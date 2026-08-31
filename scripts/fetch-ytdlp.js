// Downloads the standalone yt-dlp binary for the current platform into
// yt-dlp-bundle/ so electron-builder can ship it (see build.files /
// build.asarUnpack in package.json). Runs as the `postinstall` script, so
// each CI runner fetches its own platform binary during `npm ci`.
//
// The version is pinned for reproducible builds — bump YTDLP_VERSION to
// update. yt-dlp goes stale fast (sites change), so refresh it periodically.

const fs = require('fs');
const path = require('path');
const https = require('https');

const YTDLP_VERSION = '2026.08.19';

const ASSET = {
  linux: 'yt-dlp_linux',
  darwin: 'yt-dlp_macos',
  win32: 'yt-dlp.exe',
}[process.platform];

if (!ASSET) {
  console.warn(`[fetch-ytdlp] unsupported platform ${process.platform} — skipping`);
  process.exit(0);
}

const bundleDir = path.join(__dirname, '..', 'yt-dlp-bundle');
const dest = path.join(bundleDir, ASSET);
const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${ASSET}`;

// A version marker next to the binary, so bumping YTDLP_VERSION actually
// re-downloads instead of silently keeping a stale (and by now 403-prone) build.
const stamp = path.join(bundleDir, 'VERSION');
const haveVersion = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '';

if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000 && haveVersion === YTDLP_VERSION) {
  console.log(`[fetch-ytdlp] ${ASSET} ${YTDLP_VERSION} already present — skipping`);
  process.exit(0);
}
if (fs.existsSync(dest) && haveVersion !== YTDLP_VERSION) {
  console.log(`[fetch-ytdlp] have ${haveVersion || 'unknown'}, want ${YTDLP_VERSION} — refreshing`);
}

fs.mkdirSync(bundleDir, { recursive: true });

function download(from, redirectsLeft, cb) {
  https.get(from, { headers: { 'User-Agent': 'audex-player-build' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      if (redirectsLeft <= 0) return cb(new Error('too many redirects'));
      res.resume();
      return download(res.headers.location, redirectsLeft - 1, cb);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return cb(new Error(`HTTP ${res.statusCode} for ${from}`));
    }
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    res.pipe(file);
    file.on('finish', () => file.close(() => {
      fs.renameSync(tmp, dest);
      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
      cb(null);
    }));
    file.on('error', cb);
  }).on('error', cb);
}

console.log(`[fetch-ytdlp] downloading yt-dlp ${YTDLP_VERSION} (${ASSET})…`);
download(url, 5, (err) => {
  if (err) {
    console.error(`[fetch-ytdlp] FAILED: ${err.message}`);
    process.exit(1);
  }
  fs.writeFileSync(stamp, YTDLP_VERSION + '\n');
  console.log(`[fetch-ytdlp] saved ${dest}`);
});
