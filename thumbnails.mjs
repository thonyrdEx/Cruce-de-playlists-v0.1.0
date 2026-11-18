import { Buffer } from 'node:buffer';
import { pipeline } from 'node:stream/promises';
import { zipArchive } from './zip.mjs';

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const hosts = new Set(['img.youtube.com', 'i.ytimg.com', 'i1.ytimg.com', 'i2.ytimg.com', 'i3.ytimg.com', 'i4.ytimg.com', 'i9.ytimg.com']);
const extensions = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif'], ['image/avif', 'avif'],
]);
const maxImageSize = 4 * 1024 * 1024;
const maxRequestSize = 24 * 1024 * 1024;
const maxVideos = 60000;

function approvedUrl(value, id) {
  if (typeof value !== 'string') return null;
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.has(url.hostname)) return null;
  const match = url.pathname.match(/^\/(?:vi|vi_webp)\/([^/]+)\/[^/]+$/);
  return match?.[1] === id ? url : null;
}

function normalizeVideos(videos) {
  const unique = new Map();
  for (const { id, original, preview } of videos) {
    if (typeof id !== 'string' || !videoIdPattern.test(id)) throw new Error('Un ID de video no es válido.');
    const urls = unique.get(id) || new Map();
    for (const value of [original, preview]) {
      const url = approvedUrl(value, id);
      if (url) urls.set(url.href, url);
    }
    unique.set(id, urls);
  }
  return unique;
}

async function fetchImage(url, signal) {
  const result = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
  const extension = extensions.get(result.headers.get('content-type')?.split(';')[0].trim());
  if (!result.ok || !extension || Number(result.headers.get('content-length')) > maxImageSize) {
    await result.body?.cancel();
    return null;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of result.body || []) {
    size += chunk.length;
    if (size > maxImageSize) return null;
    chunks.push(chunk);
  }
  return size ? { extension, data: Buffer.concat(chunks, size) } : null;
}

async function downloadVideo([id, urls], signal) {
  for (const url of urls.values()) {
    signal.throwIfAborted();
    try {
      const image = await fetchImage(url, signal);
      if (image) return { name: `${id}.${image.extension}`, data: image.data };
    } catch {
      signal.throwIfAborted();
    }
  }
  return { id, reason: urls.size ? 'No se pudo recuperar la imagen' : 'YouTube no entregó una URL compatible' };
}

async function* archiveFiles(videos, signal) {
  const items = [...videos];
  const skipped = [];
  let bytes = 0;
  // Leave room for ZIP32 headers, the directory and an omissions report.
  const imageBudget = 0xffffffff - 16 * 1024 * 1024;
  for (let start = 0; start < items.length; start += 6) {
    signal.throwIfAborted();
    if (bytes >= imageBudget) {
      for (const [id] of items.slice(start)) skipped.push(`${id}\tLímite de tamaño del ZIP`);
      break;
    }
    const batch = await Promise.all(items.slice(start, start + 6).map((item) => downloadVideo(item, signal)));
    for (const file of batch) {
      if (file.data && bytes + file.data.length <= imageBudget) {
        bytes += file.data.length;
        yield file;
      } else {
        skipped.push(file.data ? `${file.name.split('.')[0]}\tLímite de tamaño del ZIP` : `${file.id}\t${file.reason}`);
      }
    }
  }
  if (skipped.length) {
    yield { name: 'miniaturas-no-descargadas.txt', data: Buffer.from(`ID del video\tMotivo\r\n${skipped.join('\r\n')}\r\n`) };
  }
}

export async function sendThumbnails(request, response) {
  if (request.method !== 'POST' || request.headers.origin !== `http://${request.headers.host}`) {
    response.writeHead(403).end('Descarga disponible desde la aplicación local.');
    return;
  }
  if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    response.writeHead(415).end('Formato de solicitud incorrecto.');
    return;
  }

  let videos;
  let fileName;
  try {
    if (Number(request.headers['content-length']) > maxRequestSize) throw new Error('La solicitud es demasiado grande.');
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > maxRequestSize) throw new Error('La solicitud es demasiado grande.');
      chunks.push(chunk);
    }
    const form = new URLSearchParams(Buffer.concat(chunks, total).toString('utf8'));
    const items = JSON.parse(form.get('videos'));
    if (!Array.isArray(items) || items.length === 0 || items.length > maxVideos) throw new Error('Cantidad de videos no compatible.');
    videos = normalizeVideos(items);
    const scope = form.get('scope');
    fileName = scope === 'all' ? 'miniaturas-todas.zip' : scope === 'playlist' ? 'miniaturas-playlist.zip' : 'miniaturas-filtradas.zip';
  } catch {
    if (!response.destroyed) response.writeHead(400).end('No se pudo leer la selección de miniaturas.');
    return;
  }

  const cancel = new AbortController();
  response.once('close', () => cancel.abort());
  response.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${fileName}"`,
  });
  response.flushHeaders();
  try {
    await pipeline(zipArchive(archiveFiles(videos, cancel.signal)), response, { signal: cancel.signal });
  } catch {
    response.destroy();
  }
}
