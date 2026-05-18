// State
// Library stored without covers (to stay within localStorage 5MB limit)
let libraryMeta = JSON.parse(localStorage.getItem('ambevor-library-meta')) || [];
let favorites = JSON.parse(localStorage.getItem('ambevor-favorites')) || [];
// Covers stored in memory only (re-parsed on each session)
const coverCache = {};
// Rebuild full library: merge meta + cached covers
let library = libraryMeta.map(t => ({ ...t, cover: coverCache[t.path] || null }));
let currentTrackIndex = -1;
let isPlaying = false;
let isShuffle = false;
let repeatMode = 0; // 0: off, 1: all, 2: one
let trackToDeleteIndex = -1;

// DOM Elements
const audio = document.getElementById('audio-player');
const btnAddFiles = document.getElementById('btn-add-files');
const libraryList = document.getElementById('library-list');
const favoritesList = document.getElementById('favorites-list');
const favoritesEmpty = document.getElementById('favorites-empty');

// Playback Controls
const btnPlay = document.getElementById('btn-play');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnShuffle = document.getElementById('btn-shuffle');
const btnRepeat = document.getElementById('btn-repeat');
const btnMute = document.getElementById('btn-mute');

const progressBar = document.getElementById('progress-bar');
const volumeBar = document.getElementById('volume-bar');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');

// Info Elements
const trackCover = document.getElementById('track-cover');
const trackTitle = document.getElementById('track-title');
const trackArtist = document.getElementById('track-artist');

// Fullscreen Elements
const fsOverlay = document.getElementById('fullscreen-overlay');
const btnCloseFs = document.getElementById('btn-close-fullscreen');
const miniCover = document.getElementById('mini-cover-wrapper');
const fsCover = document.getElementById('fs-cover');
const fsTitle = document.getElementById('fs-title');
const fsArtist = document.getElementById('fs-artist');
const fsAlbum = document.getElementById('fs-album');

// Modal Elements
const modalOverlay = document.getElementById('confirm-modal');
const btnCancelDelete = document.getElementById('btn-cancel-delete');
const btnConfirmDelete = document.getElementById('btn-confirm-delete');

// Navigation
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    
    document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${item.dataset.view}`).classList.add('active');
  });
});

// Format time
function formatTime(seconds) {
  if (isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function saveState() {
  libraryMeta = library.map(({ cover, ...rest }) => rest);
  try {
    localStorage.setItem('ambevor-library-meta', JSON.stringify(libraryMeta));
    localStorage.setItem('ambevor-favorites', JSON.stringify(favorites));
  } catch(e) {
    console.warn('localStorage full, could not save state:', e);
  }
}

// Open Files
btnAddFiles.addEventListener('click', async () => {
  const filePaths = await window.electronAPI.openFiles();
  if (filePaths.length > 0) {
    for (const filePath of filePaths) {
      if (!library.some(t => t.path === filePath)) {
        const metadata = await window.electronAPI.parseMetadata(filePath);
        // Cache cover in memory
        if (metadata.cover) {
          coverCache[filePath] = metadata.cover;
        }
        library.push(metadata);
      }
    }
    saveState();
    renderLibrary();
  }
});

// Render Library
function renderLibrary() {
  libraryList.innerHTML = '';
  library.forEach((track, index) => {
    const tr = document.createElement('tr');
    if (index === currentTrackIndex) tr.classList.add('playing');
    
    tr.innerHTML = `
      <td>${track.title}</td>
      <td>${track.artist}</td>
      <td>${track.album}</td>
      <td>${formatTime(track.duration)}</td>
      <td class="action-cell"><button class="btn-icon btn-delete" title="Удалить">✕</button></td>
    `;
    
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete')) {
        e.stopPropagation();
        confirmDelete(index);
        return;
      }
      playTrack(index);
    });
    
    libraryList.appendChild(tr);
  });
  renderFavorites();
}

function renderFavorites() {
  if (!favoritesList) return;
  favoritesList.innerHTML = '';
  const favTracks = library.filter(t => favorites.includes(t.path));
  
  if (favTracks.length === 0) {
    favoritesEmpty.style.display = 'block';
    favoritesList.parentElement.parentElement.style.display = 'none';
  } else {
    favoritesEmpty.style.display = 'none';
    favoritesList.parentElement.parentElement.style.display = 'block';
    
    favTracks.forEach((track) => {
      const index = library.indexOf(track);
      const tr = document.createElement('tr');
      if (index === currentTrackIndex) tr.classList.add('playing');
      
      tr.innerHTML = `
        <td>${track.title}</td>
        <td>${track.artist}</td>
        <td>${track.album}</td>
        <td>${formatTime(track.duration)}</td>
        <td class="action-cell"><button class="btn-icon btn-delete" title="Убрать из избранного">✕</button></td>
      `;
      
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete')) {
          e.stopPropagation();
          confirmDelete(index);
          return;
        }
        playTrack(index);
      });
      
      favoritesList.appendChild(tr);
    });
  }
}

function confirmDelete(index) {
  trackToDeleteIndex = index;
  modalOverlay.classList.add('active');
}

btnCancelDelete.addEventListener('click', () => {
  modalOverlay.classList.remove('active');
  trackToDeleteIndex = -1;
});

btnConfirmDelete.addEventListener('click', () => {
  if (trackToDeleteIndex !== -1) {
    deleteTrack(trackToDeleteIndex);
    modalOverlay.classList.remove('active');
    trackToDeleteIndex = -1;
  }
});

function deleteTrack(index) {
  const deletedPath = library[index].path;
  library.splice(index, 1);
  
  if (currentTrackIndex === index) {
    audio.pause();
    isPlaying = false;
    currentTrackIndex = -1;
    btnPlay.innerHTML = '▶';
    btnPlay.classList.remove('is-playing');
    fsCover.classList.remove('playing');
  } else if (currentTrackIndex > index) {
    currentTrackIndex--;
  }
  
  // Remove from favorites if it's there
  favorites = favorites.filter(p => p !== deletedPath);
  saveState();
  renderLibrary();
}

// Color Extraction
function getAverageColor(imgElement) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  
  if (!imgElement || !imgElement.complete || imgElement.naturalWidth === 0) {
    return { r: 28, g: 24, b: 21 }; // Fallback color
  }
  
  canvas.width = imgElement.naturalWidth || imgElement.width;
  canvas.height = imgElement.naturalHeight || imgElement.height;
  
  context.drawImage(imgElement, 0, 0, canvas.width, canvas.height);
  
  try {
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let r = 0, g = 0, b = 0;
    const step = 4 * 10;
    let count = 0;
    
    for (let i = 0; i < data.length; i += step) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
    
    if (count > 0) {
      r = Math.floor(r / count);
      g = Math.floor(g / count);
      b = Math.floor(b / count);
    }
    return { r, g, b };
  } catch(e) {
    return { r: 28, g: 24, b: 21 };
  }
}

// Playback Logic
function toggleFavorite(path) {
  if (favorites.includes(path)) {
    favorites = favorites.filter(p => p !== path);
  } else {
    favorites.push(path);
  }
  saveState();
  renderLibrary();
  
  if (currentTrackIndex !== -1 && library[currentTrackIndex].path === path) {
    updateUIForPlaying(library[currentTrackIndex]);
  }
}

// Playback Logic
function playTrack(index) {
  if (index < 0 || index >= library.length) return;
  currentTrackIndex = index;
  const track = library[index];
  
  // Use file:// protocol for audio src
  audio.src = 'file://' + track.path;
  audio.play();
  isPlaying = true;
  updateUIForPlaying(track);
  renderLibrary();
}

function updateUIForPlaying(track) {
  const coverSrc = track.cover || "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%23222' width='100' height='100'/></svg>";
  
  trackCover.onload = () => {
    const playbackBar = document.querySelector('.playback-bar');
    if (track.cover) {
      const color = getAverageColor(trackCover);
      playbackBar.style.backgroundColor = `rgba(${Math.max(20, color.r * 0.15)}, ${Math.max(20, color.g * 0.15)}, ${Math.max(20, color.b * 0.15)}, 0.95)`;
      playbackBar.style.borderTopColor = `rgba(${color.r}, ${color.g}, ${color.b}, 0.2)`;
    } else {
      playbackBar.style.backgroundColor = 'var(--bg-color-light)';
      playbackBar.style.borderTopColor = 'var(--border-color)';
    }
  };
  
  trackCover.src = coverSrc;
  fsCover.src = coverSrc;
  
  trackTitle.textContent = track.title;
  trackArtist.textContent = track.artist;
  
  fsTitle.textContent = track.title;
  fsArtist.textContent = track.artist;
  fsAlbum.textContent = track.album;
  
  const btnFavorite = document.getElementById('btn-favorite');
  if (favorites.includes(track.path)) {
    btnFavorite.classList.add('active');
    btnFavorite.innerHTML = '♥';
  } else {
    btnFavorite.classList.remove('active');
    btnFavorite.innerHTML = '♡';
  }
  
  btnPlay.innerHTML = '⏸';
  btnPlay.classList.add('is-playing');
  fsCover.classList.add('playing');
}

function togglePlay() {
  if (currentTrackIndex === -1 && library.length > 0) {
    playTrack(0);
    return;
  }
  
  if (audio.paused) {
    audio.play();
    isPlaying = true;
    btnPlay.innerHTML = '⏸';
    btnPlay.classList.add('is-playing');
    fsCover.classList.add('playing');
  } else {
    audio.pause();
    isPlaying = false;
    btnPlay.innerHTML = '▶';
    btnPlay.classList.remove('is-playing');
    fsCover.classList.remove('playing');
  }
}

function nextTrack() {
  if (library.length === 0) return;
  
  if (isShuffle && library.length > 1) {
    // Pick a random index different from the current one
    let randomIndex;
    do {
      randomIndex = Math.floor(Math.random() * library.length);
    } while (randomIndex === currentTrackIndex);
    playTrack(randomIndex);
  } else {
    let nextIndex = currentTrackIndex + 1;
    if (nextIndex >= library.length) {
      nextIndex = repeatMode > 0 ? 0 : currentTrackIndex; // Loop back if repeat is on
    }
    if (nextIndex !== currentTrackIndex || repeatMode > 0) playTrack(nextIndex);
  }
}

function prevTrack() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
  } else {
    let prevIndex = currentTrackIndex - 1;
    if (prevIndex < 0) prevIndex = library.length - 1;
    playTrack(prevIndex);
  }
}

// Event Listeners
btnPlay.addEventListener('click', togglePlay);
btnNext.addEventListener('click', nextTrack);
btnPrev.addEventListener('click', prevTrack);

const btnFavorite = document.getElementById('btn-favorite');
btnFavorite.addEventListener('click', () => {
  if (currentTrackIndex === -1) return;
  toggleFavorite(library[currentTrackIndex].path);
});

btnShuffle.addEventListener('click', () => {
  isShuffle = !isShuffle;
  btnShuffle.classList.toggle('active', isShuffle);
});

btnRepeat.addEventListener('click', () => {
  repeatMode = (repeatMode + 1) % 3;
  if (repeatMode === 0) {
    btnRepeat.classList.remove('active');
    btnRepeat.innerHTML = '🔁';
  } else if (repeatMode === 1) {
    btnRepeat.classList.add('active');
    btnRepeat.innerHTML = '🔁';
  } else {
    btnRepeat.classList.add('active');
    btnRepeat.innerHTML = '🔂';
  }
});

// Audio Events
audio.addEventListener('timeupdate', () => {
  timeCurrent.textContent = formatTime(audio.currentTime);
  if (!isNaN(audio.duration)) {
    timeTotal.textContent = formatTime(audio.duration);
    progressBar.value = (audio.currentTime / audio.duration) * 100;
    
    // Update progress bar fill color
    const val = progressBar.value;
    progressBar.style.background = `linear-gradient(to right, var(--accent-color) ${val}%, rgba(255,255,255,0.1) ${val}%)`;
  }
});

audio.addEventListener('ended', () => {
  if (repeatMode === 2) {
    audio.currentTime = 0;
    audio.play();
  } else {
    nextTrack();
  }
});

// Progress Bar
progressBar.addEventListener('input', (e) => {
  if (!isNaN(audio.duration)) {
    audio.currentTime = (e.target.value / 100) * audio.duration;
  }
});

// Volume Control
volumeBar.addEventListener('input', (e) => {
  audio.volume = e.target.value;
  updateVolumeIcon();
});

btnMute.addEventListener('click', () => {
  audio.muted = !audio.muted;
  updateVolumeIcon();
});

function updateVolumeIcon() {
  if (audio.muted || audio.volume === 0) {
    btnMute.innerHTML = '🔇';
  } else if (audio.volume < 0.5) {
    btnMute.innerHTML = '🔉';
  } else {
    btnMute.innerHTML = '🔊';
  }
  
  // Update volume bar fill
  const val = audio.muted ? 0 : audio.volume * 100;
  volumeBar.style.background = `linear-gradient(to right, var(--accent-color) ${val}%, rgba(255,255,255,0.1) ${val}%)`;
}

// Initial volume setup
audio.volume = 1;
updateVolumeIcon();

// Fullscreen
miniCover.addEventListener('click', () => {
  if (currentTrackIndex !== -1) {
    fsOverlay.classList.add('active');
  }
});

btnCloseFs.addEventListener('click', () => {
  fsOverlay.classList.remove('active');
});

// Sync progress bar color on start
progressBar.style.background = `linear-gradient(to right, var(--accent-color) 0%, rgba(255,255,255,0.1) 0%)`;

// Initial Render — restore covers async from disk for already-saved tracks
async function restoreCovers() {
  if (library.length === 0) return;
  for (const track of library) {
    if (!track.cover) {
      try {
        const metadata = await window.electronAPI.parseMetadata(track.path);
        if (metadata.cover) {
          track.cover = metadata.cover;
          coverCache[track.path] = metadata.cover;
        }
      } catch(e) { /* file may have moved, ignore */ }
    }
  }
  renderLibrary();
}

if (library.length > 0) {
  renderLibrary();
  restoreCovers();
}
