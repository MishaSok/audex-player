// ── Audex renderer ──

// Storage keys (kept "ambevor-*" for the library so existing users don't lose state;
// new keys use the audex- prefix).
const LS = {
  libraryMeta: 'ambevor-library-meta',
  favorites: 'ambevor-favorites',
  playlists: 'audex-playlists',
  settings: 'audex-settings',
  recents: 'audex-recents',
};

// State
let libraryMeta = JSON.parse(localStorage.getItem(LS.libraryMeta) || '[]');
let favorites = JSON.parse(localStorage.getItem(LS.favorites) || '[]');
let playlists = JSON.parse(localStorage.getItem(LS.playlists) || '[]');
let settings = Object.assign({
  theme: 'dark',          // 'dark' | 'light' | 'system'
  language: 'ru',
  defaultFolder: '',
  scanSubdirs: true,
  autoRescan: false,
  downloads: false,
}, JSON.parse(localStorage.getItem(LS.settings) || '{}'));
// Downloads section is in development — force off regardless of stored value.
settings.downloads = false;
let recents = JSON.parse(localStorage.getItem(LS.recents) || '[]');

const coverCache = {};
let library = libraryMeta.map(t => ({ ...t, cover: coverCache[t.path] || null }));

let currentTrackIndex = -1;
let currentQueue = library;          // the list we're playing through
let currentView = 'library';
let activeFilter = 'all';
let activeSort = 'date-desc';
let isPlaying = false;
let isShuffle = false;
let repeatMode = 0;                  // 0 off · 1 all · 2 one

let pendingDelete = null;            // { kind: 'track'|'playlist', payload }
let pendingContextTrackPath = null;
let pendingMetadataPath = null;
let pendingAddPath = null;
let activePlaylistId = null;
let activeArtistName = null;
let artistsSort = 'alpha';           // 'alpha' | 'tracks' | 'recent'
let artistsList = [];                // current filtered+sorted list of artist objects
let artistsCursor = 0;               // how many of artistsList have been mounted in the grid
let artistsObserver = null;          // IntersectionObserver on the sentinel

// ── DOM ──
const $ = id => document.getElementById(id);
const audio = $('audio-player');
const root = document.documentElement;

// ── Theme ──
function applyTheme(t) {
  const resolved = t === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : t;
  root.setAttribute('data-theme', resolved);
}
applyTheme(settings.theme);
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme('system');
});

// ── Persistence ──
function saveLibrary() {
  libraryMeta = library.map(({ cover, ...rest }) => rest);
  try {
    localStorage.setItem(LS.libraryMeta, JSON.stringify(libraryMeta));
    localStorage.setItem(LS.favorites, JSON.stringify(favorites));
  } catch (e) {
    console.warn('localStorage full:', e);
  }
}
function savePlaylists() {
  localStorage.setItem(LS.playlists, JSON.stringify(playlists));
}
function saveSettings() {
  localStorage.setItem(LS.settings, JSON.stringify(settings));
}
function saveRecents() {
  localStorage.setItem(LS.recents, JSON.stringify(recents.slice(0, 4)));
}

// ── Utils ──
function formatTime(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
function formatTotalDuration(tracks) {
  const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function uid() { return Math.random().toString(36).slice(2, 10); }

// ── Virtual list ──
// Only renders rows visible in the scroll viewport (+ overscan buffer).
// `listEl` is the row container; rows are absolutely positioned inside it.
// `scrollEl` is the actual scroll container (here: .main-content).
const ROW_HEIGHT = 42;
const OVERSCAN = 8;

function createVirtualList({ listEl, scrollEl, rowHeight = ROW_HEIGHT, overscan = OVERSCAN }) {
  let items = [];
  let renderRow = () => document.createElement('div');
  const nodes = new Map(); // index -> element
  let rafPending = false;

  function placeNode(node, index) {
    node.style.position = 'absolute';
    node.style.top = `${index * rowHeight}px`;
    node.style.left = '0';
    node.style.right = '0';
  }

  function update() {
    rafPending = false;
    const total = items.length;
    listEl.style.position = 'relative';
    listEl.style.paddingTop = '0';
    listEl.style.height = `${total * rowHeight}px`;
    if (total === 0) {
      for (const [, node] of nodes) node.remove();
      nodes.clear();
      return;
    }
    const scrollTop = scrollEl.scrollTop;
    const viewportH = scrollEl.clientHeight;
    // listEl position relative to the scroll container (account for header/topbar above it)
    const listOffset = listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollTop;
    const visibleStart = (scrollTop - listOffset) / rowHeight;
    const visibleEnd = (scrollTop - listOffset + viewportH) / rowHeight;
    const start = Math.max(0, Math.floor(visibleStart) - overscan);
    const end = Math.min(total, Math.ceil(visibleEnd) + overscan);

    for (const [i, node] of nodes) {
      if (i < start || i >= end) {
        node.remove();
        nodes.delete(i);
      }
    }
    for (let i = start; i < end; i++) {
      if (!nodes.has(i)) {
        const node = renderRow(items[i], i, items);
        placeNode(node, i);
        listEl.appendChild(node);
        nodes.set(i, node);
      }
    }
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(update);
  }

  const onScroll = () => schedule();
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', schedule);

  return {
    setItems(newItems, renderRowFn) {
      items = newItems;
      if (renderRowFn) renderRow = renderRowFn;
      for (const [, node] of nodes) node.remove();
      nodes.clear();
      update();
    },
    // Re-render all currently mounted rows in place (used when only row visuals change, e.g. playing/favorite).
    refreshVisible() {
      for (const [i, oldNode] of nodes) {
        const node = renderRow(items[i], i, items);
        placeNode(node, i);
        oldNode.replaceWith(node);
        nodes.set(i, node);
      }
    },
    // Re-render a single row if it's currently visible (used when one row's data changes, e.g. cover loaded).
    updateRow(index) {
      const old = nodes.get(index);
      if (!old) return;
      const node = renderRow(items[index], index, items);
      placeNode(node, index);
      old.replaceWith(node);
      nodes.set(index, node);
    },
    // Locate index of a row by predicate, for partial updates.
    findIndex(pred) { return items.findIndex(pred); },
    getItems() { return items; },
  };
}

const scrollEl = document.querySelector('.main-content');
let libraryVList = null;
let favoritesVList = null;
let playlistVList = null;

// ── Lazy cover loading ──
// Covers can be heavy (base64 data URLs). Only fetch them for tracks that actually become visible.
const pendingCoverLoad = new Set();
let coverRefreshPending = false;
function scheduleCoverRefresh() {
  if (coverRefreshPending) return;
  coverRefreshPending = true;
  requestAnimationFrame(() => {
    coverRefreshPending = false;
    refreshPlayingHighlight();
    renderRecents();
    if (currentView === 'artists') refreshArtistsCoversInPlace();
    else if (currentView === 'artist-detail') renderArtistDetail(activeArtistName);
    if ($('fullscreen-overlay').classList.contains('active')) updateFullscreenQueue();
    if ($('palette-overlay').classList.contains('active')) renderPaletteResults($('palette-input').value);
  });
}
async function ensureCoverFor(track) {
  if (!track || track.cover || pendingCoverLoad.has(track.path)) return;
  pendingCoverLoad.add(track.path);
  try {
    const md = await window.electronAPI.parseMetadata(track.path);
    if (md && md.cover) {
      track.cover = md.cover;
      coverCache[track.path] = md.cover;
      scheduleCoverRefresh();
      if (currentTrackIndex >= 0 && library[currentTrackIndex] && library[currentTrackIndex].path === track.path) {
        updateNowPlayingUI(library[currentTrackIndex]);
      }
    }
  } catch (e) { /* file moved / unreadable */ }
}

// ── Library track helpers ──
function trackByPath(path) { return library.find(t => t.path === path); }
function trackIndexByPath(path) { return library.findIndex(t => t.path === path); }

function sortedFilteredLibrary() {
  let arr = library.slice();
  if (activeFilter === 'recent') {
    arr = arr.slice(-50).reverse();
  } else if (activeFilter === 'favorites') {
    arr = arr.filter(t => favorites.includes(t.path));
  }
  // Sort
  if (activeSort === 'title-asc') arr.sort((a, b) => a.title.localeCompare(b.title));
  else if (activeSort === 'artist-asc') arr.sort((a, b) => a.artist.localeCompare(b.artist));
  // date-desc is default insertion order reversed
  else if (activeSort === 'date-desc' && activeFilter === 'all') arr = arr.slice().reverse();
  return arr;
}

// ── Render: navigation ──
function setView(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === view);
  });
  document.querySelectorAll('.view-section').forEach(s => {
    s.classList.toggle('active', s.id === `view-${view}`);
  });
  if (view === 'library') renderLibrary();
  else if (view === 'favorites') renderFavorites();
  else if (view === 'playlists') renderPlaylists();
  else if (view === 'playlist-detail') renderPlaylistDetail(activePlaylistId);
  else if (view === 'artists') renderArtists();
  else if (view === 'artist-detail') renderArtistDetail(activeArtistName);
  else if (view === 'settings') renderSettings();
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    if (item.dataset.action === 'open-palette') return openPalette();
    if (item.dataset.view) setView(item.dataset.view);
  });
});
document.querySelectorAll('.crumb-item.link').forEach(el => {
  el.addEventListener('click', () => setView(el.dataset.view));
});

// ── Render: sidebar counts + recents ──
function renderCounts() {
  $('count-library').textContent = library.length;
  $('count-playlists').textContent = playlists.length;
  $('count-favorites').textContent = favorites.length;
  const artistsCountEl = $('count-artists');
  if (artistsCountEl) artistsCountEl.textContent = buildArtistsIndex().length;
}
function renderRecents() {
  const list = $('recents-list');
  list.innerHTML = '';
  recents.slice(0, 4).forEach(path => {
    const t = trackByPath(path);
    if (!t) return;
    if (!t.cover) ensureCoverFor(t);
    const el = document.createElement('div');
    el.className = 'recent-item';
    const cover = t.cover ? `background-image:url('${t.cover}')` : '';
    el.innerHTML = `
      <div class="recent-swatch" style="${cover}"></div>
      <div class="recent-body">
        <div class="recent-name">${escapeHtml(t.title)}</div>
        <div class="recent-meta">${escapeHtml(t.artist)}</div>
      </div>
    `;
    el.addEventListener('click', () => playTrackByPath(path, library));
    list.appendChild(el);
  });
}

// ── Render: track row ──
function renderTrackRow(track, displayIndex, queue) {
  if (!track.cover) ensureCoverFor(track);
  const realIndex = trackIndexByPath(track.path);
  const isPlayingRow = currentTrackIndex >= 0
    && library[currentTrackIndex]
    && library[currentTrackIndex].path === track.path;
  const tr = document.createElement('div');
  tr.className = 'trow' + (isPlayingRow ? ' playing' : '');
  tr.dataset.path = track.path;
  const numCell = isPlayingRow
    ? `<span class="equalizer"><span></span><span></span><span></span></span>`
    : String(displayIndex + 1).padStart(2, '0');
  const coverStyle = track.cover ? `background-image:url('${track.cover}')` : '';
  tr.innerHTML = `
    <div class="trow-num">${numCell}</div>
    <div class="trow-title-cell">
      <div class="trow-cover" style="${coverStyle}"></div>
      <span class="trow-title">${escapeHtml(track.title)}</span>
    </div>
    <div class="trow-muted">${escapeHtml(track.artist)}</div>
    <div class="trow-muted">${escapeHtml(track.album)}</div>
    <div class="trow-dur">${formatTime(track.duration)}</div>
    <div class="trow-more"><svg class="i" width="13" height="13"><use href="#i-more"/></svg></div>
  `;
  tr.addEventListener('click', e => {
    if (e.target.closest('.trow-more')) {
      e.stopPropagation();
      openContextMenu(e, track.path);
      return;
    }
    playTrackByPath(track.path, queue);
  });
  tr.addEventListener('contextmenu', e => {
    e.preventDefault();
    openContextMenu(e, track.path);
  });
  return tr;
}

// ── Render: library ──
function currentLibraryTracks() {
  const q = ($('library-search').value || '').trim().toLowerCase();
  if (q) {
    return library.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q));
  }
  return sortedFilteredLibrary();
}

function renderLibrary() {
  const list = $('library-list');
  const empty = $('library-empty');
  const tracks = currentLibraryTracks();
  $('library-count-label').textContent = `${library.length} ${pluralTracks(library.length)}`;
  if (library.length === 0) {
    list.innerHTML = '';
    list.style.height = '';
    empty.classList.add('show');
  } else {
    empty.classList.remove('show');
    if (!libraryVList) {
      libraryVList = createVirtualList({ listEl: list, scrollEl });
    }
    libraryVList.setItems(tracks, (t, i, queue) => renderTrackRow(t, i, queue));
  }
  renderCounts();
}

function pluralTracks(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'трек';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'трека';
  return 'треков';
}

// ── Render: favorites ──
function renderFavorites() {
  const list = $('favorites-list');
  const empty = $('favorites-empty');
  const tracks = library.filter(t => favorites.includes(t.path));
  $('favorites-count-label').textContent = `${tracks.length} ${pluralTracks(tracks.length)}`;
  if (tracks.length === 0) {
    list.innerHTML = '';
    list.style.height = '';
    empty.classList.add('show');
  } else {
    empty.classList.remove('show');
    if (!favoritesVList) {
      favoritesVList = createVirtualList({ listEl: list, scrollEl });
    }
    favoritesVList.setItems(tracks, (t, i, queue) => renderTrackRow(t, i, queue));
  }
  renderCounts();
}

// ── Playlists ──
const PL_COVERS = [
  'linear-gradient(135deg, #d4377a 0%, #2a1a3d 100%)',
  'linear-gradient(135deg, #c4a872 0%, #3d2f15 100%)',
  'linear-gradient(135deg, #3a5a3a 0%, #0f1f0f 100%)',
  'linear-gradient(135deg, #4a7fc1 0%, #1a2a4d 100%)',
  'linear-gradient(135deg, #7a3a3a 0%, #2a0f0f 100%)',
  'linear-gradient(135deg, #6a4a8a 0%, #1f1535 100%)',
];

function renderPlaylists() {
  const grid = $('playlists-grid');
  const empty = $('playlists-empty');
  grid.innerHTML = '';
  $('playlists-count-label').textContent = playlists.length === 0
    ? '0 плейлистов'
    : `${playlists.length} ${playlists.length === 1 ? 'плейлист' : (playlists.length < 5 ? 'плейлиста' : 'плейлистов')}`;
  if (playlists.length === 0) {
    grid.style.display = 'none';
    empty.classList.add('show');
  } else {
    grid.style.display = 'grid';
    empty.classList.remove('show');
    playlists.forEach((pl, i) => {
      const card = document.createElement('div');
      card.className = 'playlist-card';
      const tracks = pl.trackPaths.map(trackByPath).filter(Boolean);
      const cover = pl.color || PL_COVERS[i % PL_COVERS.length];
      card.innerHTML = `
        <div class="playlist-cover" style="background:${cover}">
          <span class="playlist-letter">${escapeHtml((pl.name || '?')[0])}</span>
        </div>
        <div class="playlist-name">${escapeHtml(pl.name)}</div>
        <div class="playlist-desc">${escapeHtml(pl.desc || '')}</div>
        <div class="playlist-stats">
          <span>${tracks.length} ${pluralTracks(tracks.length)}</span>
          <span>·</span>
          <span>${formatTotalDuration(tracks)}</span>
        </div>
      `;
      card.addEventListener('click', () => {
        activePlaylistId = pl.id;
        setView('playlist-detail');
      });
      grid.appendChild(card);
    });
  }
  renderCounts();
}

function renderPlaylistDetail(plId) {
  const pl = playlists.find(p => p.id === plId);
  if (!pl) { setView('playlists'); return; }
  $('pl-detail-crumb').textContent = pl.name;
  $('pl-detail-title').textContent = pl.name;
  $('pl-hero-letter').textContent = (pl.name || '?')[0];
  $('pl-hero-cover').style.background = pl.color || PL_COVERS[0];
  const tracks = pl.trackPaths.map(trackByPath).filter(Boolean);
  const meta = $('pl-detail-meta');
  meta.innerHTML = `
    <span>${tracks.length} ${pluralTracks(tracks.length)}</span>
    <span>·</span>
    <span>${formatTotalDuration(tracks)}</span>
  `;
  const list = $('pl-detail-list');
  if (tracks.length === 0) {
    list.innerHTML = '';
    list.style.height = '';
  } else {
    if (!playlistVList) {
      playlistVList = createVirtualList({ listEl: list, scrollEl });
    }
    playlistVList.setItems(tracks, (t, i, queue) => renderTrackRow(t, i, queue));
  }

  $('btn-pl-play').onclick = () => {
    if (tracks.length > 0) playTrackByPath(tracks[0].path, tracks);
  };
  $('btn-pl-shuffle').onclick = () => {
    if (tracks.length > 0) {
      isShuffle = true;
      updateShuffleUI();
      const random = tracks[Math.floor(Math.random() * tracks.length)];
      playTrackByPath(random.path, tracks);
    }
  };
  $('btn-pl-delete').onclick = () => confirmDelete({ kind: 'playlist', payload: pl.id, title: 'Удалить плейлист?', text: `Плейлист «${pl.name}» будет удалён. Треки в библиотеке останутся.` });
}

// ── Artists ──
// A track's `artist` field may list multiple performers joined by " & ".
// Each side counts as a separate artist; the same track shows up on every
// artist's page. Pure " & " is the only separator (per product spec).
const ARTIST_SEP = /\s*&\s*/;

function splitArtists(s) {
  if (!s) return ['Неизвестный исполнитель'];
  const parts = s.split(ARTIST_SEP).map(p => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : ['Неизвестный исполнитель'];
}

function artistInitials(name) {
  const stop = new Set(['the', 'of', 'a', 'an', 'and', 'и']);
  const parts = name.split(/\s+/).filter(p => !stop.has(p.toLowerCase()));
  if (parts.length === 0) return (name[0] || '?').toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function pluralAlbums(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'альбом';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'альбома';
  return 'альбомов';
}
function pluralArtists(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'исполнитель';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'исполнителя';
  return 'исполнителей';
}

function buildArtistsIndex() {
  const map = new Map();
  library.forEach((t, idx) => {
    const names = splitArtists(t.artist);
    for (const name of names) {
      let a = map.get(name);
      if (!a) {
        a = { name, tracks: [], lastIdx: idx };
        map.set(name, a);
      }
      a.tracks.push(t);
      if (idx > a.lastIdx) a.lastIdx = idx;
    }
  });
  const out = [];
  for (const a of map.values()) {
    const albums = new Set(a.tracks.map(t => t.album));
    const cover = (a.tracks.find(t => t.cover) || {}).cover || null;
    out.push({
      name: a.name,
      tracks: a.tracks,
      trackCount: a.tracks.length,
      albumCount: albums.size,
      lastIdx: a.lastIdx,
      cover,
    });
  }
  return out;
}

function sortArtists(arr) {
  const c = arr.slice();
  if (artistsSort === 'tracks') c.sort((a, b) => b.trackCount - a.trackCount || a.name.localeCompare(b.name, 'ru'));
  else if (artistsSort === 'recent') c.sort((a, b) => b.lastIdx - a.lastIdx);
  else c.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return c;
}

// Page size = enough rows to fill a typical viewport so the first paint is
// always visually complete. Subsequent rows stream in as the user scrolls.
const ARTISTS_PAGE_SIZE = 36;

function buildArtistCard(a) {
  // Trigger cover load lazily for cards as they mount — first track without
  // a cover is enough; ensureCoverFor is idempotent.
  if (!a.cover) {
    const t = a.tracks.find(t => !t.cover);
    if (t) ensureCoverFor(t);
  }
  const card = document.createElement('div');
  card.className = 'artist-card';
  card.dataset.artist = a.name;
  const cover = a.cover ? `background-image:url('${a.cover}')` : '';
  card.innerHTML = `
    <div class="artist-avatar" style="${cover}">
      ${a.cover ? '' : `<span class="artist-avatar-letter">${escapeHtml(artistInitials(a.name))}</span>`}
    </div>
    <div class="artist-card-name">${escapeHtml(a.name)}</div>
    <div class="artist-card-stats">
      <span>${a.trackCount} тр.</span>
      <span>·</span>
      <span>${a.albumCount} ${pluralAlbums(a.albumCount)}</span>
    </div>
  `;
  card.addEventListener('click', () => {
    activeArtistName = a.name;
    setView('artist-detail');
  });
  return card;
}

function appendArtistsBatch() {
  const grid = $('artists-grid');
  // Remove any previous sentinel so it doesn't end up mid-grid.
  const oldSentinel = grid.querySelector('.artists-sentinel');
  if (oldSentinel) oldSentinel.remove();

  const end = Math.min(artistsCursor + ARTISTS_PAGE_SIZE, artistsList.length);
  const frag = document.createDocumentFragment();
  for (let i = artistsCursor; i < end; i++) {
    frag.appendChild(buildArtistCard(artistsList[i]));
  }
  grid.appendChild(frag);
  artistsCursor = end;

  if (artistsCursor < artistsList.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'artists-sentinel';
    grid.appendChild(sentinel);
    if (!artistsObserver) {
      artistsObserver = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) appendArtistsBatch();
      }, { root: scrollEl, rootMargin: '400px 0px' });
    }
    artistsObserver.observe(sentinel);
  } else if (artistsObserver) {
    artistsObserver.disconnect();
    artistsObserver = null;
  }
}

function renderArtists() {
  const all = buildArtistsIndex();
  const q = ($('artists-search').value || '').trim().toLowerCase();
  const filtered = q ? all.filter(a => a.name.toLowerCase().includes(q)) : all;
  const sorted = sortArtists(filtered);

  $('artists-count-label').textContent = `${all.length} ${pluralArtists(all.length)}`;
  const grid = $('artists-grid');
  const empty = $('artists-empty');

  // Reset previous batch state — any new render starts fresh.
  if (artistsObserver) { artistsObserver.disconnect(); artistsObserver = null; }
  grid.innerHTML = '';
  artistsCursor = 0;

  if (all.length === 0) {
    grid.style.display = 'none';
    empty.classList.add('show');
    artistsList = [];
    renderCounts();
    return;
  }
  empty.classList.remove('show');
  grid.style.display = 'grid';

  artistsList = sorted;
  appendArtistsBatch();
  renderCounts();
}

// Cover loads should update existing cards in place — re-rendering would reset
// the scroll position and the lazy-load cursor.
function refreshArtistsCoversInPlace() {
  const grid = $('artists-grid');
  if (!grid) return;
  const cards = grid.querySelectorAll('.artist-card');
  if (cards.length === 0) return;
  // Recompute covers from current library state.
  const byName = new Map();
  for (let i = 0; i < library.length; i++) {
    const t = library[i];
    if (!t.cover) continue;
    for (const name of splitArtists(t.artist)) {
      if (!byName.has(name)) byName.set(name, t.cover);
    }
  }
  cards.forEach(card => {
    const avatar = card.querySelector('.artist-avatar');
    if (!avatar || avatar.style.backgroundImage) return;
    const cover = byName.get(card.dataset.artist);
    if (!cover) return;
    avatar.style.backgroundImage = `url('${cover}')`;
    const letter = avatar.querySelector('.artist-avatar-letter');
    if (letter) letter.remove();
  });
}

function renderArtistDetail(name) {
  const all = buildArtistsIndex();
  const artist = all.find(a => a.name === name);
  if (!artist) { setView('artists'); return; }

  $('artist-detail-crumb').textContent = artist.name;
  $('artist-detail-title').textContent = artist.name;
  const avatar = $('artist-hero-avatar');
  if (artist.cover) {
    avatar.style.backgroundImage = `url('${artist.cover}')`;
    $('artist-hero-letter').textContent = '';
  } else {
    avatar.style.backgroundImage = '';
    $('artist-hero-letter').textContent = artistInitials(artist.name);
    // Try to populate a cover from any track for next render.
    const t = artist.tracks.find(t => !t.cover);
    if (t) ensureCoverFor(t);
  }
  $('artist-detail-meta').innerHTML = `
    <span>${artist.trackCount} ${pluralTracks(artist.trackCount)}</span>
    <span>·</span>
    <span>${artist.albumCount} ${pluralAlbums(artist.albumCount)}</span>
    <span>·</span>
    <span>${formatTotalDuration(artist.tracks)}</span>
  `;

  // Filter by search input
  const q = ($('artist-detail-search').value || '').trim().toLowerCase();
  const tracks = q
    ? artist.tracks.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.album || '').toLowerCase().includes(q))
    : artist.tracks;

  // Group by album, preserving insertion order.
  const byAlbum = [];
  const seen = new Map();
  tracks.forEach(t => {
    const key = t.album || '';
    if (!seen.has(key)) {
      seen.set(key, byAlbum.length);
      byAlbum.push({ album: t.album || 'Без альбома', year: t.year, cover: t.cover, tracks: [] });
    }
    const slot = byAlbum[seen.get(key)];
    slot.tracks.push(t);
    if (!slot.cover && t.cover) slot.cover = t.cover;
  });

  const container = $('artist-albums');
  container.innerHTML = '';
  byAlbum.forEach((alb, gIdx) => {
    const block = document.createElement('div');
    block.className = 'artist-album';
    const coverStyle = alb.cover ? `background-image:url('${alb.cover}')` : '';
    const head = document.createElement('div');
    head.className = 'artist-album-head';
    head.innerHTML = `
      <div class="artist-album-cover" style="${coverStyle}"></div>
      <div class="artist-album-info">
        <div class="artist-album-name">${escapeHtml(alb.album)}</div>
        <div class="artist-album-meta">
          ${alb.year ? `<span>${escapeHtml(String(alb.year))}</span><span>·</span>` : ''}
          <span>${alb.tracks.length} ${pluralTracks(alb.tracks.length)}</span>
        </div>
      </div>
      <button class="artist-album-play" data-album-idx="${gIdx}">
        <svg class="i" width="10" height="10"><use href="#i-play"/></svg>
        Альбом
      </button>
    `;
    head.querySelector('.artist-album-play').addEventListener('click', e => {
      e.stopPropagation();
      if (alb.tracks.length > 0) playTrackByPath(alb.tracks[0].path, artist.tracks);
    });
    block.appendChild(head);

    const list = document.createElement('div');
    list.className = 'artist-album-tracks';
    alb.tracks.forEach((t, j) => {
      list.appendChild(renderTrackRow(t, j, artist.tracks));
    });
    block.appendChild(list);
    container.appendChild(block);
  });

  $('btn-artist-play').onclick = () => {
    if (artist.tracks.length > 0) playTrackByPath(artist.tracks[0].path, artist.tracks);
  };
  $('btn-artist-shuffle').onclick = () => {
    if (artist.tracks.length > 0) {
      isShuffle = true;
      updateShuffleUI();
      const random = artist.tracks[Math.floor(Math.random() * artist.tracks.length)];
      playTrackByPath(random.path, artist.tracks);
    }
  };
}

// ── Playback ──
function playTrackByPath(path, queue) {
  const realIndex = trackIndexByPath(path);
  if (realIndex < 0) return;
  currentTrackIndex = realIndex;
  currentQueue = queue && queue.length > 0 ? queue : library;
  const track = library[realIndex];
  if (!track.cover) ensureCoverFor(track);
  audio.src = 'file://' + track.path;
  audio.play().catch(e => console.warn('play error:', e));
  isPlaying = true;
  // recent
  recents = [path, ...recents.filter(p => p !== path)].slice(0, 4);
  saveRecents();
  renderRecents();
  updateNowPlayingUI(track);
  refreshPlayingHighlight();
}

function loadLastTrack() {
  const lastPath = recents[0];
  if (!lastPath) return;
  const realIndex = trackIndexByPath(lastPath);
  if (realIndex < 0) return;
  currentTrackIndex = realIndex;
  currentQueue = library;
  const track = library[realIndex];
  if (!track.cover) ensureCoverFor(track);
  audio.src = 'file://' + track.path;
  isPlaying = false;
  updateNowPlayingUI(track);
  refreshPlayingHighlight();
}

function refreshCurrentViewRows() {
  if (currentView === 'library') renderLibrary();
  else if (currentView === 'favorites') renderFavorites();
  else if (currentView === 'playlist-detail') renderPlaylistDetail(activePlaylistId);
  else if (currentView === 'artists') renderArtists();
  else if (currentView === 'artist-detail') renderArtistDetail(activeArtistName);
}

// Cheap path: only the .playing/equalizer indicator changes — repaint visible rows in place.
function refreshPlayingHighlight() {
  const v = currentView === 'library' ? libraryVList
    : currentView === 'favorites' ? favoritesVList
    : currentView === 'playlist-detail' ? playlistVList
    : null;
  if (v) { v.refreshVisible(); return; }
  // Artist detail renders rows directly (no virtual list) — patch them in place.
  if (currentView === 'artist-detail') refreshPlainListHighlight($('artist-albums'));
}

function refreshPlainListHighlight(container) {
  if (!container) return;
  const playingPath = currentTrackIndex >= 0 && library[currentTrackIndex]
    ? library[currentTrackIndex].path : null;
  container.querySelectorAll('.trow').forEach(row => {
    const isPlayingRow = row.dataset.path === playingPath;
    const wasPlaying = row.classList.contains('playing');
    if (isPlayingRow === wasPlaying) return;
    row.classList.toggle('playing', isPlayingRow);
    const numCell = row.querySelector('.trow-num');
    if (!numCell) return;
    if (isPlayingRow) {
      numCell.innerHTML = `<span class="equalizer"><span></span><span></span><span></span></span>`;
    } else {
      const parent = row.parentElement;
      const idx = parent ? Array.prototype.indexOf.call(parent.children, row) : 0;
      numCell.textContent = String(idx + 1).padStart(2, '0');
    }
  });
}

function updateNowPlayingUI(track) {
  const coverSrc = track.cover || null;
  // Mini cover
  const miniCover = $('mini-cover-wrapper');
  if (coverSrc) {
    miniCover.style.backgroundImage = `url('${coverSrc}')`;
    $('mini-cover-letter').textContent = '';
  } else {
    miniCover.style.backgroundImage = '';
    $('mini-cover-letter').textContent = (track.title || '?')[0];
  }
  $('track-title').textContent = track.title;
  $('track-artist').textContent = track.artist;

  // Fullscreen
  const fsCover = $('fs-cover');
  if (coverSrc) {
    fsCover.style.backgroundImage = `url('${coverSrc}')`;
    $('fs-cover-letter').textContent = '';
    $('fs-backdrop').style.background = `url('${coverSrc}') center/cover`;
  } else {
    fsCover.style.backgroundImage = '';
    $('fs-cover-letter').textContent = (track.title || '?')[0];
    $('fs-backdrop').style.background = 'transparent';
  }
  $('fs-title').textContent = track.title;
  $('fs-artist').textContent = track.artist;
  $('fs-album').textContent = track.album + (track.year ? ` · ${track.year}` : '');

  updateFavoriteUI();
  updatePlayButtonUI();
  updateFullscreenQueue();
  updateMediaSessionMetadata(track);
}

function updatePlayButtonUI() {
  const playBtn = $('btn-play').querySelector('use');
  const fsPlayBtn = $('fs-btn-play').querySelector('use');
  playBtn.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
  fsPlayBtn.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }
}

// MediaSession (maps to MPRIS on Linux — controls in the GNOME top bar)
function updateMediaSessionMetadata(track) {
  if (!('mediaSession' in navigator) || !track) return;
  const mime = track.cover ? (track.cover.match(/^data:([^;]+);/) || [])[1] : null;
  const artwork = track.cover
    ? [{ src: track.cover, sizes: '512x512', ...(mime ? { type: mime } : {}) }]
    : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || '',
    artist: track.artist || '',
    album: (track.album || '') + (track.year ? ` · ${track.year}` : ''),
    artwork,
  });
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => { if (!isPlaying) togglePlay(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (isPlaying) togglePlay(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
  navigator.mediaSession.setActionHandler('seekto', (e) => {
    if (e.seekTime != null && isFinite(audio.duration)) audio.currentTime = e.seekTime;
  });
}

function updateFavoriteUI() {
  if (currentTrackIndex < 0) return;
  const t = library[currentTrackIndex];
  const fav = favorites.includes(t.path);
  const heart = $('btn-favorite');
  heart.classList.toggle('active', fav);
  heart.querySelector('use').setAttribute('href', fav ? '#i-heart-filled' : '#i-heart');

  const fsFav = $('fs-btn-favorite');
  fsFav.classList.toggle('active', fav);
  fsFav.querySelector('use').setAttribute('href', fav ? '#i-heart-filled' : '#i-heart');
  $('fs-fav-label').textContent = fav ? 'В избранном' : 'В избранное';
}

function togglePlay() {
  if (currentTrackIndex < 0 && library.length > 0) {
    playTrackByPath(library[0].path, library);
    return;
  }
  if (audio.paused) { audio.play(); isPlaying = true; }
  else { audio.pause(); isPlaying = false; }
  updatePlayButtonUI();
}

function nextTrack() {
  if (currentQueue.length === 0) return;
  const curPath = currentTrackIndex >= 0 ? library[currentTrackIndex].path : null;
  const inQueueIdx = currentQueue.findIndex(t => t.path === curPath);
  if (isShuffle && currentQueue.length > 1) {
    let next;
    do { next = currentQueue[Math.floor(Math.random() * currentQueue.length)]; }
    while (next.path === curPath);
    playTrackByPath(next.path, currentQueue);
    return;
  }
  let nextIdx = inQueueIdx + 1;
  if (nextIdx >= currentQueue.length) {
    if (repeatMode === 0) return;
    nextIdx = 0;
  }
  playTrackByPath(currentQueue[nextIdx].path, currentQueue);
}

function prevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const curPath = currentTrackIndex >= 0 ? library[currentTrackIndex].path : null;
  const inQueueIdx = currentQueue.findIndex(t => t.path === curPath);
  let prevIdx = inQueueIdx - 1;
  if (prevIdx < 0) prevIdx = currentQueue.length - 1;
  if (currentQueue[prevIdx]) playTrackByPath(currentQueue[prevIdx].path, currentQueue);
}

function updateShuffleUI() {
  $('btn-shuffle').classList.toggle('active', isShuffle);
  $('fs-btn-shuffle').classList.toggle('active', isShuffle);
}

function updateRepeatUI() {
  const btn = $('btn-repeat');
  const fsBtn = $('fs-btn-repeat');
  btn.classList.toggle('active', repeatMode > 0);
  fsBtn.classList.toggle('active', repeatMode > 0);
  const icon = repeatMode === 2 ? '#i-repeat-one' : '#i-repeat';
  btn.querySelector('use').setAttribute('href', icon);
  fsBtn.querySelector('use').setAttribute('href', icon);
}

// ── Open files ──
$('btn-add-files').addEventListener('click', async () => {
  const paths = await window.electronAPI.openFiles();
  if (!paths || paths.length === 0) return;
  await importPaths(paths);
});

async function importPaths(paths) {
  let added = 0;
  for (const p of paths) {
    if (library.some(t => t.path === p)) continue;
    const metadata = await window.electronAPI.parseMetadata(p);
    if (metadata.cover) coverCache[p] = metadata.cover;
    library.push(metadata);
    added++;
  }
  if (added > 0) {
    saveLibrary();
    refreshCurrentViewRows();
    renderCounts();
  }
}

// ── Mini-player navigation ──
function gotoCurrentTrackInLibrary() {
  if (currentTrackIndex < 0) return;
  const track = library[currentTrackIndex];
  $('library-search').value = '';
  activeFilter = 'all';
  document.querySelectorAll('.filter-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === 'all');
  });
  setView('library');
  requestAnimationFrame(() => {
    if (!libraryVList) return;
    const idx = libraryVList.findIndex(t => t.path === track.path);
    if (idx < 0) return;
    const listEl = $('library-list');
    const listOffset = listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    scrollEl.scrollTop = Math.max(0, listOffset + idx * ROW_HEIGHT - scrollEl.clientHeight / 2 + ROW_HEIGHT / 2);
  });
}

function gotoCurrentTrackArtist() {
  if (currentTrackIndex < 0) return;
  const track = library[currentTrackIndex];
  const artists = splitArtists(track.artist);
  if (!artists.length) return;
  activeArtistName = artists[0];
  setView('artist-detail');
}

$('track-title').addEventListener('click', gotoCurrentTrackInLibrary);
$('track-artist').addEventListener('click', gotoCurrentTrackArtist);

// ── Favorites ──
function toggleFavorite(path) {
  if (favorites.includes(path)) favorites = favorites.filter(p => p !== path);
  else favorites.push(path);
  saveLibrary();
  updateFavoriteUI();
  // Row visuals don't show favorite state, so only the favorites view's list changes.
  if (currentView === 'favorites') renderFavorites();
  else if (currentView === 'library' && activeFilter === 'favorites') renderLibrary();
  renderCounts();
}
$('btn-favorite').addEventListener('click', () => {
  if (currentTrackIndex < 0) return;
  toggleFavorite(library[currentTrackIndex].path);
});
$('fs-btn-favorite').addEventListener('click', () => {
  if (currentTrackIndex < 0) return;
  toggleFavorite(library[currentTrackIndex].path);
});

// ── Playback controls ──
$('btn-play').addEventListener('click', togglePlay);
$('fs-btn-play').addEventListener('click', togglePlay);
$('btn-next').addEventListener('click', nextTrack);
$('fs-btn-next').addEventListener('click', nextTrack);
$('btn-prev').addEventListener('click', prevTrack);
$('fs-btn-prev').addEventListener('click', prevTrack);

$('btn-shuffle').addEventListener('click', () => {
  isShuffle = !isShuffle;
  updateShuffleUI();
});
$('fs-btn-shuffle').addEventListener('click', () => {
  isShuffle = !isShuffle;
  updateShuffleUI();
});
$('btn-repeat').addEventListener('click', () => {
  repeatMode = (repeatMode + 1) % 3;
  updateRepeatUI();
});
$('fs-btn-repeat').addEventListener('click', () => {
  repeatMode = (repeatMode + 1) % 3;
  updateRepeatUI();
});

// ── Audio events ──
audio.addEventListener('play', () => { isPlaying = true; updatePlayButtonUI(); });
audio.addEventListener('pause', () => { isPlaying = false; updatePlayButtonUI(); });
audio.addEventListener('timeupdate', () => {
  const cur = audio.currentTime, dur = audio.duration;
  $('time-current').textContent = formatTime(cur);
  $('fs-time-current').textContent = formatTime(cur);
  if (!isNaN(dur)) {
    $('time-total').textContent = formatTime(dur);
    $('fs-time-total').textContent = formatTime(dur);
    const pct = (cur / dur) * 100;
    $('progress-fill').style.width = `${pct}%`;
    $('progress-thumb').style.left = `${pct}%`;
    $('fs-progress-fill').style.width = `${pct}%`;
    $('fs-progress-thumb').style.left = `${pct}%`;
  }
});
audio.addEventListener('ended', () => {
  if (repeatMode === 2) { audio.currentTime = 0; audio.play(); }
  else nextTrack();
});

// Progress track click/drag (both bars)
function wireSeek(trackEl) {
  let dragging = false;
  function seekTo(clientX) {
    if (!audio.duration) return;
    const rect = trackEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
  }
  trackEl.addEventListener('mousedown', e => {
    dragging = true;
    seekTo(e.clientX);
  });
  window.addEventListener('mousemove', e => { if (dragging) seekTo(e.clientX); });
  window.addEventListener('mouseup', () => { dragging = false; });
}
wireSeek($('progress-track'));
wireSeek($('fs-progress-track'));

// Volume
function setVolume(v) {
  audio.muted = false;
  audio.volume = Math.max(0, Math.min(1, v));
  updateVolumeUI();
}
function wireVolume(trackEl) {
  let dragging = false;
  function setFromX(clientX) {
    const rect = trackEl.getBoundingClientRect();
    setVolume((clientX - rect.left) / rect.width);
  }
  trackEl.addEventListener('mousedown', e => { dragging = true; setFromX(e.clientX); });
  window.addEventListener('mousemove', e => { if (dragging) setFromX(e.clientX); });
  window.addEventListener('mouseup', () => { dragging = false; });
}
wireVolume($('vol-track'));

function updateVolumeUI() {
  const v = audio.muted ? 0 : audio.volume;
  $('vol-fill').style.width = `${v * 100}%`;
  const icon = audio.muted || v === 0 ? '#i-volume-mute'
    : v < 0.5 ? '#i-volume-low'
    : '#i-volume';
  $('btn-mute').querySelector('use').setAttribute('href', icon);
}
$('btn-mute').addEventListener('click', () => {
  audio.muted = !audio.muted;
  updateVolumeUI();
});
audio.volume = 1;
updateVolumeUI();

// ── Fullscreen ──
$('mini-cover-wrapper').addEventListener('click', () => {
  if (currentTrackIndex >= 0) {
    $('fullscreen-overlay').classList.add('active');
    updateFullscreenQueue();
  }
});
$('btn-fullscreen').addEventListener('click', () => {
  if (currentTrackIndex >= 0) {
    $('fullscreen-overlay').classList.add('active');
    updateFullscreenQueue();
  }
});
$('btn-close-fullscreen').addEventListener('click', () => $('fullscreen-overlay').classList.remove('active'));
$('btn-close-fullscreen-x').addEventListener('click', () => $('fullscreen-overlay').classList.remove('active'));

function updateFullscreenQueue() {
  const list = $('fs-queue-list');
  list.innerHTML = '';
  const curPath = currentTrackIndex >= 0 ? library[currentTrackIndex].path : null;
  const idx = currentQueue.findIndex(t => t.path === curPath);
  const upcoming = currentQueue.slice(idx + 1, idx + 1 + 8);
  $('fs-queue-count').textContent = `${upcoming.length} впереди`;
  upcoming.forEach(t => {
    if (!t.cover) ensureCoverFor(t);
    const el = document.createElement('div');
    el.className = 'fs-queue-item';
    const cover = t.cover ? `background-image:url('${t.cover}')` : '';
    el.innerHTML = `
      <div class="fs-queue-cover" style="${cover}"></div>
      <div class="fs-queue-body">
        <div class="fs-queue-title">${escapeHtml(t.title)}</div>
        <div class="fs-queue-artist">${escapeHtml(t.artist)}</div>
      </div>
      <div class="fs-queue-dur">${formatTime(t.duration)}</div>
    `;
    el.addEventListener('click', () => playTrackByPath(t.path, currentQueue));
    list.appendChild(el);
  });
}

// ── Confirm delete modal ──
function confirmDelete({ kind, payload, title, text }) {
  pendingDelete = { kind, payload };
  $('confirm-title').textContent = title || 'Удалить трек?';
  $('confirm-text').textContent = text || 'Трек будет удалён из библиотеки, а файл — перемещён в корзину.';
  $('confirm-modal').classList.add('active');
}
$('btn-cancel-delete').addEventListener('click', () => {
  $('confirm-modal').classList.remove('active');
  pendingDelete = null;
});
$('btn-confirm-delete').addEventListener('click', () => {
  if (!pendingDelete) return;
  if (pendingDelete.kind === 'track') deleteTrack(pendingDelete.payload);
  else if (pendingDelete.kind === 'playlist') deletePlaylist(pendingDelete.payload);
  $('confirm-modal').classList.remove('active');
  pendingDelete = null;
});

async function deleteTrack(path) {
  const idx = trackIndexByPath(path);
  if (idx < 0) return;
  const res = await window.electronAPI.deleteFile(path);
  if (!res || !res.success) {
    alert('Не удалось удалить файл с диска: ' + (res && res.error ? res.error : 'неизвестная ошибка'));
    return;
  }
  library.splice(idx, 1);
  if (currentTrackIndex === idx) {
    audio.pause();
    isPlaying = false;
    currentTrackIndex = -1;
    $('track-title').textContent = 'Не выбрано';
    $('track-artist').textContent = '—';
    updatePlayButtonUI();
  } else if (currentTrackIndex > idx) {
    currentTrackIndex--;
  }
  favorites = favorites.filter(p => p !== path);
  recents = recents.filter(p => p !== path);
  playlists.forEach(pl => { pl.trackPaths = pl.trackPaths.filter(p => p !== path); });
  saveLibrary(); savePlaylists(); saveRecents();
  renderCounts();
  refreshCurrentViewRows();
  renderRecents();
}
function deletePlaylist(id) {
  playlists = playlists.filter(pl => pl.id !== id);
  savePlaylists();
  setView('playlists');
}

// ── New playlist modal ──
$('btn-new-playlist').addEventListener('click', openNewPlaylistModal);
$('btn-new-playlist-empty').addEventListener('click', openNewPlaylistModal);
function openNewPlaylistModal() {
  $('new-playlist-name').value = '';
  $('new-playlist-desc').value = '';
  $('new-playlist-modal').classList.add('active');
  setTimeout(() => $('new-playlist-name').focus(), 50);
}
$('btn-cancel-new-playlist').addEventListener('click', () => {
  $('new-playlist-modal').classList.remove('active');
});
$('btn-create-playlist').addEventListener('click', () => {
  const name = $('new-playlist-name').value.trim();
  if (!name) return;
  const desc = $('new-playlist-desc').value.trim();
  playlists.push({
    id: uid(),
    name, desc,
    color: PL_COVERS[playlists.length % PL_COVERS.length],
    trackPaths: [],
  });
  savePlaylists();
  $('new-playlist-modal').classList.remove('active');
  renderPlaylists();
});

// ── Add-to-playlist modal ──
function openAddToPlaylistModal(trackPath) {
  pendingAddPath = trackPath;
  const list = $('add-to-playlist-list');
  list.innerHTML = '';
  if (playlists.length === 0) {
    list.innerHTML = `<div class="sl-empty">Сначала создай плейлист на вкладке «Плейлисты».</div>`;
  } else {
    playlists.forEach(pl => {
      const el = document.createElement('div');
      el.className = 'sl-item';
      const has = pl.trackPaths.includes(trackPath);
      el.innerHTML = `${escapeHtml(pl.name)} ${has ? '<span style="color:var(--accent-ok);font-size:11px;margin-left:6px">уже добавлен</span>' : ''}`;
      el.addEventListener('click', () => {
        if (!has) {
          pl.trackPaths.push(trackPath);
          savePlaylists();
        }
        $('add-to-playlist-modal').classList.remove('active');
      });
      list.appendChild(el);
    });
  }
  $('add-to-playlist-modal').classList.add('active');
}
$('btn-cancel-add-pl').addEventListener('click', () => $('add-to-playlist-modal').classList.remove('active'));
$('fs-btn-add-playlist').addEventListener('click', () => {
  if (currentTrackIndex >= 0) openAddToPlaylistModal(library[currentTrackIndex].path);
});

// ── Context menu ──
function openContextMenu(e, path) {
  pendingContextTrackPath = path;
  const menu = $('track-context-menu');
  $('cm-fav-label').textContent = favorites.includes(path) ? 'Убрать из избранного' : 'В избранное';
  menu.classList.add('open');
  // position
  const rect = menu.getBoundingClientRect();
  const w = 240, h = rect.height || 280;
  let x = e.clientX, y = e.clientY;
  if (x + w > window.innerWidth) x = window.innerWidth - w - 8;
  if (y + h > window.innerHeight) y = window.innerHeight - h - 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}
function closeContextMenu() {
  $('track-context-menu').classList.remove('open');
  pendingContextTrackPath = null;
}
document.addEventListener('click', e => {
  if (!e.target.closest('#track-context-menu') && !e.target.closest('.trow-more')) {
    closeContextMenu();
  }
});
document.querySelectorAll('#track-context-menu .cm-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    const path = pendingContextTrackPath;
    closeContextMenu();
    if (!path) return;
    const track = trackByPath(path);
    if (action === 'play') playTrackByPath(path, currentQueue.length ? currentQueue : library);
    else if (action === 'favorite') toggleFavorite(path);
    else if (action === 'reveal') window.electronAPI.revealInFolder(path);
    else if (action === 'edit-tags') openMetadataEditor(path);
    else if (action === 'add-to-playlist') openAddToPlaylistModal(path);
    else if (action === 'delete') confirmDelete({
      kind: 'track', payload: path,
      title: 'Удалить трек?',
      text: `«${track.title}» от ${track.artist} будет удалён из библиотеки, а сам файл — перемещён в корзину.`,
    });
  });
});

// ── Metadata editor ──
async function openMetadataEditor(path) {
  pendingMetadataPath = path;
  let meta = trackByPath(path);
  // Refresh from disk for full tag set
  const fresh = await window.electronAPI.parseMetadata(path);
  meta = { ...meta, ...fresh };
  $('md-title').value = meta.title || '';
  $('md-artist').value = meta.artist || '';
  $('md-album').value = meta.album || '';
  $('md-album-artist').value = meta.albumArtist || '';
  $('md-year').value = meta.year || '';
  $('md-genre').value = meta.genre || '';
  $('md-track-no').value = meta.trackNo || '';
  $('md-disc-no').value = meta.discNo || '';
  $('md-comment').value = meta.comment || '';
  const cover = $('editor-cover');
  if (meta.cover) {
    cover.style.backgroundImage = `url('${meta.cover}')`;
    $('editor-cover-letter').textContent = '';
    $('editor-cover-tag').textContent = 'Встроенная обложка';
  } else {
    cover.style.backgroundImage = '';
    $('editor-cover-letter').textContent = (meta.title || '?')[0];
    $('editor-cover-tag').textContent = 'Нет обложки';
  }
  $('editor-filename').textContent = path;
  $('editor-status').textContent = '';
  $('editor-status').className = 'editor-foot-status';
  $('metadata-modal').classList.add('active');
}
$('btn-close-editor').addEventListener('click', () => $('metadata-modal').classList.remove('active'));
$('btn-cancel-editor').addEventListener('click', () => $('metadata-modal').classList.remove('active'));
$('btn-save-editor').addEventListener('click', async () => {
  if (!pendingMetadataPath) return;
  const status = $('editor-status');
  status.textContent = 'Сохранение…';
  status.className = 'editor-foot-status';
  const tags = {
    title: $('md-title').value,
    artist: $('md-artist').value,
    album: $('md-album').value,
    albumArtist: $('md-album-artist').value,
    year: $('md-year').value,
    genre: $('md-genre').value,
    trackNo: $('md-track-no').value,
    discNo: $('md-disc-no').value,
    comment: $('md-comment').value,
  };
  const res = await window.electronAPI.writeMetadata(pendingMetadataPath, tags);
  if (res.success) {
    status.textContent = 'Сохранено ✓';
    status.className = 'editor-foot-status ok';
    // update in-memory library
    const t = trackByPath(pendingMetadataPath);
    if (t) {
      Object.assign(t, {
        title: tags.title || t.title,
        artist: tags.artist || t.artist,
        album: tags.album || t.album,
        albumArtist: tags.albumArtist,
        year: tags.year,
        genre: tags.genre,
        trackNo: tags.trackNo,
        discNo: tags.discNo,
        comment: tags.comment,
      });
      saveLibrary();
      refreshCurrentViewRows();
      if (currentTrackIndex === trackIndexByPath(pendingMetadataPath)) updateNowPlayingUI(t);
    }
    setTimeout(() => $('metadata-modal').classList.remove('active'), 600);
  } else {
    status.textContent = res.error || 'Ошибка сохранения';
    status.className = 'editor-foot-status error';
  }
});

// ── Command palette ──
let paletteResults = [];
let paletteHighlight = 0;

function openPalette() {
  $('palette-overlay').classList.add('active');
  $('palette-input').value = '';
  renderPaletteResults('');
  setTimeout(() => $('palette-input').focus(), 50);
}
function closePalette() {
  $('palette-overlay').classList.remove('active');
}
function renderPaletteResults(query) {
  const q = query.trim().toLowerCase();
  const container = $('palette-results');
  container.innerHTML = '';
  paletteResults = [];
  paletteHighlight = 0;

  // Track matches
  const tracks = q ? library.filter(t =>
    t.title.toLowerCase().includes(q) ||
    t.artist.toLowerCase().includes(q) ||
    t.album.toLowerCase().includes(q)
  ).slice(0, 8) : library.slice(0, 5);
  if (tracks.length > 0) {
    const lbl = document.createElement('div');
    lbl.className = 'palette-section-label';
    lbl.textContent = 'Треки';
    container.appendChild(lbl);
    tracks.forEach(t => {
      if (!t.cover) ensureCoverFor(t);
      paletteResults.push({ kind: 'play-track', path: t.path });
      const el = document.createElement('div');
      el.className = 'palette-item';
      el.dataset.idx = paletteResults.length - 1;
      const cover = t.cover ? `background-image:url('${t.cover}')` : '';
      el.innerHTML = `
        <div class="palette-item-cover" style="${cover}"></div>
        <div class="palette-item-body">
          <div class="palette-item-title">${highlightMatch(t.title, q)}</div>
          <div class="palette-item-sub">${escapeHtml(t.artist)} · ${escapeHtml(t.album)}</div>
        </div>
        <span class="palette-item-hint">↵ играть</span>
      `;
      el.addEventListener('click', () => runPaletteAction(paletteResults[+el.dataset.idx]));
      container.appendChild(el);
    });
  }

  // Actions
  const actions = [
    { label: 'Открыть файлы…', kind: 'open-files', icon: '#i-folder' },
    { label: 'Перейти в Настройки', kind: 'goto-settings', icon: '#i-settings' },
    { label: 'Перейти в Плейлисты', kind: 'goto-playlists', icon: '#i-list' },
    { label: 'Перейти в Избранное', kind: 'goto-favorites', icon: '#i-heart' },
  ].filter(a => !q || a.label.toLowerCase().includes(q));
  if (actions.length > 0) {
    const lbl = document.createElement('div');
    lbl.className = 'palette-section-label';
    lbl.textContent = 'Действия';
    container.appendChild(lbl);
    actions.forEach(a => {
      paletteResults.push({ kind: a.kind });
      const el = document.createElement('div');
      el.className = 'palette-item';
      el.dataset.idx = paletteResults.length - 1;
      el.innerHTML = `
        <div class="palette-item-cover"><svg class="i" width="13" height="13"><use href="${a.icon}"/></svg></div>
        <div class="palette-item-body">
          <div class="palette-item-title">${escapeHtml(a.label)}</div>
        </div>
      `;
      el.addEventListener('click', () => runPaletteAction(paletteResults[+el.dataset.idx]));
      container.appendChild(el);
    });
  }

  if (paletteResults.length === 0) {
    container.innerHTML = `<div class="palette-empty">Ничего не найдено</div>`;
  } else {
    highlightPaletteItem();
  }
}
function highlightMatch(text, q) {
  if (!q) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx))
    + `<span class="palette-match">${escapeHtml(text.slice(idx, idx + q.length))}</span>`
    + escapeHtml(text.slice(idx + q.length));
}
function highlightPaletteItem() {
  document.querySelectorAll('#palette-results .palette-item').forEach((el, i) => {
    el.classList.toggle('highlighted', i === paletteHighlight);
  });
}
function runPaletteAction(action) {
  closePalette();
  if (!action) return;
  if (action.kind === 'play-track') playTrackByPath(action.path, library);
  else if (action.kind === 'open-files') $('btn-add-files').click();
  else if (action.kind === 'goto-settings') setView('settings');
  else if (action.kind === 'goto-playlists') setView('playlists');
  else if (action.kind === 'goto-favorites') setView('favorites');
}
$('palette-input').addEventListener('input', e => renderPaletteResults(e.target.value));
$('palette-input').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteHighlight = Math.min(paletteResults.length - 1, paletteHighlight + 1); highlightPaletteItem(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteHighlight = Math.max(0, paletteHighlight - 1); highlightPaletteItem(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPaletteAction(paletteResults[paletteHighlight]); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('palette-overlay').addEventListener('click', e => {
  if (e.target.id === 'palette-overlay') closePalette();
});

// Global keyboard shortcuts
document.addEventListener('keydown', e => {
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('palette-overlay').classList.contains('active')) closePalette();
    else openPalette();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e' && currentTrackIndex >= 0 && !isInput) {
    e.preventDefault();
    openMetadataEditor(library[currentTrackIndex].path);
  } else if (e.key === ' ' && !isInput) {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'Escape') {
    if ($('fullscreen-overlay').classList.contains('active')) $('fullscreen-overlay').classList.remove('active');
    else if ($('metadata-modal').classList.contains('active')) $('metadata-modal').classList.remove('active');
    else if ($('new-playlist-modal').classList.contains('active')) $('new-playlist-modal').classList.remove('active');
    else if ($('add-to-playlist-modal').classList.contains('active')) $('add-to-playlist-modal').classList.remove('active');
  }
});

// ── Filters / sort ──
document.querySelectorAll('#view-library .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#view-library .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;
    renderLibrary();
  });
});

// Library inline search
$('library-search').addEventListener('input', () => {
  renderLibrary();
});

// Artists sort chips + search
document.querySelectorAll('#view-artists .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#view-artists .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    artistsSort = chip.dataset.artistsSort;
    renderArtists();
  });
});
$('artists-search').addEventListener('input', () => renderArtists());
$('artist-detail-search').addEventListener('input', () => {
  if (activeArtistName) renderArtistDetail(activeArtistName);
});

// ── Settings UI ──
function renderSettings() {
  // Theme cards
  document.querySelectorAll('.theme-card').forEach(card => {
    card.classList.toggle('active', card.dataset.theme === settings.theme);
  });
  // Toggles
  document.querySelectorAll('.toggle').forEach(t => {
    const key = t.dataset.setting;
    const map = { 'scan-subdirs': 'scanSubdirs', 'auto-rescan': 'autoRescan', 'downloads': 'downloads' };
    if (settings[map[key]]) t.classList.add('on'); else t.classList.remove('on');
  });
  // Folder
  $('default-folder-path').textContent = settings.defaultFolder || '— не выбрана —';
  // Language
  const lblMap = { ru: 'Русский', en: 'English', de: 'Deutsch', fr: 'Français', uk: 'Українська' };
  $('lang-current').textContent = lblMap[settings.language] || 'Русский';
  document.querySelectorAll('.select-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.lang === settings.language);
  });
}

document.querySelectorAll('.theme-card').forEach(card => {
  card.addEventListener('click', () => {
    settings.theme = card.dataset.theme;
    saveSettings();
    applyTheme(settings.theme);
    renderSettings();
  });
});
document.querySelectorAll('.toggle').forEach(t => {
  t.addEventListener('click', () => {
    if (t.classList.contains('is-disabled')) return;
    const map = { 'scan-subdirs': 'scanSubdirs', 'auto-rescan': 'autoRescan', 'downloads': 'downloads' };
    const key = map[t.dataset.setting];
    settings[key] = !settings[key];
    saveSettings();
    t.classList.toggle('on', settings[key]);
    if (key === 'downloads') applyDownloadsVisibility();
  });
});
$('btn-choose-default-folder').addEventListener('click', async () => {
  const folder = await window.electronAPI.chooseFolder();
  if (folder) {
    settings.defaultFolder = folder;
    saveSettings();
    renderSettings();
  }
});
const langSelect = $('lang-select');
langSelect.querySelector('.select-btn').addEventListener('click', e => {
  e.stopPropagation();
  langSelect.classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('#lang-select')) langSelect.classList.remove('open');
});
document.querySelectorAll('.select-opt').forEach(o => {
  o.addEventListener('click', () => {
    settings.language = o.dataset.lang;
    saveSettings();
    langSelect.classList.remove('open');
    renderSettings();
  });
});

function applyDownloadsVisibility() {
  $('nav-downloads').hidden = !settings.downloads;
  if (!settings.downloads && currentView === 'downloads') setView('library');
}
applyDownloadsVisibility();

// Covers for recents (sidebar) and the now-playing track are loaded eagerly,
// since they're always visible. Library/favorites/playlist covers load lazily
// as rows scroll into view (see ensureCoverFor + renderTrackRow).
async function restoreCovers() {
  if (library.length === 0) return;
  const priority = new Set();
  recents.slice(0, 4).forEach(p => priority.add(p));
  if (currentTrackIndex >= 0 && library[currentTrackIndex]) {
    priority.add(library[currentTrackIndex].path);
  }
  for (const path of priority) {
    const t = trackByPath(path);
    if (t) await ensureCoverFor(t);
  }
  renderRecents();
  if (currentTrackIndex >= 0) updateNowPlayingUI(library[currentTrackIndex]);
}

// Optional: scan default folder on startup
async function maybeAutoRescan() {
  if (!settings.autoRescan || !settings.defaultFolder) return;
  try {
    const files = await window.electronAPI.scanFolder(settings.defaultFolder);
    if (files && files.length > 0) await importPaths(files);
  } catch (e) { /* ignore */ }
}

// Boot
renderLibrary();
renderRecents();
updateShuffleUI();
updateRepeatUI();
loadLastTrack();
restoreCovers();
maybeAutoRescan();
