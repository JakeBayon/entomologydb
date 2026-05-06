// BruchinDB FileMaker Proxy - Cloudflare Worker
// Replaces the Supabase Edge Function with built-in caching.
// Forwards requests to FileMaker Server through the Cloudflare tunnel,
// adds CORS headers, and caches responses to reduce FileMaker load.

// Cache TTLs (seconds)
const CACHE_TTL_SEARCH = 300;   // 24 hours for _find queries
const CACHE_TTL_IMAGE = 86400;      // 24 hours for images
const CACHE_TTL_SPECIES = 60;     // 1 hour for species detail
const CACHE_TTL_LOCALITIES = 86400; // 24 hours for locality aggregate

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const ALLOWED_TRIBES = [
  'Amblycerini', 'Bruchini', 'Eubaptini',
  'Kytorhinini', 'Pachymerini', 'Rhaebini',
];

// In-memory token cache (per isolate, resets on cold start)
const tokenCache = {};

async function getFmToken(env, database) {
  if (tokenCache[database]) return tokenCache[database];

  const auth = btoa(`${env.FM_USER}:${env.FM_PASS}`);
  const response = await fetch(
    `${env.FM_URL}/fmi/data/v2/databases/${database}/sessions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
      body: '{}',
    }
  );

  if (!response.ok) {
    throw new Error(`FM auth failed: ${response.status}`);
  }

  const data = await response.json();
  tokenCache[database] = data.response.token;
  return tokenCache[database];
}

async function fmFetch(env, database, path, method, body) {
  const token = await getFmToken(env, database);

  const response = await fetch(
    `${env.FM_URL}/fmi/data/v2/databases/${database}${path}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: method !== 'GET' ? body : undefined,
    }
  );

  // Token expired, retry once
  if (response.status === 401) {
    delete tokenCache[database];
    const newToken = await getFmToken(env, database);
    return fetch(
      `${env.FM_URL}/fmi/data/v2/databases/${database}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${newToken}`,
        },
        body: method !== 'GET' ? body : undefined,
      }
    );
  }

  return response;
}

// ============================================================
// LOCALITY AGGREGATION
// Fetches ALL localities from FileMaker in chunks, strips to
// just coordinates + identifiers, and returns a single slim JSON.
// This is the data source for the map page.
// ============================================================

async function fetchAllLocalities(env) {
  const CHUNK_SIZE = 1000;
  const MAX_OFFSET = 35000; // safety cap
  const allLocalities = [];
  let offset = 1;
  let totalCount = 0;

  while (offset < MAX_OFFSET) {
    const res = await fmFetch(env, 'Event', '/layouts/Locality/_find', 'POST',
      JSON.stringify({
        query: [{ 'Country': '*' }],
        limit: CHUNK_SIZE,
        offset: offset,
        'limit.Species_Locality': 500,
      })
    );

    if (!res.ok) {
      // If we get a 401 "no records" that means we've gone past the end
      const text = await res.text();
      if (text.includes('"401"')) break;
      throw new Error(`Locality fetch failed at offset ${offset}: ${res.status}`);
    }

    const data = await res.json();
    if (!data.response?.data || data.response.data.length === 0) break;

    if (offset === 1 && data.response?.dataInfo?.totalRecordCount) {
      totalCount = data.response.dataInfo.totalRecordCount;
    }

    for (const record of data.response.data) {
      const f = record.fieldData || {};
      const lat = parseFloat(f['decimal latitude']);
      const lng = parseFloat(f['decimal longitude']);

      // Skip records without valid coordinates
      if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) continue;

      // Check if any bruchid species at this locality
      // (Species_Locality portal has Family field)
      const speciesPortal = record.portalData?.Species_Locality || [];
      const bruchidSpecies = [];
      let hasBruchid = false;

      for (const sp of speciesPortal) {
        if (sp['Species_Locality::Family'] === 'Bruchinae') {
          hasBruchid = true;
          const fullName = sp['Species_Locality::Full_name'] || '';
          if (fullName) {
            // Parse "Genus (Subgenus) species (Author, Year)" into parts
            // Remove subgenus in parens at start, keep genus + species epithet
            const cleaned = fullName.replace(/\([A-Z][a-z]*\.?\)\s*/g, '').trim();
            const parts = cleaned.split(/\s+/);
            const genus = parts[0] || '';
            const epithet = parts[1] || '';
            bruchidSpecies.push({
              name: fullName,
              genus: genus,
              species: epithet,
            });
          }
        }
      }

      // Only include localities with bruchid records
      if (!hasBruchid) continue;

      allLocalities.push({
        id: f.Locality_ID || String(record.recordId) || '',
        rid: String(record.recordId) || '',
        lat: lat,
        lng: lng,
        country: f.Country || '',
        province: f.province || '',
        locality: f.locality || '',
        species: bruchidSpecies,
        speciesCount: bruchidSpecies.length,
      });
    }

    // If we got fewer than CHUNK_SIZE, we're done
    if (data.response.data.length < CHUNK_SIZE) break;
    offset += CHUNK_SIZE;
  }

  return {
    localities: allLocalities,
    totalInDb: totalCount,
    fetchedAt: new Date().toISOString(),
  };
}


// ============================================================
// IMAGE PROXY
// ============================================================

async function getAllowedImageUrls(env, speciesId) {
  const res = await fmFetch(env, 'Species', '/layouts/Species_API/_find', 'POST',
    JSON.stringify({ query: [{ Species_ID: `==${speciesId}` }], limit: 1, 'limit.Related_images': 10000 })
  );
  if (!res.ok) return null;
  const data = await res.json();
  const record = data?.response?.data?.[0];
  if (!record) return null;
  if (record.fieldData?.validity !== 'Valid name') return null;

  const genus = record.fieldData?.Genus;
  if (!genus) return null;

  const genusRes = await fmFetch(env, 'Genus', '/layouts/Genus_API/_find', 'POST',
    JSON.stringify({
      query: ALLOWED_TRIBES.map((tribe) => ({
        Genus: `==${genus}`,
        'P::Tribe': tribe,
      })),
      limit: 1,
    })
  );
  if (!genusRes.ok) return null;
  const genusData = await genusRes.json();
  if (!genusData?.response?.data?.length) return null;

  const images = record.portalData?.Related_images || [];
  return images
    .map((img) => img['Related_images::image_container'])
    .filter((url) => url && url.length > 0);
}

async function getFirstPhotoIndex(env, speciesId) {
  const res = await fmFetch(env, 'Species', '/layouts/Species_API/_find', 'POST',
    JSON.stringify({ query: [{ Species_ID: `==${speciesId}` }], limit: 1, 'limit.Related_images': 10000 })
  );
  if (!res.ok) return null;
  const data = await res.json();
  const record = data?.response?.data?.[0];
  if (!record) return null;
  if (record.fieldData?.validity !== 'Valid name') return null;

  const images = record.portalData?.Related_images || [];
  let firstPhoto = null;
  let firstDorsal = null;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const url = img['Related_images::image_container'] || '';
    if (!url) continue;
    const category = (img['Related_images::image_category'] || '').toLowerCase();
    const custom2 = (img['Related_images::custom2'] || '').toLowerCase();
    if (category.startsWith('illustration')) continue;
    if (custom2.includes('published')) continue;
    if (firstPhoto === null) firstPhoto = i;
    if (firstDorsal === null && category.includes('dorsal')) firstDorsal = i;
    if (firstDorsal !== null) break;
  }
  return firstDorsal !== null ? firstDorsal : firstPhoto;
}

async function getAllowedSpecimenImageUrls(env, specimenId) {
  const res = await fmFetch(env, 'Specimen', '/layouts/Specimen record/_find', 'POST',
    JSON.stringify({ query: [{ Specimen_ID: `==${specimenId}` }], limit: 1 })
  );
  if (!res.ok) return null;
  const data = await res.json();
  const record = data?.response?.data?.[0];
  if (!record) return null;

  const speciesId = record.fieldData?.Species_ID;
  if (!speciesId) return null;

  const species = await getAllowedImageUrls(env, speciesId);
  if (species === null) return null;

  const images = record.portalData?.Related_images || [];
  return images
    .map((img) => img['Related_images::image_container'])
    .filter((url) => url && url.length > 0);
}

async function streamImage(imgUrl) {
  const initialRes = await fetch(imgUrl, {
    method: 'GET',
    redirect: 'manual',
  });

  if (initialRes.status !== 302 && initialRes.status !== 301) {
    if (initialRes.headers.get('content-type')?.startsWith('image/')) {
      return new Response(initialRes.body, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': initialRes.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': `public, max-age=${CACHE_TTL_IMAGE}`,
        },
      });
    }
    return jsonResponse({ error: 'Unexpected response', status: initialRes.status }, 502);
  }

  const setCookie = initialRes.headers.get('set-cookie') || '';
  const cookieMatch = setCookie.match(/X-FMS-Session-Key=([^;]+)/);
  if (!cookieMatch) return jsonResponse({ error: 'No session cookie in redirect' }, 502);

  const location = initialRes.headers.get('location');
  if (!location) return jsonResponse({ error: 'No redirect location' }, 502);

  const redirectUrl = new URL(location, imgUrl).toString();
  const imgRes = await fetch(redirectUrl, {
    method: 'GET',
    headers: { 'Cookie': `X-FMS-Session-Key=${cookieMatch[1]}` },
  });

  if (!imgRes.ok) return jsonResponse({ error: 'Image fetch failed', status: imgRes.status }, 502);

  return new Response(imgRes.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': imgRes.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': `public, max-age=${CACHE_TTL_IMAGE}`,
    },
  });
}

// ============================================================
// FIELD STRIPPING
// ============================================================

function stripSpeciesFields(responseText) {
  try {
    const data = JSON.parse(responseText);
    if (!data?.response?.data) return responseText;

    const keepFields = [
      'Species_ID', 'Genus', 'Subgenus', 'Species', 'Subspecies',
      'Author', 'Year', 'validity', 'Common', 'cs',
    ];
    const keepPortals = [
      'Related_images', 'Specimens', 'Events', 'Geolib', 'Host species',
    ];

    data.response.data = data.response.data.map((record) => {
      const slimFieldData = Object.fromEntries(
        keepFields
          .filter((k) => k in record.fieldData)
          .map((k) => [k, record.fieldData[k]])
      );
      const slimPortalData = {};
      for (const portal of keepPortals) {
        if (record.portalData?.[portal]) {
          slimPortalData[portal] = record.portalData[portal];
        }
      }
      return { ...record, fieldData: slimFieldData, portalData: slimPortalData };
    });
    return JSON.stringify(data);
  } catch {
    return responseText;
  }
}

function stripEventFields(responseText) {
  try {
    const data = JSON.parse(responseText);
    if (!data?.response?.data || data?.response?.dataInfo?.layout !== 'Locality') return responseText;

    data.response.data = data.response.data.map((record) => {
      const f = record.fieldData || {};
      return {
        recordId: record.recordId,
        modId: record.modId,
        fieldData: {
          Locality_ID: f.Locality_ID,
          Country: f.Country,
          province: f.province,
          locality: f.locality,
          'decimal latitude': f['decimal latitude'],
          'decimal longitude': f['decimal longitude'],
        },
        portalData: record.portalData?.Species_Locality ? {
          Species_Locality: record.portalData.Species_Locality.map((sp) => ({
            'Species_Locality::Full_name': sp['Species_Locality::Full_name'],
            'Species_Locality::Family': sp['Species_Locality::Family'],
            'Species_Locality::Subfamily': sp['Species_Locality::Subfamily'],
            'Species_Locality::Tribe': sp['Species_Locality::Tribe'],
          })),
        } : {},
      };
    });
    return JSON.stringify(data);
  } catch {
    return responseText;
  }
}

function stripSpecimenFields(responseText) {
  try {
    const data = JSON.parse(responseText);
    if (!data?.response?.data) return responseText;

    const keepFields = [
      'Specimen_ID', 'Species_ID', 'sex', 'stage', 'collecting_method',
      'determined by', 'ss', 'Tape', 'stored', 'medium',
      'Species::Full_name', 'Host species::Full_name', 'Host species::Family',
      'Citation::full_citation', 'Event_ID',
      'Events::country', 'Events::province', 'Events::County',
      'Events::locality', 'Events::full_date', 'Events::collector',
      'Events::coordinates', 'Specimen notes',
    ];

    data.response.data = data.response.data.map((record) => {
      const slimFieldData = Object.fromEntries(
        keepFields
          .filter((k) => k in (record.fieldData || {}))
          .map((k) => [k, record.fieldData[k]])
      );
      const slimPortalData = {};
      if (record.portalData?.Related_images) {
        slimPortalData.Related_images = record.portalData.Related_images.map((img) => ({
          'Related_images::image_container': img['Related_images::image_container'],
          'Related_images::image_category': img['Related_images::image_category'],
          'Related_images::full caption': img['Related_images::full caption'],
          'Related_images::source': img['Related_images::source'],
          'Related_images::copyright': img['Related_images::copyright'],
        }));
      }
      return { recordId: record.recordId, modId: record.modId, fieldData: slimFieldData, portalData: slimPortalData };
    });
    return JSON.stringify(data);
  } catch {
    return responseText;
  }
}

// ============================================================
// HELPERS
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function getCacheKey(url, body) {
  if (!body) return new Request(url, { method: 'GET' });
  const encoder = new TextEncoder();
  const data = encoder.encode(body);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(url + '?_v=5&_h=' + hashHex, { method: 'GET' });
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      const url = new URL(request.url);
      const pathParts = url.pathname.replace(/^\//, '');

      if (!pathParts) {
        return jsonResponse({ error: 'Missing path' }, 400);
      }

      // ---- LOCALITIES AGGREGATE ENDPOINT ----
      if (pathParts === 'localities') {
        const cache = caches.default;
        const cacheKey = new Request(url.toString() + '?_v=localities_v1', { method: 'GET' });

        // Check cache first
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) return cachedResponse;

        // Fetch all localities from FileMaker (chunked)
        const localityData = await fetchAllLocalities(env);

        const response = new Response(JSON.stringify(localityData), {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL_LOCALITIES}`,
          },
        });

        // Cache it
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // ---- THUMBNAIL PROXY ----
      if (pathParts.startsWith('thumb/')) {
        const cache = caches.default;
        const cacheKey = new Request(url.toString() + '?_v=5', { method: 'GET' });
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) return cachedResponse;

        const segments = pathParts.split('/');
        const speciesId = segments[1];
        const index = parseInt(segments[2], 10);
        if (!speciesId || isNaN(index)) return jsonResponse({ error: 'Bad thumb path' }, 400);

        const imageUrls = await getAllowedImageUrls(env, speciesId);
        if (!imageUrls || !imageUrls[index]) return jsonResponse({ error: 'Not found' }, 404);

        const imgUrl = imageUrls[index];
        const response = await streamImage(imgUrl);
        if (response.status !== 200) return response;

        // Resize via Cloudflare Image Transformations
        const resized = new Response(response.body, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': response.headers.get('content-type') || 'image/jpeg',
            'Cache-Control': `public, max-age=${CACHE_TTL_IMAGE}`,
          },
        });
        ctx.waitUntil(cache.put(cacheKey, resized.clone()));
        return resized;
      }

      // ---- PHOTO PROXY (first non-illustration, non-published image) ----
      if (pathParts.startsWith('photo/')) {
        const cache = caches.default;
        const cacheKey = new Request(url.toString() + '?_v=5', { method: 'GET' });
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) return cachedResponse;

        const segments = pathParts.split('/');
        const speciesId = segments[1];
        if (!speciesId) return jsonResponse({ error: 'Missing species ID' }, 400);

        const photoIndex = await getFirstPhotoIndex(env, speciesId);
        if (photoIndex === null) return jsonResponse({ error: 'No photos available' }, 404);

        const imageUrls = await getAllowedImageUrls(env, speciesId);
        if (!imageUrls || !imageUrls[photoIndex]) return jsonResponse({ error: 'Image not found' }, 404);

        const response = await streamImage(imageUrls[photoIndex]);
        if (response.status === 200) {
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }
        return response;
      }

      // ---- IMAGE PROXY ----
      if (pathParts.startsWith('image/')) {
        // Check Cloudflare cache first
        const cache = caches.default;
        const cacheKey = new Request(url.toString() + '?_v=5', { method: 'GET' });
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) return cachedResponse;

        const segments = pathParts.split('/');
        if (segments.length < 3) return jsonResponse({ error: 'Bad image path' }, 400);

        let imageUrls;
        let index;

        if (segments[1] === 'specimen') {
          if (segments.length < 4) return jsonResponse({ error: 'Bad specimen image path' }, 400);
          imageUrls = await getAllowedSpecimenImageUrls(env, segments[2]);
          index = parseInt(segments[3], 10);
        } else {
          imageUrls = await getAllowedImageUrls(env, segments[1]);
          index = parseInt(segments[2], 10);
        }

        if (!imageUrls) return jsonResponse({ error: 'Forbidden or not found' }, 403);
        if (!imageUrls[index]) return jsonResponse({ error: 'Image index out of range' }, 404);

        const response = await streamImage(imageUrls[index]);
        // Cache the image response
        if (response.status === 200) {
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }
        return response;
      }

      // ---- READ-ONLY WHITELIST ----
      const isFindRequest = pathParts.includes('/_find');
      const isLayoutsList = pathParts.endsWith('/layouts') || /\/layouts\/[^/]+$/.test(pathParts);

      if (!isFindRequest && !isLayoutsList) {
        return jsonResponse({ error: 'Forbidden: only read operations are allowed' }, 403);
      }

      if (request.method !== 'GET' && request.method !== 'POST') {
        return jsonResponse({ error: 'Forbidden: only GET and POST allowed' }, 403);
      }

      // ---- CACHED DATA PROXY ----
      const cache = caches.default;
      const reqBody = request.method !== 'GET' ? await request.text() : null;
      const cacheKey = await getCacheKey(url.toString(), reqBody);

      // Check cache
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) return cachedResponse;

      // Forward to FileMaker
      const [database, ...rest] = pathParts.split('/');
      const fmPath = '/' + rest.join('/');

      const fmResponse = await fmFetch(env, database, fmPath, request.method, reqBody);
      let responseText = await fmResponse.text();

      // Strip unneeded fields
      if (fmResponse.ok) {
        if (database === 'Species') responseText = stripSpeciesFields(responseText);
        if (database === 'Event') responseText = stripEventFields(responseText);
        if (database === 'Specimen') responseText = stripSpecimenFields(responseText);
      }

      // Determine cache TTL
      let cacheTtl = CACHE_TTL_SEARCH;
      if (database === 'Species' && (pathParts.includes('/layouts/Species/') || pathParts.includes('/layouts/Species_API/'))) {
        cacheTtl = CACHE_TTL_SPECIES;
      }

      const response = new Response(responseText, {
        status: fmResponse.status,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${cacheTtl}`,
        },
      });

      // Store in cache
      if (fmResponse.ok) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  },

  // ---- CRON TRIGGER: Pre-warm locality + genus caches ----
  // Runs on a schedule so no real user pays the cold-query cost.
  async scheduled(event, env, ctx) {
    const cache = caches.default;
    const workerUrl = 'https://fm-proxy.bruchindb.workers.dev';

    // 1. Pre-warm localities
    try {
      const localityData = await fetchAllLocalities(env);
      const cacheKey = new Request(workerUrl + '/localities?_v=localities_v1', { method: 'GET' });
      const response = new Response(JSON.stringify(localityData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL_LOCALITIES}`,
          ...CORS_HEADERS,
        },
      });
      await cache.put(cacheKey, response);
      console.log(`Pre-warmed locality cache: ${localityData.localities.length} bruchid localities`);
    } catch (err) {
      console.error('Cron locality pre-warm failed:', err);
    }

    // 2. Pre-warm genus queries for each tribe
    // This is the slow query (~20s) that makes first search painful.
    for (const tribe of ALLOWED_TRIBES) {
      try {
        const body = JSON.stringify({
          query: [{ 'P::Tribe': tribe }],
          limit: 1000,
        });
        const fmPath = '/layouts/Genus_API/_find';
        const res = await fmFetch(env, 'Genus', fmPath, 'POST', body);
        if (res.ok) {
          let responseText = await res.text();
          // Build the same cache key the normal proxy path would use
          const fullUrl = workerUrl + '/Genus' + fmPath;
          const cacheKey = await getCacheKey(fullUrl, body);
          const cachedResponse = new Response(responseText, {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `public, max-age=${CACHE_TTL_SEARCH}`,
              ...CORS_HEADERS,
            },
          });
          await cache.put(cacheKey, cachedResponse);
          console.log(`Pre-warmed genus cache for tribe: ${tribe}`);
        }
      } catch (err) {
        console.error(`Cron genus pre-warm failed for ${tribe}:`, err);
      }
    }

    // 3. Pre-warm the all-species search (most common query)
    try {
      const allGenera = [];
      for (const tribe of ALLOWED_TRIBES) {
        const res = await fmFetch(env, 'Genus', '/layouts/Genus_API/_find', 'POST',
          JSON.stringify({ query: [{ 'P::Tribe': tribe }], limit: 1000 })
        );
        if (res.ok) {
          const data = await res.json();
          for (const r of (data.response?.data || [])) {
            allGenera.push(r.fieldData.Genus);
          }
        }
      }
      const queries = allGenera.map((genus) => ({
        Genus: `==${genus}`,
        Validity: 'Valid name',
      }));
      const body = JSON.stringify({ query: queries, limit: 10000 });
      const res = await fmFetch(env, 'Species', '/layouts/Search_API/_find', 'POST', body);
      if (res.ok) {
        let responseText = await res.text();
        responseText = stripSpeciesFields(responseText);
        const fullUrl = workerUrl + '/Species/layouts/Search_API/_find';
        const cacheKey = await getCacheKey(fullUrl, body);
        const cachedResponse = new Response(responseText, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL_SEARCH}`,
            ...CORS_HEADERS,
          },
        });
        await cache.put(cacheKey, cachedResponse);
        console.log('Pre-warmed all-species search');
      }
    } catch (err) {
      console.error('Cron species pre-warm failed:', err);
    }
  },
};
