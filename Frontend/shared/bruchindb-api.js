// BruchinDB API Client
import { CONFIG as APP_CONFIG } from './config.js';
// v3
let genusCacheByTribe = {};
let allowedGeneraSet = null;

// In-memory locality cache (survives within a page session)
let localityCache = null;

const CONFIG = {
  fmUrl: APP_CONFIG.fileMakerUrl,
};

async function fmRequest(database, path, options = {}) {
  const response = await fetch(`${CONFIG.fmUrl}/${database}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`FileMaker request failed: ${response.status}`);
  return response.json();
}

export const TRIBES = [
  'Amblycerini',
  'Bruchini',
  'Eubaptini',
  'Kytorhinini',
  'Pachymerini',
  'Rhaebini',
];

export function getTribes() {
  return [...TRIBES];
}

async function getGeneraForTribe(tribe) {
  if (genusCacheByTribe[tribe]) return genusCacheByTribe[tribe];
  try {
    const data = await fmRequest('Genus', '/layouts/Genus/_find', {
      method: 'POST',
      body: JSON.stringify({
        query: [{ 'P::Tribe': tribe }],
        limit: 1000,
      }),
    });
    genusCacheByTribe[tribe] = (data.response?.data || []).map((r) => r.fieldData.Genus);
  } catch (err) {
    console.error(`Genera fetch failed for ${tribe}:`, err);
    genusCacheByTribe[tribe] = [];
  }
  return genusCacheByTribe[tribe];
}

async function getAllowedGenera() {
  if (allowedGeneraSet) return allowedGeneraSet;
  const all = new Set();
  for (const tribe of TRIBES) {
    const list = await getGeneraForTribe(tribe);
    for (const g of list) all.add(g);
  }
  allowedGeneraSet = all;
  return allowedGeneraSet;
}

// ============================================================
// SEARCH
// ============================================================
export async function searchSpecies(filters = {}) {
  // Determine which genera the user is allowed to see
  let genusFilterSet;
  if (filters.tribe) {
    const list = await getGeneraForTribe(filters.tribe);
    genusFilterSet = new Set(list);
    if (genusFilterSet.size === 0) return [];
  } else {
    genusFilterSet = await getAllowedGenera();
  }

  // Location filter (queries Locality DB to get bruchid species names at those localities)
  let speciesNameAllowlist = null;
  if (filters.countries || filters.provinces || filters.localities) {
    let expandedCountries = [''];
    if (filters.countries) {
      expandedCountries = [];
      const variantsMap = filters.countryVariants || {};
      for (const c of filters.countries) {
        const variants = variantsMap[c] || [c];
        expandedCountries.push(...variants);
      }
    }
    const queries = [];
    const provinces = filters.provinces || [''];
    const localities = filters.localities || [''];
    for (const c of expandedCountries) {
      for (const p of provinces) {
        for (const l of localities) {
          const q = {};
          if (c) q.Country = c;
          if (p) q.province = p;
          if (l) q.locality = `*${l}*`;
          if (Object.keys(q).length > 0) queries.push(q);
        }
      }
    }

    try {
      const locData = await fmRequest('Event', '/layouts/Locality/_find', {
        method: 'POST',
        body: JSON.stringify({ query: queries, limit: 1000 }),
      });
      const localitiesData = locData.response?.data || [];
      const names = new Set();
      for (const loc of localitiesData) {
        const sps = loc.portalData?.Species_Locality || [];
        for (const sp of sps) {
          if (sp['Species_Locality::Family'] === 'Bruchinae') {
            names.add(sp['Species_Locality::Full_name']);
          }
        }
      }
      speciesNameAllowlist = names;
      if (speciesNameAllowlist.size === 0) return [];
    } catch (err) {
      console.error('Locality lookup failed:', err);
      return [];
    }
  }

  // Bounding box filter -- use cached localities to find species in the box
  if (filters.bounds && !speciesNameAllowlist) {
    try {
      const locData = await fetchLocalitiesFromWorker();
      const { west, south, east, north } = filters.bounds;
      const inBox = (locData.localities || []).filter((p) =>
        p.lat >= south && p.lat <= north &&
        p.lng >= west && p.lng <= east
      );
      const names = new Set();
      for (const loc of inBox) {
        for (const sp of (loc.species || [])) {
          const name = typeof sp === 'string' ? sp : sp.name;
          if (name) names.add(name);
        }
      }
      speciesNameAllowlist = names;
      if (speciesNameAllowlist.size === 0) return [];
    } catch (err) {
      console.error('Bounding box locality lookup failed:', err);
    }
  }

  // Build the species query -- one OR per allowed genus
  let queries;
  if (filters.speciesIds && filters.speciesIds.length > 0) {
    queries = filters.speciesIds.map((id) => ({
      Species_ID: `==${id}`,
      Validity: 'Valid name',
    }));
  } else {
    queries = [...genusFilterSet].map((genus) => {
      const q = { Genus: `==${genus}`, Validity: 'Valid name' };
      if (filters.scientificName) {
        const fmQuery = filters.scientificName.replace(/\?/g, '@').trim();
        const parts = fmQuery.split(/\s+/);
        if (parts.length >= 2) {
          const speciesPart = parts.slice(1).join(' ');
          if (speciesPart.includes('*')) {
            q.Species = speciesPart;
          } else {
            q.Species = `*${speciesPart}*`;
          }
        }
      }
      return q;
    });
  }

  if (queries.length === 0) return [];

  const data = await fmRequest('Species', '/layouts/Lookup species/_find', {
    method: 'POST',
    body: JSON.stringify({ query: queries, limit: 10000 }),
  });

  if (!data.response?.data) return [];

  let mapped = data.response.data.map((record) => {
    const f = record.fieldData;
    return {
      Species_ID: f.Species_ID,
      Genus: f.Genus,
      Subgenus: f.Subgenus || '',
      Species: f.Species,
      Subspecies: f.Subspecies || '',
      Author: '',
      Year: '',
      Tribe: f.Tribe || '',
      Common: '',
      Full_name: `${f.Genus} ${f.Species}`.trim(),
      image_url: null,
      image_count: 0,
      specimen_count: 0,
      locality_count: 0,
    };
  });

  // Exclude subspecies and varieties
  mapped = mapped.filter((s) => {
    if (s.Subspecies) return false;
    if (s.Species.includes(' var.')) return false;
    if (s.Species.includes(' subsp.')) return false;
    if (s.Species.includes(' f.')) return false;
    return true;
  });

  if (speciesNameAllowlist) {
    mapped = mapped.filter((s) => {
      for (const fullName of speciesNameAllowlist) {
        if (fullName.includes(s.Genus) && fullName.includes(s.Species)) return true;
      }
      return false;
    });
  }

  return mapped;
}

// ============================================================
// SPECIES DETAIL
// ============================================================
export async function getSpecies(speciesId) {
  const data = await fmRequest('Species', '/layouts/Species/_find', {
    method: 'POST',
    body: JSON.stringify({
      query: [{ Species_ID: `==${speciesId}` }],
      limit: 1,
      'limit.Related_images': 10000,
      'limit.Specimens': 10000,
      'limit.Events': 10000,
      'limit.Geolib': 10000,
      'limit.Host species': 10000,
      'limit.Host specimens': 10000,
    }),
  });

  if (!data.response?.data?.[0]) return null;

  const record = data.response.data[0];
  const f = record.fieldData;
  const portals = record.portalData || {};

  const allImages = (portals.Related_images || [])
    .map((img, idx) => ({
      url: img['Related_images::image_container'] || '',
      category: img['Related_images::image_category'] || '',
      caption: img['Related_images::full caption'] || '',
      source: img['Related_images::source'] || '',
      copyright: img['Related_images::copyright'] || '',
      originalIndex: idx,
    }))
    ;

  const specimens = (portals.Specimens || []).map((s) => ({
    id: s['Specimens::Dynamic_ID'] || '',
    stage_lot: s['Specimens::stage_lot'] || '',
    stored: s['Specimens::stored'] || '',
    locality_with_date: s['Specimens::Locality_with_date'] || '',
    medium: s['Specimens::medium'] || '',
  }));

  const geolibByLocality = {};
  for (const g of (portals.Geolib || [])) {
    const locName = g['Geolib::locality'] || '';
    if (locName && g['Geolib::coordinates']) {
      geolibByLocality[locName] = g['Geolib::coordinates'];
    }
  }

  const events = (portals.Events || []).map((e) => {
    const localityName = e['Events::locality'] || '';
    return {
      country: e['Events::country'] || '',
      province: e['Events::province'] || '',
      locality: localityName,
      elevation: e['Events::full_elevation'] || '',
      date: e['Events::full_date'] || '',
      collector: e['Events::collector'] || '',
      coordinates: geolibByLocality[localityName] || '',
    };
  });

  const hosts = (portals['Host species'] || []).map((h) => ({
    tribe: h['Host species::Tribe'] || '',
    name: h['Host species::Full specific name'] || '',
  }));

  const geolib = (portals.Geolib || []).map((g) => ({
    locality_id: g['Geolib::Locality_ID'] || '',
    country: g['Geolib::Country'] || '',
    province: g['Geolib::province'] || '',
    locality: g['Geolib::locality'] || '',
    coordinates: g['Geolib::coordinates'] || '',
  }));

  return {
    Species_ID: f.Species_ID,
    Genus: f.Genus,
    Subgenus: f.Subgenus || '',
    Species: f.Species,
    Subspecies: f.Subspecies || '',
    Author: f.Author || '',
    Year: f.Year || '',
    Common: f.Common || '',
    Full_name: `${f.Genus} ${f.Species}`.trim(),
    images: allImages,
    specimens,
    events,
    hosts,
    geolib,
  };
}

// ============================================================
// SPECIMEN DETAIL
// ============================================================
export async function getSpecimen(specimenId) {
  const data = await fmRequest('Specimen', '/layouts/Specimen record/_find', {
    method: 'POST',
    body: JSON.stringify({
      query: [{ Specimen_ID: `==${specimenId}` }],
      limit: 1,
      'limit.Related_images': 10000,
    }),
  });

  if (!data.response?.data?.[0]) return null;

  const record = data.response.data[0];
  const f = record.fieldData;
  const portals = record.portalData || {};

  const images = (portals.Related_images || []).map((img) => ({
    url: img['Related_images::image_container'] || '',
    category: img['Related_images::image_category'] || '',
    caption: img['Related_images::full caption'] || '',
    source: img['Related_images::source'] || '',
    copyright: img['Related_images::copyright'] || '',
  }));

  return {
    Specimen_ID: f.Specimen_ID || '',
    Species_ID: f.Species_ID || '',
    species_full_name: f['Species::Full_name'] || '',
    sex: f.sex || '',
    stage: f.stage || '',
    collecting_method: f.collecting_method || '',
    determined_by: f['determined by'] || '',
    ss: f.ss || '',
    Tape: f.Tape || '',
    stored: f.stored || '',
    medium: f.medium || '',
    host_species_name: f['Host species::Full_name'] || '',
    host_species_family: f['Host species::Family'] || '',
    citation: f['Citation::full_citation'] || '',
    Event_ID: f.Event_ID || '',
    event_country: f['Events::country'] || '',
    event_province: f['Events::province'] || '',
    event_county: f['Events::County'] || '',
    event_locality: f['Events::locality'] || '',
    event_date: f['Events::full_date'] || '',
    event_collector: f['Events::collector'] || '',
    notes: f['Specimen notes'] || '',
    images,
  };
}

// ============================================================
// MAP DATA
// Fetches all bruchid localities from the /localities endpoint.
// Caches in sessionStorage so subsequent page loads are instant.
// All filtering (bounding box, country, tribe) is done client-side.
// ============================================================

const LOCALITY_STORAGE_KEY = 'bruchindb_localities_v2';

async function fetchLocalitiesFromWorker() {
  // Check sessionStorage first
  try {
    const cached = sessionStorage.getItem(LOCALITY_STORAGE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Check if cache is less than 24 hours old
      const fetchedAt = new Date(parsed.fetchedAt).getTime();
      const now = Date.now();
      if (now - fetchedAt < 24 * 60 * 60 * 1000) {
        localityCache = parsed;
        return parsed;
      }
    }
  } catch (e) {
    // sessionStorage unavailable or corrupt, continue to fetch
  }

  // Fetch from Worker
  const response = await fetch(`${CONFIG.fmUrl}/localities`);
  if (!response.ok) throw new Error(`Localities fetch failed: ${response.status}`);

  const data = await response.json();
  localityCache = data;

  // Store in sessionStorage for subsequent page loads
  try {
    sessionStorage.setItem(LOCALITY_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // sessionStorage full or unavailable, that's fine
    console.warn('Could not cache localities in sessionStorage:', e.message);
  }

  return data;
}

/**
 * Get map points for the map page.
 * Fetches all bruchid localities (cached), then filters client-side.
 */
export async function getMapPoints(filters = {}, onProgress = null) {
  if (onProgress) onProgress({ phase: 'fetching', loaded: 0, total: 0 });

  const data = await fetchLocalitiesFromWorker();
  let points = data.localities || [];

  if (onProgress) onProgress({ phase: 'filtering', loaded: points.length, total: data.totalInDb });

  // Apply bounding box filter client-side
  if (filters.bounds) {
    const { west, south, east, north } = filters.bounds;
    points = points.filter((p) =>
      p.lat >= south && p.lat <= north &&
      p.lng >= west && p.lng <= east
    );
  }

  // Apply country filter client-side
  if (filters.country) {
    const c = filters.country.toLowerCase();
    points = points.filter((p) => (p.country || '').toLowerCase() === c);
  }

  // Map to the format map.js expects
  return points.map((p) => {
    // Normalize species: could be strings (old cache) or objects (new cache)
    const normalizedSpecies = (p.species || []).map((sp) => {
      if (typeof sp === 'string') {
        const cleaned = sp.replace(/\([A-Z][a-z]*\.?\)\s*/g, '').trim();
        const parts = cleaned.split(/\s+/);
        return { name: sp, genus: parts[0] || '', species: parts[1] || '' };
      }
      return sp;
    });

    return {
      locality_id: p.id,
      record_id: p.rid || p.id,
      latitude: p.lat,
      longitude: p.lng,
      locality_name: p.locality || '',
      country: p.country || '',
      province: p.province || '',
      species: normalizedSpecies,
      species_count: p.speciesCount || 0,
    };
  });
}

/**
 * Get distinct countries from cached localities (for map filter dropdowns).
 */
export async function getLocalityCountries() {
  const data = await fetchLocalitiesFromWorker();
  const countries = new Set();
  for (const loc of (data.localities || [])) {
    if (loc.country) countries.add(loc.country);
  }
  return [...countries].sort();
}

export async function getLocality(localityId) {
  if (!localityCache) await fetchLocalitiesFromWorker();
  const locs = localityCache?.localities || [];
  // Match by Locality_ID or by recordId
  const loc = locs.find((l) => l.id === localityId || l.rid === localityId);
  if (!loc) return null;

  // Normalize species format
  const species = (loc.species || []).map((sp) => {
    if (typeof sp === 'string') {
      const cleaned = sp.replace(/\([A-Z][a-z]*\.?\)\s*/g, '').trim();
      const parts = cleaned.split(/\s+/);
      return { name: sp, genus: parts[0] || '', species: parts[1] || '' };
    }
    return sp;
  });

  return {
    locality_id: loc.id,
    record_id: loc.rid || loc.id,
    country: loc.country,
    province: loc.province,
    locality: loc.locality,
    latitude: loc.lat,
    longitude: loc.lng,
    species: species,
  };
}