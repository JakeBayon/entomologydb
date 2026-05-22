import { getSpecimen } from '../shared/bruchindb-api.js';
import { CONFIG } from '../shared/config.js';

const params = new URLSearchParams(window.location.search);
const specimenId = params.get('id');

const titleEl = document.getElementById('specimen-title');
const subtitleEl = document.getElementById('specimen-subtitle');
const specimenInfoEl = document.getElementById('specimen-info');
const eventInfoEl = document.getElementById('event-info');
const hostInfoEl = document.getElementById('host-info');
const hostSection = document.getElementById('specimen-host-section');
const citationTextEl = document.getElementById('citation-text');
const citationSection = document.getElementById('specimen-citation-section');
const notesTextEl = document.getElementById('notes-text');
const notesSection = document.getElementById('specimen-notes-section');
const imagesEl = document.getElementById('specimen-images');
const imagesSection = document.getElementById('specimen-images-section');

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function infoItem(label, value) {
  if (!value || !String(value).trim()) return '';
  return `
    <div class="info-item">
      <div class="info-label">${escapeHtml(label)}</div>
      <div class="info-value">${escapeHtml(value)}</div>
    </div>
  `;
}

async function loadSpecimen() {
  if (!specimenId) {
    titleEl.textContent = 'No specimen selected';
    subtitleEl.textContent = 'Go back and click a specimen.';
    return;
  }

  const cached = sessionStorage.getItem('specimen:' + specimenId);
  if (cached) {
    try {
      renderSpecimen(JSON.parse(cached));
      return;
    } catch {}
  }

  titleEl.textContent = 'Loading...';
  try {
    const sp = await getSpecimen(specimenId);
    if (!sp) {
      titleEl.textContent = 'Specimen not found';
      subtitleEl.textContent = '';
      return;
    }
    sessionStorage.setItem('specimen:' + specimenId, JSON.stringify(sp));
    renderSpecimen(sp);
  } catch (err) {
    console.error(err);
    titleEl.textContent = 'Error loading specimen';
    subtitleEl.textContent = err.message;
  }
}

async function renderSpecimen(sp) {
  titleEl.textContent = sp.Specimen_ID || 'Specimen';
  const breadcrumbSpeciesLink = document.getElementById('breadcrumb-species-link');
  const breadcrumbSpecimen = document.getElementById('breadcrumb-specimen');
  if (breadcrumbSpeciesLink && sp.Species_ID) {
    const lastTab = sessionStorage.getItem('lastSpeciesTab:' + sp.Species_ID) || 'taxon';
    breadcrumbSpeciesLink.href = `./species.html?id=${encodeURIComponent(sp.Species_ID)}&tab=${lastTab}`;
    breadcrumbSpeciesLink.textContent = sp.species_full_name
      ? sp.species_full_name.split(/\s+/).slice(0, 2).join(' ')
      : 'Species';
  }
  if (breadcrumbSpecimen) {
    breadcrumbSpecimen.textContent = sp.Specimen_ID || 'Specimen';
  }
  const breadcrumbNav = document.querySelector('.breadcrumbs');
  if (breadcrumbNav) breadcrumbNav.style.visibility = 'visible';
  subtitleEl.innerHTML = sp.species_full_name
    ? `<a href="./species.html?id=${encodeURIComponent(sp.Species_ID)}&tab=${sessionStorage.getItem('lastSpeciesTab:' + sp.Species_ID) || 'taxon'}"><em>${escapeHtml(sp.species_full_name)}</em></a>`
    : '';
  
  // Get tribe from genus
  let tribe = '';
  try {
    const { getGenusTribeMap } = await import('../shared/bruchindb-api.js');
    const genusTribeMap = await getGenusTribeMap();
    const genus = (sp.species_full_name || '').split(' ')[0];
    tribe = genusTribeMap[genus] || '';
  } catch {}

  specimenInfoEl.innerHTML = [
    infoItem('Specimen ID', sp.Specimen_ID),
    infoItem('Sex', sp.sex),
    infoItem('Stage', sp.stage),
    infoItem('Collection Method', sp.collecting_method),
    infoItem('Determined By', sp.determined_by),
    infoItem('Type Status', sp.ss),
    infoItem('Tape', sp.Tape),
    infoItem('Medium', sp.medium),
    infoItem('Stored At', sp.stored),
  ].filter(Boolean).join('') || '<p class="empty">No specimen details recorded.</p>';

  eventInfoEl.innerHTML = [
    infoItem('Country', sp.event_country),
    infoItem('Province', sp.event_province),
    infoItem('County', sp.event_county),
    infoItem('Locality', sp.event_locality),
    infoItem('Coordinates', new URLSearchParams(window.location.search).get('coords') || sp.event_coordinates || ''),
    infoItem('Date', sp.event_date),
    infoItem('Collector', sp.event_collector),
    infoItem('Tribe', tribe),
  ].filter(Boolean).join('') || '<p class="empty">No collection event recorded.</p>';

  const hasHost = (sp.host_species_name && sp.host_species_name.trim()) ||
                  (sp.host_species_family && sp.host_species_family.trim());
  if (hasHost) {
    hostSection.style.display = '';
    hostInfoEl.innerHTML = [
      infoItem('Host Species', sp.host_species_name),
      infoItem('Host Family', sp.host_species_family),
    ].filter(Boolean).join('');
  }

  if (sp.citation && sp.citation.trim()) {
    citationSection.style.display = '';
    citationTextEl.textContent = sp.citation;
  }

  if (sp.notes && sp.notes.trim()) {
    notesSection.style.display = '';
    notesTextEl.textContent = sp.notes;
  }

  if (sp.images && sp.images.length > 0) {
    imagesSection.style.display = '';
    const proxyBase = CONFIG.fileMakerUrl + '/image/specimen/' + encodeURIComponent(sp.Specimen_ID);
    const specimenImages = sp.images.map((img, idx) => ({
      url: `${proxyBase}/${idx}`,
      category: img.category,
      caption: img.caption,
      source: img.source,
      copyright: img.copyright,
    }));

    imagesEl.innerHTML = specimenImages.map((img, idx) => `
      <figure class="image-tile" data-img-index="${idx}">
        <img src="${img.url}" alt="${escapeHtml(img.category)}" loading="lazy" onerror="this.src='./seed_beetle_logo_transparent.png'" />
        <figcaption>
          ${escapeHtml(img.category)}
          ${img.copyright ? `<div class="image-credit">${escapeHtml(img.copyright)}</div>` : ''}
          ${img.source ? `<div class="image-source">${escapeHtml(img.source)}</div>` : ''}
        </figcaption>
      </figure>
    `).join('');

    // Lightbox
    let lbIndex = 0;

    function openLb(index) {
      lbIndex = index;
      renderLb();
    }

    function closeLb() {
      const overlay = document.querySelector('.lightbox-overlay');
      if (overlay) overlay.remove();
    }

    function renderLb() {
      closeLb();
      const img = specimenImages[lbIndex];
      if (!img) return;

      const overlay = document.createElement('div');
      overlay.className = 'lightbox-overlay';
      overlay.innerHTML = `
        <div class="lightbox-content">
          <div class="lightbox-counter">${lbIndex + 1} / ${specimenImages.length}</div>
          <button class="lightbox-close" aria-label="Close">x</button>
          ${specimenImages.length > 1 ? `
            <button class="lightbox-nav lightbox-prev" aria-label="Previous"><</button>
            <button class="lightbox-nav lightbox-next" aria-label="Next">></button>
          ` : ''}
          <div class="lightbox-img-wrap">
            <img class="lightbox-img" src="${img.url}" alt="${escapeHtml(img.category)}" draggable="false" />
          </div>
          <div class="lightbox-caption">
            <div class="lightbox-caption-title">${escapeHtml(img.category)}</div>
            <div class="lightbox-caption-meta">
              ${img.caption ? escapeHtml(img.caption) : ''}
              ${img.copyright ? ` - ${escapeHtml(img.copyright)}` : ''}
            </div>
          </div>
        </div>
      `;

      overlay.addEventListener('click', closeLb);
      overlay.querySelector('.lightbox-caption').addEventListener('click', (e) => e.stopPropagation());
      overlay.querySelector('.lightbox-close').addEventListener('click', (e) => { e.stopPropagation(); closeLb(); });

      const prevBtn = overlay.querySelector('.lightbox-prev');
      const nextBtn = overlay.querySelector('.lightbox-next');
      if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); lbIndex = (lbIndex - 1 + specimenImages.length) % specimenImages.length; renderLb(); });
      if (nextBtn) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); lbIndex = (lbIndex + 1) % specimenImages.length; renderLb(); });

      // Pan and zoom
      const imgWrap = overlay.querySelector('.lightbox-img-wrap');
      const lightboxImg = overlay.querySelector('.lightbox-img');
      let scale = 1, panX = 0, panY = 0, isDragging = false, dragStartX = 0, dragStartY = 0;

      function applyTransform() {
        lightboxImg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
        lightboxImg.style.cursor = scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in';
      }

      imgWrap.addEventListener('click', (e) => e.stopPropagation());
      imgWrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = -e.deltaY * 0.002;
        scale = Math.max(1, Math.min(5, scale + delta * scale));
        if (scale === 1) { panX = 0; panY = 0; }
        applyTransform();
      }, { passive: false });

      lightboxImg.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (scale === 1) { scale = 2.5; } else { scale = 1; panX = 0; panY = 0; }
        applyTransform();
      });

      lightboxImg.addEventListener('mousedown', (e) => {
        if (scale <= 1) return;
        e.preventDefault(); e.stopPropagation();
        isDragging = true; dragStartX = e.clientX - panX; dragStartY = e.clientY - panY;
        applyTransform();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panX = e.clientX - dragStartX; panY = e.clientY - dragStartY;
        applyTransform();
      });

      document.addEventListener('mouseup', () => { if (isDragging) { isDragging = false; applyTransform(); } });

      applyTransform();
      document.body.appendChild(overlay);
    }

    // Wire up image clicks
    imagesEl.querySelectorAll('.image-tile').forEach((tile) => {
      tile.addEventListener('click', () => openLb(parseInt(tile.dataset.imgIndex, 10)));
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (!document.querySelector('.lightbox-overlay')) return;
      if (e.key === 'Escape') closeLb();
      else if (e.key === 'ArrowLeft' && specimenImages.length > 1) { lbIndex = (lbIndex - 1 + specimenImages.length) % specimenImages.length; renderLb(); }
      else if (e.key === 'ArrowRight' && specimenImages.length > 1) { lbIndex = (lbIndex + 1) % specimenImages.length; renderLb(); }
    });
  }
}
loadSpecimen();