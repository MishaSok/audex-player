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
  ytmState: 'audex-dl-ytm-state',
  spState: 'audex-dl-sp-state',
  queue: 'audex-dl-queue',
  wavePeaks: 'audex-wave-peaks',
  playLog: 'audex-play-log',
  qualityCache: 'audex-quality-cache',
  healthReport: 'audex-health-report',
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
  healthCheck: false,
  reports: false,
  downloads: false,
  showParserBrowser: true,
  uiScale: 1,
}, JSON.parse(localStorage.getItem(LS.settings) || '{}'));
let recents = JSON.parse(localStorage.getItem(LS.recents) || '[]');

// ── Discord Rich Presence ──
// Paste your Discord Application Client ID here (https://discord.com/developers
// → New Application → copy the Application ID). Until it's set, the integration
// stays inert: the Settings panel shows but "Connect" reports a missing ID.
// Album covers are resolved as public https URLs from the iTunes Search API and
// passed straight into the activity's large_image — no art-asset upload needed.
const DISCORD_CLIENT_ID = '1518146518392115271';
// Public fallback image used as the activity's large_image when iTunes can't
// resolve an album cover (no match). Served raw from the project repo.
const AUDEX_LOGO_URL = 'https://raw.githubusercontent.com/MishaSok/audex-player/main/build/icons/512x512.png';
// Nested Discord prefs (shallow-merge above doesn't deep-merge, so normalize).
const DISCORD_DEFAULTS = {
  enabled: false,
  showTitle: true,
  showArtist: true,
  showCover: true,
  showTimer: true,
  showPaused: false,
  privacyInvisible: true,
  privacyPrivate: false,
  buttons: [
    { label: 'GitHub', url: 'https://github.com/MishaSok/audex-player' },
    { label: 'Найти на YouTube', url: '' },
  ],
};
settings.discord = Object.assign({}, DISCORD_DEFAULTS, settings.discord || {});
if (!Array.isArray(settings.discord.buttons)) settings.discord.buttons = DISCORD_DEFAULTS.buttons.map(b => ({ ...b }));
// One-time relabel of the old placeholder button to a clear GitHub link. Only
// matches the exact legacy default, so it never overrides a user's own edits
// and is idempotent (after relabel it no longer matches).
(function migrateDiscordGithubButton() {
  const b0 = settings.discord.buttons[0];
  if (b0 && b0.label === 'Слушать в Audex' && b0.url === 'https://github.com/MishaSok/audex-player') {
    b0.label = 'GitHub';
    saveSettings();
  }
})();
let discordConnected = false;
let discordUser = null;

const coverCache = {};
let library = libraryMeta.map(t => ({ ...t, cover: coverCache[t.path] || null }));

// Backfill `addedAt` for tracks imported before the Listening Report shipped.
// Their real add-date is unknown, so we stamp a fixed past sentinel (1 = just
// after the epoch): they count toward the all-time "Added to collection" stat
// (window starts at 0) without inflating the day/month/year periods.
(function backfillLegacyAddedAt() {
  let changed = false;
  for (const t of library) {
    if (!t.addedAt) { t.addedAt = 1; changed = true; }
  }
  if (changed) saveLibrary();
})();

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

// Play history for the on-device Listening Report. Each entry:
// { t: startTs(ms), p: path, n: title, a: artist, b: album, s: seconds listened }.
// Capped in count and age so it can't grow unbounded (see savePlayLog / plPush).
const PLAYLOG_MAX = 4000;
const PLAYLOG_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months
let playLog = (() => {
  try {
    const arr = JSON.parse(localStorage.getItem(LS.playLog) || '[]');
    const cutoff = Date.now() - PLAYLOG_MAX_AGE_MS;
    return Array.isArray(arr) ? arr.filter(e => e && e.t >= cutoff) : [];
  } catch (_) { return []; }
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
function savePlayLog() {
  try {
    if (playLog.length > PLAYLOG_MAX) playLog = playLog.slice(-PLAYLOG_MAX);
    localStorage.setItem(LS.playLog, JSON.stringify(playLog));
  } catch (e) {
    console.warn('play log save failed:', e);
  }
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
    'nav.report': 'Отчёт',
    'report.onDevice': 'Считается на устройстве',
    'report.eyebrow': 'Отчёт о прослушивании',
    'report.period.day': 'День',
    'report.period.week': 'Неделя',
    'report.period.month': 'Месяц',
    'report.period.year': 'Год',
    'report.period.all': 'Всё время',
    'report.allTime': 'За всё время',
    'report.today': 'Сегодня',
    'report.thisWeek': 'Эта неделя',
    'report.listeningTime': 'Время прослушивания',
    'report.vsPrev': 'к прошлому периоду',
    'report.tracksPlayed': 'Треков сыграно',
    'report.artists': 'Исполнителей',
    'report.added': 'Добавлено в коллекцию',
    'report.streak': 'Серия прослушиваний',
    'report.days': 'дней',
    'report.whenListen': 'Когда ты слушаешь',
    'report.topArtists': 'Топ-исполнители',
    'report.topTracks': 'Топ-треки',
    'report.plays': 'просл.',
    'report.minUnit': 'мин',
    'report.hoursUnit': 'часов',
    'report.hShort': 'ч',
    'report.mShort': 'м',
    'report.empty.title': 'Здесь появится твоя статистика',
    'report.empty.text': 'Слушай музыку — отчёт соберётся из истории прослушивания на этом устройстве.',
    'table.quality': 'Качество',
    'quality.kbps': 'кбит/с',
    'quality.note': 'Бейдж качества у каждого трека · ',
    'quality.noteAmber': 'янтарный = подозрительная перекодировка',
    'quality.cutoffMarker': 'срез',
    'health.khz': 'кГц',
    'nav.health': 'Состояние',
    'health.crumb': 'Состояние библиотеки',
    'health.lastScan': 'Последняя проверка:',
    'health.never': 'ещё не проверялось',
    'health.rescan': 'Пересканировать',
    'health.scanning': 'Проверка {n} из {m}…',
    'health.scoreLabel': 'Здоровье коллекции',
    'health.ok': 'в порядке',
    'health.okLegend': 'в порядке',
    'health.flaggedLegend': 'требуют внимания',
    'health.transcodeTitle': 'Похоже на перекодировку',
    'health.claimed': 'Заявлено',
    'health.real': 'реально ≈',
    'health.spectrumCaption': 'Спектр обрывается на {cut} кГц, хотя высокий битрейт держит частоты до ~20 кГц.{lame}',
    'health.noLame': ' LAME-тег отсутствует.',
    'health.issuesLabel': 'Найденные проблемы',
    'health.show': 'Показать',
    'health.fix': 'Починить',
    'health.allGood': 'Проблем не найдено',
    'health.allGoodText': 'Коллекция в отличном состоянии.',
    'health.noData': 'Запусти проверку, чтобы оценить состояние библиотеки.',
    'health.analyzing': 'Анализ спектра…',
    'health.filterNote': 'Результат проверки: {label}',
    'health.clearFilter': 'Сбросить',
    'issue.transcode.title': 'Подозрительная перекодировка',
    'issue.transcode.desc': 'Битрейт заявлен высоким, но спектр обрывается рано — вероятно, перекодировано из низкого качества.',
    'issue.lowbitrate.title': 'Низкий битрейт (< 192 кбит/с)',
    'issue.lowbitrate.desc': 'Файлы 128 кбит/с и ниже. Можно заменить на версии получше.',
    'issue.nocover.title': 'Без обложки',
    'issue.nocover.desc': 'Треки без встроенного изображения альбома.',
    'issue.tags.title': 'Неполные теги',
    'issue.tags.desc': 'Пустые поля исполнителя, альбома или года.',
    'issue.dupes.title': 'Возможные дубликаты',
    'issue.dupes.desc': 'Совпадают исполнитель и название при разных файлах.',
    'section.discord': 'Discord Rich Presence',
    'discord.subtitle': 'Показывайте друзьям, что вы слушаете, прямо в профиле Discord — с обложкой, таймером и кнопками для перехода к треку.',
    'discord.statusConnected': 'Подключено',
    'discord.statusDisconnected': 'Не подключено',
    'discord.connect': 'Подключить Discord',
    'discord.disconnect': 'Отключить',
    'discord.connectHint': 'Свяжите аккаунт, чтобы транслировать прослушивание в профиль.',
    'discord.sessionActive': 'сессия активна',
    'discord.connecting': 'Подключение…',
    'discord.connectError': 'Не удалось подключиться. Убедитесь, что Discord запущен.',
    'discord.waitingForDiscord': 'Discord не запущен — подключусь автоматически, когда он откроется.',
    'discord.noClientId': 'Не задан Discord Client ID. Укажите его в DISCORD_CLIENT_ID в renderer.js.',
    'discord.show': 'Что показывать',
    'discord.showTitle': 'Название трека',
    'discord.showTitleDesc': 'Основная строка активности.',
    'discord.showArtist': 'Исполнитель и альбом',
    'discord.showArtistDesc': 'Вторая строка под названием.',
    'discord.showCover': 'Обложка альбома',
    'discord.showCoverDesc': 'Большое изображение карточки.',
    'discord.showTimer': 'Таймер трека',
    'discord.showTimerDesc': 'Прошедшее и общее время с прогрессом.',
    'discord.showPaused': 'Показывать на паузе',
    'discord.showPausedDesc': 'Оставлять статус, когда воспроизведение остановлено.',
    'discord.buttons': 'Кнопки на профиле',
    'discord.buttonsHint': 'Discord допускает не более двух кнопок в активности. Ссылки должны начинаться с http(s)://',
    'discord.btnLabel': 'Подпись',
    'discord.btnUrl': 'Ссылка',
    'discord.btnLabelPh': 'Текст кнопки',
    'discord.btnUrlPh': 'https://…',
    'discord.privacy': 'Приватность',
    'discord.privacyInvisible': 'Скрывать в режиме «Невидимый»',
    'discord.privacyInvisibleDesc': 'Не транслировать статус, когда вы оффлайн в Discord.',
    'discord.privacyPrivate': 'Отключать для приватных плейлистов',
    'discord.privacyPrivateDesc': 'Треки из закрытых плейлистов не попадут в профиль.',
    'discord.preview': 'Как видят друзья',
    'discord.previewListening': 'Слушает Audex',
    'discord.previewPaused': 'Слушал · на паузе',
    'discord.previewPlaceholder': 'Статус появится в профиле после подключения Discord',
    'discord.previewNote': 'Карточка обновляется в реальном времени при смене трека, паузе и перемотке.',
    'discord.previewOnline': 'В сети',
    'discord.previewEmptyTrack': 'Ничего не играет',
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
    'select.enter': 'Выбрать',
    'select.count': 'Выбрано: {n}',
    'select.all': 'Выбрать все',
    'modal.deleteTracks.title': 'Удалить выбранные треки?',
    'modal.deleteTracks.text': '{count} будет удалено из библиотеки, а файлы — перемещены в корзину.',
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
    'downloads.parsing.subtab.ytmusic': 'YouTube Music',
    'downloads.ytm.urlPlaceholder': 'https://music.youtube.com/playlist?list=…',
    'downloads.ytm.hint': 'Ссылка на альбом, сингл или исполнителя из YouTube Music. Логин и браузер не нужны.',
    'downloads.ytm.idle.title': 'Парсинг YouTube Music',
    'downloads.ytm.idle.text': 'Вставьте ссылку на альбом, сингл или страницу исполнителя из YouTube Music. Приложение соберёт список треков, и вы сможете скачать любой одним кликом.',
    'downloads.parsing.subtab.spotify': 'Spotify',
    'downloads.sp.urlPlaceholder': 'https://open.spotify.com/playlist/…',
    'downloads.sp.hint': 'Ссылка на плейлист, альбом или исполнителя из Spotify. Парсер работает в фоне.',
    'downloads.sp.idle.title': 'Парсинг Spotify',
    'downloads.sp.idle.text': 'Вставьте ссылку на плейлист или альбом из Spotify. Приложение откроет браузер, соберёт список треков, и вы сможете скачать любой одним кликом.',
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
    'setting.healthCheck': 'Проверка качества (Health-check)',
    'setting.healthCheckDesc': 'Раздел «Состояние библиотеки» и столбец «Качество» в списках треков. Выключено — колонка и раздел скрыты полностью.',
    'setting.reports': 'Отчёт о прослушивании',
    'setting.reportsDesc': 'Раздел «Отчёт» со статистикой прослушивания. Статистика собирается всегда, даже когда раздел скрыт.',
    'setting.showDownloads': 'Показать вкладку «Загрузки»',
    'setting.showDownloadsDesc': 'Откроет в боковом меню раздел для скачивания треков по ссылке.',
    'setting.showParserBrowser': 'Показывать окно браузера при парсинге',
    'setting.showParserBrowserDesc': 'Нужно, чтобы войти в Яндекс или Spotify при первом запуске, пройти капчу или увидеть, на чём парсер споткнулся. Если выключить — браузер запустится в фоне и окно не появится.',
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
    'nav.report': 'Report',
    'report.onDevice': 'Computed on this device',
    'report.eyebrow': 'Listening report',
    'report.period.day': 'Day',
    'report.period.week': 'Week',
    'report.period.month': 'Month',
    'report.period.year': 'Year',
    'report.period.all': 'All time',
    'report.allTime': 'All time',
    'report.today': 'Today',
    'report.thisWeek': 'This week',
    'report.listeningTime': 'Listening time',
    'report.vsPrev': 'vs previous period',
    'report.tracksPlayed': 'Tracks played',
    'report.artists': 'Artists',
    'report.added': 'Added to collection',
    'report.streak': 'Listening streak',
    'report.days': 'days',
    'report.whenListen': 'When you listen',
    'report.topArtists': 'Top artists',
    'report.topTracks': 'Top tracks',
    'report.plays': 'plays',
    'report.minUnit': 'min',
    'report.hoursUnit': 'hours',
    'report.hShort': 'h',
    'report.mShort': 'm',
    'report.empty.title': 'Your stats will appear here',
    'report.empty.text': 'Play some music — the report builds from listening history kept on this device.',
    'table.quality': 'Quality',
    'quality.kbps': 'kbps',
    'quality.note': 'A quality badge on every track · ',
    'quality.noteAmber': 'amber = suspicious transcode',
    'quality.cutoffMarker': 'cutoff',
    'health.khz': 'kHz',
    'nav.health': 'Health',
    'health.crumb': 'Library health',
    'health.lastScan': 'Last check:',
    'health.never': 'not checked yet',
    'health.rescan': 'Rescan',
    'health.scanning': 'Checking {n} of {m}…',
    'health.scoreLabel': 'Collection health',
    'health.ok': 'healthy',
    'health.okLegend': 'healthy',
    'health.flaggedLegend': 'need attention',
    'health.transcodeTitle': 'Looks like a transcode',
    'health.claimed': 'Claimed',
    'health.real': 'really ≈',
    'health.spectrumCaption': 'The spectrum cuts off at {cut} kHz, though a real high bitrate holds frequencies up to ~20 kHz.{lame}',
    'health.noLame': ' No LAME tag present.',
    'health.issuesLabel': 'Issues found',
    'health.show': 'Show',
    'health.fix': 'Fix',
    'health.allGood': 'No issues found',
    'health.allGoodText': 'Your collection is in great shape.',
    'health.noData': 'Run a check to assess your library health.',
    'health.analyzing': 'Analyzing spectrum…',
    'health.filterNote': 'Health filter: {label}',
    'health.clearFilter': 'Clear',
    'issue.transcode.title': 'Suspicious transcode',
    'issue.transcode.desc': 'Bitrate is claimed high, but the spectrum cuts off early — likely upsampled from a low-quality source.',
    'issue.lowbitrate.title': 'Low bitrate (< 192 kbps)',
    'issue.lowbitrate.desc': 'Files at 128 kbps and below. Consider replacing with better versions.',
    'issue.nocover.title': 'No cover art',
    'issue.nocover.desc': 'Tracks with no embedded album image.',
    'issue.tags.title': 'Incomplete tags',
    'issue.tags.desc': 'Empty artist, album or year fields.',
    'issue.dupes.title': 'Possible duplicates',
    'issue.dupes.desc': 'Same artist and title across different files.',
    'section.discord': 'Discord Rich Presence',
    'discord.subtitle': 'Show friends what you are listening to right in your Discord profile — with cover art, a timer and buttons that jump to the track.',
    'discord.statusConnected': 'Connected',
    'discord.statusDisconnected': 'Not connected',
    'discord.connect': 'Connect Discord',
    'discord.disconnect': 'Disconnect',
    'discord.connectHint': 'Link your account to broadcast your listening to your profile.',
    'discord.sessionActive': 'session active',
    'discord.connecting': 'Connecting…',
    'discord.connectError': 'Could not connect. Make sure Discord is running.',
    'discord.waitingForDiscord': 'Discord isn’t running — I’ll connect automatically once it opens.',
    'discord.noClientId': 'No Discord Client ID set. Add it to DISCORD_CLIENT_ID in renderer.js.',
    'discord.show': 'What to show',
    'discord.showTitle': 'Track title',
    'discord.showTitleDesc': 'The main activity line.',
    'discord.showArtist': 'Artist and album',
    'discord.showArtistDesc': 'The second line below the title.',
    'discord.showCover': 'Album cover',
    'discord.showCoverDesc': 'The large image on the card.',
    'discord.showTimer': 'Track timer',
    'discord.showTimerDesc': 'Elapsed and total time with progress.',
    'discord.showPaused': 'Show while paused',
    'discord.showPausedDesc': 'Keep the status when playback is stopped.',
    'discord.buttons': 'Profile buttons',
    'discord.buttonsHint': 'Discord allows at most two buttons in an activity. Links must start with http(s)://',
    'discord.btnLabel': 'Label',
    'discord.btnUrl': 'Link',
    'discord.btnLabelPh': 'Button text',
    'discord.btnUrlPh': 'https://…',
    'discord.privacy': 'Privacy',
    'discord.privacyInvisible': 'Hide while «Invisible»',
    'discord.privacyInvisibleDesc': 'Do not broadcast the status while you appear offline on Discord.',
    'discord.privacyPrivate': 'Disable for private playlists',
    'discord.privacyPrivateDesc': 'Tracks from private playlists won’t reach your profile.',
    'discord.preview': 'What friends see',
    'discord.previewListening': 'Listening to Audex',
    'discord.previewPaused': 'Was listening · paused',
    'discord.previewPlaceholder': 'The status appears in your profile once Discord is connected',
    'discord.previewNote': 'The card updates live on track change, pause and seeking.',
    'discord.previewOnline': 'Online',
    'discord.previewEmptyTrack': 'Nothing playing',
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
    'select.enter': 'Select',
    'select.count': 'Selected: {n}',
    'select.all': 'Select all',
    'modal.deleteTracks.title': 'Delete selected tracks?',
    'modal.deleteTracks.text': '{count} will be removed from the library and the files moved to the trash.',
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
    'downloads.parsing.subtab.ytmusic': 'YouTube Music',
    'downloads.ytm.urlPlaceholder': 'https://music.youtube.com/playlist?list=…',
    'downloads.ytm.hint': 'Link to an album, single, or artist on YouTube Music. No login or browser needed.',
    'downloads.ytm.idle.title': 'YouTube Music parsing',
    'downloads.ytm.idle.text': 'Paste a link to an album, single, or artist page from YouTube Music. The app will collect the track list and you can download any of them in one click.',
    'downloads.parsing.subtab.spotify': 'Spotify',
    'downloads.sp.urlPlaceholder': 'https://open.spotify.com/playlist/…',
    'downloads.sp.hint': 'Link to a playlist, album, or artist on Spotify. The parser runs in the background.',
    'downloads.sp.idle.title': 'Spotify parsing',
    'downloads.sp.idle.text': 'Paste a playlist or album link from Spotify. The app will open a browser, collect the track list, and let you download any of them in one click.',
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
    'setting.healthCheck': 'Quality check (Health-check)',
    'setting.healthCheckDesc': 'The “Library health” section and the “Quality” column in track lists. When off, the column and section are hidden entirely.',
    'setting.reports': 'Listening report',
    'setting.reportsDesc': 'The “Report” section with listening statistics. Stats are always collected, even while the section is hidden.',
    'setting.showDownloads': 'Show the “Downloads” tab',
    'setting.showDownloadsDesc': 'Adds a section to the sidebar for downloading tracks by URL.',
    'setting.showParserBrowser': 'Show the browser window while parsing',
    'setting.showParserBrowserDesc': 'Useful for signing in to Yandex or Spotify on the first run, solving a captcha, or seeing where the parser got stuck. Turn off to run the browser silently in the background.',
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
    'nav.report': 'Bericht',
    'report.onDevice': 'Auf diesem Gerät berechnet',
    'report.eyebrow': 'Hörbericht',
    'report.period.day': 'Tag',
    'report.period.week': 'Woche',
    'report.period.month': 'Monat',
    'report.period.year': 'Jahr',
    'report.period.all': 'Gesamt',
    'report.allTime': 'Gesamte Zeit',
    'report.today': 'Heute',
    'report.thisWeek': 'Diese Woche',
    'report.listeningTime': 'Hörzeit',
    'report.vsPrev': 'ggü. Vorperiode',
    'report.tracksPlayed': 'Titel gespielt',
    'report.artists': 'Interpreten',
    'report.added': 'Zur Sammlung hinzugefügt',
    'report.streak': 'Hörserie',
    'report.days': 'Tage',
    'report.whenListen': 'Wann du hörst',
    'report.topArtists': 'Top-Interpreten',
    'report.topTracks': 'Top-Titel',
    'report.plays': 'Wdg.',
    'report.minUnit': 'Min',
    'report.hoursUnit': 'Stunden',
    'report.hShort': 'Std',
    'report.mShort': 'Min',
    'report.empty.title': 'Hier erscheint deine Statistik',
    'report.empty.text': 'Höre Musik — der Bericht entsteht aus dem Verlauf auf diesem Gerät.',
    'table.quality': 'Qualität',
    'quality.kbps': 'kbit/s',
    'quality.note': 'Ein Qualitäts-Badge an jedem Titel · ',
    'quality.noteAmber': 'bernstein = verdächtige Umkodierung',
    'quality.cutoffMarker': 'Grenze',
    'health.khz': 'kHz',
    'nav.health': 'Zustand',
    'health.crumb': 'Bibliothekszustand',
    'health.lastScan': 'Letzte Prüfung:',
    'health.never': 'noch nicht geprüft',
    'health.rescan': 'Neu scannen',
    'health.scanning': 'Prüfe {n} von {m}…',
    'health.scoreLabel': 'Zustand der Sammlung',
    'health.ok': 'in Ordnung',
    'health.okLegend': 'in Ordnung',
    'health.flaggedLegend': 'brauchen Aufmerksamkeit',
    'health.transcodeTitle': 'Sieht nach Umkodierung aus',
    'health.claimed': 'Angegeben',
    'health.real': 'real ≈',
    'health.spectrumCaption': 'Das Spektrum bricht bei {cut} kHz ab, obwohl eine echte hohe Bitrate Frequenzen bis ~20 kHz hält.{lame}',
    'health.noLame': ' Kein LAME-Tag vorhanden.',
    'health.issuesLabel': 'Gefundene Probleme',
    'health.show': 'Anzeigen',
    'health.fix': 'Beheben',
    'health.allGood': 'Keine Probleme gefunden',
    'health.allGoodText': 'Deine Sammlung ist in bestem Zustand.',
    'health.noData': 'Starte eine Prüfung, um den Zustand zu beurteilen.',
    'health.analyzing': 'Spektrum wird analysiert…',
    'health.filterNote': 'Zustandsfilter: {label}',
    'health.clearFilter': 'Zurücksetzen',
    'issue.transcode.title': 'Verdächtige Umkodierung',
    'issue.transcode.desc': 'Die Bitrate ist hoch angegeben, aber das Spektrum bricht früh ab — wahrscheinlich aus geringer Qualität hochgerechnet.',
    'issue.lowbitrate.title': 'Niedrige Bitrate (< 192 kbit/s)',
    'issue.lowbitrate.desc': 'Dateien mit 128 kbit/s und weniger. Durch bessere Versionen ersetzbar.',
    'issue.nocover.title': 'Ohne Cover',
    'issue.nocover.desc': 'Titel ohne eingebettetes Albumbild.',
    'issue.tags.title': 'Unvollständige Tags',
    'issue.tags.desc': 'Leere Felder für Interpret, Album oder Jahr.',
    'issue.dupes.title': 'Mögliche Duplikate',
    'issue.dupes.desc': 'Gleicher Interpret und Titel in verschiedenen Dateien.',
    'section.discord': 'Discord Rich Presence',
    'discord.subtitle': 'Zeige Freunden direkt im Discord-Profil, was du hörst — mit Cover, Timer und Buttons zum Titel.',
    'discord.statusConnected': 'Verbunden',
    'discord.statusDisconnected': 'Nicht verbunden',
    'discord.connect': 'Discord verbinden',
    'discord.disconnect': 'Trennen',
    'discord.connectHint': 'Verknüpfe dein Konto, um deine Wiedergabe im Profil zu zeigen.',
    'discord.sessionActive': 'Sitzung aktiv',
    'discord.connecting': 'Verbinde…',
    'discord.connectError': 'Verbindung fehlgeschlagen. Stelle sicher, dass Discord läuft.',
    'discord.waitingForDiscord': 'Discord läuft nicht — ich verbinde mich automatisch, sobald es geöffnet ist.',
    'discord.noClientId': 'Keine Discord Client ID gesetzt. Trage sie in DISCORD_CLIENT_ID in renderer.js ein.',
    'discord.show': 'Was anzeigen',
    'discord.showTitle': 'Titelname',
    'discord.showTitleDesc': 'Die Hauptzeile der Aktivität.',
    'discord.showArtist': 'Interpret und Album',
    'discord.showArtistDesc': 'Die zweite Zeile unter dem Titel.',
    'discord.showCover': 'Albumcover',
    'discord.showCoverDesc': 'Das große Bild auf der Karte.',
    'discord.showTimer': 'Titel-Timer',
    'discord.showTimerDesc': 'Vergangene und Gesamtzeit mit Fortschritt.',
    'discord.showPaused': 'Bei Pause anzeigen',
    'discord.showPausedDesc': 'Status beibehalten, wenn die Wiedergabe gestoppt ist.',
    'discord.buttons': 'Profil-Buttons',
    'discord.buttonsHint': 'Discord erlaubt höchstens zwei Buttons pro Aktivität. Links müssen mit http(s):// beginnen',
    'discord.btnLabel': 'Beschriftung',
    'discord.btnUrl': 'Link',
    'discord.btnLabelPh': 'Button-Text',
    'discord.btnUrlPh': 'https://…',
    'discord.privacy': 'Privatsphäre',
    'discord.privacyInvisible': 'Bei «Unsichtbar» verbergen',
    'discord.privacyInvisibleDesc': 'Status nicht senden, wenn du auf Discord offline erscheinst.',
    'discord.privacyPrivate': 'Für private Playlists deaktivieren',
    'discord.privacyPrivateDesc': 'Titel aus privaten Playlists erscheinen nicht im Profil.',
    'discord.preview': 'Was Freunde sehen',
    'discord.previewListening': 'Hört Audex',
    'discord.previewPaused': 'Hörte · pausiert',
    'discord.previewPlaceholder': 'Der Status erscheint im Profil, sobald Discord verbunden ist',
    'discord.previewNote': 'Die Karte aktualisiert sich live bei Titelwechsel, Pause und Spulen.',
    'discord.previewOnline': 'Online',
    'discord.previewEmptyTrack': 'Nichts wird abgespielt',
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
    'select.enter': 'Auswählen',
    'select.count': 'Ausgewählt: {n}',
    'select.all': 'Alle auswählen',
    'modal.deleteTracks.title': 'Ausgewählte Titel löschen?',
    'modal.deleteTracks.text': '{count} werden aus der Bibliothek entfernt und die Dateien in den Papierkorb verschoben.',
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
    'downloads.parsing.subtab.ytmusic': 'YouTube Music',
    'downloads.ytm.urlPlaceholder': 'https://music.youtube.com/playlist?list=…',
    'downloads.ytm.hint': 'Link zu einem Album, einer Single oder einem Interpreten auf YouTube Music. Kein Login oder Browser nötig.',
    'downloads.ytm.idle.title': 'YouTube-Music-Parsing',
    'downloads.ytm.idle.text': 'Füge einen Link zu einem Album, einer Single oder einer Interpretenseite von YouTube Music ein. Die App sammelt die Titelliste, und du kannst jeden Titel mit einem Klick herunterladen.',
    'downloads.parsing.subtab.spotify': 'Spotify',
    'downloads.sp.urlPlaceholder': 'https://open.spotify.com/playlist/…',
    'downloads.sp.hint': 'Link zu einer Playlist, einem Album oder einem Interpreten auf Spotify. Der Parser läuft im Hintergrund.',
    'downloads.sp.idle.title': 'Spotify-Parsing',
    'downloads.sp.idle.text': 'Füge einen Playlist- oder Album-Link von Spotify ein. Die App öffnet einen Browser, sammelt die Titelliste, und du kannst jeden Titel mit einem Klick herunterladen.',
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
    'setting.healthCheck': 'Qualitätsprüfung (Health-check)',
    'setting.healthCheckDesc': 'Der Bereich „Bibliothekszustand“ und die Spalte „Qualität“ in den Titellisten. Wenn deaktiviert, sind Spalte und Bereich vollständig ausgeblendet.',
    'setting.reports': 'Hörbericht',
    'setting.reportsDesc': 'Der Bereich „Bericht“ mit Hörstatistiken. Statistiken werden immer erfasst, auch wenn der Bereich ausgeblendet ist.',
    'setting.showDownloads': 'Tab „Downloads“ anzeigen',
    'setting.showDownloadsDesc': 'Öffnet einen Bereich in der Seitenleiste zum Herunterladen von Titeln per URL.',
    'setting.showParserBrowser': 'Browserfenster beim Parsen anzeigen',
    'setting.showParserBrowserDesc': 'Nützlich, um sich beim ersten Start bei Yandex oder Spotify anzumelden, ein Captcha zu lösen oder zu sehen, wo der Parser hängengeblieben ist. Ausschalten, damit der Browser unsichtbar im Hintergrund läuft.',
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
    'nav.report': 'Rapport',
    'report.onDevice': 'Calculé sur cet appareil',
    'report.eyebrow': "Rapport d'écoute",
    'report.period.day': 'Jour',
    'report.period.week': 'Semaine',
    'report.period.month': 'Mois',
    'report.period.year': 'Année',
    'report.period.all': 'Tout le temps',
    'report.allTime': 'Tout le temps',
    'report.today': "Aujourd'hui",
    'report.thisWeek': 'Cette semaine',
    'report.listeningTime': "Temps d'écoute",
    'report.vsPrev': 'vs période précédente',
    'report.tracksPlayed': 'Titres écoutés',
    'report.artists': 'Artistes',
    'report.added': 'Ajoutés à la collection',
    'report.streak': "Série d'écoute",
    'report.days': 'jours',
    'report.whenListen': 'Quand tu écoutes',
    'report.topArtists': 'Top artistes',
    'report.topTracks': 'Top titres',
    'report.plays': 'éc.',
    'report.minUnit': 'min',
    'report.hoursUnit': 'heures',
    'report.hShort': 'h',
    'report.mShort': 'm',
    'report.empty.title': 'Tes statistiques apparaîtront ici',
    'report.empty.text': "Écoute de la musique — le rapport se construit à partir de l'historique conservé sur cet appareil.",
    'table.quality': 'Qualité',
    'quality.kbps': 'kbit/s',
    'quality.note': 'Un badge de qualité sur chaque piste · ',
    'quality.noteAmber': 'ambre = transcodage suspect',
    'quality.cutoffMarker': 'coupure',
    'health.khz': 'kHz',
    'nav.health': 'État',
    'health.crumb': 'État de la bibliothèque',
    'health.lastScan': 'Dernière vérification :',
    'health.never': 'pas encore vérifié',
    'health.rescan': 'Rescanner',
    'health.scanning': 'Vérification {n} sur {m}…',
    'health.scoreLabel': 'Santé de la collection',
    'health.ok': 'en bon état',
    'health.okLegend': 'en bon état',
    'health.flaggedLegend': "demandent de l'attention",
    'health.transcodeTitle': 'Ressemble à un transcodage',
    'health.claimed': 'Annoncé',
    'health.real': 'réel ≈',
    'health.spectrumCaption': 'Le spectre se coupe à {cut} kHz, alors qu’un vrai débit élevé tient les fréquences jusqu’à ~20 kHz.{lame}',
    'health.noLame': ' Aucune balise LAME présente.',
    'health.issuesLabel': 'Problèmes détectés',
    'health.show': 'Afficher',
    'health.fix': 'Réparer',
    'health.allGood': 'Aucun problème détecté',
    'health.allGoodText': 'Votre collection est en excellent état.',
    'health.noData': "Lance une vérification pour évaluer l'état de la bibliothèque.",
    'health.analyzing': 'Analyse du spectre…',
    'health.filterNote': 'Filtre d’état : {label}',
    'health.clearFilter': 'Effacer',
    'issue.transcode.title': 'Transcodage suspect',
    'issue.transcode.desc': 'Le débit est annoncé élevé, mais le spectre se coupe tôt — probablement suréchantillonné depuis une source de faible qualité.',
    'issue.lowbitrate.title': 'Faible débit (< 192 kbit/s)',
    'issue.lowbitrate.desc': 'Fichiers à 128 kbit/s et moins. À remplacer par de meilleures versions.',
    'issue.nocover.title': 'Sans pochette',
    'issue.nocover.desc': 'Pistes sans image d’album intégrée.',
    'issue.tags.title': 'Tags incomplets',
    'issue.tags.desc': 'Champs artiste, album ou année vides.',
    'issue.dupes.title': 'Doublons possibles',
    'issue.dupes.desc': 'Même artiste et titre sur des fichiers différents.',
    'section.discord': 'Discord Rich Presence',
    'discord.subtitle': 'Montrez à vos amis ce que vous écoutez directement dans votre profil Discord — avec pochette, minuteur et boutons vers le morceau.',
    'discord.statusConnected': 'Connecté',
    'discord.statusDisconnected': 'Non connecté',
    'discord.connect': 'Connecter Discord',
    'discord.disconnect': 'Déconnecter',
    'discord.connectHint': 'Liez votre compte pour diffuser votre écoute dans votre profil.',
    'discord.sessionActive': 'session active',
    'discord.connecting': 'Connexion…',
    'discord.connectError': 'Connexion impossible. Vérifiez que Discord est lancé.',
    'discord.waitingForDiscord': 'Discord n’est pas lancé — je me connecterai automatiquement dès son ouverture.',
    'discord.noClientId': "Aucun Discord Client ID défini. Ajoutez-le dans DISCORD_CLIENT_ID dans renderer.js.",
    'discord.show': 'Quoi afficher',
    'discord.showTitle': 'Titre du morceau',
    'discord.showTitleDesc': "La ligne principale de l'activité.",
    'discord.showArtist': 'Artiste et album',
    'discord.showArtistDesc': 'La deuxième ligne sous le titre.',
    'discord.showCover': "Pochette d'album",
    'discord.showCoverDesc': 'La grande image de la carte.',
    'discord.showTimer': 'Minuteur du morceau',
    'discord.showTimerDesc': 'Temps écoulé et total avec progression.',
    'discord.showPaused': 'Afficher en pause',
    'discord.showPausedDesc': 'Garder le statut quand la lecture est arrêtée.',
    'discord.buttons': 'Boutons du profil',
    'discord.buttonsHint': 'Discord autorise au plus deux boutons par activité. Les liens doivent commencer par http(s)://',
    'discord.btnLabel': 'Libellé',
    'discord.btnUrl': 'Lien',
    'discord.btnLabelPh': 'Texte du bouton',
    'discord.btnUrlPh': 'https://…',
    'discord.privacy': 'Confidentialité',
    'discord.privacyInvisible': 'Masquer en mode « Invisible »',
    'discord.privacyInvisibleDesc': 'Ne pas diffuser le statut quand vous êtes hors ligne sur Discord.',
    'discord.privacyPrivate': 'Désactiver pour les playlists privées',
    'discord.privacyPrivateDesc': "Les morceaux des playlists privées n'apparaîtront pas dans le profil.",
    'discord.preview': 'Ce que voient vos amis',
    'discord.previewListening': 'Écoute Audex',
    'discord.previewPaused': 'Écoutait · en pause',
    'discord.previewPlaceholder': 'Le statut apparaîtra dans votre profil une fois Discord connecté',
    'discord.previewNote': 'La carte se met à jour en direct au changement de morceau, en pause et au défilement.',
    'discord.previewOnline': 'En ligne',
    'discord.previewEmptyTrack': 'Rien en lecture',
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
    'select.enter': 'Sélectionner',
    'select.count': 'Sélection : {n}',
    'select.all': 'Tout sélectionner',
    'modal.deleteTracks.title': 'Supprimer les pistes sélectionnées ?',
    'modal.deleteTracks.text': '{count} seront retirées de la bibliothèque et les fichiers déplacés vers la corbeille.',
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
    'downloads.parsing.subtab.ytmusic': 'YouTube Music',
    'downloads.ytm.urlPlaceholder': 'https://music.youtube.com/playlist?list=…',
    'downloads.ytm.hint': 'Lien vers un album, un single ou un artiste sur YouTube Music. Aucune connexion ni navigateur requis.',
    'downloads.ytm.idle.title': 'Analyse YouTube Music',
    'downloads.ytm.idle.text': "Collez un lien vers un album, un single ou une page d'artiste de YouTube Music. L'application récupérera la liste des pistes et vous pourrez en télécharger n'importe laquelle en un clic.",
    'downloads.parsing.subtab.spotify': 'Spotify',
    'downloads.sp.urlPlaceholder': 'https://open.spotify.com/playlist/…',
    'downloads.sp.hint': "Lien vers une playlist, un album ou un artiste sur Spotify. L'analyseur fonctionne en arrière-plan.",
    'downloads.sp.idle.title': 'Analyse Spotify',
    'downloads.sp.idle.text': "Collez un lien de playlist ou d'album depuis Spotify. L'application ouvrira un navigateur, récupérera la liste des pistes, et vous pourrez en télécharger n'importe laquelle en un clic.",
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
    'setting.healthCheck': 'Contrôle de qualité (Health-check)',
    'setting.healthCheckDesc': 'La section « État de la bibliothèque » et la colonne « Qualité » dans les listes de pistes. Désactivé, la colonne et la section sont entièrement masquées.',
    'setting.reports': "Rapport d'écoute",
    'setting.reportsDesc': "La section « Rapport » avec les statistiques d'écoute. Les statistiques sont toujours collectées, même lorsque la section est masquée.",
    'setting.showDownloads': "Afficher l'onglet « Téléchargements »",
    'setting.showDownloadsDesc': 'Ajoute une section à la barre latérale pour télécharger des pistes par URL.',
    'setting.showParserBrowser': "Afficher la fenêtre du navigateur pendant l'analyse",
    'setting.showParserBrowserDesc': "Utile pour se connecter à Yandex ou Spotify au premier lancement, résoudre un captcha ou voir où l'analyseur s'est bloqué. Désactivez pour exécuter le navigateur silencieusement en arrière-plan.",
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
    'nav.report': 'Звіт',
    'report.onDevice': 'Обчислюється на пристрої',
    'report.eyebrow': 'Звіт про прослуховування',
    'report.period.day': 'День',
    'report.period.week': 'Тиждень',
    'report.period.month': 'Місяць',
    'report.period.year': 'Рік',
    'report.period.all': 'Увесь час',
    'report.allTime': 'За увесь час',
    'report.today': 'Сьогодні',
    'report.thisWeek': 'Цей тиждень',
    'report.listeningTime': 'Час прослуховування',
    'report.vsPrev': 'до минулого періоду',
    'report.tracksPlayed': 'Треків зіграно',
    'report.artists': 'Виконавців',
    'report.added': 'Додано до колекції',
    'report.streak': 'Серія прослуховувань',
    'report.days': 'днів',
    'report.whenListen': 'Коли ти слухаєш',
    'report.topArtists': 'Топ-виконавці',
    'report.topTracks': 'Топ-треки',
    'report.plays': 'просл.',
    'report.minUnit': 'хв',
    'report.hoursUnit': 'годин',
    'report.hShort': 'г',
    'report.mShort': 'хв',
    'report.empty.title': 'Тут зʼявиться твоя статистика',
    'report.empty.text': 'Слухай музику — звіт збереться з історії прослуховування на цьому пристрої.',
    'table.quality': 'Якість',
    'quality.kbps': 'кбіт/с',
    'quality.note': 'Бейдж якості на кожному треку · ',
    'quality.noteAmber': 'бурштиновий = підозра на перекодування',
    'quality.cutoffMarker': 'зріз',
    'health.khz': 'кГц',
    'nav.health': 'Стан',
    'health.crumb': 'Стан бібліотеки',
    'health.lastScan': 'Остання перевірка:',
    'health.never': 'ще не перевірялося',
    'health.rescan': 'Пересканувати',
    'health.scanning': 'Перевірка {n} з {m}…',
    'health.scoreLabel': "Здоров'я колекції",
    'health.ok': 'у порядку',
    'health.okLegend': 'у порядку',
    'health.flaggedLegend': 'потребують уваги',
    'health.transcodeTitle': 'Схоже на перекодування',
    'health.claimed': 'Заявлено',
    'health.real': 'реально ≈',
    'health.spectrumCaption': 'Спектр обривається на {cut} кГц, хоча високий бітрейт тримає частоти до ~20 кГц.{lame}',
    'health.noLame': ' LAME-тег відсутній.',
    'health.issuesLabel': 'Знайдені проблеми',
    'health.show': 'Показати',
    'health.fix': 'Виправити',
    'health.allGood': 'Проблем не знайдено',
    'health.allGoodText': 'Колекція у чудовому стані.',
    'health.noData': 'Запусти перевірку, щоб оцінити стан бібліотеки.',
    'health.analyzing': 'Аналіз спектра…',
    'health.filterNote': 'Фільтр стану: {label}',
    'health.clearFilter': 'Скинути',
    'issue.transcode.title': 'Підозра на перекодування',
    'issue.transcode.desc': 'Бітрейт заявлено високим, але спектр обривається рано — імовірно, перекодовано з низької якості.',
    'issue.lowbitrate.title': 'Низький бітрейт (< 192 кбіт/с)',
    'issue.lowbitrate.desc': 'Файли 128 кбіт/с і нижче. Можна замінити на кращі версії.',
    'issue.nocover.title': 'Без обкладинки',
    'issue.nocover.desc': 'Треки без вбудованого зображення альбому.',
    'issue.tags.title': 'Неповні теги',
    'issue.tags.desc': 'Порожні поля виконавця, альбому або року.',
    'issue.dupes.title': 'Можливі дублікати',
    'issue.dupes.desc': 'Збігаються виконавець і назва за різних файлів.',
    'section.discord': 'Discord Rich Presence',
    'discord.subtitle': 'Показуйте друзям, що ви слухаєте, прямо в профілі Discord — з обкладинкою, таймером і кнопками для переходу до треку.',
    'discord.statusConnected': 'Підключено',
    'discord.statusDisconnected': 'Не підключено',
    'discord.connect': 'Підключити Discord',
    'discord.disconnect': 'Відключити',
    'discord.connectHint': "Прив'яжіть акаунт, щоб транслювати прослуховування у профіль.",
    'discord.sessionActive': 'сесія активна',
    'discord.connecting': 'Підключення…',
    'discord.connectError': 'Не вдалося підключитися. Переконайтеся, що Discord запущено.',
    'discord.waitingForDiscord': 'Discord не запущено — підключуся автоматично, коли він відкриється.',
    'discord.noClientId': 'Не задано Discord Client ID. Вкажіть його в DISCORD_CLIENT_ID у renderer.js.',
    'discord.show': 'Що показувати',
    'discord.showTitle': 'Назва треку',
    'discord.showTitleDesc': 'Основний рядок активності.',
    'discord.showArtist': 'Виконавець та альбом',
    'discord.showArtistDesc': 'Другий рядок під назвою.',
    'discord.showCover': 'Обкладинка альбому',
    'discord.showCoverDesc': 'Велике зображення картки.',
    'discord.showTimer': 'Таймер треку',
    'discord.showTimerDesc': 'Минулий і загальний час із прогресом.',
    'discord.showPaused': 'Показувати на паузі',
    'discord.showPausedDesc': 'Залишати статус, коли відтворення зупинено.',
    'discord.buttons': 'Кнопки у профілі',
    'discord.buttonsHint': 'Discord дозволяє не більше двох кнопок в активності. Посилання мають починатися з http(s)://',
    'discord.btnLabel': 'Підпис',
    'discord.btnUrl': 'Посилання',
    'discord.btnLabelPh': 'Текст кнопки',
    'discord.btnUrlPh': 'https://…',
    'discord.privacy': 'Приватність',
    'discord.privacyInvisible': 'Приховувати в режимі «Невидимий»',
    'discord.privacyInvisibleDesc': 'Не транслювати статус, коли ви офлайн у Discord.',
    'discord.privacyPrivate': 'Вимикати для приватних плейлистів',
    'discord.privacyPrivateDesc': 'Треки із закритих плейлистів не потраплять у профіль.',
    'discord.preview': 'Як бачать друзі',
    'discord.previewListening': 'Слухає Audex',
    'discord.previewPaused': 'Слухав · на паузі',
    'discord.previewPlaceholder': 'Статус з’явиться у профілі після підключення Discord',
    'discord.previewNote': 'Картка оновлюється в реальному часі при зміні треку, паузі та перемотуванні.',
    'discord.previewOnline': 'У мережі',
    'discord.previewEmptyTrack': 'Нічого не грає',
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
    'select.enter': 'Вибрати',
    'select.count': 'Вибрано: {n}',
    'select.all': 'Вибрати всі',
    'modal.deleteTracks.title': 'Видалити вибрані треки?',
    'modal.deleteTracks.text': '{count} буде вилучено з бібліотеки, а файли — переміщено у смітник.',
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
    'downloads.parsing.subtab.ytmusic': 'YouTube Music',
    'downloads.ytm.urlPlaceholder': 'https://music.youtube.com/playlist?list=…',
    'downloads.ytm.hint': 'Посилання на альбом, сингл або виконавця з YouTube Music. Логін і браузер не потрібні.',
    'downloads.ytm.idle.title': 'Парсинг YouTube Music',
    'downloads.ytm.idle.text': 'Вставте посилання на альбом, сингл або сторінку виконавця з YouTube Music. Застосунок збере список треків, і ви зможете завантажити будь-який одним кліком.',
    'downloads.parsing.subtab.spotify': 'Spotify',
    'downloads.sp.urlPlaceholder': 'https://open.spotify.com/playlist/…',
    'downloads.sp.hint': 'Посилання на плейлист, альбом або виконавця зі Spotify. Парсер працює у фоні.',
    'downloads.sp.idle.title': 'Парсинг Spotify',
    'downloads.sp.idle.text': 'Вставте посилання на плейлист або альбом зі Spotify. Застосунок відкриє браузер, збере список треків, і ви зможете завантажити будь-який одним кліком.',
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
    'setting.healthCheck': 'Перевірка якості (Health-check)',
    'setting.healthCheckDesc': 'Розділ «Стан бібліотеки» та стовпець «Якість» у списках треків. Коли вимкнено — стовпець і розділ повністю приховані.',
    'setting.reports': 'Звіт про прослуховування',
    'setting.reportsDesc': 'Розділ «Звіт» зі статистикою прослуховування. Статистика збирається завжди, навіть коли розділ прихований.',
    'setting.showDownloads': 'Показати вкладку «Завантаження»',
    'setting.showDownloadsDesc': 'Відкриє в боковому меню розділ для завантаження треків за посиланням.',
    'setting.showParserBrowser': 'Показувати вікно браузера під час парсингу',
    'setting.showParserBrowserDesc': 'Потрібно, щоб увійти в Яндекс або Spotify при першому запуску, пройти капчу або побачити, на чому парсер спіткнувся. Якщо вимкнути — браузер запуститься у фоні і вікно не з\'явиться.',
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
let librarySelectMode = false;      // library-view multi-select (bulk delete)
const selectedPaths = new Set();
let lastSelectedPath = null;        // anchor for shift-click range selection
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
  if (!track || pendingCoverLoad.has(track.path)) return;
  const needCover = !track.cover;
  const needQuality = track.quality === undefined || track.hasCover === undefined;
  if (!needCover && !needQuality) return;
  pendingCoverLoad.add(track.path);
  try {
    const md = await window.electronAPI.parseMetadata(track.path);
    if (md) {
      let touched = false;
      if (needQuality) {
        track.quality = md.quality;
        track.hasCover = md.hasCover;
        touched = true;
        scheduleLibrarySave();
      }
      if (md.cover) {
        track.cover = md.cover;
        coverCache[track.path] = md.cover;
        touched = true;
        if (currentTrackIndex >= 0 && library[currentTrackIndex] && library[currentTrackIndex].path === track.path) {
          updateNowPlayingUI(library[currentTrackIndex]);
        }
      }
      if (touched) scheduleCoverRefresh();
    }
  } catch (e) { /* file moved / unreadable */ }
}

// Coalesce the many small library writes from lazy quality/cover backfill into
// one localStorage write.
let _libSaveTimer = null;
function scheduleLibrarySave() {
  clearTimeout(_libSaveTimer);
  _libSaveTimer = setTimeout(() => { _libSaveTimer = null; saveLibrary(); }, 1500);
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
  if (librarySelectMode && view !== 'library') setLibrarySelectMode(false);
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
  else if (view === 'report') renderReport();
  else if (view === 'health') renderHealth();
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
    if (item.dataset.view) {
      // A direct click on the Library nav item shows the full library, not a
      // lingering Health-check result filter.
      if (item.dataset.view === 'library') clearHealthFilter();
      setView(item.dataset.view);
    }
  });
});
document.querySelectorAll('.crumb-item.link').forEach(el => {
  el.addEventListener('click', () => {
    if (el.dataset.view === 'library') clearHealthFilter();
    setView(el.dataset.view);
  });
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

// ── Downloads: YouTube Music parsing ──
// Mirrors the Yandex parser UI, but enumeration goes through yt-dlp (no browser)
// and downloads use the exact video id via the shared 'youtube' queue source, so
// dedup and progress routing are shared with the YouTube search tab.
let ytmParseActive = false;
let ytmTracks = [];
let ytmDownloadReqSeq = 0;
const ytmActiveDownloads = new Map(); // requestId -> rowEl (direct, non-queue downloads)

function setYtmStatus(text, kind) {
  const el = $('dl-ytm-status');
  if (!el) return;
  el.classList.remove('is-error', 'is-ok');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  if (kind === 'error') el.classList.add('is-error');
  else if (kind === 'ok') el.classList.add('is-ok');
  el.hidden = false;
  el.textContent = text;
}

function saveYtmState() {
  try {
    const u = $('dl-ytm-url');
    localStorage.setItem(LS.ytmState, JSON.stringify({
      url: u ? u.value : '',
      tracks: ytmTracks,
    }));
  } catch (_) { /* ignore */ }
}

function isYtmTrackInQueue(t) {
  return t ? isYtResultInQueue({ id: t.id, url: t.url }) : false;
}

function renderYtmResults(tracks) {
  ytmTracks = tracks || [];
  saveYtmState();
  const wrap = $('dl-ytm-results');
  const rows = $('dl-ytm-rows');
  const empty = $('dl-ytm-empty');
  const note = $('dl-ytm-tag-note');
  const queueAllBtn = $('dl-ytm-queue-all');
  if (!wrap || !rows) return;
  if (!ytmTracks.length) {
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
    queueAllBtn.disabled = ytmParseActive;
  }
  const disabledAttr = ytmParseActive ? ' disabled' : '';
  rows.innerHTML = ytmTracks.map((t, i) => {
    const queued = isYtmTrackInQueue(t);
    const queuedCls = queued ? ' is-done' : '';
    const queueDis = ytmParseActive || queued ? ' disabled' : '';
    const queueLabel = queued ? tr('downloads.queue.queued') : tr('downloads.queue.add');
    const coverStyle = t.cover ? `background-image:url('${escapeHtml(t.cover)}')` : '';
    return `
      <div class="dl-row-ym dl-row-ytm" data-ytm-row="${i}">
        <div class="num">${i + 1}</div>
        <div class="cover" style="${coverStyle}"></div>
        <div class="artist" title="${escapeHtml(t.artist || '')}">${escapeHtml(t.artist || '')}</div>
        <div class="title" title="${escapeHtml(t.title || '')}">${escapeHtml(t.title || '')}</div>
        <div class="duration">${escapeHtml(t.duration || '')}</div>
        <div class="action">
          <button type="button" class="dl-download-btn dl-queue-btn${queuedCls}" data-ytm-queue="${i}"${queueDis} title="${escapeHtml(queueLabel)}">
            <svg class="i" width="12" height="12"><use href="#i-plus"/></svg>
            <span>${escapeHtml(queueLabel)}</span>
          </button>
          <button type="button" class="dl-download-btn" data-ytm-dl="${i}"${disabledAttr}>
            <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
            <span>${escapeHtml(tr('downloads.yt.action.download'))}</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
  wrap.hidden = false;
  rows.querySelectorAll('[data-ytm-dl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-ytm-dl'), 10);
      if (!isNaN(idx)) downloadYtmTrack(idx, btn);
    });
  });
  rows.querySelectorAll('[data-ytm-queue]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-ytm-queue'), 10);
      if (!isNaN(idx)) enqueueYtmTrack(idx);
    });
  });
}

function restoreYtmDownloadButton(actionEl, idx, labelKey, cls) {
  actionEl.innerHTML = `
    <button type="button" class="dl-download-btn ${cls || ''}" data-ytm-dl="${idx}">
      <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
      <span>${escapeHtml(tr(labelKey))}</span>
    </button>
  `;
  const newBtn = actionEl.querySelector('[data-ytm-dl]');
  if (newBtn) newBtn.addEventListener('click', () => downloadYtmTrack(idx, newBtn));
  return newBtn;
}

async function downloadYtmTrack(idx, btn) {
  const t = ytmTracks[idx];
  if (!t || !btn) return;
  if (btn.classList.contains('is-done')) return;
  const rowEl = btn.closest('.dl-row-ym');
  if (!rowEl) return;
  const actionEl = rowEl.querySelector('.action');
  if (!actionEl) return;

  const requestId = 'ytm-' + (++ytmDownloadReqSeq);
  rowEl.dataset.requestId = requestId;
  actionEl.innerHTML = `
    <div class="dl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="dl-progress-bar"><div class="dl-progress-fill"></div></div>
      <div class="dl-progress-pct">0%</div>
    </div>
  `;
  ytmActiveDownloads.set(requestId, rowEl);

  const suggestedName = t.artist ? `${t.artist} - ${t.title}` : t.title;

  try {
    const res = await window.electronAPI.ytDownload({ videoId: t.id, url: t.url, suggestedName, requestId, targetDir: settings.defaultFolder || '' });
    ytmActiveDownloads.delete(requestId);
    if (!res || !res.success) {
      restoreYtmDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
      setYtmStatus(tr('downloads.yt.downloadError', { e: (res && res.error) || 'unknown' }), 'error');
      return;
    }
    await importPaths([res.filePath]);
    const doneBtn = restoreYtmDownloadButton(actionEl, idx, 'downloads.yt.action.done', 'is-done');
    if (doneBtn) doneBtn.disabled = true;
    setYtmStatus(tr('downloads.yt.downloadOk', { t: suggestedName }), 'ok');
  } catch (err) {
    ytmActiveDownloads.delete(requestId);
    restoreYtmDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
    setYtmStatus(tr('downloads.yt.downloadError', { e: String(err) }), 'error');
  }
}

if (window.electronAPI && window.electronAPI.onYtDownloadProgress) {
  window.electronAPI.onYtDownloadProgress(({ requestId, phase, percent }) => {
    if (!requestId) return;
    const rowEl = ytmActiveDownloads.get(requestId);
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

function buildQueueItemFromYtm(t) {
  return {
    id: 'q-' + (++queueIdSeq),
    source: 'youtube',
    key: ytTrackKey({ id: t.id, url: t.url }),
    artist: t.artist || '',
    title: t.title || '',
    duration: t.duration || '',
    query: t.artist ? `${t.artist} ${t.title}` : (t.title || ''),
    suggestedName: t.artist ? `${t.artist} - ${t.title}` : (t.title || ''),
    videoId: t.id || '',
    url: t.url || '',
    status: 'queued',
    percent: 0,
    indeterminate: false,
    filePath: '',
    error: '',
    requestId: '',
  };
}

function enqueueYtmTrack(idx) {
  const t = ytmTracks[idx];
  if (!t || isYtmTrackInQueue(t)) return;
  downloadQueue.push(buildQueueItemFromYtm(t));
  renderQueue();
  renderYtmResults(ytmTracks);
  updateQueueTabBadge();
  startQueueWorker();
}

function enqueueAllYtmTracks() {
  if (!ytmTracks || !ytmTracks.length) return;
  let added = 0;
  for (const t of ytmTracks) {
    if (isYtmTrackInQueue(t)) continue;
    downloadQueue.push(buildQueueItemFromYtm(t));
    added++;
  }
  if (added > 0) {
    renderQueue();
    renderYtmResults(ytmTracks);
    updateQueueTabBadge();
    startQueueWorker();
    activateDlTab('queue');
  }
}

async function runYtmParse() {
  if (ytmParseActive) return;
  const urlEl = $('dl-ytm-url');
  const startBtn = $('dl-ytm-parse-btn');
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url) { urlEl.focus(); return; }
  ytmParseActive = true;
  if (startBtn) startBtn.disabled = true;
  renderYtmResults([]);
  setYtmStatus(tr('downloads.parsing.starting'));
  try {
    const res = await window.electronAPI.ytMusicParse({ url });
    if (!res || !res.success) {
      setYtmStatus(tr('downloads.parsing.error', { e: (res && res.error) || 'unknown' }), 'error');
    } else {
      setYtmStatus(tr('downloads.parsing.done', { n: res.tracks.length }), 'ok');
      renderYtmResults(res.tracks);
    }
  } catch (err) {
    setYtmStatus(tr('downloads.parsing.error', { e: String(err) }), 'error');
  } finally {
    ytmParseActive = false;
    if (startBtn) startBtn.disabled = false;
    if (ytmTracks && ytmTracks.length) renderYtmResults(ytmTracks);
  }
}

(function wireYtmControls() {
  const start = $('dl-ytm-parse-btn');
  const url = $('dl-ytm-url');
  const queueAll = $('dl-ytm-queue-all');
  if (start) start.addEventListener('click', runYtmParse);
  if (queueAll) queueAll.addEventListener('click', enqueueAllYtmTracks);
  if (url) {
    url.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runYtmParse(); }
    });
    url.addEventListener('input', saveYtmState);
  }
})();

// ── Downloads: Spotify parsing ──
// Mirrors the Yandex parser: track lists come from Puppeteer scraping the
// Spotify web player, downloads go through ytsearch1: by "artist title" query
// (Spotify itself serves no downloadable audio). Rows reuse the YTM layout
// because Spotify pages give us per-track covers.
let spParseActive = false;
let spTracks = [];
let spDownloadReqSeq = 0;
const spActiveDownloads = new Map(); // requestId -> rowEl

function setSpStatus(text, kind) {
  const el = $('dl-sp-status');
  if (!el) return;
  el.classList.remove('is-error', 'is-ok');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  if (kind === 'error') el.classList.add('is-error');
  else if (kind === 'ok') el.classList.add('is-ok');
  el.hidden = false;
  el.textContent = text;
}

function saveSpState() {
  try {
    const u = $('dl-sp-url');
    localStorage.setItem(LS.spState, JSON.stringify({
      url: u ? u.value : '',
      tracks: spTracks,
    }));
  } catch (_) { /* ignore */ }
}

function renderSpResults(tracks) {
  spTracks = tracks || [];
  saveSpState();
  const wrap = $('dl-sp-results');
  const rows = $('dl-sp-rows');
  const empty = $('dl-sp-empty');
  const note = $('dl-sp-tag-note');
  const queueAllBtn = $('dl-sp-queue-all');
  if (!wrap || !rows) return;
  if (!spTracks.length) {
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
    queueAllBtn.disabled = spParseActive;
  }
  const disabledAttr = spParseActive ? ' disabled' : '';
  rows.innerHTML = spTracks.map((t, i) => {
    const queued = isSpTrackInQueue(t);
    const queuedCls = queued ? ' is-done' : '';
    const queueDis = spParseActive || queued ? ' disabled' : '';
    const queueLabel = queued ? tr('downloads.queue.queued') : tr('downloads.queue.add');
    const coverStyle = t.cover_url ? `background-image:url('${escapeHtml(t.cover_url)}')` : '';
    return `
      <div class="dl-row-ym dl-row-ytm" data-sp-row="${i}">
        <div class="num">${i + 1}</div>
        <div class="cover" style="${coverStyle}"></div>
        <div class="artist" title="${escapeHtml(t.artist || '')}">${escapeHtml(t.artist || '')}</div>
        <div class="title" title="${escapeHtml(t.title || '')}">${escapeHtml(t.title || '')}</div>
        <div class="duration">${escapeHtml(t.duration || '')}</div>
        <div class="action">
          <button type="button" class="dl-download-btn dl-queue-btn${queuedCls}" data-sp-queue="${i}"${queueDis} title="${escapeHtml(queueLabel)}">
            <svg class="i" width="12" height="12"><use href="#i-plus"/></svg>
            <span>${escapeHtml(queueLabel)}</span>
          </button>
          <button type="button" class="dl-download-btn" data-sp-dl="${i}"${disabledAttr}>
            <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
            <span>${escapeHtml(tr('downloads.yt.action.download'))}</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
  wrap.hidden = false;
  rows.querySelectorAll('[data-sp-dl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-sp-dl'), 10);
      if (!isNaN(idx)) downloadSpTrack(idx, btn);
    });
  });
  rows.querySelectorAll('[data-sp-queue]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-sp-queue'), 10);
      if (!isNaN(idx)) enqueueSpTrack(idx);
    });
  });
}

function restoreSpDownloadButton(actionEl, idx, labelKey, cls) {
  actionEl.innerHTML = `
    <button type="button" class="dl-download-btn ${cls || ''}" data-sp-dl="${idx}">
      <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
      <span>${escapeHtml(tr(labelKey))}</span>
    </button>
  `;
  const newBtn = actionEl.querySelector('[data-sp-dl]');
  if (newBtn) newBtn.addEventListener('click', () => downloadSpTrack(idx, newBtn));
  return newBtn;
}

async function downloadSpTrack(idx, btn) {
  const t = spTracks[idx];
  if (!t || !btn) return;
  if (btn.classList.contains('is-done')) return;
  const rowEl = btn.closest('.dl-row-ym');
  if (!rowEl) return;
  const actionEl = rowEl.querySelector('.action');
  if (!actionEl) return;

  const requestId = 'sp-' + (++spDownloadReqSeq);
  rowEl.dataset.requestId = requestId;
  actionEl.innerHTML = `
    <div class="dl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="dl-progress-bar"><div class="dl-progress-fill"></div></div>
      <div class="dl-progress-pct">0%</div>
    </div>
  `;
  spActiveDownloads.set(requestId, rowEl);

  const query = `${t.artist} ${t.title}`.replace(/—/g, '').trim();
  const suggestedName = `${t.artist} - ${t.title}`;

  try {
    const res = await window.electronAPI.ytDownloadByQuery({ query, suggestedName, requestId, targetDir: settings.defaultFolder || '' });
    spActiveDownloads.delete(requestId);
    if (!res || !res.success) {
      restoreSpDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
      setSpStatus(tr('downloads.yt.downloadError', { e: (res && res.error) || 'unknown' }), 'error');
      return;
    }
    await importPaths([res.filePath]);
    const doneBtn = restoreSpDownloadButton(actionEl, idx, 'downloads.yt.action.done', 'is-done');
    if (doneBtn) doneBtn.disabled = true;
    setSpStatus(tr('downloads.yt.downloadOk', { t: suggestedName }), 'ok');
  } catch (err) {
    spActiveDownloads.delete(requestId);
    restoreSpDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
    setSpStatus(tr('downloads.yt.downloadError', { e: String(err) }), 'error');
  }
}

if (window.electronAPI && window.electronAPI.onYtDownloadProgress) {
  window.electronAPI.onYtDownloadProgress(({ requestId, phase, percent }) => {
    if (!requestId) return;
    const rowEl = spActiveDownloads.get(requestId);
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

if (window.electronAPI && window.electronAPI.onSpotifyParseProgress) {
  window.electronAPI.onSpotifyParseProgress((data) => {
    if (!data) return;
    if (data.message) {
      const total = typeof data.total === 'number' ? ` · ${data.total}` : '';
      setSpStatus(data.message + total, data.phase === 'error' ? 'error' : null);
    }
    if (Array.isArray(data.tracks)) {
      renderSpResults(data.tracks);
    }
  });
}

function isSpTrackInQueue(t) {
  if (!t) return false;
  const key = ymTrackKey(t);
  return downloadQueue.some(it => it.source === 'spotify' && it.key === key && it.status !== 'error');
}

function buildQueueItemFromSp(t) {
  return {
    id: 'q-' + (++queueIdSeq),
    source: 'spotify',
    key: ymTrackKey(t),
    artist: t.artist || '',
    title: t.title || '',
    duration: t.duration || '',
    query: `${t.artist || ''} ${t.title || ''}`.replace(/—/g, '').trim(),
    suggestedName: `${t.artist || ''} - ${t.title || ''}`,
    videoId: '',
    url: '',
    status: 'queued',
    percent: 0,
    indeterminate: false,
    filePath: '',
    error: '',
    requestId: '',
  };
}

function enqueueSpTrack(idx) {
  const t = spTracks[idx];
  if (!t || isSpTrackInQueue(t)) return;
  downloadQueue.push(buildQueueItemFromSp(t));
  renderQueue();
  renderSpResults(spTracks);
  updateQueueTabBadge();
  startQueueWorker();
}

function enqueueAllSpTracks() {
  if (!spTracks || !spTracks.length) return;
  let added = 0;
  for (const t of spTracks) {
    if (isSpTrackInQueue(t)) continue;
    downloadQueue.push(buildQueueItemFromSp(t));
    added++;
  }
  if (added > 0) {
    renderQueue();
    renderSpResults(spTracks);
    updateQueueTabBadge();
    startQueueWorker();
    activateDlTab('queue');
  }
}

async function runSpParse() {
  if (spParseActive) return;
  const urlEl = $('dl-sp-url');
  const startBtn = $('dl-sp-parse-btn');
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url) { urlEl.focus(); return; }
  spParseActive = true;
  if (startBtn) startBtn.disabled = true;
  renderSpResults([]);
  setSpStatus(tr('downloads.parsing.starting'));
  try {
    const res = await window.electronAPI.spotifyParse({ url, showBrowser: !!settings.showParserBrowser });
    if (!res || !res.success) {
      setSpStatus(tr('downloads.parsing.error', { e: (res && res.error) || 'unknown' }), 'error');
      if (res && Array.isArray(res.tracks) && res.tracks.length) renderSpResults(res.tracks);
    } else {
      setSpStatus(tr('downloads.parsing.done', { n: res.tracks.length }), 'ok');
      renderSpResults(res.tracks);
    }
  } catch (err) {
    setSpStatus(tr('downloads.parsing.error', { e: String(err) }), 'error');
  } finally {
    spParseActive = false;
    if (startBtn) startBtn.disabled = false;
    if (spTracks && spTracks.length) renderSpResults(spTracks);
  }
}

(function wireSpControls() {
  const start = $('dl-sp-parse-btn');
  const url = $('dl-sp-url');
  const queueAll = $('dl-sp-queue-all');
  if (start) start.addEventListener('click', runSpParse);
  if (queueAll) queueAll.addEventListener('click', enqueueAllSpTracks);
  if (url) {
    url.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runSpParse(); }
    });
    url.addEventListener('input', saveSpState);
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
  renderYtmResults(ytmTracks);
  renderSpResults(spTracks);
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
      renderYtmResults(ytmTracks);
      renderSpResults(spTracks);
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
  renderYtmResults(ytmTracks);
  renderSpResults(spTracks);
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
  renderYtmResults(ytmTracks);
  renderSpResults(spTracks);
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
    const raw = localStorage.getItem(LS.ytmState);
    if (raw) {
      const ytm = JSON.parse(raw);
      const urlEl = $('dl-ytm-url');
      if (urlEl && typeof ytm.url === 'string') urlEl.value = ytm.url;
      if (Array.isArray(ytm.tracks) && ytm.tracks.length) renderYtmResults(ytm.tracks);
    }
  } catch (_) { /* ignore */ }
  try {
    const raw = localStorage.getItem(LS.spState);
    if (raw) {
      const sp = JSON.parse(raw);
      const urlEl = $('dl-sp-url');
      if (urlEl && typeof sp.url === 'string') urlEl.value = sp.url;
      if (Array.isArray(sp.tracks) && sp.tracks.length) renderSpResults(sp.tracks);
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
    if (ytmTracks && ytmTracks.length) renderYtmResults(ytmTracks);
    if (spTracks && spTracks.length) renderSpResults(spTracks);
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

// ── Track quality ──
// Two-tier quality info per track. Tier 1 (`track.quality`) is decoded from the
// file header in main.js at parse time. Tier 2 (spectral transcode detection)
// runs in the renderer and is cached here per path; it can upgrade a track's
// tier to 'suspicious'. See design_handoff_track_quality/README.md.
const QUALITY_TIER_CLASS = {
  lossless: 'q-lossless', high: 'q-high', good: 'q-good', low: 'q-low', suspicious: 'q-suspicious',
};

let qualityCache = (() => {
  try { return JSON.parse(localStorage.getItem(LS.qualityCache) || '{}'); }
  catch (_) { return {}; }
})();
function saveQualityCache() {
  try { localStorage.setItem(LS.qualityCache, JSON.stringify(qualityCache)); }
  catch (e) { console.warn('quality cache save failed:', e); }
}

// Combine a track's Tier-1 header quality with any cached Tier-2 spectral result.
function qualityFor(track) {
  const q = track && track.quality;
  if (!q) return null;
  const spec = qualityCache[track.path];
  if (!spec) return q;
  return { ...q, cutoffKHz: spec.cutoffKHz, tier: spec.tier || q.tier,
    claimed: spec.claimed, estReal: spec.estReal };
}

// Short label inside the badge: FLAC/ALAC/WAV keep the format; VBR shows the
// LAME preset (V0/V1/V2…); everything else shows the bitrate number.
function qualityBadgeLabel(q) {
  if (q.format === 'FLAC') return 'FLAC';
  if (q.format === 'ALAC' || q.format === 'WAV') return q.format;
  if (q.preset && q.preset.startsWith('-V')) return 'V' + q.preset.replace('-V', '').trim();
  return q.bitrate ? String(q.bitrate) : (q.format || '—');
}

function qualityBadgeHtml(q) {
  if (!q) return '';
  const cls = QUALITY_TIER_CLASS[q.tier] || 'q-good';
  const label = escapeHtml(qualityBadgeLabel(q));
  const warn = q.tier === 'suspicious'
    ? `<svg class="i" width="10.5" height="10.5"><use href="#i-alert-triangle"/></svg>` : '';
  const suffix = q.tier === 'suspicious' ? `<span class="q-badge-q">?</span>` : '';
  const bits = q.bitrate ? `${q.bitrate} ${tr('quality.kbps')} · ` : '';
  const title = escapeHtml(`${q.format} · ${bits}${q.mode}`);
  return `<span class="q-badge ${cls}" title="${title}">${warn}${label}${suffix}</span>`;
}

// ── Track quality: spectral analysis (Tier 2) ──
// The transcode detector. Decodes a window of PCM at full rate, runs an FFT
// over overlapping Hann-windowed frames, averages the magnitude spectra, and
// finds the frequency where energy drops into the noise floor. A file that
// *claims* 320 kbps but whose spectrum dies at ~16 kHz was almost certainly
// upsampled from a ~128 kbps source. See design_handoff_track_quality/README.md.
const SPEC_FFT = 4096;                 // FFT window size (power of two)
const SPEC_SR = 44100;                 // force decode sample rate → Nyquist 22.05 kHz
const SPEC_WIN_SEC = 25;               // analyse a ~25 s loud middle section
const SPEC_POINTS = 128;               // spectrum points stored for the graph

let specDecodeCtx = null;
function getSpecCtx() {
  if (!specDecodeCtx) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('OfflineAudioContext unavailable');
    specDecodeCtx = new Ctx(1, 1, SPEC_SR);
  }
  return specDecodeCtx;
}

// In-place iterative radix-2 Cooley–Tukey FFT.
function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = cr * re[b] - ci * im[b];
        const xi = cr * im[b] + ci * re[b];
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Estimate the true source bitrate from the spectral cutoff (README table).
function estBitrateFromCutoff(cutoffKHz) {
  if (cutoffKHz <= 16.5) return 128;
  if (cutoffKHz <= 18) return 192;
  if (cutoffKHz <= 19.5) return 256;
  return 320;
}

// Analyse one track. Returns { cutoffKHz, tier, claimed?, estReal?, spectrum? }
// or null if it couldn't be decoded. Does not touch the cache; caller stores it.
async function analyzeSpectrum(track) {
  if (!window.electronAPI || !window.electronAPI.readAudioFile) return null;
  const q = track.quality;
  if (!q) return null;
  const bytes = await window.electronAPI.readAudioFile(track.path);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const buf = await getSpecCtx().decodeAudioData(ab);
  const sr = buf.sampleRate;
  const data = buf.getChannelData(0);
  const total = data.length;
  if (total < SPEC_FFT) return null;

  const N = SPEC_FFT, half = N >> 1;
  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const winLen = Math.min(total, Math.floor(SPEC_WIN_SEC * sr));
  const start = Math.max(0, Math.floor((total - winLen) / 2));
  const end = Math.min(total, start + winLen);
  const hop = N >> 1; // 50% overlap

  const mag = new Float64Array(half);
  const re = new Float64Array(N), im = new Float64Array(N);
  let frames = 0;
  for (let off = start; off + N <= end; off += hop) {
    for (let i = 0; i < N; i++) { re[i] = data[off + i] * hann[i]; im[i] = 0; }
    fftRadix2(re, im);
    for (let k = 0; k < half; k++) mag[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (frames === 0) return null;
  for (let k = 0; k < half; k++) mag[k] /= frames;

  // dB spectrum, smoothed over a few bins to suppress lone spikes.
  const eps = 1e-9;
  const db = new Float64Array(half);
  for (let k = 0; k < half; k++) db[k] = 20 * Math.log10(mag[k] + eps);
  const sm = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    let s = 0, c = 0;
    for (let d = -2; d <= 2; d++) { const j = k + d; if (j >= 0 && j < half) { s += db[j]; c++; } }
    sm[k] = s / c;
  }

  // Reference level = mean dB in the 300 Hz .. 2 kHz band.
  const binHz = sr / N;
  const lo = Math.max(1, Math.floor(300 / binHz));
  const hi = Math.min(half - 1, Math.floor(2000 / binHz));
  let ref = 0, rc = 0;
  for (let k = lo; k <= hi; k++) { ref += sm[k]; rc++; }
  ref = rc ? ref / rc : 0;
  const thr = ref - 40; // within ~40 dB of the reference = still real signal

  // Walk down from Nyquist; cutoff = highest freq with 3 consecutive bins above thr.
  let cutBin = half - 1;
  for (let k = half - 1; k >= 2; k--) {
    if (sm[k] > thr && sm[k - 1] > thr && sm[k - 2] > thr) { cutBin = k; break; }
  }
  const nyquist = sr / 2;
  const cutoffKHz = Math.min(nyquist, cutBin * binHz) / 1000;

  // Downsampled spectrum (0..1) for the graph, normalised to the reference peak.
  const spectrum = new Array(SPEC_POINTS);
  const peak = Math.max(...mag) || 1;
  for (let p = 0; p < SPEC_POINTS; p++) {
    const k = Math.min(half - 1, Math.floor((p / (SPEC_POINTS - 1)) * (half - 1)));
    spectrum[p] = Math.round(Math.min(1, mag[k] / peak) * 1000) / 1000;
  }

  // Classify.
  const roundCut = Math.round(cutoffKHz * 10) / 10;
  const result = { cutoffKHz: roundCut, tier: q.tier, analyzedAt: Date.now() };
  const claimedHigh = q.lossless || q.bitrate >= 256;
  if (claimedHigh && roundCut <= 16.6) {
    result.tier = 'suspicious';
    result.claimed = q.lossless ? q.bitrate : q.bitrate;
    result.estReal = estBitrateFromCutoff(roundCut);
    result.spectrum = spectrum; // keep the real curve for the inspector graph
  }
  return result;
}

// ── Health-check ──
// Library-scanning dashboard. Cheap issues (bitrate, missing cover, incomplete
// tags, duplicates) are computed instantly from Tier-1 metadata every render;
// the transcode count comes from the cached Tier-2 spectral verdicts and is
// (re)populated by the on-demand "Пересканировать" scan.
let healthReport = (() => {
  try { return JSON.parse(localStorage.getItem(LS.healthReport) || 'null'); }
  catch (_) { return null; }
})();
let healthScanning = false;
let healthFilterPaths = null;   // Set<path> when the library is filtered to a result
let healthFilterLabel = '';

function saveHealthReport() {
  try { localStorage.setItem(LS.healthReport, JSON.stringify(healthReport)); }
  catch (e) { console.warn('health report save failed:', e); }
}

function normDupKey(t) {
  return `${(t.artist || '').trim().toLowerCase()}|${(t.title || '').trim().toLowerCase()}`;
}

// Compute the five issue buckets from the current library + spectral cache.
function computeHealthIssues() {
  const unknownArtist = tr('label.unknownArtist');
  const transcode = [], lowbitrate = [], nocover = [], tags = [], dupes = [];
  const dupMap = new Map();
  for (const t of library) {
    const q = qualityFor(t);
    if (q && q.tier === 'suspicious') transcode.push(t.path);
    if (q && !q.lossless && q.bitrate > 0 && q.bitrate < 192) lowbitrate.push(t.path);
    // Only count a missing cover when we actually know the file has none
    // (hasCover backfilled). Unknown (pre-scan) tracks aren't flagged.
    if (typeof t.hasCover === 'boolean' && !t.hasCover && !coverCache[t.path]) nocover.push(t.path);
    const artistBad = !t.artist || t.artist === 'Unknown Artist' || t.artist === unknownArtist;
    const albumBad = !t.album || t.album === 'Unknown Album';
    if (artistBad || albumBad || !t.year) tags.push(t.path);
    const key = normDupKey(t);
    if (!dupMap.has(key)) dupMap.set(key, []);
    dupMap.get(key).push(t.path);
  }
  for (const paths of dupMap.values()) {
    if (paths.length >= 2) dupes.push(...paths);
  }
  return [
    { id: 'transcode', tone: 'alert', icon: 'i-alert-triangle', paths: transcode },
    { id: 'lowbitrate', tone: 'warn', icon: 'i-activity', paths: lowbitrate },
    { id: 'nocover', tone: 'warn', icon: 'i-image', paths: nocover },
    { id: 'tags', tone: 'warn', icon: 'i-edit', paths: tags },
    { id: 'dupes', tone: 'neutral', icon: 'i-copy', paths: dupes },
  ];
}

// SVG area chart of the frequency spectrum. Feeds on a real spectrum (0..1
// array) when available, else synthesises the envelope from the cutoff.
function buildSpectrumSvg({ spectrum, cutoffKHz = 20, suspicious = false, width = 296, height = 130 }) {
  const nyq = SPEC_SR / 2000;          // ~22.05 kHz on the X axis
  const pad = { l: 6, r: 6, t: 8, b: 20 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const N = SPEC_POINTS - 1;
  const accent = suspicious ? '#e8a045' : '#8fd6c4';
  const gid = 'spec-' + (suspicious ? 's' : 'h');

  // Deterministic jitter so the synthetic fallback isn't a dead-flat line.
  let seed = Math.round(cutoffKHz * 97) >>> 0;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  const pts = [];
  for (let i = 0; i <= N; i++) {
    const f = (i / N) * nyq;
    let e;
    if (spectrum && spectrum.length) {
      e = spectrum[Math.min(spectrum.length - 1, i)];
    } else {
      e = Math.pow(1 - f / (nyq + 4), 0.75) * (0.72 + 0.28 * rand());
      if (f > cutoffKHz) {
        const over = f - cutoffKHz;
        e *= suspicious ? Math.exp(-over * 4.5) : Math.exp(-over * 1.1);
        e = Math.max(e, 0.02 + 0.015 * rand());
      }
    }
    const x = pad.l + (f / nyq) * w;
    const y = pad.t + h - Math.max(0.015, Math.min(1, e)) * h;
    pts.push([x, y]);
  }

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${(pad.l + w).toFixed(1)},${pad.t + h} L${pad.l},${pad.t + h} Z`;
  const cutX = pad.l + (cutoffKHz / nyq) * w;
  const ticks = [0, 5, 10, 15, 20];
  const grid = ticks.map(k => {
    const x = pad.l + (k / nyq) * w;
    return `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${pad.t + h}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
  }).join('');
  const axis = ticks.map(k => {
    const x = pad.l + (k / nyq) * w;
    return `<text x="${x.toFixed(1)}" y="${height - 6}" fill="var(--text-faint)" font-size="9.5" font-family="ui-monospace, monospace" text-anchor="middle">${k}</text>`;
  }).join('');
  const unit = tr('health.khz');
  const marker = suspicious ? `
    <line x1="${cutX.toFixed(1)}" y1="${pad.t}" x2="${cutX.toFixed(1)}" y2="${pad.t + h}" stroke="#e8a045" stroke-width="1.5" stroke-dasharray="4 3"/>
    <rect x="${(cutX + 4).toFixed(1)}" y="${pad.t + 2}" width="88" height="18" rx="4" fill="rgba(232,160,69,0.15)"/>
    <text x="${(cutX + 10).toFixed(1)}" y="${pad.t + 14.5}" fill="#e8a045" font-size="10.5" font-family="ui-monospace, monospace" font-weight="600">${escapeHtml(tr('quality.cutoffMarker'))} ${cutoffKHz} ${escapeHtml(unit)}</text>` : '';

  return `<svg class="spectrum" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0.02"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round"/>
    ${marker}
    <text x="${(pad.l + w).toFixed(1)}" y="${height - 6}" fill="var(--text-faint)" font-size="9.5" font-family="ui-monospace, monospace" text-anchor="end">${escapeHtml(unit)}</text>
    ${axis}
  </svg>`;
}

function firstSuspicious() {
  for (const t of library) {
    const q = qualityFor(t);
    if (q && q.tier === 'suspicious') return { track: t, q };
  }
  return null;
}

function renderHealth() {
  const el = $('health-content');
  if (!el) return;
  // Topbar bits.
  const lastEl = $('health-lastscan');
  if (lastEl) {
    if (healthScanning) lastEl.textContent = '';
    else if (healthReport && healthReport.lastScan) {
      lastEl.textContent = `${tr('health.lastScan')} ${formatScanDate(healthReport.lastScan)}`;
    } else lastEl.textContent = `${tr('health.lastScan')} ${tr('health.never')}`;
  }

  if (library.length === 0) {
    el.innerHTML = `<div class="health-nodata">${escapeHtml(tr('health.noData'))}</div>`;
    return;
  }

  const issues = computeHealthIssues();
  const total = library.length;
  const flaggedSet = new Set();
  issues.forEach(i => i.paths.forEach(p => flaggedSet.add(p)));
  const flagged = flaggedSet.size;
  const ok = Math.max(0, total - flagged);
  const okPct = total ? Math.round((ok / total) * 100) : 100;

  // Featured inspector: the first suspicious track, else a healthy/prompt card.
  const sus = firstSuspicious();
  let inspector;
  if (sus) {
    const spec = qualityCache[sus.track.path] || {};
    const claimed = sus.q.claimed || sus.q.bitrate;
    const estReal = sus.q.estReal || estBitrateFromCutoff(sus.q.cutoffKHz || 16);
    const cut = sus.q.cutoffKHz != null ? sus.q.cutoffKHz : 16;
    const lame = sus.q.hasLame ? '' : tr('health.noLame');
    inspector = `
      <div class="health-inspector">
        <div class="health-inspector-head">
          <svg class="i" width="14" height="14"><use href="#i-alert-triangle"/></svg>
          <span>${escapeHtml(tr('health.transcodeTitle'))}</span>
        </div>
        <div class="health-inspector-track">${escapeHtml(sus.track.title)} — ${escapeHtml(sus.track.artist)}</div>
        <div class="health-inspector-nums">${escapeHtml(tr('health.claimed'))} ${claimed} ${tr('quality.kbps')} · ${escapeHtml(tr('health.real'))} ${estReal} ${tr('quality.kbps')}</div>
        ${buildSpectrumSvg({ spectrum: spec.spectrum, cutoffKHz: cut, suspicious: true })}
        <div class="health-inspector-caption">${escapeHtml(tr('health.spectrumCaption', { cut, lame })).replace(String(cut), `<b>${cut}</b>`)}</div>
      </div>`;
  } else {
    const scanned = healthReport && healthReport.lastScan;
    inspector = `
      <div class="health-inspector" style="border-color:var(--border-strong)">
        <div class="health-inspector-head" style="color:var(--text-strong)">
          <svg class="i" width="14" height="14" style="color:#8fd6c4"><use href="#i-shield"/></svg>
          <span>${escapeHtml(scanned ? tr('health.allGood') : tr('health.transcodeTitle'))}</span>
        </div>
        ${buildSpectrumSvg({ cutoffKHz: 20.5, suspicious: false })}
        <div class="health-inspector-caption">${escapeHtml(scanned ? tr('health.allGoodText') : tr('health.noData'))}</div>
      </div>`;
  }

  const issuesHtml = issues.map(iss => {
    const count = iss.paths.length;
    const fixable = iss.id === 'tags' || iss.id === 'nocover';
    const btn = fixable
      ? `<svg class="i" width="11" height="11"><use href="#i-sparkle"/></svg> ${escapeHtml(tr('health.fix'))}`
      : escapeHtml(tr('health.show'));
    return `
      <div class="health-issue tone-${iss.tone}" data-issue="${iss.id}" ${count === 0 ? 'style="opacity:0.5"' : ''}>
        <div class="health-issue-icon"><svg class="i" width="15" height="15"><use href="#${iss.icon}"/></svg></div>
        <div class="health-issue-body">
          <div class="health-issue-top">
            <span class="health-issue-title">${escapeHtml(tr('issue.' + iss.id + '.title'))}</span>
            <span class="health-issue-count">${count}</span>
          </div>
          <div class="health-issue-desc">${escapeHtml(tr('issue.' + iss.id + '.desc'))}</div>
        </div>
        <button class="health-issue-btn" data-issue-action="${iss.id}" ${count === 0 ? 'disabled style="opacity:0.4;cursor:default"' : ''}>${btn}</button>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="health-grid">
      <div class="health-left">
        <div class="health-score">
          <div class="health-score-label">${escapeHtml(tr('health.scoreLabel'))}</div>
          <div class="health-score-big">
            <span class="health-score-pct">${okPct}%</span>
            <span class="health-score-cap">${escapeHtml(tr('health.ok'))}</span>
          </div>
          <div class="health-bar">
            <div class="health-bar-ok" style="width:${okPct}%"></div>
            <div class="health-bar-flag"></div>
          </div>
          <div class="health-legend">
            <span><span class="dot-ok">●</span> ${ok} ${escapeHtml(tr('health.okLegend'))}</span>
            <span><span class="dot-flag">●</span> ${flagged} ${escapeHtml(tr('health.flaggedLegend'))}</span>
          </div>
        </div>
        ${inspector}
      </div>
      <div class="health-issues">
        <div class="health-issues-label">${escapeHtml(tr('health.issuesLabel'))}</div>
        ${issuesHtml}
      </div>
    </div>`;

  // Wire issue action buttons.
  el.querySelectorAll('[data-issue-action]').forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      const id = btn.dataset.issueAction;
      const iss = issues.find(x => x.id === id);
      if (!iss || iss.paths.length === 0) return;
      const fixable = id === 'tags' || id === 'nocover';
      applyHealthFilter(iss.paths, tr('issue.' + id + '.title'));
      if (fixable && iss.paths[0]) openMetadataEditor(iss.paths[0]);
    });
  });
}

function formatScanDate(ts) {
  try {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString(currentLang, { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `${tr('report.today').toLowerCase()}, ${time}`;
    return `${d.toLocaleDateString(currentLang)}, ${time}`;
  } catch (_) { return ''; }
}

// Filter the library view to a set of paths (from a Health-check issue).
function applyHealthFilter(paths, label) {
  healthFilterPaths = new Set(paths);
  healthFilterLabel = label || '';
  setView('library');
}
function clearHealthFilter() {
  healthFilterPaths = null;
  healthFilterLabel = '';
  const bar = $('library-health-filter');
  if (bar) bar.hidden = true;
}
function updateHealthFilterBar() {
  const bar = $('library-health-filter');
  if (!bar) return;
  if (healthFilterPaths) {
    bar.hidden = false;
    const lbl = $('library-health-filter-label');
    if (lbl) lbl.textContent = tr('health.filterNote', { label: healthFilterLabel });
  } else {
    bar.hidden = true;
  }
}

// On-demand full scan: refresh Tier 1 (cover/tags/bitrate) then run Tier 2
// spectral analysis on every track, reporting progress on the button.
async function runHealthScan() {
  if (healthScanning || library.length === 0) return;
  healthScanning = true;
  const btn = $('health-rescan-btn');
  const label = btn ? btn.querySelector('span') : null;
  const origLabel = label ? label.textContent : '';
  if (btn) btn.classList.add('is-scanning');

  const snapshot = library.slice();
  let done = 0;
  for (const track of snapshot) {
    done++;
    if (label) label.textContent = tr('health.scanning', { n: done, m: snapshot.length });
    // Refresh Tier 1 so cover/tag/bitrate issues reflect the file on disk.
    try {
      const fresh = await window.electronAPI.parseMetadata(track.path);
      if (fresh) {
        const live = trackByPath(track.path);
        if (live) {
          live.quality = fresh.quality;
          live.hasCover = fresh.hasCover;
          if (fresh.cover) coverCache[track.path] = fresh.cover;
        }
      }
    } catch (_) { /* file may be gone; skip */ }
    // Tier 2 spectral.
    try {
      const live = trackByPath(track.path);
      if (live && live.quality) {
        const res = await analyzeSpectrum(live);
        if (res) { qualityCache[track.path] = res; }
      }
    } catch (e) { console.warn('spectral analysis failed for', track.path, e); }
    // Yield so the UI can paint the progress label.
    await new Promise(r => setTimeout(r, 0));
  }

  saveQualityCache();
  saveLibrary();
  healthReport = { lastScan: Date.now(), total: library.length };
  saveHealthReport();
  healthScanning = false;
  if (btn) { btn.classList.remove('is-scanning'); }
  if (label) label.textContent = origLabel || tr('health.rescan');
  refreshCurrentViewRows();
  if (currentView === 'health') renderHealth();
}

// ── Render: track row ──
function renderTrackRow(track, displayIndex, queue) {
  // Backfill covers and (for libraries saved before this feature) Tier-1 quality
  // lazily as rows scroll into view.
  if (!track.cover || track.quality === undefined) ensureCoverFor(track);
  const realIndex = trackIndexByPath(track.path);
  const isPlayingRow = currentTrackIndex >= 0
    && library[currentTrackIndex]
    && library[currentTrackIndex].path === track.path;
  const selectable = librarySelectMode && currentView === 'library';
  const isSelected = selectable && selectedPaths.has(track.path);
  const tr = document.createElement('div');
  tr.className = 'trow' + (isPlayingRow ? ' playing' : '') + (isSelected ? ' selected' : '');
  tr.dataset.path = track.path;
  const numCell = selectable
    ? `<span class="trow-check${isSelected ? ' checked' : ''}"></span>`
    : isPlayingRow
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
    <div class="trow-quality">${qualityBadgeHtml(qualityFor(track))}</div>
    <div class="trow-dur">${formatTime(track.duration)}</div>
    <div class="trow-more"><svg class="i" width="13" height="13"><use href="#i-more"/></svg></div>
  `;
  tr.addEventListener('click', e => {
    if (currentView === 'library') {
      if (librarySelectMode) {
        toggleRowSelection(track.path, e.shiftKey);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click is a shortcut into select mode.
        setLibrarySelectMode(true);
        toggleRowSelection(track.path, false);
        return;
      }
    }
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
  // A Health-check result filter narrows the library to a specific set of files,
  // preserving library order; a search box query narrows within it.
  const base = healthFilterPaths
    ? library.filter(t => healthFilterPaths.has(t.path))
    : sortedFilteredLibrary();
  if (q) {
    return base.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q));
  }
  return base;
}

function renderLibrary() {
  const list = $('library-list');
  const empty = $('library-empty');
  updateHealthFilterBar();
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

// ── Library multi-select ──
function setLibrarySelectMode(on) {
  if (librarySelectMode === on) return;
  librarySelectMode = on;
  selectedPaths.clear();
  lastSelectedPath = null;
  $('btn-select-mode').classList.toggle('active', on);
  $('library-select-bar').hidden = !on;
  updateSelectBar();
  if (currentView === 'library') renderLibrary();
}

function updateSelectBar() {
  $('select-count-label').textContent =
    tr('select.count', { n: withCount('tracks', selectedPaths.size) });
  $('btn-delete-selected').disabled = selectedPaths.size === 0;
}

function toggleRowSelection(path, shiftRange) {
  if (shiftRange && lastSelectedPath && lastSelectedPath !== path) {
    // Shift-click selects the visible range between the last-clicked row and this one.
    const tracks = currentLibraryTracks();
    const a = tracks.findIndex(t => t.path === lastSelectedPath);
    const b = tracks.findIndex(t => t.path === path);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) selectedPaths.add(tracks[i].path);
    } else {
      selectedPaths.add(path);
    }
  } else if (selectedPaths.has(path)) {
    selectedPaths.delete(path);
  } else {
    selectedPaths.add(path);
  }
  lastSelectedPath = path;
  updateSelectBar();
  if (libraryVList) libraryVList.refreshVisible();
}

$('btn-select-mode').addEventListener('click', () => setLibrarySelectMode(!librarySelectMode));
$('btn-cancel-select').addEventListener('click', () => setLibrarySelectMode(false));
$('btn-select-all').addEventListener('click', () => {
  currentLibraryTracks().forEach(t => selectedPaths.add(t.path));
  updateSelectBar();
  if (libraryVList) libraryVList.refreshVisible();
});
$('btn-delete-selected').addEventListener('click', () => {
  if (selectedPaths.size === 0) return;
  confirmDelete({
    kind: 'tracks',
    payload: [...selectedPaths],
    title: tr('modal.deleteTracks.title'),
    text: tr('modal.deleteTracks.text', { count: withCount('tracks', selectedPaths.size) }),
  });
});

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
  pushDiscordActivity(true);
  if (currentView === 'settings') renderDiscordPreviewOnly();
}

function updatePlayButtonUI() {
  const playBtn = $('btn-play').querySelector('use');
  const fsPlayBtn = $('fs-btn-play').querySelector('use');
  playBtn.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
  fsPlayBtn.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
  // Gate the equalizer animation on actual playback (see CSS). Without this the
  // now-playing row's bars keep animating while paused, holding the compositor
  // awake indefinitely (Chromium's "CompositorAnimationObserver active too long").
  document.documentElement.classList.toggle('is-playing', isPlaying);
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

// Health-check controls.
{
  const rescanBtn = $('health-rescan-btn');
  if (rescanBtn) rescanBtn.addEventListener('click', () => runHealthScan());
  const clearBtn = $('library-health-filter-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    clearHealthFilter();
    if (currentView === 'library') renderLibrary();
  });
}

async function importPaths(paths) {
  let added = 0;
  for (const p of paths) {
    if (library.some(t => t.path === p)) continue;
    const metadata = await window.electronAPI.parseMetadata(p);
    if (metadata.cover) coverCache[p] = metadata.cover;
    metadata.addedAt = Date.now();   // for the Listening Report "added to collection" stat
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

// ── Play history logging (feeds the Listening Report) ──
// One log entry per "play session" of a track; `s` accumulates real listened
// seconds via wall-clock deltas on timeupdate (robust to seeking and pausing).
let plEntry = null;     // active log entry (a reference inside playLog) or null
let plLastTick = 0;     // ms timestamp of the last accumulation tick
let plSaveAccum = 0;    // listened seconds since the last persist

function plTick() {
  if (!plEntry || !isPlaying) return;
  const now = Date.now();
  // Clamp the delta so background-tab throttling or long stalls don't inflate totals.
  const dt = Math.min((now - plLastTick) / 1000, 2);
  plEntry.s += dt;
  plSaveAccum += dt;
  plLastTick = now;
}

function plStartIfNeeded() {
  const track = library[currentTrackIndex];
  if (!track) return;
  // Same track resuming after pause → keep the entry, just restart the tick clock.
  if (plEntry && plEntry.p === track.path) { plLastTick = Date.now(); return; }
  plTick(); // flush remaining seconds onto the previous entry before switching
  plEntry = { t: Date.now(), p: track.path, n: track.title || '', a: track.artist || '', b: track.album || '', s: 0 };
  playLog.push(plEntry);
  plLastTick = plEntry.t;
  plSaveAccum = 0;
  savePlayLog();
  refreshReportIfActive();
}

function plFinalize() {
  plTick();
  savePlayLog();
  refreshReportIfActive();
}

function refreshReportIfActive() {
  if (currentView === 'report') renderReport();
}

// ── Listening Report ──────────────────────────────────────────────────────────
// On-device analytics aggregated live from playLog. Nothing leaves the machine.
let reportPeriod = 'day';
const REPORT_LOCALE = { ru: 'ru-RU', en: 'en-US', de: 'de-DE', fr: 'fr-FR', uk: 'uk-UA' };
const REPORT_PLAY_SEC = 15;   // a log entry counts as a "play" once listened ≥ this
const REPORT_STREAK_SEC = 30; // a day counts toward the streak with ≥ this much listening

function reportLocale() { return REPORT_LOCALE[currentLang] || 'en-US'; }
function repStartOfDay(ts) { const x = new Date(ts); x.setHours(0, 0, 0, 0); return x.getTime(); }
function repCap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// { start, end, prevStart, prevEnd } in epoch ms for the selected period.
function reportWindow(period, now = Date.now()) {
  const nd = new Date(now);
  if (period === 'all') {
    return { start: 0, end: now, prevStart: 0, prevEnd: 0 };
  }
  if (period === 'day') {
    const start = repStartOfDay(now);
    return { start, end: now, prevStart: start - 86400000, prevEnd: start };
  }
  if (period === 'month') {
    const start = new Date(nd.getFullYear(), nd.getMonth(), 1).getTime();
    return { start, end: now, prevStart: new Date(nd.getFullYear(), nd.getMonth() - 1, 1).getTime(), prevEnd: start };
  }
  const start = new Date(nd.getFullYear(), 0, 1).getTime();
  return { start, end: now, prevStart: new Date(nd.getFullYear() - 1, 0, 1).getTime(), prevEnd: start };
}

function reportHeading(period, now = Date.now()) {
  const loc = reportLocale();
  const nd = new Date(now);
  const dm = (d) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long' }).format(d);
  const monthOnly = (d) => new Intl.DateTimeFormat(loc, { month: 'long' }).format(d);
  const dmy = (d) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  if (period === 'all') {
    let first = now;
    for (const e of playLog) if (e.t < first) first = e.t;
    return { label: tr('report.allTime'), range: `${dmy(new Date(first))} — ${dmy(nd)}` };
  }
  if (period === 'day') return { label: tr('report.today'), range: dm(nd) };
  if (period === 'month') {
    const m = monthOnly(nd);
    return { label: repCap(m), range: `${m} ${nd.getFullYear()}` };
  }
  return { label: String(nd.getFullYear()), range: `${monthOnly(new Date(nd.getFullYear(), 0, 1))} — ${monthOnly(nd)} ${nd.getFullYear()}` };
}

function fmtListenTime(totalSec) {
  const m = Math.round(totalSec / 60);
  if (m < 60) return { value: String(m), unit: tr('report.minUnit') };
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 100) return { value: `${h}${tr('report.hShort')} ${String(mm).padStart(2, '0')}${tr('report.mShort')}`, unit: '' };
  return { value: h.toLocaleString(reportLocale()), unit: tr('report.hoursUnit') };
}

// Current streak: consecutive days (ending today, or yesterday if nothing today
// yet) with at least REPORT_STREAK_SEC of listening. Global, not period-scoped.
function computeStreak() {
  const days = new Set();
  for (const e of playLog) if (e.s >= REPORT_STREAK_SEC) days.add(repStartOfDay(e.t));
  if (!days.size) return 0;
  let cursor = repStartOfDay(Date.now());
  if (!days.has(cursor)) cursor -= 86400000; // grace: today may have no plays yet
  let streak = 0;
  while (days.has(cursor)) { streak++; cursor -= 86400000; }
  return streak;
}

function computeReport(period) {
  const w = reportWindow(period);
  let sec = 0, prevSec = 0, plays = 0;
  const clock = new Array(24).fill(0);
  const artistAgg = new Map();   // artist -> { name, plays, cover }
  const trackAgg = new Map();    // path   -> { title, artist, plays, cover }
  const artistsSet = new Set();

  for (const e of playLog) {
    if (e.t >= w.start && e.t < w.end) {
      sec += e.s;
      clock[new Date(e.t).getHours()] += e.s;
      if (e.s >= REPORT_PLAY_SEC) {
        plays++;
        const cover = coverCache[e.p] || null;
        if (e.a) artistsSet.add(e.a);
        const ak = e.a || '—';
        const a = artistAgg.get(ak) || { name: e.a || '—', plays: 0, cover: null, path: e.p };
        a.plays++; if (!a.cover) { a.cover = cover; a.path = e.p; }
        artistAgg.set(ak, a);
        const t = trackAgg.get(e.p) || { title: e.n || '—', artist: e.a || '', plays: 0, cover: null, path: e.p };
        t.plays++; if (!t.cover) t.cover = cover;
        trackAgg.set(e.p, t);
      }
    } else if (e.t >= w.prevStart && e.t < w.prevEnd) {
      prevSec += e.s;
    }
  }

  const peak = Math.max(0, ...clock);
  const clockNorm = peak > 0 ? clock.map(v => v / peak) : clock.map(() => 0);
  const minutes = sec / 60, prevMinutes = prevSec / 60;
  let deltaPct = 0;
  if (prevMinutes > 0) deltaPct = Math.round((minutes - prevMinutes) / prevMinutes * 100);
  else if (minutes > 0) deltaPct = 100;
  const newAdds = library.filter(t => t.addedAt && t.addedAt >= w.start && t.addedAt < w.end).length;

  return {
    sec, plays, artists: artistsSet.size, newAdds, deltaPct,
    streak: computeStreak(),
    clock: clockNorm,
    topArtists: [...artistAgg.values()].sort((a, b) => b.plays - a.plays).slice(0, 5),
    topTracks: [...trackAgg.values()].sort((a, b) => b.plays - a.plays).slice(0, 5),
  };
}

// Report items come from the play log, whose tracks are frequently files that
// were never rendered as a visible library row — so their cover was never parsed
// into coverCache and `computeReport` returns cover:null. Parse those covers on
// demand here and re-render the report once they land. Keyed by path; idempotent
// via pendingCoverLoad so repeated renders don't re-spawn parses.
async function ensureReportCovers(r) {
  const paths = [];
  for (const it of [...r.topArtists, ...r.topTracks]) {
    if (!it.cover && it.path && !coverCache[it.path] && !pendingCoverLoad.has(it.path)) {
      paths.push(it.path);
    }
  }
  if (!paths.length) return;
  let gotAny = false;
  await Promise.all(paths.map(async (path) => {
    pendingCoverLoad.add(path);
    try {
      const md = await window.electronAPI.parseMetadata(path);
      if (md && md.cover) { coverCache[path] = md.cover; gotAny = true; }
    } catch (e) { /* file moved / unreadable */ }
  }));
  if (gotAny && currentView === 'report') renderReport();
}

function repCoverHtml(cover, label, round) {
  const cls = `rep-cover${round ? ' rep-cover-round' : ''}`;
  if (cover) return `<div class="${cls}" style="background-image:url('${cover}')"></div>`;
  return `<div class="${cls} rep-cover-empty">${escapeHtml((label || '?')[0] || '?')}</div>`;
}

function repRankHtml(items, kind) {
  if (!items.length) return `<div class="rep-rank-empty">—</div>`;
  const max = Math.max(...items.map(i => i.plays)) || 1;
  return `<div class="rep-rank-list">${items.map((it, i) => {
    const name = kind === 'artist' ? it.name : it.title;
    return `<div class="rep-rank-row">
      <div class="rep-rank-num">${i + 1}</div>
      ${repCoverHtml(it.cover, name, kind === 'artist')}
      <div class="rep-rank-main">
        <div class="rep-rank-name">${escapeHtml(name || '—')}</div>
        ${kind === 'track' ? `<div class="rep-rank-sub">${escapeHtml(it.artist || '')}</div>` : ''}
        <div class="rep-rank-bar"><div class="rep-rank-fill" style="width:${(it.plays / max * 100).toFixed(1)}%"></div></div>
      </div>
      <div class="rep-rank-plays">${it.plays.toLocaleString(reportLocale())} ${tr('report.plays')}</div>
    </div>`;
  }).join('')}</div>`;
}

function repStatHtml(value, unit, label, kind) {
  return `<div class="rep-stat">
    <div class="rep-stat-val${kind ? ' rep-' + kind : ''}">${value}${unit ? `<span class="rep-stat-unit">${unit}</span>` : ''}</div>
    <div class="rep-stat-label">${label}</div>
  </div>`;
}

function renderReport() {
  const el = $('report-content');
  if (!el) return;
  const loc = reportLocale();
  const tabs = ['day', 'month', 'year', 'all']
    .map(k => `<button class="rep-tab${k === reportPeriod ? ' active' : ''}" data-period="${k}">${tr('report.period.' + k)}</button>`)
    .join('');

  if (!playLog.length) {
    el.innerHTML = `
      <div class="rep-head"><div><div class="rep-eyebrow">${tr('report.eyebrow')}</div></div>
        <div class="rep-tabs">${tabs}</div></div>
      <div class="empty-state">
        <div class="empty-icon"><svg class="i" width="24" height="24"><use href="#i-report"/></svg></div>
        <div class="empty-title">${tr('report.empty.title')}</div>
        <div class="empty-text">${tr('report.empty.text')}</div>
      </div>`;
    el.querySelectorAll('.rep-tab').forEach(b => { b.onclick = () => { reportPeriod = b.dataset.period; renderReport(); }; });
    return;
  }

  const r = computeReport(reportPeriod);
  const h = reportHeading(reportPeriod);
  const time = fmtListenTime(r.sec);
  const up = r.deltaPct >= 0;
  const showDelta = reportPeriod !== 'all'; // no "previous period" for all-time

  const clockBars = r.clock.map((v) => {
    const peak = v >= 0.999 && v > 0;
    return `<div class="rep-clock-col"><div class="rep-clock-bar${peak ? ' is-peak' : ''}" style="height:${Math.max(4, v * 100)}%"></div></div>`;
  }).join('');

  el.innerHTML = `
    <div class="rep-head">
      <div>
        <div class="rep-eyebrow">${tr('report.eyebrow')} · ${escapeHtml(h.range)}</div>
        <div class="rep-title">${escapeHtml(h.label)}</div>
      </div>
      <div class="rep-tabs">${tabs}</div>
    </div>

    <div class="rep-top">
      <div class="rep-hero">
        <div class="rep-hero-cap"><svg class="i" width="13" height="13"><use href="#i-clock"/></svg> ${tr('report.listeningTime')}</div>
        <div>
          <div class="rep-hero-time"><span class="rep-hero-num">${time.value}</span>${time.unit ? `<span class="rep-hero-unit">${time.unit}</span>` : ''}</div>
          ${showDelta ? `<div class="rep-hero-delta">
            <span class="rep-delta ${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${Math.abs(r.deltaPct)}%</span>
            <span class="rep-delta-note">${tr('report.vsPrev')}</span>
          </div>` : ''}
        </div>
      </div>
      <div class="rep-stats">
        ${repStatHtml(r.plays.toLocaleString(loc), '', tr('report.tracksPlayed'))}
        ${repStatHtml(r.artists.toLocaleString(loc), '', tr('report.artists'))}
        ${repStatHtml(r.newAdds.toLocaleString(loc), '', tr('report.added'), 'ok')}
        ${repStatHtml(r.streak.toLocaleString(loc), tr('report.days'), tr('report.streak'), 'accent')}
      </div>
    </div>

    <div class="rep-lower">
      <div class="rep-card">
        <div class="rep-card-title"><svg class="i" width="14" height="14"><use href="#i-clock"/></svg> ${tr('report.whenListen')}</div>
        <div class="rep-clock-bars">${clockBars}</div>
        <div class="rep-clock-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
      </div>
      <div class="rep-card">
        <div class="rep-card-title">${tr('report.topArtists')}</div>
        ${repRankHtml(r.topArtists.slice(0, 4), 'artist')}
      </div>
      <div class="rep-card">
        <div class="rep-card-title">${tr('report.topTracks')}</div>
        ${repRankHtml(r.topTracks.slice(0, 4), 'track')}
      </div>
    </div>`;

  el.querySelectorAll('.rep-tab').forEach(b => { b.onclick = () => { reportPeriod = b.dataset.period; renderReport(); }; });

  ensureReportCovers(r);
}

// ── Audio events ──
audio.addEventListener('play', () => { isPlaying = true; updatePlayButtonUI(); plStartIfNeeded(); pushDiscordActivity(true); if (currentView === 'settings') renderDiscordPreviewOnly(); });
audio.addEventListener('pause', () => { plTick(); isPlaying = false; updatePlayButtonUI(); savePlayLog(); pushDiscordActivity(true); if (currentView === 'settings') renderDiscordPreviewOnly(); });
audio.addEventListener('seeked', () => { pushDiscordActivity(true); if (currentView === 'settings') renderDiscordPreviewOnly(); });
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
  plTick();
  if (plSaveAccum >= 15) { plSaveAccum = 0; savePlayLog(); }   // persist periodically, not every tick
  // Keep the Discord preview timer ticking (once per second, settings view only).
  if (currentView === 'settings' && settings.discord.showTimer) {
    const sec = Math.floor(cur);
    if (sec !== discordPreviewSec) { discordPreviewSec = sec; renderDiscordPreviewOnly(); }
  }
});
audio.addEventListener('ended', () => {
  plFinalize();
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
  else if (pendingDelete.kind === 'tracks') deleteTracks(pendingDelete.payload);
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
async function deleteTracks(paths) {
  const deleted = new Set();
  let firstError = null;
  for (const path of paths) {
    const res = await window.electronAPI.deleteFile(path);
    if (res && res.success) deleted.add(path);
    else if (!firstError) firstError = (res && res.error) || tr('error.unknown');
  }
  if (deleted.size > 0) {
    const playingPath = currentTrackIndex >= 0 && library[currentTrackIndex]
      ? library[currentTrackIndex].path : null;
    // Mutate in place: currentQueue may alias the library array.
    for (let i = library.length - 1; i >= 0; i--) {
      if (deleted.has(library[i].path)) library.splice(i, 1);
    }
    if (currentQueue !== library) {
      for (let i = currentQueue.length - 1; i >= 0; i--) {
        if (deleted.has(currentQueue[i].path)) currentQueue.splice(i, 1);
      }
    }
    if (playingPath && deleted.has(playingPath)) {
      audio.pause();
      isPlaying = false;
      currentTrackIndex = -1;
      $('track-title').textContent = tr('np.empty.title');
      $('track-artist').textContent = '—';
      updatePlayButtonUI();
    } else if (playingPath) {
      currentTrackIndex = trackIndexByPath(playingPath);
    }
    favorites = favorites.filter(p => !deleted.has(p));
    recents = recents.filter(p => !deleted.has(p));
    playlists.forEach(pl => { pl.trackPaths = pl.trackPaths.filter(p => !deleted.has(p)); });
    saveLibrary(); savePlaylists(); saveRecents();
    renderCounts();
    renderRecents();
  }
  setLibrarySelectMode(false); // clears selection and re-renders the library view
  refreshCurrentViewRows();
  if (firstError) alert(tr('error.deleteFile') + firstError);
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
  $('cm-select').hidden = currentView !== 'library';
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
    else if (action === 'select') {
      setLibrarySelectMode(true); // no-op if already in select mode (keeps existing selection)
      if (!selectedPaths.has(path)) toggleRowSelection(path, false);
    }
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
    else if (librarySelectMode) setLibrarySelectMode(false);
  }
});

// ── Filters / sort ──
document.querySelectorAll('#view-library .chip[data-filter]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#view-library .chip[data-filter]').forEach(c => c.classList.remove('active'));
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
  'health-check': 'healthCheck',
  'reports': 'reports',
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
  // Discord section starts collapsed (it's large); state persists in settings.
  const dcSection = $('discord-section');
  if (dcSection) dcSection.classList.toggle('is-collapsed', settings.discordCollapsed !== false);
  renderDiscord();
}

// Collapse/expand the Discord Rich Presence settings section (wired once).
const discordToggle = $('discord-toggle');
if (discordToggle) {
  const toggleDiscordSection = () => {
    const sec = $('discord-section');
    if (!sec) return;
    const collapsed = !sec.classList.contains('is-collapsed');
    sec.classList.toggle('is-collapsed', collapsed);
    settings.discordCollapsed = collapsed;
    saveSettings();
  };
  discordToggle.addEventListener('click', toggleDiscordSection);
  discordToggle.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDiscordSection(); }
  });
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
    if (key === 'healthCheck') applyHealthCheckVisibility();
    if (key === 'reports') applyReportsVisibility();
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

// Master switch for the Library Health-check feature: hides the Health nav item,
// the Quality column across every track table, the quality note, and any active
// health filter. Driven by a `quality-off` class on <html> so the CSS collapses
// the grid; JS just keeps the nav + current view consistent.
function applyHealthCheckVisibility(reflow = true) {
  const on = !!settings.healthCheck;
  document.documentElement.classList.toggle('quality-off', !on);
  const navHealth = $('nav-health');
  if (navHealth) navHealth.hidden = !on;
  if (!on) {
    clearHealthFilter();
    if (reflow) {
      if (currentView === 'health') setView('library');
      else refreshCurrentViewRows();
    }
  }
}
applyHealthCheckVisibility(false); // boot: set class/nav only; renderLibrary() runs later

// Toggle for the Listening Report feature: hides only the Report nav item and
// redirects away from the view when off. Play-history logging keeps running
// regardless (plStartIfNeeded/plTick/savePlayLog are playback-driven), so stats
// accumulate silently and are ready the moment the user re-enables the report.
function applyReportsVisibility() {
  const navReport = $('nav-report');
  if (navReport) navReport.hidden = !settings.reports;
  if (!settings.reports && currentView === 'report') setView('library');
}
applyReportsVisibility();

// ── Discord Rich Presence ─────────────────────────────────────────────────────
// Renders the Settings → Discord panel and keeps the activity in sync with
// playback. The live preview mirrors what friends see in the Discord profile.
function discordUserName() {
  if (!discordUser) return '';
  return discordUser.global_name || discordUser.username || '';
}

function dcToggleHtml(key, label, desc) {
  const on = !!settings.discord[key];
  const disabled = !discordConnected;
  return `<div class="setting-row${disabled ? ' is-dimmed' : ''}">
    <div class="setting-text">
      <div class="setting-label">${escapeHtml(tr(label))}</div>
      <div class="setting-desc">${escapeHtml(tr(desc))}</div>
    </div>
    <button class="toggle${on ? ' on' : ''}${disabled ? ' is-disabled' : ''}" data-dsetting="${key}"><div class="toggle-knob"></div></button>
  </div>`;
}

function renderDiscordPreview() {
  const t = currentTrackIndex >= 0 ? library[currentTrackIndex] : null;
  const d = settings.discord;
  const placeholder = !discordConnected;
  const paused = !!t && !isPlaying;
  const eyebrow = placeholder ? tr('discord.previewListening')
    : (paused && d.showPaused ? tr('discord.previewPaused') : tr('discord.previewListening'));
  const cover = t && t.cover ? t.cover : null;
  const coverCss = cover ? `background-image:url('${cover}')` : '';
  let body;
  if (placeholder) {
    body = `<div class="dc-prev-empty">${escapeHtml(tr('discord.previewPlaceholder'))}</div>`;
  } else if (!t) {
    body = `<div class="dc-prev-empty">${escapeHtml(tr('discord.previewEmptyTrack'))}</div>`;
  } else {
    const sub = [t.artist, t.album].filter(Boolean).join(' · ');
    const cur = isFinite(audio.currentTime) ? audio.currentTime : 0;
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    const pct = dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
    const timer = (d.showTimer && isPlaying && dur > 0) ? `
      <div class="dc-prev-bar"><div class="dc-prev-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="dc-prev-times"><span>${formatTime(cur)}</span><span>${formatTime(dur)}</span></div>` : '';
    body = `<div class="dc-prev-activity">
      <div class="dc-prev-art ${d.showCover ? '' : 'dc-prev-art-mono'}" style="${d.showCover ? coverCss : ''}">
        ${d.showCover && !cover ? `<span>${escapeHtml((t.title || '?')[0] || '?')}</span>` : ''}
        <div class="dc-prev-badge"><svg class="i" width="11" height="11"><use href="#i-discord"/></svg></div>
      </div>
      <div class="dc-prev-lines">
        ${d.showTitle ? `<div class="dc-prev-title">${escapeHtml(t.title || '')}</div>` : ''}
        ${d.showArtist && sub ? `<div class="dc-prev-sub">${escapeHtml(sub)}</div>` : ''}
        ${timer}
      </div>
    </div>`;
  }
  const btns = placeholder ? '' : (settings.discord.buttons || [])
    .filter(b => b && b.label && /^https?:\/\//i.test(b.url || ''))
    .slice(0, 2)
    .map(b => `<div class="dc-prev-btn">${escapeHtml(b.label)}</div>`).join('');

  return `<div class="dc-prev-card">
    <div class="dc-prev-user">
      <div class="dc-prev-avatar"></div>
      <div>
        <div class="dc-prev-name">${escapeHtml(discordUserName() || 'Discord')}</div>
        <div class="dc-prev-online">${escapeHtml(tr('discord.previewOnline'))}</div>
      </div>
    </div>
    <div class="dc-prev-divider"></div>
    <div class="dc-prev-eyebrow">${escapeHtml(eyebrow)}</div>
    ${body}
    ${btns ? `<div class="dc-prev-btns">${btns}</div>` : ''}
  </div>`;
}

function renderDiscord() {
  const host = $('discord-body');
  if (!host) return;
  const d = settings.discord;
  const connectLabel = discordConnected ? tr('discord.disconnect') : tr('discord.connect');
  const statusText = discordConnected ? tr('discord.statusConnected') : tr('discord.statusDisconnected');
  const sub = discordConnected
    ? `${escapeHtml(discordUserName())} · ${escapeHtml(tr('discord.sessionActive'))}`
    : escapeHtml(tr('discord.connectHint'));

  const buttonsRows = (d.buttons || []).slice(0, 2).map((b, i) => `
    <div class="setting-row dc-btn-row${discordConnected ? '' : ' is-dimmed'}">
      <div class="dc-btn-field">
        <div class="dc-btn-cap">${escapeHtml(tr('discord.btnLabel'))}</div>
        <input class="dc-input" type="text" data-dbtn="${i}" data-dfield="label" value="${escapeHtml(b.label || '')}" placeholder="${escapeHtml(tr('discord.btnLabelPh'))}" ${discordConnected ? '' : 'disabled'} />
      </div>
      <div class="dc-btn-field dc-btn-field-wide">
        <div class="dc-btn-cap">${escapeHtml(tr('discord.btnUrl'))}</div>
        <input class="dc-input dc-input-mono" type="text" data-dbtn="${i}" data-dfield="url" value="${escapeHtml(b.url || '')}" placeholder="${escapeHtml(tr('discord.btnUrlPh'))}" ${discordConnected ? '' : 'disabled'} />
      </div>
    </div>`).join('');

  host.innerHTML = `
    <div class="setting-card setting-card-tight">
      <div class="dc-conn${discordConnected ? ' is-connected' : ''}">
        <div class="dc-conn-icon"><svg class="i" width="22" height="22"><use href="#i-discord"/></svg></div>
        <div class="dc-conn-main">
          <div class="dc-conn-title">Discord <span class="dc-conn-status">${discordConnected ? '●' : '○'} ${escapeHtml(statusText)}</span></div>
          <div class="dc-conn-sub">${sub}</div>
        </div>
        <button class="btn-ghost dc-conn-btn${discordConnected ? '' : ' dc-conn-btn-primary'}" id="discord-conn-btn">${escapeHtml(connectLabel)}</button>
      </div>
      ${DISCORD_CLIENT_ID ? '' : `<div class="dc-warn">${escapeHtml(tr('discord.noClientId'))}</div>`}
    </div>

    <div class="dc-grid">
      <div class="dc-controls">
        <div class="dc-sublabel">${escapeHtml(tr('discord.show'))}</div>
        <div class="setting-card">
          ${dcToggleHtml('showTitle', 'discord.showTitle', 'discord.showTitleDesc')}
          ${dcToggleHtml('showArtist', 'discord.showArtist', 'discord.showArtistDesc')}
          ${dcToggleHtml('showCover', 'discord.showCover', 'discord.showCoverDesc')}
          ${dcToggleHtml('showTimer', 'discord.showTimer', 'discord.showTimerDesc')}
          ${dcToggleHtml('showPaused', 'discord.showPaused', 'discord.showPausedDesc')}
        </div>

        <div class="dc-sublabel">${escapeHtml(tr('discord.buttons'))}</div>
        <div class="setting-card">${buttonsRows}</div>
        <div class="dc-hint">${escapeHtml(tr('discord.buttonsHint'))}</div>

        <div class="dc-sublabel">${escapeHtml(tr('discord.privacy'))}</div>
        <div class="setting-card">
          ${dcToggleHtml('privacyInvisible', 'discord.privacyInvisible', 'discord.privacyInvisibleDesc')}
          ${dcToggleHtml('privacyPrivate', 'discord.privacyPrivate', 'discord.privacyPrivateDesc')}
        </div>
      </div>

      <div class="dc-preview">
        <div class="dc-sublabel">${escapeHtml(tr('discord.preview'))}</div>
        ${renderDiscordPreview()}
        <div class="dc-prev-note"><svg class="i" width="13" height="13"><use href="#i-info"/></svg><span>${escapeHtml(tr('discord.previewNote'))}</span></div>
      </div>
    </div>`;

  // Wire connect/disconnect
  const connBtn = $('discord-conn-btn');
  if (connBtn) connBtn.addEventListener('click', () => discordConnected ? disconnectDiscord() : connectDiscord());

  // Wire toggles
  host.querySelectorAll('.toggle[data-dsetting]').forEach(t => {
    t.addEventListener('click', () => {
      if (t.classList.contains('is-disabled')) return;
      const key = t.dataset.dsetting;
      settings.discord[key] = !settings.discord[key];
      saveSettings();
      t.classList.toggle('on', settings.discord[key]);
      renderDiscordPreviewOnly();
      pushDiscordActivity(true);
    });
  });

  // Wire button inputs
  host.querySelectorAll('.dc-input[data-dbtn]').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = Number(inp.dataset.dbtn);
      const field = inp.dataset.dfield;
      if (!settings.discord.buttons[i]) settings.discord.buttons[i] = { label: '', url: '' };
      settings.discord.buttons[i][field] = inp.value;
      saveSettings();
      renderDiscordPreviewOnly();
      pushDiscordActivity(false);
    });
  });
}

// Re-paint only the preview card (cheap path on toggle/seek/track change).
function renderDiscordPreviewOnly() {
  const host = $('discord-body');
  if (!host) return;
  const card = host.querySelector('.dc-preview');
  if (!card) return;
  card.innerHTML = `<div class="dc-sublabel">${escapeHtml(tr('discord.preview'))}</div>${renderDiscordPreview()}<div class="dc-prev-note"><svg class="i" width="13" height="13"><use href="#i-info"/></svg><span>${escapeHtml(tr('discord.previewNote'))}</span></div>`;
}

function buildDiscordActivity() {
  const d = settings.discord;
  const t = currentTrackIndex >= 0 ? library[currentTrackIndex] : null;
  if (!t) return null;
  if (!isPlaying && !d.showPaused) return null;
  // Discord requires details/state to be ≥ 2 chars when present.
  const fit = (s, max) => { s = (s || '').slice(0, max); return s.length >= 2 ? s : null; };
  const activity = { instance: false };
  if (d.showTitle) { const v = fit(t.title || 'Unknown', 128); if (v) activity.details = v; }
  if (d.showArtist) { const v = fit([t.artist, t.album].filter(Boolean).join(' · '), 128); if (v) activity.state = v; }
  if (d.showTimer && isPlaying && isFinite(audio.duration) && audio.duration > 0) {
    const startSec = Math.floor((Date.now() - Math.floor(audio.currentTime * 1000)) / 1000);
    activity.timestamps = { start: startSec, end: startSec + Math.round(audio.duration) };
  }
  // Discord's RPC accepts a raw https URL for large_image (only large_image —
  // small_image still needs an uploaded asset key). We resolve a public cover
  // URL per track via the iTunes Search API (see ensureDiscordCover). Until it
  // resolves, or if there's no match, we send no image rather than a broken one.
  if (d.showCover) {
    // Use the resolved iTunes cover; fall back to the Audex logo when there's
    // no match (or briefly, while the lookup is still in flight).
    const cover = discordCoverCache[t.path];
    activity.assets = {
      large_image: cover || AUDEX_LOGO_URL,
      large_text: (t.album || t.title || 'Audex').slice(0, 128),
    };
  }
  const btns = (d.buttons || [])
    .filter(b => b && b.label && /^https?:\/\//i.test(b.url || ''))
    .slice(0, 2)
    .map(b => ({ label: b.label.slice(0, 31), url: b.url }));
  if (btns.length) activity.buttons = btns;
  return activity;
}

// Public album-art URLs resolved from the iTunes Search API, keyed by track
// path. Value is a URL string, or null once looked up with no match. Pending
// lookups are tracked separately so we never fire duplicate requests.
const discordCoverCache = {};
const discordCoverInflight = {};
async function ensureDiscordCover(track) {
  if (!track || !settings.discord.showCover) return;
  if (!window.electronAPI || !window.electronAPI.lookupCover) return;
  const key = track.path;
  if (key in discordCoverCache || discordCoverInflight[key]) return;
  discordCoverInflight[key] = true;
  let url = null;
  try {
    const res = await window.electronAPI.lookupCover({ artist: track.artist, title: track.title, album: track.album });
    url = res && res.url ? res.url : null;
  } catch (_) { url = null; }
  discordCoverCache[key] = url;
  delete discordCoverInflight[key];
  // If this track is still the current one, re-push with the artwork attached.
  if (url && currentTrackIndex >= 0 && library[currentTrackIndex] && library[currentTrackIndex].path === key) {
    pushDiscordActivity(true);
  }
}

let discordPreviewSec = -1;
let discordPushTimer = null;
let discordLastPush = 0;
const DISCORD_PUSH_MIN_MS = 2000; // Discord rate-limits SET_ACTIVITY (~5 / 20s)
function pushDiscordActivity(immediate) {
  if (!discordConnected || !window.electronAPI || !window.electronAPI.discordSetActivity) return;
  const cur = currentTrackIndex >= 0 ? library[currentTrackIndex] : null;
  if (cur && settings.discord.showCover && !(cur.path in discordCoverCache)) ensureDiscordCover(cur);
  const send = () => {
    discordLastPush = Date.now();
    discordPushTimer = null;
    try { window.electronAPI.discordSetActivity(buildDiscordActivity()); } catch (_) {}
  };
  const since = Date.now() - discordLastPush;
  if (immediate || since >= DISCORD_PUSH_MIN_MS) {
    if (discordPushTimer) { clearTimeout(discordPushTimer); discordPushTimer = null; }
    send();
  } else if (!discordPushTimer) {
    discordPushTimer = setTimeout(send, DISCORD_PUSH_MIN_MS - since);
  }
}

// Single connect attempt. Updates state + pushes activity on success; returns a
// boolean so callers (manual button, boot, retry loop) can decide what to do.
async function tryDiscordConnect() {
  if (!window.electronAPI || !window.electronAPI.discordConnect || !DISCORD_CLIENT_ID) return false;
  let res = null;
  try { res = await window.electronAPI.discordConnect(DISCORD_CLIENT_ID); } catch (_) { res = null; }
  if (res && res.ok) {
    discordConnected = true;
    discordUser = res.user || null;
    pushDiscordActivity(true);
    return true;
  }
  discordConnected = false;
  return false;
}

// Background retry: while the integration is enabled but not connected (Discord
// client closed, or not yet launched), poll until it's reachable, then connect
// automatically. Stopped on explicit disconnect.
let discordReconnectTimer = null;
const DISCORD_RECONNECT_MS = 10000;
function stopDiscordReconnect() {
  if (discordReconnectTimer) { clearTimeout(discordReconnectTimer); discordReconnectTimer = null; }
}
function scheduleDiscordReconnect() {
  if (discordReconnectTimer || discordConnected) return;
  if (!settings.discord.enabled || !DISCORD_CLIENT_ID) return;
  discordReconnectTimer = setTimeout(async () => {
    discordReconnectTimer = null;
    if (!settings.discord.enabled || discordConnected) return;
    const ok = await tryDiscordConnect();
    if (ok) { if (currentView === 'settings') renderDiscord(); }
    else scheduleDiscordReconnect();
  }, DISCORD_RECONNECT_MS);
}

async function connectDiscord() {
  if (!window.electronAPI || !window.electronAPI.discordConnect) return;
  if (!DISCORD_CLIENT_ID) { renderDiscord(); return; }
  // Record the intent first so it survives a restart even if Discord isn't up.
  settings.discord.enabled = true;
  saveSettings();
  stopDiscordReconnect();
  const btn = $('discord-conn-btn');
  if (btn) { btn.disabled = true; btn.textContent = tr('discord.connecting'); }
  const ok = await tryDiscordConnect();
  renderDiscord();
  if (!ok) {
    // Discord client not reachable — keep the intent and connect in the
    // background as soon as Discord launches.
    const w = document.querySelector('#discord-body .dc-conn-sub');
    if (w) { w.textContent = tr('discord.waitingForDiscord'); w.classList.add('dc-error'); }
    scheduleDiscordReconnect();
  }
}

async function disconnectDiscord() {
  stopDiscordReconnect();
  if (window.electronAPI && window.electronAPI.discordDisconnect) {
    try { await window.electronAPI.discordDisconnect(); } catch (_) {}
  }
  discordConnected = false;
  discordUser = null;
  settings.discord.enabled = false;
  saveSettings();
  renderDiscord();
}

// Main process pushes status changes (e.g. Discord client quit drops the socket).
// If we still want to be connected, start polling to reconnect automatically.
if (window.electronAPI && window.electronAPI.onDiscordStatus) {
  window.electronAPI.onDiscordStatus(({ connected, user }) => {
    discordConnected = !!connected;
    discordUser = user || null;
    if (currentView === 'settings') renderDiscord();
    if (!connected && settings.discord.enabled) scheduleDiscordReconnect();
  });
}

// On boot, restore the connection if the user had it enabled. If Discord isn't
// running yet, the retry loop keeps trying until it launches.
if (settings.discord.enabled && DISCORD_CLIENT_ID) {
  tryDiscordConnect().then(ok => {
    if (ok) { if (currentView === 'settings') renderDiscord(); }
    else scheduleDiscordReconnect();
  });
}

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
