// ── Audex renderer ──

// Storage keys (kept "ambevor-*" for the library so existing users don't lose state;
// new keys use the audex- prefix).
const LS = {
  libraryMeta: 'ambevor-library-meta',
  favorites: 'ambevor-favorites',
  playlists: 'audex-playlists',
  settings: 'audex-settings',
  recents: 'audex-recents',
  updateDismiss: 'audex-update-dismiss',
  ytState: 'audex-dl-yt-state',
  ymState: 'audex-dl-ym-state',
  queue: 'audex-dl-queue',
  wavePeaks: 'audex-wave-peaks',
};

// State
let libraryMeta = JSON.parse(localStorage.getItem(LS.libraryMeta) || '[]');
let favorites = JSON.parse(localStorage.getItem(LS.favorites) || '[]');
let playlists = JSON.parse(localStorage.getItem(LS.playlists) || '[]');
let settings = Object.assign({
  theme: 'dark',          // 'dark' | 'light' | 'system' | designer palette id (nocturne/terracotta/forest/vapor/noir/arctic)
  accent: '',             // '' = theme default; otherwise a hex like '#5b9eff'
  language: 'en',
  defaultFolder: '',
  scanSubdirs: true,
  downloads: false,
  showParserBrowser: true,
  uiScale: 1,
}, JSON.parse(localStorage.getItem(LS.settings) || '{}'));
let recents = JSON.parse(localStorage.getItem(LS.recents) || '[]');

const coverCache = {};
let library = libraryMeta.map(t => ({ ...t, cover: coverCache[t.path] || null }));

// Real waveform peaks (path -> Float[0..1], length WAVE_BARS), decoded from audio
// on first play and cached. Loaded from compact 0..255 ints in localStorage.
const WAVE_CACHE_MAX = 600;
const wavePeaksCache = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(LS.wavePeaks) || '{}');
    const out = {};
    for (const k in raw) out[k] = raw[k].map(v => v / 255);
    return out;
  } catch (_) { return {}; }
})();

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

// ── Accent color ──
// Preset palette. The first entry ('') means "use the theme's built-in accent".
const ACCENT_PRESETS = [
  { value: '',        label: 'default' },
  { value: '#5b9eff', label: 'blue'    },
  { value: '#7c8cff', label: 'indigo'  },
  { value: '#b07cff', label: 'purple'  },
  { value: '#ff6b8a', label: 'pink'    },
  { value: '#ff5577', label: 'red'     },
  { value: '#ff9a3d', label: 'orange'  },
  { value: '#e8c547', label: 'yellow'  },
  { value: '#4ecdc4', label: 'teal'    },
  { value: '#7ec9a8', label: 'green'   },
];
function isHexColor(s) {
  return typeof s === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim());
}
function applyAccent(hex) {
  if (hex && isHexColor(hex)) {
    root.style.setProperty('--accent', hex);
  } else {
    root.style.removeProperty('--accent');
  }
}
applyAccent(settings.accent);

// ── Theme combobox options ──
// Built-in themes (dark/light/system) use i18n labels; designer palettes use
// their proper names. `emoji` is shown both in the menu and the select trigger.
const THEME_OPTIONS = [
  { id: 'dark',       emoji: '🌙', i18n: 'theme.dark' },
  { id: 'light',      emoji: '☀️', i18n: 'theme.light' },
  { id: 'system',     emoji: '🖥️', i18n: 'theme.system' },
  { id: 'nocturne',   emoji: '🌌', name: 'Nocturne' },
  { id: 'terracotta', emoji: '🏺', name: 'Terracotta' },
  { id: 'forest',     emoji: '🌲', name: 'Forest' },
  { id: 'vapor',      emoji: '🌆', name: 'Vapor' },
  { id: 'noir',       emoji: '🎬', name: 'Crimson Noir' },
  { id: 'arctic',     emoji: '❄️', name: 'Arctic' },
];
function themeLabel(id) {
  const o = THEME_OPTIONS.find(t => t.id === id) || THEME_OPTIONS[0];
  return `${o.emoji} ${o.i18n ? tr(o.i18n) : o.name}`;
}

// ── UI scale ──
const UI_SCALE_STEPS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5];
function clampUiScale(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 1;
  return Math.min(UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1], Math.max(UI_SCALE_STEPS[0], n));
}
function applyUiScale(scale) {
  const s = clampUiScale(scale);
  if (window.electronAPI && typeof window.electronAPI.setZoomFactor === 'function') {
    window.electronAPI.setZoomFactor(s);
  } else {
    // Fallback for older preloads: CSS zoom is Chromium-only but covers our target.
    document.documentElement.style.zoom = String(s);
  }
}
applyUiScale(settings.uiScale);

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
// Waveform peaks are persisted as compact 0..255 ints (path -> int[]), capped to
// the most-recently-decoded tracks so the cache can't grow without bound.
function saveWavePeaks() {
  try {
    const raw = {};
    for (const k of Object.keys(wavePeaksCache).slice(-WAVE_CACHE_MAX)) {
      raw[k] = wavePeaksCache[k].map(v => Math.round(v * 255));
    }
    localStorage.setItem(LS.wavePeaks, JSON.stringify(raw));
  } catch (e) {
    console.warn('wave peaks cache save failed:', e);
  }
}

// ── i18n ──
// Static UI strings are translated via [data-i18n], [data-i18n-placeholder],
// [data-i18n-title] attributes on HTML elements. Dynamic strings (rendered
// from JS) go through tr() / plural() below. Adding a new string: add the key
// to every language in I18N, then either tag the HTML element with data-i18n
// or call tr('your.key') in JS.
const I18N = {
  ru: {
    'nav.library': 'Библиотека',
    'update.available': 'Доступно обновление',
    'update.download': 'Скачать',
    'update.dismiss': 'Закрыть',
    'nav.artists': 'Исполнители',
    'nav.playlists': 'Плейлисты',
    'nav.favorites': 'Избранное',
    'nav.downloads': 'Загрузки',
    'nav.search': 'Поиск',
    'nav.recents': 'Недавнее',
    'nav.openFiles': 'Открыть файлы',
    'nav.settings': 'Настройки',
    'crumb.collection': 'Коллекция',
    'search.placeholder': 'Поиск…',
    'search.artistPlaceholder': 'Поиск исполнителя…',
    'search.trackPlaceholder': 'Поиск трека…',
    'filter.all': 'Все',
    'filter.recent': 'Недавно добавленные',
    'filter.favorites': 'Только избранное',
    'sort.label': 'Сортировка:',
    'sort.dateDesc': 'Дата добавления ↓',
    'sort.dateAsc': 'Дата добавления ↑',
    'sort.titleAsc': 'Название А→Я',
    'sort.titleDesc': 'Название Я→А',
    'sort.artistAsc': 'Исполнитель А→Я',
    'sort.artistDesc': 'Исполнитель Я→А',
    'sort.durationAsc': 'Длительность ↑',
    'sort.durationDesc': 'Длительность ↓',
    'sort.alpha': 'По алфавиту',
    'sort.byTracks': 'По числу треков',
    'sort.recent': 'Недавно добавленные',
    'table.title': 'Название',
    'table.artist': 'Исполнитель',
    'table.album': 'Альбом',
    'table.time': 'Время',
    'empty.library.title': 'Библиотека пуста',
    'empty.library.text': 'Открой файлы или папку, чтобы начать.',
    'empty.playlists.title': 'Плейлистов пока нет',
    'empty.playlists.text': 'Создай свой первый плейлист — собери треки по настроению, времени дня или альбому.',
    'empty.artists.title': 'Исполнителей пока нет',
    'empty.artists.text': 'Добавь треки в библиотеку, чтобы увидеть здесь список исполнителей.',
    'empty.favorites.title': 'Нет избранных треков',
    'empty.favorites.text': 'Нажми сердечко на любом треке, чтобы добавить его сюда.',
    'btn.newPlaylist': 'Новый плейлист',
    'btn.playAll': 'Играть всё',
    'btn.shuffle': 'Перемешать',
    'btn.deletePlaylist': 'Удалить плейлист',
    'btn.choose': 'Выбрать…',
    'btn.cancel': 'Отмена',
    'btn.delete': 'Удалить',
    'btn.create': 'Создать',
    'btn.close': 'Закрыть',
    'btn.save': 'Сохранить',
    'btn.minimize': 'Свернуть',
    'btn.portrait': 'Мобильный режим',
    'btn.album': 'Альбом',
    'btn.favorite': 'В избранное',
    'btn.unfavorite': 'Убрать из избранного',
    'btn.favoriteOn': 'В избранном',
    'btn.addToPlaylist': 'В плейлист',
    'tooltip.favorite': 'В избранное',
    'tooltip.shuffle': 'Случайный порядок',
    'tooltip.prev': 'Предыдущий',
    'tooltip.playPause': 'Воспроизведение/Пауза',
    'tooltip.next': 'Следующий',
    'tooltip.repeat': 'Повтор',
    'tooltip.fullscreen': 'Полноэкранный',
    'tooltip.volume': 'Звук',
    'tooltip.wip': 'Раздел находится в разработке',
    'hint.favorites': 'Сохранённые треки появляются здесь',
    'eyebrow.playlist': 'Плейлист',
    'eyebrow.artist': 'Исполнитель',
    'autoChip.artists': 'Список собирается автоматически из библиотеки',
    'np.empty.title': 'Не выбрано',
    'np.empty.artist': '—',
    'fs.nowPlayingFrom': 'Сейчас играет · из',
    'fs.fromLibrary': 'Библиотеки',
    'fs.nowPlaying': 'Сейчас играет',
    'fs.queue': 'Очередь',
    'fs.queueAhead': '{n} впереди',
    'downloads.tab.internet': 'Из интернета',
    'downloads.tab.parsing': 'Парсинг',
    'downloads.title': 'Скачивание из интернета',
    'downloads.subtitle': 'Здесь появится возможность сохранять треки по прямой ссылке. Раздел в разработке.',
    'downloads.parsing.title': 'Парсинг',
    'downloads.parsing.subtitle': 'Здесь появится возможность собирать треки парсингом со страниц. Раздел в разработке.',
    'downloads.yt.placeholder': 'Название трека или «исполнитель — трек»',
    'downloads.yt.search': 'Найти',
    'downloads.yt.hint': 'Поиск по YouTube · показывает несколько вариантов, чтобы выбрать нужный.',
    'downloads.yt.col.title': 'Название',
    'downloads.yt.col.channel': 'Канал',
    'downloads.yt.col.duration': 'Длит.',
    'downloads.yt.idle.title': 'Найдите трек на YouTube',
    'downloads.yt.idle.text': 'Введите название — внизу появится список mp3, доступных для скачивания. Файлы сохраняются в папку по умолчанию (если она задана в настройках) или в «Audex Downloads», и автоматически добавляются в библиотеку.',
    'downloads.yt.searching': 'Ищу: «{q}»…',
    'downloads.yt.empty': 'Ничего не найдено по запросу «{q}».',
    'downloads.yt.error': 'Ошибка поиска: {e}',
    'downloads.yt.action.download': 'Скачать',
    'downloads.yt.action.downloading': 'Загрузка…',
    'downloads.yt.action.done': 'Готово',
    'downloads.yt.action.retry': 'Повторить',
    'downloads.yt.downloadError': 'Не удалось: {e}',
    'downloads.yt.downloadOk': 'Скачано и добавлено в библиотеку: {t}',
    'downloads.yt.tagNote': 'После скачивания, возможно, потребуется вручную поправить MP3-теги (название, исполнитель, обложка) через контекстное меню трека.',
    'downloads.parsing.subtab.yandex': 'Яндекс.Музыка',
    'downloads.parsing.urlPlaceholder': 'https://music.yandex.ru/playlists/…',
    'downloads.parsing.start': 'Парсить',
    'downloads.parsing.hint': 'Вставьте ссылку на плейлист или альбом. Парсер работает в фоне.',
    'downloads.parsing.col.artist': 'Исполнитель',
    'downloads.parsing.col.title': 'Название',
    'downloads.parsing.col.duration': 'Длит.',
    'downloads.parsing.idle.title': 'Парсинг Яндекс.Музыки',
    'downloads.parsing.idle.text': 'Вставьте ссылку на плейлист или альбом из «Яндекс.Музыки». Приложение соберёт список треков в фоне, и вы сможете скачать любой одним кликом.',
    'downloads.parsing.starting': 'Запускаем парсер…',
    'downloads.parsing.done': 'Готово — собрано треков: {n}',
    'downloads.parsing.error': 'Ошибка парсинга: {e}',
    'settings.title': 'Настройки',
    'settings.subtitle': 'Внешний вид, источники музыки и поведение приложения.',
    'section.appearance': 'Внешний вид',
    'section.music': 'Музыка',
    'section.downloads': 'Скачивание из интернета',
    'section.language': 'Язык',
    'section.about': 'О приложении',
    'section.contacts': 'Контакты',
    'setting.github': 'GitHub',
    'setting.githubDesc': 'Исходный код проекта на GitHub.',
    'setting.telegram': 'Telegram',
    'setting.telegramDesc': 'Нашли баг или есть предложение — пишите в Telegram.',
    'theme.dark': 'Тёмная',
    'theme.light': 'Светлая',
    'theme.system': 'Системная',
    'setting.theme': 'Тема',
    'setting.themeDesc': 'Цветовая схема приложения.',
    'setting.accent': 'Цвет акцента',
    'setting.accentDesc': 'Подсветка активных элементов и текущего трека.',
    'setting.accentDefault': 'По умолчанию',
    'setting.accentCustom': 'Свой цвет',
    'setting.defaultFolder': 'Папка по умолчанию',
    'setting.defaultFolderDesc': 'Откуда загружать треки при запуске.',
    'setting.uiScale': 'Масштаб интерфейса',
    'setting.uiScaleDesc': 'Делает весь интерфейс крупнее или мельче. Применяется сразу.',
    'setting.uiScaleReset': 'Сбросить',
    'setting.scanSubdirs': 'Сканировать подпапки',
    'setting.scanSubdirsDesc': 'Учитывать вложенные директории при индексации.',
    'setting.showDownloads': 'Показать вкладку «Загрузки»',
    'setting.showDownloadsDesc': 'Откроет в боковом меню раздел для скачивания треков по ссылке.',
    'setting.showParserBrowser': 'Показывать окно браузера при парсинге',
    'setting.showParserBrowserDesc': 'Нужно, чтобы войти в Яндекс при первом запуске, пройти капчу или увидеть, на чём парсер споткнулся. Если выключить — браузер запустится в фоне и окно не появится.',
    'section.system': 'Система',
    'setting.hardwareAcceleration': 'Аппаратное ускорение',
    'setting.hardwareAccelerationDesc': 'Использует видеокарту для отрисовки интерфейса. Если приложение зависает при запуске или работает с артефактами — выключите. Изменение применится после перезапуска.',
    'setting.uiLanguage': 'Язык интерфейса',
    'setting.uiLanguageDesc': 'Применяется сразу.',
    'setting.version': 'Версия',
    'badge.wip': 'в разработке',
    'placeholder.noFolder': '— не выбрана —',
    'modal.deleteTrack.title': 'Удалить трек?',
    'modal.deleteTrack.text': 'Трек будет удалён из библиотеки, а файл — перемещён в корзину.',
    'modal.deleteTrackFull.text': '«{title}» от {artist} будет удалён из библиотеки, а сам файл — перемещён в корзину.',
    'modal.deletePlaylist.title': 'Удалить плейлист?',
    'modal.deletePlaylist.text': 'Плейлист «{name}» будет удалён. Треки в библиотеке останутся.',
    'modal.newPlaylist.title': 'Новый плейлист',
    'modal.newPlaylist.namePh': 'Название плейлиста',
    'modal.newPlaylist.descPh': 'Описание (необязательно)',
    'modal.addToPlaylist.title': 'Добавить в плейлист',
    'modal.addToPlaylist.empty': 'Сначала создай плейлист на вкладке «Плейлисты».',
    'modal.addToPlaylist.alreadyAdded': 'уже добавлен',
    'editor.title': 'Редактировать теги',
    'editor.cover': 'Обложка',
    'editor.field.title': 'Название',
    'editor.field.artist': 'Исполнитель',
    'editor.field.album': 'Альбом',
    'editor.field.albumArtist': 'Исп. альбома',
    'editor.field.year': 'Год',
    'editor.field.genre': 'Жанр',
    'editor.field.trackNo': 'Трек №',
    'editor.field.discNo': 'Диск №',
    'editor.field.comment': 'Комментарий',
    'editor.commentPh': 'Заметка о треке…',
    'editor.coverEmbed': 'Встроенная обложка',
    'editor.noCover': 'Нет обложки',
    'editor.saving': 'Сохранение…',
    'editor.saved': 'Сохранено ✓',
    'editor.errorSave': 'Ошибка сохранения',
    'cm.play': 'Играть',
    'cm.addToPlaylist': 'Добавить в плейлист',
    'cm.removeFromPlaylist': 'Убрать из плейлиста',
    'cm.reveal': 'Показать в папке',
    'cm.editTags': 'Редактировать теги…',
    'cm.delete': 'Удалить из библиотеки',
    'palette.placeholder': 'Поиск трека, альбома, действия…',
    'palette.nav': '↑↓ навигация',
    'palette.choose': '↵ выбрать',
    'palette.close': 'ESC закрыть',
    'palette.tracks': 'Треки',
    'palette.actions': 'Действия',
    'palette.itemHint': '↵ играть',
    'palette.empty': 'Ничего не найдено',
    'palette.action.openFiles': 'Открыть файлы…',
    'palette.action.gotoSettings': 'Перейти в Настройки',
    'palette.action.gotoPlaylists': 'Перейти в Плейлисты',
    'palette.action.gotoFavorites': 'Перейти в Избранное',
    'label.unknownArtist': 'Неизвестный исполнитель',
    'label.noAlbum': 'Без альбома',
    'label.tracksShort': 'тр.',
    'error.deleteFile': 'Не удалось удалить файл с диска: ',
    'error.unknown': 'неизвестная ошибка',
    'downloads.tab.queue': 'Очередь',
    'downloads.queue.add': 'В очередь',
    'downloads.queue.queued': 'В очереди',
    'downloads.queue.addAll': 'Все треки в очередь',
    'downloads.queue.remove': 'Убрать из очереди',
    'downloads.queue.clearDone': 'Очистить завершённые',
    'downloads.queue.clearAll': 'Очистить всё',
    'downloads.queue.empty.title': 'Очередь пуста',
    'downloads.queue.empty.text': 'Добавьте треки в очередь со вкладки «Парсинг», и они начнут скачиваться один за другим.',
    'downloads.queue.status.queued': 'Ожидает',
    'downloads.queue.status.downloading': 'Скачивается',
    'downloads.queue.status.done': 'Готово',
    'downloads.queue.status.error': 'Ошибка',
    'downloads.queue.stats.downloading': 'качается: {n}',
    'downloads.queue.stats.queued': 'в очереди: {n}',
    'downloads.queue.stats.done': 'готово: {n}',
    'downloads.queue.stats.error': 'ошибок: {n}',
    'downloads.queue.stats.paused': 'на паузе',
    'downloads.queue.pause': 'Пауза',
    'downloads.queue.resume': 'Продолжить',
  },
  en: {
    'nav.library': 'Library',
    'update.available': 'Update available',
    'update.download': 'Download',
    'update.dismiss': 'Dismiss',
    'nav.artists': 'Artists',
    'nav.playlists': 'Playlists',
    'nav.favorites': 'Favorites',
    'nav.downloads': 'Downloads',
    'nav.search': 'Search',
    'nav.recents': 'Recent',
    'nav.openFiles': 'Open files',
    'nav.settings': 'Settings',
    'crumb.collection': 'Collection',
    'search.placeholder': 'Search…',
    'search.artistPlaceholder': 'Search artist…',
    'search.trackPlaceholder': 'Search track…',
    'filter.all': 'All',
    'filter.recent': 'Recently added',
    'filter.favorites': 'Favorites only',
    'sort.label': 'Sort:',
    'sort.dateDesc': 'Date added ↓',
    'sort.dateAsc': 'Date added ↑',
    'sort.titleAsc': 'Title A→Z',
    'sort.titleDesc': 'Title Z→A',
    'sort.artistAsc': 'Artist A→Z',
    'sort.artistDesc': 'Artist Z→A',
    'sort.durationAsc': 'Duration ↑',
    'sort.durationDesc': 'Duration ↓',
    'sort.alpha': 'Alphabetical',
    'sort.byTracks': 'By track count',
    'sort.recent': 'Recently added',
    'table.title': 'Title',
    'table.artist': 'Artist',
    'table.album': 'Album',
    'table.time': 'Time',
    'empty.library.title': 'Library is empty',
    'empty.library.text': 'Open files or a folder to get started.',
    'empty.playlists.title': 'No playlists yet',
    'empty.playlists.text': 'Create your first playlist — gather tracks by mood, time of day, or album.',
    'empty.artists.title': 'No artists yet',
    'empty.artists.text': 'Add tracks to the library to see artists here.',
    'empty.favorites.title': 'No favorite tracks',
    'empty.favorites.text': 'Click the heart on any track to add it here.',
    'btn.newPlaylist': 'New playlist',
    'btn.playAll': 'Play all',
    'btn.shuffle': 'Shuffle',
    'btn.deletePlaylist': 'Delete playlist',
    'btn.choose': 'Choose…',
    'btn.cancel': 'Cancel',
    'btn.delete': 'Delete',
    'btn.create': 'Create',
    'btn.close': 'Close',
    'btn.save': 'Save',
    'btn.minimize': 'Minimize',
    'btn.portrait': 'Mobile mode',
    'btn.album': 'Album',
    'btn.favorite': 'Favorite',
    'btn.unfavorite': 'Remove from favorites',
    'btn.favoriteOn': 'Favorited',
    'btn.addToPlaylist': 'Add to playlist',
    'tooltip.favorite': 'Favorite',
    'tooltip.shuffle': 'Shuffle',
    'tooltip.prev': 'Previous',
    'tooltip.playPause': 'Play / Pause',
    'tooltip.next': 'Next',
    'tooltip.repeat': 'Repeat',
    'tooltip.fullscreen': 'Fullscreen',
    'tooltip.volume': 'Volume',
    'tooltip.wip': 'Feature in development',
    'hint.favorites': 'Saved tracks appear here',
    'eyebrow.playlist': 'Playlist',
    'eyebrow.artist': 'Artist',
    'autoChip.artists': 'List is built automatically from your library',
    'np.empty.title': 'Nothing selected',
    'np.empty.artist': '—',
    'fs.nowPlayingFrom': 'Now playing · from',
    'fs.fromLibrary': 'Library',
    'fs.nowPlaying': 'Now playing',
    'fs.queue': 'Queue',
    'fs.queueAhead': '{n} ahead',
    'downloads.tab.internet': 'From the internet',
    'downloads.tab.parsing': 'Parsing',
    'downloads.title': 'Download from the internet',
    'downloads.subtitle': 'The ability to save tracks by direct link will appear here. Section in development.',
    'downloads.parsing.title': 'Parsing',
    'downloads.parsing.subtitle': 'The ability to collect tracks by parsing pages will appear here. Section in development.',
    'downloads.yt.placeholder': 'Track name or "artist — track"',
    'downloads.yt.search': 'Search',
    'downloads.yt.hint': 'YouTube search · shows multiple options so you can pick the right one.',
    'downloads.yt.col.title': 'Title',
    'downloads.yt.col.channel': 'Channel',
    'downloads.yt.col.duration': 'Dur.',
    'downloads.yt.idle.title': 'Find a track on YouTube',
    'downloads.yt.idle.text': 'Enter a name — a list of downloadable mp3 files will appear below. Files are saved to your default folder (if set in Settings) or to "Audex Downloads", and added to your library.',
    'downloads.yt.searching': 'Searching: "{q}"…',
    'downloads.yt.empty': 'Nothing found for "{q}".',
    'downloads.yt.error': 'Search error: {e}',
    'downloads.yt.action.download': 'Download',
    'downloads.yt.action.downloading': 'Downloading…',
    'downloads.yt.action.done': 'Done',
    'downloads.yt.action.retry': 'Retry',
    'downloads.yt.downloadError': 'Failed: {e}',
    'downloads.yt.downloadOk': 'Downloaded and added to library: {t}',
    'downloads.yt.tagNote': 'After downloading, you may need to manually fix the MP3 tags (title, artist, cover) via the track context menu.',
    'downloads.parsing.subtab.yandex': 'Yandex Music',
    'downloads.parsing.urlPlaceholder': 'https://music.yandex.com/playlists/…',
    'downloads.parsing.start': 'Parse',
    'downloads.parsing.hint': 'Paste a playlist or album link. Parsing runs in the background.',
    'downloads.parsing.col.artist': 'Artist',
    'downloads.parsing.col.title': 'Title',
    'downloads.parsing.col.duration': 'Dur.',
    'downloads.parsing.idle.title': 'Parse Yandex Music',
    'downloads.parsing.idle.text': 'Paste a playlist or album link from Yandex Music. The app will collect the track list in the background, and let you download any of them in one click.',
    'downloads.parsing.starting': 'Starting parser…',
    'downloads.parsing.done': 'Done — {n} tracks collected',
    'downloads.parsing.error': 'Parsing error: {e}',
    'settings.title': 'Settings',
    'settings.subtitle': 'Appearance, music sources, and app behavior.',
    'section.appearance': 'Appearance',
    'section.music': 'Music',
    'section.downloads': 'Download from the internet',
    'section.language': 'Language',
    'section.about': 'About',
    'section.contacts': 'Contacts',
    'setting.github': 'GitHub',
    'setting.githubDesc': 'Project source code on GitHub.',
    'setting.telegram': 'Telegram',
    'setting.telegramDesc': 'Found a bug or have a suggestion — write on Telegram.',
    'theme.dark': 'Dark',
    'theme.light': 'Light',
    'theme.system': 'System',
    'setting.theme': 'Theme',
    'setting.themeDesc': 'Application color scheme.',
    'setting.accent': 'Accent color',
    'setting.accentDesc': 'Highlights active items and the currently playing track.',
    'setting.accentDefault': 'Default',
    'setting.accentCustom': 'Custom color',
    'setting.defaultFolder': 'Default folder',
    'setting.defaultFolderDesc': 'Where to load tracks from on startup.',
    'setting.uiScale': 'Interface scale',
    'setting.uiScaleDesc': 'Makes the entire UI larger or smaller. Applies instantly.',
    'setting.uiScaleReset': 'Reset',
    'setting.scanSubdirs': 'Scan subfolders',
    'setting.scanSubdirsDesc': 'Include nested directories during indexing.',
    'setting.showDownloads': 'Show the “Downloads” tab',
    'setting.showDownloadsDesc': 'Adds a section to the sidebar for downloading tracks by URL.',
    'setting.showParserBrowser': 'Show the browser window while parsing',
    'setting.showParserBrowserDesc': 'Useful for signing in to Yandex on the first run, solving a captcha, or seeing where the parser got stuck. Turn off to run the browser silently in the background.',
    'section.system': 'System',
    'setting.hardwareAcceleration': 'Hardware acceleration',
    'setting.hardwareAccelerationDesc': 'Uses the GPU to render the interface. If the app hangs on launch or shows graphical glitches, turn this off. Takes effect after a restart.',
    'setting.uiLanguage': 'Interface language',
    'setting.uiLanguageDesc': 'Applied immediately.',
    'setting.version': 'Version',
    'badge.wip': 'in development',
    'placeholder.noFolder': '— not selected —',
    'modal.deleteTrack.title': 'Delete track?',
    'modal.deleteTrack.text': 'The track will be removed from the library and the file moved to the trash.',
    'modal.deleteTrackFull.text': '“{title}” by {artist} will be removed from the library and the file moved to the trash.',
    'modal.deletePlaylist.title': 'Delete playlist?',
    'modal.deletePlaylist.text': 'Playlist “{name}” will be deleted. Tracks remain in the library.',
    'modal.newPlaylist.title': 'New playlist',
    'modal.newPlaylist.namePh': 'Playlist name',
    'modal.newPlaylist.descPh': 'Description (optional)',
    'modal.addToPlaylist.title': 'Add to playlist',
    'modal.addToPlaylist.empty': 'Create a playlist on the “Playlists” tab first.',
    'modal.addToPlaylist.alreadyAdded': 'already added',
    'editor.title': 'Edit tags',
    'editor.cover': 'Cover',
    'editor.field.title': 'Title',
    'editor.field.artist': 'Artist',
    'editor.field.album': 'Album',
    'editor.field.albumArtist': 'Album artist',
    'editor.field.year': 'Year',
    'editor.field.genre': 'Genre',
    'editor.field.trackNo': 'Track №',
    'editor.field.discNo': 'Disc №',
    'editor.field.comment': 'Comment',
    'editor.commentPh': 'Note about the track…',
    'editor.coverEmbed': 'Embedded cover',
    'editor.noCover': 'No cover',
    'editor.saving': 'Saving…',
    'editor.saved': 'Saved ✓',
    'editor.errorSave': 'Save error',
    'cm.play': 'Play',
    'cm.addToPlaylist': 'Add to playlist',
    'cm.removeFromPlaylist': 'Remove from playlist',
    'cm.reveal': 'Show in folder',
    'cm.editTags': 'Edit tags…',
    'cm.delete': 'Remove from library',
    'palette.placeholder': 'Search tracks, albums, actions…',
    'palette.nav': '↑↓ navigate',
    'palette.choose': '↵ select',
    'palette.close': 'ESC close',
    'palette.tracks': 'Tracks',
    'palette.actions': 'Actions',
    'palette.itemHint': '↵ play',
    'palette.empty': 'Nothing found',
    'palette.action.openFiles': 'Open files…',
    'palette.action.gotoSettings': 'Go to Settings',
    'palette.action.gotoPlaylists': 'Go to Playlists',
    'palette.action.gotoFavorites': 'Go to Favorites',
    'label.unknownArtist': 'Unknown artist',
    'label.noAlbum': 'No album',
    'label.tracksShort': 'tr.',
    'error.deleteFile': 'Could not delete file from disk: ',
    'error.unknown': 'unknown error',
    'downloads.tab.queue': 'Queue',
    'downloads.queue.add': 'Queue',
    'downloads.queue.queued': 'Queued',
    'downloads.queue.addAll': 'Queue all tracks',
    'downloads.queue.remove': 'Remove from queue',
    'downloads.queue.clearDone': 'Clear finished',
    'downloads.queue.clearAll': 'Clear all',
    'downloads.queue.empty.title': 'Queue is empty',
    'downloads.queue.empty.text': 'Add tracks from the Parsing tab and they will be downloaded one after another.',
    'downloads.queue.status.queued': 'Waiting',
    'downloads.queue.status.downloading': 'Downloading',
    'downloads.queue.status.done': 'Done',
    'downloads.queue.status.error': 'Failed',
    'downloads.queue.stats.downloading': 'downloading: {n}',
    'downloads.queue.stats.queued': 'queued: {n}',
    'downloads.queue.stats.done': 'done: {n}',
    'downloads.queue.stats.error': 'errors: {n}',
    'downloads.queue.stats.paused': 'paused',
    'downloads.queue.pause': 'Pause',
    'downloads.queue.resume': 'Resume',
  },
  de: {
    'nav.library': 'Bibliothek',
    'update.available': 'Update verfügbar',
    'update.download': 'Herunterladen',
    'update.dismiss': 'Schließen',
    'nav.artists': 'Interpreten',
    'nav.playlists': 'Playlists',
    'nav.favorites': 'Favoriten',
    'nav.downloads': 'Downloads',
    'nav.search': 'Suche',
    'nav.recents': 'Zuletzt',
    'nav.openFiles': 'Dateien öffnen',
    'nav.settings': 'Einstellungen',
    'crumb.collection': 'Sammlung',
    'search.placeholder': 'Suche…',
    'search.artistPlaceholder': 'Interpreten suchen…',
    'search.trackPlaceholder': 'Titel suchen…',
    'filter.all': 'Alle',
    'filter.recent': 'Kürzlich hinzugefügt',
    'filter.favorites': 'Nur Favoriten',
    'sort.label': 'Sortierung:',
    'sort.dateDesc': 'Hinzugefügt ↓',
    'sort.dateAsc': 'Hinzugefügt ↑',
    'sort.titleAsc': 'Titel A→Z',
    'sort.titleDesc': 'Titel Z→A',
    'sort.artistAsc': 'Interpret A→Z',
    'sort.artistDesc': 'Interpret Z→A',
    'sort.durationAsc': 'Dauer ↑',
    'sort.durationDesc': 'Dauer ↓',
    'sort.alpha': 'Alphabetisch',
    'sort.byTracks': 'Nach Titelanzahl',
    'sort.recent': 'Kürzlich hinzugefügt',
    'table.title': 'Titel',
    'table.artist': 'Interpret',
    'table.album': 'Album',
    'table.time': 'Zeit',
    'empty.library.title': 'Bibliothek ist leer',
    'empty.library.text': 'Öffne Dateien oder einen Ordner, um zu beginnen.',
    'empty.playlists.title': 'Noch keine Playlists',
    'empty.playlists.text': 'Erstelle deine erste Playlist — sammle Titel nach Stimmung, Tageszeit oder Album.',
    'empty.artists.title': 'Noch keine Interpreten',
    'empty.artists.text': 'Füge Titel zur Bibliothek hinzu, um hier Interpreten zu sehen.',
    'empty.favorites.title': 'Keine Favoriten',
    'empty.favorites.text': 'Tippe auf das Herz eines Titels, um ihn hier hinzuzufügen.',
    'btn.newPlaylist': 'Neue Playlist',
    'btn.playAll': 'Alle abspielen',
    'btn.shuffle': 'Zufall',
    'btn.deletePlaylist': 'Playlist löschen',
    'btn.choose': 'Auswählen…',
    'btn.cancel': 'Abbrechen',
    'btn.delete': 'Löschen',
    'btn.create': 'Erstellen',
    'btn.close': 'Schließen',
    'btn.save': 'Speichern',
    'btn.minimize': 'Minimieren',
    'btn.portrait': 'Mobiler Modus',
    'btn.album': 'Album',
    'btn.favorite': 'Zu Favoriten',
    'btn.unfavorite': 'Aus Favoriten entfernen',
    'btn.favoriteOn': 'In Favoriten',
    'btn.addToPlaylist': 'Zur Playlist',
    'tooltip.favorite': 'Zu Favoriten',
    'tooltip.shuffle': 'Zufällige Reihenfolge',
    'tooltip.prev': 'Vorheriger',
    'tooltip.playPause': 'Wiedergabe / Pause',
    'tooltip.next': 'Nächster',
    'tooltip.repeat': 'Wiederholen',
    'tooltip.fullscreen': 'Vollbild',
    'tooltip.volume': 'Lautstärke',
    'tooltip.wip': 'Funktion in Entwicklung',
    'hint.favorites': 'Gespeicherte Titel erscheinen hier',
    'eyebrow.playlist': 'Playlist',
    'eyebrow.artist': 'Interpret',
    'autoChip.artists': 'Die Liste wird automatisch aus deiner Bibliothek erstellt',
    'np.empty.title': 'Nichts ausgewählt',
    'np.empty.artist': '—',
    'fs.nowPlayingFrom': 'Wird abgespielt · aus',
    'fs.fromLibrary': 'Bibliothek',
    'fs.nowPlaying': 'Wird abgespielt',
    'fs.queue': 'Warteschlange',
    'fs.queueAhead': '{n} folgen',
    'downloads.tab.internet': 'Aus dem Internet',
    'downloads.tab.parsing': 'Parsing',
    'downloads.title': 'Aus dem Internet herunterladen',
    'downloads.subtitle': 'Hier wird es möglich sein, Titel per Direktlink zu speichern. Bereich in Entwicklung.',
    'downloads.parsing.title': 'Parsing',
    'downloads.parsing.subtitle': 'Hier wird es möglich sein, Titel durch Parsen von Seiten zu sammeln. Bereich in Entwicklung.',
    'downloads.yt.placeholder': 'Titel oder „Interpret — Titel"',
    'downloads.yt.search': 'Suchen',
    'downloads.yt.hint': 'YouTube-Suche · zeigt mehrere Treffer zur Auswahl.',
    'downloads.yt.col.title': 'Titel',
    'downloads.yt.col.channel': 'Kanal',
    'downloads.yt.col.duration': 'Dauer',
    'downloads.yt.idle.title': 'Titel auf YouTube finden',
    'downloads.yt.idle.text': 'Gib einen Namen ein — unten erscheint eine Liste herunterladbarer mp3-Dateien. Dateien werden im Standardordner (falls in den Einstellungen festgelegt) oder in „Audex Downloads" gespeichert und zur Bibliothek hinzugefügt.',
    'downloads.yt.searching': 'Suche: „{q}"…',
    'downloads.yt.empty': 'Nichts gefunden zu „{q}".',
    'downloads.yt.error': 'Suchfehler: {e}',
    'downloads.yt.action.download': 'Herunterladen',
    'downloads.yt.action.downloading': 'Lädt…',
    'downloads.yt.action.done': 'Fertig',
    'downloads.yt.action.retry': 'Erneut',
    'downloads.yt.downloadError': 'Fehlgeschlagen: {e}',
    'downloads.yt.downloadOk': 'Heruntergeladen und zur Bibliothek hinzugefügt: {t}',
    'downloads.yt.tagNote': 'Nach dem Download müssen die MP3-Tags (Titel, Interpret, Cover) eventuell manuell über das Kontextmenü des Titels angepasst werden.',
    'downloads.parsing.subtab.yandex': 'Yandex Music',
    'downloads.parsing.urlPlaceholder': 'https://music.yandex.com/playlists/…',
    'downloads.parsing.start': 'Parsen',
    'downloads.parsing.hint': 'Fügen Sie einen Playlist- oder Albumlink ein. Der Parser läuft im Hintergrund.',
    'downloads.parsing.col.artist': 'Interpret',
    'downloads.parsing.col.title': 'Titel',
    'downloads.parsing.col.duration': 'Dauer',
    'downloads.parsing.idle.title': 'Yandex Music parsen',
    'downloads.parsing.idle.text': 'Füge einen Playlist- oder Album-Link von Yandex Music ein. Die App sammelt die Titelliste im Hintergrund, und du kannst jeden mit einem Klick herunterladen.',
    'downloads.parsing.starting': 'Parser wird gestartet…',
    'downloads.parsing.done': 'Fertig — {n} Titel gesammelt',
    'downloads.parsing.error': 'Parsing-Fehler: {e}',
    'settings.title': 'Einstellungen',
    'settings.subtitle': 'Aussehen, Musikquellen und App-Verhalten.',
    'section.appearance': 'Aussehen',
    'section.music': 'Musik',
    'section.downloads': 'Aus dem Internet herunterladen',
    'section.language': 'Sprache',
    'section.about': 'Über die App',
    'section.contacts': 'Kontakte',
    'setting.github': 'GitHub',
    'setting.githubDesc': 'Quellcode des Projekts auf GitHub.',
    'setting.telegram': 'Telegram',
    'setting.telegramDesc': 'Bug gefunden oder Vorschlag — schreib auf Telegram.',
    'theme.dark': 'Dunkel',
    'theme.light': 'Hell',
    'theme.system': 'System',
    'setting.theme': 'Design',
    'setting.themeDesc': 'Farbschema der Anwendung.',
    'setting.accent': 'Akzentfarbe',
    'setting.accentDesc': 'Hervorhebung aktiver Elemente und des aktuellen Titels.',
    'setting.accentDefault': 'Standard',
    'setting.accentCustom': 'Eigene Farbe',
    'setting.defaultFolder': 'Standardordner',
    'setting.defaultFolderDesc': 'Woher Titel beim Start geladen werden.',
    'setting.uiScale': 'Oberflächenskalierung',
    'setting.uiScaleDesc': 'Vergrößert oder verkleinert die gesamte Oberfläche. Wird sofort angewendet.',
    'setting.uiScaleReset': 'Zurücksetzen',
    'setting.scanSubdirs': 'Unterordner durchsuchen',
    'setting.scanSubdirsDesc': 'Verschachtelte Verzeichnisse beim Indizieren einbeziehen.',
    'setting.showDownloads': 'Tab „Downloads“ anzeigen',
    'setting.showDownloadsDesc': 'Öffnet einen Bereich in der Seitenleiste zum Herunterladen von Titeln per URL.',
    'setting.showParserBrowser': 'Browserfenster beim Parsen anzeigen',
    'setting.showParserBrowserDesc': 'Nützlich, um sich beim ersten Start bei Yandex anzumelden, ein Captcha zu lösen oder zu sehen, wo der Parser hängengeblieben ist. Ausschalten, damit der Browser unsichtbar im Hintergrund läuft.',
    'section.system': 'System',
    'setting.hardwareAcceleration': 'Hardwarebeschleunigung',
    'setting.hardwareAccelerationDesc': 'Nutzt die Grafikkarte zum Rendern der Oberfläche. Wenn die App beim Start hängt oder Grafikfehler zeigt, schalten Sie sie aus. Wird nach einem Neustart wirksam.',
    'setting.uiLanguage': 'Sprache der Oberfläche',
    'setting.uiLanguageDesc': 'Wird sofort angewendet.',
    'setting.version': 'Version',
    'badge.wip': 'in Entwicklung',
    'placeholder.noFolder': '— nicht ausgewählt —',
    'modal.deleteTrack.title': 'Titel löschen?',
    'modal.deleteTrack.text': 'Der Titel wird aus der Bibliothek entfernt und die Datei in den Papierkorb verschoben.',
    'modal.deleteTrackFull.text': '„{title}“ von {artist} wird aus der Bibliothek entfernt und die Datei in den Papierkorb verschoben.',
    'modal.deletePlaylist.title': 'Playlist löschen?',
    'modal.deletePlaylist.text': 'Playlist „{name}“ wird gelöscht. Titel bleiben in der Bibliothek.',
    'modal.newPlaylist.title': 'Neue Playlist',
    'modal.newPlaylist.namePh': 'Playlist-Name',
    'modal.newPlaylist.descPh': 'Beschreibung (optional)',
    'modal.addToPlaylist.title': 'Zur Playlist hinzufügen',
    'modal.addToPlaylist.empty': 'Erstelle zuerst eine Playlist im Tab „Playlists“.',
    'modal.addToPlaylist.alreadyAdded': 'bereits hinzugefügt',
    'editor.title': 'Tags bearbeiten',
    'editor.cover': 'Cover',
    'editor.field.title': 'Titel',
    'editor.field.artist': 'Interpret',
    'editor.field.album': 'Album',
    'editor.field.albumArtist': 'Album-Interpret',
    'editor.field.year': 'Jahr',
    'editor.field.genre': 'Genre',
    'editor.field.trackNo': 'Titel-Nr.',
    'editor.field.discNo': 'CD-Nr.',
    'editor.field.comment': 'Kommentar',
    'editor.commentPh': 'Notiz zum Titel…',
    'editor.coverEmbed': 'Eingebettetes Cover',
    'editor.noCover': 'Kein Cover',
    'editor.saving': 'Speichern…',
    'editor.saved': 'Gespeichert ✓',
    'editor.errorSave': 'Speicherfehler',
    'cm.play': 'Abspielen',
    'cm.addToPlaylist': 'Zur Playlist hinzufügen',
    'cm.removeFromPlaylist': 'Aus Playlist entfernen',
    'cm.reveal': 'Im Ordner anzeigen',
    'cm.editTags': 'Tags bearbeiten…',
    'cm.delete': 'Aus Bibliothek entfernen',
    'palette.placeholder': 'Suche Titel, Alben, Aktionen…',
    'palette.nav': '↑↓ Navigation',
    'palette.choose': '↵ auswählen',
    'palette.close': 'ESC schließen',
    'palette.tracks': 'Titel',
    'palette.actions': 'Aktionen',
    'palette.itemHint': '↵ abspielen',
    'palette.empty': 'Nichts gefunden',
    'palette.action.openFiles': 'Dateien öffnen…',
    'palette.action.gotoSettings': 'Zu den Einstellungen',
    'palette.action.gotoPlaylists': 'Zu den Playlists',
    'palette.action.gotoFavorites': 'Zu den Favoriten',
    'label.unknownArtist': 'Unbekannter Interpret',
    'label.noAlbum': 'Ohne Album',
    'label.tracksShort': 'Tit.',
    'error.deleteFile': 'Datei konnte nicht gelöscht werden: ',
    'error.unknown': 'unbekannter Fehler',
    'downloads.tab.queue': 'Warteschlange',
    'downloads.queue.add': 'In Warteschlange',
    'downloads.queue.queued': 'In Warteschlange',
    'downloads.queue.addAll': 'Alle in die Warteschlange',
    'downloads.queue.remove': 'Aus Warteschlange entfernen',
    'downloads.queue.clearDone': 'Fertige entfernen',
    'downloads.queue.clearAll': 'Alle entfernen',
    'downloads.queue.empty.title': 'Warteschlange ist leer',
    'downloads.queue.empty.text': 'Füge Titel im Tab „Parsen" hinzu — sie werden nacheinander heruntergeladen.',
    'downloads.queue.status.queued': 'Wartet',
    'downloads.queue.status.downloading': 'Lädt',
    'downloads.queue.status.done': 'Fertig',
    'downloads.queue.status.error': 'Fehler',
    'downloads.queue.stats.downloading': 'lädt: {n}',
    'downloads.queue.stats.queued': 'wartet: {n}',
    'downloads.queue.stats.done': 'fertig: {n}',
    'downloads.queue.stats.error': 'Fehler: {n}',
    'downloads.queue.stats.paused': 'pausiert',
    'downloads.queue.pause': 'Pause',
    'downloads.queue.resume': 'Fortsetzen',
  },
  fr: {
    'nav.library': 'Bibliothèque',
    'update.available': 'Mise à jour disponible',
    'update.download': 'Télécharger',
    'update.dismiss': 'Fermer',
    'nav.artists': 'Artistes',
    'nav.playlists': 'Playlists',
    'nav.favorites': 'Favoris',
    'nav.downloads': 'Téléchargements',
    'nav.search': 'Recherche',
    'nav.recents': 'Récents',
    'nav.openFiles': 'Ouvrir des fichiers',
    'nav.settings': 'Paramètres',
    'crumb.collection': 'Collection',
    'search.placeholder': 'Recherche…',
    'search.artistPlaceholder': 'Rechercher un artiste…',
    'search.trackPlaceholder': 'Rechercher une piste…',
    'filter.all': 'Tout',
    'filter.recent': 'Récemment ajoutés',
    'filter.favorites': 'Favoris uniquement',
    'sort.label': 'Tri :',
    'sort.dateDesc': "Date d'ajout ↓",
    'sort.dateAsc': "Date d'ajout ↑",
    'sort.titleAsc': 'Titre A→Z',
    'sort.titleDesc': 'Titre Z→A',
    'sort.artistAsc': 'Artiste A→Z',
    'sort.artistDesc': 'Artiste Z→A',
    'sort.durationAsc': 'Durée ↑',
    'sort.durationDesc': 'Durée ↓',
    'sort.alpha': 'Alphabétique',
    'sort.byTracks': 'Par nombre de pistes',
    'sort.recent': 'Récemment ajoutés',
    'table.title': 'Titre',
    'table.artist': 'Artiste',
    'table.album': 'Album',
    'table.time': 'Durée',
    'empty.library.title': 'Bibliothèque vide',
    'empty.library.text': 'Ouvre des fichiers ou un dossier pour commencer.',
    'empty.playlists.title': 'Aucune playlist pour le moment',
    'empty.playlists.text': "Crée ta première playlist — rassemble des pistes par humeur, moment de la journée ou album.",
    'empty.artists.title': "Aucun artiste pour l'instant",
    'empty.artists.text': 'Ajoute des pistes à la bibliothèque pour voir des artistes ici.',
    'empty.favorites.title': 'Aucune piste favorite',
    'empty.favorites.text': "Clique sur le cœur d'une piste pour l'ajouter ici.",
    'btn.newPlaylist': 'Nouvelle playlist',
    'btn.playAll': 'Tout lire',
    'btn.shuffle': 'Aléatoire',
    'btn.deletePlaylist': 'Supprimer la playlist',
    'btn.choose': 'Choisir…',
    'btn.cancel': 'Annuler',
    'btn.delete': 'Supprimer',
    'btn.create': 'Créer',
    'btn.close': 'Fermer',
    'btn.save': 'Enregistrer',
    'btn.minimize': 'Réduire',
    'btn.portrait': 'Mode mobile',
    'btn.album': 'Album',
    'btn.favorite': 'Ajouter aux favoris',
    'btn.unfavorite': 'Retirer des favoris',
    'btn.favoriteOn': 'Dans les favoris',
    'btn.addToPlaylist': 'À la playlist',
    'tooltip.favorite': 'Ajouter aux favoris',
    'tooltip.shuffle': 'Ordre aléatoire',
    'tooltip.prev': 'Précédent',
    'tooltip.playPause': 'Lecture / Pause',
    'tooltip.next': 'Suivant',
    'tooltip.repeat': 'Répéter',
    'tooltip.fullscreen': 'Plein écran',
    'tooltip.volume': 'Volume',
    'tooltip.wip': 'Fonctionnalité en développement',
    'hint.favorites': 'Les pistes enregistrées apparaissent ici',
    'eyebrow.playlist': 'Playlist',
    'eyebrow.artist': 'Artiste',
    'autoChip.artists': 'La liste est générée automatiquement depuis ta bibliothèque',
    'np.empty.title': 'Rien de sélectionné',
    'np.empty.artist': '—',
    'fs.nowPlayingFrom': 'En cours de lecture · depuis',
    'fs.fromLibrary': 'la Bibliothèque',
    'fs.nowPlaying': 'En cours de lecture',
    'fs.queue': 'File',
    'fs.queueAhead': '{n} à venir',
    'downloads.tab.internet': "Depuis Internet",
    'downloads.tab.parsing': 'Analyse',
    'downloads.title': "Téléchargement depuis Internet",
    'downloads.subtitle': "La possibilité d'enregistrer des pistes via un lien direct apparaîtra ici. Section en développement.",
    'downloads.parsing.title': 'Analyse',
    'downloads.parsing.subtitle': "La possibilité de collecter des pistes en analysant des pages apparaîtra ici. Section en développement.",
    'downloads.yt.placeholder': "Nom de la piste ou « artiste — piste »",
    'downloads.yt.search': 'Rechercher',
    'downloads.yt.hint': 'Recherche YouTube · affiche plusieurs résultats au choix.',
    'downloads.yt.col.title': 'Titre',
    'downloads.yt.col.channel': 'Chaîne',
    'downloads.yt.col.duration': 'Durée',
    'downloads.yt.idle.title': 'Trouvez une piste sur YouTube',
    'downloads.yt.idle.text': "Entrez un nom — la liste des mp3 téléchargeables apparaîtra ci-dessous. Les fichiers sont enregistrés dans votre dossier par défaut (s'il est défini dans les paramètres) ou dans « Audex Downloads », et ajoutés à votre bibliothèque.",
    'downloads.yt.searching': 'Recherche : « {q} »…',
    'downloads.yt.empty': 'Aucun résultat pour « {q} ».',
    'downloads.yt.error': 'Erreur de recherche : {e}',
    'downloads.yt.action.download': 'Télécharger',
    'downloads.yt.action.downloading': 'Téléchargement…',
    'downloads.yt.action.done': 'Terminé',
    'downloads.yt.action.retry': 'Réessayer',
    'downloads.yt.downloadError': 'Échec : {e}',
    'downloads.yt.downloadOk': 'Téléchargé et ajouté à la bibliothèque : {t}',
    'downloads.yt.tagNote': "Après le téléchargement, il peut être nécessaire de corriger manuellement les tags MP3 (titre, artiste, pochette) via le menu contextuel de la piste.",
    'downloads.parsing.subtab.yandex': 'Yandex Music',
    'downloads.parsing.urlPlaceholder': 'https://music.yandex.com/playlists/…',
    'downloads.parsing.start': 'Analyser',
    'downloads.parsing.hint': "Collez un lien de playlist ou d'album. L'analyse s'exécute en arrière-plan.",
    'downloads.parsing.col.artist': 'Artiste',
    'downloads.parsing.col.title': 'Titre',
    'downloads.parsing.col.duration': 'Durée',
    'downloads.parsing.idle.title': 'Analyser Yandex Music',
    'downloads.parsing.idle.text': "Collez un lien de playlist ou d'album depuis Yandex Music. L'app récupérera la liste des pistes en arrière-plan, et vous pourrez en télécharger n'importe laquelle en un clic.",
    'downloads.parsing.starting': "Démarrage de l'analyseur…",
    'downloads.parsing.done': 'Terminé — {n} pistes collectées',
    'downloads.parsing.error': "Erreur d'analyse : {e}",
    'settings.title': 'Paramètres',
    'settings.subtitle': "Apparence, sources musicales et comportement de l'application.",
    'section.appearance': 'Apparence',
    'section.music': 'Musique',
    'section.downloads': "Téléchargement depuis Internet",
    'section.language': 'Langue',
    'section.about': "À propos",
    'section.contacts': 'Contacts',
    'setting.github': 'GitHub',
    'setting.githubDesc': 'Code source du projet sur GitHub.',
    'setting.telegram': 'Telegram',
    'setting.telegramDesc': "Trouvé un bug ou une suggestion — écrivez sur Telegram.",
    'theme.dark': 'Sombre',
    'theme.light': 'Clair',
    'theme.system': 'Système',
    'setting.theme': 'Thème',
    'setting.themeDesc': 'Schéma de couleurs de l’application.',
    'setting.accent': 'Couleur d’accent',
    'setting.accentDesc': 'Met en évidence les éléments actifs et le morceau en cours.',
    'setting.accentDefault': 'Par défaut',
    'setting.accentCustom': 'Couleur personnalisée',
    'setting.defaultFolder': 'Dossier par défaut',
    'setting.defaultFolderDesc': "D'où charger les pistes au démarrage.",
    'setting.uiScale': "Échelle de l'interface",
    'setting.uiScaleDesc': "Agrandit ou réduit toute l'interface. Appliqué immédiatement.",
    'setting.uiScaleReset': 'Réinitialiser',
    'setting.scanSubdirs': 'Analyser les sous-dossiers',
    'setting.scanSubdirsDesc': "Inclure les répertoires imbriqués lors de l'indexation.",
    'setting.showDownloads': "Afficher l'onglet « Téléchargements »",
    'setting.showDownloadsDesc': 'Ajoute une section à la barre latérale pour télécharger des pistes par URL.',
    'setting.showParserBrowser': "Afficher la fenêtre du navigateur pendant l'analyse",
    'setting.showParserBrowserDesc': "Utile pour se connecter à Yandex au premier lancement, résoudre un captcha ou voir où l'analyseur s'est bloqué. Désactivez pour exécuter le navigateur silencieusement en arrière-plan.",
    'section.system': 'Système',
    'setting.hardwareAcceleration': 'Accélération matérielle',
    'setting.hardwareAccelerationDesc': "Utilise la carte graphique pour afficher l'interface. Si l'application se bloque au démarrage ou présente des artefacts graphiques, désactivez-la. Prend effet après un redémarrage.",
    'setting.uiLanguage': "Langue de l'interface",
    'setting.uiLanguageDesc': 'Appliquée immédiatement.',
    'setting.version': 'Version',
    'badge.wip': 'en développement',
    'placeholder.noFolder': '— non sélectionné —',
    'modal.deleteTrack.title': 'Supprimer la piste ?',
    'modal.deleteTrack.text': 'La piste sera retirée de la bibliothèque et le fichier déplacé vers la corbeille.',
    'modal.deleteTrackFull.text': '« {title} » de {artist} sera retirée de la bibliothèque et le fichier déplacé vers la corbeille.',
    'modal.deletePlaylist.title': 'Supprimer la playlist ?',
    'modal.deletePlaylist.text': 'La playlist « {name} » sera supprimée. Les pistes restent dans la bibliothèque.',
    'modal.newPlaylist.title': 'Nouvelle playlist',
    'modal.newPlaylist.namePh': 'Nom de la playlist',
    'modal.newPlaylist.descPh': 'Description (facultatif)',
    'modal.addToPlaylist.title': 'Ajouter à la playlist',
    'modal.addToPlaylist.empty': "Crée d'abord une playlist dans l'onglet « Playlists ».",
    'modal.addToPlaylist.alreadyAdded': 'déjà ajoutée',
    'editor.title': 'Modifier les tags',
    'editor.cover': 'Pochette',
    'editor.field.title': 'Titre',
    'editor.field.artist': 'Artiste',
    'editor.field.album': 'Album',
    'editor.field.albumArtist': "Artiste de l'album",
    'editor.field.year': 'Année',
    'editor.field.genre': 'Genre',
    'editor.field.trackNo': 'Piste №',
    'editor.field.discNo': 'Disque №',
    'editor.field.comment': 'Commentaire',
    'editor.commentPh': 'Note sur la piste…',
    'editor.coverEmbed': 'Pochette intégrée',
    'editor.noCover': 'Pas de pochette',
    'editor.saving': 'Enregistrement…',
    'editor.saved': 'Enregistré ✓',
    'editor.errorSave': "Erreur d'enregistrement",
    'cm.play': 'Lire',
    'cm.addToPlaylist': 'Ajouter à la playlist',
    'cm.removeFromPlaylist': 'Retirer de la playlist',
    'cm.reveal': 'Afficher dans le dossier',
    'cm.editTags': 'Modifier les tags…',
    'cm.delete': 'Retirer de la bibliothèque',
    'palette.placeholder': 'Rechercher pistes, albums, actions…',
    'palette.nav': '↑↓ navigation',
    'palette.choose': '↵ sélectionner',
    'palette.close': 'ESC fermer',
    'palette.tracks': 'Pistes',
    'palette.actions': 'Actions',
    'palette.itemHint': '↵ lire',
    'palette.empty': 'Aucun résultat',
    'palette.action.openFiles': 'Ouvrir des fichiers…',
    'palette.action.gotoSettings': 'Aller aux Paramètres',
    'palette.action.gotoPlaylists': 'Aller aux Playlists',
    'palette.action.gotoFavorites': 'Aller aux Favoris',
    'label.unknownArtist': 'Artiste inconnu',
    'label.noAlbum': 'Sans album',
    'label.tracksShort': 'p.',
    'error.deleteFile': "Impossible de supprimer le fichier du disque : ",
    'error.unknown': 'erreur inconnue',
    'downloads.tab.queue': 'File d\'attente',
    'downloads.queue.add': 'À la file',
    'downloads.queue.queued': 'En file',
    'downloads.queue.addAll': 'Tout mettre en file',
    'downloads.queue.remove': 'Retirer de la file',
    'downloads.queue.clearDone': 'Effacer les terminés',
    'downloads.queue.clearAll': 'Tout effacer',
    'downloads.queue.empty.title': 'File d\'attente vide',
    'downloads.queue.empty.text': 'Ajoutez des pistes depuis l\'onglet « Analyse » — elles seront téléchargées les unes après les autres.',
    'downloads.queue.status.queued': 'En attente',
    'downloads.queue.status.downloading': 'Téléchargement',
    'downloads.queue.status.done': 'Terminé',
    'downloads.queue.status.error': 'Échec',
    'downloads.queue.stats.downloading': 'téléchargement : {n}',
    'downloads.queue.stats.queued': 'en file : {n}',
    'downloads.queue.stats.done': 'terminés : {n}',
    'downloads.queue.stats.error': 'erreurs : {n}',
    'downloads.queue.stats.paused': 'en pause',
    'downloads.queue.pause': 'Pause',
    'downloads.queue.resume': 'Reprendre',
  },
  uk: {
    'nav.library': 'Бібліотека',
    'update.available': 'Доступне оновлення',
    'update.download': 'Завантажити',
    'update.dismiss': 'Закрити',
    'nav.artists': 'Виконавці',
    'nav.playlists': 'Плейлисти',
    'nav.favorites': 'Улюблене',
    'nav.downloads': 'Завантаження',
    'nav.search': 'Пошук',
    'nav.recents': 'Нещодавнє',
    'nav.openFiles': 'Відкрити файли',
    'nav.settings': 'Налаштування',
    'crumb.collection': 'Колекція',
    'search.placeholder': 'Пошук…',
    'search.artistPlaceholder': 'Пошук виконавця…',
    'search.trackPlaceholder': 'Пошук треку…',
    'filter.all': 'Усі',
    'filter.recent': 'Нещодавно додані',
    'filter.favorites': 'Тільки улюблене',
    'sort.label': 'Сортування:',
    'sort.dateDesc': 'Дата додавання ↓',
    'sort.dateAsc': 'Дата додавання ↑',
    'sort.titleAsc': 'Назва А→Я',
    'sort.titleDesc': 'Назва Я→А',
    'sort.artistAsc': 'Виконавець А→Я',
    'sort.artistDesc': 'Виконавець Я→А',
    'sort.durationAsc': 'Тривалість ↑',
    'sort.durationDesc': 'Тривалість ↓',
    'sort.alpha': 'За алфавітом',
    'sort.byTracks': 'За кількістю треків',
    'sort.recent': 'Нещодавно додані',
    'table.title': 'Назва',
    'table.artist': 'Виконавець',
    'table.album': 'Альбом',
    'table.time': 'Час',
    'empty.library.title': 'Бібліотека порожня',
    'empty.library.text': 'Відкрий файли або теку, щоб почати.',
    'empty.playlists.title': 'Плейлистів поки немає',
    'empty.playlists.text': 'Створи свій перший плейлист — збери треки за настроєм, часом доби чи альбомом.',
    'empty.artists.title': 'Виконавців поки немає',
    'empty.artists.text': 'Додай треки до бібліотеки, щоб побачити тут перелік виконавців.',
    'empty.favorites.title': 'Немає улюблених треків',
    'empty.favorites.text': 'Натисни сердечко на будь-якому треку, щоб додати його сюди.',
    'btn.newPlaylist': 'Новий плейлист',
    'btn.playAll': 'Грати все',
    'btn.shuffle': 'Перемішати',
    'btn.deletePlaylist': 'Видалити плейлист',
    'btn.choose': 'Обрати…',
    'btn.cancel': 'Скасувати',
    'btn.delete': 'Видалити',
    'btn.create': 'Створити',
    'btn.close': 'Закрити',
    'btn.save': 'Зберегти',
    'btn.minimize': 'Згорнути',
    'btn.portrait': 'Мобільний режим',
    'btn.album': 'Альбом',
    'btn.favorite': 'До улюбленого',
    'btn.unfavorite': 'Прибрати з улюбленого',
    'btn.favoriteOn': 'В улюбленому',
    'btn.addToPlaylist': 'До плейлиста',
    'tooltip.favorite': 'До улюбленого',
    'tooltip.shuffle': 'Випадковий порядок',
    'tooltip.prev': 'Попередній',
    'tooltip.playPause': 'Відтворення/Пауза',
    'tooltip.next': 'Наступний',
    'tooltip.repeat': 'Повтор',
    'tooltip.fullscreen': 'На весь екран',
    'tooltip.volume': 'Звук',
    'tooltip.wip': 'Розділ у розробці',
    'hint.favorites': 'Збережені треки з\'являються тут',
    'eyebrow.playlist': 'Плейлист',
    'eyebrow.artist': 'Виконавець',
    'autoChip.artists': 'Список збирається автоматично з бібліотеки',
    'np.empty.title': 'Не обрано',
    'np.empty.artist': '—',
    'fs.nowPlayingFrom': 'Зараз грає · з',
    'fs.fromLibrary': 'Бібліотеки',
    'fs.nowPlaying': 'Зараз грає',
    'fs.queue': 'Черга',
    'fs.queueAhead': '{n} попереду',
    'downloads.tab.internet': 'З інтернету',
    'downloads.tab.parsing': 'Парсинг',
    'downloads.title': 'Завантаження з інтернету',
    'downloads.subtitle': 'Тут з\'явиться можливість зберігати треки за прямим посиланням. Розділ у розробці.',
    'downloads.parsing.title': 'Парсинг',
    'downloads.parsing.subtitle': 'Тут з\'явиться можливість збирати треки парсингом зі сторінок. Розділ у розробці.',
    'downloads.yt.placeholder': 'Назва треку або «виконавець — трек»',
    'downloads.yt.search': 'Знайти',
    'downloads.yt.hint': 'Пошук на YouTube · показує кілька варіантів на вибір.',
    'downloads.yt.col.title': 'Назва',
    'downloads.yt.col.channel': 'Канал',
    'downloads.yt.col.duration': 'Трив.',
    'downloads.yt.idle.title': 'Знайдіть трек на YouTube',
    'downloads.yt.idle.text': 'Введіть назву — нижче з\'явиться список mp3, доступних для завантаження. Файли зберігаються в теку за замовчуванням (якщо її задано в налаштуваннях) або в «Audex Downloads», і додаються до бібліотеки.',
    'downloads.yt.searching': 'Шукаю: «{q}»…',
    'downloads.yt.empty': 'Нічого не знайдено за запитом «{q}».',
    'downloads.yt.error': 'Помилка пошуку: {e}',
    'downloads.yt.action.download': 'Завантажити',
    'downloads.yt.action.downloading': 'Завантаження…',
    'downloads.yt.action.done': 'Готово',
    'downloads.yt.action.retry': 'Повторити',
    'downloads.yt.downloadError': 'Не вдалося: {e}',
    'downloads.yt.downloadOk': 'Завантажено і додано до бібліотеки: {t}',
    'downloads.yt.tagNote': 'Після завантаження, можливо, доведеться вручну виправити MP3-теги (назва, виконавець, обкладинка) через контекстне меню треку.',
    'downloads.parsing.subtab.yandex': 'Яндекс.Музика',
    'downloads.parsing.urlPlaceholder': 'https://music.yandex.ua/playlists/…',
    'downloads.parsing.start': 'Парсити',
    'downloads.parsing.hint': 'Вставте посилання на плейлист або альбом. Парсер працює у фоновому режимі.',
    'downloads.parsing.col.artist': 'Виконавець',
    'downloads.parsing.col.title': 'Назва',
    'downloads.parsing.col.duration': 'Трив.',
    'downloads.parsing.idle.title': 'Парсинг Яндекс.Музики',
    'downloads.parsing.idle.text': 'Вставте посилання на плейлист або альбом з «Яндекс.Музики». Застосунок збере список треків у фоні, і ви зможете завантажити будь-який одним кліком.',
    'downloads.parsing.starting': 'Запускаємо парсер…',
    'downloads.parsing.done': 'Готово — зібрано треків: {n}',
    'downloads.parsing.error': 'Помилка парсингу: {e}',
    'settings.title': 'Налаштування',
    'settings.subtitle': 'Зовнішній вигляд, джерела музики та поведінка застосунку.',
    'section.appearance': 'Зовнішній вигляд',
    'section.music': 'Музика',
    'section.downloads': 'Завантаження з інтернету',
    'section.language': 'Мова',
    'section.about': 'Про застосунок',
    'section.contacts': 'Контакти',
    'setting.github': 'GitHub',
    'setting.githubDesc': 'Вихідний код проєкту на GitHub.',
    'setting.telegram': 'Telegram',
    'setting.telegramDesc': 'Знайшли баг або є пропозиція — пишіть у Telegram.',
    'theme.dark': 'Темна',
    'theme.light': 'Світла',
    'theme.system': 'Системна',
    'setting.theme': 'Тема',
    'setting.themeDesc': 'Колірна схема застосунку.',
    'setting.accent': 'Колір акценту',
    'setting.accentDesc': 'Підсвічування активних елементів і поточного треку.',
    'setting.accentDefault': 'За замовчуванням',
    'setting.accentCustom': 'Власний колір',
    'setting.defaultFolder': 'Тека за замовчуванням',
    'setting.defaultFolderDesc': 'Звідки завантажувати треки під час запуску.',
    'setting.uiScale': 'Масштаб інтерфейсу',
    'setting.uiScaleDesc': 'Збільшує або зменшує весь інтерфейс. Застосовується одразу.',
    'setting.uiScaleReset': 'Скинути',
    'setting.scanSubdirs': 'Сканувати підтеки',
    'setting.scanSubdirsDesc': 'Враховувати вкладені каталоги під час індексації.',
    'setting.showDownloads': 'Показати вкладку «Завантаження»',
    'setting.showDownloadsDesc': 'Відкриє в боковому меню розділ для завантаження треків за посиланням.',
    'setting.showParserBrowser': 'Показувати вікно браузера під час парсингу',
    'setting.showParserBrowserDesc': 'Потрібно, щоб увійти в Яндекс при першому запуску, пройти капчу або побачити, на чому парсер спіткнувся. Якщо вимкнути — браузер запуститься у фоні і вікно не з\'явиться.',
    'section.system': 'Система',
    'setting.hardwareAcceleration': 'Апаратне прискорення',
    'setting.hardwareAccelerationDesc': 'Використовує відеокарту для відмалювання інтерфейсу. Якщо застосунок зависає при запуску або працює з артефактами — вимкніть. Зміна застосується після перезапуску.',
    'setting.uiLanguage': 'Мова інтерфейсу',
    'setting.uiLanguageDesc': 'Застосовується одразу.',
    'setting.version': 'Версія',
    'badge.wip': 'у розробці',
    'placeholder.noFolder': '— не обрано —',
    'modal.deleteTrack.title': 'Видалити трек?',
    'modal.deleteTrack.text': 'Трек буде вилучено з бібліотеки, а файл — переміщено у смітник.',
    'modal.deleteTrackFull.text': '«{title}» від {artist} буде вилучено з бібліотеки, а файл — переміщено у смітник.',
    'modal.deletePlaylist.title': 'Видалити плейлист?',
    'modal.deletePlaylist.text': 'Плейлист «{name}» буде вилучено. Треки в бібліотеці залишаться.',
    'modal.newPlaylist.title': 'Новий плейлист',
    'modal.newPlaylist.namePh': 'Назва плейлиста',
    'modal.newPlaylist.descPh': 'Опис (необов\'язково)',
    'modal.addToPlaylist.title': 'Додати до плейлиста',
    'modal.addToPlaylist.empty': 'Спершу створи плейлист на вкладці «Плейлисти».',
    'modal.addToPlaylist.alreadyAdded': 'вже додано',
    'editor.title': 'Редагувати теги',
    'editor.cover': 'Обкладинка',
    'editor.field.title': 'Назва',
    'editor.field.artist': 'Виконавець',
    'editor.field.album': 'Альбом',
    'editor.field.albumArtist': 'Викон. альбому',
    'editor.field.year': 'Рік',
    'editor.field.genre': 'Жанр',
    'editor.field.trackNo': 'Трек №',
    'editor.field.discNo': 'Диск №',
    'editor.field.comment': 'Коментар',
    'editor.commentPh': 'Нотатка про трек…',
    'editor.coverEmbed': 'Вбудована обкладинка',
    'editor.noCover': 'Немає обкладинки',
    'editor.saving': 'Збереження…',
    'editor.saved': 'Збережено ✓',
    'editor.errorSave': 'Помилка збереження',
    'cm.play': 'Грати',
    'cm.addToPlaylist': 'Додати до плейлиста',
    'cm.removeFromPlaylist': 'Прибрати з плейлиста',
    'cm.reveal': 'Показати у теці',
    'cm.editTags': 'Редагувати теги…',
    'cm.delete': 'Вилучити з бібліотеки',
    'palette.placeholder': 'Пошук треку, альбому, дії…',
    'palette.nav': '↑↓ навігація',
    'palette.choose': '↵ обрати',
    'palette.close': 'ESC закрити',
    'palette.tracks': 'Треки',
    'palette.actions': 'Дії',
    'palette.itemHint': '↵ грати',
    'palette.empty': 'Нічого не знайдено',
    'palette.action.openFiles': 'Відкрити файли…',
    'palette.action.gotoSettings': 'Перейти в Налаштування',
    'palette.action.gotoPlaylists': 'Перейти в Плейлисти',
    'palette.action.gotoFavorites': 'Перейти в Улюблене',
    'label.unknownArtist': 'Невідомий виконавець',
    'label.noAlbum': 'Без альбому',
    'label.tracksShort': 'тр.',
    'error.deleteFile': 'Не вдалося видалити файл з диска: ',
    'error.unknown': 'невідома помилка',
    'downloads.tab.queue': 'Черга',
    'downloads.queue.add': 'В чергу',
    'downloads.queue.queued': 'В черзі',
    'downloads.queue.addAll': 'Усі треки в чергу',
    'downloads.queue.remove': 'Прибрати з черги',
    'downloads.queue.clearDone': 'Очистити завершені',
    'downloads.queue.clearAll': 'Очистити все',
    'downloads.queue.empty.title': 'Черга порожня',
    'downloads.queue.empty.text': 'Додайте треки з вкладки «Парсинг», і вони почнуть завантажуватися один за одним.',
    'downloads.queue.status.queued': 'Очікує',
    'downloads.queue.status.downloading': 'Завантаження',
    'downloads.queue.status.done': 'Готово',
    'downloads.queue.status.error': 'Помилка',
    'downloads.queue.stats.downloading': 'завантажується: {n}',
    'downloads.queue.stats.queued': 'у черзі: {n}',
    'downloads.queue.stats.done': 'готово: {n}',
    'downloads.queue.stats.error': 'помилок: {n}',
    'downloads.queue.stats.paused': 'на паузі',
    'downloads.queue.pause': 'Пауза',
    'downloads.queue.resume': 'Продовжити',
  },
};

// Slavic-style 3-form plural (ru, uk): n%10==1 && n%100!=11 → one;
// n%10 in 2..4 && n%100 not in 12..14 → few; else → many.
function slavicPluralIdx(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1;
  return 2;
}
// Pluralized noun forms for "tracks/albums/artists/playlists" per language.
// ru/uk use [one, few, many]; en/de/fr use [one, other].
const PLURAL_FORMS = {
  ru: {
    tracks:    ['трек', 'трека', 'треков'],
    albums:    ['альбом', 'альбома', 'альбомов'],
    artists:   ['исполнитель', 'исполнителя', 'исполнителей'],
    playlists: ['плейлист', 'плейлиста', 'плейлистов'],
  },
  uk: {
    tracks:    ['трек', 'треки', 'треків'],
    albums:    ['альбом', 'альбоми', 'альбомів'],
    artists:   ['виконавець', 'виконавці', 'виконавців'],
    playlists: ['плейлист', 'плейлисти', 'плейлистів'],
  },
  en: {
    tracks:    ['track', 'tracks'],
    albums:    ['album', 'albums'],
    artists:   ['artist', 'artists'],
    playlists: ['playlist', 'playlists'],
  },
  de: {
    tracks:    ['Titel', 'Titel'],
    albums:    ['Album', 'Alben'],
    artists:   ['Interpret', 'Interpreten'],
    playlists: ['Playlist', 'Playlists'],
  },
  fr: {
    tracks:    ['piste', 'pistes'],
    albums:    ['album', 'albums'],
    artists:   ['artiste', 'artistes'],
    playlists: ['playlist', 'playlists'],
  },
};
// "h X min" / "X min" — total duration formatting.
const DURATION_UNITS = {
  ru: { h: 'ч', m: 'мин' },
  uk: { h: 'год', m: 'хв' },
  en: { h: 'h', m: 'min' },
  de: { h: 'h', m: 'Min' },
  fr: { h: 'h', m: 'min' },
};

let currentLang = I18N[settings.language] ? settings.language : 'en';

function tr(key, params) {
  const dict = I18N[currentLang] || I18N.ru;
  let s = dict[key];
  if (s == null) s = I18N.ru[key] != null ? I18N.ru[key] : key;
  if (params) {
    for (const k in params) s = s.split('{' + k + '}').join(params[k]);
  }
  return s;
}

function plural(kind, n) {
  const forms = (PLURAL_FORMS[currentLang] || PLURAL_FORMS.ru)[kind];
  const idx = (currentLang === 'ru' || currentLang === 'uk')
    ? slavicPluralIdx(n)
    : (n === 1 ? 0 : 1);
  return forms[idx];
}
function withCount(kind, n) { return `${n} ${plural(kind, n)}`; }

function applyLanguage(lang) {
  if (!I18N[lang]) lang = 'ru';
  currentLang = lang;
  document.documentElement.setAttribute('lang', lang);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = tr(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = tr(el.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = tr(el.getAttribute('data-i18n-title'));
  });
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
  const u = DURATION_UNITS[currentLang] || DURATION_UNITS.ru;
  return h > 0 ? `${h} ${u.h} ${m} ${u.m}` : `${m} ${u.m}`;
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
  let lastScrollTop = scrollEl.scrollTop;

  // listEl's offset within the scroll container's content (header/topbar above it).
  // It's constant while scrolling, so cache it and avoid a forced layout every frame.
  let listOffset = 0;
  let offsetValid = false;
  function measureOffset() {
    listOffset = listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    offsetValid = true;
  }

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
    if (!offsetValid) measureOffset();
    // Velocity-aware buffer: a fast fling can jump far more than `overscan` rows
    // between frames, leaving the newly-revealed area unmounted (blank rows). Extend
    // the render range in the scroll direction by the per-frame travel so rows are
    // mounted ahead of the viewport. Capped to bound per-frame work.
    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    const velRows = Math.min(80, Math.ceil(Math.abs(delta) / rowHeight));
    const aheadExtra = delta >= 0 ? velRows : 0;
    const behindExtra = delta < 0 ? velRows : 0;
    const visibleStart = (scrollTop - listOffset) / rowHeight;
    const visibleEnd = (scrollTop - listOffset + viewportH) / rowHeight;
    const start = Math.max(0, Math.floor(visibleStart) - overscan - behindExtra);
    const end = Math.min(total, Math.ceil(visibleEnd) + overscan + aheadExtra);

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
  window.addEventListener('resize', () => { offsetValid = false; schedule(); });

  return {
    setItems(newItems, renderRowFn) {
      items = newItems;
      if (renderRowFn) renderRow = renderRowFn;
      for (const [, node] of nodes) node.remove();
      nodes.clear();
      offsetValid = false; // list may have moved (view switch / count change)
      lastScrollTop = scrollEl.scrollTop;
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

// activeSort values: date-desc | date-asc | title-asc | title-desc |
//                    artist-asc | artist-desc | duration-asc | duration-desc
// "date" uses library insertion order as a proxy for "added on".
function sortedFilteredLibrary() {
  let arr = library.slice();
  if (activeFilter === 'recent') {
    arr = arr.slice(-50).reverse();
  } else if (activeFilter === 'favorites') {
    arr = arr.filter(t => favorites.includes(t.path));
  }
  const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '');
  const byArtist = (a, b) => (a.artist || '').localeCompare(b.artist || '') || byTitle(a, b);
  const byDuration = (a, b) => (a.duration || 0) - (b.duration || 0);
  switch (activeSort) {
    case 'title-asc': arr.sort(byTitle); break;
    case 'title-desc': arr.sort((a, b) => -byTitle(a, b)); break;
    case 'artist-asc': arr.sort(byArtist); break;
    case 'artist-desc': arr.sort((a, b) => -byArtist(a, b)); break;
    case 'duration-asc': arr.sort(byDuration); break;
    case 'duration-desc': arr.sort((a, b) => -byDuration(a, b)); break;
    case 'date-asc':
      // 'recent' is already date-desc from the slice; reverse it for ascending.
      if (activeFilter === 'recent') arr = arr.slice().reverse();
      // For 'all' and 'favorites' the underlying order is already insertion-asc.
      break;
    case 'date-desc':
    default:
      if (activeFilter !== 'recent') arr = arr.slice().reverse();
      break;
  }
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
    if (item.dataset.action === 'open-palette') {
      // Replay the icon-ping animation by toggling the class off and back on.
      item.classList.remove('is-pinging');
      void item.offsetWidth;
      item.classList.add('is-pinging');
      setTimeout(() => item.classList.remove('is-pinging'), 600);
      return openPalette();
    }
    if (item.dataset.view) setView(item.dataset.view);
  });
});
document.querySelectorAll('.crumb-item.link').forEach(el => {
  el.addEventListener('click', () => setView(el.dataset.view));
});

// ── Downloads tabs ──
document.querySelectorAll('.dl-tabs .dl-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    activateDlTab(btn.dataset.dlTab);
  });
});

// ── Downloads: YouTube search & download ──
let ytSearchToken = 0;
let ytLastResults = [];
const ytActiveDownloads = new Map(); // videoId -> { rowEl, btnEl }

if (window.electronAPI && window.electronAPI.onYtDownloadProgress) {
  window.electronAPI.onYtDownloadProgress(({ videoId, phase, percent }) => {
    const entry = videoId ? ytActiveDownloads.get(videoId) : null;
    if (!entry) return;
    const { rowEl } = entry;
    const fill = rowEl.querySelector('.dl-progress-fill');
    const pct = rowEl.querySelector('.dl-progress-pct');
    const wrap = rowEl.querySelector('.dl-progress');
    if (!fill || !pct || !wrap) return;
    if (phase === 'postprocess') {
      wrap.classList.add('is-indeterminate');
      pct.textContent = '…';
      return;
    }
    if (typeof percent === 'number' && !isNaN(percent)) {
      wrap.classList.remove('is-indeterminate');
      fill.style.width = percent.toFixed(1) + '%';
      pct.textContent = Math.round(percent) + '%';
    }
  });
}

function setYtStatus(text, kind) {
  const el = $('dl-yt-status');
  if (!el) return;
  el.classList.remove('is-error', 'is-ok');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  if (kind === 'error') el.classList.add('is-error');
  else if (kind === 'ok') el.classList.add('is-ok');
  el.hidden = false;
  el.textContent = text;
}

function saveYtState() {
  try {
    const q = $('dl-yt-query');
    localStorage.setItem(LS.ytState, JSON.stringify({
      query: q ? q.value : '',
      results: ytLastResults,
    }));
  } catch (_) { /* ignore */ }
}

function renderYtResults(results) {
  ytLastResults = results || [];
  // Save before any DOM checks — persistence shouldn't depend on the YT pane
  // being currently mounted/visible.
  saveYtState();
  const wrap = $('dl-yt-results');
  const rows = $('dl-yt-rows');
  const empty = $('dl-yt-empty');
  const note = $('dl-yt-tag-note');
  const queueAllBtn = $('dl-yt-queue-all');
  if (!wrap || !rows) return;
  if (!ytLastResults.length) {
    wrap.hidden = true;
    if (note) note.hidden = true;
    if (empty) empty.classList.add('show');
    if (queueAllBtn) queueAllBtn.hidden = true;
    return;
  }
  if (empty) empty.classList.remove('show');
  if (note) note.hidden = false;
  if (queueAllBtn) queueAllBtn.hidden = false;
  rows.innerHTML = ytLastResults.map((r, i) => {
    const queued = isYtResultInQueue(r);
    const queuedCls = queued ? ' is-done' : '';
    const queueDis = queued ? ' disabled' : '';
    const queueLabel = queued ? tr('downloads.queue.queued') : tr('downloads.queue.add');
    return `
      <div class="dl-row" data-yt-row="${i}">
        <div class="thumb" style="background-image: url('${escapeHtml(r.thumbnail || '')}')"></div>
        <div class="title" title="${escapeHtml(r.title)}">${escapeHtml(r.title || '')}</div>
        <div class="channel" title="${escapeHtml(r.channel || '')}">${escapeHtml(r.channel || '')}</div>
        <div class="duration">${escapeHtml(r.durationStr || '')}</div>
        <div class="action">
          <button type="button" class="dl-download-btn dl-queue-btn${queuedCls}" data-yt-queue="${i}"${queueDis} title="${escapeHtml(queueLabel)}">
            <svg class="i" width="12" height="12"><use href="#i-plus"/></svg>
            <span>${escapeHtml(queueLabel)}</span>
          </button>
          <button type="button" class="dl-download-btn" data-yt-dl="${i}">
            <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
            <span>${escapeHtml(tr('downloads.yt.action.download'))}</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
  wrap.hidden = false;
  rows.querySelectorAll('[data-yt-dl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-yt-dl'), 10);
      if (!isNaN(idx)) downloadYtResult(idx, btn);
    });
  });
  rows.querySelectorAll('[data-yt-queue]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-yt-queue'), 10);
      if (!isNaN(idx)) enqueueYtResult(idx);
    });
  });
}

async function runYtSearch() {
  const input = $('dl-yt-query');
  const btn = $('dl-yt-search-btn');
  if (!input) return;
  const q = input.value.trim();
  if (!q) { input.focus(); return; }
  const token = ++ytSearchToken;
  if (btn) btn.disabled = true;
  setYtStatus(tr('downloads.yt.searching', { q }));
  const wrap = $('dl-yt-results');
  if (wrap) wrap.hidden = true;
  try {
    const res = await window.electronAPI.ytSearch(q, 8);
    if (token !== ytSearchToken) return;
    if (!res || !res.success) {
      setYtStatus(tr('downloads.yt.error', { e: (res && res.error) || 'unknown' }), 'error');
      renderYtResults([]);
      return;
    }
    if (!res.results.length) {
      setYtStatus(tr('downloads.yt.empty', { q }), 'error');
      renderYtResults([]);
      return;
    }
    setYtStatus(null);
    renderYtResults(res.results);
  } catch (err) {
    if (token !== ytSearchToken) return;
    setYtStatus(tr('downloads.yt.error', { e: String(err) }), 'error');
  } finally {
    if (token === ytSearchToken && btn) btn.disabled = false;
  }
}

function restoreDownloadButton(actionEl, idx, labelKey, cls) {
  actionEl.innerHTML = `
    <button type="button" class="dl-download-btn ${cls || ''}" data-yt-dl="${idx}">
      <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
      <span>${escapeHtml(tr(labelKey))}</span>
    </button>
  `;
  const newBtn = actionEl.querySelector('[data-yt-dl]');
  if (newBtn) {
    newBtn.addEventListener('click', () => downloadYtResult(idx, newBtn));
  }
  return newBtn;
}

async function downloadYtResult(idx, btn) {
  const r = ytLastResults[idx];
  if (!r || !btn) return;
  if (btn.classList.contains('is-done')) return;
  const rowEl = btn.closest('.dl-row');
  if (!rowEl) return;
  const actionEl = rowEl.querySelector('.action');
  if (!actionEl) return;

  actionEl.innerHTML = `
    <div class="dl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="dl-progress-bar"><div class="dl-progress-fill"></div></div>
      <div class="dl-progress-pct">0%</div>
    </div>
  `;
  ytActiveDownloads.set(r.id, { rowEl, btnEl: null });

  try {
    const res = await window.electronAPI.ytDownload({
      videoId: r.id,
      url: r.url,
      suggestedName: r.title,
      targetDir: settings.defaultFolder || '',
    });
    ytActiveDownloads.delete(r.id);
    if (!res || !res.success) {
      restoreDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
      setYtStatus(tr('downloads.yt.downloadError', { e: (res && res.error) || 'unknown' }), 'error');
      return;
    }
    await importPaths([res.filePath]);
    const doneBtn = restoreDownloadButton(actionEl, idx, 'downloads.yt.action.done', 'is-done');
    if (doneBtn) doneBtn.disabled = true;
    setYtStatus(tr('downloads.yt.downloadOk', { t: r.title }), 'ok');
  } catch (err) {
    ytActiveDownloads.delete(r.id);
    restoreDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
    setYtStatus(tr('downloads.yt.downloadError', { e: String(err) }), 'error');
  }
}

(function wireYtSearchControls() {
  const btn = $('dl-yt-search-btn');
  const input = $('dl-yt-query');
  const queueAll = $('dl-yt-queue-all');
  if (btn) btn.addEventListener('click', runYtSearch);
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runYtSearch(); }
    });
    // Persist the typed query as the user types so a reload before pressing
    // Enter doesn't drop their input. Light-touch: just rewrites the same
    // JSON blob, no debouncing needed at human typing speed.
    input.addEventListener('input', saveYtState);
  }
  if (queueAll) queueAll.addEventListener('click', enqueueAllYtResults);
})();

// ── Downloads: Parsing sub-tabs ──
document.querySelectorAll('.dl-subtabs .dl-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.dlSubtab;
    document.querySelectorAll('.dl-subtabs .dl-subtab').forEach(t => {
      const on = t.dataset.dlSubtab === target;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.dl-subpane').forEach(p => {
      p.hidden = p.dataset.dlSubpane !== target;
    });
  });
});

// ── Downloads: Yandex Music parsing ──
let ymParseActive = false;
let ymTracks = [];
let ymDownloadReqSeq = 0;
const ymActiveDownloads = new Map(); // requestId -> rowEl

function setYmStatus(text, kind) {
  const el = $('dl-ym-status');
  if (!el) return;
  el.classList.remove('is-error', 'is-ok');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  if (kind === 'error') el.classList.add('is-error');
  else if (kind === 'ok') el.classList.add('is-ok');
  el.hidden = false;
  el.textContent = text;
}

function saveYmState() {
  try {
    const u = $('dl-ym-url');
    localStorage.setItem(LS.ymState, JSON.stringify({
      url: u ? u.value : '',
      tracks: ymTracks,
    }));
  } catch (_) { /* ignore */ }
}

function renderYmResults(tracks) {
  ymTracks = tracks || [];
  saveYmState();
  const wrap = $('dl-ym-results');
  const rows = $('dl-ym-rows');
  const empty = $('dl-ym-empty');
  const note = $('dl-ym-tag-note');
  const queueAllBtn = $('dl-ym-queue-all');
  if (!wrap || !rows) return;
  if (!ymTracks.length) {
    wrap.hidden = true;
    if (note) note.hidden = true;
    if (empty) empty.classList.add('show');
    if (queueAllBtn) queueAllBtn.hidden = true;
    return;
  }
  if (empty) empty.classList.remove('show');
  if (note) note.hidden = false;
  if (queueAllBtn) {
    queueAllBtn.hidden = false;
    queueAllBtn.disabled = ymParseActive;
  }
  const disabledAttr = ymParseActive ? ' disabled' : '';
  rows.innerHTML = ymTracks.map((t, i) => {
    const queued = isYmTrackInQueue(t);
    const queuedCls = queued ? ' is-done' : '';
    const queueDis = ymParseActive || queued ? ' disabled' : '';
    const queueLabel = queued ? tr('downloads.queue.queued') : tr('downloads.queue.add');
    return `
      <div class="dl-row-ym" data-ym-row="${i}">
        <div class="num">${i + 1}</div>
        <div class="artist" title="${escapeHtml(t.artist || '')}">${escapeHtml(t.artist || '')}</div>
        <div class="title" title="${escapeHtml(t.title || '')}">${escapeHtml(t.title || '')}</div>
        <div class="duration">${escapeHtml(t.duration || '')}</div>
        <div class="action">
          <button type="button" class="dl-download-btn dl-queue-btn${queuedCls}" data-ym-queue="${i}"${queueDis} title="${escapeHtml(queueLabel)}">
            <svg class="i" width="12" height="12"><use href="#i-plus"/></svg>
            <span>${escapeHtml(queueLabel)}</span>
          </button>
          <button type="button" class="dl-download-btn" data-ym-dl="${i}"${disabledAttr}>
            <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
            <span>${escapeHtml(tr('downloads.yt.action.download'))}</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
  wrap.hidden = false;
  rows.querySelectorAll('[data-ym-dl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-ym-dl'), 10);
      if (!isNaN(idx)) downloadYmTrack(idx, btn);
    });
  });
  rows.querySelectorAll('[data-ym-queue]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-ym-queue'), 10);
      if (!isNaN(idx)) enqueueYmTrack(idx);
    });
  });
}

function restoreYmDownloadButton(actionEl, idx, labelKey, cls) {
  actionEl.innerHTML = `
    <button type="button" class="dl-download-btn ${cls || ''}" data-ym-dl="${idx}">
      <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
      <span>${escapeHtml(tr(labelKey))}</span>
    </button>
  `;
  const newBtn = actionEl.querySelector('[data-ym-dl]');
  if (newBtn) newBtn.addEventListener('click', () => downloadYmTrack(idx, newBtn));
  return newBtn;
}

async function downloadYmTrack(idx, btn) {
  const t = ymTracks[idx];
  if (!t || !btn) return;
  if (btn.classList.contains('is-done')) return;
  const rowEl = btn.closest('.dl-row-ym');
  if (!rowEl) return;
  const actionEl = rowEl.querySelector('.action');
  if (!actionEl) return;

  const requestId = 'ym-' + (++ymDownloadReqSeq);
  rowEl.dataset.requestId = requestId;
  actionEl.innerHTML = `
    <div class="dl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="dl-progress-bar"><div class="dl-progress-fill"></div></div>
      <div class="dl-progress-pct">0%</div>
    </div>
  `;
  ymActiveDownloads.set(requestId, rowEl);

  const query = `${t.artist} ${t.title}`.replace(/—/g, '').trim();
  const suggestedName = `${t.artist} - ${t.title}`;

  try {
    const res = await window.electronAPI.ytDownloadByQuery({ query, suggestedName, requestId, targetDir: settings.defaultFolder || '' });
    ymActiveDownloads.delete(requestId);
    if (!res || !res.success) {
      restoreYmDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
      setYmStatus(tr('downloads.yt.downloadError', { e: (res && res.error) || 'unknown' }), 'error');
      return;
    }
    await importPaths([res.filePath]);
    const doneBtn = restoreYmDownloadButton(actionEl, idx, 'downloads.yt.action.done', 'is-done');
    if (doneBtn) doneBtn.disabled = true;
    setYmStatus(tr('downloads.yt.downloadOk', { t: suggestedName }), 'ok');
  } catch (err) {
    ymActiveDownloads.delete(requestId);
    restoreYmDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
    setYmStatus(tr('downloads.yt.downloadError', { e: String(err) }), 'error');
  }
}

if (window.electronAPI && window.electronAPI.onYtDownloadProgress) {
  // The YT handler is already wired by the YouTube tab; reuse for requestId-based progress too.
  window.electronAPI.onYtDownloadProgress(({ requestId, phase, percent }) => {
    if (!requestId) return;
    const rowEl = ymActiveDownloads.get(requestId);
    if (!rowEl) return;
    const fill = rowEl.querySelector('.dl-progress-fill');
    const pct = rowEl.querySelector('.dl-progress-pct');
    const wrap = rowEl.querySelector('.dl-progress');
    if (!fill || !pct || !wrap) return;
    if (phase === 'postprocess') {
      wrap.classList.add('is-indeterminate');
      pct.textContent = '…';
      return;
    }
    if (typeof percent === 'number' && !isNaN(percent)) {
      wrap.classList.remove('is-indeterminate');
      fill.style.width = percent.toFixed(1) + '%';
      pct.textContent = Math.round(percent) + '%';
    }
  });
}

if (window.electronAPI && window.electronAPI.onYandexParseProgress) {
  window.electronAPI.onYandexParseProgress((data) => {
    if (!data) return;
    if (data.message) {
      const total = typeof data.total === 'number' ? ` · ${data.total}` : '';
      setYmStatus(data.message + total, data.phase === 'error' ? 'error' : null);
    }
    if (Array.isArray(data.tracks)) {
      renderYmResults(data.tracks);
    }
  });
}

async function runYmParse() {
  if (ymParseActive) return;
  const urlEl = $('dl-ym-url');
  const startBtn = $('dl-ym-parse-btn');
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url) { urlEl.focus(); return; }
  ymParseActive = true;
  if (startBtn) startBtn.disabled = true;
  renderYmResults([]);
  setYmStatus(tr('downloads.parsing.starting'));
  try {
    const res = await window.electronAPI.yandexParse({ url, showBrowser: !!settings.showParserBrowser });
    if (!res || !res.success) {
      setYmStatus(tr('downloads.parsing.error', { e: (res && res.error) || 'unknown' }), 'error');
      if (res && Array.isArray(res.tracks) && res.tracks.length) renderYmResults(res.tracks);
    } else {
      setYmStatus(tr('downloads.parsing.done', { n: res.tracks.length }), 'ok');
      renderYmResults(res.tracks);
    }
  } catch (err) {
    setYmStatus(tr('downloads.parsing.error', { e: String(err) }), 'error');
  } finally {
    ymParseActive = false;
    if (startBtn) startBtn.disabled = false;
    // Re-render rows so disabled download buttons become clickable now that the
    // parser is done. ymTracks holds whatever the last progress/result update saw.
    if (ymTracks && ymTracks.length) renderYmResults(ymTracks);
  }
}

(function wireYmControls() {
  const start = $('dl-ym-parse-btn');
  const url = $('dl-ym-url');
  if (start) start.addEventListener('click', runYmParse);
  if (url) {
    url.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runYmParse(); }
    });
    url.addEventListener('input', saveYmState);
  }
})();

// ── Downloads: Queue ──
// In-memory queue (per session). Items move queued → downloading → done|error.
// One concurrent download keeps things simple and predictable.
const downloadQueue = [];
const queueByRequestId = new Map(); // requestId → item.id (for progress routing)
let queueWorkerRunning = false;
let queueIdSeq = 0;
let queuePaused = false;

function ymTrackKey(t) {
  return `${(t.artist || '').trim().toLowerCase()}|${(t.title || '').trim().toLowerCase()}`;
}

function ytTrackKey(r) {
  return r && r.id ? `yt:${r.id}` : `yt:${(r && r.url) || ''}`;
}

function isYmTrackInQueue(t) {
  if (!t) return false;
  const key = ymTrackKey(t);
  return downloadQueue.some(it => it.source === 'yandex' && it.key === key && it.status !== 'error');
}

function isYtResultInQueue(r) {
  if (!r) return false;
  const key = ytTrackKey(r);
  return downloadQueue.some(it => it.source === 'youtube' && it.key === key && it.status !== 'error');
}

function buildQueueItemFromYm(t) {
  return {
    id: 'q-' + (++queueIdSeq),
    source: 'yandex',
    key: ymTrackKey(t),
    artist: t.artist || '',
    title: t.title || '',
    duration: t.duration || '',
    query: `${t.artist || ''} ${t.title || ''}`.replace(/—/g, '').trim(),
    suggestedName: `${t.artist || ''} - ${t.title || ''}`,
    videoId: '',
    url: '',
    status: 'queued',          // 'queued' | 'downloading' | 'done' | 'error'
    percent: 0,
    indeterminate: false,
    filePath: '',
    error: '',
    requestId: '',
  };
}

function buildQueueItemFromYt(r) {
  return {
    id: 'q-' + (++queueIdSeq),
    source: 'youtube',
    key: ytTrackKey(r),
    artist: r.channel || '',
    title: r.title || '',
    duration: r.durationStr || '',
    query: r.title || '',
    suggestedName: r.title || '',
    videoId: r.id || '',
    url: r.url || '',
    status: 'queued',
    percent: 0,
    indeterminate: false,
    filePath: '',
    error: '',
    requestId: '',
  };
}

function enqueueYmTrack(idx) {
  const t = ymTracks[idx];
  if (!t || isYmTrackInQueue(t)) return;
  downloadQueue.push(buildQueueItemFromYm(t));
  renderQueue();
  renderYmResults(ymTracks);
  updateQueueTabBadge();
  startQueueWorker();
}

function enqueueAllYmTracks() {
  if (!ymTracks || !ymTracks.length) return;
  let added = 0;
  for (const t of ymTracks) {
    if (isYmTrackInQueue(t)) continue;
    downloadQueue.push(buildQueueItemFromYm(t));
    added++;
  }
  if (added > 0) {
    renderQueue();
    renderYmResults(ymTracks);
    updateQueueTabBadge();
    startQueueWorker();
    activateDlTab('queue');
  }
}

function enqueueYtResult(idx) {
  const r = ytLastResults[idx];
  if (!r || isYtResultInQueue(r)) return;
  downloadQueue.push(buildQueueItemFromYt(r));
  renderQueue();
  renderYtResults(ytLastResults);
  updateQueueTabBadge();
  startQueueWorker();
}

function enqueueAllYtResults() {
  if (!ytLastResults || !ytLastResults.length) return;
  let added = 0;
  for (const r of ytLastResults) {
    if (isYtResultInQueue(r)) continue;
    downloadQueue.push(buildQueueItemFromYt(r));
    added++;
  }
  if (added > 0) {
    renderQueue();
    renderYtResults(ytLastResults);
    updateQueueTabBadge();
    startQueueWorker();
    activateDlTab('queue');
  }
}

function nextQueuedItem() {
  if (queuePaused) return null;
  return downloadQueue.find(it => it.status === 'queued');
}

async function startQueueWorker() {
  if (queueWorkerRunning) return;
  queueWorkerRunning = true;
  try {
    while (true) {
      const item = nextQueuedItem();
      if (!item) break;
      await processQueueItem(item);
    }
  } finally {
    queueWorkerRunning = false;
  }
}

function setQueuePaused(paused) {
  queuePaused = !!paused;
  saveQueueState();
  renderQueue();
  updateQueueTabBadge();
  if (!queuePaused) startQueueWorker();
}

async function processQueueItem(item) {
  item.status = 'downloading';
  item.percent = 0;
  item.indeterminate = false;
  item.requestId = item.id; // reuse our item id as requestId for progress routing
  queueByRequestId.set(item.requestId, item.id);
  renderQueue();
  try {
    let res;
    if (item.source === 'youtube' && (item.videoId || item.url)) {
      // YouTube items have a concrete video id — download that exact video.
      res = await window.electronAPI.ytDownload({
        videoId: item.videoId,
        url: item.url,
        suggestedName: item.suggestedName,
        requestId: item.requestId,
        targetDir: settings.defaultFolder || '',
      });
    } else {
      // Yandex (and any text-only source) goes through ytsearch1: by query.
      res = await window.electronAPI.ytDownloadByQuery({
        query: item.query,
        suggestedName: item.suggestedName,
        requestId: item.requestId,
        targetDir: settings.defaultFolder || '',
      });
    }
    queueByRequestId.delete(item.requestId);
    if (!res || !res.success) {
      item.status = 'error';
      item.error = (res && res.error) || tr('error.unknown');
    } else {
      item.status = 'done';
      item.percent = 100;
      item.filePath = res.filePath;
      try { await importPaths([res.filePath]); } catch (_) { /* ignore */ }
    }
  } catch (err) {
    queueByRequestId.delete(item.requestId);
    item.status = 'error';
    item.error = String(err);
  }
  renderQueue();
  renderYmResults(ymTracks);
  renderYtResults(ytLastResults);
  updateQueueTabBadge();
}

function handleQueueProgress(requestId, phase, percent) {
  const itemId = queueByRequestId.get(requestId);
  if (!itemId) return false;
  const item = downloadQueue.find(it => it.id === itemId);
  if (!item || item.status !== 'downloading') return true;
  if (phase === 'postprocess') {
    item.indeterminate = true;
  } else if (typeof percent === 'number' && !isNaN(percent)) {
    item.indeterminate = false;
    item.percent = percent;
  }
  // Patch the visible row in place rather than re-rendering the whole list.
  patchQueueRowProgress(item);
  return true;
}

if (window.electronAPI && window.electronAPI.onYtDownloadProgress) {
  // Layer queue routing on top of the existing YT/YM progress listeners.
  // The earlier listeners only act if they recognise the requestId, so this
  // additional handler simply claims queue-owned ids without conflict.
  window.electronAPI.onYtDownloadProgress(({ requestId, phase, percent }) => {
    if (!requestId) return;
    handleQueueProgress(requestId, phase, percent);
  });
}

function queueStatusLabel(item) {
  switch (item.status) {
    case 'queued': return tr('downloads.queue.status.queued');
    case 'downloading': return tr('downloads.queue.status.downloading');
    case 'done': return tr('downloads.queue.status.done');
    case 'error': return tr('downloads.queue.status.error');
    default: return '';
  }
}

function saveQueueState() {
  try {
    // Persist a normalised snapshot. An in-flight item is recorded as 'queued' so
    // a reload re-attempts the download rather than leaving an orphaned row that
    // never finishes (the actual yt-dlp spawn dies with the renderer anyway).
    const items = downloadQueue.map(it => ({
      id: it.id,
      source: it.source,
      key: it.key,
      artist: it.artist,
      title: it.title,
      duration: it.duration,
      query: it.query,
      suggestedName: it.suggestedName,
      videoId: it.videoId || '',
      url: it.url || '',
      status: it.status === 'downloading' ? 'queued' : it.status,
      filePath: it.filePath || '',
      error: it.error || '',
    }));
    localStorage.setItem(LS.queue, JSON.stringify({ paused: queuePaused, items }));
  } catch (_) { /* ignore */ }
}

function renderQueue() {
  saveQueueState();
  const list = $('dl-queue-list');
  const empty = $('dl-queue-empty');
  const stats = $('dl-queue-stats');
  const clearBtn = $('dl-queue-clear-done');
  const clearAllBtn = $('dl-queue-clear-all');
  const pauseBtn = $('dl-queue-pause');
  const pauseLabel = $('dl-queue-pause-label');
  if (!list) return;

  // Pause button: shown whenever there are queued/downloading items; otherwise
  // pausing has no effect and just adds noise.
  const hasActive = downloadQueue.some(it => it.status === 'queued' || it.status === 'downloading');
  if (pauseBtn) {
    pauseBtn.hidden = !hasActive;
    pauseBtn.classList.toggle('is-paused', queuePaused);
    const useEl = pauseBtn.querySelector('use');
    if (useEl) useEl.setAttribute('href', queuePaused ? '#i-play' : '#i-pause');
  }
  if (pauseLabel) pauseLabel.textContent = queuePaused ? tr('downloads.queue.resume') : tr('downloads.queue.pause');

  if (!downloadQueue.length) {
    list.innerHTML = '';
    if (empty) empty.classList.add('show');
    if (stats) stats.textContent = '';
    if (clearBtn) clearBtn.hidden = true;
    if (clearAllBtn) clearAllBtn.hidden = true;
    return;
  }
  if (empty) empty.classList.remove('show');

  const counts = { queued: 0, downloading: 0, done: 0, error: 0 };
  for (const it of downloadQueue) counts[it.status]++;
  if (stats) {
    const parts = [];
    if (queuePaused) parts.push(tr('downloads.queue.stats.paused'));
    if (counts.downloading) parts.push(tr('downloads.queue.stats.downloading', { n: counts.downloading }));
    if (counts.queued) parts.push(tr('downloads.queue.stats.queued', { n: counts.queued }));
    if (counts.done) parts.push(tr('downloads.queue.stats.done', { n: counts.done }));
    if (counts.error) parts.push(tr('downloads.queue.stats.error', { n: counts.error }));
    stats.textContent = parts.join(' · ');
  }
  if (clearBtn) clearBtn.hidden = !(counts.done || counts.error);
  if (clearAllBtn) clearAllBtn.hidden = false;

  list.innerHTML = downloadQueue.map(it => renderQueueRow(it)).join('');
  list.querySelectorAll('[data-q-retry]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-q-retry');
      const item = downloadQueue.find(x => x.id === id);
      if (!item) return;
      item.status = 'queued';
      item.error = '';
      item.percent = 0;
      renderQueue();
      updateQueueTabBadge();
      startQueueWorker();
    });
  });
  list.querySelectorAll('[data-q-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-q-remove');
      const idx = downloadQueue.findIndex(x => x.id === id);
      if (idx < 0) return;
      const item = downloadQueue[idx];
      // Don't allow removing an active download mid-flight; cancellation isn't wired.
      if (item.status === 'downloading') return;
      downloadQueue.splice(idx, 1);
      renderQueue();
      renderYmResults(ymTracks);
      updateQueueTabBadge();
    });
  });
}

function renderQueueRow(item) {
  const showProgress = item.status === 'downloading';
  const indetCls = item.indeterminate ? ' is-indeterminate' : '';
  const pctText = item.indeterminate ? '…' : (Math.round(item.percent) + '%');
  const removeDis = item.status === 'downloading' ? ' disabled' : '';
  const errorLine = item.status === 'error' && item.error
    ? `<div class="dl-queue-error" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</div>`
    : '';
  const retryBtn = item.status === 'error'
    ? `<button type="button" class="dl-download-btn" data-q-retry="${item.id}" title="${escapeHtml(tr('downloads.yt.action.retry'))}">
         <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
         <span>${escapeHtml(tr('downloads.yt.action.retry'))}</span>
       </button>`
    : '';
  const progressBlock = showProgress
    ? `<div class="dl-queue-progress" data-q-row-progress="${item.id}">
         <div class="dl-progress${indetCls}">
           <div class="dl-progress-bar"><div class="dl-progress-fill" style="width:${item.indeterminate ? 40 : item.percent.toFixed(1)}%"></div></div>
           <div class="dl-progress-pct">${escapeHtml(pctText)}</div>
         </div>
       </div>`
    : '';
  return `
    <div class="dl-queue-row dl-queue-${item.status}" data-q-row="${item.id}">
      <div class="dl-queue-info">
        <div class="dl-queue-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title || '—')}</div>
        <div class="dl-queue-artist" title="${escapeHtml(item.artist)}">${escapeHtml(item.artist || '—')}</div>
        ${errorLine}
      </div>
      <div class="dl-queue-mid">
        <span class="dl-queue-badge dl-queue-badge-${item.status}">${escapeHtml(queueStatusLabel(item))}</span>
        ${progressBlock}
      </div>
      <div class="dl-queue-actions">
        ${retryBtn}
        <button type="button" class="dl-icon-btn" data-q-remove="${item.id}"${removeDis} title="${escapeHtml(tr('downloads.queue.remove'))}">
          <svg class="i" width="12" height="12"><use href="#i-close"/></svg>
        </button>
      </div>
    </div>
  `;
}

function patchQueueRowProgress(item) {
  const list = $('dl-queue-list');
  if (!list) return;
  const row = list.querySelector(`[data-q-row="${item.id}"]`);
  if (!row) {
    // Row not on screen — full re-render handles transitions.
    renderQueue();
    return;
  }
  const wrap = row.querySelector('.dl-progress');
  if (!wrap) { renderQueue(); return; }
  const fill = wrap.querySelector('.dl-progress-fill');
  const pct = wrap.querySelector('.dl-progress-pct');
  if (item.indeterminate) {
    wrap.classList.add('is-indeterminate');
    if (pct) pct.textContent = '…';
  } else {
    wrap.classList.remove('is-indeterminate');
    if (fill) fill.style.width = item.percent.toFixed(1) + '%';
    if (pct) pct.textContent = Math.round(item.percent) + '%';
  }
}

function updateQueueTabBadge() {
  const badge = $('dl-queue-tab-count');
  if (!badge) return;
  const active = downloadQueue.filter(it => it.status === 'queued' || it.status === 'downloading').length;
  if (active > 0) {
    badge.hidden = false;
    badge.textContent = String(active);
  } else {
    badge.hidden = true;
  }
}

function clearFinishedFromQueue() {
  for (let i = downloadQueue.length - 1; i >= 0; i--) {
    if (downloadQueue[i].status === 'done' || downloadQueue[i].status === 'error') {
      downloadQueue.splice(i, 1);
    }
  }
  renderQueue();
  renderYmResults(ymTracks);
  updateQueueTabBadge();
}

function clearAllFromQueue() {
  // Keep the in-flight download alive — cancellation isn't wired through yt-dlp.
  // Removing the active row would orphan its progress events and leave the file
  // half-downloaded on disk.
  for (let i = downloadQueue.length - 1; i >= 0; i--) {
    if (downloadQueue[i].status !== 'downloading') {
      downloadQueue.splice(i, 1);
    }
  }
  renderQueue();
  renderYmResults(ymTracks);
  updateQueueTabBadge();
}

function activateDlTab(target) {
  document.querySelectorAll('.dl-tabs .dl-tab').forEach(t => {
    const on = t.dataset.dlTab === target;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.dl-pane').forEach(p => {
    p.hidden = p.dataset.dlPane !== target;
  });
  if (target === 'queue') renderQueue();
}

(function wireQueueControls() {
  const queueAll = $('dl-ym-queue-all');
  if (queueAll) queueAll.addEventListener('click', enqueueAllYmTracks);
  const clearBtn = $('dl-queue-clear-done');
  if (clearBtn) clearBtn.addEventListener('click', clearFinishedFromQueue);
  const clearAllBtn = $('dl-queue-clear-all');
  if (clearAllBtn) clearAllBtn.addEventListener('click', clearAllFromQueue);
  const pauseBtn = $('dl-queue-pause');
  if (pauseBtn) pauseBtn.addEventListener('click', () => setQueuePaused(!queuePaused));
})();

// ── Downloads: session restore ──
// Restores YT search results, YM parsed tracks, and the download queue from
// localStorage. Items that were mid-download when the session ended are reset
// to 'queued' so the worker re-attempts them.
function restoreDownloadsState() {
  try {
    const raw = localStorage.getItem(LS.ytState);
    if (raw) {
      const yt = JSON.parse(raw);
      const queryEl = $('dl-yt-query');
      if (queryEl && typeof yt.query === 'string') queryEl.value = yt.query;
      if (Array.isArray(yt.results) && yt.results.length) renderYtResults(yt.results);
    }
  } catch (_) { /* ignore */ }
  try {
    const raw = localStorage.getItem(LS.ymState);
    if (raw) {
      const ym = JSON.parse(raw);
      const urlEl = $('dl-ym-url');
      if (urlEl && typeof ym.url === 'string') urlEl.value = ym.url;
      if (Array.isArray(ym.tracks) && ym.tracks.length) renderYmResults(ym.tracks);
    }
  } catch (_) { /* ignore */ }
  try {
    const raw = localStorage.getItem(LS.queue);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    // Accept both the legacy plain-array shape and the new {paused, items} shape.
    const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
    if (parsed && !Array.isArray(parsed)) queuePaused = !!parsed.paused;
    if (!items.length) return;
    for (const it of items) {
      const id = typeof it.id === 'string' ? it.id : ('q-' + (++queueIdSeq));
      const m = id.match(/^q-(\d+)$/);
      if (m) queueIdSeq = Math.max(queueIdSeq, parseInt(m[1], 10));
      downloadQueue.push({
        id,
        source: it.source || 'yandex',
        key: it.key || '',
        artist: it.artist || '',
        title: it.title || '',
        duration: it.duration || '',
        query: it.query || '',
        suggestedName: it.suggestedName || '',
        videoId: it.videoId || '',
        url: it.url || '',
        status: it.status === 'downloading' ? 'queued' : (it.status || 'queued'),
        percent: 0,
        indeterminate: false,
        filePath: it.filePath || '',
        error: it.error || '',
        requestId: '',
      });
    }
    renderQueue();
    // Re-render result rows so any "В очереди" badges reflect the restored queue.
    if (ymTracks && ymTracks.length) renderYmResults(ymTracks);
    if (ytLastResults && ytLastResults.length) renderYtResults(ytLastResults);
    updateQueueTabBadge();
    startQueueWorker();
  } catch (_) { /* ignore */ }
}

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

function pluralTracks(n) { return plural('tracks', n); }

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
  $('playlists-count-label').textContent = `${playlists.length} ${plural('playlists', playlists.length)}`;
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
  $('btn-pl-delete').onclick = () => confirmDelete({
    kind: 'playlist', payload: pl.id,
    title: tr('modal.deletePlaylist.title'),
    text: tr('modal.deletePlaylist.text', { name: pl.name }),
  });
}

// ── Artists ──
// A track's `artist` field may list multiple performers joined by " & ".
// Each side counts as a separate artist; the same track shows up on every
// artist's page. Pure " & " is the only separator (per product spec).
const ARTIST_SEP = /\s*&\s*/;

function splitArtists(s) {
  const unknown = tr('label.unknownArtist');
  if (!s) return [unknown];
  const parts = s.split(ARTIST_SEP).map(p => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [unknown];
}

function artistInitials(name) {
  const stop = new Set(['the', 'of', 'a', 'an', 'and', 'и']);
  const parts = name.split(/\s+/).filter(p => !stop.has(p.toLowerCase()));
  if (parts.length === 0) return (name[0] || '?').toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function pluralAlbums(n) { return plural('albums', n); }
function pluralArtists(n) { return plural('artists', n); }

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
      <span>${a.trackCount} ${escapeHtml(tr('label.tracksShort'))}</span>
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
      byAlbum.push({ album: t.album || tr('label.noAlbum'), year: t.year, cover: t.cover, tracks: [] });
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
        ${escapeHtml(tr('btn.album'))}
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

// ── Track-change animation ──
let trackChangeDirection = 0;   // +1 = next, -1 = prev, 0 = direct pick (fade)
let lastNowPlayingPath = null;
const swapState = new WeakMap();

function cancelSwap(el) {
  const s = swapState.get(el);
  if (!s) return;
  try { s.cloneAnim && s.cloneAnim.cancel(); } catch {}
  try { s.targetAnim && s.targetAnim.cancel(); } catch {}
  if (s.clone && s.clone.parentNode) s.clone.remove();
  swapState.delete(el);
}

function cloneForSwap(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const clone = el.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  const cs = getComputedStyle(el);
  if (cs.backgroundImage && cs.backgroundImage !== 'none') {
    clone.style.backgroundImage = cs.backgroundImage;
  }
  clone.style.position = 'fixed';
  clone.style.left = rect.left + 'px';
  clone.style.top = rect.top + 'px';
  clone.style.width = rect.width + 'px';
  clone.style.height = rect.height + 'px';
  clone.style.margin = '0';
  clone.style.pointerEvents = 'none';
  clone.style.zIndex = '500';
  return { clone, originalEl: el, rect };
}

function animateSwap(snap, direction, kind) {
  if (!snap) return;
  const { clone, originalEl, rect } = snap;
  cancelSwap(originalEl);
  document.body.appendChild(clone);

  let outFrames, inFrames, outDuration, inDuration, inDelay;
  if (kind === 'cover') {
    const dist = Math.max(24, rect.width * 0.28);
    if (direction > 0) {
      outFrames = [{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translateX(${-dist}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateX(${dist}px)`, opacity: 0 }, { transform: 'translate(0,0)', opacity: 1 }];
    } else if (direction < 0) {
      outFrames = [{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translateX(${dist}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateX(${-dist}px)`, opacity: 0 }, { transform: 'translate(0,0)', opacity: 1 }];
    } else {
      outFrames = [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.92)', opacity: 0 }];
      inFrames  = [{ transform: 'scale(1.06)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }];
    }
    outDuration = 320; inDuration = 440; inDelay = 60;
  } else {
    const dy = direction === 0 ? 6 : 12;
    if (direction > 0) {
      outFrames = [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${-dy}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateY(${dy}px)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }];
    } else if (direction < 0) {
      outFrames = [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${dy}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateY(${-dy}px)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }];
    } else {
      outFrames = [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${-dy}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateY(${dy}px)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }];
    }
    outDuration = 240; inDuration = 320; inDelay = 90;
  }

  const cloneAnim = clone.animate(outFrames, {
    duration: outDuration,
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    fill: 'forwards',
  });
  const targetAnim = originalEl.animate(inFrames, {
    duration: inDuration,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'both',
    delay: inDelay,
  });

  const cleanup = () => {
    if (clone.parentNode) clone.remove();
    try { targetAnim.cancel(); } catch {}
    if (swapState.get(originalEl)?.clone === clone) swapState.delete(originalEl);
  };
  Promise.all([cloneAnim.finished, targetAnim.finished]).then(cleanup).catch(cleanup);

  swapState.set(originalEl, { clone, cloneAnim, targetAnim });
}

function updateNowPlayingUI(track) {
  const coverSrc = track.cover || null;
  const isTrackChange = lastNowPlayingPath !== null && lastNowPlayingPath !== track.path;
  const direction = isTrackChange ? trackChangeDirection : 0;
  trackChangeDirection = 0;
  const overlayActive = $('fullscreen-overlay').classList.contains('active');

  // Snapshot previous visuals BEFORE applying new state.
  // When the fullscreen overlay is open, the mini-player is hidden behind it —
  // skip its clones so they don't float over the overlay.
  let snaps = null;
  if (isTrackChange) {
    snaps = {
      miniCover:  overlayActive ? null : cloneForSwap($('mini-cover-wrapper')),
      miniTitle:  overlayActive ? null : cloneForSwap($('track-title')),
      miniArtist: overlayActive ? null : cloneForSwap($('track-artist')),
      fsCover:    overlayActive ? cloneForSwap($('fs-cover'))   : null,
      fsTitle:    overlayActive ? cloneForSwap($('fs-title'))   : null,
      fsArtist:   overlayActive ? cloneForSwap($('fs-artist'))  : null,
      fsAlbum:    overlayActive ? cloneForSwap($('fs-album'))   : null,
    };
  }

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

  if (snaps) {
    animateSwap(snaps.miniCover,  direction, 'cover');
    animateSwap(snaps.miniTitle,  direction, 'text');
    animateSwap(snaps.miniArtist, direction, 'text');
    animateSwap(snaps.fsCover,    direction, 'cover');
    animateSwap(snaps.fsTitle,    direction, 'text');
    animateSwap(snaps.fsArtist,   direction, 'text');
    animateSwap(snaps.fsAlbum,    direction, 'text');
  }
  lastNowPlayingPath = track.path;

  buildWaveforms(track);

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
  syncTray();
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
  $('fs-fav-label').textContent = fav ? tr('btn.favoriteOn') : tr('btn.favorite');
  syncTray();
}

// Push current now-playing snapshot to the main-process tray so it can update
// its menu labels and tooltip. Safe to call before electronAPI is wired.
function syncTray() {
  if (!window.electronAPI || !window.electronAPI.updateTrayState) return;
  const t = currentTrackIndex >= 0 ? library[currentTrackIndex] : null;
  window.electronAPI.updateTrayState({
    hasTrack: !!t,
    isPlaying: !!isPlaying,
    isFavorite: t ? favorites.includes(t.path) : false,
    title: t ? (t.title || '') : '',
    artist: t ? (t.artist || '') : '',
  });
}

if (window.electronAPI && window.electronAPI.onTrayCommand) {
  window.electronAPI.onTrayCommand(({ action }) => {
    switch (action) {
      case 'playPause':      togglePlay(); break;
      case 'next':           nextTrack(); break;
      case 'prev':           prevTrack(); break;
      case 'toggleFavorite': {
        if (currentTrackIndex >= 0) toggleFavorite(library[currentTrackIndex].path);
        break;
      }
    }
  });
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
  trackChangeDirection = 1;
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
  trackChangeDirection = -1;
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

// ── Inline waveform progress bar ──
// The progress bar is rendered as the track's amplitude envelope (like Amberol):
// played bars use --accent, the rest are dim, and hovering shows a seek preview.
// Bar heights are the *real* per-bucket peaks decoded from the audio via the Web
// Audio API (computeRealPeaks), cached per track in wavePeaksCache. While decoding
// — or if decode fails — we fall back to a deterministic seeded envelope keyed off
// the track so the bar always shows something stable instantly.
const WAVE_BARS = 130;

function waveSeededRand(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function waveHashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Build a peaks array (0.06..1) that looks like music: a slow loudness curve
// (intro → build → chorus → outro) modulated by fast bar-to-bar variation.
function waveBuildPeaks(seed, n = WAVE_BARS) {
  const rand = waveSeededRand(seed);
  const peaks = [];
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const intro = Math.min(1, p / 0.08);
    const outro = Math.min(1, (1 - p) / 0.1);
    const body = 0.55 + 0.35 * Math.sin(p * Math.PI * 2.3 - 0.6)
                      + 0.12 * Math.sin(p * Math.PI * 7.1);
    const macro = Math.max(0.18, body) * intro * outro;
    const micro = 0.55 + 0.45 * rand();
    peaks.push(Math.max(0.06, Math.min(1, macro * micro)));
  }
  return peaks;
}

// Decode a track's audio bytes into WAVE_BARS amplitude peaks (0..1). Uses a
// low-rate OfflineAudioContext so decodeAudioData resamples down — we only need
// the loudness envelope, so 8 kHz keeps memory small even for long tracks.
let waveDecodeCtx = null;
async function decodePeaks(arrayBuffer) {
  if (!waveDecodeCtx) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('OfflineAudioContext unavailable');
    waveDecodeCtx = new Ctx(1, 1, 8000);
  }
  const audioBuf = await waveDecodeCtx.decodeAudioData(arrayBuffer);
  const chCount = audioBuf.numberOfChannels;
  const len = audioBuf.length;
  const channels = [];
  for (let c = 0; c < chCount; c++) channels.push(audioBuf.getChannelData(c));

  const peaks = new Float32Array(WAVE_BARS);
  const bucket = Math.max(1, Math.floor(len / WAVE_BARS));
  let globalMax = 0;
  for (let i = 0; i < WAVE_BARS; i++) {
    const start = i * bucket;
    const end = i === WAVE_BARS - 1 ? len : Math.min(len, start + bucket);
    let max = 0;
    for (let j = start; j < end; j++) {
      for (let c = 0; c < chCount; c++) {
        const v = Math.abs(channels[c][j]);
        if (v > max) max = v;
      }
    }
    peaks[i] = max;
    if (max > globalMax) globalMax = max;
  }
  const norm = globalMax > 0 ? 1 / globalMax : 0;
  const out = new Array(WAVE_BARS);
  for (let i = 0; i < WAVE_BARS; i++) {
    // pow(.,0.7) lifts quiet sections so they stay legible; floor keeps silent gaps visible
    out[i] = Math.max(0.05, Math.min(1, Math.pow(peaks[i] * norm, 0.7)));
  }
  return out;
}

function cacheWavePeaks(path, peaks) {
  wavePeaksCache[path] = peaks;
  const keys = Object.keys(wavePeaksCache);
  if (keys.length > WAVE_CACHE_MAX) delete wavePeaksCache[keys[0]];
  saveWavePeaks();
}

// Decode real peaks for a track in the background, then repaint if it's still
// the current track. Deduped via wavePeaksInFlight so re-plays don't re-decode.
const wavePeaksInFlight = new Set();
async function computeRealPeaks(track) {
  const p = track.path;
  if (!p || wavePeaksCache[p] || wavePeaksInFlight.has(p)) return;
  if (!window.electronAPI || !window.electronAPI.readAudioFile) return;
  wavePeaksInFlight.add(p);
  try {
    const bytes = await window.electronAPI.readAudioFile(p); // Uint8Array
    // decodeAudioData detaches the buffer, so hand it a standalone copy
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const peaks = await decodePeaks(ab);
    cacheWavePeaks(p, peaks);
    if (lastNowPlayingPath === p) {
      playbarWave.setPeaks(peaks, p + ':real');
      fsWave.setPeaks(peaks, p + ':real');
    }
  } catch (e) {
    console.warn('Waveform decode failed for', p, e);
  } finally {
    wavePeaksInFlight.delete(p);
  }
}

// Controller bound to a container element; manages bar DOM + paint state.
function makeWave(containerEl) {
  let bars = [];
  let progress = 0;   // 0..100
  let hover = null;   // 0..100 seek-preview position, or null
  let builtKey = null;

  function setPeaks(peaks, key) {
    if (key === builtKey) return;
    builtKey = key;
    containerEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    bars = peaks.map((h) => {
      const b = document.createElement('div');
      b.className = 'wave-bar';
      b.style.height = `${Math.round(h * 100)}%`;
      frag.appendChild(b);
      return b;
    });
    containerEl.appendChild(frag);
    paint();
  }

  function paint() {
    const n = bars.length;
    if (!n) return;
    for (let i = 0; i < n; i++) {
      const pct = (i + 0.5) / n * 100;
      const played = pct <= progress;
      const inPreview = hover != null && pct > progress && pct <= hover;
      const b = bars[i];
      b.classList.toggle('played', played);
      b.classList.toggle('preview', inPreview);
    }
  }

  function setProgress(p) {
    if (p === progress) return;
    progress = p;
    paint();
  }
  function setHover(h) {
    if (h === hover) return;
    hover = h;
    paint();
  }

  // Hover preview: highlight where a click would seek to.
  containerEl.addEventListener('mousemove', (e) => {
    const rect = containerEl.getBoundingClientRect();
    setHover(Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100)));
  });
  containerEl.addEventListener('mouseleave', () => setHover(null));

  return { setPeaks, setProgress, setHover };
}

const playbarWave = makeWave($('progress-track'));
const fsWave = makeWave($('fs-progress-track'));

function buildWaveforms(track) {
  const p = track.path;
  const real = wavePeaksCache[p];
  if (real) {
    playbarWave.setPeaks(real, p + ':real');
    fsWave.setPeaks(real, p + ':real');
  } else {
    // show the synthetic shape immediately, then decode real peaks in the background
    const syn = waveBuildPeaks(waveHashStr((track.title || '') + (track.artist || '')));
    playbarWave.setPeaks(syn, p + ':syn');
    fsWave.setPeaks(syn, p + ':syn');
    computeRealPeaks(track);
  }
}

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
    playbarWave.setProgress(pct);
    fsWave.setProgress(pct);
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
wireVolume($('fs-vol-track'));

function updateVolumeUI() {
  const v = audio.muted ? 0 : audio.volume;
  const pct = `${v * 100}%`;
  $('vol-fill').style.width = pct;
  const fsFill = $('fs-vol-fill');
  if (fsFill) fsFill.style.width = pct;
  const icon = audio.muted || v === 0 ? '#i-volume-mute'
    : v < 0.5 ? '#i-volume-low'
    : '#i-volume';
  $('btn-mute').querySelector('use').setAttribute('href', icon);
  const fsMute = $('fs-btn-mute');
  if (fsMute) fsMute.querySelector('use').setAttribute('href', icon);
}
function toggleMute() {
  audio.muted = !audio.muted;
  updateVolumeUI();
}
$('btn-mute').addEventListener('click', toggleMute);
const fsMuteBtn = $('fs-btn-mute');
if (fsMuteBtn) fsMuteBtn.addEventListener('click', toggleMute);
audio.volume = 1;
updateVolumeUI();

// ── Fullscreen ──
let fsAnimating = false;
let fsCoverAnim = null;

function flipCover(direction) {
  const mini = $('mini-cover-wrapper');
  const big = $('fs-cover');
  const mr = mini.getBoundingClientRect();
  const br = big.getBoundingClientRect();
  if (!mr.width || !br.width) return null;
  const dx = (mr.left + mr.width / 2) - (br.left + br.width / 2);
  const dy = (mr.top + mr.height / 2) - (br.top + br.height / 2);
  const sx = mr.width / br.width;
  const sy = mr.height / br.height;
  const small = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  const frames = direction === 'in'
    ? [{ transform: small }, { transform: 'translate(0, 0) scale(1, 1)' }]
    : [{ transform: 'translate(0, 0) scale(1, 1)' }, { transform: small }];
  return big.animate(frames, {
    duration: direction === 'in' ? 480 : 360,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'both',
  });
}

function cancelCoverAnim() {
  if (fsCoverAnim) { try { fsCoverAnim.cancel(); } catch {} }
  fsCoverAnim = null;
}

function openFullscreen() {
  if (currentTrackIndex < 0 || fsAnimating) return;
  const overlay = $('fullscreen-overlay');
  if (overlay.classList.contains('active')) return;
  fsAnimating = true;
  cancelCoverAnim();
  overlay.classList.add('active');
  updateFullscreenQueue();
  // Force layout so getBoundingClientRect returns measurable values for FLIP.
  void overlay.offsetHeight;
  $('mini-cover-wrapper').classList.add('is-morphing');
  fsCoverAnim = flipCover('in');
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  const done = () => {
    cancelCoverAnim();
    fsAnimating = false;
    $('mini-cover-wrapper').classList.remove('is-morphing');
  };
  if (fsCoverAnim) fsCoverAnim.finished.then(done).catch(done);
  else done();
}

function closeFullscreen() {
  const overlay = $('fullscreen-overlay');
  if (!overlay.classList.contains('active') || fsAnimating) return;
  // Exiting fullscreen also exits portrait — the rest of the UI has min-width
  // constraints (sidebar etc.) and looks broken in a phone-sized window.
  if (portraitMode) setPortraitMode(false);
  fsAnimating = true;
  cancelCoverAnim();
  overlay.classList.remove('is-in');
  $('mini-cover-wrapper').classList.add('is-morphing');
  fsCoverAnim = flipCover('out');
  const done = () => {
    cancelCoverAnim();
    overlay.classList.remove('active');
    fsAnimating = false;
    $('mini-cover-wrapper').classList.remove('is-morphing');
  };
  if (fsCoverAnim) fsCoverAnim.finished.then(done).catch(done);
  else setTimeout(done, 320);
}

let portraitMode = false;
let portraitAnimating = false;

// FLIP morph between desktop and portrait layouts.
//   1. Capture cover rect (FIRST). Hide cover so the user never sees it snap.
//   2. Swap .is-portrait + ask main to resize the window. Wait for the IPC and
//      one frame so the new layout is settled.
//   3. Measure cover rect (LAST), compute the inverse translate+scale, apply
//      it as a transform, reveal the cover — it's now visually back where it
//      started but ready to glide to its new spot.
//   4. Animate the transform to identity. The surrounding content fades out
//      via .is-morphing and back in 140ms later, hiding the layout shift.
async function setPortraitMode(on) {
  on = !!on;
  if (portraitAnimating || on === portraitMode) return;
  portraitAnimating = true;
  portraitMode = on;

  const overlay = $('fullscreen-overlay');
  const cover = $('fs-cover');
  const btn = $('btn-fs-portrait');

  const first = cover.getBoundingClientRect();

  // Hide the cover before any layout change so the user doesn't see it snap
  // to its new position while we wait for the window to resize. We'll re-show
  // it once the FLIP transform has been applied.
  cover.style.visibility = 'hidden';

  overlay.classList.add('is-morphing');
  overlay.classList.toggle('is-portrait', on);
  if (btn) btn.classList.toggle('is-active', on);

  try {
    if (window.electronAPI && window.electronAPI.setPortrait) {
      await window.electronAPI.setPortrait(on);
    }
  } catch (_) { /* ignore */ }
  // One frame so Chromium picks up the new window size and reflows.
  await new Promise(r => requestAnimationFrame(r));

  // Force a layout pass so the new rect is measurable on this frame.
  void overlay.offsetHeight;
  const last = cover.getBoundingClientRect();

  const sx = first.width / Math.max(1, last.width);
  const sy = first.height / Math.max(1, last.height);
  const dx = first.left - last.left;
  const dy = first.top - last.top;

  const startTransform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

  // Pre-apply the FLIP transform via inline style BEFORE revealing the cover —
  // it's visually back at its starting position when the user sees it again.
  cover.style.transformOrigin = 'top left';
  cover.style.transform = startTransform;
  cover.style.visibility = '';
  void cover.offsetHeight;

  const dur = 420;
  const ease = 'cubic-bezier(0.32, 0.72, 0.18, 1)';
  const coverAnim = cover.animate([
    { transform: startTransform, transformOrigin: 'top left' },
    { transform: 'none', transformOrigin: 'top left' },
  ], { duration: dur, easing: ease, fill: 'both' });

  // Fade the surrounding content back in slightly after the cover starts
  // moving so the new layout reveals smoothly rather than all at once.
  setTimeout(() => overlay.classList.remove('is-morphing'), 140);

  try { await coverAnim.finished; } catch (_) { /* ignore cancellations */ }
  try { coverAnim.cancel(); } catch (_) {}
  cover.style.transform = '';
  cover.style.transformOrigin = '';
  overlay.classList.remove('is-morphing');
  portraitAnimating = false;
}
function togglePortraitMode() { setPortraitMode(!portraitMode); }

$('mini-cover-wrapper').addEventListener('click', openFullscreen);
$('btn-fullscreen').addEventListener('click', openFullscreen);
$('btn-close-fullscreen').addEventListener('click', closeFullscreen);
$('btn-close-fullscreen-x').addEventListener('click', closeFullscreen);
const fsPortraitBtn = $('btn-fs-portrait');
if (fsPortraitBtn) fsPortraitBtn.addEventListener('click', togglePortraitMode);

function updateFullscreenQueue() {
  const list = $('fs-queue-list');
  list.innerHTML = '';
  const curPath = currentTrackIndex >= 0 ? library[currentTrackIndex].path : null;
  const idx = currentQueue.findIndex(t => t.path === curPath);
  const upcoming = currentQueue.slice(idx + 1, idx + 1 + 8);
  $('fs-queue-count').textContent = tr('fs.queueAhead', { n: upcoming.length });
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
  $('confirm-title').textContent = title || tr('modal.deleteTrack.title');
  $('confirm-text').textContent = text || tr('modal.deleteTrack.text');
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
    alert(tr('error.deleteFile') + (res && res.error ? res.error : tr('error.unknown')));
    return;
  }
  library.splice(idx, 1);
  if (currentTrackIndex === idx) {
    audio.pause();
    isPlaying = false;
    currentTrackIndex = -1;
    $('track-title').textContent = tr('np.empty.title');
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
    list.innerHTML = `<div class="sl-empty">${escapeHtml(tr('modal.addToPlaylist.empty'))}</div>`;
  } else {
    playlists.forEach(pl => {
      const el = document.createElement('div');
      el.className = 'sl-item';
      const has = pl.trackPaths.includes(trackPath);
      el.innerHTML = `${escapeHtml(pl.name)} ${has ? `<span style="color:var(--accent-ok);font-size:11px;margin-left:6px">${escapeHtml(tr('modal.addToPlaylist.alreadyAdded'))}</span>` : ''}`;
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
  $('cm-fav-label').textContent = favorites.includes(path) ? tr('btn.unfavorite') : tr('btn.favorite');
  $('cm-remove-from-pl').hidden = !(currentView === 'playlist-detail' && activePlaylistId);
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
    else if (action === 'remove-from-playlist') {
      const pl = playlists.find(p => p.id === activePlaylistId);
      if (pl) {
        pl.trackPaths = pl.trackPaths.filter(p => p !== path);
        savePlaylists();
        renderPlaylistDetail(activePlaylistId);
        renderCounts();
      }
    }
    else if (action === 'delete') confirmDelete({
      kind: 'track', payload: path,
      title: tr('modal.deleteTrack.title'),
      text: tr('modal.deleteTrackFull.text', { title: track.title, artist: track.artist }),
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
    $('editor-cover-tag').textContent = tr('editor.coverEmbed');
  } else {
    cover.style.backgroundImage = '';
    $('editor-cover-letter').textContent = (meta.title || '?')[0];
    $('editor-cover-tag').textContent = tr('editor.noCover');
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
  status.textContent = tr('editor.saving');
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
    status.textContent = tr('editor.saved');
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
    status.textContent = res.error || tr('editor.errorSave');
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
    lbl.textContent = tr('palette.tracks');
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
        <span class="palette-item-hint">${escapeHtml(tr('palette.itemHint'))}</span>
      `;
      el.addEventListener('click', () => runPaletteAction(paletteResults[+el.dataset.idx]));
      container.appendChild(el);
    });
  }

  // Actions
  const actions = [
    { label: tr('palette.action.openFiles'),       kind: 'open-files',      icon: '#i-folder' },
    { label: tr('palette.action.gotoSettings'),    kind: 'goto-settings',   icon: '#i-settings' },
    { label: tr('palette.action.gotoPlaylists'),   kind: 'goto-playlists',  icon: '#i-list' },
    { label: tr('palette.action.gotoFavorites'),   kind: 'goto-favorites',  icon: '#i-heart' },
  ].filter(a => !q || a.label.toLowerCase().includes(q));
  if (actions.length > 0) {
    const lbl = document.createElement('div');
    lbl.className = 'palette-section-label';
    lbl.textContent = tr('palette.actions');
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
    container.innerHTML = `<div class="palette-empty">${escapeHtml(tr('palette.empty'))}</div>`;
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
    if ($('fullscreen-overlay').classList.contains('active')) closeFullscreen();
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

const SORT_I18N = {
  'date-desc': 'sort.dateDesc',
  'date-asc': 'sort.dateAsc',
  'title-asc': 'sort.titleAsc',
  'title-desc': 'sort.titleDesc',
  'artist-asc': 'sort.artistAsc',
  'artist-desc': 'sort.artistDesc',
  'duration-asc': 'sort.durationAsc',
  'duration-desc': 'sort.durationDesc',
};
function refreshSortUI() {
  const labelEl = $('sort-label');
  if (labelEl) {
    const key = SORT_I18N[activeSort] || SORT_I18N['date-desc'];
    labelEl.setAttribute('data-i18n', key);
    labelEl.textContent = tr(key);
  }
  document.querySelectorAll('#sort-select .sort-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.sort === activeSort);
  });
}
const sortSelect = $('sort-select');
if (sortSelect) {
  sortSelect.querySelector('.sort-btn').addEventListener('click', e => {
    e.stopPropagation();
    sortSelect.classList.toggle('open');
  });
  sortSelect.querySelectorAll('.sort-opt').forEach(o => {
    o.addEventListener('click', () => {
      activeSort = o.dataset.sort;
      sortSelect.classList.remove('open');
      refreshSortUI();
      renderLibrary();
    });
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#sort-select')) sortSelect.classList.remove('open');
  });
  refreshSortUI();
}

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
const TOGGLE_KEY_MAP = {
  'scan-subdirs': 'scanSubdirs',
  'downloads': 'downloads',
  'show-parser-browser': 'showParserBrowser',
};

function renderAccentPalette() {
  const host = $('accent-palette');
  if (!host) return;
  const current = (settings.accent || '').toLowerCase();
  const presetValues = new Set(ACCENT_PRESETS.map(p => p.value.toLowerCase()));
  const isCustom = !!current && !presetValues.has(current);
  const parts = ACCENT_PRESETS.map(p => {
    const isActive = p.value.toLowerCase() === current;
    const cls = ['accent-swatch'];
    if (isActive) cls.push('active');
    if (p.value === '') cls.push('is-default');
    const style = p.value ? `background:${escapeHtml(p.value)};` : '';
    const title = p.value === ''
      ? tr('setting.accentDefault')
      : escapeHtml(p.value);
    return `<button type="button" class="${cls.join(' ')}" data-accent="${escapeHtml(p.value)}" style="${style}" title="${title}" aria-label="${title}"></button>`;
  });
  const customColor = isCustom ? current : '#5b9eff';
  const customCls = ['accent-swatch', 'is-custom'];
  if (isCustom) customCls.push('active');
  parts.push(
    `<span class="${customCls.join(' ')}" title="${escapeHtml(tr('setting.accentCustom'))}" aria-label="${escapeHtml(tr('setting.accentCustom'))}">` +
      `<input type="color" class="accent-custom-input" id="accent-custom-input" value="${escapeHtml(customColor)}">` +
    `</span>`
  );
  host.innerHTML = parts.join('');
  host.querySelectorAll('.accent-swatch[data-accent]').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.accent = btn.dataset.accent || '';
      saveSettings();
      applyAccent(settings.accent);
      renderAccentPalette();
    });
  });
  const customInput = $('accent-custom-input');
  if (customInput) {
    customInput.addEventListener('input', (e) => {
      const v = e.target.value;
      if (isHexColor(v)) {
        settings.accent = v;
        applyAccent(settings.accent);
      }
    });
    customInput.addEventListener('change', (e) => {
      const v = e.target.value;
      if (isHexColor(v)) {
        settings.accent = v;
        saveSettings();
        applyAccent(settings.accent);
        renderAccentPalette();
      }
    });
  }
}

function renderSettings() {
  // Theme combobox
  const themeCurrent = $('theme-current');
  if (themeCurrent) themeCurrent.textContent = themeLabel(settings.theme);
  document.querySelectorAll('#theme-select .select-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.theme === settings.theme);
  });
  renderAccentPalette();
  // Toggles
  document.querySelectorAll('.toggle').forEach(t => {
    const key = TOGGLE_KEY_MAP[t.dataset.setting];
    if (!key) return; // toggles with their own handler (e.g. hardware acceleration)
    if (settings[key]) t.classList.add('on'); else t.classList.remove('on');
  });
  refreshHwAccelToggle();
  // Folder
  $('default-folder-path').textContent = settings.defaultFolder || tr('placeholder.noFolder');
  // Language — labels stay in their native language regardless of currentLang.
  const lblMap = { ru: 'Русский', en: 'English', de: 'Deutsch', fr: 'Français', uk: 'Українська' };
  $('lang-current').textContent = lblMap[settings.language] || lblMap.en;
  document.querySelectorAll('#lang-select .select-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.lang === settings.language);
  });
  // UI scale stepper
  const scaleEl = $('scale-current');
  if (scaleEl) scaleEl.textContent = Math.round(settings.uiScale * 100) + '%';
  const dec = $('scale-dec');
  const inc = $('scale-inc');
  if (dec) dec.disabled = settings.uiScale <= UI_SCALE_STEPS[0] + 1e-6;
  if (inc) inc.disabled = settings.uiScale >= UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1] - 1e-6;
}

const themeSelect = $('theme-select');
themeSelect.querySelector('.select-btn').addEventListener('click', e => {
  e.stopPropagation();
  themeSelect.classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('#theme-select')) themeSelect.classList.remove('open');
});
document.querySelectorAll('#theme-select .select-opt').forEach(o => {
  o.addEventListener('click', () => {
    settings.theme = o.dataset.theme;
    saveSettings();
    themeSelect.classList.remove('open');
    applyTheme(settings.theme);
    renderSettings();
  });
});
document.querySelectorAll('.toggle').forEach(t => {
  const key = TOGGLE_KEY_MAP[t.dataset.setting];
  if (!key) return; // toggles with their own handler (e.g. hardware acceleration)
  t.addEventListener('click', () => {
    if (t.classList.contains('is-disabled')) return;
    settings[key] = !settings[key];
    saveSettings();
    t.classList.toggle('on', settings[key]);
    if (key === 'downloads') applyDownloadsVisibility();
  });
});

// ── Hardware acceleration toggle ──
// State lives in the main process (a marker file read before app.ready), not in
// localStorage. We query it for display and ask main to persist + restart.
async function refreshHwAccelToggle() {
  const t = $('toggle-hwaccel');
  if (!t || !window.electronAPI || typeof window.electronAPI.getHardwareAcceleration !== 'function') return;
  try {
    const res = await window.electronAPI.getHardwareAcceleration();
    t.classList.toggle('on', !!(res && res.enabled));
  } catch (_) { /* leave as-is */ }
}
const hwAccelToggle = $('toggle-hwaccel');
if (hwAccelToggle) {
  hwAccelToggle.addEventListener('click', async () => {
    if (hwAccelToggle.classList.contains('is-disabled')) return;
    const enabled = !hwAccelToggle.classList.contains('on');
    hwAccelToggle.classList.toggle('on', enabled);
    try {
      await window.electronAPI.setHardwareAcceleration(enabled);
    } catch (_) { /* if it failed, re-sync from the source of truth */ }
    // If the user declined the restart, the visible state still reflects the
    // pending choice; re-sync to the actual effective state on next render.
  });
}
$('btn-choose-default-folder').addEventListener('click', async () => {
  const folder = await window.electronAPI.chooseFolder();
  if (folder) {
    settings.defaultFolder = folder;
    saveSettings();
    renderSettings();
  }
});

document.querySelectorAll('[data-open-url]').forEach(btn => {
  btn.addEventListener('click', () => {
    const url = btn.dataset.openUrl;
    if (url) window.electronAPI.openExternal(url);
  });
});

function setUiScale(scale) {
  settings.uiScale = clampUiScale(scale);
  saveSettings();
  applyUiScale(settings.uiScale);
  renderSettings();
}
function nudgeUiScale(direction) {
  // Snap to the nearest predefined step in the chosen direction so the stepper
  // matches the labels users see in the dropdown.
  const cur = settings.uiScale;
  if (direction > 0) {
    const next = UI_SCALE_STEPS.find(s => s > cur + 1e-6);
    if (next != null) setUiScale(next);
  } else {
    const prev = [...UI_SCALE_STEPS].reverse().find(s => s < cur - 1e-6);
    if (prev != null) setUiScale(prev);
  }
}
const scaleDec = $('scale-dec');
const scaleInc = $('scale-inc');
const scaleReset = $('scale-reset');
if (scaleDec) scaleDec.addEventListener('click', () => nudgeUiScale(-1));
if (scaleInc) scaleInc.addEventListener('click', () => nudgeUiScale(1));
if (scaleReset) scaleReset.addEventListener('click', () => setUiScale(1));
const langSelect = $('lang-select');
langSelect.querySelector('.select-btn').addEventListener('click', e => {
  e.stopPropagation();
  langSelect.classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('#lang-select')) langSelect.classList.remove('open');
});
document.querySelectorAll('#lang-select .select-opt').forEach(o => {
  o.addEventListener('click', () => {
    settings.language = o.dataset.lang;
    saveSettings();
    langSelect.classList.remove('open');
    applyLanguage(settings.language);
    // Re-render dynamic surfaces so plurals, counts, and rendered strings update.
    refreshCurrentViewRows();
    if (currentView === 'playlists') renderPlaylists();
    renderCounts();
    renderRecents();
    if (currentTrackIndex >= 0) updateNowPlayingUI(library[currentTrackIndex]);
    else $('track-title').textContent = tr('np.empty.title');
    updateFullscreenQueue();
    if ($('palette-overlay').classList.contains('active')) {
      renderPaletteResults($('palette-input').value);
    }
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

// On startup, pull tracks from the app's own downloads folder ("Audex Downloads")
// and, if the user has set one, from their default folder. This keeps the library
// in sync with both sources without requiring manual import.
async function rescanOnBoot() {
  const folders = [];
  try {
    const downloadsDir = await window.electronAPI.getDownloadsDir();
    if (downloadsDir) folders.push(downloadsDir);
  } catch (_) { /* ignore */ }
  if (settings.defaultFolder && !folders.includes(settings.defaultFolder)) {
    folders.push(settings.defaultFolder);
  }
  for (const folder of folders) {
    try {
      const files = await window.electronAPI.scanFolder(folder);
      if (files && files.length > 0) await importPaths(files);
    } catch (_) { /* ignore */ }
  }
}

// ── Update check ──
// Asks the main process whether a newer GitHub release exists and, if so,
// shows the in-app banner. The banner is suppressed for the rest of the day
// once the user closes it (keyed by version + date), so it reappears the next
// day — and immediately for any newer version.
function updateTodayStr() {
  return new Date().toISOString().slice(0, 10);
}
function getUpdateDismiss() {
  try { return JSON.parse(localStorage.getItem(LS.updateDismiss)) || {}; }
  catch (_) { return {}; }
}
function showUpdateBanner(info) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  const versionEl = document.getElementById('update-banner-version');
  if (versionEl) versionEl.textContent = 'v' + info.latestVersion;
  const dlBtn = document.getElementById('update-download-btn');
  if (dlBtn) dlBtn.onclick = () => {
    if (info.url) window.electronAPI.openExternal(info.url);
  };
  const closeBtn = document.getElementById('update-close-btn');
  if (closeBtn) closeBtn.onclick = () => {
    banner.hidden = true;
    try {
      localStorage.setItem(LS.updateDismiss, JSON.stringify({
        version: info.latestVersion,
        date: updateTodayStr(),
      }));
    } catch (_) { /* ignore */ }
  };
  banner.hidden = false;
}
async function checkForUpdates() {
  if (!window.electronAPI || typeof window.electronAPI.checkForUpdate !== 'function') return;
  let info;
  try { info = await window.electronAPI.checkForUpdate(); }
  catch (_) { return; }
  if (!info || !info.success || !info.hasUpdate) return;
  const dismissed = getUpdateDismiss();
  if (dismissed.version === info.latestVersion && dismissed.date === updateTodayStr()) return;
  showUpdateBanner(info);
}

// Boot
applyLanguage(settings.language);
renderSettings();
renderLibrary();
renderRecents();
updateShuffleUI();
updateRepeatUI();
loadLastTrack();
restoreCovers();
restoreDownloadsState();
rescanOnBoot();
checkForUpdates();
