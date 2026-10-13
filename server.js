const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { pool, migrate } = require('./db');

const PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const PORT = process.env.PORT || 3000;
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();
// E-mails com acesso master (veem e filtram os sites de todos os gestores). Separados por vírgula.
const MASTER_EMAILS = (process.env.MASTER_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const COMPANIES = ['TN Digitech', 'Moodlr'];
const ACTIONS = ['escalei', 'reduzi', 'mantive'];
const COOKIE = 'mbz_pulse';
const MAX_AGE = 30 * 24 * 60 * 60; // 30 dias

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[PULSE] JWT_SECRET não definido — usando segredo temporário (logins caem a cada restart).');
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' })); // a importação manda a prévia inteira de volta
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* ---------- helpers ---------- */

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function str(v, max, label, { required = true } = {}) {
  const s = (v === undefined || v === null ? '' : String(v)).trim();
  if (!s && required) throw bad(`${label} é obrigatório.`);
  if (s.length > max) throw bad(`${label} passou de ${max} caracteres.`);
  return s;
}

// Aceita "0,35" e "0.35".
function money(v, label) {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) throw bad(`${label} inválido.`);
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n >= 1e9) throw bad(`${label} inválido.`);
  return Math.round(n * 1e4) / 1e4;
}

function country(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) throw bad('País deve ser o código de 2 letras (ex.: BR, US, PT).');
  return s;
}

function intId(v, label = 'ID') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${label} inválido.`);
  return n;
}

function companyOf(v, { required = true } = {}) {
  const s = String(v ?? '').trim();
  if (!s && !required) return '';
  if (!COMPANIES.includes(s)) throw bad('Empresa inválida. Escolha ' + COMPANIES.join(' ou ') + '.');
  return s;
}

// Idioma da campanha (ex.: en, es, pt-br). Opcional: distingue o mesmo ID rodando em dois idiomas no mesmo país.
function langOf(v) {
  const s = String(v ?? '').trim().toLowerCase().replace('_', '-');
  if (!s) return '';
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(s)) throw bad('Idioma inválido (use en, es, pt, pt-br...).');
  return s;
}

function dateOf(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw bad(`${label} inválida.`);
  return d;
}

function actionOf(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  if (!ACTIONS.includes(s)) throw bad('Ação inválida.');
  return s;
}

const CURRENCIES = ['USD', 'BRL', 'EUR'];

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: MAX_AGE });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}${PROD ? '; Secure' : ''}`);
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, company: u.company, is_master: u.is_master });

// Carrega o usuário a cada chamada: req.uid, req.user e req.owner (null = master, vê tudo).
async function auth(req, res, next) {
  try {
    const token = readCookie(req, COOKIE);
    if (!token) throw new Error('no token');
    const uid = jwt.verify(token, JWT_SECRET).uid;
    const { rows } = await pool.query('SELECT id, name, email, company, is_master FROM users WHERE id=$1', [uid]);
    if (!rows[0]) throw new Error('no user');
    req.uid = uid;
    req.user = rows[0];
    req.owner = rows[0].is_master ? null : uid;
    next();
  } catch {
    res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
}

function masterOnly(req, res, next) {
  if (!req.user.is_master) return res.status(403).json({ error: 'Só o usuário master pode fazer isso.' });
  next();
}

// Limite simples em memória para as rotas de login/cadastro.
const hits = new Map();
function limiter(req, res, next) {
  const now = Date.now();
  const h = hits.get(req.ip);
  if (!h || h.reset < now) { hits.set(req.ip, { n: 1, reset: now + 15 * 60e3 }); return next(); }
  if (++h.n > 30) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  next();
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60e3).unref();

// Site do próprio usuário — ou qualquer site, se for master.
async function ownSite(req, siteId) {
  const { rows } = await pool.query(
    'SELECT id, name, currency, user_id FROM sites WHERE id=$1 AND ($2::int IS NULL OR user_id=$2)', [siteId, req.owner]);
  if (!rows[0]) throw new HttpError(404, 'Site não encontrado.');
  return rows[0];
}

/* ---------- auth ---------- */

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.get('/api/config', (req, res) => res.json({ invite_required: !!INVITE_CODE, companies: COMPANIES, actions: ACTIONS }));

app.post('/api/auth/register', limiter, wrap(async (req, res) => {
  const name = str(req.body.name, 60, 'Nome');
  const email = str(req.body.email, 120, 'E-mail').toLowerCase();
  const password = String(req.body.password || '');
  const company = companyOf(req.body.company);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('E-mail inválido.');
  if (password.length < 8 || password.length > 100) throw bad('Senha precisa ter entre 8 e 100 caracteres.');
  if (INVITE_CODE) {
    const given = Buffer.from(String(req.body.invite || '').trim());
    const want = Buffer.from(INVITE_CODE);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw new HttpError(403, 'Código de convite inválido.');
    }
  }
  const hash = await bcrypt.hash(password, 11);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, company, is_master) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, email, company, is_master`,
      [name, email, hash, company, MASTER_EMAILS.includes(email)]);
    setSession(res, rows[0]);
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Já existe uma conta com esse e-mail.');
    throw e;
  }
}));

app.post('/api/auth/login', limiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT id, name, email, company, is_master, password_hash FROM users WHERE email=$1', [email]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!u || !ok) throw new HttpError(401, 'E-mail ou senha incorretos.');
  setSession(res, u);
  res.json({ user: publicUser(u) });
}));

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${PROD ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// Quem criou a conta antes de existir o campo "empresa" escolhe aqui.
app.patch('/api/me', auth, wrap(async (req, res) => {
  const company = companyOf(req.body.company);
  const { rows } = await pool.query('UPDATE users SET company=$1 WHERE id=$2 RETURNING id, name, email, company, is_master', [company, req.uid]);
  res.json({ user: publicUser(rows[0]) });
}));

// Lista de gestores (para os filtros do master).
app.get('/api/users', auth, masterOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.company, u.is_master, COUNT(s.id)::int AS sites
    FROM users u LEFT JOIN sites s ON s.user_id = u.id
    GROUP BY u.id ORDER BY lower(u.name)`);
  res.json({ users: rows });
}));

/* ---------- sites ---------- */

app.get('/api/sites', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.url, s.currency, s.created_at, s.user_id AS owner_id,
           o.name AS owner_name, o.company,
           COUNT(r.id)::int AS records,
           COUNT(DISTINCT (r.post_id, r.country, r.lang))::int AS campaigns,
           MAX(r.created_at) AS last_at
    FROM sites s JOIN users o ON o.id = s.user_id LEFT JOIN records r ON r.site_id = s.id
    WHERE ($1::int IS NULL OR s.user_id = $1)
    GROUP BY s.id, o.name, o.company ORDER BY lower(o.name), lower(s.name)`, [req.owner]);
  res.json({ sites: rows });
}));

function siteBody(body) {
  const currency = String(body.currency || 'USD').toUpperCase();
  if (!CURRENCIES.includes(currency)) throw bad('Moeda inválida.');
  return {
    name: str(body.name, 80, 'Nome do site'),
    url: str(body.url, 200, 'URL', { required: false }),
    currency,
  };
}
const dupSite = (e) => (e.code === '23505' ? new HttpError(409, 'Já existe um site com esse nome para este gestor.') : e);

app.post('/api/sites', auth, wrap(async (req, res) => {
  const s = siteBody(req.body);
  try {
    const { rows } = await pool.query(
      'INSERT INTO sites (user_id, name, url, currency) VALUES ($1,$2,$3,$4) RETURNING id, name, url, currency',
      [req.uid, s.name, s.url, s.currency]);
    res.status(201).json({ site: rows[0] });
  } catch (e) { throw dupSite(e); }
}));

app.patch('/api/sites/:id', auth, wrap(async (req, res) => {
  const id = intId(req.params.id);
  const s = siteBody(req.body);
  try {
    const { rows } = await pool.query(
      `UPDATE sites SET name=$1, url=$2, currency=$3 WHERE id=$4 AND ($5::int IS NULL OR user_id=$5)
       RETURNING id, name, url, currency`,
      [s.name, s.url, s.currency, id, req.owner]);
    if (!rows[0]) throw new HttpError(404, 'Site não encontrado.');
    res.json({ site: rows[0] });
  } catch (e) { throw dupSite(e); }
}));

app.delete('/api/sites/:id', auth, wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM sites WHERE id=$1 AND ($2::int IS NULL OR user_id=$2)', [intId(req.params.id), req.owner]);
  if (!rowCount) throw new HttpError(404, 'Site não encontrado.');
  res.json({ ok: true });
}));

/* ---------- registros ---------- */

// Cada linha já vem com o registro anterior da mesma chave (site + post + país).
// $1 = dono dos sites (null para o master, que vê tudo). gestor = dono do site; added_by = quem gravou.
const BASE = `
  WITH base AS (
    SELECT r.id, r.site_id, r.post_id, r.country, r.lang, r.cpr, r.cpm, r.note, r.action, r.created_at,
           s.name AS site_name, s.currency, s.user_id AS owner_id,
           o.name AS owner_name, o.company,
           u.name AS added_by, r.user_id AS added_by_id,
           LAG(r.cpr) OVER w AS prev_cpr,
           LAG(r.cpm) OVER w AS prev_cpm,
           LAG(r.created_at) OVER w AS prev_at,
           COUNT(*) OVER (PARTITION BY r.site_id, r.post_id, r.country, r.lang)::int AS readings,
           ROW_NUMBER() OVER (PARTITION BY r.site_id, r.post_id, r.country, r.lang
                              ORDER BY r.created_at DESC, r.id DESC)::int AS rn
    FROM records r
      JOIN sites s ON s.id = r.site_id
      JOIN users o ON o.id = s.user_id
      JOIN users u ON u.id = r.user_id
    WHERE ($1::int IS NULL OR s.user_id = $1)
    WINDOW w AS (PARTITION BY r.site_id, r.post_id, r.country, r.lang ORDER BY r.created_at, r.id)
  )`;

function recordFilters(q, params) {
  const where = [];
  if (q.site_id) { params.push(intId(q.site_id, 'Site')); where.push(`site_id = $${params.length}`); }
  if (q.country) { params.push(country(q.country)); where.push(`country = $${params.length}`); }
  if (q.post_id) {
    params.push(String(q.post_id).trim().slice(0, 80));
    where.push(q.exact === '1' ? `post_id = $${params.length}` : `post_id ILIKE '%' || $${params.length} || '%'`);
  }
  if (q.lang !== undefined && q.lang !== '') { params.push(langOf(q.lang)); where.push(`lang = $${params.length}`); }
  if (q.from) { params.push(dateOf(q.from, 'Data inicial')); where.push(`created_at >= $${params.length}`); }
  if (q.to) { params.push(dateOf(q.to, 'Data final')); where.push(`created_at < $${params.length}`); }
  if (q.company) { params.push(companyOf(q.company)); where.push(`company = $${params.length}`); }
  if (q.owner_id) { params.push(intId(q.owner_id, 'Gestor')); where.push(`owner_id = $${params.length}`); }
  if (q.action) { params.push(actionOf(q.action)); where.push(`action = $${params.length}`); }
  if (q.latest === '1') where.push('rn = 1');
  return where.length ? 'WHERE ' + where.join(' AND ') : '';
}

app.get('/api/records', auth, wrap(async (req, res) => {
  const params = [req.owner];
  const where = recordFilters(req.query, params);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  params.push(limit, offset);
  const { rows } = await pool.query(
    `${BASE} SELECT *, COUNT(*) OVER()::int AS total FROM base ${where}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const total = rows[0] ? rows[0].total : 0;
  rows.forEach((r) => { delete r.total; delete r.rn; });
  res.json({ records: rows, total });
}));

// Último registro da mesma campanha (site + post + país) + série para o gráfico.
// Nunca compara com outro post: cada ID é uma campanha com público e anunciantes próprios.
app.get('/api/records/last', auth, wrap(async (req, res) => {
  const site = await ownSite(req, intId(req.query.site_id, 'Site'));
  const postId = String(req.query.post_id || '').trim();
  const c = req.query.country ? country(req.query.country) : null;
  const lang = langOf(req.query.lang);
  // Ao corrigir uma leitura, compara só com o que veio antes dela.
  const ex = req.query.exclude_id ? intId(req.query.exclude_id) : null;
  const exSql = ex ? ` AND (created_at, id) < (SELECT created_at, id FROM records WHERE id=${ex})` : '';
  let exact = null, series = [];
  if (postId && c) {
    const r = await pool.query(
      `SELECT id, post_id, country, lang, cpr, cpm, note, action, created_at FROM records
       WHERE site_id=$1 AND post_id=$2 AND country=$3 AND lang=$4${exSql}
       ORDER BY created_at DESC, id DESC LIMIT 30`, [site.id, postId, c, lang]);
    series = r.rows.map(({ cpr, cpm, created_at }) => ({ cpr, cpm, created_at })).reverse();
    exact = r.rows[0] || null;
  }
  res.json({ exact, series });
}));

function recordBody(body) {
  return {
    post_id: str(body.post_id, 80, 'Post ID'),
    country: country(body.country),
    lang: langOf(body.lang),
    cpr: money(body.cpr, 'CPR'),
    cpm: money(body.cpm, 'eCPM'),
    note: str(body.note, 280, 'Observação', { required: false }),
    action: actionOf(body.action),
  };
}
const RET = 'id, site_id, post_id, country, lang, cpr, cpm, note, action, created_at';

app.post('/api/records', auth, wrap(async (req, res) => {
  const site = await ownSite(req, intId(req.body.site_id, 'Site'));
  const rec = recordBody(req.body);
  const prev = await pool.query(
    `SELECT cpr, cpm, created_at FROM records WHERE site_id=$1 AND post_id=$2 AND country=$3 AND lang=$4
     ORDER BY created_at DESC, id DESC LIMIT 1`, [site.id, rec.post_id, rec.country, rec.lang]);
  const { rows } = await pool.query(
    `INSERT INTO records (user_id, site_id, post_id, country, lang, cpr, cpm, note, action)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${RET}`,
    [req.uid, site.id, rec.post_id, rec.country, rec.lang, rec.cpr, rec.cpm, rec.note, rec.action]);
  res.status(201).json({ record: rows[0], previous: prev.rows[0] || null });
}));

// Corrige uma leitura já gravada. A data original e quem gravou são mantidos.
app.patch('/api/records/:id', auth, wrap(async (req, res) => {
  const id = intId(req.params.id);
  const site = await ownSite(req, intId(req.body.site_id, 'Site'));
  const rec = recordBody(req.body);
  const { rows } = await pool.query(
    `UPDATE records r SET site_id=$1, post_id=$2, country=$3, cpr=$4, cpm=$5, note=$6, action=$7, lang=$10
     FROM sites s WHERE s.id = r.site_id AND r.id=$8 AND ($9::int IS NULL OR s.user_id=$9)
     RETURNING r.id, r.site_id, r.post_id, r.country, r.lang, r.cpr, r.cpm, r.note, r.action, r.created_at`,
    [site.id, rec.post_id, rec.country, rec.cpr, rec.cpm, rec.note, rec.action, id, req.owner, rec.lang]);
  if (!rows[0]) throw new HttpError(404, 'Registro não encontrado.');
  const prev = await pool.query(
    `SELECT cpr, cpm, created_at FROM records
     WHERE site_id=$1 AND post_id=$2 AND country=$3 AND lang=$5
       AND (created_at, id) < (SELECT created_at, id FROM records WHERE id=$4)
     ORDER BY created_at DESC, id DESC LIMIT 1`, [site.id, rows[0].post_id, rows[0].country, id, rows[0].lang]);
  res.json({ record: rows[0], previous: prev.rows[0] || null });
}));

app.delete('/api/records/:id', auth, wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM records r USING sites s WHERE s.id = r.site_id AND r.id=$1 AND ($2::int IS NULL OR s.user_id=$2)`,
    [intId(req.params.id), req.owner]);
  if (!rowCount) throw new HttpError(404, 'Registro não encontrado.');
  res.json({ ok: true });
}));

// IDs cadastrados num site, com a última leitura de cada um (aba ATUALIZAÇÃO).
app.get('/api/sites/:id/campaigns', auth, wrap(async (req, res) => {
  const site = await ownSite(req, intId(req.params.id));
  const { rows } = await pool.query(
    `${BASE} SELECT post_id, country, lang, cpr, cpm, prev_cpr, prev_cpm, action, note, created_at, readings, added_by
     FROM base WHERE site_id = $2 AND rn = 1 ORDER BY created_at DESC`, [req.owner, site.id]);
  res.json({ site: { id: site.id, name: site.name, currency: site.currency }, campaigns: rows });
}));

const ACTION_LABEL = { escalei: 'ESCALEI', reduzi: 'REDUZI', mantive: 'MANTIVE', '': '' };

app.get('/api/records/export.csv', auth, wrap(async (req, res) => {
  const params = [req.owner];
  const where = recordFilters(req.query, params);
  const { rows } = await pool.query(`${BASE} SELECT * FROM base ${where} ORDER BY created_at DESC, id DESC LIMIT 20000`, params);
  const TEXT_COLS = new Set([1, 2, 3, 4, 5, 6, 15]); // texto livre do usuário
  const cell = (v, i) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (TEXT_COLS.has(i) && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita fórmula em planilha
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const pct = (a, b) => (b ? (((a - b) / b) * 100).toFixed(2) : '');
  const lines = [['data', 'post_id', 'pais', 'idioma', 'site', 'empresa', 'gestor', 'adicionado_por', 'moeda', 'cpr', 'cpr_anterior', 'cpr_var_pct', 'ecpm', 'ecpm_anterior', 'ecpm_var_pct', 'acao', 'observacao'].join(',')];
  for (const r of rows) {
    lines.push([
      r.created_at.toISOString(), r.post_id, r.country, r.lang, r.site_name, r.company, r.owner_name, r.added_by, r.currency,
      r.cpr, r.prev_cpr, pct(r.cpr, r.prev_cpr), r.cpm, r.prev_cpm, pct(r.cpm, r.prev_cpm), ACTION_LABEL[r.action] || '', r.note,
    ].map(cell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mbz-pulse-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

/* ---------- exportação Excel ---------- */

const CUR_FMT = { USD: '"$" #,##0.00##', BRL: '"R$" #,##0.00##', EUR: '"€" #,##0.00##' };
const FLAT_PCT = 0.02; // mesma faixa de "estável" da tela
const pctOf = (cur, prev) => (prev ? (cur - prev) / prev : null);
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;

function statusOf(dCpr, dCpm) {
  if (dCpr === null && dCpm === null) return '1ª LEITURA';
  // gain > 0 = melhorou. CPR é custo (cair é bom); eCPM é receita (subir é bom).
  const cls = (gain) => (gain === null ? null : gain > FLAT_PCT ? 'good' : gain < -FLAT_PCT ? 'bad' : 'flat');
  const set = [cls(dCpr === null ? null : -dCpr), cls(dCpm)];
  if (set.includes('good') && set.includes('bad')) return 'MISTO';
  if (set.includes('bad')) return 'PIOROU';
  if (set.includes('good')) return 'MELHOROU';
  return 'ESTÁVEL';
}
const STATUS_COLOR = { MELHOROU: 'FF12824C', PIOROU: 'FFD81B60', MISTO: 'FFB7791F', 'ESTÁVEL': 'FF0E7490', '1ª LEITURA': 'FF64748B' };
const ACTION_COLOR = { ESCALEI: 'FF0E7490', REDUZI: 'FFB7791F', MANTIVE: 'FF64748B' };
const DARK = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0E16' } };
const font = (o = {}) => ({ name: 'Consolas', size: 10, ...o });
const pctColor = (gain) => (gain > FLAT_PCT ? 'FF12824C' : gain < -FLAT_PCT ? 'FFD81B60' : 'FF64748B');

function styleCell(cell, c, v, r) {
  cell.font = font();
  if (c.t === 'cur') cell.numFmt = CUR_FMT[r.currency] || '#,##0.00##';
  else if (c.t === 'date') cell.numFmt = 'dd/mm/yyyy hh:mm';
  else if (c.t === 'int') cell.numFmt = '0';
  else if (c.t === 'pct') {
    cell.numFmt = '+0.0%;-0.0%;0.0%';
    if (typeof v === 'number') cell.font = font({ bold: true, color: { argb: pctColor(c.up ? v : -v) } });
  } else if (c.t === 'status' && v) cell.font = font({ bold: true, color: { argb: STATUS_COLOR[v] || 'FF64748B' } });
  else if (c.t === 'action' && v) cell.font = font({ bold: true, color: { argb: ACTION_COLOR[v] || 'FF64748B' } });
  else if (c.t === 'key') cell.font = font({ bold: true, color: { argb: 'FF0B3B4A' } });
}

function titleRows(ws, title, subtitle, n) {
  ws.mergeCells(1, 1, 1, n);
  ws.mergeCells(2, 1, 2, n);
  Object.assign(ws.getCell(1, 1), { value: title, font: font({ bold: true, size: 14, color: { argb: 'FF39FF9C' } }), fill: DARK });
  Object.assign(ws.getCell(2, 1), { value: subtitle, font: font({ size: 9, color: { argb: 'FF8FA3BA' } }), fill: DARK });
  ws.getRow(1).height = 24;
}

// Monta uma aba: faixa de título, cabeçalho escuro, filtro, painel congelado e formatos por tipo de coluna.
function addSheet(wb, name, subtitle, cols, rows, freezeCols = 1) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4, xSplit: freezeCols }] });
  ws.columns = cols.map((c) => ({ width: c.w }));
  titleRows(ws, `MBZ::PULSE — ${name}`, subtitle, cols.length);
  const head = ws.getRow(4);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.h;
    cell.font = font({ bold: true, color: { argb: 'FF19E3FF' } });
    cell.fill = DARK;
    cell.alignment = { vertical: 'middle', horizontal: ['text', 'key', 'status', 'action'].includes(c.t) ? 'left' : 'right' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF39FF9C' } } };
  });
  head.height = 20;
  rows.forEach((r, n) => {
    const row = ws.getRow(5 + n);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      const v = r[c.k];
      cell.value = v === undefined ? null : v;
      styleCell(cell, c, v, r);
      if (n % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FA' } };
    });
  });
  if (rows.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + rows.length, column: cols.length } };
  return ws;
}

// Aba "IDs": uma linha por ID + país + site, com as últimas leituras lado a lado (mais recente primeiro).
// Site, empresa e gestor são colunas normais, então dá para filtrar por qualquer um deles.
const MAX_COLS_READINGS = 8;
const FIXED = [
  { h: 'POST ID', k: 'post_id', t: 'key', w: 20 }, { h: 'PAÍS', k: 'country', t: 'key', w: 7 }, { h: 'IDIOMA', k: 'lang', t: 'key', w: 8 },
  { h: 'SITE', k: 'site', t: 'text', w: 22 }, { h: 'EMPRESA', k: 'company', t: 'text', w: 13 }, { h: 'GESTOR', k: 'owner', t: 'text', w: 16 },
  { h: 'STATUS', k: 'status', t: 'status', w: 12 }, { h: 'Δ CPR', k: 'd_cpr', t: 'pct', w: 9 }, { h: 'Δ eCPM', k: 'd_cpm', t: 'pct', up: true, w: 9 },
  { h: 'LEIT.', k: 'n', t: 'int', w: 7 },
];
const PER = [
  { h: 'DATA / HORA', k: 'at', t: 'date', w: 17 }, { h: 'CPR', k: 'cpr', t: 'cur', w: 11 }, { h: 'eCPM', k: 'cpm', t: 'cur', w: 11 },
  { h: 'AÇÃO', k: 'action', t: 'action', w: 10 }, { h: 'POR', k: 'by', t: 'text', w: 12 },
];

function addIdsSheet(wb, camps, subtitle, local, K) {
  const ws = wb.addWorksheet('IDs', { views: [{ state: 'frozen', xSplit: 4, ySplit: 5 }] });
  const cols = FIXED.map((c) => ({ width: c.w }));
  for (let k = 0; k < K; k++) PER.forEach((c) => cols.push({ width: c.w }));
  ws.columns = cols;
  const N = cols.length;
  titleRows(ws, 'MBZ::PULSE — IDs · uma linha por ID', subtitle, N);
  const light = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9F4FA' } };
  const light2 = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2F7' } };
  const sep = { left: { style: 'thin', color: { argb: 'FFB6C2D1' } } };

  // linha 4 = grupos (ÚLTIMA LEITURA, ANTERIOR, ...), linha 5 = cabeçalho com filtro
  const g = ws.getRow(4), h = ws.getRow(5);
  FIXED.forEach((c, i) => {
    Object.assign(g.getCell(i + 1), { fill: DARK });
    Object.assign(h.getCell(i + 1), {
      value: c.h, font: font({ bold: true, color: { argb: 'FF19E3FF' } }), fill: DARK,
      alignment: { horizontal: ['text', 'key', 'status'].includes(c.t) ? 'left' : 'right' },
      border: { bottom: { style: 'medium', color: { argb: 'FF39FF9C' } } },
    });
  });
  for (let k = 0; k < K; k++) {
    const c0 = FIXED.length + 1 + k * PER.length;
    ws.mergeCells(4, c0, 4, c0 + PER.length - 1);
    Object.assign(g.getCell(c0), {
      value: k === 0 ? 'ÚLTIMA LEITURA' : k === 1 ? 'ANTERIOR' : `${k + 1}ª MAIS RECENTE`,
      font: font({ bold: true, size: 9, color: { argb: k === 0 ? 'FF0B3B4A' : 'FF64748B' } }),
      fill: k % 2 ? light2 : light, alignment: { horizontal: 'center' }, border: sep,
    });
    PER.forEach((c, j) => {
      Object.assign(h.getCell(c0 + j), {
        value: `${c.h}${k ? ' ' + (k + 1) : ''}`, font: font({ bold: true, size: 9, color: { argb: 'FF64748B' } }),
        fill: k % 2 ? light2 : light, alignment: { horizontal: ['text', 'action', 'date'].includes(c.t) ? 'left' : 'right' },
        border: { ...(j === 0 ? sep : {}), bottom: { style: 'medium', color: { argb: 'FF39FF9C' } } },
      });
    });
  }
  h.height = 20;

  camps.forEach((c, n) => {
    const row = ws.getRow(6 + n);
    const zebra = n % 2 ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FA' } } : null;
    FIXED.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      cell.value = c[col.k] === undefined ? null : c[col.k];
      styleCell(cell, col, c[col.k], c);
      if (zebra) cell.fill = zebra;
    });
    c.list.slice(-K).reverse().forEach((x, k) => {
      const c0 = FIXED.length + 1 + k * PER.length;
      const vals = { at: local(x.created_at), cpr: x.cpr, cpm: x.cpm, action: ACTION_LABEL[x.action] || null, by: x.added_by };
      PER.forEach((col, j) => {
        const cell = row.getCell(c0 + j);
        cell.value = vals[col.k];
        styleCell(cell, col, vals[col.k], c);
        if (col.t === 'date') cell.numFmt = 'dd/mm/yy hh:mm';
        if (k === 0 && col.t !== 'action') cell.font = font({ bold: true });
        else if (k > 0 && col.t !== 'action') cell.font = font({ color: { argb: 'FF475569' } });
        if (j === 0) cell.border = sep;
        if (zebra) cell.fill = zebra;
      });
    });
  });
  if (camps.length) ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5 + camps.length, column: N } };
  return ws;
}

app.get('/api/records/export.xlsx', auth, wrap(async (req, res) => {
  const params = [req.owner];
  const where = recordFilters({ ...req.query, latest: undefined }, params);
  const { rows } = await pool.query(
    `${BASE} SELECT * FROM base ${where} ORDER BY lower(site_name), site_id, post_id, country, created_at, id LIMIT 50000`, params);

  // Excel não tem fuso: desloca para o horário local de quem exportou.
  const tzo = Math.min(Math.max(parseInt(req.query.tzo, 10) || 0, -840), 840);
  const local = (d) => (d ? new Date(d.getTime() - tzo * 60000) : null);
  const stamp = local(new Date()).toISOString().slice(0, 16).replace('T', ' ');

  // Agrupa: site -> campanha (post + país) -> leituras em ordem cronológica.
  const sites = new Map();
  for (const r of rows) {
    if (!sites.has(r.site_id)) sites.set(r.site_id, { name: r.site_name, currency: r.currency, owner: r.owner_name, company: r.company, camps: new Map(), readings: [] });
    const s = sites.get(r.site_id);
    const key = r.post_id + '|' + r.country + '|' + r.lang;
    if (!s.camps.has(key)) s.camps.set(key, []);
    s.camps.get(key).push(r);
    s.readings.push(r);
  }

  const summary = [];
  const camps = [];
  let maxN = 1;
  for (const s of sites.values()) {
    const mine = [];
    for (const list of s.camps.values()) {
      const last = list[list.length - 1];
      const dCpr = last.prev_cpr === null ? null : pctOf(last.cpr, last.prev_cpr);
      const dCpm = last.prev_cpm === null ? null : pctOf(last.cpm, last.prev_cpm);
      maxN = Math.max(maxN, list.length);
      mine.push({
        post_id: last.post_id, country: last.country, lang: last.lang || null, site: s.name, company: s.company, owner: s.owner, currency: s.currency,
        n: list.length, cpr: last.cpr, cpm: last.cpm, d_cpr: dCpr, d_cpm: dCpm, status: statusOf(dCpr, dCpm), list,
      });
    }
    mine.sort((a, b) => a.post_id.localeCompare(b.post_id, undefined, { numeric: true }) || a.country.localeCompare(b.country) || (a.lang || '').localeCompare(b.lang || ''));
    camps.push(...mine);
    const byCpr = mine.slice().sort((a, b) => a.cpr - b.cpr);
    const count = (st) => mine.filter((c) => c.status === st).length;
    const label = (c) => `${c.post_id} · ${c.country}${c.lang ? ' · ' + c.lang : ''}`;
    summary.push({
      site: s.name, company: s.company, owner: s.owner, currency: s.currency, moeda: s.currency, camps: mine.length, readings: s.readings.length,
      cpr_avg: avg(mine.map((c) => c.cpr)), cpm_avg: avg(mine.map((c) => c.cpm)),
      up: count('MELHOROU'), down: count('PIOROU'), mixed: count('MISTO'), flat: count('ESTÁVEL'),
      best: label(byCpr[0]), best_cpr: byCpr[0].cpr, worst: label(byCpr[byCpr.length - 1]), worst_cpr: byCpr[byCpr.length - 1].cpr,
      last_at: local(new Date(Math.max(...s.readings.map((r) => r.created_at.getTime())))),
    });
  }
  const K = Math.min(maxN, MAX_COLS_READINGS);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MBZ::PULSE';
  wb.created = new Date();
  const sub = `gerado em ${stamp} por ${req.user.name} · ${sites.size} sites · ${camps.length} IDs · ${rows.length} leituras · verde = melhorou (CPR caiu ou eCPM subiu) · status compara a última leitura com a anterior do mesmo ID`;

  addIdsSheet(wb, camps, sub + (maxN > K ? ` · até ${K} leituras por linha; o histórico completo está na aba LEITURAS` : ''), local, K);

  addSheet(wb, 'RESUMO', sub, [
    { h: 'SITE', k: 'site', t: 'key', w: 24 }, { h: 'EMPRESA', k: 'company', t: 'text', w: 13 }, { h: 'GESTOR', k: 'owner', t: 'text', w: 16 },
    { h: 'MOEDA', k: 'moeda', t: 'text', w: 8 },
    { h: 'IDs', k: 'camps', t: 'int', w: 8 }, { h: 'LEITURAS', k: 'readings', t: 'int', w: 11 },
    { h: 'CPR MÉDIO ATUAL', k: 'cpr_avg', t: 'cur', w: 18 }, { h: 'eCPM MÉDIO ATUAL', k: 'cpm_avg', t: 'cur', w: 18 },
    { h: 'MELHORARAM', k: 'up', t: 'int', w: 13 }, { h: 'PIORARAM', k: 'down', t: 'int', w: 11 },
    { h: 'MISTAS', k: 'mixed', t: 'int', w: 9 }, { h: 'ESTÁVEIS', k: 'flat', t: 'int', w: 11 },
    { h: 'MELHOR CPR (ID · PAÍS)', k: 'best', t: 'text', w: 30 }, { h: 'CPR', k: 'best_cpr', t: 'cur', w: 12 },
    { h: 'PIOR CPR (ID · PAÍS)', k: 'worst', t: 'text', w: 30 }, { h: 'CPR', k: 'worst_cpr', t: 'cur', w: 12 },
    { h: 'ÚLTIMA LEITURA', k: 'last_at', t: 'date', w: 18 },
  ], summary);

  // Todas as leituras numa lista só, com ID e país na frente, para filtrar.
  const flat = rows.slice().sort((a, b) => a.site_name.localeCompare(b.site_name) || a.post_id.localeCompare(b.post_id, undefined, { numeric: true })
    || a.country.localeCompare(b.country) || b.created_at - a.created_at).map((r) => ({
    currency: r.currency, post_id: r.post_id, country: r.country, lang: r.lang || null, site: r.site_name, company: r.company, owner: r.owner_name, by: r.added_by,
    at: local(r.created_at),
    cpr: r.cpr, d_cpr: r.prev_cpr === null ? null : pctOf(r.cpr, r.prev_cpr),
    cpm: r.cpm, d_cpm: r.prev_cpm === null ? null : pctOf(r.cpm, r.prev_cpm),
    action: ACTION_LABEL[r.action] || null, note: r.note,
  }));
  addSheet(wb, 'LEITURAS', sub + ' · mais recente primeiro dentro de cada ID', [
    { h: 'POST ID', k: 'post_id', t: 'key', w: 20 }, { h: 'PAÍS', k: 'country', t: 'key', w: 7 }, { h: 'IDIOMA', k: 'lang', t: 'key', w: 8 }, { h: 'SITE', k: 'site', t: 'text', w: 22 },
    { h: 'EMPRESA', k: 'company', t: 'text', w: 13 }, { h: 'GESTOR', k: 'owner', t: 'text', w: 16 }, { h: 'ADICIONADO POR', k: 'by', t: 'text', w: 16 },
    { h: 'DATA / HORA', k: 'at', t: 'date', w: 16 },
    { h: 'CPR', k: 'cpr', t: 'cur', w: 12 }, { h: 'Δ CPR', k: 'd_cpr', t: 'pct', w: 9 },
    { h: 'eCPM', k: 'cpm', t: 'cur', w: 12 }, { h: 'Δ eCPM', k: 'd_cpm', t: 'pct', up: true, w: 9 },
    { h: 'AÇÃO', k: 'action', t: 'action', w: 10 }, { h: 'OBSERVAÇÃO', k: 'note', t: 'text', w: 40 },
  ], flat, 4);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="mbz-pulse-${stamp.slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

/* ---------- importação de planilha ---------- */

const IMPORT_COLS = {
  site: ['site', 'blog', 'dominio', 'domain'],
  post_id: ['post_id', 'postid', 'post id', 'id', 'id do post', 'campanha', 'anuncio', 'ad id'],
  country: ['pais', 'country', 'geo', 'cc'],
  lang: ['idioma', 'lang', 'language', 'lingua'],
  cpr: ['cpr'],
  cpm: ['ecpm', 'cpm'],
  action: ['acao', 'action', 'o que fez', 'ajuste'],
  note: ['obs', 'observacao', 'observacoes', 'note', 'nota', 'comentario'],
  at: ['data', 'data/hora', 'data hora', 'datahora', 'date', 'quando', 'horario', 'hora'],
  owner: ['gestor', 'usuario', 'owner', 'dono'],
};
const normHeader = (h) => String(h ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[_\s]+/g, ' ');
function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const n = normHeader(h).replace(/\s*\(.*\)\s*$/, '');
    for (const [key, names] of Object.entries(IMPORT_COLS)) {
      if (map[key] === undefined && names.some((x) => x.replace(/_/g, ' ') === n)) map[key] = i;
    }
  });
  return map;
}

// CSV simples (vírgula ou ponto e vírgula, aspas duplas).
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const cellText = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.result !== undefined) return v.result;
    if (v.text !== undefined) return v.text;
  }
  return v;
};

// Data informada na planilha, interpretada no fuso de quem importa (tzo em minutos, como getTimezoneOffset).
function importDate(v, tzo) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return new Date(v.getTime() + tzo * 60000); // exceljs entrega a hora "de parede" como UTC
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return new Date(Date.UTC(y, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) + tzo * 60000);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) + tzo * 60000);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  throw bad('Data inválida (use dd/mm/aaaa hh:mm).');
}

async function scopedSites(req) {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.currency, s.user_id, o.name AS owner_name FROM sites s JOIN users o ON o.id = s.user_id
     WHERE ($1::int IS NULL OR s.user_id = $1)`, [req.owner]);
  return rows;
}

// Valida uma linha e devolve o registro pronto para inserir, ou a mensagem de erro.
function buildImportRow(raw, sites, tzo) {
  const out = { n: raw.n, site: String(raw.site ?? '').trim(), post_id: String(raw.post_id ?? '').trim(), country: String(raw.country ?? '').trim().toUpperCase(),
    lang: String(raw.lang ?? '').trim().toLowerCase(), cpr: raw.cpr, cpm: raw.cpm, action: String(raw.action ?? '').trim(), note: String(raw.note ?? '').trim(),
    at: null, owner: String(raw.owner ?? '').trim(), site_id: null, currency: null, error: null };
  try {
    if (!out.site) throw bad('Site em branco.');
    const matches = sites.filter((s) => s.name.toLowerCase() === out.site.toLowerCase());
    let site = matches[0];
    if (matches.length > 1) {
      site = matches.find((s) => s.owner_name.toLowerCase() === out.owner.toLowerCase());
      if (!site) throw bad(`Há ${matches.length} sites "${out.site}" (gestores: ${matches.map((s) => s.owner_name).join(', ')}). Preencha a coluna GESTOR.`);
    }
    if (!site) throw bad(`Site "${out.site}" não encontrado. Cadastre antes ou confira o nome.`);
    out.site_id = site.id; out.currency = site.currency; out.site = site.name; out.owner = site.owner_name;
    out.post_id = str(out.post_id, 80, 'Post ID');
    out.country = country(out.country);
    out.lang = langOf(out.lang);
    out.cpr = money(out.cpr, 'CPR');
    out.cpm = money(out.cpm, 'eCPM');
    const a = normHeader(out.action);
    out.action = actionOf({ escalei: 'escalei', escalar: 'escalei', escala: 'escalei', reduzi: 'reduzi', reduzir: 'reduzi', mantive: 'mantive', manter: 'mantive', mantido: 'mantive' }[a] || a);
    out.note = str(out.note, 280, 'Observação', { required: false });
    out.at = importDate(raw.at, tzo);
    if (out.at && out.at.getTime() > Date.now() + 60e3) throw bad('Data no futuro.');
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    out.error = e.message;
  }
  return out;
}

const rawBody = express.raw({ type: () => true, limit: '8mb' });

// 1) Lê o arquivo (xlsx ou csv), valida linha a linha e devolve a prévia. Não grava nada.
app.post('/api/import/parse', auth, rawBody, wrap(async (req, res) => {
  const buf = req.body;
  if (!buf || !buf.length) throw bad('Arquivo vazio.');
  const tzo = Math.min(Math.max(parseInt(req.query.tzo, 10) || 0, -840), 840);
  let table;
  if (buf[0] === 0x50 && buf[1] === 0x4b) { // xlsx (zip)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets.find((w) => w.name.toUpperCase() !== 'SITES' && w.name.toUpperCase() !== 'AJUDA') || wb.worksheets[0];
    if (!ws) throw bad('Planilha sem abas.');
    table = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(row.getCell(c).value));
      if (vals.some((v) => v !== '' && v !== null)) table.push(vals);
    });
  } else {
    table = parseCsv(buf.toString('utf8'));
  }
  if (table.length < 2) throw bad('A planilha precisa de um cabeçalho e pelo menos uma linha.');
  const map = mapHeaders(table[0]);
  const missing = ['site', 'post_id', 'country', 'cpr', 'cpm'].filter((k) => map[k] === undefined);
  if (missing.length) throw bad(`Faltam colunas: ${missing.map((k) => ({ site: 'SITE', post_id: 'POST ID', country: 'PAÍS', cpr: 'CPR', cpm: 'eCPM' }[k])).join(', ')}. Baixe o modelo para ver o formato.`);
  const sites = await scopedSites(req);
  const rows = table.slice(1, 5001).map((vals, i) => {
    const pick = (k) => (map[k] === undefined ? '' : vals[map[k]]);
    return buildImportRow({ n: i + 2, site: pick('site'), post_id: pick('post_id'), country: pick('country'), lang: pick('lang'),
      cpr: pick('cpr'), cpm: pick('cpm'), action: pick('action'), note: pick('note'), at: pick('at'), owner: pick('owner') }, sites, tzo);
  });
  res.json({ rows, ok: rows.filter((r) => !r.error).length, errors: rows.filter((r) => r.error).length, truncated: table.length - 1 > 5000 });
}));

// 2) Grava as linhas válidas (revalida tudo no servidor).
app.post('/api/import/commit', auth, wrap(async (req, res) => {
  const list = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 5000) : [];
  if (!list.length) throw bad('Nada para importar.');
  const sites = await scopedSites(req);
  const rows = list.map((r, i) => buildImportRow({ ...r, n: r.n || i + 1 }, sites, 0)).filter((r) => !r.error);
  if (!rows.length) throw bad('Nenhuma linha válida.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO records (user_id, site_id, post_id, country, lang, cpr, cpm, note, action, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, now()))`,
        [req.uid, r.site_id, r.post_id, r.country, r.lang, r.cpr, r.cpm, r.note, r.action, r.at]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  res.json({ imported: rows.length, skipped: list.length - rows.length });
}));

// Modelo para preencher, com os sites do usuário numa aba de apoio.
app.get('/api/import/template.xlsx', auth, wrap(async (req, res) => {
  const sites = await scopedSites(req);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('LEITURAS', { views: [{ state: 'frozen', ySplit: 1 }] });
  const heads = ['SITE', 'POST ID', 'PAÍS', 'IDIOMA', 'CPR', 'eCPM', 'AÇÃO', 'OBS', 'DATA (opcional)'];
  if (req.user.is_master) heads.push('GESTOR');
  ws.columns = [26, 22, 8, 10, 10, 10, 12, 36, 20, 18].slice(0, heads.length).map((width) => ({ width }));
  const head = ws.getRow(1);
  heads.forEach((h, i) => Object.assign(head.getCell(i + 1), { value: h, font: font({ bold: true, color: { argb: 'FF19E3FF' } }), fill: DARK }));
  const ex = sites[0] ? sites[0].name : 'Nome do site';
  ws.addRow([ex, '120214567890123', 'US', 'en', 0.02, 5.84, 'escalei', 'subi orçamento', '']);
  ws.addRow([ex, '120214567890123', 'US', 'es', 0.03, 4.1, 'mantive', '', '']);
  ws.addRow([ex, '120214567890124', 'BR', '', 0.8, 18.5, 'reduzi', 'troquei criativo', '13/10/2026 14:30']);
  ws.getColumn(5).numFmt = '0.00##'; ws.getColumn(6).numFmt = '0.00##';
  ws.getColumn(2).numFmt = '@';
  const help = wb.addWorksheet('AJUDA');
  help.columns = [{ width: 110 }];
  [
    'MBZ::PULSE — modelo de importação',
    '',
    'Cada linha vira UMA leitura nova (não substitui as anteriores; o histórico é preservado).',
    'SITE: exatamente como está cadastrado (veja a aba SITES). POST ID: o ID do post/anúncio.',
    'PAÍS: código de 2 letras (BR, US, PT...). IDIOMA: opcional (en, es, pt...). Use quando o mesmo ID roda em dois idiomas no mesmo país.',
    'CPR e eCPM: números (0,35 ou 0.35). AÇÃO: escalei, reduzi ou mantive (opcional). OBS: texto livre (opcional).',
    'DATA: opcional, dd/mm/aaaa hh:mm no seu horário local. Em branco = momento da importação.',
    'As linhas de exemplo podem ser apagadas. As colunas podem vir em outra ordem, desde que o cabeçalho seja mantido.',
  ].forEach((t, i) => { help.getCell(i + 1, 1).value = t; if (i === 0) help.getCell(1, 1).font = font({ bold: true, size: 13 }); });
  const ss = wb.addWorksheet('SITES');
  ss.columns = [{ width: 30 }, { width: 10 }, { width: 20 }];
  ss.addRow(['SITE', 'MOEDA', 'GESTOR']).font = font({ bold: true });
  sites.sort((a, b) => a.name.localeCompare(b.name)).forEach((s) => ss.addRow([s.name, s.currency, s.owner_name]));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="mbz-pulse-modelo-importacao.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));

/* ---------- estático + erros ---------- */

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1h' : 0 }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error('[PULSE]', err);
  res.status(500).json({ error: 'Erro interno. Tente de novo.' });
});

migrate()
  .then(async () => {
    if (MASTER_EMAILS.length) {
      const { rowCount } = await pool.query('UPDATE users SET is_master = (email = ANY($1)) WHERE is_master <> (email = ANY($1))', [MASTER_EMAILS]);
      if (rowCount) console.log(`[PULSE] acesso master ajustado em ${rowCount} conta(s).`);
    }
    app.listen(PORT, () => console.log(`[PULSE] online na porta ${PORT}`));
  })
  .catch((e) => { console.error('[PULSE] falha ao preparar o banco:', e); process.exit(1); });
