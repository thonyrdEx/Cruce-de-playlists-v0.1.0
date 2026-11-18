import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPlaylists, demoVideos, group, localDay, searchVideos, videoPage } from '../catalog.mjs';
import { playlistCsv } from '../csv.mjs';
import { privateCatalog } from '../youtube.mjs';

const category = (id) => ({ type: 'playlist', id });
const filters = { condition: group(), query: '', published: {}, added: {} };
const ids = (videos) => videos.map(({ id }) => id);

test('cruza grupos Y/O y filtra la fecha de la playlist indicada', () => {
  const condition = group('and', [group('or', [category('cocina'), category('system')]), category('slife')]);
  const results = searchVideos(demoVideos, { ...filters, condition });
  assert.deepEqual(ids(results), ['v01', 'v03']);
  assert.deepEqual(ids(searchVideos(demoVideos, { ...filters, condition: category('system') })), ['v01', 'v05']);
  const day = localDay('2025-10-11T12:00:00Z');
  const added = { playlistId: 'system', from: day, to: day };
  assert.deepEqual(ids(searchVideos(demoVideos, { ...filters, condition, added })), ['v01']);
  assert.deepEqual(ids(searchVideos(demoVideos, { ...filters, condition, added: { ...added, playlistId: 'slife' } })), []);
});

test('el CSV conserva una fila por video y playlist y la fecha de cada una', () => {
  const [header, first, second, end] = playlistCsv([demoVideos[0]], demoPlaylists, { example: true }).split('\r\n');
  assert.ok(header.startsWith('\uFEFF"ID del video"'));
  assert.match(first, /"v01".*"Slife_of_life".*"2025-11-08T12:00:00Z"/);
  assert.match(second, /"v01".*"system".*"2025-10-11T12:00:00Z"/);
  assert.equal(end, '');
});

test('importa un catálogo grande de forma paginada y busca fuera de la página visible', async (context) => {
  const size = 5037;
  const queriedLists = new Set();
  context.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    const endpoint = url.pathname.split('/').at(-1);
    const query = url.searchParams;
    if (endpoint === 'playlists') {
      assert.equal(query.get('mine'), 'true');
      const playlist = (id, privacyStatus) => ({ id, snippet: { title: id }, status: { privacyStatus } });
      return query.get('pageToken') ? Response.json({ items: [playlist('two', 'private')] }) :
        Response.json({ items: [playlist('one', 'private'), playlist('public', 'public')], nextPageToken: 'next' });
    }
    if (endpoint === 'playlistItems') {
      const list = query.get('playlistId');
      queriedLists.add(list);
      const start = Number(query.get('pageToken'));
      const count = list === 'one' ? size : 1;
      const end = Math.min(start + 50, count);
      const items = Array.from({ length: end - start }, (_, index) => ({
        snippet: { publishedAt: '2025-10-11T12:00:00Z' },
        contentDetails: { videoId: String(list === 'one' ? start + index : size - 1) },
      }));
      return Response.json({ items, nextPageToken: end < count ? String(end) : undefined });
    }
    assert.equal(endpoint, 'videos');
    const batch = query.get('id').split(',');
    assert.ok(batch.length <= 50);
    return Response.json({ items: batch.map((id) => ({ id, snippet: { title: `Video ${id}` } })) });
  });

  const { playlists, videos } = await privateCatalog('fake-token', new AbortController().signal, () => {});
  assert.deepEqual(queriedLists, new Set(['one', 'two']));
  assert.equal(videos.length, size);
  assert.equal(videoPage(videos, 1, 24).items.length, 24);
  const last = videoPage(videos, 210, 24);
  assert.equal(last.items.length, 21);
  assert.equal(last.items.at(-1).id, '5036');
  const results = searchVideos(videos, { ...filters, query: '5036', condition: category('two') });
  assert.deepEqual(ids(results), ['5036']);
  assert.equal(playlistCsv(results, playlists).trim().split('\r\n').length, 3);
});
