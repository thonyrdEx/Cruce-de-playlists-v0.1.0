import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sessionHandler } from '../session.mjs';

test('recupera la sesión y su catálogo, y permite borrar la caché sin salir', async (context) => {
  const realFetch = globalThis.fetch;
  const calls = [];
  let revoked = false;
  let pausePlaylistLoad;
  context.mock.method(globalThis, 'fetch', async (input, { headers, signal } = {}) => {
    const url = new URL(input);
    const endpoint = url.pathname.split('/').at(-1);
    calls.push(endpoint);
    if (endpoint === 'channels') {
      if (revoked) return Response.json({}, { status: 401 });
      const id = headers.Authorization === 'Bearer otro-token' ? 'otro-canal' : 'mi-canal';
      return Response.json({ items: [{ id, snippet: { title: id } }] });
    }
    if (endpoint === 'playlists') {
      if (pausePlaylistLoad) {
        pausePlaylistLoad();
        signal.throwIfAborted();
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return Response.json({ items: [{ id: 'lista', snippet: { title: 'Mi lista' }, status: { privacyStatus: 'private' } }] });
    }
    if (endpoint === 'playlistItems') {
      return Response.json({ items: [{ contentDetails: { videoId: 'video' }, snippet: { publishedAt: '2025-11-08T12:00:00Z' } }] });
    }
    assert.equal(endpoint, 'videos');
    return Response.json({ items: [{ id: 'video', snippet: { title: 'Un video' } }] });
  });

  const directory = await mkdtemp(join(tmpdir(), 'cruce-sesion-'));
  const handle = sessionHandler(directory);
  const server = createServer((request, response) => handle(request, response, request.url.split('?')[0]));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const file of await readdir(directory)) await rm(join(directory, file), { force: true });
    await rmdir(directory);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const request = (path, { method = 'GET', cookie, token, source = origin } = {}) => realFetch(`${origin}/api/${path}`, {
    method, headers: { origin: source, ...(cookie && { cookie }), ...(token && { 'Content-Type': 'application/json' }) },
    body: token && JSON.stringify({ token, expiresIn: 3600 }),
  });
  const login = (token, cookie) => request('session', { method: 'POST', token, cookie });
  const guest = await request('session');
  assert.deepEqual(await guest.json(), {});
  const denied = await request('session', { method: 'POST', token: 'token-de-prueba', source: 'https://example.org' });
  assert.equal(denied.status, 403);
  await denied.text();

  const connected = await login('token-de-prueba');
  const setCookie = connected.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(setCookie, /token-de-prueba/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await connected.json()).snapshot, null);

  const loading = await request('catalog', { method: 'POST', cookie });
  const events = (await loading.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(({ progress }) => progress));
  const { snapshot } = events.at(-1);
  assert.deepEqual(snapshot.catalog.videos[0].memberships, [['lista', ['2025-11-08T12:00:00Z']]]);
  assert.equal((await readdir(directory)).length, 1);
  calls.length = 0;

  const restored = await request('session', { cookie });
  const details = await restored.json();
  assert.deepEqual(details.snapshot, snapshot);
  assert.deepEqual(calls, ['channels']);
  assert.equal((await (await login('otro-token')).json()).snapshot, null);

  const noDuplicate = await request('catalog?resume=1', { method: 'POST', cookie });
  assert.deepEqual(JSON.parse(await noDuplicate.text()).snapshot, snapshot);
  assert.deepEqual(calls, ['channels', 'channels']);

  const enteringSync = new Promise((resolve) => { pausePlaylistLoad = resolve; });
  const pending = request('catalog', { method: 'POST', cookie });
  await enteringSync;
  const cleared = await request('catalog', { method: 'DELETE', cookie });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.headers.get('set-cookie'), null);
  await cleared.json();
  assert.match(await (await pending).text(), /Se canceló la actualización/);
  pausePlaylistLoad = undefined;
  assert.deepEqual(await readdir(directory), []);
  const empty = await (await request('session', { cookie })).json();
  assert.equal(empty.channel.id, 'mi-canal');
  assert.equal(empty.snapshot, null);

  await (await request('catalog', { method: 'POST', cookie })).text();
  revoked = true;
  const rejected = await request('session', { cookie });
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers.get('set-cookie'), /Max-Age=0/);
  await rejected.json();
  assert.deepEqual(await readdir(directory), []);
});
