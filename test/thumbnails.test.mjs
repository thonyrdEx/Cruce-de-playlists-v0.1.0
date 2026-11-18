import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { sendThumbnails } from '../thumbnails.mjs';

function zipContents(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const files = new Map();
  let entry = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i += 1) {
    assert.equal(zip.readUInt32LE(entry), 0x02014b50);
    const offset = zip.readUInt32LE(entry + 42);
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const nameLength = zip.readUInt16LE(entry + 28);
    const name = zip.toString('utf8', entry + 46, entry + 46 + nameLength);
    const start = offset + 30 + zip.readUInt16LE(offset + 26);
    const crc = zip.readUInt32LE(entry + 16);
    assert.equal(crc, zip.readUInt32LE(offset + 14));
    assert.ok(!files.has(name), `Archivo repetido: ${name}`);
    files.set(name, { crc, data: zip.subarray(start, start + zip.readUInt32LE(entry + 20)) });
    entry += 46 + nameLength;
  }
  assert.equal(entry, end);
  return files;
}

test('exporta una imagen por ID, usa respaldo y registra omisiones en ZIP', async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'i.ytimg.com');
    assert.equal(options.redirect, 'error');
    calls.push(url.pathname);
    if (url.pathname.endsWith('/maxresdefault.jpg')) return new Response('', { status: 404 });
    return new Response('123456789', { headers: { 'content-type': 'image/jpeg' } });
  });
  const server = createServer(sendThumbnails);
  server.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/miniaturas.zip`;
  const shared = {
    id: 'shared00001', original: 'https://i.ytimg.com/vi/shared00001/maxresdefault.jpg',
    preview: 'https://i.ytimg.com/vi/shared00001/default.jpg',
  };
  const body = new URLSearchParams({ scope: 'all', videos: JSON.stringify([
    shared, shared, { id: 'blocked0000', original: 'https://example.org/vi/blocked0000/default.jpg' },
  ]) });

  const denied = await originalFetch(url, { method: 'POST', headers: { origin: 'https://example.org' }, body });
  assert.equal(denied.status, 403);
  await denied.text();
  const response = await originalFetch(url, { method: 'POST', headers: { origin }, body });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /miniaturas-todas\.zip/);
  const files = zipContents(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(calls, ['/vi/shared00001/maxresdefault.jpg', '/vi/shared00001/default.jpg']);
  assert.deepEqual([...files.keys()], ['shared00001.jpg', 'miniaturas-no-descargadas.txt']);
  assert.equal(files.get('shared00001.jpg').data.toString(), '123456789');
  assert.equal(files.get('shared00001.jpg').crc, 0xcbf43926);
  assert.match(files.get('miniaturas-no-descargadas.txt').data.toString(), /blocked0000/);
});
