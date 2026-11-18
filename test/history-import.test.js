import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertAsset, insertEvents, replaceBalances, kvGet } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildLedger } from '../src/ledger.js';
import { buildSummary } from '../src/portfolio.js';
import { parseHistory, importHistory } from '../src/history-import.js';
import { categoryLabel, categoryOf } from '../src/categories.js';

const DAY = 86400;
const T0 = 1_750_000_000;
const iso = (ts) => new Date(ts * 1000).toISOString();
const snap = (ts, v, p = []) => JSON.stringify({ t: iso(ts), v, p });

function history() {
  return parseHistory([
    snap(T0, 1000, [{ sy: 'FOO', amt: 100, px: 5, usd: 500, cat: 'TOKEN.AI', ty: 'Idle' }, { sy: 'USDC', amt: 500, px: 1, usd: 500, cat: 'STABLECOIN', ty: 'Idle' }]),
    snap(T0 + DAY, 1200, [{ sy: 'FOO', amt: 100, px: 7, usd: 700, cat: 'TOKEN.AI', ty: 'Idle' }, { sy: 'WETH', amt: 0.25, px: 2000, usd: 500, cat: 'MAJOR.ETH', ty: 'Idle' }]),
    snap(T0 + 2 * DAY, 20, [{ sy: 'GOLD', amt: 1, px: 4000, usd: 4000, cat: 'RWA.COMMODITY', ty: 'Futures' }]),
    snap(T0 + 3 * DAY, 1300, [{ sy: 'FOO', amt: 100, px: 8, usd: 800, cat: 'TOKEN.AI', ty: 'Idle' }]),
    '',
  ].join('\n'));
}

test('import fills the value chart before the tracker\'s own snapshots, skipping the given period', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO snapshots (ts, total, data) VALUES (?, ?, ?)').run(T0 + 3 * DAY - 60, 1290, '{}'); // own first snapshot
  const r = importHistory(db, loadConfig(db), history(), { skip: [[T0 + 2 * DAY - 10, T0 + 2 * DAY + 10]] });
  assert.equal(r.snapshots, 2);
  assert.equal(r.leftOut, 2); // one skipped, one after the tracker's own history starts
  const rows = db.prepare('SELECT ts, total, src, data FROM snapshots ORDER BY ts').all();
  assert.deepEqual(rows.map((x) => [x.ts, x.total, x.src]), [[T0, 1000, 'import'], [T0 + DAY, 1200, 'import'], [T0 + 3 * DAY - 60, 1290, null]]);
  assert.deepEqual(JSON.parse(rows[1].data), { FOO: 700, ETH: 500 }); // WETH counts as ETH

  // running it again replaces the earlier import instead of adding to it
  importHistory(db, loadConfig(db), history().slice(0, 1));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE src = 'import'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE src IS NULL').get().n, 1);
});

test('import keeps daily prices (not for stablecoins or futures) and categories', () => {
  const db = openDb(':memory:');
  const r = importHistory(db, loadConfig(db), history());
  const prices = db.prepare('SELECT grp, day, price FROM imported_prices ORDER BY grp, day').all();
  assert.deepEqual(prices.map((p) => [p.grp, p.day - Math.floor(T0 / DAY), p.price]), [['ETH', 1, 2000], ['FOO', 0, 5], ['FOO', 1, 7], ['FOO', 3, 8]]);
  assert.equal(r.prices, 4);
  assert.deepEqual(kvGet(db, 'setting:categories'), { FOO: 'AI', USDC: 'Stablecoins', ETH: 'ETH' });
});

test('category labels and built-in rules', () => {
  assert.equal(categoryLabel('TOKEN.AI'), 'AI');
  assert.equal(categoryLabel('RWA.STOCK'), 'Stocks');
  assert.equal(categoryLabel('MAJOR.HYPE'), 'HYPE');
  assert.equal(categoryLabel('TOKEN.LST_LRT'), 'Staking');
  assert.equal(categoryLabel('TOKEN.REAL_ESTATE'), 'Real Estate');
  assert.equal(categoryLabel('Privacy'), 'Privacy');
  assert.equal(categoryLabel(''), null);
  const cfg = { stables: new Set(['USDC']), settings: { categories: { FOO: 'AI' } } };
  assert.equal(categoryOf('FOO', [], cfg), 'AI');
  assert.equal(categoryOf('USDC', [], cfg), 'Stablecoins');
  assert.equal(categoryOf('BTC', [], cfg), 'BTC');
  assert.equal(categoryOf('TSLA', [{ priceId: 'stock:TSLA' }], cfg), 'Stocks');
  assert.equal(categoryOf('BAR', [{ priceId: 'base:0xbar' }], cfg), 'Other');
});

test('a deposit with no market price history takes its cost basis from the imported price', async () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO accounts (id, label, type, address, enabled) VALUES (?, ?, ?, ?, 1)').run('w1', 'Wallet 1', 'evm', '0x' + 'a'.repeat(40));
  // no price_id on the asset: nothing to look up online, so today's price would be the only fallback
  upsertAsset(db, { asset: 'manual:FOO', symbol: 'FOO', chain: 'manual' });
  db.prepare('UPDATE assets SET price_id = ? WHERE asset = ?').run('manual:FOO', 'manual:FOO');
  db.prepare("INSERT INTO prices (price_id, price, change24h, confidence, updated_at, source) VALUES ('manual:FOO', 20, 0, 0.99, 0, 'test')").run();
  // the hour of the deposit is already known to have no price, so no network lookup is made
  insertEvents(db, [{ id: '1', account_id: 'w1', ts: T0 + DAY + 3600, tx: 't1', asset: 'manual:FOO', qty: 100, kind: 'transfer', counterparty: '0xsomeone' }]);
  replaceBalances(db, 'w1', 'manual:', [{ asset: 'manual:FOO', qty: 100 }]);

  let cfg = loadConfig(db);
  let foo = (await buildLedger(db, cfg)).get('FOO');
  assert.equal(foo.events[0].priceSrc, 'current (no history)');
  assert.equal(foo.avgCost, 20);

  importHistory(db, cfg, history());
  cfg = loadConfig(db);
  const ledger = await buildLedger(db, cfg);
  foo = ledger.get('FOO');
  assert.equal(foo.events[0].priceSrc, 'imported history');
  assert.equal(foo.avgCost, 7); // the imported price for that day
  const s = buildSummary(db, cfg, ledger);
  assert.equal(s.assets[0].category, 'AI');
  assert.deepEqual(s.categories.map((c) => [c.name, c.value, c.assets]), [['AI', 2000, 1]]);
});
