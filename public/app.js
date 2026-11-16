'use strict';

const $ = selector => document.querySelector(selector);
const yards = ['Todos', 'Pátio Central', 'Pátio Superior', 'Bandeirantes', 'Cajamar'];
const outsideStatuses = new Set(['Em rota', 'Fora do pátio', 'Entregue', 'Liberado']);
let state = { user: null, vehicles: [], history: [], checklistTemplate: {} };
let activeYard = 'Todos';
let activeCategoryFilter = null;
let activeMetricFilter = '';
let weekOffset = 0;
let deferredInstallPrompt = null;
let catalogResults = [];
let catalogRequestId = 0;
let syncingOfflineQueue = false;

const offlineDB = (() => {
  let connection;
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('patio-diversos-offline', 1);
      request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache'); if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return connection;
  }
  async function read(store, key) { const db = await open(); return new Promise((resolve, reject) => { const tx = db.transaction(store, 'readonly'); const request = tx.objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  async function write(store, key, value) { const db = await open(); return new Promise((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); const request = tx.objectStore(store).put(value, key); request.onsuccess = () => resolve(value); request.onerror = () => reject(request.error); }); }
  async function remove(store, key) { const db = await open(); return new Promise((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); const request = tx.objectStore(store).delete(key); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); }
  async function all(store) { const db = await open(); return new Promise((resolve, reject) => { const tx = db.transaction(store, 'readonly'); const request = tx.objectStore(store).getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); }); }
  return { read, write, remove, all };
})();

function setConnectionStatus(mode) {
  const element = $('#connectionStatus');
  if (!element) return;
  element.textContent = mode === 'syncing' ? 'Sincronizando…' : mode === 'offline' ? 'Offline · salvo neste dispositivo' : 'Online';
  element.className = `connection-status ${mode}`;
}
async function cacheState(data) { try { await offlineDB.write('cache', 'state', data); } catch { /* cache opcional */ } }
async function cachedState() { try { return await offlineDB.read('cache', 'state'); } catch { return null; } }
async function cachedCatalog() { try { return (await offlineDB.read('cache', 'catalog')) || []; } catch { return []; } }
async function cacheCatalog(items) { try { await offlineDB.write('cache', 'catalog', items); } catch { /* cache opcional */ } }
async function queueOfflineMutation(url, options, tempId = '') { const item = { id: crypto.randomUUID(), url, options: { method: options.method, headers: options.headers, body: options.body }, tempId, createdAt: Date.now() }; await offlineDB.write('queue', item.id, item); return item; }
async function offlineMutations() { try { return (await offlineDB.all('queue')).sort((a, b) => a.createdAt - b.createdAt); } catch { return []; } }
function localAudit(vehicle, action, detail = '') { state.history.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), user: state.user?.name || 'Offline', action, vehicleId: vehicle.id, plate: vehicle.plate, detail, yard: vehicle.yard || '', position: vehicle.position || '', status: vehicle.status || '', type: vehicle.type || '', enteredAt: vehicle.enteredAt || '' }); state.history = state.history.slice(0, 2000); }
async function applyOfflineMutation(url, options) {
  const input = options.body ? JSON.parse(options.body) : {};
  const match = url.match(/^\/api\/vehicles\/([^/]+)(?:\/presence-check)?$/);
  if (options.method === 'POST' && url === '/api/vehicles') {
    const now = new Date().toISOString();
    const vehicle = { ...input, id: `offline-${crypto.randomUUID()}`, plate: String(input.plate || '').toUpperCase(), createdAt: now, updatedAt: now, enteredAt: input.enteredAt || localDateKey(), presenceEvents: [], presenceStartedAt: now, checklist: input.checklist || state.checklistTemplate, photos: input.photos || [], incidentPhotos: input.incidentPhotos || [], available: false };
    state.vehicles.push(vehicle); localAudit(vehicle, 'Veículo cadastrado offline', 'Aguardando sincronização'); await cacheState({ vehicles: state.vehicles, history: state.history, checklistTemplate: state.checklistTemplate }); return { vehicle, offline: true };
  }
  if (match) {
    const vehicle = state.vehicles.find(item => item.id === match[1]);
    if (!vehicle) throw new Error('Veículo não encontrado no cache offline.');
    if (url.endsWith('/presence-check')) { const present = input.present === true || input.present === 'true'; const event = { id: crypto.randomUUID(), date: input.date || localDateKey(), at: new Date().toISOString(), present, user: state.user?.name || 'Offline', yard: vehicle.yard || '', position: vehicle.position || '' }; vehicle.presenceEvents = [event, ...(vehicle.presenceEvents || [])].slice(0, 365); vehicle.status = present ? 'No pátio' : 'Fora do pátio'; vehicle.updatedAt = event.at; localAudit(vehicle, present ? 'Presença confirmada offline' : 'Saída confirmada offline', 'Aguardando sincronização'); }
    else if (options.method === 'PUT') { Object.assign(vehicle, input, { updatedAt: new Date().toISOString() }); localAudit(vehicle, 'Cadastro atualizado offline', 'Aguardando sincronização'); }
    await cacheState({ vehicles: state.vehicles, history: state.history, checklistTemplate: state.checklistTemplate }); return { vehicle, offline: true };
  }
  throw new Error('Esta operação não pode ser feita offline.');
}
async function syncOfflineQueue() {
  if (syncingOfflineQueue || !navigator.onLine) return;
  const queue = await offlineMutations(); if (!queue.length) return;
  syncingOfflineQueue = true; setConnectionStatus('syncing');
  try {
    for (const item of queue) {
      const response = await fetch(item.url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(item.options.headers || {}) }, ...item.options });
      if (!response.ok) throw new Error('A sincronização foi interrompida.');
      const result = await response.json().catch(() => ({}));
      if (item.tempId && result.vehicle?.id) { const local = state.vehicles.find(vehicle => vehicle.id === item.tempId); if (local) Object.assign(local, result.vehicle); }
      await offlineDB.remove('queue', item.id);
    }
    setConnectionStatus('online'); await load(); toast('Alterações offline sincronizadas.');
  } catch { setConnectionStatus('offline'); }
  finally { syncingOfflineQueue = false; }
}

async function request(url, options = {}) {
  try {
    const response = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Falha na solicitação.');
    setConnectionStatus('online');
    return data;
  } catch (error) {
    const networkFailure = !navigator.onLine || error instanceof TypeError || /Failed to fetch|Load failed|NetworkError|timed out/i.test(error.message || '');
    if (!networkFailure) throw error;
    if ((options.method || 'GET') === 'GET' && url === '/api/state') { const data = await cachedState(); if (data) { setConnectionStatus('offline'); return data; } }
    if ((options.method || 'GET') === 'GET' && url.startsWith('/api/vehicle-catalog')) { const query = normalizedCatalogValue(new URL(url, location.origin).searchParams.get('q')); const items = (await cachedCatalog()).filter(item => [item.plate, item.plateAux, item.linkedPlate, item.chassis].some(value => normalizedCatalogValue(value).includes(query))).slice(0, 30); setConnectionStatus('offline'); return { items }; }
    if (['POST', 'PUT'].includes(options.method) && !url.includes('/api/login')) { const result = await applyOfflineMutation(url, options); await queueOfflineMutation(url, options, result.vehicle?.id?.startsWith('offline-') ? result.vehicle.id : ''); setConnectionStatus('offline'); return result; }
    throw error;
  }
}

function normalizedCatalogValue(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function catalogType(value) {
  const type = String(value || '').toUpperCase();
  if (type.includes('CAVALO')) return 'Cavalo';
  if (type.includes('VAN')) return 'Van';
  if (type.includes('TRUCK')) return 'Caminhão Truck';
  if (type.includes('TOCO')) return 'Caminhão Toco';
  if (type.includes('CARRETA') || type.includes('SEMIRREBOQUE') || type.includes('RODOTREM') || type.includes('DOLLY')) return 'Carreta';
  return '';
}
function setCatalogSelect(id, value) {
  if (!value || !$(id)) return;
  const select = $(id);
  if (![...select.options].some(option => option.value === value)) select.add(new Option(value, value));
  select.value = value;
}
function applyCatalogItem(item) {
  if (!item) return;
  if (item.plate) $('#plate').value = item.plate;
  setCatalogSelect('#type', catalogType(item.type));
  setCatalogSelect('#brand', item.brand);
  if (item.model) $('#model').value = item.model;
  if (item.chassis) $('#chassis').value = item.chassis;
  if (item.renavam) $('#renavam').value = item.renavam;
  if (item.operation) setCatalogSelect('#operation', /correios/i.test(item.operation) ? 'Correios' : 'Diversos');
  if (item.color && !/^0$/.test(item.color)) $('#color').value = item.color;
  const linked = [...new Set([item.plateAux, item.linkedPlate].filter(Boolean).map(value => value.toUpperCase()))].filter(value => value !== item.plate).join(' + ');
  if (linked) $('#linkedPlates').value = linked;
  if (item.operationalDetails && !$('#notes').value) $('#notes').value = item.operationalDetails;
  toggleColorField();
  $('#catalogHint').textContent = `Dados preenchidos pela planilha · ${item.brand || ''} ${item.model || ''}`.trim();
}
async function searchVehicleCatalog(value, field) {
  const query = String(value || '').trim();
  if (query.length < 2) { catalogResults = []; $(`#${field}Suggestions`).innerHTML = ''; if ($('#catalogHint')) $('#catalogHint').textContent = ''; return; }
  const requestId = ++catalogRequestId;
  try {
    const result = await request(`/api/vehicle-catalog?q=${encodeURIComponent(query)}`);
    if (requestId !== catalogRequestId) return;
    catalogResults = result.items || [];
    const list = $(`#${field}Suggestions`);
    list.innerHTML = catalogResults.map(item => {
      const value = field === 'plate' ? item.plate : item.chassis;
      const detail = [item.brand, item.model, item.type].filter(Boolean).join(' · ');
      return `<option value="${esc(value)}" label="${esc(detail)}"></option>`;
    }).join('');
    if ($('#catalogHint')) $('#catalogHint').textContent = catalogResults.length ? `${catalogResults.length} possível(is) encontrado(s) na planilha` : 'Nenhum registro correspondente na planilha';
  } catch { /* autocomplete não deve bloquear o cadastro */ }
}
function applyExactCatalogMatch(value, field) {
  const key = normalizedCatalogValue(value);
  if (!key) return;
  const item = catalogResults.find(candidate => {
    const values = field === 'plate' ? [candidate.plate, candidate.plateAux] : [candidate.chassis];
    return values.some(candidateValue => normalizedCatalogValue(candidateValue) === key);
  });
  if (item) applyCatalogItem(item);
}

function esc(value) { const node = document.createElement('div'); node.textContent = value || ''; return node.innerHTML; }
function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); setTimeout(() => element.classList.remove('show'), 2800); }
function localDateKey(value = new Date()) { const date = value instanceof Date ? value : new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function parseDate(value) { if (!value) return null; const date = new Date(`${String(value).slice(0, 10)}T12:00:00`); return Number.isNaN(date.getTime()) ? null : date; }
function formatDate(value, options = {}) { const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('pt-BR', options); }
function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Sem registro' : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function presenceEvents(vehicle) {
  if (Array.isArray(vehicle.presenceEvents)) return [...vehicle.presenceEvents].sort((a, b) => new Date(a.at) - new Date(b.at));
  return (Array.isArray(vehicle.dailyChecks) ? vehicle.dailyChecks : []).map(check => ({ ...check, present: true })).sort((a, b) => new Date(a.at) - new Date(b.at));
}
function latestPresenceEvent(vehicle, reference = new Date()) { return presenceEvents(vehicle).filter(event => new Date(event.at) <= reference).at(-1) || null; }
function isPresentAt(vehicle, reference = new Date()) {
  const entered = parseDate(vehicle.enteredAt || vehicle.createdAt);
  const end = new Date(reference); if (end.getHours() === 12 && end.getMinutes() === 0) end.setHours(23, 59, 59, 999);
  if (entered && entered > end) return false;
  const event = latestPresenceEvent(vehicle, end);
  return event ? Boolean(event.present) : !outsideStatuses.has(vehicle.status || 'No pátio');
}
function isPresent(vehicle) { return isPresentAt(vehicle, new Date()); }
function isAttention(vehicle) {
  return vehicle.status === 'Em manutenção' || vehicle.status === 'Sinistro' || /sinistro|bloqueado/i.test(`${vehicle.status} ${vehicle.notes}`);
}
function isReadyForUse(vehicle) {
  if (!isPresent(vehicle)) return false;
  if (vehicle.ready === true || vehicle.status === 'Pronto para uso') return true;
  if (isAttention(vehicle) || vehicle.status === 'Aguardando operação') return false;
  return Boolean(vehicle.available);
}
function presenceEventOn(vehicle, date = new Date()) { const key = localDateKey(date); return presenceEvents(vehicle).filter(event => event.date === key || localDateKey(event.at) === key).at(-1) || null; }
function presenceStart(vehicle) {
  if (!isPresent(vehicle)) return null;
  if (vehicle.presenceStartedAt) return new Date(vehicle.presenceStartedAt);
  const events = presenceEvents(vehicle);
  for (let index = events.length - 1; index >= 0; index -= 1) if (events[index].present && (index === 0 || !events[index - 1].present)) return new Date(events[index].at);
  return parseDate(vehicle.enteredAt || vehicle.createdAt);
}
function presenceDurationMs(vehicle) {
  const start = vehicle.presenceStartedAt ? new Date(vehicle.presenceStartedAt) : presenceStart(vehicle) || parseDate(vehicle.enteredAt || vehicle.createdAt);
  if (!start) return 0;
  const last = latestPresenceEvent(vehicle);
  const end = isPresent(vehicle) ? new Date() : new Date(vehicle.presenceEndedAt || (!last?.present ? last?.at : Date.now()));
  return Math.max(0, end - start);
}
function durationLabel(milliseconds) { const hours = Math.floor(milliseconds / 3600000); if (hours < 24) return `${hours}h`; const days = Math.floor(hours / 24); const remainingHours = hours % 24; return `${days}d${remainingHours ? ` ${remainingHours}h` : ''}`; }
function yardDays(vehicle) { return Math.floor(presenceDurationMs(vehicle) / 86400000); }
function statusTone(status) {
  if (status === 'Pronto para uso') return 'ready';
  if (outsideStatuses.has(status)) return 'outside';
  if (status === 'Em manutenção' || status === 'Sinistro') return 'attention';
  if (status === 'Aguardando operação') return 'waiting';
  return 'present';
}
function vehicleEvents(vehicle) { return state.history.filter(event => event.vehicleId === vehicle.id || (!event.vehicleId && event.plate === vehicle.plate)); }
function lastEvent(vehicle) { return vehicleEvents(vehicle).sort((a, b) => new Date(b.at) - new Date(a.at))[0]; }
function eventsOn(date, vehicle = null) { const key = localDateKey(date); return state.history.filter(event => localDateKey(event.at) === key && (!vehicle || event.vehicleId === vehicle.id || event.plate === vehicle.plate)); }

function normalizeYardName(yard) {
  return yard === 'Jaraguá' ? 'Pátio Central' : (yard || '');
}
function matchesYard(vehicleYard, targetYard) {
  if (targetYard === 'Todos') return true;
  const norm = normalizeYardName(vehicleYard);
  return norm === targetYard;
}

function matchesCategoryFilter(vehicle, filter) {
  if (!filter) return true;
  const type = String(vehicle.type || '').trim().toLowerCase();
  const color = String(vehicle.color || '').trim().toLowerCase();
  const operation = String(vehicle.operation || 'Diversos').trim().toLowerCase();
  const fullText = [vehicle.type, vehicle.model, vehicle.operation, vehicle.color, vehicle.notes, vehicle.linkedPlates, vehicle.brand].join(' ').toLowerCase();

  if (filter.key) {
    switch (filter.key) {
      case 'toco':
        return type === 'caminhão toco' || type === 'toco';
      case 'truck':
        return type === 'caminhão truck' || type === 'truck';
      case 'vuc':
        return type === 'vuc / 3/4' || type === '3/4' || type === 'vuc';
      case 'cavalo':
        return type === 'cavalo';
      case 'carreta_prata':
        if (type === 'carreta diversos prata') return true;
        if (type === 'carreta' && operation !== 'correios') {
          if (color) return /prata|cinza|alum/i.test(color);
          return !/amarel|branc|correios/i.test(fullText);
        }
        return false;
      case 'carreta_amarela':
        return type === 'carreta diversos amarela' || (type === 'carreta' && (/amarel/i.test(color) || /amarel/i.test(fullText)));
      case 'carreta_branca':
        return type === 'carreta diversos branca' || (type === 'carreta' && (/branc/i.test(color) || /branc/i.test(fullText)));
      case 'rodotrem':
        return type === 'rodotrem' || type === 'dolly';
      case 'carreta_correios':
        return type === 'carreta correios' || (type === 'carreta' && (operation === 'correios' || /correios/i.test(fullText)));
      case 'conjunto_diversos':
        if (type === 'conjunto diversos') return true;
        return Boolean(vehicle.linkedPlates && vehicle.linkedPlates.trim()) && operation !== 'correios' && !/correios/i.test(fullText);
      case 'conjunto_correios':
        if (type === 'conjunto correios') return true;
        return Boolean(vehicle.linkedPlates && vehicle.linkedPlates.trim()) && (operation === 'correios' || /correios/i.test(fullText));
      default:
        break;
    }
  }

  if (filter.group === 'caminhoes') {
    return ['caminhão toco', 'toco', 'caminhão truck', 'truck', 'vuc / 3/4', '3/4', 'cavalo', 'van', 'veículo visitante', 'veículo diretoria'].includes(type);
  }
  if (filter.group === 'carretas') {
    return ['carreta', 'carreta diversos prata', 'carreta diversos amarela', 'carreta diversos branca', 'carreta correios', 'rodotrem', 'semirreboque', 'dolly'].includes(type);
  }
  if (filter.group === 'conjuntos') {
    return ['conjunto diversos', 'conjunto correios'].includes(type) || Boolean(vehicle.linkedPlates && vehicle.linkedPlates.trim());
  }
  return true;
}

function scopedVehicles() {
  return state.vehicles.filter(vehicle => matchesCategoryFilter(vehicle, activeCategoryFilter));
}

function switchView(viewName) {
  document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === viewName));
  $('#homeView').classList.toggle('hidden', viewName !== 'home');
  $('#dailyView').classList.toggle('hidden', viewName !== 'daily');
  $('#weeklyView').classList.toggle('hidden', viewName !== 'weekly');
  if (viewName === 'weekly') renderWeekly();
  if (viewName === 'daily') {
    renderDailyMetrics();
    renderYards();
    renderVehicles();
  }
}

function loginScreen() { $('#loginView').classList.remove('hidden'); $('#appView').classList.add('hidden'); }
async function enter(user) {
  state.user = user;
  try { await offlineDB.write('cache', 'user', user); } catch { /* cache opcional */ }
  $('#userName').textContent = user.name;
  $('#userRole').textContent = user.role;
  document.querySelectorAll('.admin-backup').forEach(element => element.classList.toggle('hidden', user.role !== 'admin'));
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  await load();
  if (navigator.onLine) { request('/api/vehicle-catalog?all=1').then(data => cacheCatalog(data.items || [])).catch(() => {}); syncOfflineQueue(); }
}
async function load() {
  const data = await request('/api/state');
  data.vehicles = (data.vehicles || []).map(v => ({ ...v, yard: normalizeYardName(v.yard) }));
  data.history = (data.history || []).map(h => ({ ...h, yard: normalizeYardName(h.yard) }));
  Object.assign(state, data);
  await cacheState({ vehicles: state.vehicles, history: state.history, checklistTemplate: state.checklistTemplate });
  renderAll();
}

function renderAll() {
  $('#todayLabel').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  renderDailyMetrics();
  renderYards();
  renderVehicles();
  renderWeekly();
}

function renderDailyMetrics() {
  const today = localDateKey();
  const baseVehicles = scopedVehicles().filter(vehicle => matchesYard(vehicle.yard, activeYard));
  const baseIds = new Set(baseVehicles.map(v => v.id));
  const basePlates = new Set(baseVehicles.map(v => v.plate));
  const present = baseVehicles.filter(isPresent);
  const ready = baseVehicles.filter(isReadyForUse);
  const checked = baseVehicles.filter(vehicle => presenceEventOn(vehicle)).length;
  const pendingChecks = baseVehicles.length - checked;
  const movements = state.history.filter(event => localDateKey(event.at) === today && (baseIds.has(event.vehicleId) || basePlates.has(event.plate)) && /Movimenta|Pátio alterado|cadastrado/i.test(event.action)).length;
  const attention = present.filter(isAttention).length;
  const cards = [
    { filter: 'present', value: present.length, label: 'No pátio agora', detail: `${baseVehicles.length - present.length} fora / em rota`, tone: 'blue', icon: 'P' },
    { filter: 'ready', value: ready.length, label: 'Pronto para uso', detail: 'Disponíveis para operação', tone: 'emerald', icon: '✓' },
    { filter: 'checked', value: checked, label: 'Conferidos hoje', detail: `${baseVehicles.length ? Math.round(checked / baseVehicles.length * 100) : 0}% dos veículos`, tone: 'green', icon: '✓' },
    { filter: 'pending', value: pendingChecks, label: 'Faltam conferir', detail: 'Sem OK ou Não OK hoje', tone: pendingChecks ? 'red' : 'green', icon: pendingChecks ? '!' : '✓' },
    { filter: 'movements', value: movements, label: 'Movimentações hoje', detail: 'Pátio, vaga ou status', tone: 'cyan', icon: 'M' },
    { filter: 'attention', value: attention, label: 'Exigem atenção', detail: 'Manutenção ou sinistro', tone: 'amber', icon: 'A' }
  ];
  $('#dailyMetrics').innerHTML = cards.map(card => `<article class="summary-card ${activeMetricFilter === card.filter ? 'active' : ''}" data-metric-filter="${card.filter}" role="button" tabindex="0" title="Filtrar por ${card.label}"><span class="summary-icon ${card.tone}">${card.icon}</span><div><b>${card.value}</b><strong>${card.label}</strong><small>${card.detail}</small></div>${activeMetricFilter === card.filter ? '<em class="summary-active-badge">FILTRO</em>' : ''}</article>`).join('');
}

function renderYards() {
  const baseVehicles = scopedVehicles();
  $('#yardTabs').innerHTML = yards.map(yard => {
    const count = baseVehicles.filter(vehicle => isPresent(vehicle) && matchesYard(vehicle.yard, yard)).length;
    return `<button class="${activeYard === yard ? 'active' : ''}" data-yard="${yard}">${yard}<span>${count}</span></button>`;
  }).join('');
}

function updateCategoryBanner() {
  const clearBtn = $('#clearCategoryFilter');
  const titleEl = $('#dailyTitle');
  const subtitleEl = $('#panelSubtitle');
  if (activeCategoryFilter) {
    clearBtn.classList.remove('hidden');
    titleEl.textContent = activeCategoryFilter.label || 'Movimentação de hoje';
    subtitleEl.textContent = `Veículos · ${activeCategoryFilter.label}${activeYard !== 'Todos' ? ` (${activeYard})` : ''}`;
  } else {
    clearBtn.classList.add('hidden');
    titleEl.textContent = 'Movimentação de hoje';
    subtitleEl.textContent = 'Veículos nos pátios';
  }
}

function filteredVehicles() {
  const query = $('#search').value.trim().toLowerCase();
  const status = $('#statusFilter').value;
  const operation = $('#operationFilter').value;
  const checklist = $('#checklistFilter').value;
  const today = localDateKey();
  return scopedVehicles().filter(vehicle => {
    const yardMatches = matchesYard(vehicle.yard, activeYard);
    const statusMatches = status === 'all' || (status === 'ready' ? isReadyForUse(vehicle) : status === 'Em rota' ? outsideStatuses.has(vehicle.status) : vehicle.status === status);
    const operationMatches = operation === 'all' || (vehicle.operation || 'Diversos') === operation;
    const checklistMatches = checklist === 'all' || (checklist === 'ok' ? vehicle.available : !vehicle.available);
    const metricMatches = !activeMetricFilter ||
      (activeMetricFilter === 'present' && isPresent(vehicle)) ||
      (activeMetricFilter === 'ready' && isReadyForUse(vehicle)) ||
      (activeMetricFilter === 'checked' && Boolean(presenceEventOn(vehicle))) ||
      (activeMetricFilter === 'pending' && !presenceEventOn(vehicle)) ||
      (activeMetricFilter === 'movements' && vehicleEvents(vehicle).some(event => localDateKey(event.at) === today && /Movimenta|Pátio alterado|cadastrado/i.test(event.action))) ||
      (activeMetricFilter === 'attention' && isAttention(vehicle));
    const text = [vehicle.plate, vehicle.fleet, vehicle.type, vehicle.position, vehicle.linkedPlates, vehicle.yard, vehicle.color, vehicle.operation, vehicle.notes].join(' ').toLowerCase();
    return yardMatches && statusMatches && operationMatches && checklistMatches && metricMatches && text.includes(query);
  }).sort((a, b) => Number(isPresent(b)) - Number(isPresent(a)) || String(a.yard).localeCompare(String(b.yard), 'pt-BR') || String(a.plate).localeCompare(String(b.plate), 'pt-BR'));
}

function plateHtml(vehicle) { return `<span class="plate ${vehicle.plateType || ''}">${esc(vehicle.plate)}</span>`; }
function renderVehicles() {
  updateCategoryBanner();
  const vehicles = filteredVehicles();
  $('#resultCount').textContent = `${vehicles.length} veículo${vehicles.length === 1 ? '' : 's'}`;
  if (!vehicles.length) {
    $('#vehicleTable').innerHTML = '<div class="empty"><b>Nenhum veículo encontrado nesta categoria/filtro</b><span>Altere os filtros ou clique em “＋ Registrar veículo” para adicionar.</span></div>';
    return;
  }
  const rows = vehicles.map(vehicle => {
    const event = lastEvent(vehicle);
    const duration = durationLabel(presenceDurationMs(vehicle));
    const todayPresence = presenceEventOn(vehicle);
    const displayStatus = vehicle.ready && vehicle.status === 'No pátio' ? 'Pronto para uso' : (vehicle.status || 'No pátio');
    return `<div class="vehicle-row ${isPresent(vehicle) ? '' : 'is-outside'}" data-id="${vehicle.id}" role="button" tabindex="0">
      <span class="vehicle-cell identity">${plateHtml(vehicle)}<span><b>${esc(vehicle.type || 'Veículo')}</b><small>${esc(vehicle.operation || 'Diversos')}${vehicle.operation === 'Diversos' && vehicle.color ? ` · ${esc(vehicle.color)}` : ''}</small></span></span>
      <span class="vehicle-cell"><small>Pátio</small><b>${esc(vehicle.yard || 'Não informado')}</b><em>${esc(vehicle.linkedPlates || 'Sem conjunto vinculado')}</em></span>
      <span class="vehicle-cell"><small>Status</small><i class="status-pill ${statusTone(displayStatus)}">${esc(displayStatus)}</i></span>
      <span class="vehicle-cell permanence"><small>${isPresent(vehicle) ? 'Permanência atual' : 'Última permanência'}</small><b>${duration}</b><em>${isPresent(vehicle) ? `Desde ${formatDateTime(presenceStart(vehicle))}` : `Saída ${formatDateTime(vehicle.presenceEndedAt || latestPresenceEvent(vehicle)?.at)}`}</em></span>
      <span class="vehicle-cell daily-check-cell"><small>Presença hoje</small><span class="presence-actions"><button type="button" class="presence-button yes ${todayPresence?.present === true ? 'active' : ''}" data-presence-id="${vehicle.id}" data-present="true">OK</button><button type="button" class="presence-button no ${todayPresence?.present === false ? 'active' : ''}" data-presence-id="${vehicle.id}" data-present="false">Não OK</button></span><em>${todayPresence ? `${todayPresence.present ? 'No pátio' : 'Fora'} · ${formatDateTime(todayPresence.at)}` : 'Aguardando conferência'}</em></span>
      <span class="vehicle-cell last-update"><small>Última movimentação</small><b>${event ? esc(event.action) : 'Sem movimentação'}</b><em>${event ? formatDateTime(event.at) : formatDateTime(vehicle.updatedAt)}</em></span>
      <span class="row-action">Editar →</span>
    </div>`;
  }).join('');
  $('#vehicleTable').innerHTML = `<div class="table-head"><span>Veículo / operação</span><span>Localização</span><span>Status</span><span>Permanência</span><span>OK diário</span><span>Última movimentação</span><span></span></div>${rows}`;
}

function startOfSelectedWeek() {
  const date = new Date();
  const day = date.getDay() || 7;
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - day + 1 - 7 + weekOffset * 7);
  return date;
}
function weekDays() { const start = startOfSelectedWeek(); return Array.from({ length: 21 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; }); }
function snapshotForDay(vehicle, date) {
  const entered = parseDate(vehicle.enteredAt || vehicle.createdAt);
  const end = new Date(date); end.setHours(23, 59, 59, 999);
  if (entered && entered > end) return null;
  const snapshot = vehicleEvents(vehicle).filter(event => new Date(event.at) <= end && (event.yard || event.status || event.position)).sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  return snapshot ? { ...vehicle, yard: normalizeYardName(snapshot.yard || vehicle.yard), status: snapshot.status || vehicle.status, position: snapshot.position || vehicle.position } : vehicle;
}

function renderWeekly() {
  const days = weekDays();
  const lastDay = days.at(-1);
  const baseVehicles = scopedVehicles();
  const baseIds = new Set(baseVehicles.map(v => v.id));
  const basePlates = new Set(baseVehicles.map(v => v.plate));
  $('#weekLabel').textContent = `${formatDate(days[0], { day: '2-digit', month: 'long' })} a ${formatDate(lastDay, { day: '2-digit', month: 'long', year: 'numeric' })}`;
  const weekEvents = state.history.filter(event => { const at = new Date(event.at); const end = new Date(lastDay); end.setHours(23, 59, 59, 999); return at >= days[0] && at <= end && (baseIds.has(event.vehicleId) || basePlates.has(event.plate)); });
  const entries = baseVehicles.filter(vehicle => { const entered = parseDate(vehicle.enteredAt); return entered && entered >= days[0] && entered <= new Date(lastDay.getTime() + 86399999); }).length;
  const movedVehicles = new Set(weekEvents.filter(event => /Movimenta|Pátio alterado/i.test(event.action)).map(event => event.vehicleId || event.plate)).size;
  const peak = Math.max(0, ...days.map(day => baseVehicles.filter(vehicle => snapshotForDay(vehicle, day) && isPresentAt(vehicle, day)).length));
  const longStay = baseVehicles.filter(vehicle => isPresent(vehicle) && yardDays(vehicle) >= 7).length;
  const cards = [
    { value: peak, label: 'Pico de ocupação', detail: 'Maior total diário', tone: 'blue', icon: 'P' },
    { value: entries, label: 'Entradas na semana', detail: 'Veículos recebidos', tone: 'green', icon: 'E' },
    { value: movedVehicles, label: 'Veículos movimentados', detail: `${weekEvents.length} registros no período`, tone: 'cyan', icon: 'M' },
    { value: longStay, label: 'Há 7 dias ou mais', detail: 'Permanência prolongada', tone: 'amber', icon: '7' }
  ];
  $('#weeklyMetrics').innerHTML = cards.map(card => `<article class="summary-card"><span class="summary-icon ${card.tone}">${card.icon}</span><div><b>${card.value}</b><strong>${card.label}</strong><small>${card.detail}</small></div></article>`).join('');
  renderOccupancy(days, baseVehicles);
  renderMovementSummary(weekEvents);
  renderWeeklyTable(days, baseVehicles);
}

function renderOccupancy(days, baseVehicles = scopedVehicles()) {
  const values = days.map(day => baseVehicles.filter(vehicle => snapshotForDay(vehicle, day) && isPresentAt(vehicle, day)).length);
  const max = Math.max(1, ...values);
  $('#occupancyChart').innerHTML = days.map((day, index) => `<div class="bar-column"><b>${values[index]}</b><div class="bar-track"><i style="height:${Math.max(8, values[index] / max * 100)}%"></i></div><span>${day.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</span><small>${day.getDate()}</small></div>`).join('');
}

function renderMovementSummary(events) {
  const movements = events.filter(event => /Movimenta|Pátio alterado|cadastrado/i.test(event.action)).sort((a, b) => new Date(b.at) - new Date(a.at));
  $('#movementSummary').innerHTML = movements.length ? movements.slice(0, 7).map(event => `<div class="movement-item"><span class="movement-dot"></span><div><b>${esc(event.plate)} · ${esc(event.action)}</b><small>${esc(event.detail || event.yard || 'Registro operacional')} · ${formatDateTime(event.at)}</small></div></div>`).join('') : '<div class="empty compact-empty"><b>Sem movimentações nesta semana</b><span>As alterações de pátio, posição e status aparecerão aqui.</span></div>';
}

function renderWeeklyTable(days, baseVehicles = scopedVehicles()) {
  const select = $('#weeklyVehicleFilter');
  const selected = select.value || 'all';
  select.innerHTML = '<option value="all">Todos</option>' + [...baseVehicles].sort((a, b) => String(a.plate).localeCompare(String(b.plate))).map(vehicle => `<option value="${vehicle.id}">${esc(vehicle.plate)}</option>`).join('');
  select.value = baseVehicles.some(vehicle => vehicle.id === selected) ? selected : 'all';
  const vehicles = baseVehicles.filter(vehicle => select.value === 'all' || vehicle.id === select.value).sort((a, b) => String(a.plate).localeCompare(String(b.plate), 'pt-BR'));
  const header = days.map(day => `<span><b>${day.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</b><small>${day.getDate()}</small></span>`).join('');
  const rows = vehicles.map(vehicle => `<div class="week-row" data-timeline-id="${vehicle.id}" role="button" tabindex="0" title="Abrir timeline de ${esc(vehicle.plate)}"><div class="week-vehicle">${plateHtml(vehicle)}<small>${esc(vehicle.type || '')} · Ver timeline</small></div>${days.map(day => {
    const snapshot = snapshotForDay(vehicle, day);
    const events = eventsOn(day, vehicle);
    if (!snapshot) return '<span class="day-cell empty-day">—</span>';
    const present = isPresentAt(vehicle, day);
    const mark = presenceEventOn(vehicle, day);
    return `<span class="day-cell ${mark ? mark.present ? 'checked-day' : 'outside-day' : present ? 'present-day' : 'outside-day'}" title="${esc(snapshot.status || '')}"><b>${mark ? mark.present ? '✓ OK' : '✕ Não OK' : present ? esc((snapshot.yard || 'Pátio').replace('Pátio ', '')) : 'Fora'}</b><small>${mark ? formatDateTime(mark.at) : present ? 'Sem conferência' : events.length ? `${events.length} mov.` : esc(snapshot.position || 'Sem alteração')}</small></span>`;
  }).join('')}</div>`).join('');
  $('#weeklyTable').innerHTML = vehicles.length ? `<div class="week-header"><span>Veículo</span>${header}</div>${rows}` : '<div class="empty"><b>Nenhum veículo para exibir</b></div>';
}

function presencePeriods(vehicle) {
  const periods = [];
  let openedAt = parseDate(vehicle.enteredAt || vehicle.createdAt);
  for (const event of presenceEvents(vehicle)) {
    const at = new Date(event.at);
    if (event.present && !openedAt) openedAt = at;
    if (!event.present && openedAt) { periods.push({ start: openedAt, end: at }); openedAt = null; }
  }
  if (openedAt) periods.push({ start: openedAt, end: isPresent(vehicle) ? new Date() : new Date(vehicle.presenceEndedAt || latestPresenceEvent(vehicle)?.at || Date.now()) });
  return periods.filter(period => period.end >= period.start);
}

function openVehicleTimeline(id) {
  const vehicle = state.vehicles.find(item => item.id === id);
  if (!vehicle) return;
  const periods = presencePeriods(vehicle);
  const totalMs = periods.reduce((sum, period) => sum + Math.max(0, period.end - period.start), 0);
  const marks = presenceEvents(vehicle);
  $('#timelineTitle').textContent = `Timeline · ${vehicle.plate}`;
  $('#timelineSubtitle').textContent = `${vehicle.type || 'Veículo'} · ${vehicle.yard || 'Pátio não informado'} · ${vehicle.position || 'Sem posição'}`;
  $('#timelineStats').innerHTML = `<article><small>Situação atual</small><b class="${isPresent(vehicle) ? 'text-present' : 'text-outside'}">${isPresent(vehicle) ? 'No pátio' : 'Fora do pátio'}</b></article><article><small>Entradas registradas</small><b>${Math.max(1, periods.length)}</b></article><article><small>Tempo total no pátio</small><b>${durationLabel(totalMs)}</b></article><article><small>Última marcação</small><b>${marks.length ? formatDateTime(marks.at(-1).at) : 'Sem marcação'}</b></article>`;
  const presenceItems = marks.map(mark => ({ at: mark.at, tone: mark.present ? 'entry' : 'exit', title: mark.present ? 'OK · Entrada/presença confirmada' : 'Não OK · Saída confirmada', detail: `${ normalizeYardName(mark.yard || vehicle.yard) || 'Pátio não informado'}${mark.position ? ` · ${mark.position}` : ''}`, user: mark.user }));
  const historyItems = vehicleEvents(vehicle).filter(event => !/Presença confirmada|Saída confirmada|Conferência diária OK/i.test(event.action)).map(event => ({ at: event.at, tone: /excluído/i.test(event.action) ? 'exit' : /cadastrado/i.test(event.action) ? 'entry' : 'movement', title: event.action, detail: event.detail || [normalizeYardName(event.yard), event.position, event.status].filter(Boolean).join(' · '), user: event.user }));
  const items = [...presenceItems, ...historyItems].sort((a, b) => new Date(b.at) - new Date(a.at));
  $('#timelineList').innerHTML = items.length ? items.map(item => `<article class="timeline-item ${item.tone}"><div class="timeline-rail"><i></i></div><div><time>${formatDateTime(item.at)}</time><h3>${esc(item.title)}</h3><p>${esc(item.detail || 'Sem detalhes adicionais')}</p><small>${esc(item.user || 'Sistema')}</small></div></article>`).join('') : '<div class="empty"><b>Sem eventos para este veículo</b><span>As próximas marcações formarão a timeline.</span></div>';
  $('#timelineDialog').showModal();
}

function openVehicle(id = '') {
  const vehicle = state.vehicles.find(item => item.id === id);
  $('#vehicleForm').reset();
  catalogResults = [];
  $('#plateSuggestions').innerHTML = '';
  $('#chassisSuggestions').innerHTML = '';
  $('#catalogHint').textContent = '';
  $('#photos').dataset.loaded = JSON.stringify(vehicle?.photos || []);
  $('#incidentPhotos').dataset.loaded = JSON.stringify(vehicle?.incidentPhotos || []);
  $('#vehicleId').value = vehicle?.id || '';
  $('#dialogTitle').textContent = vehicle ? `Atualizar ${vehicle.plate}` : 'Registrar veículo no pátio';
  $('#plate').disabled = Boolean(vehicle);
  const fields = ['plate', 'brand', 'type', 'model', 'enteredAt', 'chassis', 'renavam', 'nf', 'operation', 'color', 'stage', 'status', 'yard', 'linkedPlates', 'notes'];
  fields.forEach(key => { if (vehicle && $(`#${key}`)) $(`#${key}`).value = key === 'yard' ? normalizeYardName(vehicle[key]) : (vehicle[key] || ''); });
  $('#ready').checked = vehicle?.ready === true || vehicle?.status === 'Pronto para uso';
  if (!vehicle) {
    $('#enteredAt').value = localDateKey();
    $('#status').value = 'No pátio';
    $('#stage').value = 'Controle de pátio';
    if (activeCategoryFilter?.defaultType) $('#type').value = activeCategoryFilter.defaultType;
    if (activeCategoryFilter?.defaultOperation) $('#operation').value = activeCategoryFilter.defaultOperation;
    if (activeCategoryFilter?.defaultColor) $('#color').value = activeCategoryFilter.defaultColor;
    if (activeYard && activeYard !== 'Todos') $('#yard').value = activeYard;
  }
  renderChecklistFields(vehicle);
  renderPhotoPreview(vehicle?.photos || []);
  renderIncidentPhotoPreview(vehicle?.incidentPhotos || []);
  toggleColorField();
  $('#deleteVehicle').classList.toggle('hidden', !vehicle || state.user.role !== 'admin');
  $('#vehicleDialog').showModal();
}

function checklistId(label) { return `check-${String(label).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`; }
function renderChecklistFields(vehicle) {
  const template = state.checklistTemplate || {};
  const current = vehicle?.checklist || {};
  const html = Object.entries(template).map(([area, labels]) => `<div class="checklist-area"><b>${esc(area.replace(/^[a-z]/, value => value.toUpperCase()))}</b>${labels.map(label => { const item = (current[area] || []).find(entry => entry.label === label); return `<label>${esc(label)}<select id="${checklistId(label)}" data-checklist="${esc(label)}"><option value="pendente" ${item?.status === 'pendente' ? 'selected' : ''}>Pendente</option><option value="concluido" ${item?.status === 'concluido' ? 'selected' : ''}>Conforme</option><option value="nao_aplicado" ${item?.status === 'nao_aplicado' ? 'selected' : ''}>Não se aplica</option></select></label>`; }).join('')}</div>`).join('');
  $('#checklistFields').innerHTML = html || '<p class="muted">Nenhum item configurado.</p>';
}
function toggleColorField() {
  const field = $('#color')?.closest('label');
  if (field) field.classList.toggle('hidden', $('#operation').value !== 'Diversos');
}
function photoValue(photo) { return typeof photo === 'string' ? photo : photo?.src || ''; }
function photoLabel(photo, index) { return typeof photo === 'string' ? `Foto ${index + 1}` : photo?.label || `Foto ${index + 1}`; }
function renderPhotoCards(container, photos, key, emptyText) { $(container).innerHTML = photos.length ? photos.map((photo, index) => `<article class="photo-card"><img class="preview-image" data-image="${esc(photoValue(photo))}" src="${esc(photoValue(photo))}" alt="${esc(photoLabel(photo, index))}"><label>Descrição<input data-photo-label="${key}" data-photo-index="${index}" value="${esc(photoLabel(photo, index))}" placeholder="Ex.: Lado direito"></label><button type="button" class="photo-remove" data-photo-remove="${key}" data-photo-index="${index}">Remover</button></article>`).join('') : `<span class="muted">${emptyText}</span>`; }
function renderPhotoPreview(photos) { renderPhotoCards('#photoPreview', photos, 'photos', 'Nenhuma foto anexada.'); }
function renderIncidentPhotoPreview(photos) { renderPhotoCards('#incidentPhotoPreview', photos, 'incidentPhotos', 'Nenhuma foto de sinistro anexada.'); }

function renderHistory() {
  $('#historyList').innerHTML = state.history.length ? state.history.map(event => `<div class="history-item"><time>${formatDateTime(event.at)}</time><span class="history-marker"></span><div><b>${esc(event.action)} · ${esc(event.plate)}</b><span>${esc(event.detail || [normalizeYardName(event.yard), event.position, event.status].filter(Boolean).join(' · ') || 'Sem detalhes')}</span><small>${esc(event.user)}</small></div></div>`).join('') : '<div class="empty"><b>Nenhum evento registrado</b></div>';
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  switchView(button.dataset.view);
}));

$('#backToHome').onclick = () => switchView('home');
$('#clearCategoryFilter').onclick = () => {
  activeCategoryFilter = null;
  activeYard = 'Todos';
  activeMetricFilter = '';
  $('#search').value = '';
  $('#statusFilter').value = 'all';
  $('#operationFilter').value = 'all';
  $('#checklistFilter').value = 'all';
  renderDailyMetrics();
  renderYards();
  renderVehicles();
};

$('#homeView').addEventListener('click', event => {
  const yardBtn = event.target.closest('[data-group-yard]');
  if (yardBtn) {
    const groupSection = yardBtn.closest('[data-group]');
    const group = groupSection?.dataset.group || '';
    const groupTitles = { caminhoes: 'Caminhões', carretas: 'Carretas', conjuntos: 'Conjuntos' };
    const defaultTypes = { caminhoes: 'Caminhão Toco', carretas: 'Carreta', conjuntos: 'Conjunto Diversos' };
    activeYard = yardBtn.dataset.groupYard;
    activeMetricFilter = '';
    activeCategoryFilter = { group, label: `${groupTitles[group] || 'Frota'} · ${activeYard}`, defaultType: defaultTypes[group] };
    switchView('daily');
    return;
  }

  const card = event.target.closest('.fleet-card');
  if (card) {
    const groupSection = card.closest('[data-group]');
    const group = groupSection?.dataset.group || '';
    const label = card.dataset.category || '';
    const key = card.dataset.key || '';
    const defaultType = card.dataset.defaultType || '';
    const defaultOperation = card.dataset.defaultOperation || '';
    const defaultColor = card.dataset.defaultColor || '';
    activeYard = 'Todos';
    activeMetricFilter = '';
    activeCategoryFilter = { group, key, label, defaultType, defaultOperation, defaultColor };
    switchView('daily');
  }
});

$('#homeView').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    const card = event.target.closest('.fleet-card');
    if (card) {
      event.preventDefault();
      card.click();
    }
  }
});

function compressImage(file, maxSize = 960, quality = .58) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => { const image = new Image(); image.onload = () => { const scale = Math.min(1, maxSize / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale)); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL('image/jpeg', quality)); }; image.onerror = reject; image.src = reader.result; }; reader.readAsDataURL(file); }); }
async function loadPhotoFiles(input, preview, targetId) { const files = [...(input.files || [])].slice(0, 8); try { const incoming = await Promise.all(files.map(async (file, index) => ({ src: await compressImage(file), label: file.name.replace(/\.[^.]+$/, '') || `Foto ${index + 1}` }))); const target = $(`#${targetId}`); const existing = JSON.parse(target.dataset.loaded || '[]'); const photos = [...existing, ...incoming].slice(0, 8); preview(photos); target.dataset.loaded = JSON.stringify(photos); input.value = ''; } catch { toast('Não foi possível processar uma das imagens.'); } }
$('#photos').addEventListener('change', event => loadPhotoFiles(event.target, renderPhotoPreview, 'photos'));
$('#cameraPhotos').addEventListener('change', event => loadPhotoFiles(event.target, renderPhotoPreview, 'photos'));
$('#incidentPhotos').addEventListener('change', event => loadPhotoFiles(event.target, renderIncidentPhotoPreview, 'incidentPhotos'));
$('#cameraIncidentPhotos').addEventListener('change', event => loadPhotoFiles(event.target, renderIncidentPhotoPreview, 'incidentPhotos'));
document.addEventListener('click', event => { const image = event.target.closest('.preview-image'); if (!image) return; $('#expandedImage').src = image.dataset.image; $('#imageDialog').showModal(); });
document.addEventListener('click', event => { const button = event.target.closest('[data-photo-remove]'); if (!button) return; const input = $(`#${button.dataset.photoRemove}`); const photos = JSON.parse(input.dataset.loaded || '[]'); photos.splice(Number(button.dataset.photoIndex), 1); input.dataset.loaded = JSON.stringify(photos); (button.dataset.photoRemove === 'incidentPhotos' ? renderIncidentPhotoPreview : renderPhotoPreview)(photos); });
document.addEventListener('input', event => { const field = event.target.closest('[data-photo-label]'); if (!field) return; const input = $(`#${field.dataset.photoLabel}`); const photos = JSON.parse(input.dataset.loaded || '[]'); if (photos[field.dataset.photoIndex]) photos[field.dataset.photoIndex] = { ...photos[field.dataset.photoIndex], label: field.value }; input.dataset.loaded = JSON.stringify(photos); });
$('#closeImage').onclick = () => $('#imageDialog').close();
$('#loginForm').addEventListener('submit', async event => { event.preventDefault(); $('#loginError').textContent = ''; try { const data = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) }); await enter(data.user); } catch (error) { $('#loginError').textContent = error.message; } });
$('#showPassword').onclick = () => { $('#password').type = $('#password').type === 'password' ? 'text' : 'password'; };
$('#operation').onchange = toggleColorField;
$('#plate').addEventListener('input', event => searchVehicleCatalog(event.target.value, 'plate'));
$('#plate').addEventListener('change', event => applyExactCatalogMatch(event.target.value, 'plate'));
$('#chassis').addEventListener('input', event => searchVehicleCatalog(event.target.value, 'chassis'));
$('#chassis').addEventListener('change', event => applyExactCatalogMatch(event.target.value, 'chassis'));
$('#logout').onclick = async () => { try { await request('/api/logout', { method: 'POST' }); } catch { /* permite sair mesmo offline */ } loginScreen(); };
$('#newVehicle').onclick = () => openVehicle();
$('#dailyMetrics').onclick = event => { const card = event.target.closest('[data-metric-filter]'); if (!card) return; activeMetricFilter = activeMetricFilter === card.dataset.metricFilter ? '' : card.dataset.metricFilter; renderDailyMetrics(); renderVehicles(); };
$('#dailyMetrics').onkeydown = event => { if (event.key !== 'Enter' && event.key !== ' ') return; const card = event.target.closest('[data-metric-filter]'); if (!card) return; event.preventDefault(); activeMetricFilter = activeMetricFilter === card.dataset.metricFilter ? '' : card.dataset.metricFilter; renderDailyMetrics(); renderVehicles(); };
$('#yardTabs').onclick = event => { const button = event.target.closest('[data-yard]'); if (button) { activeYard = button.dataset.yard; renderDailyMetrics(); renderYards(); renderVehicles(); } };
$('#search').oninput = renderVehicles;
$('#statusFilter').onchange = renderVehicles;
$('#operationFilter').onchange = renderVehicles;
$('#checklistFilter').onchange = renderVehicles;
$('#vehicleTable').onclick = async event => {
  const presenceButton = event.target.closest('[data-presence-id]');
  if (presenceButton) {
    const present = presenceButton.dataset.present === 'true';
    const vehicle = state.vehicles.find(item => item.id === presenceButton.dataset.presenceId);
    if (!present && !confirm(`Confirmar que o veículo ${vehicle?.plate || ''} NÃO está no pátio? A permanência será encerrada agora.`)) return;
    presenceButton.disabled = true;
    presenceButton.textContent = '...';
    try { await request(`/api/vehicles/${presenceButton.dataset.presenceId}/presence-check`, { method: 'POST', body: JSON.stringify({ date: localDateKey(), present }) }); await load(); toast(present ? 'Presença confirmada. Nova permanência iniciada.' : 'Saída confirmada. Permanência encerrada.'); } catch (error) { presenceButton.disabled = false; presenceButton.textContent = present ? 'OK' : 'Não OK'; toast(error.message); }
    return;
  }
  const row = event.target.closest('[data-id]');
  if (row) openVehicle(row.dataset.id);
};
$('#vehicleTable').onkeydown = event => { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('[data-presence-id]')) { const row = event.target.closest('[data-id]'); if (row) { event.preventDefault(); openVehicle(row.dataset.id); } } };
$('#previousWeek').onclick = () => { weekOffset -= 1; renderWeekly(); };
$('#currentWeek').onclick = () => { weekOffset = 0; renderWeekly(); };
$('#nextWeek').onclick = () => { weekOffset += 1; renderWeekly(); };
$('#weeklyVehicleFilter').onchange = () => renderWeeklyTable(weekDays());
$('#weeklyTable').onclick = event => { const row = event.target.closest('[data-timeline-id]'); if (row) openVehicleTimeline(row.dataset.timelineId); };
$('#weeklyTable').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { const row = event.target.closest('[data-timeline-id]'); if (row) { event.preventDefault(); openVehicleTimeline(row.dataset.timelineId); } } };
(() => { const scroller = $('.weekly-table'); if (!scroller) return; let dragging = false; let startX = 0; let startScroll = 0; scroller.addEventListener('pointerdown', event => { dragging = true; startX = event.clientX; startScroll = scroller.scrollLeft; scroller.setPointerCapture(event.pointerId); }); scroller.addEventListener('pointermove', event => { if (dragging) scroller.scrollLeft = startScroll - (event.clientX - startX); }); scroller.addEventListener('pointerup', () => { dragging = false; }); scroller.addEventListener('pointercancel', () => { dragging = false; }); })();
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $('#vehicleDialog').close());
$('#vehicleForm').addEventListener('submit', async event => {
  event.preventDefault();
  const id = $('#vehicleId').value;
  const fields = ['plate', 'brand', 'type', 'model', 'enteredAt', 'chassis', 'renavam', 'nf', 'operation', 'color', 'stage', 'status', 'yard', 'linkedPlates', 'notes'];
  const payload = Object.fromEntries(fields.map(key => [key, $(`#${key}`)?.value || '']));
  payload.ready = $('#ready').checked || payload.status === 'Pronto para uso';
  payload.checklist = Object.fromEntries(Object.entries(state.checklistTemplate).map(([area, labels]) => [area, labels.map(label => ({ label, status: $(`#${checklistId(label)}`)?.value || 'pendente', note: '' }))]));
  payload.photos = JSON.parse($('#photos').dataset.loaded || '[]');
  payload.incidentPhotos = JSON.parse($('#incidentPhotos').dataset.loaded || '[]');
  try { await request(id ? `/api/vehicles/${id}` : '/api/vehicles', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); $('#vehicleDialog').close(); await load(); toast(id ? 'Movimentação registrada.' : 'Veículo registrado no pátio.'); } catch (error) { toast(error.message); }
});
$('#deleteVehicle').onclick = async () => { const id = $('#vehicleId').value; if (!id || !confirm('Excluir este veículo do controle? O histórico será preservado.')) return; try { await request(`/api/vehicles/${id}`, { method: 'DELETE' }); $('#vehicleDialog').close(); await load(); toast('Veículo excluído.'); } catch (error) { toast(error.message); } };
function generatePdfReport() {
  const filter = $('#pdfChoice').value;
  let vehicles = scopedVehicles().filter(vehicle => filter === 'all' || (filter === 'ready' ? isReadyForUse(vehicle) : vehicle.status === filter || vehicle.operation === filter));
  const labels = { all: 'Todas as carretas', ready: 'Carretas prontas', Diversos: 'Carretas Diversos', Correios: 'Carretas Correios', 'Em manutenção': 'Carretas em manutenção', Sinistro: 'Carretas com sinistro', 'Aguardando operação': 'Carretas aguardando operação' };
  const title = labels[filter] || 'Relatório de carretas';
  const cards = vehicles.map(vehicle => `<article class="vehicle-card"><span class="plate">${esc(vehicle.plate)}</span><span class="vehicle-type">${esc(vehicle.type || 'Carreta')}</span><span>${esc(vehicle.yard || 'Não informado')}</span><span>${esc(vehicle.operation || 'Diversos')}${vehicle.operation === 'Diversos' && vehicle.color ? ` · ${esc(vehicle.color)}` : ''}</span><span>${vehicle.available ? 'Checklist OK' : 'Checklist pendente'}</span><span class="state ${isReadyForUse(vehicle) ? 'ready' : 'waiting'}">${isReadyForUse(vehicle) ? 'PRONTA' : esc(vehicle.status || 'Em avaliação')}</span>${vehicle.notes ? `<small>${esc(vehicle.notes)}</small>` : ''}</article>`).join('');
  const printWindow = window.open('', '_blank');
  if (!printWindow) { toast('Permita pop-ups para gerar o PDF.'); return; }
  printWindow.document.write(`<html><head><title>${title} · Pátio Print</title><style>@page{size:A4;margin:13mm}*{box-sizing:border-box}body{margin:0;background:#fff;color:#14253d;font-family:Arial,Helvetica,sans-serif}.report{max-width:860px;margin:0 auto;min-height:100vh;padding:24px 28px}.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0a86bd;padding-bottom:14px}.logo{width:130px;height:auto}.kicker{color:#0a91a7;font-size:10px;font-weight:bold;letter-spacing:1.6px;text-transform:uppercase;margin-top:4px}.title{font-size:23px;margin:6px 0 4px;color:#102d50}.sub{font-size:10px;color:#718096}.vehicle-card{display:grid;grid-template-columns:1.2fr .8fr 1fr 1.2fr 1.2fr auto;gap:8px;align-items:center;border-bottom:1px solid #dce5ee;padding:8px 4px;break-inside:avoid;font-size:10px;color:#30455e}.vehicle-card small{grid-column:1/-1;background:#fffaf0;border-left:3px solid #f0a32b;padding:4px 8px}.plate{font-size:13px;font-weight:800;color:#102d50;letter-spacing:.5px}.vehicle-type{font-size:9px;color:#718096}.state{border-radius:20px;padding:5px 7px;font-size:8px;font-weight:bold;letter-spacing:.3px;text-align:center}.state.ready{background:#dff6e9;color:#13784d}.state.waiting{background:#fff1d8;color:#98600b}.footer{border-top:1px solid #dce5ee;margin-top:18px;padding-top:10px;display:flex;justify-content:space-between;color:#8290a0;font-size:10px}.signature{font-weight:bold;color:#43617b}@media print{body{background:#fff}.report{padding:0;max-width:none}.print-action{display:none}}@media(max-width:600px){.report{padding:18px}.vehicle-card{grid-template-columns:1fr 1fr}}</style></head><body><main class="report"><header class="top"><div><div class="kicker">Controle operacional</div><h1>${title}</h1><div class="sub">Base Print · ${new Date().toLocaleDateString('pt-BR')} · ${vehicles.length} registro(s)</div></div><img class="logo" src="/images/logo-print.png" alt="Print"></header><section>${vehicles.length ? cards : '<article class="vehicle-card">Nenhum registro encontrado.</article>'}</section><footer class="footer"><span>Gerado pelo Controle de Pátios · ${vehicles.length} registro(s)</span><span class="signature">Sistema desenvolvido por Ramalho</span></footer><button class="print-action" onclick="window.print()" style="margin-top:16px;padding:10px 14px;border:0;border-radius:8px;background:#087db4;color:#fff;font-weight:bold">Imprimir / Salvar como PDF</button></main></body></html>`);
  printWindow.document.close(); printWindow.focus();
}
$('#pdfButton').onclick = () => $('#pdfDialog').showModal();
$('#confirmPdf').onclick = () => { $('#pdfDialog').close(); generatePdfReport(); };
$('#historyButton').onclick = () => { renderHistory(); $('#historyDialog').showModal(); };
$('[data-close-history]').onclick = () => $('#historyDialog').close();
$('[data-close-timeline]').onclick = () => $('#timelineDialog').close();
$('#backupButton').onclick = async () => { try { const data = await request('/api/backup'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `backup-patio-diversos-${localDateKey()}.json`; link.click(); URL.revokeObjectURL(link.href); toast('Backup gerado com sucesso.'); } catch (error) { toast(error.message); } };
$('#restoreButton').onclick = () => $('#restoreFile').click();
$('#restoreFile').onchange = async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file || !confirm(`Restaurar o backup “${file.name}”? Os dados atuais serão substituídos.`)) return; try { const content = JSON.parse(await file.text()); const result = await request('/api/backup/restore', { method: 'POST', body: JSON.stringify(content) }); await load(); toast(`Backup restaurado: ${result.vehicles} veículo(s).`); } catch (error) { toast(error.message); } };

function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function updateInstallButton() { $('#installApp').classList.toggle('hidden', isStandalone()); }
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstallPrompt = event; updateInstallButton(); });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; $('#installApp').classList.add('hidden'); toast('App instalado com sucesso.'); });
$('#installApp').onclick = async () => { if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; updateInstallButton(); return; } toast('No menu do navegador, escolha “Instalar aplicativo”.'); };
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
updateInstallButton();
window.addEventListener('online', () => { setConnectionStatus('online'); syncOfflineQueue(); load().catch(() => {}); });
window.addEventListener('offline', () => setConnectionStatus('offline'));
request('/api/me').then(data => enter(data.user)).catch(async () => { const user = await offlineDB.read('cache', 'user').catch(() => null); const cached = await cachedState(); if (user && cached) { setConnectionStatus('offline'); await enter(user); } else loginScreen(); });
