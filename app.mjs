import { demoPlaylists, demoVideos, group, searchVideos, videoPage } from './catalog.mjs';
import { playlistCsv } from './csv.mjs';
import { readOnlyScope } from './youtube.mjs';

const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'mode', 'connect', 'settings', 'sync', 'disconnect', 'connection-status', 'clear-cache', 'catalog-date',
  'reset', 'query', 'conditions',
  'published-from', 'published-to', 'added-list', 'added-from', 'added-to', 'date-error',
  'count', 'video-grid', 'empty', 'connection-dialog', 'connection-form', 'client-id',
  'oauth-origin', 'oauth-status', 'cancel', 'forget-id',
  'export', 'export-dialog', 'export-form', 'export-filtered', 'export-playlist', 'export-all', 'export-list-field',
  'export-list', 'export-download', 'export-thumbnails', 'export-cancel',
  'pagination', 'page-range', 'previous-page', 'page-form', 'page-number', 'page-total', 'next-page',
  'results-view', 'infinite-controls', 'infinite-range', 'load-more',
].map((id) => [id, byId(id)]));

const demo = { playlists: demoPlaylists, videos: demoVideos };
const infiniteBatchSize = 24;
const viewKey = 'cruce-de-playlists.results-view';
const clientIdKey = 'cruce-de-playlists.google-client-id';
const clientIdPattern = /^[\w-]+\.apps\.googleusercontent\.com$/;
const dateFormatter = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
const syncFormatter = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' });
let data = demo;
let matchingVideos = [];
let pageNumber = 1;
let resultView = '24';
let loadedCount = 0;
const batches = new Map();
const openMemberships = new Set();
let condition = group();
let session;
let syncedAt = 0;
let changingSession = true;
let deletingCache = false;
let expiryTimer;
let activeLoad;
let identityScript;
let loadingIdentity = false;
let authorizing = false;
let savedClientId = '';
try {
  const storedId = localStorage.getItem(clientIdKey) || '';
  if (clientIdPattern.test(storedId)) savedClientId = storedId;
  const storedView = localStorage.getItem(viewKey);
  if (Array.from(ui['results-view'].options).some(({ value }) => value === storedView)) resultView = storedView;
} catch {
  // Settings are still usable for the current tab when storage is blocked.
}

const observeBatches = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const batch = batches.get(entry.target);
    if (!batch) continue;
    batch.nearby = entry.isIntersecting;
    if (batch.nearby && !entry.target.firstChild) mountBatch(entry.target, batch);
    else if (!batch.nearby) releaseBatch(entry.target);
  }
}, { rootMargin: '800px 0px' }) : null;

const observeEnd = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  if (entries.some(({ isIntersecting }) => isIntersecting) && document.activeElement !== ui['load-more']) loadMoreVideos();
}, { rootMargin: '0px 0px 360px' }) : null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label, style, callback) {
  const node = element('button', style, label);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}

function message(node, content = '', error = false) {
  node.hidden = !content;
  node.textContent = content;
  node.classList.toggle('error-text', error);
}

function playlistOptions(select, title, selected = '') {
  select.replaceChildren(new Option(title, ''), ...data.playlists.map((list) => new Option(list.title, list.id)));
  select.value = data.playlists.some((list) => list.id === selected) ? selected : '';
}

function conditionGroup(value, remove) {
  const node = element('div', remove ? 'condition-group nested' : 'condition-group');
  const header = element('div', 'group-header');
  const join = element('select');
  join.setAttribute('aria-label', remove ? 'Operador del subgrupo' : 'Operador principal');
  join.append(new Option('Todas (Y)', 'and'), new Option('Cualquiera (O)', 'or'));
  join.value = value.operator;
  join.onchange = () => {
    value.operator = join.value;
    renderResults();
  };
  header.append(join);
  if (remove) header.append(removeButton('Quitar grupo', remove));

  const children = element('div', 'group-children');
  function addControl(child) {
    const drop = () => {
      value.children.splice(value.children.indexOf(child), 1);
      control.remove();
      addCategory.focus();
      renderResults();
    };
    const control = child.type === 'group' ? conditionGroup(child, drop) : categoryControl(child, drop);
    children.append(control);
    return control;
  }

  function addChild(child) {
    value.children.push(child);
    addControl(child).querySelector('select').focus();
  }

  const actions = element('div', 'group-actions');
  const addCategory = button('+ Categoría', 'compact', () => addChild({ type: 'playlist', id: '' }));
  const addGroup = button('+ Grupo', 'compact', () => addChild(group(value.operator === 'and' ? 'or' : 'and', [{ type: 'playlist', id: '' }])));
  addCategory.disabled = addGroup.disabled = data.playlists.length === 0;
  actions.append(addCategory, addGroup);
  for (const child of value.children) addControl(child);
  node.append(header, children, actions);
  return node;
}

function removeButton(label, callback) {
  const control = button('×', 'icon-button', callback);
  control.setAttribute('aria-label', label);
  control.title = label;
  return control;
}

function categoryControl(value, remove) {
  const row = element('div', 'condition-row');
  const select = element('select');
  select.setAttribute('aria-label', 'Playlist de la condición');
  playlistOptions(select, 'Selecciona una playlist', value.id);
  select.onchange = () => {
    value.id = select.value;
    renderResults();
  };
  row.append(select, removeButton('Quitar categoría', remove));
  return row;
}

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : dateFormatter.format(date);
}

function videoCard(video, playlists) {
  const card = element('article', 'video-card');
  const heading = element('h3', 'video-title', video.title);
  const cover = element(data === demo ? 'div' : 'a', 'cover');
  if (data === demo) {
    cover.classList.add('demo-cover', `demo-${video.id}`);
    cover.setAttribute('aria-hidden', 'true');
    cover.append(element('span', 'sample-video', video.id));
  } else {
    cover.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
    cover.target = '_blank';
    cover.rel = 'noopener noreferrer';
    cover.setAttribute('aria-label', `Abrir en YouTube: ${video.title}`);
    const fallback = element('span', 'cover-fallback', 'Miniatura no disponible');
    fallback.hidden = Boolean(video.thumbnail);
    cover.append(fallback);
    if (video.thumbnail) {
      const image = element('img');
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => {
        image.remove();
        fallback.hidden = false;
      });
      image.src = video.thumbnail;
      cover.append(image);
    }
  }

  const body = element('div', 'card-body');
  const subtitle = [video.channelTitle, displayDate(video.publishedAt)].filter(Boolean).join(' · ');
  const badges = element('ul', 'badges');
  badges.setAttribute('aria-label', 'Playlists y fechas de incorporación');
  const details = element('details', 'membership-details');
  if (resultView === 'infinite') {
    details.open = openMemberships.has(video.id);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) openMemberships.add(video.id);
      else openMemberships.delete(video.id);
    });
  }
  details.append(element('summary', '', 'Fechas de incorporación'));
  const dates = element('dl');
  for (const [id, membershipDates] of video.memberships) {
    const title = playlists.get(id);
    const label = element('li', 'badge', title);
    const days = Array.from(membershipDates).sort().map(displayDate).filter(Boolean);
    dates.append(element('dt', '', title), element('dd', '', days.join(', ') || 'Sin fecha disponible'));
    badges.append(label);
  }
  details.append(dates);
  body.append(heading);
  if (subtitle) body.append(element('p', 'video-subtitle', subtitle));
  body.append(badges, details);
  const imageUrl = video.thumbnailOriginal || video.thumbnail;
  if (data !== demo && imageUrl?.startsWith('https://')) {
    const imageLink = element('a', 'thumbnail-link', 'Abrir miniatura');
    imageLink.href = imageUrl;
    imageLink.target = '_blank';
    imageLink.rel = 'noopener noreferrer';
    body.append(imageLink);
  }
  card.append(cover, body);
  return card;
}

function renderResults() {
  const published = { from: ui['published-from'].value, to: ui['published-to'].value };
  const added = { from: ui['added-from'].value, to: ui['added-to'].value, playlistId: ui['added-list'].value };
  const invalid = [published, added].some(({ from, to }) => from && to && from > to);
  message(ui['date-error'], invalid ? 'La fecha Desde debe ser anterior o igual a Hasta.' : '', true);
  matchingVideos = invalid ? [] : searchVideos(data.videos, { condition, query: ui.query.value, published, added });
  ui.count.textContent = `${matchingVideos.length} de ${data.videos.length}`;
  ui.empty.hidden = matchingVideos.length > 0 || invalid;
  ui.empty.textContent = session && !syncedAt ? 'El catálogo está vacío. Pulsa Actualizar para cargar tus playlists privadas.' :
    data.playlists.length === 0 ? 'Este canal no tiene playlists privadas.' :
    data.videos.length === 0 ? 'Las playlists privadas de este canal están vacías.' :
    'No encontramos videos con esos filtros.';
  renderResultView();
  updateExportButton();
}

function renderPage(requestedPage) {
  const page = videoPage(matchingVideos, requestedPage, Number(resultView));
  pageNumber = page.number;
  ui.pagination.hidden = page.total <= 1;
  ui['page-range'].textContent = page.items.length ? `Mostrando ${page.start + 1}–${page.end} de ${matchingVideos.length}` : '';
  ui['page-number'].max = page.total;
  ui['page-number'].value = pageNumber;
  ui['page-total'].textContent = `de ${page.total}`;
  ui['previous-page'].disabled = pageNumber === 1;
  ui['next-page'].disabled = pageNumber === page.total;

  ui['video-grid'].replaceChildren(buildCards(page.items));
}

function buildCards(videos) {
  const playlists = new Map(data.playlists.map(({ id, title }) => [id, title]));
  const cards = document.createDocumentFragment();
  for (const video of videos) cards.append(videoCard(video, playlists));
  return cards;
}

function renderResultView() {
  observeBatches?.disconnect();
  observeEnd?.disconnect();
  batches.clear();
  openMemberships.clear();
  loadedCount = 0;
  const infinite = resultView === 'infinite';
  ui['video-grid'].classList.toggle('infinite-grid', infinite);
  ui['infinite-controls'].hidden = !infinite || matchingVideos.length === 0;
  if (infinite) {
    ui.pagination.hidden = true;
    ui['video-grid'].replaceChildren();
    loadMoreVideos();
  } else {
    renderPage(1);
  }
}

function mountBatch(node, { start, end }) {
  const cards = element('div', 'video-grid');
  cards.append(buildCards(matchingVideos.slice(start, end)));
  node.append(cards);
  node.style.height = '';
}

function releaseBatch(node) {
  if (!node.firstChild || node.contains(document.activeElement)) return;
  node.style.height = `${node.getBoundingClientRect().height}px`;
  node.replaceChildren();
}

function loadMoreVideos(focusNext = false) {
  if (resultView !== 'infinite' || loadedCount >= matchingVideos.length) return;
  const start = loadedCount;
  loadedCount = Math.min(start + infiniteBatchSize, matchingVideos.length);
  const node = element('div');
  const batch = { start, end: loadedCount, nearby: true };
  batches.set(node, batch);
  ui['video-grid'].append(node);
  mountBatch(node, batch);
  observeBatches?.observe(node);
  node.addEventListener('focusout', () => {
    queueMicrotask(() => {
      if (node.isConnected && !batch.nearby) releaseBatch(node);
    });
  });

  ui['infinite-range'].textContent = `${loadedCount} de ${matchingVideos.length} videos cargados`;
  ui['load-more'].hidden = loadedCount === matchingVideos.length;
  if (ui['load-more'].hidden) observeEnd?.disconnect();
  else observeEnd?.observe(ui['infinite-controls']);

  if (focusNext) {
    const firstTitle = node.querySelector('h3');
    firstTitle.tabIndex = -1;
    firstTitle.focus();
  }
}

function updateExportButton() {
  ui.export.disabled = Boolean(activeLoad) || changingSession || deletingCache || data.playlists.length === 0;
}

function updateExportDialog() {
  const fullPlaylist = ui['export-playlist'].checked;
  ui['export-list-field'].hidden = !fullPlaylist;
  ui['export-list'].disabled = !fullPlaylist;
  ui['export-download'].disabled = fullPlaylist ? !ui['export-list'].value :
    ui['export-filtered'].checked && !matchingVideos.length;
  ui['export-thumbnails'].disabled = data === demo || !exportSelection().videos.length;
}

function exportSelection() {
  if (ui['export-filtered'].checked) return { scope: 'filtered', videos: matchingVideos };
  if (ui['export-all'].checked) return { scope: 'all', videos: data.videos };
  const playlist = data.playlists.find(({ id }) => id === ui['export-list'].value);
  return { scope: 'playlist', playlist, videos: playlist ? data.videos.filter((video) => video.memberships.has(playlist.id)) : [] };
}

function downloadThumbnailZip(scope, videos) {
  const form = element('form');
  form.method = 'post';
  form.action = './miniaturas.zip';
  form.hidden = true;
  for (const [name, value] of Object.entries({ scope, videos: JSON.stringify(videos) })) {
    const field = element('input');
    field.type = 'hidden';
    field.name = name;
    field.value = value;
    form.append(field);
  }
  document.body.append(form);
  form.submit();
  setTimeout(() => form.remove(), 1000);
}

function downloadCsv(contents, fileName) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }));
  const link = element('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderFilters() {
  ui.conditions.replaceChildren(conditionGroup(condition));
  playlistOptions(ui['added-list'], 'Cualquiera de mis playlists', ui['added-list'].value);
  renderResults();
}

function resetFilters() {
  condition = group();
  for (const id of ['query', 'published-from', 'published-to', 'added-list', 'added-from', 'added-to']) ui[id].value = '';
  renderFilters();
}

function keepExistingConditions(value, playlistIds) {
  value.children = value.children.filter((child) => child.type === 'group' || !child.id || playlistIds.has(child.id));
  for (const child of value.children) if (child.type === 'group') keepExistingConditions(child, playlistIds);
}

function renderConnection() {
  ui.mode.textContent = session?.channel.title || (changingSession ? 'Cargando sesión…' : 'Datos de ejemplo');
  ui.mode.classList.toggle('connected', Boolean(session));
  ui.connect.hidden = Boolean(session);
  ui.connect.textContent = savedClientId ? 'Conectar con Google' : 'Configurar YouTube';
  ui.connect.disabled = changingSession || authorizing || Boolean(savedClientId && loadingIdentity);
  ui.settings.hidden = Boolean(session) || !savedClientId;
  ui.settings.disabled = changingSession || authorizing;
  ui.sync.hidden = ui.disconnect.hidden = ui['clear-cache'].hidden = !session;
  ui.sync.disabled = Boolean(activeLoad) || changingSession || deletingCache;
  ui['clear-cache'].disabled = changingSession || deletingCache;
  ui.disconnect.disabled = changingSession || deletingCache;
  message(ui['catalog-date'], syncedAt ? `Última sincronización: ${syncFormatter.format(syncedAt)}` : '');
  updateExportButton();
}

async function localRequest(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(result.error || 'No se pudo comunicar con el servidor local.');
    error.status = response.status;
    throw error;
  }
  return response;
}

function clearLocalCatalog() {
  if (ui['export-dialog'].open) ui['export-dialog'].close();
  data = session ? { playlists: [], videos: [] } : demo;
  syncedAt = 0;
  resetFilters();
}

function endSession(notice, error = false) {
  session = undefined;
  clearTimeout(expiryTimer);
  activeLoad?.abort();
  activeLoad = undefined;
  clearLocalCatalog();
  renderConnection();
  message(ui['connection-status'], notice, error);
}

function showSnapshot(snapshot) {
  const { catalog, savedAt } = snapshot;
  data = {
    ...catalog,
    videos: catalog.videos.map((video) => ({
      ...video,
      memberships: new Map(video.memberships.map(([id, dates]) => [id, new Set(dates)])),
    })),
  };
  syncedAt = savedAt;
  const playlistIds = new Set(data.playlists.map(({ id }) => id));
  keepExistingConditions(condition, playlistIds);
  if (ui['added-list'].value && !playlistIds.has(ui['added-list'].value)) {
    ui['added-from'].value = ui['added-to'].value = '';
  }
  renderFilters();
}

function useSession(details) {
  if (!details.channel) return;
  session = { channel: details.channel, expiresAt: details.expiresAt };
  clearLocalCatalog();
  if (details.snapshot) showSnapshot(details.snapshot);
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => endSession('La sesión de YouTube venció. Vuelve a conectar tu canal.'), Math.max(0, session.expiresAt - Date.now()));
  message(ui['connection-status'], details.warning, Boolean(details.warning));
}

async function loadPlaylists(resume = false) {
  if (!session || activeLoad || deletingCache) return;
  const controller = new AbortController();
  activeLoad = controller;
  renderConnection();
  message(ui['connection-status'], 'Buscando playlists privadas…');
  try {
    const response = await localRequest(resume ? '/api/catalog?resume=1' : '/api/catalog', { method: 'POST', signal: controller.signal });
    let remaining = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      if (activeLoad !== controller) return;
      const lines = (remaining + chunk).split('\n');
      remaining = lines.pop();
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.status === 401) { endSession(event.error); return; }
        if (event.error) throw new Error(event.error);
        if (event.progress) message(ui['connection-status'], event.progress);
        if (event.snapshot) showSnapshot(event.snapshot);
        if ('snapshot' in event) message(ui['connection-status'], event.warning, Boolean(event.warning));
      }
    }
  } catch (error) {
    if (activeLoad !== controller) return;
    if (error.status === 401) endSession(error.message);
    else message(ui['connection-status'], error.message, true);
  } finally {
    if (activeLoad === controller) activeLoad = undefined;
    renderConnection();
  }
}

async function restoreSession() {
  try {
    const response = await localRequest('/api/session');
    const details = await response.json();
    useSession(details);
    if (details.syncing) loadPlaylists(true);
  } catch (error) {
    if (error.status !== 401) message(ui['connection-status'], error.message, true);
  } finally {
    changingSession = false;
    renderConnection();
  }
}

async function startSession(tokenResponse) {
  try {
    const response = await localRequest('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenResponse.access_token, expiresIn: tokenResponse.expires_in }),
    });
    const details = await response.json();
    useSession(details);
    if (details.syncing) loadPlaylists(true);
    else if (!details.snapshot) loadPlaylists();
  } catch (error) {
    authorizationError(error.message);
  } finally {
    authorizing = false;
    renderConnection();
  }
}

function loadIdentity() {
  if (!identityScript) {
    identityScript = new Promise((resolve, reject) => {
      const script = element('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        identityScript = undefined;
        reject(new Error('No se pudo cargar Google. Revisa tu conexión y vuelve a intentarlo.'));
      };
      document.head.append(script);
    });
  }
  return identityScript;
}

function openSettings() {
  ui['client-id'].value = savedClientId;
  ui['forget-id'].hidden = !savedClientId;
  message(ui['oauth-status']);
  ui['connection-dialog'].showModal();
}

async function prepareGoogle() {
  if (loadingIdentity || window.google?.accounts?.oauth2) return;
  loadingIdentity = true;
  renderConnection();
  try {
    await loadIdentity();
  } catch (error) {
    if (savedClientId) message(ui['connection-status'], error.message, true);
  } finally {
    loadingIdentity = false;
    renderConnection();
  }
}

function authorizationError(notice) {
  authorizing = false;
  renderConnection();
  message(ui['connection-status'], notice, true);
}

function connectWithGoogle(oauth) {
  message(ui['connection-status'], 'Esperando autorización en Google…');
  authorizing = true;
  renderConnection();
  try {
    const client = oauth.initTokenClient({
      client_id: savedClientId,
      scope: readOnlyScope,
      include_granted_scopes: false,
      callback: (response) => {
        if (response.error || !response.access_token || !oauth.hasGrantedAllScopes(response, readOnlyScope)) {
          authorizationError(`Google no concedió el permiso de lectura${response.error ? ` (${response.error})` : ''}.`);
          return;
        }
        startSession(response);
      },
      error_callback: ({ type }) => authorizationError(type === 'popup_closed' ? 'Se cerró la ventana de Google.' : 'Google no pudo abrir la autorización. Revisa el bloqueo de ventanas emergentes.'),
    });
    client.requestAccessToken({ prompt: 'select_account' });
  } catch {
    authorizationError('No se pudo iniciar la autorización. Revisa el cliente y el origen en Google Cloud.');
  }
}

ui['oauth-origin'].textContent = location.origin;
ui.settings.onclick = openSettings;
ui.connect.onclick = () => {
  if (!savedClientId) openSettings();
  else if (window.google?.accounts?.oauth2) connectWithGoogle(window.google.accounts.oauth2);
  else prepareGoogle();
};

ui['connection-form'].onsubmit = (event) => {
  event.preventDefault();
  const clientId = ui['client-id'].value.trim();
  if (!clientIdPattern.test(clientId)) {
    message(ui['oauth-status'], 'Introduce un ID de cliente web válido que termine en .apps.googleusercontent.com.', true);
    return;
  }
  savedClientId = clientId;
  let notice = 'ID guardado. Pulsa «Conectar con Google» para acceder a tu canal.';
  try {
    localStorage.setItem(clientIdKey, savedClientId);
  } catch {
    notice = 'El navegador solo permite usar este ID en la pestaña actual.';
  }
  ui['connection-dialog'].close();
  message(ui['connection-status'], notice);
  renderConnection();
  prepareGoogle();
  (ui.connect.disabled ? ui.settings : ui.connect).focus();
};

ui['forget-id'].onclick = () => {
  try {
    localStorage.removeItem(clientIdKey);
  } catch {
    message(ui['oauth-status'], 'No se pudo borrar el ID del almacenamiento del navegador.', true);
    return;
  }
  savedClientId = '';
  ui['client-id'].value = '';
  ui['connection-dialog'].close();
  renderConnection();
  message(ui['connection-status'], 'Se borró el ID guardado.');
  ui.connect.focus();
};

ui.cancel.onclick = () => ui['connection-dialog'].close();
ui.disconnect.onclick = async () => {
  if (changingSession) return;
  changingSession = true;
  renderConnection();
  try {
    const response = await localRequest('/api/session', { method: 'DELETE' });
    const { warning } = await response.json();
    endSession(warning || 'Desconectaste YouTube. Ahora ves los datos de ejemplo.', Boolean(warning));
  } catch (error) {
    if (error.status === 401) endSession(error.message);
    else message(ui['connection-status'], error.message, true);
  } finally {
    changingSession = false;
    renderConnection();
  }
};
ui['clear-cache'].onclick = async () => {
  deletingCache = true;
  activeLoad?.abort();
  activeLoad = undefined;
  renderConnection();
  try {
    await localRequest('/api/catalog', { method: 'DELETE' });
    clearLocalCatalog();
    if (session) message(ui['connection-status'], 'Caché local borrada. Sigues conectado a YouTube.');
  } catch (error) {
    if (error.status === 401) endSession(error.message);
    else message(ui['connection-status'], error.message, true);
  } finally {
    deletingCache = false;
    renderConnection();
  }
};
ui.sync.onclick = () => loadPlaylists();
ui.reset.onclick = resetFilters;
ui['results-view'].value = resultView;
ui['results-view'].onchange = () => {
  resultView = ui['results-view'].value;
  try {
    localStorage.setItem(viewKey, resultView);
  } catch {
    // The selected view is still usable for the current tab.
  }
  renderResultView();
};
ui['load-more'].onclick = () => loadMoreVideos(true);
ui['previous-page'].onclick = () => renderPage(pageNumber - 1);
ui['next-page'].onclick = () => renderPage(pageNumber + 1);
ui['page-form'].onsubmit = (event) => {
  event.preventDefault();
  const requested = ui['page-number'].valueAsNumber;
  if (Number.isInteger(requested)) renderPage(requested);
};

ui.export.onclick = () => {
  playlistOptions(ui['export-list'], 'Selecciona una playlist');
  ui['export-filtered'].disabled = matchingVideos.length === 0;
  ui[matchingVideos.length ? 'export-filtered' : 'export-all'].checked = true;
  updateExportDialog();
  ui['export-dialog'].showModal();
};

ui['export-form'].addEventListener('change', updateExportDialog);
ui['export-cancel'].onclick = () => ui['export-dialog'].close();
ui['export-dialog'].addEventListener('close', () => ui['export-list'].replaceChildren());

ui['export-form'].onsubmit = (event) => {
  event.preventDefault();
  if (ui['export-download'].disabled) return;
  const example = data === demo;
  const { scope, playlist, videos } = exportSelection();
  const contents = playlistCsv(videos, data.playlists, { playlistId: playlist?.id, example });
  const slug = playlist && playlist.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const name = playlist ? `playlist-${slug || playlist.id}` : scope === 'all' ? 'todas-las-playlists' : 'videos-filtrados';
  downloadCsv(contents, `${example ? 'ejemplo-' : ''}${name}.csv`);
  ui['export-dialog'].close();
};

ui['export-thumbnails'].onclick = () => {
  if (ui['export-thumbnails'].disabled) return;
  const { scope, videos } = exportSelection();
  downloadThumbnailZip(scope, videos.map(({ id, thumbnailOriginal, thumbnail }) => ({ id, original: thumbnailOriginal, preview: thumbnail })));
  ui['export-dialog'].close();
  message(ui['connection-status'], 'Preparando el ZIP. Puedes seguir la descarga en tu navegador.');
};

for (const id of ['query', 'published-from', 'published-to', 'added-list', 'added-from', 'added-to']) {
  ui[id].addEventListener('input', renderResults);
}

renderFilters();
renderConnection();
if (savedClientId) prepareGoogle();
restoreSession();
