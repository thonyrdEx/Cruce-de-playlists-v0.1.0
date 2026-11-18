import { videoCatalog } from './catalog.mjs';

export const readOnlyScope = 'https://www.googleapis.com/auth/youtube.readonly';

const imageFields = 'thumbnails(default(url),medium(url),high(url),standard(url),maxres(url))';

function thumbnailUrls(snippet) {
  const images = snippet.thumbnails || {};
  const original = images.maxres || images.standard || images.high || images.medium || images.default;
  const preview = images.medium || images.high || images.default || original;
  return { thumbnail: preview?.url, thumbnailOriginal: original?.url };
}

async function get(token, endpoint, parameters, signal) {
  const query = new URLSearchParams(parameters);
  const response = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  const data = await response.json();
  if (!response.ok) {
    const reason = data.error?.errors?.[0]?.reason;
    const error = new Error(response.status === 401 ? 'La sesión de YouTube venció. Vuelve a conectar tu canal.' :
      reason === 'accessNotConfigured' ? 'Activa YouTube Data API v3 en tu proyecto de Google Cloud.' :
      ['quotaExceeded', 'dailyLimitExceeded'].includes(reason) ? 'El proyecto alcanzó su cuota de YouTube. Intenta de nuevo cuando se restablezca.' :
      `YouTube no pudo completar la consulta (${reason || response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function currentChannel(token, signal) {
  const result = await get(token, 'channels', { part: 'snippet', mine: 'true', fields: 'items(id,snippet(title))' }, signal);
  const channel = result.items?.[0];
  if (!channel) throw new Error('La cuenta seleccionada no tiene un canal de YouTube accesible.');
  return { id: channel.id, title: channel.snippet.title };
}

async function readPages(token, endpoint, parameters, signal, onPage) {
  const items = [];
  let pageToken = '';
  do {
    const data = await get(token, endpoint, { ...parameters, maxResults: '50', ...(pageToken && { pageToken }) }, signal);
    const page = data.items || [];
    items.push(...page);
    onPage?.(page.length);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

async function mapInBatches(items, load) {
  const results = [];
  for (let start = 0; start < items.length; start += 4) {
    results.push(...await Promise.all(items.slice(start, start + 4).map(load)));
  }
  return results;
}

export async function privateCatalog(token, signal, reportProgress) {
  const owned = await readPages(token, 'playlists', {
    part: 'snippet,status', mine: 'true', fields: 'nextPageToken,items(id,snippet(title,channelTitle),status(privacyStatus))',
  }, signal);
  const playlists = owned.filter((item) => item.status.privacyStatus === 'private')
    .map((item) => ({ id: item.id, title: item.snippet.title }));

  let listCount = 0;
  let entryCount = 0;
  const reportLists = () => reportProgress(`Playlists leídas: ${listCount} de ${playlists.length} · ${entryCount} elementos`);
  reportLists();
  const playlistEntries = await mapInBatches(playlists, async (playlist) => {
    const items = await readPages(token, 'playlistItems', {
      part: 'snippet,contentDetails', playlistId: playlist.id,
      fields: `nextPageToken,items(snippet(publishedAt,title,${imageFields},videoOwnerChannelTitle,resourceId(videoId)),contentDetails(videoId,videoPublishedAt))`,
    }, signal, (count) => {
      entryCount += count;
      reportLists();
    });
    listCount += 1;
    reportLists();
    const entries = [];
    for (const { snippet, contentDetails } of items) {
      const videoId = contentDetails?.videoId || snippet?.resourceId?.videoId;
      if (!videoId) continue;
      entries.push({
        videoId, playlistId: playlist.id,
        title: snippet?.title, addedAt: snippet?.publishedAt,
        publishedAt: contentDetails?.videoPublishedAt,
        ...thumbnailUrls(snippet || {}), channelTitle: snippet?.videoOwnerChannelTitle,
      });
    }
    return entries;
  });
  const entries = playlistEntries.flat();

  const metadata = new Map();
  const ids = [...new Set(entries.map(({ videoId }) => videoId))];
  const batches = [];
  for (let start = 0; start < ids.length; start += 50) {
    batches.push(ids.slice(start, start + 50));
  }
  let checked = 0;
  const reportDetails = () => reportProgress(`Consultando fechas y miniaturas: ${checked} de ${ids.length} videos`);
  if (ids.length) reportDetails();
  await mapInBatches(batches, async (batch) => {
    const result = await get(token, 'videos', {
      part: 'snippet', id: batch.join(','),
      fields: `items(id,snippet(title,channelTitle,publishedAt,${imageFields}))`,
    }, signal);
    for (const { id, snippet } of result.items || []) {
      const { title, channelTitle, publishedAt } = snippet;
      metadata.set(id, { title, channelTitle, publishedAt, ...thumbnailUrls(snippet) });
    }
    checked += batch.length;
    reportDetails();
  });
  return { channelTitle: owned[0]?.snippet.channelTitle, playlists, videos: videoCatalog(entries, metadata) };
}
