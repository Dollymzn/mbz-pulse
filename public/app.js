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

const ACTION_LABEL = { escalei: '▲ ESCALEI', reduzi: '▼ REDUZI', mantive: '■ MANTIVE' };
const state = { user: null, sites: [], users: [], records: [], total: 0, mode: 'latest', last: null, lastKey: '', seq: 0, editing: null };
let config = { companies: [], actions: [] };
const isMaster = () => !!(state.user && state.user.is_master);

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
  $$('.only-register').forEach((el) => { el.hidden = mode !== 'register'; });
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
    if (authMode === 'register') { body.name = f.name.value; body.invite = f.invite.value; body.company = f.company.value; }
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
  setAuthMode('login');
  showAuth();
});

async function enter(user) {
  state.user = user;
  $('#userName').textContent = user.company ? `${user.name} · ${user.company}` : user.name;
  $('#masterBadge').hidden = !user.is_master;
  $$('.master-only').forEach((el) => { el.hidden = !user.is_master; });
  $('#companyForm').hidden = !!user.company;
  $('#auth').hidden = true;
  $('#app').hidden = false;
  if (user.is_master) await loadUsers();
  await loadSites();
  await loadRecords(true);
  renderCompare();
}

$('#companyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('/me', { method: 'PATCH', body: { company: $('#meCompany').value } });
    state.user = user;
    $('#userName').textContent = `${user.name} · ${user.company}`;
    $('#companyForm').hidden = true;
    toast(`Empresa definida: ${user.company}.`);
  } catch (err) { $('#companyErr').textContent = err.message; }
});

async function loadUsers() {
  const { users } = await api('/users');
  state.users = users;
  const keepC = $('#fCompany').value, keepO = $('#fOwner').value;
  $('#fCompany').innerHTML = '<option value="">todas as empresas</option>' + config.companies.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('#fOwner').innerHTML = '<option value="">todos os gestores</option>' + users.map((u) => `<option value="${u.id}">${esc(u.name)}${u.company ? ' · ' + esc(u.company) : ''}</option>`).join('');
  $('#fCompany').value = keepC; $('#fOwner').value = keepO;
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
  const opt = (s) => `<option value="${s.id}">${esc(s.name)}${isMaster() && s.owner_id !== state.user.id ? ' · ' + esc(s.owner_name) : ''}</option>`;
  let opts = state.sites.map(opt).join('');
  if (isMaster()) { // agrupa por gestor
    const groups = new Map();
    state.sites.forEach((s) => { const k = `${s.owner_name}${s.company ? ' · ' + s.company : ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    opts = [...groups].map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>`).join('');
  }
  formSel.innerHTML = opts || '<option value="">— cadastre um site —</option>';
  $('#fSite').innerHTML = '<option value="">todos os sites</option>' + opts;
  if (siteById(keepForm)) formSel.value = keepForm;
  if (siteById(keepFilter)) $('#fSite').value = keepFilter;

  const current = Number(formSel.value);
  $('#siteList').innerHTML = state.sites.length ? state.sites.map((s) => `
    <li data-id="${s.id}" class="${s.id === current ? 'on' : ''}">
      <div class="nm"><b>${esc(s.name)}</b>
        <span>${isMaster() && s.owner_id !== state.user.id ? `<i>${esc(s.owner_name)}</i> · ` : ''}${s.currency} · ${s.campaigns} camp. · ${s.records} leit.${s.last_at ? ' · ' + ago(s.last_at) : ''}</span></div>
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
  lang: rf.lang.value.trim().toLowerCase(),
});
const geo = (country, lang) => `${flag(country)} ${esc(country)}${lang ? ` <span class="lang">· ${esc(lang)}</span>` : ''}`;

let lastTimer;
function refreshLast(now) {
  clearTimeout(lastTimer);
  lastTimer = setTimeout(fetchLast, now ? 0 : 220);
}

async function fetchLast() {
  const k = keyOf();
  const key = `${k.site_id}|${k.post_id}|${k.country}|${k.lang}`;
  if (!k.site_id || !/^[A-Z]{2}$/.test(k.country)) {
    state.last = null; state.lastKey = ''; state.seq++;
    return renderCompare();
  }
  const seq = ++state.seq;
  try {
    const data = await api(`/records/last?site_id=${k.site_id}&post_id=${encodeURIComponent(k.post_id)}&country=${k.country}&lang=${encodeURIComponent(k.lang)}${state.editing ? '&exclude_id=' + state.editing : ''}`);
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
  const keyLine = `<div class="cmp-key"><b>${esc(site.name)}</b> · ${flag(k.country)} <b>${esc(k.country)}</b>${k.lang ? ` · idioma <b>${esc(k.lang)}</b>` : ''} · post <b>${esc(k.post_id)}</b></div>`;

  if (!ref) {
    box.innerHTML = keyLine + `<div class="verdict flat">PRIMEIRA LEITURA<small>Este ID ainda não tem leitura em ${esc(k.country)}${k.lang ? ' / ' + esc(k.lang) : ''} neste site. Esta leitura vira a base de comparação dele.</small></div>
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
    (ref.action || ref.note ? `<div class="cmp-key" style="margin-top:12px">${ref.action ? `ação anterior: <b>${ACTION_LABEL[ref.action]}</b>` : ''}${ref.action && ref.note ? ' · ' : ''}${ref.note ? `obs. anterior: <b>${esc(ref.note)}</b>` : ''}</div>` : '') +
    sparkline(data.series, 'cpr', cpr) + sparkline(data.series, 'cpm', cpm);
}

rf.site_id.addEventListener('change', () => { renderSites(); refreshLast(true); });
rf.post_id.addEventListener('input', () => refreshLast());
rf.country.addEventListener('input', () => { normCountry(rf.country); refreshLast(); });
rf.lang.addEventListener('input', () => refreshLast());
rf.cpr.addEventListener('input', renderCompare);
function setAction(a) {
  rf.action.value = a || '';
  $$('#actions .act').forEach((b) => b.classList.toggle('on', b.dataset.action === a));
}
$('#actions').addEventListener('click', (e) => {
  const b = e.target.closest('.act');
  if (!b) return;
  setAction(rf.action.value === b.dataset.action ? '' : b.dataset.action); // clica de novo para desmarcar
});
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
      body: { ...k, cpr: rf.cpr.value, cpm: rf.cpm.value, note: rf.note.value, action: rf.action.value },
    });
    const d = previous ? delta(record.cpr, previous.cpr) : null;
    toast(d ? `${tag} · CPR ${d.text} · eCPM ${delta(record.cpm, previous.cpm, true).text}` : `${tag} · primeira leitura desta campanha`);
    if (editing) setEditing(null);
    rf.cpr.value = ''; rf.cpm.value = ''; rf.note.value = ''; setAction('');
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
  rf.cpr.value = ''; rf.cpm.value = ''; rf.note.value = ''; setAction('');
  $('#recErr').textContent = '';
  refreshLast(true);
}
$('#recCancel').addEventListener('click', cancelEdit);

/* ---------- histórico ---------- */

// Limites do período escolhido, no fuso do navegador, em ISO (o servidor compara em UTC).
function periodRange() {
  const p = $('#fPeriod').value;
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = day(new Date());
  const plus = (d, n) => new Date(d.getTime() + n * 86400e3);
  if (p === 'today') return [today, plus(today, 1)];
  if (p === 'yesterday') return [plus(today, -1), today];
  if (p === '7d') return [plus(today, -6), plus(today, 1)];
  if (p === '30d') return [plus(today, -29), plus(today, 1)];
  if (p === 'month') return [new Date(today.getFullYear(), today.getMonth(), 1), plus(today, 1)];
  if (p === 'custom') {
    const f = $('#fFrom').value ? new Date($('#fFrom').value + 'T00:00:00') : null;
    const t = $('#fTo').value ? plus(new Date($('#fTo').value + 'T00:00:00'), 1) : null;
    return [f, t];
  }
  return [null, null];
}

function filterQuery() {
  const q = new URLSearchParams();
  const [from, to] = periodRange();
  if (from) q.set('from', from.toISOString());
  if (to) q.set('to', to.toISOString());
  const lg = $('#fLang').value.trim().toLowerCase();
  if (lg) q.set('lang', lg);
  if ($('#fSite').value) q.set('site_id', $('#fSite').value);
  const c = $('#fCountry').value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c)) q.set('country', c);
  if ($('#fPost').value.trim()) q.set('post_id', $('#fPost').value.trim());
  if ($('#fAction').value) q.set('action', $('#fAction').value);
  if (isMaster() && $('#fCompany').value) q.set('company', $('#fCompany').value);
  if (isMaster() && $('#fOwner').value) q.set('owner_id', $('#fOwner').value);
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
      ${isMaster() ? `<td class="dim" title="gravado por ${esc(r.added_by)}">${esc(r.owner_name)}</td>` : ''}
      <td class="pid">${esc(r.post_id)}${state.mode === 'latest' && r.readings > 1 ? `<span class="tag">${r.readings}×</span>` : ''}</td>
      <td>${geo(r.country, r.lang)}</td>
      <td class="num">${money(r.cpr, r.currency)}</td>${dcell(r.cpr, r.prev_cpr)}
      <td class="num">${money(r.cpm, r.currency)}</td>${dcell(r.cpm, r.prev_cpm, true)}
      <td>${r.action ? `<span class="atag ${esc(r.action)}">${ACTION_LABEL[r.action]}</span>` : ''}</td>
      <td class="obs" title="${esc(r.note)}">${esc(r.note)}</td>
      <td><button class="icon" data-act="edit" title="Corrigir esta leitura">✎</button><button class="icon del" data-act="del" title="Apagar esta leitura">✕</button></td>
    </tr>`).join('')
    : `<tr><td colspan="12" class="empty">Nenhuma leitura ${filterQuery().toString().replace('latest=1', '') ? 'com esses filtros' : 'ainda — grave a primeira no painel 02'}.</td></tr>`;
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
  setAction(edit ? r.action : '');
  rf.site_id.value = r.site_id;
  rf.post_id.value = r.post_id;
  rf.country.value = r.country;
  rf.lang.value = r.lang || '';
  showTab('new');
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
$('#fAction').addEventListener('change', refilter);
$('#fLang').addEventListener('input', refilter);
$('#fPeriod').addEventListener('change', () => {
  const custom = $('#fPeriod').value === 'custom';
  $$('.custom-date').forEach((el) => { el.hidden = !custom; });
  if (!custom) refilter();
});
$('#fFrom').addEventListener('change', refilter);
$('#fTo').addEventListener('change', refilter);
$('#fCompany').addEventListener('change', refilter);
$('#fOwner').addEventListener('change', refilter);
$('#fClear').addEventListener('click', () => {
  ['#fSite', '#fCountry', '#fLang', '#fPost', '#fAction', '#fCompany', '#fOwner', '#fPeriod', '#fFrom', '#fTo'].forEach((id) => { $(id).value = ''; });
  $$('.custom-date').forEach((el) => { el.hidden = true; });
  loadRecords(true);
});
$('#more').addEventListener('click', () => loadRecords(false));
$('#xlsx').addEventListener('click', () => {
  const q = filterQuery(); q.delete('latest'); q.set('tzo', new Date().getTimezoneOffset());
  window.location.href = '/api/records/export.xlsx?' + q;
});
$('#csv').addEventListener('click', () => { window.location.href = '/api/records/export.csv?' + filterQuery(); });

/* ---------- abas do painel 02 ---------- */

function showTab(tab) {
  $$('#entryTabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('[data-tab-pane]').forEach((el) => { el.hidden = el.dataset.tabPane !== tab; });
  if (tab !== 'new' && state.editing) cancelEdit();
  if (tab === 'update') loadCampaigns();
}
$$('#entryTabs .tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- ATUALIZAÇÃO: IDs cadastrados por site ---------- */

const upd = { site: null, campaigns: [], current: null };

function fillUpdSites() {
  const sel = $('#updSite');
  const keep = sel.value;
  sel.innerHTML = $('#recForm [name=site_id]').innerHTML;
  if (siteById(keep)) sel.value = keep;
}

async function loadCampaigns() {
  fillUpdSites();
  const id = $('#updSite').value;
  if (!id) { $('#updList').innerHTML = '<li class="empty">Cadastre um site no painel 01.</li>'; return; }
  try {
    const data = await api(`/sites/${id}/campaigns`);
    upd.site = data.site; upd.campaigns = data.campaigns;
    renderCampaigns();
  } catch (err) { toast(err.message, true); }
}

function renderCampaigns() {
  const q = plain($('#updSearch').value);
  const list = upd.campaigns.filter((c) => !q || plain(`${c.post_id} ${c.country} ${c.lang}`).includes(q));
  const cur = upd.site ? upd.site.currency : 'USD';
  $('#updList').innerHTML = list.length ? list.map((c, i) => {
    const d1 = delta(c.cpr, c.prev_cpr), d2 = delta(c.cpm, c.prev_cpm, true);
    return `<li data-i="${upd.campaigns.indexOf(c)}">
      <div class="k">${esc(c.post_id)}<span>${geo(c.country, c.lang)}</span></div>
      <div class="v">${money(c.cpr, cur)} <span class="dim">·</span> ${money(c.cpm, cur)}</div>
      <div class="m">${ago(c.created_at)} · ${c.readings} leit. · CPR <span class="${d1.cls}">${d1.text}</span> · eCPM <span class="${d2.cls}">${d2.text}</span>${c.action ? ` · ${ACTION_LABEL[c.action]}` : ''}</div>
    </li>`;
  }).join('') : `<li class="empty">${upd.campaigns.length ? 'Nenhum ID bate com a busca.' : 'Este site ainda não tem IDs. Grave a primeira leitura na aba NOVA.'}</li>`;
}
$('#updSite').addEventListener('change', loadCampaigns);
$('#updSearch').addEventListener('input', renderCampaigns);
$('#updList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) openModal(upd.campaigns[Number(li.dataset.i)]);
});

/* ---------- modal: histórico de hoje + atualizar ---------- */

const mf = $('#mForm');
function mSetAction(a) {
  mf.action.value = a || '';
  $$('#mActions .act').forEach((b) => b.classList.toggle('on', b.dataset.action === a));
}
$('#mActions').addEventListener('click', (e) => {
  const b = e.target.closest('.act');
  if (b) mSetAction(mf.action.value === b.dataset.action ? '' : b.dataset.action);
});

async function openModal(c) {
  upd.current = { ...c, site_id: upd.site.id, currency: upd.site.currency, site_name: upd.site.name };
  $('#mTitle').innerHTML = `${esc(c.post_id)} <span class="dim">·</span> ${geo(c.country, c.lang)} <span class="dim">· ${esc(upd.site.name)}</span>`;
  $('#mCur').textContent = `em ${upd.site.currency}`;
  mf.reset(); mSetAction(''); $('#mErr').textContent = '';
  $('#modal').hidden = false;
  await loadModalHistory();
  mf.cpr.focus();
}

async function loadModalHistory() {
  const c = upd.current;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const q = new URLSearchParams({ site_id: c.site_id, post_id: c.post_id, exact: '1', country: c.country, lang: c.lang || '', limit: 50 });
  const [today, all] = await Promise.all([
    api(`/records?${q}&from=${start.toISOString()}`),
    api(`/records/last?site_id=${c.site_id}&post_id=${encodeURIComponent(c.post_id)}&country=${c.country}&lang=${encodeURIComponent(c.lang || '')}`),
  ]);
  upd.ref = all.exact; // última leitura (hoje ou antes) — base da comparação
  const rows = today.records;
  const cur = c.currency;
  const dcell = (v, p, up) => { const d = delta(v, p, up); return `<td class="dl ${d.cls}">${d.text}</td>`; };
  $('#mToday').innerHTML = `
    <div class="m-today"><div class="cap">HOJE · ${rows.length} leitura${rows.length === 1 ? '' : 's'}</div>
      ${rows.length ? `<table><thead><tr><th>HORA</th><th class="r">CPR</th><th class="r">Δ</th><th class="r">eCPM</th><th class="r">Δ</th><th>AÇÃO</th><th>POR</th><th>OBS</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${new Date(r.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</td>
          <td class="num">${money(r.cpr, cur)}</td>${dcell(r.cpr, r.prev_cpr)}<td class="num">${money(r.cpm, cur)}</td>${dcell(r.cpm, r.prev_cpm, true)}
          <td>${r.action ? `<span class="atag ${esc(r.action)}">${ACTION_LABEL[r.action]}</span>` : ''}</td><td class="dim">${esc(r.added_by)}</td><td class="obs" title="${esc(r.note)}">${esc(r.note)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">Nenhuma leitura hoje ainda.</div>'}
    </div>
    ${upd.ref ? `<p class="m-ref">base de comparação: <b>${money(upd.ref.cpr, cur)}</b> · <b>${money(upd.ref.cpm, cur)}</b> · ${ago(upd.ref.created_at)} (${when(upd.ref.created_at)})${upd.ref.action ? ` · ${ACTION_LABEL[upd.ref.action]}` : ''}</p>` : ''}`;
  renderModalCompare();
}

function renderModalCompare() {
  const ref = upd.ref;
  const box = $('#mCompare');
  if (!ref) { box.innerHTML = ''; return; }
  const cpr = parseNum(mf.cpr.value), cpm = parseNum(mf.cpm.value);
  const d1 = delta(cpr, ref.cpr), d2 = delta(cpm, ref.cpm, true);
  box.innerHTML = `<div><div class="lbl">Δ CPR</div><div class="delta ${d1.cls}">${d1.text}</div></div><div><div class="lbl">Δ eCPM</div><div class="delta ${d2.cls}">${d2.text}</div></div>`;
}
mf.cpr.addEventListener('input', renderModalCompare);
mf.cpm.addEventListener('input', renderModalCompare);

function closeModal() { $('#modal').hidden = true; upd.current = null; }
$('#mClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

mf.addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = upd.current;
  if (!c) return;
  if (parseNum(mf.cpr.value) === null || parseNum(mf.cpm.value) === null) { $('#mErr').textContent = 'CPR e eCPM precisam ser números.'; return; }
  $('#mBtn').disabled = true;
  try {
    const { record, previous } = await api('/records', { method: 'POST', body: {
      site_id: c.site_id, post_id: c.post_id, country: c.country, lang: c.lang || '',
      cpr: mf.cpr.value, cpm: mf.cpm.value, note: mf.note.value, action: mf.action.value } });
    const d = previous ? delta(record.cpr, previous.cpr) : null;
    toast(d ? `GRAVADO · CPR ${d.text} · eCPM ${delta(record.cpm, previous.cpm, true).text}` : 'GRAVADO · primeira leitura desta campanha');
    mf.cpr.value = ''; mf.cpm.value = ''; mf.note.value = ''; mSetAction('');
    await Promise.all([loadModalHistory(), loadCampaigns(), loadSites(), loadRecords(true, record.id)]);
    mf.cpr.focus();
  } catch (err) { $('#mErr').textContent = err.message; }
  finally { $('#mBtn').disabled = false; }
});

/* ---------- IMPORTAR planilha ---------- */

const imp = { rows: [] };
$('#impTemplate').addEventListener('click', () => { window.location.href = '/api/import/template.xlsx'; });
$('#impFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#impName').textContent = file.name;
  $('#impErr').textContent = '';
  $('#impPreview').hidden = true;
  try {
    const res = await fetch(`/api/import/parse?tzo=${new Date().getTimezoneOffset()}`, { method: 'POST', body: file, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falha ao ler o arquivo.');
    imp.rows = data.rows;
    $('#impSummary').innerHTML = `<b>${data.ok}</b> linha${data.ok === 1 ? '' : 's'} pronta${data.ok === 1 ? '' : 's'} para importar` +
      (data.errors ? ` · <span class="bad">${data.errors} com erro (serão ignoradas)</span>` : '') + (data.truncated ? ' · só as 5000 primeiras foram lidas' : '');
    $('#impRows').innerHTML = data.rows.map((r) => `<tr class="${r.error ? 'has-err' : ''}">
      <td class="dim">${r.n}</td><td>${esc(r.site)}</td><td class="pid">${esc(r.post_id)}</td><td>${esc(r.country)}</td><td>${esc(r.lang)}</td>
      <td class="num">${r.error ? esc(r.cpr) : money(r.cpr, r.currency)}</td><td class="num">${r.error ? esc(r.cpm) : money(r.cpm, r.currency)}</td>
      <td>${r.action ? ACTION_LABEL[r.action] || esc(r.action) : ''}</td><td class="dim">${r.at ? when(r.at) : 'agora'}</td>
      <td class="${r.error ? 'bad' : 'good'}">${r.error ? 'ERRO' : 'OK'}</td></tr>${r.error ? `<tr class="err-detail"><td></td><td colspan="9">↳ ${esc(r.error)}</td></tr>` : ''}`).join('');
    $('#impCommit').textContent = `IMPORTAR ${data.ok} LEITURA${data.ok === 1 ? '' : 'S'}`;
    $('#impCommit').disabled = !data.ok;
    $('#impPreview').hidden = false;
  } catch (err) { $('#impErr').textContent = err.message; }
  e.target.value = '';
});
$('#impCommit').addEventListener('click', async () => {
  const rows = imp.rows.filter((r) => !r.error);
  if (!rows.length) return;
  if (!confirm(`Importar ${rows.length} leitura${rows.length === 1 ? '' : 's'}? Elas entram no histórico como leituras novas.`)) return;
  $('#impCommit').disabled = true;
  try {
    const { imported } = await api('/import/commit', { method: 'POST', body: { rows } });
    toast(`${imported} leitura${imported === 1 ? '' : 's'} importada${imported === 1 ? '' : 's'}.`);
    imp.rows = []; $('#impPreview').hidden = true; $('#impName').textContent = '';
    await Promise.all([loadSites(), loadRecords(true)]);
  } catch (err) { $('#impErr').textContent = err.message; $('#impCommit').disabled = false; }
});

/* ---------- campos numéricos (CPR / eCPM) ---------- */
// Só dígitos e UM separador decimal. "." vira "," automaticamente; letras e símbolos são descartados.
function sanitizeNum(input) {
  const raw = input.value;
  let out = '', sep = false;
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if ((ch === ',' || ch === '.') && !sep) { out += ','; sep = true; }
  }
  if (out.startsWith(',')) out = '0' + out;
  if (out !== raw) {
    const pos = input.selectionStart - (raw.length - out.length);
    input.value = out;
    try { input.setSelectionRange(Math.max(0, pos), Math.max(0, pos)); } catch { /* tipo sem seleção */ }
  }
}
$$('.num-in').forEach((el) => {
  el.addEventListener('input', () => sanitizeNum(el));
  el.addEventListener('paste', () => setTimeout(() => { sanitizeNum(el); el.dispatchEvent(new Event('input')); }, 0));
  el.addEventListener('keydown', (e) => { // bloqueia antes de entrar
    if (e.key.length === 1 && !/[0-9.,]/.test(e.key) && !e.ctrlKey && !e.metaKey) e.preventDefault();
  });
});

/* ---------- tema ---------- */
function applyTheme(t) {
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  $('#themeBtn').textContent = t === 'light' ? 'ESCURO' : 'CLARO';
  $('#themeBtn').title = t === 'light' ? 'Voltar ao modo escuro' : 'Modo claro';
  try { localStorage.setItem('pulse-theme', t === 'light' ? 'light' : 'dark'); } catch { /* sem storage */ }
}
$('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));
(() => { let t = 'dark'; try { t = localStorage.getItem('pulse-theme') || 'dark'; } catch { /* */ } applyTheme(t); })();

/* ---------- boot ---------- */

$('#countries').innerHTML = COUNTRIES.map((c) => `<option value="${c.code}">${esc(c.name)}</option>`).join('');

(async () => {
  try {
    config = await api('/config');
    inviteRequired = config.invite_required;
    const opts = config.companies.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('#authCompany').innerHTML = opts;
    $('#meCompany').innerHTML = opts;
  } catch { /* segue */ }
  setAuthMode('login');
  try {
    const { user } = await api('/me');
    await enter(user);
  } catch { showAuth(); }
})();
})();
