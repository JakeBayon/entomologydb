// Map page logic
// Loads specimen localities from the API and renders them as clustered pins.
// Clicking a pin or drawing a bounding box navigates to the search page.

import { getMapPoints, getLocality, TRIBES } from '../shared/bruchindb-api.js';
import { polygonFromCorners } from './boundingbox-utils.js';


// ============================================================
// CONSTANTS AND STATE
// ============================================================

let bboxMode = false;
let firstCorner = null;
let bboxBtnEl = null;
let currentBbox = null;

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
// Uses MapLibre's free demotiles style. It's basic but very fast.
// To switch to a fancier style later, replace the style URL.
// ============================================================

const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
  center: [-85, 10],
  zoom: 3,
});

window.map = map;

const nav = new maplibregl.NavigationControl({ visualizePitch: true });
map.addControl(nav, "top-right");


// ============================================================
// PIN MARKER (SVG loaded as map image)
// Teardrop shape with a point at the bottom.
// ============================================================

const PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48">
  <path d="M18 0 C8.06 0 0 8.06 0 18 C0 31.5 18 48 18 48 C18 48 36 31.5 36 18 C36 8.06 27.94 0 18 0 Z" fill="#76b476" stroke="#ffffff" stroke-width="2"/>
  <circle cx="18" cy="18" r="6" fill="#ffffff"/>
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
// Floating button that appears after a bbox is drawn,
// asking the user if they want to view results in the search page.
// ============================================================

function showBboxPrompt(bounds) {
  hideBboxPrompt();

  // Count species inside the bounds (using mock or real API)
  getMapPoints({ bounds }).then((points) => {
    const speciesIds = new Set();
    points.forEach((p) => p.species_ids.forEach((id) => speciesIds.add(id)));

    const promptEl = document.createElement("div");
    promptEl.className = "bbox-prompt";
    promptEl.id = "bboxPrompt";
    promptEl.innerHTML = `
      <span>${speciesIds.size} species in this area</span>
      <button type="button">View results →</button>
      <button type="button" class="close-btn" aria-label="Close">×</button>
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
  });
}

function hideBboxPrompt() {
  const existing = document.getElementById("bboxPrompt");
  if (existing) existing.remove();
}


// ============================================================
// SPECIMEN MARKERS WITH CLUSTERING
// ============================================================

function pointsToGeoJson(points) {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      properties: {
        locality_id: p.locality_id,
        locality_name: p.locality_name,
        country: p.country,
        province: p.province || "",
        specimen_count: p.specimen_count,
        species_count: p.species_count,
        species_names_json: JSON.stringify(p.species_names || []),
        // Store species_ids as a JSON string so it survives the geojson roundtrip
        species_ids_json: JSON.stringify(p.species_ids),
      },
    })),
  };
}

function fitToPoints(points) {
  if (!points.length) return;

  const bounds = new maplibregl.LngLatBounds();
  points.forEach((point) => bounds.extend([point.longitude, point.latitude]));
  fitBoundsWithPanel(bounds);
}

async function loadSpecimenPoints(extraFilters = {}) {
  try {
    await loadPinImage();

    // Read filters from URL so map matches search page
    const params = new URLSearchParams(window.location.search);
    const filters = { ...extraFilters };
    if (params.has('west')) {
      filters.bounds = {
        west: parseFloat(params.get('west')),
        south: parseFloat(params.get('south')),
        east: parseFloat(params.get('east')),
        north: parseFloat(params.get('north')),
      };
    }
    const points = await getMapPoints(filters);
    const geojson = pointsToGeoJson(points);

    if (map.getSource(SPECIMENS_SOURCE_ID)) {
      map.getSource(SPECIMENS_SOURCE_ID).setData(geojson);
      fitToPoints(points);
      return;
    }

    map.addSource(SPECIMENS_SOURCE_ID, {
      type: "geojson",
      data: geojson,
      cluster: true,
      clusterMaxZoom: 5,
      clusterRadius: 40,
      clusterProperties: {
        total_specimens: ["+", ["get", "specimen_count"]],
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
          ["get", "total_specimens"],
          "#76b476",
          100, "#f1a93b",
          500, "#e67e22",
        ],
        "circle-radius": [
          "step",
          ["get", "total_specimens"],
          20,
          100, 28,
          500, 36,
        ],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });

    // Cluster count text
    map.addLayer({
      id: CLUSTER_COUNT_LAYER_ID,
      type: "symbol",
      source: SPECIMENS_SOURCE_ID,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "total_specimens"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 14,
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

    // Click individual pin: navigate to search page (or species page if single)
    map.on("click", POINT_LAYER_ID, (e) => {
      const props = e.features[0].properties;
      const params = new URLSearchParams();
      if (props.country) params.set("countries", props.country);
      if (props.province) params.set("provinces", props.province);
      if (props.locality_name) params.set("localities", props.locality_name);
      window.location.href = `../search-page/index.html?${params}`;
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

    fitToPoints(points);
  } catch (err) {
    console.error("Failed to load specimen points:", err);
  }
}


// ============================================================
// MAP LOAD HANDLER
// ============================================================

map.on("load", () => {
  ensureBboxLayers();
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
      fitBoundsWithPanel([[-180, -85], [180, 85]]);
    });
    navContainer.appendChild(worldBtn);
  }
  // Hide grid lines from demotiles style
  ['countries-boundary', 'geolines'].forEach((layerId) => {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none');
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

// Bounding box drawing handlers
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
  fitBoundsWithPanel([[west, south], [east, north]]);
  setBboxMode(false);
  showBboxPrompt(currentBbox);
});
