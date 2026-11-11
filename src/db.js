import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export function openDb(file = process.env.PORTFOLIO_DB || path.join(ROOT, 'data', 'portfolio.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      type TEXT NOT NULL,             -- evm | hyperliquid | cex | pearl | manual
      address TEXT,
      chains TEXT,                    -- JSON array for evm, null = auto-detect active chains
      exchange TEXT,                  -- ccxt id for cex: binance | kraken | ...
      api_key TEXT, secret TEXT, password TEXT,
      extra TEXT,                     -- JSON (manual holdings, etc)
      enabled INTEGER DEFAULT 1,
      sort INTEGER DEFAULT 0,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS assets (
      asset TEXT PRIMARY KEY,         -- e.g. base:0xabc.., base:native, hl:HYPE, cex:binance:SOL, stock:TSLA
      symbol TEXT, name TEXT, chain TEXT, decimals INTEGER,
      price_id TEXT,                  -- key into prices
      verified INTEGER DEFAULT 0,     -- on a public token list / priced by a trusted source
      logo TEXT
    );
    CREATE TABLE IF NOT EXISTS balances (
      account_id TEXT, asset TEXT, qty REAL, updated_at INTEGER, meta TEXT,
      PRIMARY KEY (account_id, asset)
    );
    CREATE TABLE IF NOT EXISTS prices (
      price_id TEXT PRIMARY KEY, price REAL, change24h REAL, confidence REAL, updated_at INTEGER, source TEXT
    );
    CREATE TABLE IF NOT EXISTS price_history (
      price_id TEXT, ts INTEGER, price REAL, PRIMARY KEY (price_id, ts)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      account_id TEXT, ts INTEGER, tx TEXT, asset TEXT,
      qty REAL,                       -- signed: + received, - sent
      kind TEXT,                      -- transfer | fee | trade
      counterparty TEXT,
      price_usd REAL,                 -- known execution price per unit (fills/trades), else null
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS events_tx ON events(account_id, tx);
    CREATE TABLE IF NOT EXISTS overrides (
      event_id TEXT PRIMARY KEY,
      class TEXT,                     -- buy | sell | internal | income | ignore | deposit | withdraw
      price_usd REAL, note TEXT
    );
    CREATE TABLE IF NOT EXISTS positions (
      account_id TEXT, venue TEXT, coin TEXT, size REAL, entry_px REAL, mark_px REAL,
      value REAL, upnl REAL, leverage REAL, liq_px REAL, margin REAL, funding REAL, updated_at INTEGER,
      PRIMARY KEY (account_id, venue, coin)
    );
    CREATE TABLE IF NOT EXISTS perp_fills (
      id TEXT PRIMARY KEY, account_id TEXT, ts INTEGER, coin TEXT, dir TEXT, px REAL, sz REAL,
      closed_pnl REAL, fee REAL
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS snapshots (ts INTEGER PRIMARY KEY, total REAL, data TEXT);
    CREATE TABLE IF NOT EXISTS source_status (
      source TEXT PRIMARY KEY, ok INTEGER, message TEXT, updated_at INTEGER
    );
  `);
  return db;
}

// Run fn inside a transaction (node:sqlite has no db.transaction helper).
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet(db, k, dflt = null) {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return r ? JSON.parse(r.v) : dflt;
}
export function kvSet(db, k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
}

export function setStatus(db, source, ok, message = '') {
  db.prepare(
    `INSERT INTO source_status (source, ok, message, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET ok = excluded.ok, message = excluded.message, updated_at = excluded.updated_at`
  ).run(source, ok ? 1 : 0, String(message).slice(0, 500), Math.floor(Date.now() / 1000));
}

export function upsertAsset(db, a) {
  db.prepare(
    `INSERT INTO assets (asset, symbol, name, chain, decimals, price_id) VALUES (@asset, @symbol, @name, @chain, @decimals, @price_id)
     ON CONFLICT(asset) DO UPDATE SET symbol = excluded.symbol, name = COALESCE(excluded.name, assets.name),
       decimals = COALESCE(excluded.decimals, assets.decimals), price_id = COALESCE(excluded.price_id, assets.price_id)`
  ).run({ asset: a.asset, symbol: a.symbol ?? '?', name: a.name ?? null, chain: a.chain ?? null, decimals: a.decimals ?? null, price_id: a.price_id ?? null });
  if (a.verified) db.prepare('UPDATE assets SET verified = 1 WHERE asset = ?').run(a.asset);
  if (a.logo) db.prepare('UPDATE assets SET logo = ? WHERE asset = ?').run(a.logo, a.asset);
}

// Replace all balances for one account+scope (so sold-out assets disappear).
export function replaceBalances(db, accountId, prefix, rows) {
  const now = Math.floor(Date.now() / 1000);
  tx(db, () => {
    db.prepare('DELETE FROM balances WHERE account_id = ? AND asset LIKE ?').run(accountId, `${prefix}%`);
    const ins = db.prepare('INSERT OR REPLACE INTO balances (account_id, asset, qty, updated_at, meta) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) if (r.qty) ins.run(accountId, r.asset, r.qty, now, r.meta ? JSON.stringify(r.meta) : null);
  });
}

export function insertEvents(db, rows) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO events (id, account_id, ts, tx, asset, qty, kind, counterparty, price_usd, meta)
     VALUES (@id, @account_id, @ts, @tx, @asset, @qty, @kind, @counterparty, @price_usd, @meta)`
  );
  let n = 0;
  tx(db, () => {
    for (const r of rows) {
      const { id, account_id, ts, tx: txid, asset, qty, kind, counterparty = null, price_usd = null, meta = null } = r;
      n += Number(ins.run({ id, account_id, ts, tx: txid, asset, qty, kind, counterparty, price_usd, meta: meta ? JSON.stringify(meta) : null }).changes);
    }
  });
  return n;
}
