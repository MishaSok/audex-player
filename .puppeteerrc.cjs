const { join } = require('path');

// Pin Chromium download to a project-local dir so electron-builder packs it
// via asarUnpack. A non-dotted name avoids the default hidden-file ignore.
module.exports = {
  cacheDirectory: join(__dirname, 'chromium-bundle'),
};
