// Portfolio tracker UI. Vanilla ES module, no dependencies, everything served from this machine.
// Rendering rule: a view builds its skeleton once (mount) and every live summary only patches
// the cells that changed (update), so scroll, sort, expanded rows, focus and form input survive.

// ───────────────────────── helpers ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
/** Escape anything that goes into HTML (token names and symbols are attacker-controlled). */
const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
/** Shorten long untrusted strings before escaping. */
const clip = (v, n = 28) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

const nfCache = new Map();
const nf = (min, max) => {
  const k = `${min}|${max}`;
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max }));
  return nfCache.get(k);
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const SUB = '₀₁₂₃₄₅₆₇₈₉';

/** USD amount: $1,234.56, sign optional. */
function usd(v, { sign = false, dp = 2 } = {}) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  if (a > 0 && a < 0.005) return `${s}<$0.01`;
  return `${s}$${nf(dp, dp).format(a)}`;
}
/** Bare number with adaptive decimals for small values (0.0₅1234 for dust prices). */
function adaptive(a) {
  if (a === 0) return '0';
  if (a >= 10) return nf(2, 2).format(a);
  if (a >= 1) return nf(2, 4).format(a);
  if (a >= 0.0001) return String(+a.toPrecision(4));
  const e = Math.floor(Math.log10(a));
  const zeros = -e - 1;
  let digits = String(Math.round(a * 10 ** (-e + 3))).replace(/0+$/, '');
  if (digits.length > 4) digits = digits.slice(0, 4);
  return `0.0${String(zeros).split('').map((d) => SUB[d]).join('')}${digits || '0'}`;
}
/** Unit price with adaptive decimals. */
function price(p) {
  if (!isNum(p)) return '—';
  return `${p < 0 ? '−' : ''}$${adaptive(Math.abs(p))}`;
}
/** Money: dimmed "$" and dimmed, slightly smaller decimals next to a bright integer part. Returns HTML. */
function dimMoney(str) {
  const m = /^([−+]?)(<)?\$([\d,]+)(\.[\d₀-₉]+)?(.*)$/.exec(str);
  if (!m || m[2]) return str === '—' ? '<span class="dim">—</span>' : esc(str);
  return `<span class="m">${m[1]}<i>$</i>${m[3]}${m[4] ? `<i class="c">${m[4]}</i>` : ''}${esc(m[5])}</span>`;
}
const money = (v, o) => dimMoney(usd(v, o));
const priceH = (p) => dimMoney(price(p));
/** Token amount, compact for big numbers. */
function qty(q, { sign = false } = {}) {
  if (!isNum(q)) return '—';
  const a = Math.abs(q);
  const s = q < 0 ? '−' : sign && q > 0 ? '+' : '';
  let body;
  if (a >= 1e12) body = `${nf(0, 2).format(a / 1e12)}T`;
  else if (a >= 1e9) body = `${nf(0, 2).format(a / 1e9)}B`;
  else if (a >= 1e6) body = `${nf(0, 2).format(a / 1e6)}M`;
  else if (a >= 1e5) body = `${nf(0, 1).format(a / 1e3)}K`;
  else if (a >= 1000) body = nf(0, 2).format(a);
  else if (a >= 1) body = nf(0, 4).format(a);
  else if (a >= 1e-8) body = String(+a.toPrecision(4)).includes('e') ? a.toFixed(10).replace(/0+$/, '') : String(+a.toPrecision(4));
  else if (a === 0) body = '0';
  else body = a.toExponential(2);
  return s + body;
}
/** Fraction → percentage. */
function pct(f, { sign = true, dp = 2 } = {}) {
  if (!isNum(f)) return '—';
  const v = f * 100;
  const a = Math.abs(v);
  const s = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  return `${s}${a >= 1000 ? nf(0, 0).format(a) : a.toFixed(dp)}%`;
}
/** Short USD for axis labels and tiles. */
function compactUsd(v, step = 0) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  const unit = a >= 1e9 ? 1e9 : a >= 1e6 ? 1e6 : a >= 1e4 ? 1e3 : 1;
  const suffix = unit === 1e9 ? 'B' : unit === 1e6 ? 'M' : unit === 1e3 ? 'K' : '';
  let dp = unit === 1 ? (a < 10 ? 2 : 0) : 1;
  if (step) dp = Math.min(3, Math.max(0, Math.ceil(-Math.log10(step / unit) - 1e-9)));
  return `${v < 0 ? '−' : ''}$${nf(dp, dp).format(a / unit)}${suffix}`;
}
const pnlCls = (v) => (!isNum(v) || Math.abs(v) < 1e-9 ? 'dim' : v > 0 ? 'up' : 'down');
/** Plain numeric string for inputs (no separators, no exponent). */
function plain(p) {
  if (!isNum(p)) return '';
  const a = Math.abs(p);
  if (a === 0) return '0';
  if (a >= 1) return String(+p.toPrecision(10)).includes('e') ? p.toFixed(2) : String(+p.toFixed(6));
  return p.toFixed(14).replace(/0+$/, '').replace(/\.$/, '').slice(0, Math.max(8, Math.ceil(-Math.log10(a)) + 7));
}
const parseNum = (s) => { const n = Number(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : NaN; };

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const agoSpan = (ts) => `<span class="ago" data-ts="${Number(ts) || 0}">${ago(ts)}</span>`;
const dfDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const dfDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dfTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const THIS_YEAR = new Date().getFullYear();
const dateTime = (ts) => { const d = new Date(ts * 1000); return `${(d.getFullYear() === THIS_YEAR ? dfDay : dfDate).format(d)} <span class="dim">${dfTime.format(d)}</span>`; };

const shortAddr = (a) => { const s = String(a ?? ''); return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s; };
function shortTx(tx) {
  let s = String(tx ?? '');
  const i = s.lastIndexOf(':');
  const tail = i >= 0 && s.length - i > 12 ? s.slice(i + 1) : s;
  if (tail.length > 14) return `${tail.slice(0, 6)}…${tail.slice(-4)}`;
  if (s.length > 18) s = `${s.slice(0, 8)}…${s.slice(-6)}`;
  return s;
}

/** Letter avatar in one muted tone (no remote logos, nothing leaves the machine). */
function avatar(sym, small = false) {
  const s = String(sym || '?');
  const ch = (s.replace(/[^A-Za-z0-9]/g, '')[0] || '?').toUpperCase();
  return `<span class="av${small ? ' sm' : ''}" aria-hidden="true">${esc(ch)}</span>`;
}

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function flash(el, up) {
  if (reduceMotion || !el.animate) return;
  const c = up ? 'rgba(62, 207, 142, .20)' : 'rgba(229, 100, 95, .20)';
  el.animate([{ backgroundColor: c }, { backgroundColor: 'rgba(0,0,0,0)' }], { duration: 1100, easing: 'ease-out' });
}

/** innerHTML that only touches the DOM when the markup actually changed. */
function setHTML(el, html) {
  if (!el) return false;
  if (el._h === html) return false;
  el.innerHTML = html;
  el._h = html;
  return true;
}

/**
 * Keyed, cell-level table patcher. rows: [{ key, cls, cells: [{ h, c, v }], detail }]
 *   h = cell html, c = cell class, v = numeric value (a change flashes the cell green/red).
 * Rows are reused and reordered in place; a cell that contains the focused element is left alone.
 */
function syncRows(tbody, rows) {
  if (!tbody) return;
  const have = new Map();
  for (const tr of [...tbody.children]) {
    if (tr.dataset.key === undefined) tr.remove(); else have.set(tr.dataset.key, tr);
  }
  let cursor = tbody.firstElementChild;
  const place = (tr) => { if (tr === cursor) cursor = cursor.nextElementSibling; else tbody.insertBefore(tr, cursor); };
  const seen = new Set();
  const active = document.activeElement;
  for (const r of rows) {
    const key = String(r.key);
    let tr = have.get(key);
    const fresh = !tr;
    if (fresh) { tr = document.createElement('tr'); tr.dataset.key = key; }
    const cls = r.cls || '';
    if (tr._c !== cls) { tr.className = cls; tr._c = cls; }
    for (let i = 0; i < r.cells.length; i++) {
      const c = r.cells[i];
      let td = tr.children[i];
      if (!td) { td = document.createElement('td'); tr.appendChild(td); }
      const cc = c.c || '';
      if (td._c !== cc) { td.className = cc; td._c = cc; }
      if (c.span && td.colSpan !== c.span) td.colSpan = c.span;
      const h = c.h ?? '';
      if (td._h !== h) {
        if (!fresh && active && active !== document.body && td.contains(active)) continue;
        td.innerHTML = h;
        td._h = h;
        if (!fresh && isNum(c.v) && isNum(td._v) && c.v !== td._v) flash(td, c.v > td._v);
      }
      td._v = c.v;
    }
    while (tr.children.length > r.cells.length) tr.lastElementChild.remove();
    place(tr);
    seen.add(key);
    if (r.detail != null) {
      const dk = `${key}\u0001detail`;
      let dr = have.get(dk);
      if (!dr) {
        dr = document.createElement('tr');
        dr.dataset.key = dk;
        dr.className = 'detail';
        const td = document.createElement('td');
        td.colSpan = r.cells.length;
        dr.appendChild(td);
      }
      const td = dr.firstElementChild;
      if (td._h !== r.detail) { td.innerHTML = r.detail; td._h = r.detail; }
      place(dr);
      seen.add(dk);
    }
  }
  for (const [k, tr] of have) if (!seen.has(k)) tr.remove();
}

/** Keyed list of block elements (cards). */
function syncBlocks(container, items, keyOf, create, update) {
  const have = new Map();
  for (const el of [...container.children]) {
    if (el.dataset.key === undefined) el.remove(); else have.set(el.dataset.key, el);
  }
  let cursor = container.firstElementChild;
  const seen = new Set();
  for (const it of items) {
    const key = String(keyOf(it));
    let el = have.get(key);
    if (!el) { el = create(it); el.dataset.key = key; }
    update(el, it);
    if (el === cursor) cursor = cursor.nextElementSibling; else container.insertBefore(el, cursor);
    seen.add(key);
  }
  for (const [k, el] of have) if (!seen.has(k)) el.remove();
}

async function api(path, method = 'GET', body) {
  const opt = { method, headers: {}, cache: 'no-store' };
  if (method !== 'GET') { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body ?? {}); }
  const r = await fetch(path, opt);
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON error body */ }
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j;
}

function toast(msg, kind = '') {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'err' ? 5000 : 2200);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;left:-999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied to clipboard');
  } catch { toast('Could not copy', 'err'); }
}

const prefs = {
  get(k, d) { try { const v = localStorage.getItem(`pt:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`pt:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ───────────────────────── state ─────────────────────────
const VIEWS = ['overview', 'assets', 'positions', 'accounts', 'settings'];
const S = {
  summary: null,
  view: null,
  connected: false,
  polling: false,
  lastAt: 0, // client clock (ms) of the last summary received
  sort: prefs.get('sort', { key: 'value', dir: -1 }),
  expanded: new Set(), // asset groups expanded inline on the Assets view
  hideSmall: prefs.get('hideSmall', true),
  showAllOverview: false,
  search: '',
  accExpanded: new Set(),
  fills: null,
  fillsAt: 0,
  fillsLimit: 25,
};
const viewEl = $('#view');
const accountLabel = (id) => S.summary?.accounts.find((a) => a.id === id)?.label || id;
const TYPE_LABEL = { evm: 'Ethereum & EVM', solana: 'Solana', pearl: 'Pearl', cex: 'Exchange', manual: 'Manual', hyperliquid: 'Hyperliquid' };
const typeLabel = (a) => (a.type === 'cex' && a.exchange ? a.exchange[0].toUpperCase() + a.exchange.slice(1) : TYPE_LABEL[a.type] || a.type);
/** "evm:ab12cd34:base" → "evm · Main wallet · base" */
function sourceLabel(src) {
  const accs = S.summary?.accounts || [];
  return String(src).split(':').map((p) => accs.find((a) => a.id === p)?.label || p).join(' · ');
}

// ───────────────────────── header, live indicator, sidebar ─────────────────────────
function renderHeader(s) {
  const tot = $('#total');
  if (setHTML(tot, money(s.total)) && isNum(tot._v) && tot._v !== s.total) flash(tot, s.total > tot._v);
  tot._v = s.total;
  const chg = $('#chg');
  chg.className = pnlCls(s.change24hUsd);
  chg.textContent = `${usd(s.change24hUsd, { sign: true })}  ${pct(s.change24h)}`;
  setHTML($('#pnl'), `<span class="pl"><span class="dim">PnL</span> <b class="${pnlCls(s.pnl)}">${usd(s.pnl, { sign: true })}</b></span>`);
  document.title = `${usd(s.total, { dp: 0 })} · Portfolio`;
}

function renderStatus(s) {
  const bad = (s.status || []).filter((x) => !x.ok);
  const n = (s.status || []).length;
  let h;
  if (!n) h = '';
  else if (!bad.length) h = `<div class="ok"><i class="dot ok"></i>All ${n} sources ok</div>`;
  else {
    h = `<div class="hd">${bad.length} of ${n} sources failing</div>`
      + bad.map((x) => `<div class="bad" title="${esc(x.message)}"><i class="dot bad"></i>${esc(sourceLabel(x.source))}</div>`).join('');
  }
  setHTML($('#status'), h);
  const dot = $('#navDot');
  if (dot) dot.hidden = !bad.length;
}

function tick() {
  const live = $('#live');
  const text = $('#liveText');
  const secs = S.lastAt ? Math.max(0, Math.round((Date.now() - S.lastAt) / 1000)) : null;
  const upd = secs == null ? 'waiting for data' : `updated ${secs < 120 ? `${secs}s` : `${Math.floor(secs / 60)}m`} ago`;
  live.classList.toggle('on', S.connected);
  live.classList.toggle('stale', S.connected && secs != null && secs > 90);
  const t = S.connected ? `live · ${upd}` : S.lastAt ? `offline · ${upd}` : 'connecting…';
  if (text.textContent !== t) text.textContent = t;
  for (const el of $$('.ago')) {
    const v = ago(Number(el.dataset.ts));
    if (el.textContent !== v) el.textContent = v;
  }
}

// ───────────────────────── live data ─────────────────────────
let es = null;
let pollTimer = null;
function onSummary(s) {
  if (!s || !Array.isArray(s.assets)) return;
  S.summary = s;
  S.lastAt = Date.now();
  $('#boot')?.remove();
  try {
    renderHeader(s);
    renderStatus(s);
    views[S.view]?.update?.(s);
    if (D.group) updateDrawer();
  } catch (e) { console.error('render failed', e); }
  const btn = $('#refresh');
  if (btn._busy && Date.now() - btn._busy > 1500) endRefresh();
  tick();
}
async function pollOnce() {
  try { onSummary(await api('/api/summary')); } catch { /* server down: indicator shows offline */ }
}
function startPolling() {
  if (pollTimer) return;
  S.polling = true;
  pollTimer = setInterval(pollOnce, 10_000);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  S.polling = false;
}
function connect() {
  if (!('EventSource' in window)) { startPolling(); return; }
  try { es?.close(); } catch { /* ignore */ }
  es = new EventSource('/api/stream');
  es.onopen = () => { S.connected = true; stopPolling(); tick(); };
  es.onmessage = (e) => {
    S.connected = true;
    try { onSummary(JSON.parse(e.data)); } catch (err) { console.error('bad stream message', err); }
  };
  es.onerror = () => {
    S.connected = false;
    startPolling();
    tick();
    // The browser retries by itself unless the stream was closed for good.
    if (es.readyState === 2) setTimeout(connect, 5000);
  };
}

function endRefresh() {
  const btn = $('#refresh');
  btn._busy = 0;
  btn.disabled = false;
  btn.textContent = 'Refresh now';
}
$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  if (btn._busy) return;
  btn._busy = Date.now();
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  setTimeout(() => { if (btn._busy) endRefresh(); }, 12_000);
  try { await api('/api/refresh', 'POST', {}); } catch (e) { toast(`Refresh failed: ${e.message}`, 'err'); endRefresh(); }
});

// ───────────────────────── shared cell builders ─────────────────────────
function assetCell(a) {
  const main = a.holdings?.[0];
  const many = a.holdings?.length > 1;
  const sameName = !many || a.holdings.every((h) => h.name === main.name);
  const name = sameName && main?.name && String(main.name).toUpperCase() !== String(a.group).toUpperCase() ? clip(main.name, 26) : '';
  const places = many ? `${a.holdings.length} places` : (main?.accountLabel ? clip(main.accountLabel, 22) : '');
  const sub = [name, places].filter(Boolean).join(' · ');
  return `<div class="asset">${avatar(a.group)}<div class="asset-t"><span class="sym">${esc(clip(a.group, 16))}</span>`
    + `<small><span class="mo">${qty(a.qty)}</span><span class="dk">${esc(sub)}</span></small></div></div>`;
}
const pctCell = (f) => `<span class="${pnlCls(f)}">${pct(f)}</span>`;
function pnlCell(v, p) {
  if (!isNum(v)) return '<span class="dim">—</span>';
  return `<span class="${pnlCls(v)}">${usd(v, { sign: true })}</span>${isNum(p) ? `<small class="${pnlCls(v)}">${pct(p)}</small>` : ''}`;
}
const shareCell = (f) => `<div class="share"><span>${pct(f, { sign: false, dp: f < 0.1 ? 2 : 1 })}</span><div class="bar"><i style="width:${Math.max(0, Math.min(100, f * 100)).toFixed(2)}%"></i></div></div>`;
const chainTag = (c) => (c ? `<span class="chain">${esc(clip(c, 14))}</span>` : '');
const emptyRow = (cols, msg) => [{ key: '__empty', cls: 'empty-row', cells: [{ h: msg, c: 'empty-cell', span: cols }] }];

function onboardHtml() {
  return `<div class="panel onboard"><div class="ob-icon"><span class="av" aria-hidden="true">+</span></div><h2>Add your first account</h2>
    <p>Paste a wallet address or a read-only exchange API key and the tracker starts pulling balances, prices and trade history.
    Everything is stored in a local database on this machine: no cloud, no telemetry.</p>
    <a class="btn primary" href="#accounts">Add an account</a></div>`;
}

// ───────────────────────── chart ─────────────────────────
const RANGES = { '1D': 1, '7D': 7, '30D': 30, ALL: 36500 };
const RANGE_TEXT = { '1D': 'past 24 hours', '7D': 'past 7 days', '30D': 'past 30 days', ALL: 'all time' };
const chart = { range: prefs.get('range', '30D'), data: null, fetchedAt: 0, loading: false, error: null, geom: null, hoverX: null, ro: null, seq: 0 };
if (!RANGES[chart.range]) chart.range = '30D';

async function loadHistory() {
  const seq = ++chart.seq;
  chart.loading = true;
  try {
    const rows = await api(`/api/history?days=${RANGES[chart.range]}`);
    if (seq !== chart.seq) return;
    chart.data = Array.isArray(rows) ? rows.filter((r) => isNum(r.ts) && isNum(r.total)) : [];
    chart.error = null;
  } catch (e) {
    if (seq !== chart.seq) return;
    chart.error = e.message;
    chart.data = chart.data || [];
  }
  chart.loading = false;
  chart.fetchedAt = Date.now();
  drawChart();
}

function chartPoints() {
  let pts = (chart.data || []).map((r) => ({ t: r.ts * 1000, v: r.total }));
  const s = S.summary;
  if (s && s.total > 0 && (!pts.length || s.at * 1000 > pts[pts.length - 1].t)) pts.push({ t: s.at * 1000, v: s.total });
  const max = 700;
  if (pts.length > max) { // keep the last point of each bucket; the server may return every snapshot
    const out = [];
    const stride = pts.length / max;
    for (let i = 0; i < max; i++) out.push(pts[Math.min(pts.length - 1, Math.floor((i + 1) * stride) - 1)]);
    pts = out;
  }
  return pts;
}

function niceTicks(lo, hi, n) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return { step, ticks: out };
}

function drawChart() {
  const box = $('#chart');
  if (!box) return;
  const head = $('#chDelta');
  const pts = chartPoints();
  if (chart.data == null) { setHTML(box, '<div class="chart-empty"><span class="spin"></span>Loading history…</div>'); chart.geom = null; return; }
  if (pts.length < 2) {
    chart.geom = null;
    setHTML(head, '');
    const only = pts[0];
    setHTML(box, `<div class="chart-empty"><svg viewBox="0 0 120 40" class="ce-art" aria-hidden="true"><path d="M2 30 C 20 28, 28 14, 44 18 S 70 34, 84 16 S 108 8, 118 6"/></svg>
      <b>${chart.error ? 'History is unavailable right now' : only ? 'Just getting started' : 'No history yet'}</b>
      <span>${chart.error ? esc(chart.error) : only
    ? `First snapshot recorded at ${usd(only.v)}. The chart draws itself as more snapshots come in, one every few minutes.`
    : chart.range !== 'ALL' && S.summary?.total ? `No snapshots in the ${RANGE_TEXT[chart.range]}. Try a longer range.`
      : 'A snapshot of your portfolio value is saved every few minutes while the tracker is running. Leave it open and this fills in.'}</span></div>`);
    return;
  }
  const W = Math.max(240, box.clientWidth);
  const H = Math.max(160, box.clientHeight);
  const narrow = W < 520;
  const m = { t: 14, r: narrow ? 50 : 62, b: 24, l: 2 };
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.01 || 1;
  lo -= pad; hi += pad;
  const x = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const first = pts[0].v;
  const last = pts[pts.length - 1].v;
  const up = last >= first;
  const col = up ? 'var(--up)' : 'var(--down)';

  const { step, ticks } = niceTicks(lo, hi, narrow ? 3 : 4);
  let g = '';
  for (const v of ticks) {
    const yy = y(v).toFixed(1);
    g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/><text class="ax" x="${W - m.r + 8}" y="${yy}" dy=".32em">${compactUsd(v, step)}</text>`;
  }
  const span = t1 - t0;
  const nx = narrow ? 3 : 6;
  for (let i = 0; i < nx; i++) {
    const t = t0 + (span * (i + 0.5)) / nx;
    const d = new Date(t);
    g += `<text class="ax" text-anchor="middle" x="${x(t).toFixed(1)}" y="${H - 6}">${esc(span <= 2 * 86400e3 ? dfTime.format(d) : dfDay.format(d))}</text>`;
  }
  let d = '';
  for (let i = 0; i < pts.length; i++) d += `${i ? 'L' : 'M'}${x(pts[i].t).toFixed(1)} ${y(pts[i].v).toFixed(1)}`;
  const base = H - m.b;
  const area = `${d}L${x(t1).toFixed(1)} ${base}L${x(t0).toFixed(1)} ${base}Z`;
  const lx = x(t1).toFixed(1);
  const ly = y(last).toFixed(1);
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Portfolio value, ${esc(RANGE_TEXT[chart.range])}">
    <defs><linearGradient id="chFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".13"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    ${g}<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${base}" y2="${base}"/>
    <path d="${area}" fill="url(#chFill)"/><path class="line" d="${d}" stroke="${col}"/>
    <circle class="pulse" cx="${lx}" cy="${ly}" r="7" fill="${col}"/><circle cx="${lx}" cy="${ly}" r="3.5" fill="${col}" stroke="var(--panel)" stroke-width="2"/>
    <g id="chHover" visibility="hidden"><line class="cross" y1="${m.t - 6}" y2="${base}"/><circle r="4.5" fill="${col}" stroke="var(--panel)" stroke-width="2"/></g>
  </svg><div class="tip" hidden></div>`;
  box._h = null;
  chart.geom = { pts, x, y, W, H, m, first };
  setHTML(head, `<b class="${pnlCls(last - first)}">${usd(last - first, { sign: true })}</b> <span class="${pnlCls(last - first)}">${first ? pct((last - first) / first) : ''}</span> <span class="dim">${RANGE_TEXT[chart.range]}</span>`);
  if (chart.hoverX != null) chartHover(chart.hoverX);
}

function chartHover(px) {
  const g = chart.geom;
  const box = $('#chart');
  if (!g || !box) return;
  const hov = $('#chHover', box);
  const tip = $('.tip', box);
  if (!hov || !tip) return;
  if (px == null) { hov.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
  // nearest point by x (binary search on time)
  const { pts } = g;
  let a = 0;
  let b = pts.length - 1;
  while (b - a > 1) { const mid = (a + b) >> 1; if (g.x(pts[mid].t) < px) a = mid; else b = mid; }
  const p = Math.abs(g.x(pts[a].t) - px) <= Math.abs(g.x(pts[b].t) - px) ? pts[a] : pts[b];
  const cx = g.x(p.t);
  const cy = g.y(p.v);
  hov.setAttribute('visibility', 'visible');
  const [line, dot] = hov.children;
  line.setAttribute('x1', cx); line.setAttribute('x2', cx);
  dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
  const diff = p.v - g.first;
  tip.innerHTML = `<b>${money(p.v)}</b><span class="${pnlCls(diff)}">${usd(diff, { sign: true })} (${g.first ? pct(diff / g.first) : '—'})</span><span class="dim">${dateTime(p.t / 1000)}</span>`;
  tip.hidden = false;
  const tw = tip.offsetWidth;
  let left = cx + 14;
  if (left + tw > g.W - 4) left = cx - tw - 14;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, Math.min(cy - 30, g.H - tip.offsetHeight - 30))}px`;
}

function mountChart() {
  const box = $('#chart');
  const move = (e) => { const r = box.getBoundingClientRect(); chart.hoverX = e.clientX - r.left; chartHover(chart.hoverX); };
  const leave = () => { chart.hoverX = null; chartHover(null); };
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerdown', move);
  box.addEventListener('pointerleave', leave);
  box.addEventListener('pointercancel', leave);
  chart.ro?.disconnect();
  if ('ResizeObserver' in window) {
    let raf = 0;
    let lastW = 0;
    chart.ro = new ResizeObserver(() => {
      if (box.clientWidth === lastW) return;
      lastW = box.clientWidth;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(drawChart);
    });
    chart.ro.observe(box);
  }
  $('#ranges').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b || b.dataset.range === chart.range) return;
    chart.range = b.dataset.range;
    prefs.set('range', chart.range);
    for (const x of $$('#ranges button')) x.classList.toggle('on', x.dataset.range === chart.range);
    loadHistory();
  });
  drawChart();
  loadHistory();
}

// ───────────────────────── overview ─────────────────────────
// Categorical slots (identity colours). A colour stays with its asset for the session, whatever its rank.
const SERIES = ['#2f9e83', '#5a8fdb', '#b3862a', '#c7668f', '#8a7fe0', '#cc6f45', '#2fa3bd'];
const OTHER_COLOR = '#4d4d4d';
const seriesOf = new Map();
function assignSeries(groups) {
  for (const [g] of seriesOf) if (!groups.includes(g)) seriesOf.delete(g);
  for (const g of groups) {
    if (seriesOf.has(g)) continue;
    const used = new Set(seriesOf.values());
    seriesOf.set(g, SERIES.find((c) => !used.has(c)) || OTHER_COLOR);
  }
}

function tile(label, value, sub = '', cls = '') {
  return `<div class="tile"><label>${label}</label><b class="${cls}">${value}</b><small>${sub}</small></div>`;
}

const overview = {
  mount(el) {
    el.innerHTML = `
      <div id="ovOnboard" hidden></div>
      <div id="ovBody">
        <div class="tiles" id="ovTiles"></div>
        <div class="grid">
          <div class="panel chart-panel">
            <h3><span>Portfolio value</span>
              <span class="seg" id="ranges">${Object.keys(RANGES).map((r) => `<button type="button" data-range="${r}" class="${r === chart.range ? 'on' : ''}">${r}</button>`).join('')}</span></h3>
            <div class="chart-head" id="chDelta"></div>
            <div id="chart" class="chartbox"></div>
          </div>
          <div class="panel"><h3><span>Allocation</span><span id="allocN"></span></h3><div id="alloc"></div></div>
        </div>
        <div class="grid">
          <div class="panel">
            <h3><span>Holdings</span><a href="#assets">All assets →</a></h3>
            <div class="scroll"><table id="ovTable" class="tbl-hold">
              <thead><tr><th>Asset</th><th>Price</th><th class="hm">24h</th><th class="hm">Amount</th><th>Value</th><th class="hm">PnL</th></tr></thead>
              <tbody></tbody></table></div>
            <div id="ovMore" class="more"></div>
          </div>
          <div class="panel"><h3><span>Top movers</span><span>24h</span></h3><div id="movers"></div></div>
        </div>
      </div>`;
    mountChart();
    $('#ovTable tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr.click');
      if (tr) openAsset(tr.dataset.key);
    });
    $('#movers').addEventListener('click', (e) => { const r = e.target.closest('[data-group]'); if (r) openAsset(r.dataset.group); });
    $('#alloc').addEventListener('click', (e) => { const r = e.target.closest('[data-group]'); if (r) openAsset(r.dataset.group); });
    $('#ovMore').addEventListener('click', (e) => {
      if (e.target.closest('button')) { S.showAllOverview = !S.showAllOverview; this.update(S.summary); }
    });
  },
  unmount() { chart.ro?.disconnect(); chart.ro = null; chart.geom = null; chart.hoverX = null; },
  update(s) {
    const none = !s.accounts.length && !s.assets.length;
    $('#ovOnboard').hidden = !none;
    $('#ovBody').hidden = none;
    if (none) { setHTML($('#ovOnboard'), onboardHtml()); return; }

    // tiles
    const cost = s.assets.reduce((t, a) => t + (a.stable ? 0 : a.costBasis || 0), 0);
    const stables = s.assets.filter((a) => a.stable).reduce((t, a) => t + a.value, 0);
    const upnl = s.positions.reduce((t, p) => t + (p.upnl || 0), 0);
    const top = s.assets[0];
    setHTML($('#ovTiles'),
      tile('24h change', usd(s.change24hUsd, { sign: true }), pct(s.change24h), pnlCls(s.change24hUsd))
      + tile('PnL', usd(s.pnl, { sign: true }), cost ? `${pct(s.pnl / cost)} on ${compactUsd(cost)} cost` : 'no cost basis yet', pnlCls(s.pnl))
      + tile('Perps', usd(upnl, { sign: true }), `open · ${usd(s.perpRealized, { sign: true })} closed`, pnlCls(upnl))
      + tile('Stablecoins', compactUsd(stables), s.total ? `${pct(stables / s.total, { sign: false, dp: 1 })} of portfolio` : '')
      + tile('Largest holding', top ? esc(clip(top.group, 12)) : '—', top ? `${pct(top.share, { sign: false, dp: 1 })} · ${compactUsd(top.value)}` : ''));

    // chart: live point + periodic history refresh
    if (Date.now() - chart.fetchedAt > 5 * 60_000 && !chart.loading) loadHistory(); else drawChart();

    // allocation
    const ranked = s.assets.filter((a) => a.value > 0);
    const head = ranked.slice(0, SERIES.length);
    const rest = ranked.slice(SERIES.length);
    assignSeries(head.map((a) => a.group));
    const restShare = rest.reduce((t, a) => t + a.share, 0);
    const restValue = rest.reduce((t, a) => t + a.value, 0);
    const segs = head.map((a) => ({ label: a.group, share: a.share, value: a.value, color: seriesOf.get(a.group), group: a.group }));
    if (rest.length) segs.push({ label: `Other (${rest.length})`, share: restShare, value: restValue, color: OTHER_COLOR });
    setHTML($('#allocN'), `${ranked.length} assets`);
    setHTML($('#alloc'), segs.length ? `<div class="stack" role="img" aria-label="Allocation by asset">${segs.map((x) => `<i style="flex:${Math.max(x.share, 0.004).toFixed(4)};background:${x.color}" title="${esc(x.label)} ${pct(x.share, { sign: false, dp: 1 })}"></i>`).join('')}</div>
      <div class="alloc-list">${segs.map((x) => `<div class="alloc-row${x.group ? ' click' : ''}"${x.group ? ` data-group="${esc(x.group)}"` : ''}>
        <span class="sw" style="background:${x.color}"></span><span class="nm">${esc(clip(x.label, 18))}</span>
        <span class="ab"><i style="width:${(x.share * 100).toFixed(2)}%;background:${x.color}"></i></span>
        <span class="pc">${pct(x.share, { sign: false, dp: 1 })}</span><span class="vl">${compactUsd(x.value)}</span></div>`).join('')}</div>`
      : '<div class="empty">Nothing to allocate yet.</div>');

    // movers
    const floor = Math.max(1, s.total * 0.0005);
    const mov = s.assets.filter((a) => !a.stable && isNum(a.change24h) && a.value >= floor && Math.abs(a.change24h) > 1e-6)
      .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 7);
    const maxMove = Math.max(...mov.map((a) => Math.abs(a.change24h)), 0.0001);
    setHTML($('#movers'), mov.length ? mov.map((a) => `<div class="mover click" data-group="${esc(a.group)}">${avatar(a.group, true)}
        <span class="nm"><b>${esc(clip(a.group, 14))}</b><small>${price(a.price)}</small></span>
        <span class="mbar ${pnlCls(a.change24h)}"><i style="width:${((Math.abs(a.change24h) / maxMove) * 100).toFixed(1)}%"></i></span>
        <span class="mv"><b class="${pnlCls(a.change24h)}">${pct(a.change24h)}</b><small class="${pnlCls(a.change24hUsd)}">${usd(a.change24hUsd, { sign: true })}</small></span></div>`).join('')
      : '<div class="empty">No 24h price changes yet.</div>');

    // holdings
    const big = s.assets.filter((a) => a.value >= 1);
    const small = s.assets.length - big.length;
    const list = S.showAllOverview || !big.length ? s.assets : big;
    syncRows($('#ovTable tbody'), list.length ? list.map((a) => ({
      key: a.group,
      cls: 'click',
      cells: [
        { h: assetCell(a) },
        { h: `${priceH(a.price)}<small class="mo ${pnlCls(a.change24h)}">${pct(a.change24h)}</small>`, v: a.price },
        { h: pctCell(a.change24h), c: 'hm' },
        { h: qty(a.qty), c: 'hm' },
        { h: `${money(a.value)}<small class="mo ${pnlCls(a.pnl)}">${isNum(a.pnl) ? usd(a.pnl, { sign: true }) : '&nbsp;'}</small>`, v: a.value },
        { h: pnlCell(a.pnl, a.pnlPct), c: 'hm two', v: a.pnl },
      ],
    })) : emptyRow(6, 'No holdings found yet. Balances appear after the first sync.'));
    setHTML($('#ovMore'), small > 0 && big.length ? `<button type="button" class="link">${S.showAllOverview ? 'Hide' : 'Show'} ${small} small balance${small === 1 ? '' : 's'} (under $1)</button>` : '');
  },
};

// ───────────────────────── assets ─────────────────────────
const ASSET_COLS = [
  ['group', 'Asset'], ['qty', 'Amount'], ['price', 'Price'], ['change24h', '24h'], ['value', 'Value'], ['share', 'Share'],
  ['avgCost', 'Avg cost'], ['costBasis', 'Cost basis'], ['pnl', 'PnL'],
];
function sortAssets(list) {
  const { key, dir } = S.sort;
  const val = (a) => (key === 'group' ? String(a.group).toLowerCase() : a[key]);
  return [...list].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const xn = x == null || (typeof x === 'number' && !Number.isFinite(x));
    const yn = y == null || (typeof y === 'number' && !Number.isFinite(y));
    if (xn || yn) return xn === yn ? b.value - a.value : xn ? 1 : -1; // unknowns always last
    if (x === y) return b.value - a.value;
    return (x < y ? -1 : 1) * dir;
  });
}
function holdingsDetail(a) {
  return `<div class="sub-hold"><table><thead><tr><th>Held in</th><th class="hm">Chain</th><th class="hm">Token</th><th>Amount</th><th class="hm">Price</th><th>Value</th></tr></thead><tbody>${
    a.holdings.map((h) => `<tr><td>${heldCell(h)}</td><td class="hm">${chainTag(h.chain)}</td><td class="hm">${esc(clip(h.name || h.symbol, 26))}${holdingNote(h)}</td><td>${qty(h.qty)}</td><td class="hm">${priceH(h.price)}</td><td>${money(h.value)}</td></tr>`).join('')
  }</tbody></table></div>`;
}
const heldCell = (h) => `${esc(clip(h.accountLabel || h.account, 24))}<small class="mo">${esc(clip(h.chain || '', 14))}${h.meta?.staked ? ' · staked' : h.meta?.perpEquity ? ' · perp margin' : ''}</small>`;
function holdingNote(h) {
  const m = h.meta || {};
  if (m.staked) return ' <span class="tag">staked</span>';
  if (m.perpEquity) return ' <span class="tag">perp margin</span>';
  return '';
}

const assets = {
  mount(el) {
    el.innerHTML = `
      <div class="toolbar">
        <input id="asSearch" type="search" placeholder="Filter assets…" autocomplete="off" spellcheck="false" value="${esc(S.search)}" aria-label="Filter assets">
        <label class="check"><input type="checkbox" id="asSmall" ${S.hideSmall ? 'checked' : ''}> Hide balances under $1</label>
        <span class="dim grow" id="asCount"></span>
      </div>
      <div class="panel flush">
        <div class="scroll"><table id="asTable" class="sticky1 tbl-assets">
          <thead><tr>${ASSET_COLS.map(([k, label]) => `<th class="sort" data-sort="${k}" tabindex="0">${label}</th>`).join('')}</tr></thead>
          <tbody></tbody>
          <tfoot><tr id="asFoot"></tr></tfoot>
        </table></div>
      </div>
      <details class="panel hidden-tokens" id="hiddenBox" hidden>
        <summary><span>Hidden / unverified tokens <b id="hidN"></b></span><small>not counted in any total</small></summary>
        <p class="note">Tokens that are not on a public token list and have no trustworthy price. Usually airdropped spam: never visit links in their names.</p>
        <div class="scroll"><table id="hidTable"><thead><tr><th>Token</th><th>Chain</th><th class="hm">Account</th><th>Amount</th><th class="hm">Price</th><th>Est. value</th></tr></thead><tbody></tbody></table></div>
      </details>`;
    $('#asSearch').addEventListener('input', (e) => { S.search = e.target.value; this.update(S.summary); });
    $('#asSmall').addEventListener('change', (e) => { S.hideSmall = e.target.checked; prefs.set('hideSmall', S.hideSmall); this.update(S.summary); });
    const sortBy = (th) => {
      const k = th.dataset.sort;
      S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: k === 'group' ? 1 : -1 };
      prefs.set('sort', S.sort);
      this.update(S.summary);
    };
    $('#asTable thead').addEventListener('click', (e) => { const th = e.target.closest('th.sort'); if (th) sortBy(th); });
    $('#asTable thead').addEventListener('keydown', (e) => {
      const th = e.target.closest('th.sort');
      if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sortBy(th); }
    });
    $('#asTable tbody').addEventListener('click', (e) => {
      const chev = e.target.closest('.chev');
      const tr = e.target.closest('tr');
      if (!tr) return;
      if (chev) {
        const k = tr.dataset.key;
        if (S.expanded.has(k)) S.expanded.delete(k); else S.expanded.add(k);
        this.update(S.summary);
        return;
      }
      if (tr.classList.contains('click')) openAsset(tr.dataset.key);
    });
  },
  update(s) {
    if (!s) return;
    for (const th of $$('#asTable th.sort')) {
      const on = th.dataset.sort === S.sort.key;
      if (on) th.setAttribute('aria-sort', S.sort.dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
    }
    const q = S.search.trim().toLowerCase();
    let list = s.assets;
    if (S.hideSmall && !q) list = list.filter((a) => a.value >= 1);
    if (q) list = list.filter((a) => String(a.group).toLowerCase().includes(q) || a.holdings.some((h) => `${h.name} ${h.symbol} ${h.chain} ${h.accountLabel}`.toLowerCase().includes(q)));
    list = sortAssets(list);
    setHTML($('#asCount'), `${list.length} of ${s.assets.length} assets`);
    syncRows($('#asTable tbody'), list.length ? list.map((a) => {
      const open = S.expanded.has(a.group);
      const partial = a.coverage < 0.98 && isNum(a.avgCost) && !a.stable;
      return {
        key: a.group,
        cls: `click${open ? ' open' : ''}`,
        cells: [
          { h: `<div class="asset"><button type="button" class="chev" aria-label="${open ? 'Collapse' : 'Expand'} holdings" aria-expanded="${open}"></button>${avatar(a.group)}<div class="asset-t"><span class="sym">${esc(clip(a.group, 16))}</span><small>${a.holdings.length} holding${a.holdings.length === 1 ? '' : 's'}${a.trades ? ` · ${a.trades} trades` : ''}</small></div></div>` },
          { h: qty(a.qty) },
          { h: priceH(a.price), v: a.price },
          { h: pctCell(a.change24h) },
          { h: money(a.value), v: a.value },
          { h: shareCell(a.share) },
          { h: isNum(a.avgCost) ? `${priceH(a.avgCost)}${partial ? `<small class="warn" title="Cost basis is known for ${pct(a.coverage, { sign: false, dp: 0 })} of this holding">◐ ${pct(a.coverage, { sign: false, dp: 0 })} known</small>` : ''}` : '<span class="dim">—</span>', c: 'two' },
          { h: isNum(a.costBasis) ? money(a.costBasis) : '<span class="dim">—</span>' },
          { h: pnlCell(a.pnl, a.pnlPct), c: 'two', v: a.pnl },
        ],
        detail: open ? holdingsDetail(a) : null,
      };
    }) : emptyRow(ASSET_COLS.length, q ? 'No assets match that filter.' : s.assets.length ? 'Only small balances here. Untick “Hide balances under $1” to see them.' : 'No assets yet. Add an account on the Accounts page.'));
    const sum = (k) => list.reduce((t, a) => t + (isNum(a[k]) ? a[k] : 0), 0);
    const un = sum('pnl');
    const cb = list.reduce((t, a) => t + (a.stable ? 0 : a.costBasis || 0), 0);
    setHTML($('#asFoot'), list.length ? `<td>Total <span class="dim">· ${list.length}</span></td><td></td><td></td><td></td><td>${money(sum('value'))}</td><td>${pct(sum('share'), { sign: false, dp: 1 })}</td><td></td>`
      + `<td>${money(sum('costBasis'))}</td><td class="two"><span class="${pnlCls(un)}">${usd(un, { sign: true })}</span>${cb ? `<small class="${pnlCls(un)}">${pct(un / cb)}</small>` : ''}</td>` : '');

    const hid = s.hidden || [];
    $('#hiddenBox').hidden = !hid.length;
    setHTML($('#hidN'), String(hid.length));
    const keys = new Map();
    syncRows($('#hidTable tbody'), hid.map((h) => {
      let k = `${h.account}|${h.asset}`;
      const n = (keys.get(k) || 0) + 1;
      keys.set(k, n);
      if (n > 1) k += `#${n}`;
      return {
        key: k,
        cells: [
          { h: `<span class="spam" title="${esc(h.asset)}">${esc(clip(h.symbol || '?', 32))}</span>` },
          { h: chainTag(h.chain) },
          { h: esc(clip(accountLabel(h.account), 22)), c: 'hm' },
          { h: qty(h.qty) },
          { h: h.price ? price(h.price) : '<span class="dim">—</span>', c: 'hm' },
          { h: h.value ? `<span class="dim">${usd(h.value)}</span>` : '<span class="dim">—</span>' },
        ],
      };
    }));
  },
};

// ───────────────────────── asset drawer ─────────────────────────
const CLASSES = ['buy', 'sell', 'deposit', 'withdraw', 'internal', 'income', 'ignore'];
const HIST_FILTERS = { all: 'All', trades: 'Trades', transfers: 'Transfers', fees: 'Fees' };
const D = { group: null, data: null, loadedAt: 0, loading: false, error: null, limit: 100, filter: 'all', seq: 0, saving: new Set() };
const drawerEl = $('#drawer');
const drawerBody = $('#drawerBody');

function openAsset(group) { location.hash = `#${S.view}/${encodeURIComponent(group)}`; }
function closeAsset() { if (D.group) location.hash = `#${S.view}`; }

function showDrawer(group) {
  if (D.group === group) return;
  D.group = group;
  D.data = null;
  D.error = null;
  D.limit = 100;
  D.filter = 'all';
  D.saving.clear();
  drawerEl.classList.remove('hidden');
  document.body.classList.add('drawer-open');
  drawerBody.innerHTML = `
    <div class="dr-head">
      <div class="asset big">${avatar(group)}<div class="asset-t"><h2>${esc(clip(group, 24))}</h2><small id="drName"></small></div></div>
      <div class="dr-price"><b id="drPrice"></b><span id="drChg"></span></div>
      <button type="button" class="x" id="drClose" aria-label="Close">✕</button>
    </div>
    <div class="kpis" id="drKpis"></div>
    <div id="drWarn"></div>
    <div class="panel">
      <h3><span>Where it is held</span><span id="drHoldN"></span></h3>
      <div class="scroll"><table id="drHold"><thead><tr><th>Account</th><th class="hm">Chain</th><th class="hm">Token</th><th>Amount</th><th class="hm">Price</th><th>Value</th><th class="hm">Share</th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="panel">
      <h3><span>Buy / sell history <b id="drHistN"></b></span>
        <span class="seg" id="drFilter">${Object.entries(HIST_FILTERS).map(([k, v]) => `<button type="button" data-f="${k}" class="${k === 'all' ? 'on' : ''}">${v}</button>`).join('')}</span></h3>
      <p class="note tight">Average-cost basis. Change a row’s type or price if the automatic guess is wrong: cost basis and PnL recalculate immediately. Your overrides are outlined in green; ↺ puts the automatic value back.</p>
      <div class="scroll"><table id="drHist" class="tbl-hist"><thead><tr><th>Date</th><th>Type</th><th class="hm">Account</th><th>Qty</th><th>Price</th><th>USD value</th><th>PnL on sale</th><th>Avg cost after</th><th>Swapped with</th><th>Tx</th></tr></thead><tbody></tbody></table></div>
      <div id="drMore" class="more"></div>
    </div>`;
  drawerBody.scrollTop = 0;
  updateDrawer();
  loadAsset();
  $('#drClose').focus({ preventScroll: true });
}
function hideDrawer() {
  if (!D.group) return;
  D.group = null;
  D.data = null;
  D.seq++;
  drawerEl.classList.add('hidden');
  document.body.classList.remove('drawer-open');
  drawerBody.innerHTML = '';
}

async function loadAsset() {
  const group = D.group;
  if (!group) return;
  const seq = ++D.seq;
  D.loading = true;
  try {
    const data = await api(`/api/asset?group=${encodeURIComponent(group)}`);
    if (seq !== D.seq || D.group !== group) return;
    D.data = data && Array.isArray(data.events) ? data : { events: [] };
    D.error = null;
  } catch (e) {
    if (seq !== D.seq) return;
    D.error = e.message;
  }
  D.loading = false;
  D.loadedAt = Date.now();
  updateDrawer();
}

const kpi = (label, value, sub = '', cls = '') => `<div class="kpi"><label>${label}</label><b class="${cls}">${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

function eventFilter(e) {
  if (D.filter === 'trades') return e.cls === 'buy' || e.cls === 'sell';
  if (D.filter === 'transfers') return ['deposit', 'withdraw', 'internal', 'income'].includes(e.cls);
  if (D.filter === 'fees') return e.cls === 'fee';
  return true;
}
const PRICE_SRC_NOTE = {
  fill: 'Execution price from the venue', stable: 'Stablecoin, valued at $1', historical: 'Market price at the time of the transaction',
  override: 'Price set by you', unknown: 'No price found: set one to include this in cost basis', 'current (no history)': 'No historical price found: using today’s price. Set the real one if you know it.',
};

function updateDrawer() {
  const group = D.group;
  if (!group || !$('#drKpis')) return;
  const s = S.summary;
  const a = s?.assets.find((x) => x.group === group);
  const L = D.data;

  if (a) {
    const main = a.holdings[0];
    setHTML($('#drName'), esc(clip(main?.name && main.name !== group ? main.name : '', 40)) + (a.stable ? ' <span class="tag">stablecoin</span>' : ''));
    const pe = $('#drPrice');
    if (setHTML(pe, priceH(a.price)) && isNum(pe._v) && pe._v !== a.price) flash(pe, a.price > pe._v);
    pe._v = a.price;
    setHTML($('#drChg'), `<span class="${pnlCls(a.change24h)}">${pct(a.change24h)}</span> <span class="dim">24h</span>`);
    const src = a.costSource === 'hyperliquid' ? 'entry reported by Hyperliquid' : a.costSource === 'stable' ? 'stablecoin, $1' : 'average cost';
    setHTML($('#drKpis'),
      kpi('Holding', qty(a.qty), `${pct(a.share, { sign: false, dp: 1 })} of portfolio`)
      + kpi('Value', money(a.value), `${usd(a.change24hUsd, { sign: true })} today`)
      + kpi('Avg cost', isNum(a.avgCost) ? priceH(a.avgCost) : '—', isNum(a.avgCost) ? src : 'no purchase history')
      + kpi('Cost basis', isNum(a.costBasis) ? money(a.costBasis) : '—', a.coverage < 0.98 && isNum(a.costBasis) ? `${pct(a.coverage, { sign: false, dp: 0 })} of holding` : '')
      + kpi('PnL', isNum(a.pnl) ? usd(a.pnl, { sign: true }) : '—', [isNum(a.pnlPct) ? pct(a.pnlPct) : '', L && (L.buys || L.sells) ? `${L.buys || 0} buys · ${L.sells || 0} sells` : ''].filter(Boolean).join(' · '), pnlCls(a.pnl))
      + (Math.abs(a.realized || 0) >= 1 ? kpi('Past sells', usd(a.realized, { sign: true }), 'profit already taken', pnlCls(a.realized)) : ''));
    let warn = '';
    if (!a.stable && a.qty > 0 && a.coverage < 0.98) {
      warn = isNum(a.avgCost)
        ? `<div class="callout warn"><b>Cost basis known for ${pct(a.coverage, { sign: false, dp: 0 })} of this holding.</b> The history found explains ${qty(a.qty * a.coverage)} of ${qty(a.qty)} ${esc(clip(group, 12))}. PnL only covers that part. If a deposit below was really a purchase, set its type and price.</div>`
        : `<div class="callout warn"><b>No cost basis yet.</b> No purchase history was found for this holding, so PnL cannot be calculated. History sync can take a few minutes after adding an account.</div>`;
    }
    setHTML($('#drWarn'), warn);
    setHTML($('#drHoldN'), `${a.holdings.length} place${a.holdings.length === 1 ? '' : 's'}`);
    const seen = new Map();
    syncRows($('#drHold tbody'), a.holdings.map((h) => {
      let k = `${h.account}|${h.asset}`;
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      if (n > 1) k += `#${n}`;
      return {
        key: k,
        cells: [
          { h: heldCell(h) },
          { h: chainTag(h.chain), c: 'hm' },
          { h: `${esc(clip(h.name || h.symbol, 26))}${holdingNote(h)}`, c: 'hm' },
          { h: qty(h.qty) },
          { h: priceH(h.price), c: 'hm', v: h.price },
          { h: money(h.value), v: h.value },
          { h: pct(a.value ? h.value / a.value : 0, { sign: false, dp: 1 }), c: 'hm' },
        ],
      };
    }));
  } else if (s) {
    setHTML($('#drKpis'), kpi('Holding', '0', 'no longer held') + (L ? kpi('PnL', usd(L.realized || 0, { sign: true }), 'from sells', pnlCls(L.realized)) : ''));
    setHTML($('#drWarn'), '');
    syncRows($('#drHold tbody'), emptyRow(7, 'Not currently held in any account.'));
  }

  // history
  const body = $('#drHist tbody');
  if (!L) {
    syncRows(body, emptyRow(10, D.error ? `Could not load history: ${esc(D.error)}` : '<span class="spin"></span>Loading history…'));
    setHTML($('#drMore'), '');
    return;
  }
  const all = L.events.filter(eventFilter);
  setHTML($('#drHistN'), all.length === L.events.length ? String(all.length) : `${all.length} / ${L.events.length}`);
  const shown = all.slice(0, D.limit);
  const seenIds = new Map();
  const rows = shown.map((e) => {
    let k = String(e.id);
    const n = (seenIds.get(k) || 0) + 1;
    seenIds.set(k, n);
    if (n > 1) k += `#${n}`;
    const clsOverride = e.overridden && e.cls !== e.auto;
    const pxOverride = e.priceSrc === 'override';
    const sel = clsOverride ? e.cls : 'auto';
    const opts = [`<option value="auto"${sel === 'auto' ? ' selected' : ''}>${esc(e.auto)} · auto</option>`]
      .concat(CLASSES.map((c) => `<option value="${c}"${sel === c ? ' selected' : ''}>${c}</option>`)).join('');
    const weak = e.priceSrc === 'unknown' || e.priceSrc === 'current (no history)';
    const id = esc(e.id);
    return {
      key: k,
      cls: `${e.cls === 'ignore' ? 'ignored ' : ''}${D.saving.has(e.id) ? 'saving' : ''}`,
      cells: [
        { h: dateTime(e.ts) },
        { h: `<span class="clsbox"><select class="cls c-${esc(e.cls)}${clsOverride ? ' ovr' : ''}" data-ev="${id}" aria-label="Type" title="${clsOverride ? `You set this. Automatic guess: ${esc(e.auto)}` : 'Classified automatically. Change it if this is wrong.'}">${opts}</select>${e.overridden ? `<button type="button" class="reset" data-ev="${id}" title="Clear your override${e.note ? `: ${esc(e.note)}` : ''}">↺</button>` : ''}</span>` },
        { h: esc(clip(accountLabel(e.account), 18)), c: 'hm' },
        { h: `<span class="${e.qty > 0 ? 'up' : e.qty < 0 ? 'down' : 'dim'}">${qty(e.qty, { sign: true })}</span>${e.symbol && String(e.symbol).toUpperCase() !== String(group).toUpperCase() ? ` <small>${esc(clip(e.symbol, 10))}</small>` : ''}` },
        { h: `<input class="px${pxOverride ? ' ovr' : ''}${weak ? ' weak' : ''}" data-ev="${id}" inputmode="decimal" autocomplete="off" aria-label="Unit price in USD" value="${esc(plain(e.unitPrice))}" placeholder="set price" title="${esc(PRICE_SRC_NOTE[e.priceSrc] || e.priceSrc || '')}">` },
        { h: isNum(e.usd) ? money(e.usd) : '<span class="dim">—</span>' },
        { h: isNum(e.realized) && Math.abs(e.realized) >= 0.005 ? `<span class="${pnlCls(e.realized)}">${usd(e.realized, { sign: true })}</span>` : '<span class="dim">—</span>' },
        { h: isNum(e.avgAfter) && e.avgAfter > 0 ? priceH(e.avgAfter) : '<span class="dim">—</span>' },
        { h: e.swapWith?.length ? `<span class="swap">${e.swapWith.map((x) => esc(clip(x, 26))).join('<br>')}</span>` : (e.counterparty ? `<span class="dim" title="${esc(e.counterparty)}">${e.qty > 0 ? 'from' : 'to'} ${esc(shortAddr(e.counterparty))}</span>` : '<span class="dim">—</span>') },
        { h: e.tx ? `<button type="button" class="tx" data-copy="${esc(e.tx)}" title="Copy ${esc(e.tx)}">${esc(shortTx(e.tx))}</button>` : '<span class="dim">—</span>' },
      ],
    };
  });
  syncRows(body, rows.length ? rows : emptyRow(10, L.events.length ? 'Nothing of this type.' : 'No transactions found for this asset yet. History sync can take a few minutes after adding an account.'));
  setHTML($('#drMore'), all.length > shown.length ? `<button type="button" class="link">Show ${Math.min(200, all.length - shown.length)} more (${all.length - shown.length} older)</button>` : '');
}

async function saveOverride(eventId, change) {
  const e = D.data?.events.find((x) => String(x.id) === String(eventId));
  if (!e) return;
  // The server replaces the whole override row, so always send class and price together.
  let cls = e.overridden && e.cls !== e.auto ? e.cls : null;
  let px = e.priceSrc === 'override' ? e.unitPrice : null;
  if ('cls' in change) cls = change.cls;
  if ('price' in change) px = change.price;
  const body = change.clear || (!cls && px == null) ? { eventId: e.id } : { eventId: e.id, class: cls, price: px, note: e.note || null };
  D.saving.add(e.id);
  updateDrawer();
  try {
    await api('/api/override', 'POST', body);
    toast(change.clear || (!cls && px == null) ? 'Override cleared' : 'Saved. Cost basis recalculated');
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'err');
  }
  D.saving.delete(e.id);
  if (document.activeElement?.closest?.('#drHist')) document.activeElement.blur();
  await loadAsset();
}

drawerEl.addEventListener('click', (e) => {
  if (e.target === drawerEl || e.target.closest('#drClose')) { closeAsset(); return; }
  const copy = e.target.closest('[data-copy]');
  if (copy) { copyText(copy.dataset.copy); return; }
  const f = e.target.closest('#drFilter button');
  if (f) {
    D.filter = f.dataset.f;
    D.limit = 100;
    for (const b of $$('#drFilter button')) b.classList.toggle('on', b === f);
    updateDrawer();
    return;
  }
  if (e.target.closest('#drMore button')) { D.limit += 200; updateDrawer(); return; }
  const reset = e.target.closest('button.reset');
  if (reset) saveOverride(reset.dataset.ev, { clear: true });
});
drawerEl.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('select.cls')) { saveOverride(t.dataset.ev, { cls: t.value === 'auto' ? null : t.value }); return; }
  if (t.matches('input.px')) {
    const raw = t.value.trim();
    const ev = D.data?.events.find((x) => String(x.id) === t.dataset.ev);
    if (!ev) return;
    if (raw === '') { if (ev.priceSrc === 'override') saveOverride(t.dataset.ev, { price: null }); else t.value = plain(ev.unitPrice); return; }
    const n = parseNum(raw);
    if (!(n >= 0)) { t.classList.add('bad'); toast('Enter a price in USD, for example 1234.56', 'err'); return; }
    t.classList.remove('bad');
    if (plain(n) === plain(ev.unitPrice)) return;
    saveOverride(t.dataset.ev, { price: n });
  }
});
drawerEl.addEventListener('keydown', (e) => {
  if (!e.target.matches?.('input.px')) return;
  if (e.key === 'Enter') e.target.blur();
  if (e.key === 'Escape') {
    const ev = D.data?.events.find((x) => String(x.id) === e.target.dataset.ev);
    e.target.value = plain(ev?.unitPrice);
    e.target.classList.remove('bad');
    e.target.blur();
    e.stopPropagation();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && D.group && !e.defaultPrevented) closeAsset();
});

// ───────────────────────── positions ─────────────────────────
async function loadFills() {
  try { S.fills = await api('/api/perp-fills'); } catch (e) { S.fills = S.fills || []; S.fillsErr = e.message; }
  S.fillsAt = Date.now();
  if (S.view === 'positions' && S.summary) positions.update(S.summary);
}
const positions = {
  mount(el) {
    el.innerHTML = `
      <div class="tiles" id="poTiles"></div>
      <div class="panel flush">
        <h3><span>Open perp positions</span><span id="poN"></span></h3>
        <div class="scroll"><table id="poTable" class="sticky1"><thead><tr><th>Coin</th><th>Side</th><th>Size</th><th class="hm">Entry</th><th>Mark</th><th>Value</th><th>uPnL</th><th class="hm">Leverage</th><th>Liq. price</th><th class="hm">Funding</th><th class="hm">Account</th></tr></thead><tbody></tbody></table></div>
      </div>
      <div class="panel flush">
        <h3><span>Recent fills</span><span id="fiN"></span></h3>
        <div class="scroll"><table id="fiTable" class="sticky1 tbl-fills"><thead><tr><th>Time</th><th>Coin</th><th>Direction</th><th>Price</th><th>Size</th><th class="hm">Notional</th><th class="hm">Fee</th><th>Closed PnL</th><th class="hm">Account</th></tr></thead><tbody></tbody></table></div>
        <div id="fiMore" class="more"></div>
      </div>`;
    $('#fiMore').addEventListener('click', (e) => { if (e.target.closest('button')) { S.fillsLimit += 200; this.update(S.summary); } });
    loadFills();
  },
  update(s) {
    if (Date.now() - S.fillsAt > 60_000) { S.fillsAt = Date.now(); loadFills(); }
    const ps = s.positions || [];
    const upnl = ps.reduce((t, p) => t + (p.upnl || 0), 0);
    const notional = ps.reduce((t, p) => t + Math.abs(p.value || 0), 0);
    const margin = ps.reduce((t, p) => t + (p.margin || 0), 0);
    const funding = ps.reduce((t, p) => t - (p.funding || 0), 0);
    const net = ps.reduce((t, p) => t + Math.sign(p.size) * Math.abs(p.value || 0), 0);
    setHTML($('#poTiles'),
      tile('Open positions', String(ps.length), ps.length ? `${ps.filter((p) => p.size > 0).length} long · ${ps.filter((p) => p.size < 0).length} short` : 'none')
      + tile('Notional', compactUsd(notional), ps.length ? `net ${net >= 0 ? 'long' : 'short'} ${compactUsd(Math.abs(net))}` : '')
      + tile('Unrealized PnL', usd(upnl, { sign: true }), margin ? `${pct(upnl / margin)} on margin` : '', pnlCls(upnl))
      + tile('Margin used', compactUsd(margin), notional && margin ? `${(notional / margin).toFixed(1)}× effective` : '')
      + tile('Funding', usd(funding, { sign: true }), 'since positions opened', pnlCls(funding))
      + tile('Realized PnL', usd(s.perpRealized, { sign: true }), 'closed trades, after fees', pnlCls(s.perpRealized)));
    setHTML($('#poN'), ps.length ? `${ps.length}` : '');
    syncRows($('#poTable tbody'), ps.length ? ps.map((p) => {
      const long = p.size > 0;
      const dist = isNum(p.liq_px) && p.mark_px ? (p.liq_px - p.mark_px) / p.mark_px : null;
      const fund = isNum(p.funding) ? -p.funding : null;
      return {
        key: `${p.account_id}|${p.venue}|${p.coin}`,
        cells: [
          { h: `<div class="asset">${avatar(p.coin, true)}<div class="asset-t"><span class="sym">${esc(clip(p.coin, 14))}</span></div></div>` },
          { h: `<span class="tag ${long ? 'buy' : 'sell'}">${long ? 'LONG' : 'SHORT'}</span>` },
          { h: qty(Math.abs(p.size)) },
          { h: priceH(p.entry_px), c: 'hm' },
          { h: priceH(p.mark_px), v: p.mark_px },
          { h: money(Math.abs(p.value)), v: Math.abs(p.value) },
          { h: pnlCell(p.upnl, p.margin ? p.upnl / p.margin : null), c: 'two', v: p.upnl },
          { h: isNum(p.leverage) && p.leverage ? `${+p.leverage.toFixed(1)}×` : '<span class="dim">—</span>', c: 'hm' },
          { h: isNum(p.liq_px) ? `${priceH(p.liq_px)}${isNum(dist) ? `<small class="${Math.abs(dist) < 0.1 ? 'warn' : ''}">${pct(dist)} away</small>` : ''}` : '<span class="dim">—</span>', c: 'two' },
          { h: isNum(fund) && Math.abs(fund) >= 0.005 ? `<span class="${pnlCls(fund)}">${usd(fund, { sign: true })}</span>` : '<span class="dim">—</span>', c: 'hm' },
          { h: `<span class="dim">${esc(clip(accountLabel(p.account_id), 18))}</span>`, c: 'hm' },
        ],
      };
    }) : emptyRow(10, 'No open perp positions.'));

    const fills = S.fills;
    const tbody = $('#fiTable tbody');
    if (!fills) { syncRows(tbody, emptyRow(9, '<span class="spin"></span>Loading fills…')); return; }
    const shown = fills.slice(0, S.fillsLimit);
    setHTML($('#fiN'), fills.length ? `${fills.length}${fills.length >= 500 ? '+' : ''}` : '');
    const seen = new Map();
    syncRows(tbody, shown.length ? shown.map((f) => {
      let k = String(f.id);
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      if (n > 1) k += `#${n}`;
      const dir = String(f.dir || '');
      return {
        key: k,
        cells: [
          { h: dateTime(f.ts) },
          { h: `<span class="sym">${esc(clip(f.coin, 14))}</span>` },
          { h: `<span class="tag">${esc(clip(dir || '—', 22))}</span>` },
          { h: priceH(f.px) },
          { h: qty(f.sz) },
          { h: money(f.px * f.sz), c: 'hm' },
          { h: f.fee ? `<span class="dim">${usd(f.fee)}</span>` : '<span class="dim">—</span>', c: 'hm' },
          { h: f.closed_pnl ? `<span class="${pnlCls(f.closed_pnl)}">${usd(f.closed_pnl, { sign: true })}</span>` : '<span class="dim">—</span>' },
          { h: `<span class="dim">${esc(clip(accountLabel(f.account_id), 18))}</span>`, c: 'hm' },
        ],
      };
    }) : emptyRow(9, S.fillsErr ? `Could not load fills: ${esc(S.fillsErr)}` : 'No perp fills yet.'));
    setHTML($('#fiMore'), fills.length > shown.length ? `<button type="button" class="link">Show more (${fills.length - shown.length} older)</button>` : '');
  },
};

// ───────────────────────── accounts ─────────────────────────
function accountHoldings(s, id) {
  const out = [];
  for (const a of s.assets) for (const h of a.holdings) if (h.account === id) out.push({ ...h, group: a.group });
  return out.sort((x, y) => y.value - x.value);
}
// The Accounts page is where accounts are managed: a searchable, sortable table; a row expands to its
// holdings and any failing sources; the ⋮ menu edits, disables or deletes; Add/Edit opens the form above.
const AC = { sort: prefs.get('acSort', { key: 'value', dir: -1 }), q: '', menu: null, autoOpened: false };
const CHAIN_NAME = { hyperliquid: 'Hyperliquid', ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', robinhood: 'Robinhood', polygon: 'Polygon', solana: 'Solana', pearl: 'Pearl' };
const chainName = (c) => CHAIN_NAME[c] || (c ? String(c)[0].toUpperCase() + String(c).slice(1) : '');

function accountRows(s) {
  const live = new Map((s?.accounts || []).map((a) => [a.id, a]));
  const base = ST.data ? ST.data.accounts : (s?.accounts || []).map((a) => ({ ...a, enabled: true }));
  return base.map((a) => {
    const hs = s ? accountHoldings(s, a.id) : [];
    const failing = (s?.status || []).filter((x) => !x.ok && String(x.source).split(':').includes(a.id));
    // sources = where this account actually has balances (Hyperliquid first, then chains by value)
    const byChain = new Map();
    for (const h of hs) if (h.chain) byChain.set(h.chain, (byChain.get(h.chain) || 0) + h.value);
    const skip = new Set([a.exchange, 'manual', a.type === 'solana' ? 'solana' : null, a.type === 'pearl' ? 'pearl' : null]);
    const sources = [...byChain.entries()].filter(([c]) => !skip.has(c))
      .sort((x, y) => (y[0] === 'hyperliquid') - (x[0] === 'hyperliquid') || y[1] - x[1]).map(([c]) => c);
    return { ...a, value: live.get(a.id)?.value ?? 0, hs, failing, sources };
  });
}
function accountDetail(a) {
  const fails = a.failing.map((x) => `<div class="acc-fail"><i class="sdot warn"></i><span class="fs">${esc(clip(sourceLabel(x.source), 44))}</span><span class="fm">${esc(clip(x.message || 'failed', 200))}</span><span class="ft">${agoSpan(x.updated_at)}</span></div>`).join('');
  const rows = a.hs.map((h) => `<tr class="click" data-group="${esc(h.group)}"><td><div class="asset">${avatar(h.group, true)}<div class="asset-t"><span class="sym">${esc(clip(h.symbol || h.group, 16))}</span><small class="mo">${esc(chainName(h.chain))}</small></div></div></td>
    <td class="hm">${h.chain ? `<span class="pill">${esc(clip(chainName(h.chain), 16))}</span>` : ''}${holdingNote(h)}</td><td>${qty(h.qty)}</td><td class="hm">${priceH(h.price)}</td><td>${money(h.value)}</td></tr>`).join('');
  const body = a.hs.length
    ? `<table><thead><tr><th>Asset</th><th class="hm">Chain</th><th>Amount</th><th class="hm">Price</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="acc-none">${a.enabled ? 'No balances found for this account yet. A first sync can take a minute.' : 'This account is disabled, so it is not synced or counted.'}</div>`;
  return `<div class="acc-detail">${fails ? `<div class="acc-fails">${fails}</div>` : ''}${body}</div>`;
}

const accounts = {
  mount(el) {
    ST.editing = null;
    ST.confirmDel = null;
    AC.menu = null;
    this.el = el;
    el.innerHTML = `
      <div class="pagehead"><h2>Accounts <span id="acN"></span></h2><button type="button" class="outline" id="acAdd">Add account</button></div>
      <div id="acForm"></div>
      <div class="panel flush">
        <label class="tsearch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
          <input id="acSearch" type="search" placeholder="Search accounts" autocomplete="off" spellcheck="false" aria-label="Search accounts" value="${esc(AC.q)}"></label>
        <div class="scroll"><table id="acTable" class="tbl-ac">
          <thead><tr><th class="sort" data-sort="label" tabindex="0">Name</th><th class="hm">Address</th><th class="hm">Type</th><th class="hm">Sources</th><th class="sort" data-sort="value" tabindex="0">Balance</th><th aria-label="Actions"></th></tr></thead>
          <tbody></tbody></table></div>
      </div>
      <div id="acMenu" class="menu" hidden role="menu"></div>`;
    $('#acSearch').addEventListener('input', (e) => { AC.q = e.target.value; this.update(S.summary); });
    const sortBy = (th) => {
      const k = th.dataset.sort;
      AC.sort = AC.sort.key === k ? { key: k, dir: -AC.sort.dir } : { key: k, dir: k === 'label' ? 1 : -1 };
      prefs.set('acSort', AC.sort);
      this.update(S.summary);
    };
    el.addEventListener('keydown', (e) => {
      const th = e.target.closest?.('th.sort');
      if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sortBy(th); }
    });
    el.addEventListener('click', async (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) { copyText(copy.dataset.copy); return; }
      if (e.target.closest('#acAdd')) { this.closeMenu(); this.openForm('new'); return; }
      if (e.target.closest('#formCancel')) { this.openForm(null); return; }
      if (e.target.closest('#mAdd')) { $('#mrows').insertAdjacentHTML('beforeend', manualRow()); $('#mrows').lastElementChild.querySelector('input').focus(); return; }
      const rm = e.target.closest('.mrow .rm');
      if (rm) { const rows = $$('#mrows .mrow'); if (rows.length > 1) rm.closest('.mrow').remove(); else for (const i of $$('input', rows[0])) i.value = ''; return; }
      const th = e.target.closest('th.sort');
      if (th) { sortBy(th); return; }
      const keb = e.target.closest('.kebab');
      if (keb) { const id = keb.closest('tr').dataset.key; if (AC.menu === id) this.closeMenu(); else this.openMenu(id, keb); return; }
      const act = e.target.closest('[data-act]');
      if (act) { await this.action(act.dataset.act, act.dataset.id); return; }
      if (e.target.closest('#acForm') || e.target.closest('#acMenu')) return;
      const hold = e.target.closest('tr[data-group]');
      if (hold) { openAsset(hold.dataset.group); return; }
      const tr = e.target.closest('#acTable > tbody > tr.acc');
      if (tr) {
        const id = tr.dataset.key;
        if (S.accExpanded.has(id)) S.accExpanded.delete(id); else S.accExpanded.add(id);
        this.update(S.summary);
      }
    });
    el.addEventListener('change', (e) => {
      if (e.target.id === 'f_type') { $('#typeFields').innerHTML = typeFieldsHtml(e.target.value, null); $('#formErr').textContent = ''; }
    });
    el.addEventListener('input', (e) => { if (e.target.closest('#acctForm')) { $('#formErr').textContent = ''; e.target.classList.remove('bad'); } });
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      if (form.id !== 'acctForm') return;
      const btn = $('button[type=submit]', form);
      if (btn.disabled) return;
      const { body, error, focus } = collectAccountForm(form);
      const err = $('#formErr');
      if (error) { err.textContent = error; const f = focus && $(`#${focus}`); if (f) { f.classList.add('bad'); f.focus(); } return; }
      btn.disabled = true;
      try {
        await api('/api/accounts', 'POST', body);
        toast(body.id ? 'Account saved' : 'Account added. First sync is running');
        this.openForm(null);
        await loadAccounts();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    // the ⋮ menu is a fixed-position popover: it follows its row on scroll and closes on an outside click, Escape or resize
    this.onDoc = (e) => { if (AC.menu && !e.composedPath().some((n) => n.id === 'acMenu' || n.classList?.contains('kebab'))) this.closeMenu(); };
    this.onKey = (e) => { if (e.key === 'Escape' && AC.menu) { e.preventDefault(); this.closeMenu(); } };
    this.onMove = (e) => { if (!AC.menu) return; if (e.type === 'resize' || !this.anchor?.isConnected) this.closeMenu(); else this.placeMenu(); };
    document.addEventListener('click', this.onDoc);
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('scroll', this.onMove, { passive: true, capture: true });
    window.addEventListener('resize', this.onMove);
    this.update(S.summary);
    loadAccounts();
  },
  unmount() {
    document.removeEventListener('click', this.onDoc);
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('scroll', this.onMove, { capture: true });
    window.removeEventListener('resize', this.onMove);
    AC.menu = null;
    ST.editing = null;
  },
  openForm(id) {
    ST.editing = id;
    ST.confirmDel = null;
    const box = $('#acForm');
    if (!box) return;
    if (id == null) { box.innerHTML = ''; $('#acAdd').hidden = false; this.update(S.summary); return; }
    const a = id === 'new' ? null : ST.data?.accounts.find((x) => x.id === id);
    box.innerHTML = `<div class="panel formpanel">${accountFormHtml(a)}</div>`;
    $('#acAdd').hidden = true;
    (a ? $('#f_label') : $('#f_type'))?.focus({ preventScroll: true });
    box.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    this.update(S.summary);
  },
  menuHtml(a) {
    const id = esc(a.id);
    if (ST.confirmDel === a.id) {
      return `<div class="menu-confirm">Delete <b>${esc(clip(a.label, 24))}</b> and its history?<div><button type="button" class="small danger" data-act="del-yes" data-id="${id}">Delete</button><button type="button" class="small" data-act="del-no" data-id="${id}">Cancel</button></div></div>`;
    }
    return `<button type="button" role="menuitem" data-act="edit" data-id="${id}">Edit</button>
      <button type="button" role="menuitem" data-act="toggle" data-id="${id}">${a.enabled ? 'Disable' : 'Enable'}</button>
      <button type="button" role="menuitem" class="danger" data-act="del" data-id="${id}">Delete</button>`;
  },
  openMenu(id, anchor) {
    const a = ST.data?.accounts.find((x) => x.id === id);
    const menu = $('#acMenu');
    if (!a || !menu) return;
    AC.menu = id;
    ST.confirmDel = null;
    this.anchor = anchor;
    menu.innerHTML = this.menuHtml(a);
    menu.hidden = false;
    this.placeMenu();
    menu.querySelector('button')?.focus({ preventScroll: true });
  },
  placeMenu() {
    const menu = $('#acMenu');
    if (!menu || !this.anchor?.isConnected) return;
    const r = this.anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const top = r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  },
  closeMenu() {
    AC.menu = null;
    ST.confirmDel = null;
    const menu = $('#acMenu');
    if (menu) { menu.hidden = true; menu.innerHTML = ''; }
  },
  async action(act, id) {
    const a = ST.data?.accounts.find((x) => x.id === id);
    if (!a || ST.busy) return;
    if (act === 'edit') { this.closeMenu(); this.openForm(id); return; }
    if (act === 'del') { ST.confirmDel = id; $('#acMenu').innerHTML = this.menuHtml(a); this.placeMenu(); return; }
    if (act === 'del-no') { this.closeMenu(); return; }
    ST.busy = true;
    try {
      if (act === 'del-yes') {
        await api(`/api/accounts/${encodeURIComponent(id)}`, 'DELETE', {});
        toast('Account deleted');
        S.accExpanded.delete(id);
        if (ST.editing === id) this.openForm(null);
      } else if (act === 'toggle') {
        const body = { id: a.id, label: a.label, type: a.type, address: a.address, exchange: a.exchange, enabled: !a.enabled };
        if (a.chains?.length) body.chains = a.chains;
        await api('/api/accounts', 'POST', body);
        toast(a.enabled ? 'Account disabled' : 'Account enabled');
      }
    } catch (err) { toast(`Could not update: ${err.message}`, 'err'); }
    ST.busy = false;
    this.closeMenu();
    await loadAccounts();
  },
  update(s) {
    const tbody = $('#acTable tbody');
    if (!tbody) return;
    for (const th of $$('#acTable th.sort')) {
      if (th.dataset.sort === AC.sort.key) th.setAttribute('aria-sort', AC.sort.dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
    }
    const all = accountRows(s);
    setHTML($('#acN'), ST.data || s ? String(all.length) : '');
    if (ST.data && !all.length && !AC.autoOpened && ST.editing == null) { AC.autoOpened = true; this.openForm('new'); return; }
    const q = AC.q.trim().toLowerCase();
    let list = q ? all.filter((a) => `${a.label} ${a.address || ''} ${typeLabel(a)} ${a.sources.map(chainName).join(' ')}`.toLowerCase().includes(q)) : all;
    const { key, dir } = AC.sort;
    list = [...list].sort((x, y) => (key === 'label'
      ? String(x.label).localeCompare(String(y.label), undefined, { sensitivity: 'base' }) * dir
      : ((x.value - y.value) * dir || String(x.label).localeCompare(String(y.label)))));
    if (!list.length) {
      syncRows(tbody, emptyRow(6, !ST.data && !s ? '<span class="spin"></span>Loading accounts…' : ST.error && !all.length ? `Could not load accounts: ${esc(ST.error)}`
        : q ? 'No accounts match that search.' : 'No accounts yet. Add a wallet address or a read-only exchange key to start tracking.'));
      return;
    }
    syncRows(tbody, list.map((a) => {
      const open = S.accExpanded.has(a.id);
      const state = !a.enabled ? 'off' : a.failing.length ? 'warn' : 'ok';
      const stateTitle = !a.enabled ? 'Disabled' : a.failing.length ? `${a.failing.length} source${a.failing.length === 1 ? '' : 's'} failing` : 'All sources ok';
      const addr = a.type === 'cex' ? (a.apiKey ? `<span class="dim" title="API key (masked)${a.hasSecret ? ', secret stored' : ''}">key ${esc(a.apiKey)}</span>` : '')
        : a.address ? `<button type="button" class="tx" data-copy="${esc(a.address)}" title="Copy ${esc(a.address)}">${esc(shortAddr(a.address))}</button>`
          : a.type === 'manual' ? `<span class="dim">${a.extra?.holdings?.length ?? a.hs.length} holdings</span>` : '';
      const src = a.sources.slice(0, 3).map((c) => `<span class="pill${c === 'hyperliquid' ? ' hl' : ''}">${esc(clip(chainName(c), 14))}</span>`).join('')
        + (a.sources.length > 3 ? `<span class="pill" title="${esc(a.sources.slice(3).map(chainName).join(', '))}">+${a.sources.length - 3}</span>` : '');
      return {
        key: a.id,
        cls: `acc click${open ? ' open' : ''}${a.enabled ? '' : ' off'}${ST.editing === a.id ? ' editing' : ''}`,
        cells: [
          { h: `<div class="acc-name"><i class="sdot ${state}" title="${stateTitle}"></i><div class="asset-t"><span class="nm">${esc(clip(a.label, 30))}</span><small class="mo">${esc(typeLabel(a))}${a.enabled ? '' : ' · disabled'}</small></div>${a.enabled ? '' : '<span class="pill dk">disabled</span>'}</div>` },
          { h: addr, c: 'hm addr' },
          { h: `<span class="pill">${esc(typeLabel(a))}</span>`, c: 'hm' },
          { h: src, c: 'hm' },
          { h: a.enabled ? money(a.value) : '<span class="dim">—</span>', v: a.enabled ? a.value : undefined },
          { h: `<button type="button" class="kebab" aria-label="Actions for ${esc(clip(a.label, 30))}" aria-haspopup="menu"><i></i></button>`, c: 'kb' },
        ],
        detail: open ? accountDetail(a) : null,
      };
    }));
  },
};

// ───────────────────────── settings ─────────────────────────
const ST = { data: null, error: null, editing: null, confirmDel: null, busy: false };
const ACCOUNT_TYPES = [
  ['evm', 'EVM wallet (all EVM chains + Hyperliquid)'],
  ['solana', 'Solana wallet'],
  ['pearl', 'Pearl wallet'],
  ['cex', 'Exchange (read-only API key)'],
  ['manual', 'Manual holdings'],
];
const EXCHANGES = [['kraken', 'Kraken'], ['binance', 'Binance']];
const TYPE_HINT = {
  evm: 'Paste any 0x address. The main EVM chains are scanned automatically, and the same address is checked on Hyperliquid too (spot, staking and perps): there is no separate Hyperliquid account to add. Only the public address is needed, so the tracker can never move funds.',
  solana: 'Paste a Solana address (base58). SOL and SPL token balances and history are read from public RPC.',
  pearl: 'Paste a Pearl address starting with prl1.',
  cex: 'Create an API key with read-only permission on the exchange (no trading, no withdrawals) and paste it here.',
  manual: 'For anything without an API: type the holdings in yourself. Give a USD price per unit to value it.',
};
const VALID = {
  evm: (a) => /^0x[0-9a-fA-F]{40}$/.test(a) || 'Enter a 0x address (0x followed by 40 hex characters).',
  solana: (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) || 'Enter a Solana address (32 to 44 base58 characters).',
  pearl: (a) => /^prl1[0-9a-z]{20,90}$/.test(a) || 'Enter a Pearl address starting with prl1.',
};

async function loadAccounts() {
  try { ST.data = await api('/api/accounts'); ST.error = null; } catch (e) { ST.error = e.message; }
  if (S.view === 'settings') renderKeys(false);
  if (S.view === 'accounts') accounts.update(S.summary);
}

function manualRow(h = {}) {
  return `<div class="mrow"><input name="m_symbol" placeholder="Symbol, e.g. TSLA" autocomplete="off" spellcheck="false" value="${esc(h.symbol || '')}" aria-label="Symbol">
    <input name="m_qty" placeholder="Amount" inputmode="decimal" autocomplete="off" value="${esc(h.qty ?? '')}" aria-label="Amount">
    <input name="m_usd" placeholder="USD price per unit" inputmode="decimal" autocomplete="off" value="${esc(h.usd ?? '')}" aria-label="USD price per unit">
    <button type="button" class="small rm" aria-label="Remove holding">✕</button></div>`;
}
function typeFieldsHtml(type, a) {
  const hint = `<p class="note tight span">${esc(TYPE_HINT[type] || '')}</p>`;
  if (type === 'cex') {
    return `${hint}
      <div><label for="f_exchange">Exchange</label><select id="f_exchange" name="exchange">${EXCHANGES.concat(a?.exchange && !EXCHANGES.some(([k]) => k === a.exchange) ? [[a.exchange, a.exchange]] : [])
    .map(([k, v]) => `<option value="${esc(k)}"${a?.exchange === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      <div><label for="f_apiKey">API key</label><input id="f_apiKey" name="apiKey" autocomplete="off" spellcheck="false" placeholder="${a?.apiKey ? `${esc(a.apiKey)} · leave blank to keep` : 'paste read-only key'}"></div>
      <div><label for="f_secret">API secret</label><input id="f_secret" name="secret" type="password" autocomplete="new-password" placeholder="${a?.hasSecret ? '•••••••• stored · leave blank to keep' : 'paste secret'}"></div>
      <div><label for="f_password">Passphrase <span class="dim">(only if the exchange gives one)</span></label><input id="f_password" name="password" type="password" autocomplete="new-password" placeholder="optional"></div>`;
  }
  if (type === 'manual') {
    const hs = a?.extra?.holdings?.length ? a.extra.holdings : [{}];
    return `${hint}<div class="span"><label>Holdings</label><div id="mrows">${hs.map(manualRow).join('')}</div>
      <button type="button" class="small" id="mAdd">+ Add holding</button></div>`;
  }
  const ph = type === 'solana' ? 'e.g. 7xKX…gAsU' : type === 'pearl' ? 'prl1…' : '0x…';
  let adv = '';
  const chains = ST.data?.chains || [];
  if (type === 'evm' && chains.length) {
    const custom = a?.chains?.length ? new Set(a.chains) : null;
    adv = `<details class="adv span"${custom ? ' open' : ''}><summary>Advanced: choose which chains to scan <span class="dim">(optional)</span></summary>
      <p class="note tight">Leave as is to scan the default chains. Tick more to include chains that are off by default, or untick ones you never use. Hyperliquid is always checked.</p>
      <div class="chips">${chains.map((c) => `<label class="chip"><input type="checkbox" name="chain" value="${esc(c.name)}"${(custom ? custom.has(c.name) : c.default) ? ' checked' : ''}> ${esc(c.name)}${c.default ? ' <span class="dim">default</span>' : ''}</label>`).join('')}</div></details>`;
  }
  return `${hint}<div class="span2"><label for="f_address">Address</label><input id="f_address" name="address" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${ph}" value="${esc(a?.address || '')}"></div>${adv}`;
}
function accountFormHtml(a) {
  const type = a?.type || 'evm';
  const types = a && !ACCOUNT_TYPES.some(([k]) => k === a.type) ? ACCOUNT_TYPES.concat([[a.type, TYPE_LABEL[a.type] || a.type]]) : ACCOUNT_TYPES;
  return `<form id="acctForm" class="form" novalidate autocomplete="off">
    <h4>${a ? `Edit ${esc(clip(a.label, 30))}` : 'Add account'}</h4>
    <div class="fields">
      <div><label for="f_type">Type</label><select id="f_type" name="type"${a ? ' disabled' : ''}>${types.map(([k, v]) => `<option value="${esc(k)}"${k === type ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      <div><label for="f_label">Label</label><input id="f_label" name="label" autocomplete="off" maxlength="60" placeholder="e.g. Main wallet" value="${esc(a?.label || '')}"></div>
      <div id="typeFields" class="fields span">${typeFieldsHtml(type, a)}</div>
    </div>
    <div class="form-err" id="formErr" role="alert"></div>
    <div class="form-actions">
      ${a ? `<label class="check"><input type="checkbox" name="enabled" ${a.enabled ? 'checked' : ''}> Enabled</label>` : ''}
      <span class="grow"></span>
      <button type="button" id="formCancel">Cancel</button>
      <button type="submit" class="primary">${a ? 'Save changes' : 'Add account'}</button>
    </div>
  </form>`;
}

/** Key + interval forms. Only rebuilt on first load or after a save, never while typing. */
function renderKeys(force) {
  const box = $('#stKeys');
  if (!box || !ST.data) return;
  if (!force && box.dataset.ready) return;
  const st = ST.data.settings || {};
  const r = st.refresh || {};
  box.dataset.ready = '1';
  const own = Array.isArray(st.otherOwnAddresses) ? st.otherOwnAddresses : [];
  box.innerHTML = `
    <form id="bsForm" class="form" novalidate autocomplete="off">
      <div class="fields">
        <div class="span2"><label for="f_bs">Blockscout API key <span class="dim">(free · needed for Base, Arbitrum and Robinhood Chain)</span></label>
          <input id="f_bs" name="blockscoutKey" type="password" autocomplete="off" spellcheck="false" placeholder="${st.blockscoutKey ? 'key saved (' + esc(st.blockscoutKey) + ') · paste a new one to replace' : 'proapi_…'}"></div>
        <div class="end"><button type="submit">Save key</button></div>
      </div>
      <p class="note tight">${st.blockscoutKey ? 'A key is saved. ' : '<b class="warn">No key yet.</b> '}Some chain explorers only answer requests that carry an API key. Create a free one at dev.blockscout.com and paste it here: one key covers every EVM chain. It is stored only in the local database on this machine.</p>
      <div class="form-err" id="bsErr" role="alert"></div>
    </form>
    <form id="alForm" class="form" novalidate autocomplete="off">
      <div class="fields">
        <div class="span2"><label for="f_al">Alchemy API key <span class="dim">(needed for Base · fallback elsewhere)</span></label>
          <input id="f_al" name="alchemyKey" type="password" autocomplete="off" spellcheck="false" placeholder="${st.alchemyKey ? 'key saved (' + esc(st.alchemyKey) + ') · paste a new one to replace' : 'paste your Alchemy API key'}"></div>
        <div class="end"><button type="submit">Save key</button></div>
      </div>
      <p class="note tight">${st.alchemyKey ? 'A key is saved. ' : '<b class="warn">No key yet.</b> '}Blockscout (free) is used wherever it works. Alchemy is only called for Base, which Blockscout's free plan does not cover, and as a fallback when a wallet's history cannot be read from Blockscout. To keep request counts low, Alchemy balances refresh every 10 minutes and history hourly. Enable the networks you want in your Alchemy app and paste its API key here. Stored only in the local database on this machine.</p>
      <div class="form-err" id="alErr" role="alert"></div>
    </form>
    <form id="histForm" class="form" novalidate autocomplete="off">
      <div class="fields">
        <div class="span2"><label>Chart history</label><p class="note tight">Clears the stored portfolio-value snapshots behind the Overview chart, for example after a data glitch. Balances, trades and cost basis are not affected.</p></div>
        <div class="end"><button type="submit" id="histReset">Reset chart history</button></div>
      </div>
      <div class="form-err" id="histErr" role="alert"></div>
    </form>
    <form id="rpcForm" class="form" novalidate autocomplete="off">
      <div class="fields">
        <div class="span2"><label for="f_rpc">Custom Solana RPC URL <span class="dim">(optional)</span></label>
          <input id="f_rpc" name="solanaRpc" type="url" autocomplete="off" spellcheck="false" placeholder="${st.solanaRpc ? 'custom RPC saved · paste a new URL to replace' : 'https://… (default: public mainnet RPC)'}"></div>
        <div class="end"><button type="submit">Save RPC</button>${st.solanaRpc ? ' <button type="button" id="rpcClear">Use default</button>' : ''}</div>
      </div>
      <p class="note tight">Not required. The public Solana RPC is slow and rate-limited; a private endpoint makes Solana balances and history sync faster. ${st.solanaRpc ? 'A custom endpoint is saved (not shown, as these URLs usually contain an API key).' : ''}</p>
      <div class="form-err" id="rpcErr" role="alert"></div>
    </form>
    <form id="ownForm" class="form" novalidate autocomplete="off">
      <div class="fields">
        <div class="span2"><label for="f_own">Other addresses you own <span class="dim">(one per line)</span></label>
          <textarea id="f_own" name="own" rows="${Math.min(8, Math.max(3, own.length + 1))}" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="0x…">${esc(own.join('\n'))}</textarea></div>
        <div class="end"><button type="submit">Save addresses</button></div>
      </div>
      <p class="note tight">Transfers to or from these addresses are treated as internal moves between your own wallets: they keep their cost basis instead of counting as a deposit or a withdrawal. Useful for old wallets or cold storage you do not track here. Accounts you track are already included.</p>
      <div class="form-err" id="ownErr" role="alert"></div>
    </form>
    <form id="refForm" class="form" novalidate autocomplete="off">
      <div class="fields four">
        <div><label for="r_p">Prices, every (s)</label><input id="r_p" name="pricesSeconds" inputmode="numeric" value="${esc(r.pricesSeconds ?? '')}"></div>
        <div><label for="r_h">Hyperliquid, every (s)</label><input id="r_h" name="hyperliquidSeconds" inputmode="numeric" value="${esc(r.hyperliquidSeconds ?? '')}"></div>
        <div><label for="r_b">Balances, every (s)</label><input id="r_b" name="balancesSeconds" inputmode="numeric" value="${esc(r.balancesSeconds ?? '')}"></div>
        <div><label for="r_t">History, every (min)</label><input id="r_t" name="historyMinutes" inputmode="numeric" value="${esc(r.historyMinutes ?? '')}"></div>
        <div class="end"><button type="submit">Save intervals</button></div>
      </div>
      <div class="form-err" id="refErr" role="alert"></div>
    </form>`;
}
function renderSources(s) {
  const box = $('#stSources');
  if (!box || !s) return;
  const list = [...(s.status || [])].sort((a, b) => (a.ok - b.ok) || String(a.source).localeCompare(String(b.source)));
  const bad = list.filter((x) => !x.ok).length;
  setHTML($('#stSrcN'), list.length ? (bad ? `<span class="down">${bad} failing</span> · ${list.length - bad} ok` : `all ${list.length} ok`) : '');
  setHTML(box, list.length ? list.map((x) => `<div class="src ${x.ok ? 'ok' : 'bad'}"><i class="dot ${x.ok ? 'ok' : 'bad'}"></i>
      <span class="sn">${esc(clip(sourceLabel(x.source), 44))}</span><span class="sm" title="${esc(x.message)}">${x.ok ? '' : '<b>error</b> '}${esc(clip(x.message || (x.ok ? 'ok' : 'failed'), 160))}</span>
      <span class="st">${agoSpan(x.updated_at)}</span></div>`).join('')
    : '<div class="empty">No data sources have run yet.</div>');
}

function collectAccountForm(form) {
  const existing = ST.editing && ST.editing !== 'new' ? ST.data.accounts.find((x) => x.id === ST.editing) : null;
  const fd = new FormData(form);
  const get = (k) => String(fd.get(k) ?? '').trim();
  const type = existing?.type || get('type');
  const b = { type, label: get('label') };
  if (existing) { b.id = existing.id; b.enabled = !!form.elements.enabled?.checked; }
  if (!b.label) return { error: 'Give the account a label.', focus: 'f_label' };
  if (type === 'cex') {
    b.exchange = get('exchange');
    for (const k of ['apiKey', 'secret', 'password']) if (get(k)) b[k] = get(k);
    if (!b.exchange) return { error: 'Choose an exchange.', focus: 'f_exchange' };
    if (!existing && !b.apiKey) return { error: 'Paste the read-only API key.', focus: 'f_apiKey' };
    if (!existing && !b.secret) return { error: 'Paste the API secret.', focus: 'f_secret' };
  } else if (type === 'manual') {
    const old = existing?.extra?.holdings || [];
    const holdings = [];
    for (const row of $$('.mrow', form)) {
      const sym = $('[name=m_symbol]', row).value.trim().toUpperCase();
      const q = $('[name=m_qty]', row).value.trim();
      const u = $('[name=m_usd]', row).value.trim();
      if (!sym && !q && !u) continue;
      if (!sym) return { error: 'Every holding needs a symbol.' };
      const qn = parseNum(q);
      if (!(qn > 0)) return { error: `Enter an amount for ${sym}.` };
      const h = { ...(old.find((o) => String(o.symbol).toUpperCase() === sym) || {}), symbol: sym, qty: qn };
      if (u) {
        const un = parseNum(u);
        if (!(un >= 0)) return { error: `The USD price for ${sym} is not a number.` };
        h.usd = un;
        if (!h.price || String(h.price).startsWith('manual:')) h.price = `manual:${sym}`;
      } else delete h.usd;
      holdings.push(h);
    }
    if (!holdings.length) return { error: 'Add at least one holding.' };
    b.extra = { ...(existing?.extra || {}), holdings };
  } else {
    b.address = get('address');
    const ok = (VALID[type] || (() => !!b.address || 'Enter an address.'))(b.address);
    if (ok !== true) return { error: ok, focus: 'f_address' };
    if (type === 'evm') {
      const all = ST.data?.chains || [];
      const boxes = $$('input[name=chain]', form);
      const picked = boxes.filter((x) => x.checked).map((x) => x.value);
      const defaults = all.filter((c) => c.default).map((c) => c.name);
      const same = picked.length === defaults.length && defaults.every((n) => picked.includes(n));
      // no boxes rendered (chain list not loaded): keep whatever the account had
      if (!boxes.length) { if (existing?.chains?.length) b.chains = existing.chains; } else if (picked.length && !same) b.chains = picked;
    }
  }
  return { body: b };
}

const settings = {
  mount(el) {
    el.innerHTML = `
      <div class="callout privacy"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>
        <div><b>Everything stays on this machine.</b> Addresses, API keys and your history are stored only in the local database file next to this app.
        The server listens on localhost only, and this page loads no scripts, fonts or images from the internet. Exchange API keys are saved only in that local database, are shown masked, and are never sent back to the browser. Always use read-only keys.</div></div>
      <p class="note pointer">Accounts are managed on the <a href="#accounts">Accounts page</a>.</p>
      <div class="panel"><h3><span>API keys, tracking &amp; refresh</span></h3><div id="stKeys"><div class="empty"><span class="spin"></span>Loading…</div></div></div>
      <div class="panel"><h3><span>Data sources</span><span id="stSrcN"></span></h3><div id="stSources" class="srcs"></div></div>`;
    renderKeys(true);
    loadAccounts();

    el.addEventListener('click', async (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) { copyText(copy.dataset.copy); return; }
      if (e.target.closest('#rpcClear')) {
        try { await api('/api/settings', 'POST', { solanaRpc: '' }); toast('Using the default Solana RPC'); await loadAccounts(); renderKeys(true); } catch (ex) { toast(`Could not save: ${ex.message}`, 'err'); }
        return;
      }
    });
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const btn = $('button[type=submit]', form);
      if (btn.disabled) return;
      if (form.id === 'ownForm') {
        const err = $('#ownErr');
        err.textContent = '';
        const lines = [...new Set(form.elements.own.value.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean))];
        const bad = lines.find((x) => !(/^0x[0-9a-fA-F]{40}$/.test(x) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x) || /^prl1[0-9a-z]{20,90}$/.test(x)));
        if (bad) { err.textContent = `“${clip(bad, 50)}” does not look like a wallet address (0x…, Solana or prl1…).`; form.elements.own.focus(); return; }
        btn.disabled = true;
        try {
          await api('/api/settings', 'POST', { otherOwnAddresses: lines.map((x) => (x.startsWith('0x') ? x.toLowerCase() : x)) });
          toast('Addresses saved. History is being reclassified');
          await loadAccounts();
          renderKeys(true);
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      } else if (form.id === 'bsForm') {
        const err = $('#bsErr');
        err.textContent = '';
        const key = form.elements.blockscoutKey.value.trim();
        if (!key) { err.textContent = 'Paste an API key first.'; return; }
        btn.disabled = true;
        try { await api('/api/settings', 'POST', { blockscoutKey: key }); toast('Blockscout key saved. Refreshing wallets'); await loadAccounts(); renderKeys(true); } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      } else if (form.id === 'alForm') {
        const err = $('#alErr');
        err.textContent = '';
        const key = form.elements.alchemyKey.value.trim();
        if (!key) { err.textContent = 'Paste an API key first.'; return; }
        btn.disabled = true;
        try { await api('/api/settings', 'POST', { alchemyKey: key }); toast('Alchemy key saved. Refreshing wallets'); await loadAccounts(); renderKeys(true); } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      } else if (form.id === 'histForm') {
        const err = $('#histErr');
        err.textContent = '';
        if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Click again to confirm'; return; }
        btn.disabled = true;
        try { await api('/api/history/reset', 'POST', {}); toast('Chart history cleared'); btn.dataset.armed = ''; btn.textContent = 'Reset chart history'; btn.disabled = false; } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      } else if (form.id === 'rpcForm') {
        const err = $('#rpcErr');
        err.textContent = '';
        const url = form.elements.solanaRpc.value.trim();
        if (!url) { err.textContent = 'Paste an RPC URL first.'; return; }
        if (!/^https?:\/\/\S+$/i.test(url)) { err.textContent = 'The RPC URL must start with https://'; form.elements.solanaRpc.focus(); return; }
        btn.disabled = true;
        try { await api('/api/settings', 'POST', { solanaRpc: url }); toast('Solana RPC saved'); await loadAccounts(); renderKeys(true); } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      } else if (form.id === 'refForm') {
        const min = { pricesSeconds: 5, hyperliquidSeconds: 5, balancesSeconds: 30, historyMinutes: 1 };
        const refresh = { ...(ST.data?.settings?.refresh || {}) };
        const err = $('#refErr');
        err.textContent = '';
        for (const [k, lo] of Object.entries(min)) {
          const v = parseNum(form.elements[k].value);
          if (!(v >= lo) || v > 86400) { err.textContent = `${form.elements[k].previousElementSibling.textContent}: enter a number of at least ${lo}.`; form.elements[k].focus(); return; }
          refresh[k] = Math.round(v);
        }
        btn.disabled = true;
        try { await api('/api/settings', 'POST', { refresh }); toast('Refresh intervals saved'); await loadAccounts(); renderKeys(true); } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      }
    });
  },
  update(s) {
    renderSources(s);
  },
};

// ───────────────────────── router ─────────────────────────
const views = { overview, assets, positions, accounts, settings };
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const i = raw.indexOf('/');
  const v = i < 0 ? raw : raw.slice(0, i);
  let group = null;
  if (i >= 0) { try { group = decodeURIComponent(raw.slice(i + 1)); } catch { group = null; } }
  return { view: VIEWS.includes(v) ? v : 'overview', group: group || null };
}
function route() {
  const { view, group } = parseHash();
  if (view !== S.view) {
    views[S.view]?.unmount?.();
    S.view = view;
    for (const a of $$('#nav a')) {
      const on = a.dataset.view === view;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    viewEl.innerHTML = '';
    viewEl.className = `view-${view}`;
    // listeners live on the section; swap in a clean node so views do not stack handlers
    const host = document.createElement('div');
    viewEl.appendChild(host);
    views[view].mount(host);
    if (S.summary) { try { views[view].update(S.summary); } catch (e) { console.error(e); } } else if (view !== 'settings') viewEl.insertAdjacentHTML('afterbegin', '<div class="boot" id="boot"><span class="spin"></span>Loading portfolio…</div>');
    window.scrollTo(0, 0);
  }
  if (group) showDrawer(group); else hideDrawer();
}
window.addEventListener('hashchange', route);

// ───────────────────────── boot ─────────────────────────
route();
setInterval(tick, 1000);
tick();
api('/api/summary').then((s) => { if (!S.summary) onSummary(s); }).catch(() => {});
connect();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !S.connected) pollOnce();
});
