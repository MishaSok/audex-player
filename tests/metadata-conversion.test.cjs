const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function syncsafe(size) {
  return Buffer.from([size >>> 21 & 127, size >>> 14 & 127, size >>> 7 & 127, size & 127]);
}
function frame(version, id, data) {
  const header = Buffer.alloc(version === 2 ? 6 : 10);
  header.write(id);
  if (version === 2) header.writeUIntBE(data.length, 3, 3);
  else header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}
for (const version of [2, 3]) {
  test(`converts ID3v2.${version} and preserves metadata and audio`, async t => {
    const mm = await import('music-metadata');
    const source = await fs.readFile(path.join(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf("ipcMain.handle('music:writeMetadata'");
    const end = source.indexOf("ipcMain.handle('shell:revealInFolder'", start);
    let write;
    vm.runInNewContext(source.slice(start, end).replace("await import('music-metadata')", 'metadataModule'), {
      ipcMain: { handle: (_, handler) => { write = handler; } }, path, metadataModule: mm
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audex-tags-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'track.mp3');
    const text = value => Buffer.from('\0' + value);
    const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
    const body = Buffer.concat([
      frame(version, version === 2 ? 'TT2' : 'TIT2', text('Old title')),
      frame(version, version === 2 ? 'TP1' : 'TPE1', text('Old artist')),
      frame(version, version === 2 ? 'TAL' : 'TALB', text('Keep album')),
      frame(version, version === 2 ? 'TRK' : 'TRCK', text('2/12')),
      frame(version, version === 2 ? 'TXX' : 'TXXX', text('CUSTOM\0Keep custom')),
      frame(version, version === 2 ? 'PIC' : 'APIC', Buffer.concat([
        Buffer.from(version === 2 ? '\0PNG\x03\0' : '\0image/png\0\x03\0'), picture
      ]))
    ]);
    const audioFrame = Buffer.alloc(417);
    Buffer.from([0xff, 0xfb, 0x90, 0]).copy(audioFrame);
    const audio = Buffer.concat([audioFrame, audioFrame, audioFrame]);
    await fs.writeFile(file, Buffer.concat([Buffer.from([73, 68, 51, version, 0, 0]), syncsafe(body.length), body, audio]));
    const result = await write(null, { filePath: file, tags: { title: 'New title', artist: 'New artist' } });
    assert.equal(result.success, true, result.error);
    const parsed = await mm.parseFile(file);
    assert.ok(parsed.format.tagTypes.includes('ID3v2.4'));
    assert.equal(parsed.common.title, 'New title');
    assert.equal(parsed.common.artist, 'New artist');
    assert.equal(parsed.common.album, 'Keep album');
    assert.deepEqual(parsed.common.track, { no: 2, of: 12 });
    assert.deepEqual(Buffer.from(parsed.common.picture[0].data), picture);
    assert.equal(parsed.native['ID3v2.4'].find(tag => tag.id === 'TXXX:CUSTOM').value, 'Keep custom');
    assert.deepEqual((await fs.readFile(file)).subarray(-audio.length), audio);
    const second = await write(null, { filePath: file, tags: { title: 'Second title' } });
    assert.equal(second.success, true, second.error);
    assert.equal((await mm.parseFile(file)).common.album, 'Keep album');
  });
}
