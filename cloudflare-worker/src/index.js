// BruchinDB FileMaker Proxy - Cloudflare Worker
// Replaces the Supabase Edge Function with built-in caching.
// Forwards requests to FileMaker Server through the Cloudflare tunnel,
// adds CORS headers, and caches responses to reduce FileMaker load.

// Cache TTLs (seconds)
const CACHE_TTL_SEARCH = 300;     // 5 min for _find queries
const CACHE_TTL_IMAGE = 86400;    // 24 hours for images
const CACHE_TTL_SPECIES = 3600;   // 1 hour for species detail

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
// IMAGE PROXY
// ============================================================

async function getAllowedImageUrls(env, speciesId) {
  const res = await fmFetch(env, 'Species', '/layouts/Species/_find', 'POST',
    JSON.stringify({ query: [{ Species_ID: `==${speciesId}` }], limit: 1 })
  );
  if (!res.ok) return null;
  const data = await res.json();
  const record = data?.response?.data?.[0];
  if (!record) return null;
  if (record.fieldData?.validity !== 'Valid name') return null;

  const genus = record.fieldData?.Genus;
  if (!genus) return null;

  const genusRes = await fmFetch(env, 'Genus', '/layouts/Genus/_find', 'POST',
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
      'Author', 'Year', 'Validity', 'Tribe', 'Common',
    ];

    data.response.data = data.response.data.map((record) => {
      const slimFieldData = Object.fromEntries(
        keepFields
          .filter((k) => k in record.fieldData)
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
      for (const portal of ['Specimens', 'Events', 'Geolib', 'Host species', 'Host specimens']) {
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
  return new Request(url + '?_v=2&_h=' + hashHex, { method: 'GET' });
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

      // ---- IMAGE PROXY ----
      if (pathParts.startsWith('image/')) {
        // Check Cloudflare cache first
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), { method: 'GET' });
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
      if (database === 'Species' && pathParts.includes('/layouts/Species/')) {
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
};
