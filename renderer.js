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
}, JSON.parse(localStorage.getItem(LS.settings) || '{}'));
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
}
function renderRecents() {
  const list = $('recents-list');
  list.innerHTML = '';
  recents.slice(0, 4).forEach(path => {
    const t = trackByPath(path);
    if (!t) return;
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
function renderLibrary() {
  const list = $('library-list');
  const empty = $('library-empty');
  const tracks = sortedFilteredLibrary();
  list.innerHTML = '';
  $('library-count-label').textContent = `${library.length} ${pluralTracks(library.length)}`;
  if (library.length === 0) {
    empty.classList.add('show');
  } else {
    empty.classList.remove('show');
    tracks.forEach((t, i) => list.appendChild(renderTrackRow(t, i, tracks)));
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
  list.innerHTML = '';
  const tracks = library.filter(t => favorites.includes(t.path));
  $('favorites-count-label').textContent = `${tracks.length} ${pluralTracks(tracks.length)}`;
  if (tracks.length === 0) {
    empty.classList.add('show');
  } else {
    empty.classList.remove('show');
    tracks.forEach((t, i) => list.appendChild(renderTrackRow(t, i, tracks)));
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
  list.innerHTML = '';
  tracks.forEach((t, i) => list.appendChild(renderTrackRow(t, i, tracks)));

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

// ── Playback ──
function playTrackByPath(path, queue) {
  const realIndex = trackIndexByPath(path);
  if (realIndex < 0) return;
  currentTrackIndex = realIndex;
  currentQueue = queue && queue.length > 0 ? queue : library;
  const track = library[realIndex];
  audio.src = 'file://' + track.path;
  audio.play().catch(e => console.warn('play error:', e));
  isPlaying = true;
  // recent
  recents = [path, ...recents.filter(p => p !== path)].slice(0, 4);
  saveRecents();
  renderRecents();
  updateNowPlayingUI(track);
  refreshCurrentViewRows();
}

function refreshCurrentViewRows() {
  if (currentView === 'library') renderLibrary();
  else if (currentView === 'favorites') renderFavorites();
  else if (currentView === 'playlist-detail') renderPlaylistDetail(activePlaylistId);
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
}

function updatePlayButtonUI() {
  const playBtn = $('btn-play').querySelector('use');
  const fsPlayBtn = $('fs-btn-play').querySelector('use');
  playBtn.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
  fsPlayBtn.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
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

// ── Favorites ──
function toggleFavorite(path) {
  if (favorites.includes(path)) favorites = favorites.filter(p => p !== path);
  else favorites.push(path);
  saveLibrary();
  updateFavoriteUI();
  refreshCurrentViewRows();
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
  $('confirm-text').textContent = text || 'Будет удалён из библиотеки. Сам файл на диске останется.';
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

function deleteTrack(path) {
  const idx = trackIndexByPath(path);
  if (idx < 0) return;
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
      text: `«${track.title}» от ${track.artist} будет удалён из библиотеки. Сам файл на диске останется.`,
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
$('library-search').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  const list = $('library-list');
  list.innerHTML = '';
  const filtered = (q
    ? library.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q))
    : sortedFilteredLibrary());
  filtered.forEach((t, i) => list.appendChild(renderTrackRow(t, i, filtered)));
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
    const map = { 'scan-subdirs': 'scanSubdirs', 'auto-rescan': 'autoRescan' };
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
    const map = { 'scan-subdirs': 'scanSubdirs', 'auto-rescan': 'autoRescan' };
    const key = map[t.dataset.setting];
    settings[key] = !settings[key];
    saveSettings();
    t.classList.toggle('on', settings[key]);
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

// ── Initial render + restore covers ──
async function restoreCovers() {
  if (library.length === 0) return;
  for (const track of library) {
    if (!track.cover) {
      try {
        const md = await window.electronAPI.parseMetadata(track.path);
        if (md.cover) {
          track.cover = md.cover;
          coverCache[track.path] = md.cover;
        }
      } catch (e) { /* file moved */ }
    }
  }
  refreshCurrentViewRows();
  if (currentTrackIndex >= 0) updateNowPlayingUI(library[currentTrackIndex]);
  renderRecents();
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
restoreCovers();
maybeAutoRescan();
