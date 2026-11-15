'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3010);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
let DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
let DATA_FILE = path.join(DATA_DIR, 'fleet.json');
const sessions = new Map();
const CATALOG_FILE = path.join(ROOT, 'data', 'vehicle-catalog.json');
let vehicleCatalog = [];
const databaseConfigured = Boolean(process.env.DB_NAME && process.env.DB_USER && process.env.DB_PASSWORD);
let dbPool = null;
let dbReady = null;

const USERS = {
  admin: { password: process.env.PATIO_ADMIN_PASSWORD || '1234', name: 'Administrador', role: 'admin' },
  coordenador: { password: process.env.PATIO_COORD_PASSWORD || '4321', name: 'Coordenador', role: 'coordenador' }
};

const CHECKLIST = {
  manutencao: ['Sistema elétrico e iluminação', 'Freios e sistema pneumático', 'Suspensão e estrutura', 'Engate e quinta roda', 'Trava do rastreador', 'Reparo de baú'],
  borracharia: ['Pneus e calibragem', 'Estepe', 'Rodas e porcas'],
  documentacao: ['CRLV vigente', 'Licenciamento e multas', 'Documentos operacionais']
};

function initialData() {
  return { vehicles: [], history: [], updatedAt: new Date().toISOString() };
}
function readLocalVehicleCatalog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}
function readLocalData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
    DATA_DIR = path.join(ROOT, 'data');
    DATA_FILE = path.join(DATA_DIR, 'fleet.json');
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(initialData(), null, 2));
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return initialData(); }
}
function saveLocalData(data) {
  data.updatedAt = new Date().toISOString();
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, DATA_FILE);
}
async function database() {
  if (!databaseConfigured) return null;
  if (!dbReady) {
    dbReady = (async () => {
      const mysql = require('mysql2/promise');
      dbPool = mysql.createPool({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4' });
      await dbPool.query('CREATE TABLE IF NOT EXISTS patio_app_state (id TINYINT UNSIGNED PRIMARY KEY, data JSON NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)');
      await dbPool.query('CREATE TABLE IF NOT EXISTS vehicle_catalog (id VARCHAR(100) PRIMARY KEY, plate VARCHAR(20) NOT NULL, plate_aux VARCHAR(20) NULL, linked_plate VARCHAR(20) NULL, chassis VARCHAR(100) NULL, data JSON NOT NULL, INDEX idx_vehicle_catalog_plate (plate), INDEX idx_vehicle_catalog_chassis (chassis))');
      const [stateRows] = await dbPool.query('SELECT id FROM patio_app_state WHERE id = 1 LIMIT 1');
      if (!stateRows.length) await dbPool.query('INSERT INTO patio_app_state (id, data) VALUES (1, ?)', [JSON.stringify(readLocalData())]);
      const [catalogRows] = await dbPool.query('SELECT COUNT(*) AS total FROM vehicle_catalog');
      if (!Number(catalogRows[0]?.total)) {
        const localCatalog = readLocalVehicleCatalog();
        for (const item of localCatalog) await dbPool.query('INSERT IGNORE INTO vehicle_catalog (id, plate, plate_aux, linked_plate, chassis, data) VALUES (?, ?, ?, ?, ?, ?)', [item.id || crypto.randomUUID(), item.plate || '', item.plateAux || null, item.linkedPlate || null, item.chassis || null, JSON.stringify(item)]);
      }
      return dbPool;
    })();
  }
  return dbReady;
}
async function readVehicleCatalog() {
  const db = await database();
  if (!db) return readLocalVehicleCatalog();
  const [rows] = await db.query('SELECT data FROM vehicle_catalog');
  return rows.map(row => typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
}
async function readData() {
  const db = await database();
  if (!db) return readLocalData();
  const [rows] = await db.query('SELECT data FROM patio_app_state WHERE id = 1 LIMIT 1');
  return rows.length ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data) : initialData();
}
async function saveData(data) {
  data.updatedAt = new Date().toISOString();
  const db = await database();
  if (db) { await db.query('INSERT INTO patio_app_state (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)', [JSON.stringify(data)]); return; }
  saveLocalData(data);
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 50e6) reject(new Error('O arquivo excede o limite de 50 MB.')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON inválido.')); } });
  });
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => { const i = v.indexOf('='); return [v.slice(0, i).trim(), decodeURIComponent(v.slice(i + 1))]; }));
}
function currentUser(req) {
  const token = cookies(req).sid;
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return null; }
  return session.user;
}
function clean(value, max = 100) { return String(value || '').trim().slice(0, max); }
function searchKey(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function todayInSaoPaulo() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function plate(value) { return clean(value, 8).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function plateType(value) { return /^[A-Z]{3}\d{4}$/.test(value) ? 'vermelha' : 'mercosul'; }
function makeChecklist(existing = {}) {
  return Object.fromEntries(Object.entries(CHECKLIST).map(([area, labels]) => [area, labels.map(label => {
    const found = (existing[area] || []).find(x => x.label === label);
    return found || { label, status: 'pendente', note: '' };
  })]));
}
function available(vehicle) {
  const items = Object.values(vehicle.checklist || {}).flat();
  return items.length > 0 && items.every(x => ['concluido', 'nao_aplicado'].includes(x.status));
}
function vehiclePresenceEvents(vehicle) {
  if (Array.isArray(vehicle.presenceEvents)) return vehicle.presenceEvents;
  return (Array.isArray(vehicle.dailyChecks) ? vehicle.dailyChecks : []).map(check => ({ ...check, present: true }));
}
function normalizeYard(yard) {
  const cleaned = clean(yard);
  return cleaned === 'Jaraguá' ? 'Pátio Central' : cleaned;
}
function decorate(vehicle) {
  const decorated = { ...vehicle, yard: normalizeYard(vehicle.yard), brand: vehicle.brand || 'Facchini', enteredAt: vehicle.enteredAt || vehicle.createdAt?.slice(0, 10), plateType: plateType(vehicle.plate), presenceEvents: vehiclePresenceEvents(vehicle), checklist: makeChecklist(vehicle.checklist) };
  return { ...decorated, available: available(decorated) };
}
function audit(data, user, action, vehicle, detail = '') {
  data.history.unshift({
    id: crypto.randomUUID(), at: new Date().toISOString(), user: user.name, action,
    vehicleId: vehicle.id, plate: vehicle.plate, detail,
    yard: vehicle.yard || '', position: vehicle.position || '', status: vehicle.status || '',
    type: vehicle.type || '', enteredAt: vehicle.enteredAt || ''
  });
  data.history = data.history.slice(0, 2000);
}
function serve(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = path.normalize(path.join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC)) return json(res, 403, { error: 'Acesso negado.' });
  fs.readFile(target, (err, data) => {
    if (err) return json(res, 404, { error: 'Arquivo não encontrado.' });
    const ext = path.extname(target);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/manifest+json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); res.end(data);
  });
}

async function api(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const input = await body(req); const username = clean(input.username, 30).toLowerCase(); const found = USERS[username];
    const suppliedHash = crypto.createHash('sha256').update(String(input.password || '')).digest();
    const expectedHash = crypto.createHash('sha256').update(found?.password || crypto.randomBytes(16)).digest();
    if (!found || !crypto.timingSafeEqual(expectedHash, suppliedHash)) return json(res, 401, { error: 'Usuário ou senha inválidos.' });
    const token = crypto.randomBytes(32).toString('hex'); const user = { username, name: found.name, role: found.role };
    sessions.set(token, { user, expires: Date.now() + 12 * 60 * 60 * 1000 });
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`); return json(res, 200, { user });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') { const token = cookies(req).sid; if (token) sessions.delete(token); res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
  const user = currentUser(req); if (!user) return json(res, 401, { error: 'Sessão expirada.' });
  if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user });
  const data = await readData();
  if (req.method === 'GET' && url.pathname === '/api/vehicle-catalog') {
    const query = searchKey(url.searchParams.get('q'));
    if (query.length < 1) return json(res, 200, { items: [] });
    const matches = vehicleCatalog.filter(item => [item.plate, item.plateAux, item.linkedPlate, item.chassis].some(value => searchKey(value).includes(query)));
    matches.sort((a, b) => {
      const aKey = [a.plate, a.plateAux, a.linkedPlate, a.chassis].map(searchKey);
      const bKey = [b.plate, b.plateAux, b.linkedPlate, b.chassis].map(searchKey);
      const aPrefix = aKey.some(value => value.startsWith(query));
      const bPrefix = bKey.some(value => value.startsWith(query));
      return Number(bPrefix) - Number(aPrefix) || String(a.plate).localeCompare(String(b.plate));
    });
    return json(res, 200, { items: matches.slice(0, 30) });
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { vehicles: data.vehicles.map(decorate), history: data.history, checklistTemplate: CHECKLIST });
  if (req.method === 'GET' && url.pathname === '/api/backup') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Apenas o administrador pode fazer backup.' });
    return json(res, 200, { version: 1, system: 'Controle de Pátio Diversos Print', exportedAt: new Date().toISOString(), data });
  }
  if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Apenas o administrador pode restaurar backup.' });
    const input = await body(req); const restored = input?.data || input;
    if (!restored || !Array.isArray(restored.vehicles) || !Array.isArray(restored.history)) return json(res, 400, { error: 'Arquivo de backup inválido.' });
    const safeData = { vehicles: restored.vehicles.map(v => ({ ...v, checklist: makeChecklist(v.checklist) })), history: restored.history.slice(0, 2000), updatedAt: new Date().toISOString() };
    await saveData(safeData); return json(res, 200, { ok: true, vehicles: safeData.vehicles.length });
  }
  if (req.method === 'POST' && url.pathname === '/api/vehicles') {
    const input = await body(req); const p = plate(input.plate);
    if (!p) return json(res, 400, { error: 'Informe a placa.' });
    if (data.vehicles.some(v => v.plate === p)) return json(res, 409, { error: 'Esta placa já está cadastrada.' });
    const createdAt = new Date().toISOString();
    const operation = ['Correios', 'Diversos'].includes(clean(input.operation)) ? clean(input.operation) : 'Diversos';
    const vehicle = { id: crypto.randomUUID(), plate: p, plateType: plateType(p), type: clean(input.type), brand: clean(input.brand), model: clean(input.model), fleet: clean(input.fleet), chassis: clean(input.chassis), renavam: clean(input.renavam), nf: clean(input.nf), operation, color: operation === 'Diversos' ? clean(input.color) : '', ready: input.ready === true || input.ready === 'true', stage: clean(input.stage) || 'Processos', status: clean(input.status) || 'Aguardando linha', yard: normalizeYard(input.yard), position: clean(input.position), linkedPlates: clean(input.linkedPlates, 100).toUpperCase(), notes: clean(input.notes, 500), enteredAt: input.enteredAt || todayInSaoPaulo(), presenceEvents: [], presenceStartedAt: createdAt, checklist: makeChecklist(input.checklist), photos: Array.isArray(input.photos) ? input.photos.slice(0, 8) : [], incidentPhotos: Array.isArray(input.incidentPhotos) ? input.incidentPhotos.slice(0, 8) : [], createdAt, updatedAt: createdAt };
    data.vehicles.push(vehicle); audit(data, user, 'Veículo cadastrado', vehicle, vehicle.yard); await saveData(data); return json(res, 201, { vehicle: decorate(vehicle) });
  }
  const presenceCheckMatch = url.pathname.match(/^\/api\/vehicles\/([^/]+)\/presence-check$/);
  if (presenceCheckMatch && req.method === 'POST') {
    const vehicle = data.vehicles.find(v => v.id === presenceCheckMatch[1]);
    if (!vehicle) return json(res, 404, { error: 'Veículo não encontrado.' });
    const input = await body(req);
    const date = clean(input.date, 10) || todayInSaoPaulo();
    const present = input.present === true || input.present === 'true';
    vehicle.presenceEvents = vehiclePresenceEvents(vehicle).sort((a, b) => new Date(b.at) - new Date(a.at));
    const last = vehicle.presenceEvents[0];
    if (last?.date === date && Boolean(last.present) === present) return json(res, 200, { ok: true, alreadyChecked: true, event: last, vehicle: decorate(vehicle) });
    const event = { id: crypto.randomUUID(), date, at: new Date().toISOString(), present, user: user.name, yard: vehicle.yard || '', position: vehicle.position || '' };
    vehicle.presenceEvents.unshift(event);
    vehicle.presenceEvents = vehicle.presenceEvents.slice(0, 365);
    if (present) {
      if (!last?.present) vehicle.presenceStartedAt = event.at;
      vehicle.presenceEndedAt = null;
      if (['Em rota', 'Fora do pátio', 'Entregue', 'Liberado'].includes(vehicle.status)) vehicle.status = 'No pátio';
    } else {
      vehicle.presenceEndedAt = event.at;
      vehicle.status = 'Fora do pátio';
    }
    vehicle.updatedAt = event.at;
    audit(data, user, present ? 'Presença confirmada no pátio' : 'Saída confirmada do pátio', vehicle, present ? 'OK · veículo localizado no pátio' : 'Não OK · veículo não localizado no pátio');
    await saveData(data);
    return json(res, 200, { ok: true, alreadyChecked: false, event, vehicle: decorate(vehicle) });
  }
  const match = url.pathname.match(/^\/api\/vehicles\/([^/]+)$/); const vehicle = match && data.vehicles.find(v => v.id === match[1]);
  if (match && !vehicle) return json(res, 404, { error: 'Veículo não encontrado.' });
  if (vehicle && req.method === 'PUT') {
    const input = await body(req); const before = { yard: vehicle.yard || '', position: vehicle.position || '', status: vehicle.status || '' };
    ['type','brand','model','fleet','chassis','renavam','nf','stage','status','yard','position','linkedPlates','notes'].forEach(k => { if (k in input) vehicle[k] = k === 'yard' ? normalizeYard(input[k]) : clean(input[k], k === 'notes' ? 500 : 100); });
    if ('operation' in input) vehicle.operation = ['Correios', 'Diversos'].includes(clean(input.operation)) ? clean(input.operation) : 'Diversos';
    if ('color' in input) vehicle.color = vehicle.operation === 'Diversos' ? clean(input.color) : '';
    if ('ready' in input) vehicle.ready = input.ready === true || input.ready === 'true';
    if (Array.isArray(input.photos)) vehicle.photos = input.photos.slice(0, 8);
    if (Array.isArray(input.incidentPhotos)) vehicle.incidentPhotos = input.incidentPhotos.slice(0, 8);
    if (input.enteredAt) vehicle.enteredAt = clean(input.enteredAt, 10);
    vehicle.plateType = plateType(vehicle.plate);
    if (input.checklist) vehicle.checklist = makeChecklist(input.checklist);
    vehicle.updatedAt = new Date().toISOString();
    const changes = [];
    if (before.yard !== vehicle.yard) changes.push(`Pátio: ${before.yard || 'Não informado'} → ${vehicle.yard || 'Não informado'}`);
    if (before.position !== vehicle.position) changes.push(`Posição: ${before.position || 'Não informada'} → ${vehicle.position || 'Não informada'}`);
    if (before.status !== vehicle.status) changes.push(`Status: ${before.status || 'Não informado'} → ${vehicle.status || 'Não informado'}`);
    audit(data, user, changes.length ? 'Movimentação registrada' : 'Cadastro atualizado', vehicle, changes.join(' · '));
    await saveData(data); return json(res, 200, { vehicle: decorate(vehicle) });
  }
  if (vehicle && req.method === 'DELETE') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Apenas o administrador pode excluir.' });
    data.vehicles = data.vehicles.filter(v => v.id !== vehicle.id); audit(data, user, 'Veículo excluído', vehicle); await saveData(data); return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Rota não encontrada.' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) api(req, res, url).catch(err => json(res, 400, { error: err.message || 'Falha na solicitação.' })); else serve(req, res);
});
async function start() {
  vehicleCatalog = await readVehicleCatalog();
  server.listen(PORT, () => console.log(`Controle de Pátio Diversos Print em http://localhost:${PORT} · armazenamento: ${databaseConfigured ? 'MySQL' : 'arquivo local'}`));
}
start().catch(error => { console.error('Falha ao inicializar o armazenamento:', error.message); process.exit(1); });
