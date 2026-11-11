// Local-only server: binds to 127.0.0.1, serves the UI, and keeps data fresh in the background.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadConfig } from './config.js';
import { autoChains } from './chains.js';
import { openDb, kvSet, setStatus } from './db.js';
import { log, nowSec } from './util.js';
import { syncEvmBalances, syncEvmHistory, evmForce } from './sources/evm.js';
import { refreshHlMarket, syncHlAccount, syncHlHistory } from './sources/hyperliquid.js';
import { syncCexBalances, syncCexHistory } from './sources/cex.js';
import { syncSolanaBalances, syncSolanaHistory } from './sources/solana.js';
import { syncPearl } from './sources/pearl.js';
import { syncManual } from './sources/manual.js';
import { refreshPrices, refreshTokenLists, markVerifiedFromLists } from './prices.js';
import { buildLedger } from './ledger.js';
import { buildSummary } from './portfolio.js';

const PORT = Number(process.env.PORT || 4321);
// Binds to localhost only by default. To serve it over a private network (e.g. Tailscale),
// set HOST to that interface's IP and ALLOWED_HOSTS to the hostnames you will browse to.
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', HOST, ...(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
const db = openDb();
let cfg = loadConfig(db);
let ledger = new Map();
let summary = null;
const clients = new Set();

// ---------- refresh loops ----------
const running = new Set();
let firstPassDone = false;
let jumpCount = 0;
async function guard(name, fn) {
  if (running.has(name)) return;
  running.add(name);
  try { await fn(); } catch (e) { log.warn(name, e.message); setStatus(db, name, false, e.message); } finally { running.delete(name); }
}

function publish() {
  summary = buildSummary(db, cfg, ledger);
  const msg = `data: ${JSON.stringify(summary)}\n\n`;
  for (const res of clients) res.write(msg);
}

// Every EVM wallet is also checked on Hyperliquid (same address, no key needed).
const hlAccounts = () => cfg.accounts.filter((a) => a.type === 'evm' && a.extra?.hyperliquid !== false);
const hasHl = () => hlAccounts().length > 0;

const jobs = {
  prices: () => guard('prices', async () => {
    if (hasHl()) await refreshHlMarket(db).catch((e) => setStatus(db, 'hyperliquid-market', false, e.message));
    await refreshPrices(db, cfg);
    publish();
  }),
  hl: () => guard('hl', async () => {
    for (const a of hlAccounts()) await syncHlAccount(db, cfg, a);
    publish();
  }),
  balances: () => guard('balances', async () => {
    for (const a of cfg.accounts) {
      if (a.type === 'evm') await syncEvmBalances(db, cfg, a);
      else if (a.type === 'solana') await syncSolanaBalances(db, cfg, a);
      else if (a.type === 'pearl') await syncPearl(db, cfg, a);
      else if (a.type === 'cex') await syncCexBalances(db, cfg, a);
      else if (a.type === 'manual') syncManual(db, cfg, a);
    }
    markVerifiedFromLists(db);
    firstPassDone = true;
    publish();
  }),
  // New Hyperliquid trades and transfers, picked up about once a minute for accounts that hold
  // something there, so a fresh buy gets its cost basis without waiting for the full history pass.
  hlFills: () => guard('hlFills', async () => {
    const active = new Set(db.prepare("SELECT DISTINCT account_id FROM balances WHERE asset LIKE 'hl:%' AND qty > 0").all().map((r) => r.account_id));
    let added = 0;
    for (const a of hlAccounts()) if (active.has(a.id)) added += (await syncHlHistory(db, cfg, a)) || 0;
    if (added) {
      ledger = await buildLedger(db, cfg).catch(() => ledger);
      publish();
    }
  }),
  history: () => guard('history', async () => {
    await refreshTokenLists(db, cfg).catch((e) => log.warn('token lists', e.message));
    const value = new Map((summary?.accounts || []).map((x) => [x.id, x.value]));
    const ordered = [...cfg.accounts].sort((x, y) => (value.get(y.id) || 0) - (value.get(x.id) || 0)); // biggest first
    for (const a of ordered) {
      if (a.type === 'evm') {
        await syncEvmHistory(db, cfg, a);
        if (a.extra?.hyperliquid !== false) await syncHlHistory(db, cfg, a);
      } else if (a.type === 'solana') await syncSolanaHistory(db, cfg, a);
      else if (a.type === 'cex') await syncCexHistory(db, cfg, a);
      // rebuild after each account so cost basis fills in progressively on first sync
      ledger = await buildLedger(db, cfg).catch(() => ledger);
      publish();
    }
    markVerifiedFromLists(db);
    await refreshPrices(db, cfg);
    ledger = await buildLedger(db, cfg);
    publish();
  }),
  snapshot: () => {
    if (!summary || !summary.total) return;
    // No snapshots until the first full balance pass after start, and none while a jump of more
    // than 40% is unconfirmed (it must persist for three checks): keeps glitches out of the chart.
    if (!firstPassDone) return;
    const last = db.prepare('SELECT total FROM snapshots ORDER BY ts DESC LIMIT 1').get();
    if (last && Math.abs(summary.total / last.total - 1) > 0.4 && ++jumpCount < 3) return;
    jumpCount = 0;
    const data = Object.fromEntries(summary.assets.slice(0, 40).map((a) => [a.group, Math.round(a.value * 100) / 100]));
    db.prepare('INSERT OR REPLACE INTO snapshots (ts, total, data) VALUES (?, ?, ?)').run(nowSec(), summary.total, JSON.stringify(data));
  },
};

async function refreshAll() {
  await jobs.balances();
  await jobs.hl();
  await jobs.history();
  await jobs.prices();
  jobs.snapshot();
}

let timers = [];
function schedule() {
  timers.forEach(clearInterval);
  const r = cfg.refresh;
  timers = [
    setInterval(jobs.prices, r.pricesSeconds * 1000),
    setInterval(jobs.hl, r.hyperliquidSeconds * 1000),
    setInterval(jobs.hlFills, (r.hlFillsSeconds || 60) * 1000),
    setInterval(jobs.balances, r.balancesSeconds * 1000),
    setInterval(jobs.history, r.historyMinutes * 60_000),
    setInterval(jobs.snapshot, r.snapshotMinutes * 60_000),
  ];
}

function reloadConfig() {
  cfg = loadConfig(db);
  // drop balances for accounts that no longer exist
  const ids = cfg.accounts.map((a) => a.id);
  const all = db.prepare('SELECT DISTINCT account_id FROM balances').all().map((r) => r.account_id);
  for (const id of all) if (!ids.includes(id)) {
    db.prepare('DELETE FROM balances WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM positions WHERE account_id = ?').run(id);
  }
  schedule();
  refreshAll();
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) reject(new Error('too large')); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});
const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : '');
const publicAccount = (a) => ({
  id: a.id, label: a.label, type: a.type, address: a.address, chains: a.chains ? JSON.parse(a.chains) : null, exchange: a.exchange,
  apiKey: mask(a.api_key), hasSecret: !!a.secret, extra: a.extra ? JSON.parse(a.extra) : null, enabled: !!a.enabled,
});

const ACCOUNT_TYPES = new Set(['evm', 'solana', 'pearl', 'cex', 'manual']);
const EXCHANGES = new Set(['kraken', 'binance']);
function saveAccount(b) {
  if (!ACCOUNT_TYPES.has(b.type)) throw new Error('Unknown account type');
  if (!b.label) throw new Error('Label is required');
  b.address = (b.address || '').trim();
  if (b.type === 'evm' && !/^0x[0-9a-fA-F]{40}$/.test(b.address)) throw new Error('Address must be a 0x… address');
  if (b.type === 'solana' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.address)) throw new Error('Address must be a Solana address');
  if (b.type === 'pearl' && !/^prl1[0-9a-z]{20,90}$/.test(b.address)) throw new Error('Address must be a prl1… address');
  if (b.type === 'cex' && !EXCHANGES.has(b.exchange)) throw new Error('Exchange must be kraken or binance');
  const existing = b.id ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(b.id) : null;
  const row = {
    id: existing?.id || crypto.randomUUID().slice(0, 8),
    label: b.label,
    type: b.type,
    address: b.address ? (b.type === 'evm' ? b.address.toLowerCase() : b.address) : null,
    chains: b.chains?.length ? JSON.stringify(b.chains) : null,
    exchange: b.exchange || null,
    // blank key fields keep the stored value
    api_key: (b.apiKey || '').trim() || existing?.api_key || null,
    secret: (b.secret || '').trim() || existing?.secret || null,
    password: (b.password || '').trim() || existing?.password || null,
    extra: b.extra ? JSON.stringify(b.extra) : existing?.extra || null,
    enabled: b.enabled === false ? 0 : 1,
    sort: existing?.sort || 0,
    created_at: existing?.created_at || nowSec(),
  };
  db.prepare(`INSERT OR REPLACE INTO accounts (id, label, type, address, chains, exchange, api_key, secret, password, extra, enabled, sort, created_at)
              VALUES (@id, @label, @type, @address, @chains, @exchange, @api_key, @secret, @password, @extra, @enabled, @sort, @created_at)`).run(row);
  return row.id;
}

const server = http.createServer(async (req, res) => {
  try {
    // Only answer requests addressed to localhost (blocks DNS-rebinding from other sites).
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_HOSTS.has(new URL(origin).hostname.toLowerCase())) return send(res, 403, { error: 'forbidden' });
      if (!(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'json only' });
    }
    const url = new URL(req.url, `http://${HOST}`);
    const p = url.pathname;

    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res);
      if (summary) res.write(`data: ${JSON.stringify(summary)}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/summary') return send(res, 200, summary || buildSummary(db, cfg, ledger));
    if (p === '/api/history') {
      const d = url.searchParams.get('days');
      const since = d === 'all' ? 0 : nowSec() - Number(d || 30) * 86400;
      // Bucket to at most ~800 points so long ranges stay light.
      const span = db.prepare('SELECT MIN(ts) AS a, MAX(ts) AS b FROM snapshots WHERE ts >= ?').get(since);
      const bucket = Math.max(300, Math.ceil(((span.b || 0) - (span.a || 0)) / 800 / 300) * 300);
      return send(res, 200, db.prepare('SELECT MAX(ts) AS ts, total FROM snapshots WHERE ts >= ? GROUP BY ts / ? ORDER BY ts').all(since, bucket));
    }
    if (p === '/api/history/reset' && req.method === 'POST') {
      db.prepare('DELETE FROM snapshots').run();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/asset') {
      const g = ledger.get(url.searchParams.get('group'));
      return send(res, 200, g ? { ...g, events: g.events.slice(0, 2000) } : { events: [] });
    }
    if (p === '/api/perp-fills') return send(res, 200, db.prepare('SELECT * FROM perp_fills ORDER BY ts DESC LIMIT 500').all());
    if (p === '/api/refresh' && req.method === 'POST') { evmForce.until = nowSec() + 120; refreshAll(); return send(res, 200, { ok: true }); }

    if (p === '/api/accounts' && req.method === 'GET') {
      return send(res, 200, { accounts: db.prepare('SELECT * FROM accounts ORDER BY sort, label').all().map(publicAccount),
        chains: Object.values(cfg.chains).map((c) => ({ name: c.name, default: autoChains(cfg.chains).includes(c.name) })), settings: { blockscoutKey: mask(cfg.settings.blockscoutKey), alchemyKey: mask(cfg.settings.alchemyKey), refresh: cfg.refresh, solanaRpc: cfg.settings.solanaRpc ? 'custom' : '', otherOwnAddresses: cfg.settings.otherOwnAddresses || [] } });
    }
    if (p === '/api/accounts' && req.method === 'POST') {
      const id = saveAccount(await readBody(req));
      reloadConfig();
      return send(res, 200, { ok: true, id });
    }
    if (p.startsWith('/api/accounts/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice(14));
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      db.prepare('DELETE FROM events WHERE account_id = ?').run(id);
      db.prepare('DELETE FROM kv WHERE k LIKE ?').run(`%:${id}%`); // sync cursors for this account
      db.prepare('DELETE FROM source_status WHERE source LIKE ?').run(`%:${id}%`);
      db.prepare('DELETE FROM perp_fills WHERE account_id = ?').run(id);
      reloadConfig();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.blockscoutKey === 'string' && b.blockscoutKey.trim()) kvSet(db, 'setting:blockscoutKey', b.blockscoutKey.trim());
      if (typeof b.alchemyKey === 'string' && b.alchemyKey.trim()) kvSet(db, 'setting:alchemyKey', b.alchemyKey.trim());
      if (typeof b.solanaRpc === 'string') kvSet(db, 'setting:solanaRpc', b.solanaRpc.trim() || null);
      if (b.refresh) kvSet(db, 'setting:refresh', b.refresh);
      if (b.aliases) kvSet(db, 'setting:aliases', b.aliases);
      if (Array.isArray(b.otherOwnAddresses)) kvSet(db, 'setting:otherOwnAddresses', b.otherOwnAddresses);
      reloadConfig();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/override' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.eventId) return send(res, 400, { error: 'eventId required' });
      if (!b.class && b.price == null) db.prepare('DELETE FROM overrides WHERE event_id = ?').run(b.eventId);
      else db.prepare('INSERT OR REPLACE INTO overrides (event_id, class, price_usd, note) VALUES (?, ?, ?, ?)').run(b.eventId, b.class || null, b.price == null || b.price === '' ? null : Number(b.price), b.note || null);
      ledger = await buildLedger(db, cfg);
      publish();
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    // static UI
    const file = path.normalize(path.join(ROOT, 'public', p === '/' ? 'index.html' : p));
    if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    log.error(e);
    send(res, 400, { error: e.message });
  }
});

// First run: import accounts from accounts.seed.json (gitignored) if the database has none.
function importSeed() {
  const file = path.join(ROOT, 'accounts.seed.json');
  if (!fs.existsSync(file) || db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n > 0) return;
  try {
    for (const a of JSON.parse(fs.readFileSync(file, 'utf8')).accounts || []) {
      try { saveAccount(a); } catch (e) { log.warn(`seed account "${a.label}" skipped: ${e.message}`); }
    }
    cfg = loadConfig(db);
    log.info(`Imported ${cfg.accounts.length} accounts from accounts.seed.json`);
  } catch (e) { log.warn('seed import failed', e.message); }
}
importSeed();

server.listen(PORT, HOST, () => {
  log.info(`Portfolio tracker running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT} (${cfg.accounts.length} accounts)`);
  schedule();
  buildLedger(db, cfg).then((l) => { ledger = l; publish(); }).catch((e) => log.warn('ledger', e.message));
  refreshAll();
});
