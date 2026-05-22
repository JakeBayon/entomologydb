// Map page logic
// Loads all bruchid localities from the cached /localities endpoint
// and renders them as clustered pins. All filtering is client-side.
// First load may take 1-2 minutes; subsequent loads are instant from cache.

import { getMapPoints, getLocality, getLocalityCountries, TRIBES, getGenusTribeMap } from '../shared/bruchindb-api.js';
import { polygonFromCorners } from './boundingbox-utils.js';


// ============================================================
// CONSTANTS AND STATE
// ============================================================

let bboxMode = false;
let firstCorner = null;
let bboxBtnEl = null;
let currentBbox = null;
let allPoints = []; // all loaded points, unfiltered
let isLoaded = false;

const BBOX_SOURCE_ID = "user-bbox";
const BBOX_FILL_ID = "user-bbox-fill";
const BBOX_LINE_ID = "user-bbox-line";
const SPECIMENS_SOURCE_ID = "specimens";
const CLUSTERS_LAYER_ID = "clusters";
const CLUSTER_COUNT_LAYER_ID = "cluster-count";
const POINT_LAYER_ID = "unclustered-point";
const PIN_IMAGE_ID = "bruchin-pin";

const PANEL_WIDTH = 300;
const DEFAULT_PADDING = 160;

const mapSearchBtn = document.getElementById("mapSearchBtn");
const mapResetBtn = document.getElementById("mapResetBtn");
const mapSciNameInput = document.getElementById("map-sci-name-search");
const mapTribeSelect = document.getElementById("map-filter-tribe");
const mapCountryInput = document.getElementById("map-filter-country");
const mapProvinceInput = document.getElementById("map-filter-province");
const mapLocalityInput = document.getElementById("map-filter-locality");
const mapElevationMinInput = document.getElementById("map-filter-elevation-min");
const mapHostInput = document.getElementById("map-filter-host");
const mapHostFamilySelect = document.getElementById("map-filter-host-family");
const mapImagesOnlyCheckbox = document.getElementById("map-filter-images-only");

function populateTribeFilter() {
  if (!mapTribeSelect) return;
  mapTribeSelect.innerHTML = '<option value="">Any tribe</option>';
  TRIBES.forEach((tribe) => {
    const option = document.createElement("option");
    option.value = tribe;
    option.textContent = tribe;
    mapTribeSelect.appendChild(option);
  });
}

function getMapFilters() {
  return {
    scientificName: mapSciNameInput?.value.trim() || "",
    tribe: mapTribeSelect?.value || "",
    country: mapCountryInput?.value.trim() || "",
    province: mapProvinceInput?.value.trim() || "",
    locality: mapLocalityInput?.value.trim() || "",
    minElevation: mapElevationMinInput?.value || "",
    host: mapHostInput?.value.trim() || "",
    hostFamily: mapHostFamilySelect?.value || "",
    imagesOnly: mapImagesOnlyCheckbox?.checked || false,
  };
}

function resetMapFilters() {
  [
    mapSciNameInput,
    mapCountryInput,
    mapProvinceInput,
    mapLocalityInput,
    mapElevationMinInput,
    mapHostInput,
  ].forEach((input) => {
    if (input) input.value = "";
  });

  if (mapTribeSelect) mapTribeSelect.value = "";
  if (mapHostFamilySelect) mapHostFamilySelect.value = "";
  if (mapImagesOnlyCheckbox) mapImagesOnlyCheckbox.checked = false;
}


// ============================================================
// MAP SETUP
// ============================================================

const MAP_STYLES = {
  default: { name: 'Default', url: 'https://demotiles.maplibre.org/style.json' },
  osm: { name: 'Streets', url: 'https://tiles.openfreemap.org/styles/liberty' },
  dark: { name: 'Dark', url: 'https://tiles.openfreemap.org/styles/dark' },
  satellite: { name: 'Satellite', url: null },
};

let currentStyle = localStorage.getItem('mapStyle') || 'default';
if (!MAP_STYLES[currentStyle]) currentStyle = 'default';

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLES[currentStyle]?.url ?? MAP_STYLES.default.url,
  center: [-85, 10],
  zoom: 3,
});

window.map = map;

const nav = new maplibregl.NavigationControl({ visualizePitch: true });
map.addControl(nav, "top-right");


// ============================================================
// PIN MARKER
// ============================================================

const PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="52" viewBox="-4 -4 40 52">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.3"/>
    </filter>
  </defs>
  <path d="M16 0 C7.16 0 0 7.16 0 16 C0 28 16 44 16 44 C16 44 32 28 32 16 C32 7.16 24.84 0 16 0 Z" fill="#3d8bfd" stroke="#ffffff" stroke-width="2" filter="url(#shadow)"/>
  <circle cx="16" cy="16" r="5" fill="#ffffff"/>
</svg>`;

function loadPinImage() {
  return new Promise((resolve) => {
    const img = new Image(36, 48);
    img.onload = () => {
      if (!map.hasImage(PIN_IMAGE_ID)) {
        map.addImage(PIN_IMAGE_ID, img);
      }
      resolve();
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(PIN_SVG);
  });
}


// ============================================================
// LOADING INDICATOR
// ============================================================

function showLoadingState(message) {
  let el = document.getElementById('mapLoadingOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mapLoadingOverlay';
    el.className = 'map-loading-overlay';
    document.getElementById('map').parentNode.appendChild(el);
  }
  el.innerHTML = `
    <div class="map-loading-content">
      <div class="map-loading-spinner"></div>
      <div class="map-loading-text">${message}</div>
    </div>
  `;
  el.style.display = 'flex';
}

function hideLoadingState() {
  const el = document.getElementById('mapLoadingOverlay');
  if (el) el.style.display = 'none';
}

function updateLoadingState(message) {
  const textEl = document.querySelector('.map-loading-text');
  if (textEl) textEl.textContent = message;
}


// ============================================================
// BOUNDING BOX FEATURE
// ============================================================

function fitBoundsWithPanel(bounds) {
  const panelOpen = !document.getElementById("searchLayout")?.classList.contains("filters-collapsed");
  map.fitBounds(bounds, {
    padding: {
      top: DEFAULT_PADDING,
      right: DEFAULT_PADDING,
      bottom: DEFAULT_PADDING,
      left: panelOpen ? PANEL_WIDTH + DEFAULT_PADDING : DEFAULT_PADDING,
    },
  });
}

function ensureBboxLayers() {
  if (map.getSource(BBOX_SOURCE_ID)) return;

  map.addSource(BBOX_SOURCE_ID, {
    type: "geojson",
    data: { type: "Feature", geometry: { type: "Polygon", coordinates: [[]] } },
  });

  map.addLayer({
    id: BBOX_FILL_ID,
    type: "fill",
    source: BBOX_SOURCE_ID,
    paint: { "fill-color": "#ff0000", "fill-opacity": 0.15 },
  });

  map.addLayer({
    id: BBOX_LINE_ID,
    type: "line",
    source: BBOX_SOURCE_ID,
    paint: { "line-color": "#ff0000", "line-width": 2, "line-dasharray": [2, 2] },
  });
}

function clearBbox() {
  const src = map.getSource(BBOX_SOURCE_ID);
  if (!src) return;
  src.setData({ type: "Feature", geometry: { type: "Polygon", coordinates: [[]] } });
  currentBbox = null;
  hideBboxPrompt();
  // Show all points again
  if (isLoaded) renderPoints(allPoints);
}

function setBboxPreview(a, b) {
  const src = map.getSource(BBOX_SOURCE_ID);
  if (!src) return;
  src.setData(polygonFromCorners(a, b));
}

function setBboxMode(on) {
  bboxMode = on;
  map.getCanvas().style.cursor = on ? "crosshair" : "";
  if (bboxBtnEl) bboxBtnEl.classList.toggle("active", on);
  if (!on) {
    firstCorner = null;
    map.dragPan.enable();
    map.doubleClickZoom.enable();
  } else {
    map.dragPan.disable();
    map.doubleClickZoom.disable();
  }
}

class BBoxControl {
  onAdd(mapInstance) {
    this.map = mapInstance;
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group bbox-ctrl";

    const bboxBtn = document.createElement("button");
    bboxBtn.type = "button";
    bboxBtn.className = "bbox-btn";
    bboxBtn.title = "Bounding box";
    bboxBtn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="12" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/></svg>`;

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "bbox-btn";
    clearBtn.title = "Clear bounding box";
    clearBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

    bboxBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    clearBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    bboxBtnEl = bboxBtn;

    bboxBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setBboxMode(!bboxMode);
    });

    clearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      clearBbox();
      setBboxMode(false);
    });

    this.container.appendChild(bboxBtn);
    this.container.appendChild(clearBtn);
    return this.container;
  }

  onRemove() {
    this.container.parentNode.removeChild(this.container);
    this.map = undefined;
  }
}

map.addControl(new BBoxControl(), "top-right");


// ============================================================
// BBOX RESULTS PROMPT
// ============================================================

function showBboxPrompt(bounds, filteredPoints) {
  hideBboxPrompt();

  // Count unique species across filtered points
  const speciesNames = new Set();
  for (const p of filteredPoints) {
    for (const sp of (p.species || [])) {
      speciesNames.add(typeof sp === 'string' ? sp : sp.name);
    }
  }

  const promptEl = document.createElement("div");
  promptEl.className = "bbox-prompt";
  promptEl.id = "bboxPrompt";
  promptEl.innerHTML = `
    <span>${filteredPoints.length} localities, ${speciesNames.size} species</span>
    <button type="button">View in search &rarr;</button>
    <button type="button" class="close-btn" aria-label="Close">&times;</button>
  `;

  promptEl.querySelector("button:not(.close-btn)").addEventListener("click", () => {
    const params = new URLSearchParams({
      west: bounds.west,
      south: bounds.south,
      east: bounds.east,
      north: bounds.north,
    });
    window.location.href = `../search-page/index.html?${params}`;
  });

  promptEl.querySelector(".close-btn").addEventListener("click", () => {
    hideBboxPrompt();
  });

  document.body.appendChild(promptEl);
}

function hideBboxPrompt() {
  const existing = document.getElementById("bboxPrompt");
  if (existing) existing.remove();
}


// ============================================================
// RENDER POINTS ON MAP
// ============================================================

function renderPoints(points) {
  const geojson = {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      properties: {
        locality_id: p.locality_id,
        locality_name: p.locality_name,
        country: p.country,
        province: p.province || "",
        latitude: p.latitude,
        longitude: p.longitude,
        species_count: p.species_count,
        species_json: JSON.stringify(p.species || []),
      },
    })),
  };

  if (map.getSource(SPECIMENS_SOURCE_ID)) {
    map.getSource(SPECIMENS_SOURCE_ID).setData(geojson);
    return;
  }

  map.addSource(SPECIMENS_SOURCE_ID, {
    type: "geojson",
    data: geojson,
    cluster: true,
    clusterMaxZoom: 8,
    clusterRadius: 40,
    clusterProperties: {
      total_species: ["+", ["get", "species_count"]],
    },
  });

  // Cluster circles
  map.addLayer({
    id: CLUSTERS_LAYER_ID,
    type: "circle",
    source: SPECIMENS_SOURCE_ID,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": [
        "step",
        ["get", "point_count"],
        "#4da6ff",
        10, "#3d8bfd",
        50, "#f59e0b",
        200, "#ef4444",
      ],
      "circle-radius": [
        "step",
        ["get", "point_count"],
        16,
        10, 22,
        50, 28,
        200, 36,
      ],
      "circle-stroke-width": 2.5,
      "circle-stroke-color": "#ffffff",
      "circle-opacity": 0.9,
    },
  });

  // Cluster count text
  map.addLayer({
    id: CLUSTER_COUNT_LAYER_ID,
    type: "symbol",
    source: SPECIMENS_SOURCE_ID,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 13,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#ffffff",
    },
  });

  // Individual point markers (pin shape)
  map.addLayer({
    id: POINT_LAYER_ID,
    type: "symbol",
    source: SPECIMENS_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    layout: {
      "icon-image": PIN_IMAGE_ID,
      "icon-anchor": "bottom",
      "icon-size": 0.85,
      "icon-allow-overlap": true,
    },
  });

  // Click cluster: zoom in
  map.on("click", CLUSTERS_LAYER_ID, (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: [CLUSTERS_LAYER_ID] });
    const clusterId = features[0].properties.cluster_id;
    const source = map.getSource(SPECIMENS_SOURCE_ID);
    source.getClusterExpansionZoom(clusterId, (err, zoom) => {
      if (err) return;
      map.easeTo({
        center: features[0].geometry.coordinates,
        zoom: zoom,
      });
    });
  });

  // Click individual pin: show popup with species list
  map.on("click", POINT_LAYER_ID, (e) => {
    const props = e.features[0].properties;
    const coords = e.features[0].geometry.coordinates.slice();
    const point = allPoints.find(p => p.locality_id === props.locality_id);
    const rawSpecies = point?.species || [];
    const localityName = props.locality_name || '';
    const country = props.country || '';
    const province = props.province || '';

    const lat = Number(props.latitude);
    const lng = Number(props.longitude);

    const coordsText =
      !isNaN(lat) && !isNaN(lng)
        ? `${lat.toFixed(4)}, ${lng.toFixed(4)}`
        : '';

    const secondaryParts = [province, country].filter(Boolean);

    // Normalize species to handle both formats:
    // Old format: plain string "Genus species (Author, Year)"
    // New format: {name, genus, species}
    const species = rawSpecies.map((sp) => {
      if (typeof sp === 'string') {
        // Parse "Genus (Subgenus) species (Author, Year)" from string
        const cleaned = sp.replace(/\([A-Z][a-z]*\.?\)\s*/g, '').trim();
        const parts = cleaned.split(/\s+/);
        return { name: sp, genus: parts[0] || '', species: parts[1] || '' };
      }
      return sp;
    });

    const maxShow = 10;
    const shown = species.slice(0, maxShow);

    let speciesHtml = '';

    if (shown.length > 0) {
      speciesHtml = `
        <div class="popup-species-list">
          ${shown.map((sp) => {
            const isUndetermined =
              !sp.species ||
              sp.species === 'undetermined' ||
              sp.species === 'sp';

            if (isUndetermined) {
              return `
                <div class="popup-species-item popup-species-unid">
                  ${escapeHtml(sp.name)}
                </div>
              `;
            }

            const query = `${sp.genus} ${sp.species}`.trim();

            return `
              <a class="popup-species-item"
                href="../search-page/index.html?q=${encodeURIComponent(query)}&autoSearch=1">
                ${escapeHtml(sp.name)}
              </a>
            `;
          }).join('')}
        </div>
      `;
    } else {
      speciesHtml = `<div class="popup-no-species">No species recorded</div>`;
    }

    const moreHtml =
      species.length > maxShow
        ? `<div class="popup-more">+ ${species.length - maxShow} more</div>`
        : '';

    const popupHtml = `
      <div class="locality-popup">

        <div class="popup-header">
          <div class="popup-title">${escapeHtml(localityName)}</div>
          ${
            secondaryParts.length
              ? `<div class="popup-subtitle">${escapeHtml(secondaryParts.join(', '))}</div>`
              : ''
          }
          ${
            coordsText
              ? `<div class="popup-coords">${coordsText}</div>`
              : ''
          }
        </div>

        <div class="popup-body">
          <div class="popup-count">${species.length} species</div>
          ${speciesHtml}
          ${moreHtml}
        </div>

        <div class="popup-footer">
          <a class="popup-link"
            href="../search-page/index.html?localityId=${encodeURIComponent(props.locality_id)}">
            View in search →
          </a>
        </div>

      </div>
    `;

    new maplibregl.Popup({ maxWidth: '320px', closeButton: true })
      .setLngLat(coords)
      .setHTML(popupHtml)
      .addTo(map);
  });

  // Cursor changes
  [CLUSTERS_LAYER_ID, POINT_LAYER_ID].forEach((layer) => {
    map.on("mouseenter", layer, () => {
      if (!bboxMode) map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layer, () => {
      if (!bboxMode) map.getCanvas().style.cursor = "";
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


// ============================================================
// LOAD ALL SPECIMEN POINTS
// ============================================================

async function loadSpecimenPoints() {
  try {
    await loadPinImage();

    showLoadingState('Loading localities...');

    const points = await getMapPoints({}, (progress) => {
      if (progress.phase === 'fetching') {
        updateLoadingState('Fetching locality data...');
      } else if (progress.phase === 'filtering') {
        updateLoadingState(`Loaded ${progress.loaded.toLocaleString()} localities`);
      }
    });

    // Filter to only valid species using genus allowlist
    updateLoadingState('Filtering valid species...');
    // getGenusTribeMap imported at top
    const genusTribeMap = await getGenusTribeMap();
    const validGenera = new Set(Object.keys(genusTribeMap));

    for (const p of points) {
      p.species = (p.species || []).filter((sp) => {
        const name = typeof sp === 'string' ? sp : sp.name;
        // Clean subgenus parens for matching: "Genus (Subgenus) species" -> "Genus species"
        const cleaned = name.replace(/\([A-Z][a-z]*\.?\)\s*/g, '').trim();
        const parts = cleaned.split(/\s+/);
        return validGenera.has(parts[0]);
      });
      p.species_count = p.species.length;
    }

    // Remove localities with no valid species
    const filteredPoints = points.filter((p) => p.species.length > 0);
    allPoints = filteredPoints;
    isLoaded = true;

    hideLoadingState();

    if (filteredPoints.length === 0) {
      showLoadingState('No localities with coordinates found');
      return;
    }

    renderPoints(filteredPoints);

    // Update stats in header if element exists
    const statsEl = document.getElementById('mapStats');
    if (statsEl) {
      const speciesNames = new Set();
      for (const p of points) {
        for (const sp of (p.species || [])) {
          speciesNames.add(typeof sp === 'string' ? sp : sp.name);
        }
      }
      statsEl.textContent = `${points.length.toLocaleString()} localities, ${speciesNames.size.toLocaleString()} species`;
    }

    // Check URL for initial bounding box
    const params = new URLSearchParams(window.location.search);
    if (params.has('west')) {
      const bounds = {
        west: parseFloat(params.get('west')),
        south: parseFloat(params.get('south')),
        east: parseFloat(params.get('east')),
        north: parseFloat(params.get('north')),
      };
      currentBbox = bounds;

      // Filter and re-render for the bbox
      const filtered = points.filter((p) =>
        p.latitude >= bounds.south && p.latitude <= bounds.north &&
        p.longitude >= bounds.west && p.longitude <= bounds.east
      );
      renderPoints(filtered);

      // Draw the bbox on the map
      ensureBboxLayers();
      setBboxPreview(
        { lng: bounds.west, lat: bounds.south },
        { lng: bounds.east, lat: bounds.north }
      );
      fitBoundsWithPanel([[bounds.west, bounds.south], [bounds.east, bounds.north]]);
      showBboxPrompt(bounds, filtered);
    }
  } catch (err) {
    console.error("Failed to load specimen points:", err);
    showLoadingState('Failed to load locality data. Please refresh.');
  }
}


// ============================================================
// MAP LOAD HANDLER
// ============================================================

map.on("load", () => {
  ensureBboxLayers();
  // force re-add if lost
  if (!map.getSource("user-bbox")) {
    ensureBboxLayers();
  }
  populateTribeFilter();
  loadSpecimenPoints();

  const navContainer = nav._container;
  if (!navContainer.querySelector(".maplibregl-ctrl-world")) {
    const worldBtn = document.createElement("button");
    worldBtn.type = "button";
    worldBtn.className = "maplibregl-ctrl-icon maplibregl-ctrl-world";
    worldBtn.title = "Zoom to world";
    worldBtn.innerHTML = `<img src="./assets/zoom-world.png" alt="Zoom to world">`;
    worldBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    worldBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setBboxMode(false);
      clearBbox();
      fitBoundsWithPanel([[-180, -85], [180, 85]]);
    });
    navContainer.appendChild(worldBtn);
  }

  // Hide grid lines from demotiles style
  ['countries-boundary', 'geolines'].forEach((layerId) => {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none');
  });

  // Style switcher
  const styleDiv = document.createElement('div');
  styleDiv.className = 'maplibregl-ctrl';
  styleDiv.style.cssText = 'padding:2px;background:#fff;border-radius:4px;';
  styleDiv.innerHTML = `<select id="mapStyleSelect" style="border:none;font-size:11px;padding:2px 4px;cursor:pointer;background:#fff;width:70px;">
    ${Object.entries(MAP_STYLES).map(([key, s]) => `<option value="${key}" ${key === currentStyle ? 'selected' : ''}>${s.name}</option>`).join('')}
  </select>`;
  map.getContainer().appendChild(styleDiv);
  styleDiv.style.cssText += 'position:absolute;top:16px;right:60px;z-index:20;box-shadow:0 2px 6px rgba(0,0,0,0.15);border-radius:6px;';

  document.getElementById('mapStyleSelect').addEventListener('change', (e) => {
    const key = e.target.value;
    localStorage.setItem('mapStyle', key);
    currentStyle = key;
    if (key === 'satellite') {
      map.setStyle({
        version: 8,
        sources: {
          'satellite': {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            attribution: '&copy; Esri',
            maxzoom: 18,
          },
        },
        layers: [{
          id: 'satellite-tiles',
          type: 'raster',
          source: 'satellite',
          minzoom: 0,
          maxzoom: 18,
        }],
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      });
    } else {
      map.setStyle(MAP_STYLES[key].url);
    }
    map.once('idle', () => {
      [POINT_LAYER_ID, CLUSTER_COUNT_LAYER_ID, CLUSTERS_LAYER_ID].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (map.getSource(SPECIMENS_SOURCE_ID)) map.removeSource(SPECIMENS_SOURCE_ID);
      if (map.getSource(BBOX_SOURCE_ID)) map.removeSource(BBOX_SOURCE_ID);
      if (map.hasImage(PIN_IMAGE_ID)) map.removeImage(PIN_IMAGE_ID);
      ensureBboxLayers();
      if (isLoaded) {
        loadPinImage().then(() => renderPoints(allPoints));
      }
    });
  });
});

if (mapSearchBtn) {
  mapSearchBtn.addEventListener("click", () => {
    clearBbox();
    loadSpecimenPoints(getMapFilters());
  });
}

if (mapResetBtn) {
  mapResetBtn.addEventListener("click", () => {
    resetMapFilters();
    clearBbox();
    loadSpecimenPoints();
  });
}

document.getElementById("filterPanel")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.tagName !== "BUTTON") {
    event.preventDefault();
    clearBbox();
    loadSpecimenPoints(getMapFilters());
  }
});


// ============================================================
// BOUNDING BOX DRAWING HANDLERS
// ============================================================

map.on("mousemove", (e) => {
  if (!bboxMode || !firstCorner) return;
  setBboxPreview(firstCorner, e.lngLat);
});

map.on("click", (e) => {
  if (!bboxMode) return;

  if (!firstCorner) {
    firstCorner = e.lngLat;
    setBboxPreview(firstCorner, firstCorner);
    return;
  }

  const secondCorner = e.lngLat;
  setBboxPreview(firstCorner, secondCorner);

  const west = Math.min(firstCorner.lng, secondCorner.lng);
  const east = Math.max(firstCorner.lng, secondCorner.lng);
  const south = Math.min(firstCorner.lat, secondCorner.lat);
  const north = Math.max(firstCorner.lat, secondCorner.lat);

  currentBbox = { west, south, east, north };

  // Filter the already-loaded points client-side (instant)
  const filtered = allPoints.filter((p) =>
    p.latitude >= south && p.latitude <= north &&
    p.longitude >= west && p.longitude <= east
  );

  renderPoints(filtered);
  setTimeout(() => {
    fitBoundsWithPanel([[west, south], [east, north]]);
    showBboxPrompt(currentBbox, filtered);
  }, 50);
  setBboxMode(false);
});
