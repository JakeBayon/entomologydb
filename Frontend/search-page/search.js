// Search page logic
// Hooks up the filter sidebar to the BruchinDB API and renders results.
// Reads URL params (localityId, bounds) to apply filters from the map page.

import {
  searchSpecies,
  getLocality,
  TRIBES,
} from '../shared/bruchindb-api.js';

sessionStorage.removeItem('breadcrumbActive');

// ============================================================
// ELEMENT REFERENCES
// ============================================================

const cardsGrid = document.querySelector('.cards-grid');
const searchBtn = document.getElementById('searchBtn');
const resetBtn = document.getElementById('resetBtn');
const resultsCount = document.getElementById('resultsCount');
const filterBanner = document.getElementById('filterBanner');

const sciNameInput = document.getElementById('sci-name-search');
const sciNameSuggestions = document.getElementById('sci-name-suggestions');
const selectedChipsContainer = document.getElementById('selectedChips');
const countryInput = document.getElementById('filter-country');
const provinceInput = document.getElementById('province-input');
const localityInput = document.getElementById('locality-input');
const tribeSelect = document.getElementById('filter-tribe');
const imagesOnlyCheckbox = document.getElementById('filter-images-only');


// ============================================================
// READ URL PARAMS
// These come from the map page when the user clicks a marker
// or accepts a bounding box prompt.
// ============================================================

const urlParams = new URLSearchParams(window.location.search);

const initialFilters = {};
let bannerText = '';
let allSpeciesCache = [];
let selectedSpeciesIds = new Set();
const PAGE_SIZE = 50;
let currentPage = 1;
let lastResults = [];

searchSpecies({}).then((all) => { allSpeciesCache = all; });

// Location autocomplete state
let locationsData = null;
const selectedCountries = new Set();
const selectedProvinces = new Set();
const selectedLocalities = new Set();

const countrySuggestions = document.getElementById('country-suggestions');
const countryChips = document.getElementById('country-chips');
const provinceSuggestions = document.getElementById('province-suggestions');
const provinceChips = document.getElementById('province-chips');
const localitySuggestions = document.getElementById('locality-suggestions');
const localityChips = document.getElementById('locality-chips');

async function loadLocations() {
  if (locationsData) return locationsData;
  try {
    const res = await fetch('../shared/locations.json');
    const raw = await res.json();
    // Trim and clean all location strings
    const clean = (s) => s.replace(/[\x00-\x1f]/g, '').trim();
    raw.countries = [...new Set(raw.countries.map(clean).filter(Boolean))].sort();
    for (const key of Object.keys(raw.provincesByCountry)) {
      const cleanKey = clean(key);
      const vals = [...new Set(raw.provincesByCountry[key].map(clean).filter(Boolean))].sort();
      if (cleanKey !== key) {
        delete raw.provincesByCountry[key];
        raw.provincesByCountry[cleanKey] = vals;
      } else {
        raw.provincesByCountry[key] = vals;
      }
    }
    locationsData = raw;
    return locationsData;
  } catch (err) {
    console.error('Failed to load locations:', err);
    return null;
  }
}

function setupAutocomplete(input, suggestionsEl, chipsEl, getOptions, selectedSet, onChange) {
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      suggestionsEl.innerHTML = '';
      suggestionsEl.style.display = 'none';
      return;
    }
    const options = getOptions().filter(
      (opt) => opt.toLowerCase().startsWith(query) && !selectedSet.has(opt)
    ).sort();
    if (options.length === 0) {
      suggestionsEl.style.display = 'none';
      return;
    }
    suggestionsEl.innerHTML = options.slice(0, 10).map(
      (opt) => `<div class="autocomplete-item">${escapeHtml(opt)}</div>`
    ).join('');
    suggestionsEl.style.display = 'block';
    suggestionsEl.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
      item.addEventListener('click', (e) => {
        selectedSet.add(options[idx]);
        item.classList.add('selected');
        renderChipList(chipsEl, selectedSet, onChange);
        if (e.ctrlKey || e.metaKey) {
          // Keep open, re-render options
          input.dispatchEvent(new Event('input'));
        } else {
          input.value = '';
          suggestionsEl.innerHTML = '';
          suggestionsEl.style.display = 'none';
          if (onChange) onChange();
        }
      });
    });
  });
  input.addEventListener('focus', () => {
    if (!input.value.trim()) {
      input.dispatchEvent(new Event('input'));
      // Force show with empty query showing first results
      const options = getOptions().filter((opt) => !selectedSet.has(opt)).sort().slice(0, 50);
      if (options.length > 0) {
        suggestionsEl.innerHTML = options.map(
          (opt) => `<div class="autocomplete-item">${escapeHtml(opt)}</div>`
        ).join('');
        suggestionsEl.style.display = 'block';
        suggestionsEl.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
          item.addEventListener('click', (e) => {
            selectedSet.add(options[idx]);
            renderChipList(chipsEl, selectedSet, onChange);
            if (e.ctrlKey || e.metaKey) {
              input.dispatchEvent(new Event('input'));
            } else {
              input.value = '';
              suggestionsEl.innerHTML = '';
              suggestionsEl.style.display = 'none';
              if (onChange) onChange();
            }
          });
        });
      }
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => suggestionsEl.style.display = 'none', 200);
  });
}

function renderChipList(container, selectedSet, onChange) {
  container.innerHTML = [...selectedSet].map(
    (item) => `<span class="chip">${escapeHtml(item)} <button type="button" class="chip-remove" data-value="${escapeHtml(item)}">×</button></span>`
  ).join('');
  container.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedSet.delete(btn.dataset.value);
      renderChipList(container, selectedSet, onChange);
      if (onChange) onChange();
    });
  });
}

(async () => {
  const locs = await loadLocations();
  if (!locs) return;

  setupAutocomplete(
    countryInput, countrySuggestions, countryChips,
    () => locs.countries, selectedCountries
  );
  setupAutocomplete(
    provinceInput, provinceSuggestions, provinceChips,
    () => {
      // Suggest provinces from selected countries (or all if none selected)
      const set = new Set();
      if (selectedCountries.size > 0) {
        for (const c of selectedCountries) {
          (locs.provincesByCountry[c] || []).forEach((p) => set.add(p));
        }
      } else {
        Object.values(locs.provincesByCountry).flat().forEach((p) => set.add(p));
      }
      return [...set].sort();
    },
    selectedProvinces
  );
  setupAutocomplete(
    localityInput, localitySuggestions, localityChips,
    () => {
      // Suggest localities filtered by selected country+province if set
      const set = new Set();
      if (selectedCountries.size > 0 && selectedProvinces.size > 0) {
        for (const c of selectedCountries) {
          for (const p of selectedProvinces) {
            (locs.localitiesByProvince[`${c}|${p}`] || []).forEach((l) => set.add(l));
          }
        }
      } else {
        Object.values(locs.localitiesByProvince).flat().forEach((l) => set.add(l));
      }
      return [...set].sort();
    },
    selectedLocalities
  );
})();

function renderSuggestions(query) {
  const q = (query || '').toLowerCase();
  const matches = allSpeciesCache
    .filter((s) => !selectedSpeciesIds.has(s.Species_ID))
    .filter((s) => !q || s.Full_name.toLowerCase().startsWith(q) || s.Genus.toLowerCase().startsWith(q))
    .sort((a, b) => a.Full_name.localeCompare(b.Full_name))
    .slice(0, 50);
  if (matches.length === 0) { sciNameSuggestions.innerHTML = ''; return; }
  sciNameSuggestions.innerHTML = matches.map((s) =>
    `<div class="suggestion-item" data-id="${s.Species_ID}"><em>${escapeHtml(s.Genus)} ${escapeHtml(s.Species)}</em></div>`
  ).join('');
  sciNameSuggestions.querySelectorAll('.suggestion-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      selectedSpeciesIds.add(el.dataset.id);
      el.classList.add('selected');
      renderChips();
      if (e.ctrlKey || e.metaKey) {
        // Keep dropdown open, re-render without the selected item
        renderSuggestions(sciNameInput.value);
      } else {
        sciNameInput.value = '';
        sciNameSuggestions.innerHTML = '';
        runSearch();
      }
    });
  });
}

function renderChips() {
  if (selectedSpeciesIds.size === 0) {
    selectedChipsContainer.innerHTML = '';
    return;
  }
  const chips = [...selectedSpeciesIds].map((id) => {
    const s = allSpeciesCache.find((x) => x.Species_ID === id);
    if (!s) return '';
    return `<span class="chip"><em>${escapeHtml(s.Genus)} ${escapeHtml(s.Species)}</em><button data-id="${id}">×</button></span>`;
  }).join('');
  selectedChipsContainer.innerHTML = chips;
  selectedChipsContainer.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedSpeciesIds.delete(btn.dataset.id);
      renderChips();
      runSearch();
    });
  });
}

if (urlParams.get('localityId')) {
  initialFilters.localityIds = [urlParams.get('localityId')];
}

if (urlParams.has('west') && urlParams.has('south') && urlParams.has('east') && urlParams.has('north')) {
  initialFilters.bounds = {
    west: parseFloat(urlParams.get('west')),
    south: parseFloat(urlParams.get('south')),
    east: parseFloat(urlParams.get('east')),
    north: parseFloat(urlParams.get('north')),
  };
  bannerText = 'Showing species inside the bounding box from the map.';
}


// ============================================================
// POPULATE FILTER DROPDOWNS
// ============================================================

function populateDropdown(selectEl, options, placeholder) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = placeholder;
  selectEl.appendChild(placeholderOption);
  options.forEach((opt) => {
    const optionEl = document.createElement('option');
    optionEl.value = opt;
    optionEl.textContent = opt;
    selectEl.appendChild(optionEl);
  });
}

populateDropdown(tribeSelect, TRIBES, 'Any tribe');


// ============================================================
// SET BANNER TEXT IF FILTERED FROM MAP
// ============================================================

async function updateBanner() {
  if (!filterBanner) return;

  if (initialFilters.localityIds && initialFilters.localityIds.length === 1) {
    const loc = await getLocality(initialFilters.localityIds[0]);
    if (loc) {
      bannerText = `Showing species at ${loc.locality_name}, ${loc.country}${loc.province ? ', ' + loc.province : ''}.`;
    }
  }

  if (bannerText) {
    filterBanner.innerHTML = `
      <span>${bannerText}</span>
      <button type="button" id="clearBannerBtn">Clear filter ×</button>
    `;
    filterBanner.style.display = 'flex';
    document.getElementById('clearBannerBtn').addEventListener('click', () => {
      delete initialFilters.localityIds;
      delete initialFilters.bounds;
      bannerText = '';
      filterBanner.style.display = 'none';
      filterBanner.innerHTML = '';
      window.history.replaceState({}, '', window.location.pathname);
      runSearch();
    });
  } else {
    filterBanner.style.display = 'none';
  }
}


// ============================================================
// URL STATE
// ============================================================

function filtersToUrl() {
  const url = new URL(window.location);
  // Tribe
  if (tribeSelect?.value) url.searchParams.set('tribe', tribeSelect.value);
  else url.searchParams.delete('tribe');
  // Countries
  if (selectedCountries.size > 0) url.searchParams.set('countries', [...selectedCountries].join('|'));
  else url.searchParams.delete('countries');
  // Provinces
  if (selectedProvinces.size > 0) url.searchParams.set('provinces', [...selectedProvinces].join('|'));
  else url.searchParams.delete('provinces');
  // Localities
  if (selectedLocalities.size > 0) url.searchParams.set('localities', [...selectedLocalities].join('|'));
  else url.searchParams.delete('localities');
  // Species chips
  if (selectedSpeciesIds.size > 0) url.searchParams.set('species', [...selectedSpeciesIds].join('|'));
  else url.searchParams.delete('species');
  // Page
  url.searchParams.set('page', String(currentPage));
  // Sort
  const sortSelect = document.getElementById('sortSelect');
  if (sortSelect?.value && sortSelect.value !== 'az') url.searchParams.set('sort', sortSelect.value);
  else url.searchParams.delete('sort');

  history.replaceState(null, '', url);
}

function filtersFromUrl() {
  const params = new URLSearchParams(window.location.search);

  // Tribe
  const tribe = params.get('tribe');
  if (tribe && tribeSelect) tribeSelect.value = tribe;

  // Countries
  const countries = params.get('countries');
  if (countries) {
    countries.split('|').forEach((c) => selectedCountries.add(c));
    const countryChipsEl = document.getElementById('country-chips');
    if (countryChipsEl) renderChipList(countryChipsEl, selectedCountries);
  }

  // Provinces
  const provinces = params.get('provinces');
  if (provinces) {
    provinces.split('|').forEach((p) => selectedProvinces.add(p));
    const provinceChipsEl = document.getElementById('province-chips');
    if (provinceChipsEl) renderChipList(provinceChipsEl, selectedProvinces);
  }

  // Localities
  const localities = params.get('localities');
  if (localities) {
    localities.split('|').forEach((l) => selectedLocalities.add(l));
    const localityChipsEl = document.getElementById('locality-chips');
    if (localityChipsEl) renderChipList(localityChipsEl, selectedLocalities);
  }

  // Species chips
  const species = params.get('species');
  if (species) {
    species.split('|').forEach((id) => selectedSpeciesIds.add(id));
    renderChips();
  }

  // Page
  const page = parseInt(params.get('page'), 10);
  if (page && page > 0) currentPage = page;

  // Sort
  const sort = params.get('sort');
  const sortSelect = document.getElementById('sortSelect');
  if (sort && sortSelect) sortSelect.value = sort;
}

function getFilters() {
  const filters = {
    speciesIds: selectedSpeciesIds.size > 0 ? [...selectedSpeciesIds] : null,
    countries: selectedCountries.size > 0 ? [...selectedCountries] : null,
    countryVariants: locationsData?.countryVariants || {},
    provinces: selectedProvinces.size > 0 ? [...selectedProvinces] : null,
    localities: selectedLocalities.size > 0 ? [...selectedLocalities] : null,
    tribe: tribeSelect?.value || '',
    imagesOnly: imagesOnlyCheckbox?.checked || false,
  };

  if (initialFilters.localityIds) filters.localityIds = initialFilters.localityIds;
  if (initialFilters.bounds) filters.bounds = initialFilters.bounds;

  return filters;
}


// ============================================================
// RENDER RESULTS
// ============================================================

function renderLoading() {
  cardsGrid.innerHTML = `<div class="results-message"><div class="loading-spinner"></div>Searching FileMaker database...</div>`;
}

function renderError(message) {
  cardsGrid.innerHTML = `<div class="results-message error">
    <p>Could not load results</p>
    <p class="error-detail">${escapeHtml(message)}</p>
    <p class="error-hint">This usually means FileMaker Server is unreachable. Check that Dr. Morse's lab Mac is on and connected.</p>
    <button onclick="location.reload()" class="retry-btn">Retry</button>
  </div>`;
}

function renderEmpty() {
  cardsGrid.innerHTML = `<div class="results-message">No species match your filters.</div>`;
}

function renderCards(species) {
  if (species.length === 0) {
    renderEmpty();
    return;
  }

  cardsGrid.innerHTML = species.map((s) => `
    <a class="species-card" href="./species.html?id=${encodeURIComponent(s.Species_ID)}">
      <div class="species-info">
        <h3><em>${escapeHtml(s.Genus)} ${escapeHtml(s.Species)}</em></h3>
        <p class="card-meta">
          Subfamily Bruchinae${s.Tribe ? ` · ${escapeHtml(s.Tribe)}` : ''}
        </p>
        <span class="learn-more">Learn More →</span>      </div>
      <img
        class="species-img"
        src="./seed_beetle_logo_transparent.png"
        alt="${escapeHtml(s.Full_name)}"
      />
    </a>
  `).join('');
  const shouldRestore = sessionStorage.getItem('restoreScroll') || sessionStorage.getItem('searchScroll');
  if (shouldRestore) {
    const savedScroll = sessionStorage.getItem('searchScroll');
    if (savedScroll) {
      setTimeout(() => {
        window.scrollTo(0, parseInt(savedScroll, 10));
      }, 50);
    }
    sessionStorage.removeItem('restoreScroll');
    sessionStorage.removeItem('searchScroll');
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


// ============================================================
// RUN A SEARCH
// ============================================================

function getFilterCacheKey(filters) {
  return JSON.stringify({
    speciesIds: filters.speciesIds,
    countries: filters.countries,
    provinces: filters.provinces,
    localities: filters.localities,
    tribe: filters.tribe,
    imagesOnly: filters.imagesOnly,
  });
}

async function runSearch(useCache = false) {
  const filters = getFilters();
  const cacheKey = getFilterCacheKey(filters);

  // Try to restore from cache
  if (useCache) {
    const cached = sessionStorage.getItem('search:' + cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        lastResults = parsed.results;
        currentPage = parsed.page || currentPage;
        applySortToResults();
        if (resultsCount) {
          resultsCount.textContent = `${lastResults.length} result${lastResults.length === 1 ? '' : 's'}`;
        }
        renderPage();
        return;
      } catch {}
    }
  }

  renderLoading();
  try {
    const results = await searchSpecies(filters);
    lastResults = results;
    currentPage = 1;
    applySortToResults();

    // Cache results
    sessionStorage.setItem('search:' + cacheKey, JSON.stringify({
      results,
      page: 1,
    }));

    if (resultsCount) {
      resultsCount.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
    }
    renderPage();
  } catch (err) {
    console.error('Search error:', err);
    renderError(err.message);
  }
}

function applySortToResults() {
  const sortSelect = document.getElementById('sortSelect');
  if (!sortSelect || !lastResults) return;
  const mode = sortSelect.value;
  lastResults.sort((a, b) => {
    if (mode === 'az') return a.Full_name.localeCompare(b.Full_name);
    if (mode === 'za') return b.Full_name.localeCompare(a.Full_name);
    if (mode === 'newest') return (parseInt(b.Year) || 0) - (parseInt(a.Year) || 0);
    if (mode === 'oldest') return (parseInt(a.Year) || 0) - (parseInt(b.Year) || 0);
    return 0;
  });
}

function renderPage() {
  const totalPages = Math.max(1, Math.ceil(lastResults.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = lastResults.slice(start, start + PAGE_SIZE);

  renderCards(pageItems);
  renderPagination(totalPages);

  // Update URL with current state
  filtersToUrl();

  // Save current page back to cache
  const filters = getFilters();
  const cacheKey = getFilterCacheKey(filters);
  const existing = sessionStorage.getItem('search:' + cacheKey);
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      parsed.page = currentPage;
      sessionStorage.setItem('search:' + cacheKey, JSON.stringify(parsed));
    } catch {}
  }
}

function renderPagination(totalPages) {
  let container = document.getElementById('pagination');
  if (!container) {
    container = document.createElement('div');
    container.id = 'pagination';
    container.className = 'pagination';
    cardsGrid.parentNode.appendChild(container);
  }

  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  const pages = new Set();
  pages.add(1);
  pages.add(totalPages);
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    pages.add(i);
  }
  const sorted = [...pages].sort((a, b) => a - b);

  let html = '';
  html += `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">← Prev</button>`;

  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) html += `<span class="page-ellipsis">...</span>`;
    html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
    prev = p;
  }

  html += `<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Next →</button>`;

  container.innerHTML = html;

  container.querySelectorAll('.page-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page, 10);
      if (!isNaN(p) && p >= 1 && p <= totalPages) {
        currentPage = p;
        renderPage();
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }
    });
  });
}

// ============================================================
// EVENT HANDLERS
// ============================================================

if (searchBtn) {
  searchBtn.addEventListener('click', () => {
    currentPage = 1;
    runSearch();
  });
}

// Enter key triggers search
document.querySelector('.filter-panel')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    currentPage = 1;
    runSearch();
  }
});
// Tribe dropdown change is picked up when user clicks Search

if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    if (sciNameInput) sciNameInput.value = '';
    selectedSpeciesIds.clear();
    renderChips();
    selectedCountries.clear();
    selectedProvinces.clear();
    selectedLocalities.clear();
    const countryChipsEl = document.getElementById('country-chips');
    const provinceChipsEl = document.getElementById('province-chips');
    const localityChipsEl = document.getElementById('locality-chips');
    if (countryChipsEl) renderChipList(countryChipsEl, selectedCountries);
    if (provinceChipsEl) renderChipList(provinceChipsEl, selectedProvinces);
    if (localityChipsEl) renderChipList(localityChipsEl, selectedLocalities);
    if (countryInput) countryInput.value = '';
    if (provinceInput) provinceInput.value = '';
    if (localityInput) localityInput.value = '';
    if (tribeSelect) tribeSelect.value = '';
    if (imagesOnlyCheckbox) imagesOnlyCheckbox.checked = false;
    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) sortSelect.value = 'az';
    currentPage = 1;
    // Clear URL params
    history.replaceState(null, '', window.location.pathname);
    runSearch();
  });
}

// Sort dropdown
const sortSelect = document.getElementById('sortSelect');
if (sortSelect) {
  sortSelect.addEventListener('change', () => {
    if (!lastResults || lastResults.length === 0) return;
    applySortToResults();
    currentPage = 1;
    renderPage();
  });
}

// Restore state from URL, then run search
filtersFromUrl();
updateBanner();
const hasUrlFilters = window.location.search.length > 0;
runSearch(!hasUrlFilters);

// Save scroll position when clicking a species card
document.addEventListener('click', (e) => {
  const card = e.target.closest('.species-card');
  if (card) {
    sessionStorage.setItem('searchScroll', String(window.scrollY));
    sessionStorage.setItem('searchUrl', window.location.search);
    sessionStorage.setItem('searchScrollUrl', window.location.pathname + window.location.search);
  }
});

// ============================================================
// ACTIVE FILTERS DISPLAY
// ============================================================

function renderActiveFilters() {
  const container = document.getElementById('active-filters');
  if (!container) return;

  const chips = [];
  if (tribeSelect?.value) chips.push({ label: `Tribe: ${tribeSelect.value}`, type: 'tribe' });
  [...selectedCountries].forEach((c) => chips.push({ label: c, type: 'country', value: c }));
  [...selectedProvinces].forEach((p) => chips.push({ label: p, type: 'province', value: p }));
  [...selectedLocalities].forEach((l) => chips.push({ label: l, type: 'locality', value: l }));
  [...selectedSpeciesIds].forEach((id) => {
    const s = allSpeciesCache.find((x) => x.Species_ID === id);
    if (s) chips.push({ label: `${s.Genus} ${s.Species}`, type: 'species', value: id });
  });

  if (chips.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="active-filters-label">Active filters:</div>
    <div class="active-filters-chips">
      ${chips.map((c) => `
        <span class="chip active-chip">${escapeHtml(c.label)}
          <button type="button" class="chip-x" data-type="${c.type}" data-value="${escapeHtml(c.value || '')}">x</button>
        </span>
      `).join('')}
      <button type="button" class="clear-all-filters" id="clearAllFilters">Clear all</button>
    </div>
  `;

  container.querySelectorAll('.chip-x').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      const value = btn.dataset.value;
      if (type === 'tribe' && tribeSelect) tribeSelect.value = '';
      if (type === 'country') selectedCountries.delete(value);
      if (type === 'province') selectedProvinces.delete(value);
      if (type === 'locality') selectedLocalities.delete(value);
      if (type === 'species') { selectedSpeciesIds.delete(value); renderChips(); }
      runSearch();
    });
  });

  const clearAll = container.querySelector('#clearAllFilters');
  if (clearAll) {
    clearAll.addEventListener('click', () => {
      document.getElementById('resetBtn')?.click();
    });
  }
}

// ============================================================
// RECENTLY VIEWED (last 10, show 5 with scroll)
// ============================================================

function renderRecentlyViewed() {
  const container = document.getElementById('recently-viewed-list');
  if (!container) return;
  const recent = JSON.parse(localStorage.getItem('recentSpecies') || '[]');
  if (recent.length === 0) {
    container.innerHTML = '<p class="filter-hint">No species viewed yet.</p>';
    return;
  }
  container.innerHTML = `
    <div class="recent-scroll">
      ${recent.map((r) => `
        <a class="recent-sidebar-item" href="./species.html?id=${encodeURIComponent(r.id)}">
          <em>${escapeHtml(r.name)}</em>
        </a>
      `).join('')}
    </div>
  `;
}

// ============================================================
// SAVED QUERIES (inline naming)
// ============================================================

function renderSavedQueries() {
  const container = document.getElementById('saved-queries-list');
  if (!container) return;
  const saved = JSON.parse(localStorage.getItem('savedQueries') || '[]');
  if (saved.length === 0) {
    container.innerHTML = '<p class="filter-hint">No saved queries yet.</p>';
    return;
  }
  container.innerHTML = saved.map((q, idx) => `
    <div class="saved-query-item">
      <div class="saved-query-left">
        <a class="saved-query-link" href="./index.html?${q.params}">${escapeHtml(q.name)}</a>
        <div class="saved-query-details">${escapeHtml(decodeFilterParams(q.params))}</div>
      </div>
      <button type="button" class="saved-query-delete" data-idx="${idx}">x</button>
    </div>
  `).join('');
  container.querySelectorAll('.saved-query-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const saved = JSON.parse(localStorage.getItem('savedQueries') || '[]');
      saved.splice(parseInt(btn.dataset.idx, 10), 1);
      localStorage.setItem('savedQueries', JSON.stringify(saved));
      renderSavedQueries();
    });
  });
}

function decodeFilterParams(paramStr) {
  const p = new URLSearchParams(paramStr);
  const parts = [];
  if (p.get('tribe')) parts.push(`Tribe: ${p.get('tribe')}`);
  if (p.get('countries')) parts.push(`Countries: ${p.get('countries').replace(/\|/g, ', ')}`);
  if (p.get('provinces')) parts.push(`Provinces: ${p.get('provinces').replace(/\|/g, ', ')}`);
  if (p.get('sort') && p.get('sort') !== 'az') parts.push(`Sort: ${p.get('sort')}`);
  return parts.join(' / ') || 'All species';
}

// Save query button (inline naming)
const saveQueryBtn = document.getElementById('saveQueryBtn');
const saveQueryInline = document.getElementById('save-query-inline');
const saveQueryName = document.getElementById('saveQueryName');
const saveQueryConfirm = document.getElementById('saveQueryConfirm');
const saveQueryCancel = document.getElementById('saveQueryCancel');

if (saveQueryBtn && saveQueryInline) {
  saveQueryBtn.addEventListener('click', () => {
    const params = new URLSearchParams(window.location.search);
    params.delete('page');
    if (!params.toString()) return;

    const parts = [];
    if (tribeSelect?.value) parts.push(tribeSelect.value);
    if (selectedCountries.size > 0) parts.push([...selectedCountries].join(', '));
    if (selectedProvinces.size > 0) parts.push([...selectedProvinces].join(', '));
    saveQueryName.value = parts.length > 0 ? parts.join(' / ') : 'My Query';

    saveQueryBtn.style.display = 'none';
    saveQueryInline.style.display = 'flex';
    saveQueryName.focus();
    saveQueryName.select();
  });

  saveQueryConfirm.addEventListener('click', () => {
    const name = saveQueryName.value.trim();
    if (!name) return;
    const params = new URLSearchParams(window.location.search);
    params.delete('page');
    const saved = JSON.parse(localStorage.getItem('savedQueries') || '[]');
    saved.unshift({ name, params: params.toString() });
    localStorage.setItem('savedQueries', JSON.stringify(saved.slice(0, 10)));
    renderSavedQueries();
    saveQueryInline.style.display = 'none';
    saveQueryBtn.style.display = '';
  });

  saveQueryCancel.addEventListener('click', () => {
    saveQueryInline.style.display = 'none';
    saveQueryBtn.style.display = '';
  });

  saveQueryName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveQueryConfirm.click();
    if (e.key === 'Escape') saveQueryCancel.click();
  });
}

// ============================================================
// CARD CLICK: save scroll + recently viewed
// ============================================================

document.addEventListener('click', (e) => {
  const card = e.target.closest('.species-card');
  if (card) {
    sessionStorage.setItem('searchScroll', String(window.scrollY));
    sessionStorage.setItem('searchUrl', window.location.search);
    const href = card.getAttribute('href');
    const id = new URLSearchParams(href.split('?')[1]).get('id');
    const name = card.querySelector('h3')?.textContent?.trim() || '';
    if (id && name) {
      const recent = JSON.parse(localStorage.getItem('recentSpecies') || '[]');
      const filtered = recent.filter((r) => r.id !== id);
      filtered.unshift({ id, name });
      localStorage.setItem('recentSpecies', JSON.stringify(filtered.slice(0, 10)));
    }
  }
});

// ============================================================
// SEARCH INPUT: show results on focus
// ============================================================

if (sciNameInput) {
  sciNameInput.addEventListener('input', (e) => renderSuggestions(e.target.value));
  sciNameInput.addEventListener('focus', () => renderSuggestions(sciNameInput.value));
  sciNameInput.addEventListener('blur', () => {
    setTimeout(() => { sciNameSuggestions.innerHTML = ''; }, 100);
  });
}

// Back to top button
const backToTop = document.getElementById('backToTop');
if (backToTop) {
  const mainView = document.querySelector('.main-view');
  if (mainView) {
    mainView.addEventListener('scroll', () => {
      backToTop.classList.toggle('visible', mainView.scrollTop > 400);
    });
  }
  backToTop.addEventListener('click', () => {
    const mainView = document.querySelector('.main-view');
    if (mainView) mainView.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ============================================================
// INIT
// ============================================================

// Call renderActiveFilters after every search
const origRenderPage = renderPage;
renderPage = function() {
  origRenderPage();
  renderActiveFilters();
};

renderRecentlyViewed();
renderSavedQueries();