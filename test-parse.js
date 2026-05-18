const mm = require('music-metadata');
mm.parseFile(__filename).then(res => console.log('success')).catch(e => console.error('Error:', e.message));
