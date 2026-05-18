// State
let library = [];
let currentTrackIndex = -1;
let isPlaying = false;
let isShuffle = false;
let repeatMode = 0; // 0: off, 1: all, 2: one

// DOM Elements
const audio = document.getElementById('audio-player');
const btnAddFiles = document.getElementById('btn-add-files');
const libraryList = document.getElementById('library-list');

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

// Open Files
btnAddFiles.addEventListener('click', async () => {
  const filePaths = await window.electronAPI.openFiles();
  if (filePaths.length > 0) {
    for (const filePath of filePaths) {
      if (!library.some(t => t.path === filePath)) {
        const metadata = await window.electronAPI.parseMetadata(filePath);
        library.push(metadata);
      }
    }
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
    `;
    
    tr.addEventListener('click', () => {
      playTrack(index);
    });
    
    libraryList.appendChild(tr);
  });
}

// Playback Logic
function playTrack(index) {
  if (index < 0 || index >= library.length) return;
  currentTrackIndex = index;
  const track = library[index];
  
  // Use custom local:// protocol for audio src
  audio.src = 'local://' + encodeURIComponent(track.path);
  audio.play();
  isPlaying = true;
  updateUIForPlaying(track);
  renderLibrary();
}

function updateUIForPlaying(track) {
  const coverSrc = track.cover || "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%23222' width='100' height='100'/></svg>";
  
  trackCover.src = coverSrc;
  fsCover.src = coverSrc;
  
  trackTitle.textContent = track.title;
  trackArtist.textContent = track.artist;
  
  fsTitle.textContent = track.title;
  fsArtist.textContent = track.artist;
  fsAlbum.textContent = track.album;
  
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
  
  if (isShuffle) {
    playTrack(Math.floor(Math.random() * library.length));
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
