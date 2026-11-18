import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { sendThumbnails } from './thumbnails.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/catalog.mjs', ['catalog.mjs', 'text/javascript']],
  ['/csv.mjs', ['csv.mjs', 'text/javascript']],
  ['/youtube.mjs', ['youtube.mjs', 'text/javascript']],
]);

const port = 4317;
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  response.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self' https://accounts.google.com/gsi/",
    "style-src 'self' https://accounts.google.com/gsi/style", "img-src 'self' https://*.ytimg.com https://img.youtube.com",
    "connect-src https://www.googleapis.com https://accounts.google.com/gsi/",
    "frame-src https://accounts.google.com/gsi/", "object-src 'none'", "base-uri 'none'",
    "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '));

  // Reject other Host values so a different origin cannot reach this loopback app by name.
  if (![ `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}` ].includes(request.headers.host)) {
    response.writeHead(403).end();
    return;
  }
  const path = request.url.split('?')[0];
  if (path === '/miniaturas.zip') {
    await sendThumbnails(request, response);
    return;
  }
  const file = files.get(path);
  if (!file || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const [name, type] = file;
    const body = await readFile(new URL(name, import.meta.url));
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(500).end('No se pudo abrir el archivo de la aplicación.');
  }
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `El puerto ${port} ya está ocupado.` : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Local: http://localhost:${port}`));
