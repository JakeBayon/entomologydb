// BruchinDB API Client
import { CONFIG as APP_CONFIG } from './config.js';

let genusCacheByTribe = {};
let allowedGeneraSet = null;

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

  // Build the species query — one OR per allowed genus
  let queries;
  if (filters.speciesIds && filters.speciesIds.length > 0) {
    queries = filters.speciesIds.map((id) => ({
      Species_ID: `==${id}`,
      Validity: 'Valid name',
    }));
  } else {
    queries = [...genusFilterSet].map((genus) => {
      const q = { Genus: `==${genus}`, Validity: 'Valid name' };
      if (filters.scientificName) q.Species = `*${filters.scientificName}*`;
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

  // Exclude subspecies and varieties — Morse wants 1,714 species only
  mapped = mapped.filter((s) => {
    if (s.Subspecies) return false;
    if (s.Species.includes(' var.')) return false;
    if (s.Species.includes(' subsp.')) return false;
    if (s.Species.includes(' f.')) return false;
    return true;
  });

  if (speciesNameAllowlist) {
    mapped = mapped.filter((s) => {
      const speciesNamePrefix = `${s.Genus} ${s.Species}`;
      for (const fullName of speciesNameAllowlist) {
        if (fullName.startsWith(speciesNamePrefix)) return true;
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
    }),
  });

  if (!data.response?.data?.[0]) return null;

  const record = data.response.data[0];
  const f = record.fieldData;
  const portals = record.portalData || {};

  const allImages = (portals.Related_images || []).map((img) => ({
    url: img['Related_images::image_container'] || '',
    category: img['Related_images::image_category'] || '',
    caption: img['Related_images::full caption'] || '',
    source: img['Related_images::source'] || '',
    copyright: img['Related_images::copyright'] || '',
  }));

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
// MAP - stubs
// ============================================================
export async function getMapPoints(filters = {}) {
  return [];
}

export async function getLocality(localityId) {
  return null;
}