(() => {
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FLAT = 2; // variação até ±2% conta como estável
const PAGE = 50;
const SYMBOL = { USD: '$', BRL: 'R$', EUR: '€' };
// Todos os códigos ISO 3166-1 alpha-2; os nomes vêm do próprio navegador, em português.
const ISO = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
  + 'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP '
  + 'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT '
  + 'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
  + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ '
  + 'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');
const regionName = (() => {
  try { const dn = new Intl.DisplayNames(['pt-BR'], { type: 'region' }); return (c) => dn.of(c) || c; }
  catch { return (c) => c; }
})();
const plain = (v) => String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
const COUNTRIES = ISO.map((code) => ({ code, name: regionName(code) })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
const BY_NAME = new Map(COUNTRIES.map((c) => [plain(c.name), c.code]));
// Quem digitar o nome inteiro ("Turquia") tem o campo trocado pelo código ("TR").
function normCountry(input) {
  const code = BY_NAME.get(plain(input.value));
  if (code && plain(input.value).length > 2) input.value = code;
}

const state = { user: null, sites: [], records: [], total: 0, mode: 'latest', last: null, lastKey: '', seq: 0 };

/* ---------- utilidades ---------- */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 401 && state.user) { state.user = null; showAuth(); }
  if (!res.ok) throw new Error(data.error || 'Falha de conexão.');
  return data;
}

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 4200);
}

const parseNum = (v) => {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
};
const fmt = (n) => (n === null || n === undefined ? '—'
  : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
const money = (n, cur) => (n === null || n === undefined ? '—' : `${SYMBOL[cur] || ''} ${fmt(n)}`);
const flag = (cc) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `há ${Math.floor(s / 86400)} d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}
const when = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// CPR é custo: cair é bom. eCPM é receita: subir é bom (up = true).
function delta(cur, prev, up) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return { cls: 'none', text: '—', pct: null };
  if (prev === 0) return cur === 0 ? { cls: 'flat', text: '■ 0,0%', pct: 0 } : { cls: up ? 'good' : 'bad', text: '▲ saiu do zero', pct: Infinity };
  const pct = ((cur - prev) / prev) * 100;
  const gain = up ? pct : -pct; // positivo = melhorou
  const cls = gain > FLAT ? 'good' : gain < -FLAT ? 'bad' : 'flat';
  const arrow = pct < -0.05 ? '▼' : pct > 0.05 ? '▲' : '■';
  return { cls, pct, text: `${arrow} ${Math.abs(pct).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` };
}

const siteById = (id) => state.sites.find((s) => s.id === Number(id));

/* ---------- auth ---------- */

let authMode = 'login';
let inviteRequired = false;

function showAuth() {
  $('#app').hidden = true;
  $('#auth').hidden = false;
}
function setAuthMode(mode) {
  authMode = mode;
  $$('[data-auth]').forEach((b) => b.classList.toggle('on', b.dataset.auth === mode));
  $('.only-register').hidden = mode !== 'register';
  $('.only-invite').hidden = !(mode === 'register' && inviteRequired);
  $('#authBtn').textContent = mode === 'login' ? 'ACESSAR TERMINAL' : 'CRIAR CONTA';
  $('#authForm [name=password]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authErr').textContent = '';
}
$$('[data-auth]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('#authBtn');
  btn.disabled = true;
  try {
    const body = { email: f.email.value, password: f.password.value };
    if (authMode === 'register') { body.name = f.name.value; body.invite = f.invite.value; }
    const { user } = await api('/auth/' + authMode, { method: 'POST', body });
    f.reset();
    await enter(user);
  } catch (err) {
    $('#authErr').textContent = err.message;
  } finally { btn.disabled = false; }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  showAuth();
});

async function enter(user) {
  state.user = user;
  $('#userName').textContent = user.name;
  $('#auth').hidden = true;
  $('#app').hidden = false;
  await loadSites();
  await loadRecords(true);
  renderCompare();
}

/* ---------- sites ---------- */

async function loadSites() {
  const { sites } = await api('/sites');
  state.sites = sites;
  renderSites();
}

function renderSites() {
  const formSel = $('#recForm [name=site_id]');
  const keepForm = formSel.value;
  const keepFilter = $('#fSite').value;
  const opts = state.sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  formSel.innerHTML = opts || '<option value="">— cadastre um site —</option>';
  $('#fSite').innerHTML = '<option value="">todos os sites</option>' + opts;
  if (siteById(keepForm)) formSel.value = keepForm;
  if (siteById(keepFilter)) $('#fSite').value = keepFilter;

  const current = Number(formSel.value);
  $('#siteList').innerHTML = state.sites.length ? state.sites.map((s) => `
    <li data-id="${s.id}" class="${s.id === current ? 'on' : ''}">
      <div class="nm"><b>${esc(s.name)}</b>
        <span>${s.currency} · ${s.campaigns} camp. · ${s.records} leit.${s.last_at ? ' · ' + ago(s.last_at) : ''}</span></div>
      <button class="icon" data-act="edit" title="Editar">✎</button>
      <button class="icon del" data-act="del" title="Excluir">✕</button>
    </li>`).join('') : '<li class="empty">Nenhum site ainda. Cadastre o primeiro aqui embaixo ↓</li>';
  updateCurrencyHints();
}

function updateCurrencyHints() {
  const s = siteById($('#recForm [name=site_id]').value);
  const sym = s ? `em ${s.currency}` : '';
  $('#curCpr').textContent = sym;
  $('#curCpm').textContent = sym;
}

$('#siteList').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const s = siteById(li.dataset.id);
  const act = e.target.dataset.act;
  if (act === 'edit') {
    const f = $('#siteForm');
    f.id.value = s.id; f.name.value = s.name; f.url.value = s.url; f.currency.value = s.currency;
    $('#siteBtn').textContent = 'SALVAR';
    $('#siteCancel').hidden = false;
    f.name.focus();
  } else if (act === 'del') {
    if (!confirm(`Excluir "${s.name}" e TODO o histórico dele (${s.records} leituras)? Não dá para desfazer.`)) return;
    try {
      await api('/sites/' + s.id, { method: 'DELETE' });
      resetSiteForm();
      await loadSites();
      await loadRecords(true);
      refreshLast(true);
      toast(`Site "${s.name}" excluído.`);
    } catch (err) { toast(err.message, true); }
  } else {
    $('#recForm [name=site_id]').value = s.id;
    renderSites();
    refreshLast(true);
    $('#recForm [name=post_id]').focus();
  }
});

function resetSiteForm() {
  const f = $('#siteForm');
  f.reset(); f.id.value = '';
  $('#siteBtn').textContent = '+ ADICIONAR';
  $('#siteCancel').hidden = true;
  $('#siteErr').textContent = '';
}
$('#siteCancel').addEventListener('click', resetSiteForm);

$('#siteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, url: f.url.value, currency: f.currency.value };
  try {
    const editing = f.id.value;
    const { site } = await api(editing ? '/sites/' + editing : '/sites', { method: editing ? 'PATCH' : 'POST', body });
    resetSiteForm();
    await loadSites();
    if (!editing) { $('#recForm [name=site_id]').value = site.id; renderSites(); refreshLast(true); }
    else { await loadRecords(true); }
    toast(editing ? 'Site atualizado.' : `Site "${site.name}" cadastrado.`);
  } catch (err) { $('#siteErr').textContent = err.message; }
});

/* ---------- comparação ao vivo ---------- */

const rf = $('#recForm');
const keyOf = () => ({
  site_id: rf.site_id.value,
  post_id: rf.post_id.value.trim(),
  country: rf.country.value.trim().toUpperCase(),
});

let lastTimer;
function refreshLast(now) {
  clearTimeout(lastTimer);
  lastTimer = setTimeout(fetchLast, now ? 0 : 220);
}

async function fetchLast() {
  const k = keyOf();
  const key = `${k.site_id}|${k.post_id}|${k.country}`;
  if (!k.site_id || !/^[A-Z]{2}$/.test(k.country)) {
    state.last = null; state.lastKey = ''; state.seq++;
    return renderCompare();
  }
  const seq = ++state.seq;
  try {
    const data = await api(`/records/last?site_id=${k.site_id}&post_id=${encodeURIComponent(k.post_id)}&country=${k.country}${state.editing ? '&exclude_id=' + state.editing : ''}`);
    if (seq !== state.seq) return; // chegou resposta antiga
    state.last = data; state.lastKey = key;
  } catch { if (seq === state.seq) state.last = null; }
  renderCompare();
}

function sparkline(series, field, curVal) {
  const pts = series.map((p) => p[field]);
  if (curVal !== null) pts.push(curVal);
  if (pts.length < 2) return '';
  const W = 300, H = 64, pad = 8;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const x = (i) => pad + (i * (W - pad * 2)) / (pts.length - 1);
  const y = (v) => H - pad - ((v - min) / span) * (H - pad * 2);
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const li = pts.length - 1;
  const color = curVal !== null ? 'var(--warn)' : 'var(--cyan)';
  return `<div class="spark"><div class="lbl"><span>${field === 'cpm' ? 'eCPM' : 'CPR'} · ${series.length} leitura${series.length === 1 ? '' : 's'}${curVal !== null ? ' + agora' : ''}</span><span>mín ${fmt(min)} · máx ${fmt(max)}</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${path}" fill="none" stroke="var(--cyan)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      <circle cx="${x(li).toFixed(1)}" cy="${y(pts[li]).toFixed(1)}" r="3" fill="${color}"/>
    </svg></div>`;
}

function renderCompare() {
  const box = $('#cmpBody');
  const k = keyOf();
  const site = siteById(k.site_id);
  if (!state.sites.length) {
    box.innerHTML = '<div class="verdict">SEM SITES<small>Cadastre um site no painel 01 para começar.</small></div>';
    return;
  }
  if (!site || !/^[A-Z]{2}$/.test(k.country) || !k.post_id) {
    box.innerHTML = '<div class="verdict">AGUARDANDO<small>Preencha site, país e post id — o último registro aparece aqui na hora.</small></div>';
    return;
  }
  const data = state.last || {};
  const ref = data.exact; // só compara o ID com ele mesmo
  const cpr = parseNum(rf.cpr.value);
  const cpm = parseNum(rf.cpm.value);
  const cur = site.currency;
  const keyLine = `<div class="cmp-key"><b>${esc(site.name)}</b> · ${flag(k.country)} <b>${esc(k.country)}</b> · post <b>${esc(k.post_id)}</b></div>`;

  if (!ref) {
    box.innerHTML = keyLine + `<div class="verdict flat">PRIMEIRA LEITURA<small>Este ID ainda não tem leitura em ${esc(k.country)} neste site. Esta leitura vira a base de comparação dele.</small></div>
      <div class="metrics">
        <div class="metric"><div class="lbl">CPR</div><div class="now">${money(cpr, cur)}</div></div>
        <div class="metric"><div class="lbl">eCPM</div><div class="now">${money(cpm, cur)}</div></div>
      </div>`;
    return;
  }

  const dCpr = delta(cpr, ref.cpr);
  const dCpm = delta(cpm, ref.cpm, true);
  let v = { cls: '', text: 'DIGITE CPR E eCPM' };
  if (cpr !== null || cpm !== null) {
    const a = cpr !== null ? dCpr.cls : null;
    const b = cpm !== null ? dCpm.cls : null;
    const set = [a, b].filter(Boolean);
    if (set.includes('good') && set.includes('bad')) v = { cls: 'mixed', text: 'MISTO' };
    else if (set.includes('bad')) v = { cls: 'bad', text: 'PIOROU' };
    else if (set.includes('good')) v = { cls: 'good', text: 'MELHOROU' };
    else v = { cls: 'flat', text: 'ESTÁVEL' };
  }
  const refNote = `vs. último registro deste post · ${ago(ref.created_at)} (${when(ref.created_at)})`;
  const metric = (lbl, now, was, d) => `
    <div class="metric"><div class="lbl">${lbl}</div>
      <div class="now">${money(now, cur)}</div>
      <div class="was">antes: ${money(was, cur)}</div>
      <div class="delta ${d.cls}">${d.text}${now !== null && d.pct !== null && Number.isFinite(d.pct) ? ` <span class="dim">(${now - was >= 0 ? '+' : '−'}${fmt(Math.abs(now - was))})</span>` : ''}</div>
    </div>`;

  box.innerHTML = keyLine +
    `<div class="verdict ${v.cls}">${v.text}<small>${refNote}</small></div>
     <div class="metrics">${metric('CPR', cpr, ref.cpr, dCpr)}${metric('eCPM', cpm, ref.cpm, dCpm)}</div>` +
    (ref.note ? `<div class="cmp-key" style="margin-top:12px">obs. anterior: <b>${esc(ref.note)}</b></div>` : '') +
    sparkline(data.series, 'cpr', cpr) + sparkline(data.series, 'cpm', cpm);
}

rf.site_id.addEventListener('change', () => { renderSites(); refreshLast(true); });
rf.post_id.addEventListener('input', () => refreshLast());
rf.country.addEventListener('input', () => { normCountry(rf.country); refreshLast(); });
rf.cpr.addEventListener('input', renderCompare);
rf.cpm.addEventListener('input', renderCompare);

rf.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#recErr');
  err.textContent = '';
  const k = keyOf();
  if (!k.site_id) { err.textContent = 'Cadastre um site primeiro.'; return; }
  if (parseNum(rf.cpr.value) === null || parseNum(rf.cpm.value) === null) { err.textContent = 'CPR e eCPM precisam ser números (ex.: 0,35).'; return; }
  const btn = $('#recBtn');
  btn.disabled = true;
  try {
    const editing = state.editing;
    const tag = editing ? 'CORRIGIDO' : 'GRAVADO';
    const { record, previous } = await api(editing ? '/records/' + editing : '/records', {
      method: editing ? 'PATCH' : 'POST',
      body: { ...k, cpr: rf.cpr.value, cpm: rf.cpm.value, note: rf.note.value },
    });
    const d = previous ? delta(record.cpr, previous.cpr) : null;
    toast(d ? `${tag} · CPR ${d.text} · eCPM ${delta(record.cpm, previous.cpm, true).text}` : `${tag} · primeira leitura desta campanha`);
    if (editing) setEditing(null);
    rf.cpr.value = ''; rf.cpm.value = ''; rf.note.value = '';
    await Promise.all([loadSites(), loadRecords(true, record.id)]);
    await fetchLast();
    rf.cpr.focus();
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; }
});

/* ---------- correção de leitura ---------- */

function setEditing(r) {
  state.editing = r ? r.id : null;
  $('#recBtn').innerHTML = r ? 'SALVAR CORREÇÃO <kbd>ENTER</kbd>' : 'GRAVAR LEITURA <kbd>ENTER</kbd>';
  $('#recCancel').hidden = !r;
  $('#editNote').hidden = !r;
  $('#editNote').textContent = r ? `Corrigindo a leitura de ${when(r.created_at)}. A data e a hora originais são mantidas.` : '';
  $('.entry').classList.toggle('editing', !!r);
  $('.entry h2').innerHTML = r ? '<b>02</b> CORRIGIR LEITURA' : '<b>02</b> NOVA LEITURA';
}
function cancelEdit() {
  setEditing(null);
  rf.cpr.value = ''; rf.cpm.value = ''; rf.note.value = '';
  $('#recErr').textContent = '';
  refreshLast(true);
}
$('#recCancel').addEventListener('click', cancelEdit);

/* ---------- histórico ---------- */

function filterQuery() {
  const q = new URLSearchParams();
  if ($('#fSite').value) q.set('site_id', $('#fSite').value);
  const c = $('#fCountry').value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c)) q.set('country', c);
  if ($('#fPost').value.trim()) q.set('post_id', $('#fPost').value.trim());
  if (state.mode === 'latest') q.set('latest', '1');
  return q;
}

async function loadRecords(reset, flashId) {
  const q = filterQuery();
  q.set('limit', PAGE);
  q.set('offset', reset ? 0 : state.records.length);
  try {
    const { records, total } = await api('/records?' + q);
    state.records = reset ? records : state.records.concat(records);
    state.total = total;
    renderRecords(flashId);
  } catch (err) { toast(err.message, true); }
}

function renderRecords(flashId) {
  const dcell = (cur, prev, up) => {
    const d = delta(cur, prev, up);
    return `<td class="dl ${d.cls}">${d.text}${prev !== null ? `<small>antes ${fmt(prev)}</small>` : '<small>1ª leitura</small>'}</td>`;
  };
  $('#rows').innerHTML = state.records.length ? state.records.map((r) => `
    <tr data-id="${r.id}" class="${r.id === String(flashId) || r.id === flashId ? 'flash' : ''}" title="Clique para lançar nova leitura desta campanha">
      <td title="${esc(new Date(r.created_at).toLocaleString('pt-BR'))}">${when(r.created_at)} <span class="dim">· ${ago(r.created_at)}</span></td>
      <td>${esc(r.site_name)}</td>
      <td class="pid">${esc(r.post_id)}${state.mode === 'latest' && r.readings > 1 ? `<span class="tag">${r.readings}×</span>` : ''}</td>
      <td>${flag(r.country)} ${esc(r.country)}</td>
      <td class="num">${money(r.cpr, r.currency)}</td>${dcell(r.cpr, r.prev_cpr)}
      <td class="num">${money(r.cpm, r.currency)}</td>${dcell(r.cpm, r.prev_cpm, true)}
      <td class="obs" title="${esc(r.note)}">${esc(r.note)}</td>
      <td><button class="icon" data-act="edit" title="Corrigir esta leitura">✎</button><button class="icon del" data-act="del" title="Apagar esta leitura">✕</button></td>
    </tr>`).join('')
    : `<tr><td colspan="10" class="empty">Nenhuma leitura ${filterQuery().toString().replace('latest=1', '') ? 'com esses filtros' : 'ainda — grave a primeira no painel 02'}.</td></tr>`;
  $('#histCount').textContent = state.total ? `${state.records.length} de ${state.total}` : '';
  $('#more').hidden = state.records.length >= state.total;

  const posts = [...new Set(state.records.map((r) => r.post_id))].slice(0, 100);
  $('#knownPosts').innerHTML = posts.map((p) => `<option value="${esc(p)}">`).join('');
}

$('#rows').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const r = state.records.find((x) => String(x.id) === tr.dataset.id);
  if (!r) return;
  if (e.target.dataset.act === 'del') {
    if (!confirm(`Apagar a leitura de ${when(r.created_at)} (post ${r.post_id}, ${r.country})?`)) return;
    try {
      await api('/records/' + r.id, { method: 'DELETE' });
      if (state.editing === r.id) cancelEdit();
      await Promise.all([loadSites(), loadRecords(true)]);
      refreshLast(true);
      toast('Leitura apagada.');
    } catch (err) { toast(err.message, true); }
    return;
  }
  const edit = e.target.dataset.act === 'edit';
  setEditing(edit ? r : null);
  rf.cpr.value = edit ? String(r.cpr).replace('.', ',') : '';
  rf.cpm.value = edit ? String(r.cpm).replace('.', ',') : '';
  rf.note.value = edit ? r.note : '';
  rf.site_id.value = r.site_id;
  rf.post_id.value = r.post_id;
  rf.country.value = r.country;
  renderSites();
  refreshLast(true);
  rf.cpr.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$$('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  $$('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  loadRecords(true);
}));

let fTimer;
const refilter = () => { clearTimeout(fTimer); fTimer = setTimeout(() => loadRecords(true), 250); };
$('#fSite').addEventListener('change', refilter);
$('#fCountry').addEventListener('input', () => { normCountry($('#fCountry')); refilter(); });
$('#fPost').addEventListener('input', refilter);
$('#fClear').addEventListener('click', () => { $('#fSite').value = ''; $('#fCountry').value = ''; $('#fPost').value = ''; loadRecords(true); });
$('#more').addEventListener('click', () => loadRecords(false));
$('#xlsx').addEventListener('click', () => {
  const q = filterQuery(); q.delete('latest'); q.set('tzo', new Date().getTimezoneOffset());
  window.location.href = '/api/records/export.xlsx?' + q;
});
$('#csv').addEventListener('click', () => { window.location.href = '/api/records/export.csv?' + filterQuery(); });

/* ---------- boot ---------- */

$('#countries').innerHTML = COUNTRIES.map((c) => `<option value="${c.code}">${esc(c.name)}</option>`).join('');

(async () => {
  try { inviteRequired = (await api('/config')).invite_required; } catch { /* segue */ }
  setAuthMode('login');
  try {
    const { user } = await api('/me');
    await enter(user);
  } catch { showAuth(); }
})();
})();
