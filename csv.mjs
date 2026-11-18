const columns = [
  'ID del video', 'Título', 'Enlace de YouTube', 'ID de playlist', 'Playlist',
  'Fecha de publicación', 'Fechas de incorporación', 'URL de miniatura',
];

function csvCell(value) {
  let text = String(value ?? '');
  // Playlist and video titles are user-provided text and can resemble formulas.
  if (/^[\t\r\n]|^\s*[=+\-@＝＋－＠]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function playlistCsv(videos, playlists, { playlistId = '', example = false } = {}) {
  const titles = new Map(playlists.map(({ id, title }) => [id, title]));
  const rows = [columns.map(csvCell).join(',')];
  for (const video of videos) {
    for (const [id, dates] of video.memberships) {
      if (playlistId && playlistId !== id) continue;
      const row = [
        video.id,
        video.title,
        example ? '' : `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
        id,
        titles.get(id),
        video.publishedAt,
        [...dates].sort().join(' | '),
        example ? '' : video.thumbnailOriginal || video.thumbnail,
      ];
      rows.push(row.map(csvCell).join(','));
    }
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}
