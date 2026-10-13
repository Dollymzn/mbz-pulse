const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, migrate } = require('./db');

const PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const PORT = process.env.PORT || 3000;
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();
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
app.use(express.json({ limit: '50kb' }));
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

function auth(req, res, next) {
  try {
    const token = readCookie(req, COOKIE);
    if (!token) throw new Error('no token');
    req.uid = jwt.verify(token, JWT_SECRET).uid;
    next();
  } catch {
    res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
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

async function ownSite(uid, siteId) {
  const { rows } = await pool.query('SELECT id, name, currency FROM sites WHERE id=$1 AND user_id=$2', [siteId, uid]);
  if (!rows[0]) throw new HttpError(404, 'Site não encontrado.');
  return rows[0];
}

/* ---------- auth ---------- */

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.get('/api/config', (req, res) => res.json({ invite_required: !!INVITE_CODE }));

app.post('/api/auth/register', limiter, wrap(async (req, res) => {
  const name = str(req.body.name, 60, 'Nome');
  const email = str(req.body.email, 120, 'E-mail').toLowerCase();
  const password = String(req.body.password || '');
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
      'INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email',
      [name, email, hash]);
    setSession(res, rows[0]);
    res.status(201).json({ user: rows[0] });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Já existe uma conta com esse e-mail.');
    throw e;
  }
}));

app.post('/api/auth/login', limiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT id, name, email, password_hash FROM users WHERE email=$1', [email]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!u || !ok) throw new HttpError(401, 'E-mail ou senha incorretos.');
  setSession(res, u);
  res.json({ user: { id: u.id, name: u.name, email: u.email } });
}));

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${PROD ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/me', auth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email FROM users WHERE id=$1', [req.uid]);
  if (!rows[0]) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
  res.json({ user: rows[0] });
}));

/* ---------- sites ---------- */

app.get('/api/sites', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.url, s.currency, s.created_at,
           COUNT(r.id)::int AS records,
           COUNT(DISTINCT (r.post_id, r.country))::int AS campaigns,
           MAX(r.created_at) AS last_at
    FROM sites s LEFT JOIN records r ON r.site_id = s.id
    WHERE s.user_id = $1
    GROUP BY s.id ORDER BY lower(s.name)`, [req.uid]);
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
const dupSite = (e) => (e.code === '23505' ? new HttpError(409, 'Você já tem um site com esse nome.') : e);

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
      'UPDATE sites SET name=$1, url=$2, currency=$3 WHERE id=$4 AND user_id=$5 RETURNING id, name, url, currency',
      [s.name, s.url, s.currency, id, req.uid]);
    if (!rows[0]) throw new HttpError(404, 'Site não encontrado.');
    res.json({ site: rows[0] });
  } catch (e) { throw dupSite(e); }
}));

app.delete('/api/sites/:id', auth, wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM sites WHERE id=$1 AND user_id=$2', [intId(req.params.id), req.uid]);
  if (!rowCount) throw new HttpError(404, 'Site não encontrado.');
  res.json({ ok: true });
}));

/* ---------- registros ---------- */

// Cada linha já vem com o registro anterior da mesma chave (site + post + país).
const BASE = `
  WITH base AS (
    SELECT r.id, r.site_id, r.post_id, r.country, r.cpr, r.cpm, r.note, r.created_at,
           s.name AS site_name, s.currency,
           LAG(r.cpr) OVER w AS prev_cpr,
           LAG(r.cpm) OVER w AS prev_cpm,
           LAG(r.created_at) OVER w AS prev_at,
           COUNT(*) OVER (PARTITION BY r.site_id, r.post_id, r.country)::int AS readings,
           ROW_NUMBER() OVER (PARTITION BY r.site_id, r.post_id, r.country
                              ORDER BY r.created_at DESC, r.id DESC)::int AS rn
    FROM records r JOIN sites s ON s.id = r.site_id
    WHERE r.user_id = $1
    WINDOW w AS (PARTITION BY r.site_id, r.post_id, r.country ORDER BY r.created_at, r.id)
  )`;

function recordFilters(q, params) {
  const where = [];
  if (q.site_id) { params.push(intId(q.site_id, 'Site')); where.push(`site_id = $${params.length}`); }
  if (q.country) { params.push(country(q.country)); where.push(`country = $${params.length}`); }
  if (q.post_id) {
    params.push(String(q.post_id).trim().slice(0, 80));
    where.push(q.exact === '1' ? `post_id = $${params.length}` : `post_id ILIKE '%' || $${params.length} || '%'`);
  }
  if (q.latest === '1') where.push('rn = 1');
  return where.length ? 'WHERE ' + where.join(' AND ') : '';
}

app.get('/api/records', auth, wrap(async (req, res) => {
  const params = [req.uid];
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

// Último registro da chave exata + fallback (mesmo site e país) + série para o gráfico.
app.get('/api/records/last', auth, wrap(async (req, res) => {
  const siteId = intId(req.query.site_id, 'Site');
  const postId = String(req.query.post_id || '').trim();
  const c = req.query.country ? country(req.query.country) : null;
  let exact = null, fallback = null, series = [];
  if (postId && c) {
    const r = await pool.query(
      `SELECT id, post_id, country, cpr, cpm, note, created_at FROM records
       WHERE user_id=$1 AND site_id=$2 AND post_id=$3 AND country=$4
       ORDER BY created_at DESC, id DESC LIMIT 30`, [req.uid, siteId, postId, c]);
    series = r.rows.map(({ cpr, cpm, created_at }) => ({ cpr, cpm, created_at })).reverse();
    exact = r.rows[0] || null;
  }
  if (!exact && c) {
    const r = await pool.query(
      `SELECT id, post_id, country, cpr, cpm, note, created_at FROM records
       WHERE user_id=$1 AND site_id=$2 AND country=$3
       ORDER BY created_at DESC, id DESC LIMIT 1`, [req.uid, siteId, c]);
    fallback = r.rows[0] || null;
  }
  res.json({ exact, fallback, series });
}));

app.post('/api/records', auth, wrap(async (req, res) => {
  const site = await ownSite(req.uid, intId(req.body.site_id, 'Site'));
  const rec = {
    post_id: str(req.body.post_id, 80, 'Post ID'),
    country: country(req.body.country),
    cpr: money(req.body.cpr, 'CPR'),
    cpm: money(req.body.cpm, 'CPM'),
    note: str(req.body.note, 280, 'Observação', { required: false }),
  };
  const prev = await pool.query(
    `SELECT cpr, cpm, created_at FROM records
     WHERE user_id=$1 AND site_id=$2 AND post_id=$3 AND country=$4
     ORDER BY created_at DESC, id DESC LIMIT 1`, [req.uid, site.id, rec.post_id, rec.country]);
  const { rows } = await pool.query(
    `INSERT INTO records (user_id, site_id, post_id, country, cpr, cpm, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, site_id, post_id, country, cpr, cpm, note, created_at`,
    [req.uid, site.id, rec.post_id, rec.country, rec.cpr, rec.cpm, rec.note]);
  res.status(201).json({ record: rows[0], previous: prev.rows[0] || null });
}));

app.delete('/api/records/:id', auth, wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM records WHERE id=$1 AND user_id=$2', [intId(req.params.id), req.uid]);
  if (!rowCount) throw new HttpError(404, 'Registro não encontrado.');
  res.json({ ok: true });
}));

app.get('/api/records/export.csv', auth, wrap(async (req, res) => {
  const params = [req.uid];
  const where = recordFilters(req.query, params);
  const { rows } = await pool.query(`${BASE} SELECT * FROM base ${where} ORDER BY created_at DESC, id DESC LIMIT 20000`, params);
  const TEXT_COLS = new Set([1, 2, 11]); // site, post_id, observação: texto livre do usuário
  const cell = (v, i) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (TEXT_COLS.has(i) && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita fórmula em planilha
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const pct = (a, b) => (b ? (((a - b) / b) * 100).toFixed(2) : '');
  const lines = [['data', 'site', 'post_id', 'pais', 'moeda', 'cpr', 'cpr_anterior', 'cpr_var_pct', 'cpm', 'cpm_anterior', 'cpm_var_pct', 'observacao'].join(',')];
  for (const r of rows) {
    lines.push([
      r.created_at.toISOString(), r.site_name, r.post_id, r.country, r.currency,
      r.cpr, r.prev_cpr, pct(r.cpr, r.prev_cpr), r.cpm, r.prev_cpm, pct(r.cpm, r.prev_cpm), r.note,
    ].map(cell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mbz-pulse-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
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
  .then(() => app.listen(PORT, () => console.log(`[PULSE] online na porta ${PORT}`)))
  .catch((e) => { console.error('[PULSE] falha ao preparar o banco:', e); process.exit(1); });
