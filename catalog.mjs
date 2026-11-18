export function group(operator = 'and', children = []) {
  return { type: 'group', operator, children };
}

export function videoCatalog(entries, metadata) {
  const videos = new Map();
  for (const entry of entries) {
    let video = videos.get(entry.videoId);
    if (!video) {
      const details = metadata.get(entry.videoId);
      video = {
        id: entry.videoId,
        title: details?.title || entry.title || 'Video sin título',
        channelTitle: details?.channelTitle || entry.channelTitle || '',
        publishedAt: details?.publishedAt || entry.publishedAt || '',
        thumbnail: details?.thumbnail || entry.thumbnail || '',
        thumbnailOriginal: details?.thumbnailOriginal || entry.thumbnailOriginal || details?.thumbnail || entry.thumbnail || '',
        memberships: new Map(),
      };
      videos.set(video.id, video);
    }
    const dates = video.memberships.get(entry.playlistId) || new Set();
    if (entry.addedAt) dates.add(entry.addedAt);
    video.memberships.set(entry.playlistId, dates);
  }
  return [...videos.values()];
}

function categoryFilter(condition) {
  if (condition.type === 'playlist') {
    return condition.id ? (video) => video.memberships.has(condition.id) : null;
  }
  const checks = condition.children.map(categoryFilter).filter(Boolean);
  if (checks.length === 0) return null;
  return condition.operator === 'and' ? (video) => checks.every((check) => check(video)) :
    (video) => checks.some((check) => check(video));
}

export function localDay(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function withinRange(value, { from, to }) {
  const day = localDay(value);
  return Boolean(day) && (!from || day >= from) && (!to || day <= to);
}

function fold(text) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

export function searchVideos(videos, { condition, query, published, added }) {
  const keyword = fold(query);
  const matchesCategories = categoryFilter(condition);
  if (!keyword && !matchesCategories && !published.from && !published.to && !added.from && !added.to) return videos;
  return videos.filter((video) => {
    if (matchesCategories && !matchesCategories(video)) return false;
    if (keyword && !fold(video.title).includes(keyword)) return false;
    if ((published.from || published.to) && !withinRange(video.publishedAt, published)) return false;
    if (added.from || added.to) {
      const lists = added.playlistId ? [video.memberships.get(added.playlistId) || []] : video.memberships.values();
      return Array.from(lists).some((dates) => Array.from(dates).some((date) => withinRange(date, added)));
    }
    return true;
  });
}

export function videoPage(videos, page, size) {
  const total = Math.max(1, Math.ceil(videos.length / size));
  const number = Math.min(Math.max(1, page), total);
  const start = (number - 1) * size;
  const end = Math.min(start + size, videos.length);
  return { total, number, start, end, items: videos.slice(start, end) };
}

export const demoPlaylists = [
  { id: 'cocina', title: 'cocina' },
  { id: 'slife', title: 'Slife_of_life' },
  { id: 'system', title: 'system' },
];

export const demoVideos = videoCatalog([
  ['v01', 'slife', '2025-11-08'], ['v01', 'system', '2025-10-11'],
  ['v02', 'cocina', '2025-10-19'],
  ['v03', 'cocina', '2025-11-12'], ['v03', 'slife', '2025-11-13'],
  ['v05', 'system', '2025-10-22'],
].map(([videoId, playlistId, day]) => ({ videoId, playlistId, addedAt: `${day}T12:00:00Z` })), new Map([
  ['v01', { title: 'v01 · Organiza tu espacio de trabajo', publishedAt: '2025-09-16T12:00:00Z' }],
  ['v02', { title: 'v02 · Cocina para una tarde de domingo', publishedAt: '2025-10-03T12:00:00Z' }],
  ['v03', { title: 'v03 · Cocinar sin prisa', publishedAt: '2025-11-02T12:00:00Z' }],
  ['v05', { title: 'v05 · Un sistema para tus notas', publishedAt: '2025-08-27T12:00:00Z' }],
]));
