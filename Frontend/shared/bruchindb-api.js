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
      if (filters.scientificName) {
        const fmQuery = filters.scientificName.replace(/\?/g, '@');
        // If user already included wildcards, use as-is. Otherwise wrap in *
        if (fmQuery.includes('*')) {
          q.Species = fmQuery;
        } else {
          q.Species = `*${fmQuery}*`;
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

  if (filters.localityIds || filters.bounds) {
    const mapPoints = await getMapPoints({
      localityIds: filters.localityIds,
      bounds: filters.bounds,
    });
    const mapSpeciesNames = new Set(mapPoints.flatMap((point) => point.species_names || []));
    if (mapSpeciesNames.size === 0) return [];

    mapped = mapped.filter((s) => mapSpeciesNames.has(`${s.Genus} ${s.Species}`.trim()));
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
// MAP
// ============================================================

let mapDatasetPromise = null;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(cell);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
  }

  return rows;
}

function cleanText(value) {
  return String(value || '').replace(/[\x00-\x1f]/g, '').trim();
}

function normalize(value) {
  return cleanText(value).toLowerCase();
}

function parseNumber(value) {
  const parsed = parseFloat(cleanText(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function speciesBinomial(fullName) {
  const parts = cleanText(fullName).split(/\s+/);
  return parts.slice(0, 2).join(' ');
}

async function loadMapDataset() {
  if (mapDatasetPromise) return mapDatasetPromise;

  mapDatasetPromise = (async () => {
    const [localityText, specimenText, genusText, imageText] = await Promise.all([
      fetch(new URL('../../Data/BruchinDB_Locality.csv', import.meta.url)).then((res) => res.text()),
      fetch(new URL('../../Data/BruchinDB_Specimen.csv', import.meta.url)).then((res) => res.text()),
      fetch(new URL('../../Data/BruchinDB_Genus.csv', import.meta.url)).then((res) => res.text()),
      fetch(new URL('../../Data/BruchinDB_Image.csv', import.meta.url)).then((res) => res.text()),
    ]);

    const genusToTribe = new Map();
    parseCsv(genusText).forEach((row) => {
      const genus = cleanText(row[0]);
      const tribe = cleanText(row[2]);
      if (genus) genusToTribe.set(genus, tribe);
    });

    const localities = new Map();
    parseCsv(localityText).forEach((row) => {
      const localityId = cleanText(row[10]);
      const latitude = parseNumber(row[5]);
      const longitude = parseNumber(row[6]);
      if (!localityId || latitude === null || longitude === null) return;

      localities.set(localityId, {
        locality_id: localityId,
        country: cleanText(row[0]),
        province: cleanText(row[1]),
        county: cleanText(row[2]),
        locality_name: cleanText(row[3]),
        elevation: cleanText(row[4]),
        latitude,
        longitude,
      });
    });

    const imagedSpecimens = new Set();
    parseCsv(imageText).forEach((row) => {
      const specimenId = cleanText(row[6]);
      if (specimenId) imagedSpecimens.add(specimenId);
    });

    const specimens = parseCsv(specimenText).map((row) => {
      const fullName = cleanText(row[1]);
      const genus = fullName.split(/\s+/)[0] || '';
      const specimenId = cleanText(row[0]);
      return {
        specimen_id: specimenId,
        full_name: fullName,
        binomial: speciesBinomial(fullName),
        genus,
        tribe: genusToTribe.get(genus) || '',
        locality_id: cleanText(row[9]),
        host_name: cleanText(row[11]),
        host_family: cleanText(row[12]),
        has_image: imagedSpecimens.has(specimenId),
      };
    }).filter((specimen) => specimen.full_name && specimen.locality_id);

    return { localities, specimens };
  })();

  return mapDatasetPromise;
}

export async function getMapPoints(filters = {}) {
  const { localities, specimens } = await loadMapDataset();
  const groups = new Map();

  const scientificName = normalize(filters.scientificName);
  const tribe = normalize(filters.tribe);
  const country = normalize(filters.country);
  const province = normalize(filters.province);
  const localityQuery = normalize(filters.locality);
  const host = normalize(filters.host);
  const hostFamily = normalize(filters.hostFamily);
  const imagesOnly = Boolean(filters.imagesOnly);
  const minElevation = filters.minElevation ? parseFloat(filters.minElevation) : null;
  const bounds = filters.bounds || null;
  const localityIds = filters.localityIds ? new Set(filters.localityIds.map(cleanText)) : null;

  for (const specimen of specimens) {
    const locality = localities.get(specimen.locality_id);
    if (!locality) continue;

    if (localityIds && !localityIds.has(locality.locality_id)) continue;
    if (scientificName && !normalize(specimen.full_name).includes(scientificName)) continue;
    if (tribe && normalize(specimen.tribe) !== tribe) continue;
    if (country && !normalize(locality.country).includes(country)) continue;
    if (province && !normalize(locality.province).includes(province)) continue;
    if (localityQuery && !normalize(locality.locality_name).includes(localityQuery)) continue;
    if (host && !normalize(specimen.host_name).includes(host)) continue;
    if (hostFamily && normalize(specimen.host_family) !== hostFamily) continue;
    if (imagesOnly && !specimen.has_image) continue;

    if (Number.isFinite(minElevation)) {
      const elevation = parseNumber(locality.elevation);
      if (elevation === null || elevation < minElevation) continue;
    }

    if (bounds) {
      if (
        locality.longitude < bounds.west ||
        locality.longitude > bounds.east ||
        locality.latitude < bounds.south ||
        locality.latitude > bounds.north
      ) {
        continue;
      }
    }

    if (!groups.has(locality.locality_id)) {
      groups.set(locality.locality_id, {
        locality_id: locality.locality_id,
        locality_name: locality.locality_name,
        country: locality.country,
        province: locality.province,
        latitude: locality.latitude,
        longitude: locality.longitude,
        specimen_count: 0,
        species_count: 0,
        species_ids: [],
        species_names: [],
      });
    }

    const group = groups.get(locality.locality_id);
    group.specimen_count += 1;
    if (!group.species_names.includes(specimen.binomial)) {
      group.species_names.push(specimen.binomial);
      group.species_ids.push(specimen.binomial);
      group.species_count = group.species_names.length;
    }
  }

  return [...groups.values()];
}

export async function getLocality(localityId) {
  const { localities } = await loadMapDataset();
  return localities.get(localityId) || null;
}
