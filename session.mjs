import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentChannel, privateCatalog } from './youtube.mjs';

const day = 86400000;
const cacheLifetime = 29 * day;
const cookieName = 'cruce_session';
const expired = 'La sesión de YouTube venció. Vuelve a conectar tu canal.';

function defaultDirectory() {
  const root = process.platform === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') :
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(root, 'cruce-de-playlists');
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function sessionCookie(id = '') {
  return `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict${id ? '' : '; Max-Age=0'}`;
}

async function readLogin(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) throw new Error('Solicitud demasiado grande.');
    chunks.push(chunk);
  }
  const { token, expiresIn } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const seconds = Number(expiresIn);
  if (typeof token !== 'string' || !/^\S{1,4096}$/.test(token) || !Number.isFinite(seconds) || seconds < 1) {
    throw new Error('La respuesta de autorización de Google no es válida.');
  }
  return { token, expiresAt: Date.now() + Math.min(seconds, 3600) * 1000 };
}

function catalogRecord(catalog) {
  return {
    ...catalog,
    videos: catalog.videos.map((video) => ({
      ...video,
      memberships: Array.from(video.memberships, ([id, dates]) => [id, [...dates]]),
    })),
  };
}

export function sessionHandler(directory = defaultDirectory()) {
  const sessions = new Map();
  const jobs = new Map();
  const clearing = new Map();

  function filename(channel) {
    const key = createHash('sha256').update(channel.id).digest('hex');
    return join(directory, `${key}.json`);
  }

  async function readCache(channel) {
    await clearing.get(channel.id);
    try {
      const snapshot = JSON.parse(await readFile(filename(channel), 'utf8'));
      if (snapshot?.channelId === channel.id && Number.isFinite(snapshot.savedAt) &&
          Array.isArray(snapshot.catalog?.playlists) && Array.isArray(snapshot.catalog?.videos) &&
          snapshot.savedAt <= Date.now() && Date.now() - snapshot.savedAt < cacheLifetime) return snapshot;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return null;
  }

  async function saveCache(channel, snapshot) {
    const file = filename(channel);
    const temp = `${file}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async function prune() {
    for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id);
    try {
      const files = await readdir(directory);
      await Promise.all(files.filter((file) => /^[a-f0-9]{64}\.(?:json|json\.[a-f0-9-]+\.tmp)$/.test(file)).map(async (file) => {
        const path = join(directory, file);
        if ((await stat(path)).mtimeMs <= Date.now() - cacheLifetime) await rm(path, { force: true });
      }));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('No se pudo revisar la caducidad de la caché local.');
    }
  }

  let pruning = prune();
  setInterval(() => { pruning = prune(); }, 60 * 60 * 1000).unref();

  function clearCache(channel) {
    if (clearing.has(channel.id)) return clearing.get(channel.id);
    const job = jobs.get(channel.id);
    const done = (async () => {
      job?.controller.abort();
      await job?.result.catch(() => {});
      await rm(filename(channel), { force: true });
    })();
    clearing.set(channel.id, done);
    done.finally(() => clearing.delete(channel.id)).catch(() => {});
    return done;
  }

  function invalidateChannel(channel) {
    for (const [id, session] of sessions) if (session.channel.id === channel.id) sessions.delete(id);
  }

  async function describe(session) {
    let snapshot = null;
    let warning = '';
    try {
      snapshot = await readCache(session.channel);
    } catch {
      warning = 'No se pudo abrir la caché local. Puedes actualizar el catálogo desde YouTube.';
    }
    return { channel: session.channel, expiresAt: session.expiresAt, snapshot, syncing: jobs.has(session.channel.id), warning };
  }

  function syncJob(session) {
    const { channel, token } = session;
    if (jobs.has(channel.id)) return jobs.get(channel.id);
    const controller = new AbortController();
    const job = { controller, listeners: new Set(), progress: 'Buscando playlists privadas…' };
    jobs.set(channel.id, job);
    job.result = (async () => {
      await pruning;
      controller.signal.throwIfAborted();
      const catalog = await privateCatalog(token, controller.signal, (message) => {
        job.progress = message;
        for (const send of job.listeners) send({ progress: message });
      });
      controller.signal.throwIfAborted();
      const snapshot = { channelId: channel.id, savedAt: Date.now(), catalog: catalogRecord(catalog) };
      let warning = '';
      try {
        await saveCache(channel, snapshot);
      } catch {
        warning = 'El catálogo está actualizado, pero no se pudo guardar una copia local.';
      }
      controller.signal.throwIfAborted();
      return { snapshot, warning };
    })().finally(() => jobs.delete(channel.id));
    return job;
  }

  return async function handle(request, response, path) {
    if (!['/api/session', '/api/catalog'].includes(path)) return false;
    const method = request.method;
    if (method !== 'GET' && request.headers.origin !== `http://${request.headers.host}`) {
      json(response, 403, { error: 'Solicitud fuera de la aplicación local.' });
      return true;
    }
    const id = request.headers.cookie?.split(/;\s*/).find((value) => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    let session = sessions.get(id);
    if (session?.expiresAt <= Date.now()) {
      sessions.delete(id);
      session = undefined;
    }

    if (path === '/api/session' && method === 'POST') {
      let login;
      try {
        login = await readLogin(request);
      } catch {
        if (!response.destroyed) json(response, 400, { error: 'La respuesta de autorización de Google no es válida.' });
        return true;
      }
      try {
        const channel = await currentChannel(login.token, AbortSignal.timeout(12000));
        await pruning;
        const replacement = { ...login, channel };
        const details = await describe(replacement);
        const key = randomUUID();
        sessions.delete(id);
        sessions.set(key, replacement);
        response.setHeader('Set-Cookie', sessionCookie(key));
        json(response, 200, details);
      } catch (error) {
        json(response, 502, { error: error instanceof TypeError ? 'No se pudo identificar el canal con YouTube.' : error.message });
      }
      return true;
    }

    if (!session) {
      if (!id && path === '/api/session' && method === 'GET') {
        json(response, 200, {});
        return true;
      }
      if (id) response.setHeader('Set-Cookie', sessionCookie());
      json(response, 401, { error: expired });
      return true;
    }
    const { channel } = session;
    if (path === '/api/session' && method === 'GET') {
      try {
        const verified = await currentChannel(session.token, AbortSignal.timeout(3500));
        if (verified.id !== channel.id) {
          const error = new Error(expired);
          error.status = 401;
          throw error;
        }
      } catch (error) {
        if (error.status === 401) {
          invalidateChannel(channel);
          await clearCache(channel).catch(() => {});
          response.setHeader('Set-Cookie', sessionCookie());
          json(response, 401, { error: expired });
          return true;
        }
      }
      const details = await describe(session);
      if (sessions.get(id) !== session || session.expiresAt <= Date.now()) json(response, 401, { error: expired });
      else json(response, 200, details);
    } else if (path === '/api/session' && method === 'DELETE') {
      invalidateChannel(channel);
      response.setHeader('Set-Cookie', sessionCookie());
      const [cache, revoke] = await Promise.allSettled([
        clearCache(channel),
        fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST', body: new URLSearchParams({ token: session.token }), signal: AbortSignal.timeout(8000),
        }),
      ]);
      const warning = cache.status === 'rejected' ? 'Se cerró la sesión, pero no se pudo borrar la caché local.' :
        revoke.status !== 'fulfilled' || !revoke.value.ok ? 'Se cerró la sesión local. Google no confirmó la revocación.' : '';
      json(response, 200, { warning });
    } else if (path === '/api/catalog' && method === 'DELETE') {
      try {
        await clearCache(channel);
        json(response, 200, {});
      } catch {
        json(response, 500, { error: 'No se pudo borrar la caché local.' });
      }
    } else if (path === '/api/catalog' && method === 'POST') {
      if (clearing.has(channel.id)) {
        json(response, 409, { error: 'Se está borrando la caché. Intenta actualizar de nuevo.' });
        return true;
      }
      const resume = new URL(request.url, 'http://localhost').searchParams.has('resume');
      const job = resume ? jobs.get(channel.id) : syncJob(session);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      if (!job) {
        const { snapshot, warning } = await describe(session);
        response.end(`${JSON.stringify({ snapshot, warning })}\n`);
        return true;
      }
      const send = (data) => { if (!response.destroyed) response.write(`${JSON.stringify(data)}\n`); };
      job.listeners.add(send);
      response.once('close', () => job.listeners.delete(send));
      send({ progress: job.progress });
      try {
        const result = await job.result;
        if (sessions.get(id) === session && session.expiresAt > Date.now()) send(result);
        else send({ status: 401, error: expired });
      } catch (error) {
        const status = error.status;
        if (status === 401) {
          invalidateChannel(channel);
          await clearCache(channel).catch(() => {});
        }
        const message = error.name === 'AbortError' ? 'Se canceló la actualización del catálogo.' :
          error instanceof TypeError ? 'No hubo conexión con YouTube. Intenta actualizar de nuevo.' : error.message;
        send({ status, error: message });
      } finally {
        response.end();
      }
    } else {
      json(response, 405, { error: 'Método no disponible.' });
    }
    return true;
  };
}
