import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertAsset, insertEvents, replaceBalances } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildLedger } from '../src/ledger.js';
import { buildSummary } from '../src/portfolio.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const T0 = 1_750_000_000;

function setup() {
  const db = openDb(':memory:');
  const acc = db.prepare('INSERT INTO accounts (id, label, type, address, enabled) VALUES (?, ?, ?, ?, 1)');
  acc.run('w1', 'Wallet 1', 'evm', A);
  acc.run('w2', 'Wallet 2', 'evm', B);
  upsertAsset(db, { asset: 'base:0xusdc', symbol: 'USDC', chain: 'base', price_id: 'base:0xusdc', verified: 1 });
  upsertAsset(db, { asset: 'base:0xfoo', symbol: 'FOO', chain: 'base', price_id: 'base:0xfoo', verified: 1 });
  upsertAsset(db, { asset: 'base:native', symbol: 'ETH', chain: 'base', price_id: 'coingecko:ethereum', verified: 1 });
  upsertAsset(db, { asset: 'base:0xweth', symbol: 'WETH', chain: 'base', price_id: 'base:0xweth', verified: 1 });
  upsertAsset(db, { asset: 'base:0xspam', symbol: 'USDC', chain: 'base', price_id: 'base:0xspam' }); // fake USDC, unverified
  const price = db.prepare("INSERT INTO prices (price_id, price, change24h, confidence, updated_at, source) VALUES (?, ?, 0.1, 0.99, 0, 'test')");
  price.run('base:0xusdc', 1);
  price.run('base:0xfoo', 3);
  price.run('coingecko:ethereum', 2000);
  price.run('base:0xweth', 2000);
  // historical ETH price so no network lookups are needed
  const h = db.prepare('INSERT INTO price_history (price_id, ts, price) VALUES (?, ?, ?)');
  for (let i = 0; i < 400; i++) h.run('coingecko:ethereum', Math.floor(T0 / 3600) * 3600 + i * 3600, 2000);
  return db;
}
const ev = (id, account, ts, tx, asset, qty, extra = {}) => ({ id, account_id: account, ts, tx, asset, qty, kind: 'transfer', ...extra });

test('swap sets cost basis; partial sell realizes PnL at average cost', async () => {
  const db = setup();
  insertEvents(db, [
    ev('1', 'w1', T0, 't0', 'base:0xusdc', 1000, { counterparty: '0xexchange' }), // funding deposit
    ev('2', 'w1', T0 + 10, 't1', 'base:0xusdc', -200), // buy 100 FOO @ 2
    ev('3', 'w1', T0 + 10, 't1', 'base:0xfoo', 100),
    ev('4', 'w1', T0 + 20, 't2', 'base:0xusdc', -400), // buy 100 FOO @ 4
    ev('5', 'w1', T0 + 20, 't2', 'base:0xfoo', 100),
    ev('6', 'w1', T0 + 30, 't3', 'base:0xfoo', -50), // sell 50 FOO @ 5
    ev('7', 'w1', T0 + 30, 't3', 'base:0xusdc', 250),
  ]);
  const cfg = loadConfig(db);
  const ledger = await buildLedger(db, cfg);
  const foo = ledger.get('FOO');
  assert.equal(foo.qty, 150);
  assert.equal(foo.avgCost, 3);
  assert.equal(foo.realized, 100); // 50 * (5 - 3)
  assert.equal(foo.buys, 2);
  assert.equal(foo.sells, 1);
  assert.deepEqual(foo.events.map((e) => e.cls), ['sell', 'buy', 'buy']);

  replaceBalances(db, 'w1', 'base:', [{ asset: 'base:0xfoo', qty: 150 }, { asset: 'base:0xusdc', qty: 650 }]);
  const s = buildSummary(db, cfg, ledger);
  const a = s.assets.find((x) => x.group === 'FOO');
  assert.equal(a.value, 450);
  assert.equal(a.costBasis, 450);
  assert.equal(a.unrealized, 0);
  assert.equal(s.total, 1100);
});

test('transfers between own wallets keep basis; wrap/unwrap is a no-op', async () => {
  const db = setup();
  insertEvents(db, [
    ev('1', 'w1', T0, 't0', 'base:0xusdc', 300, { counterparty: '0xexchange' }),
    ev('2', 'w1', T0 + 10, 't1', 'base:0xusdc', -300),
    ev('3', 'w1', T0 + 10, 't1', 'base:0xfoo', 100), // 100 FOO @ 3
    ev('4', 'w1', T0 + 20, 't2', 'base:0xfoo', -100, { counterparty: B }), // move to wallet 2
    ev('5', 'w2', T0 + 20, 't2', 'base:0xfoo', 100, { counterparty: A }),
    ev('6', 'w2', T0 + 30, 't3', 'base:native', 1, { counterparty: '0xsomeone' }), // 1 ETH in @ 2000
    ev('7', 'w2', T0 + 40, 't4', 'base:native', -1), // wrap
    ev('8', 'w2', T0 + 40, 't4', 'base:0xweth', 1),
  ]);
  const ledger = await buildLedger(db, loadConfig(db));
  const foo = ledger.get('FOO');
  assert.equal(foo.qty, 100);
  assert.equal(foo.avgCost, 3);
  assert.equal(foo.realized, 0);
  assert.ok(foo.events.every((e) => e.cls === 'buy' || e.cls === 'internal'));
  const eth = ledger.get('ETH');
  assert.equal(eth.qty, 1);
  assert.equal(eth.avgCost, 2000);
  assert.equal(eth.sells, 0);
});

test('bridge-style transfer is matched across accounts by amount and time', async () => {
  const db = setup();
  upsertAsset(db, { asset: 'hl:FOO', symbol: 'FOO', chain: 'hyperliquid', price_id: 'base:0xfoo', verified: 1 });
  insertEvents(db, [
    ev('1', 'w1', T0, 't1', 'base:0xusdc', -200),
    ev('2', 'w1', T0, 't1', 'base:0xfoo', 100), // 100 FOO @ 2
    ev('3', 'w1', T0 + 100, 't2', 'base:0xfoo', -100, { counterparty: '0xbridge' }),
    ev('4', 'w2', T0 + 400, 'hl:x', 'hl:FOO', 99.5, { counterparty: 'bridge' }), // arrives minus a fee
  ]);
  const ledger = await buildLedger(db, loadConfig(db));
  const foo = ledger.get('FOO');
  assert.equal(foo.avgCost, 2);
  assert.equal(foo.realized, 0);
  assert.equal(foo.events.filter((e) => e.cls === 'internal').length, 2);
});

test('fills use their execution price; fees reduce holdings; spam is ignored', async () => {
  const db = setup();
  upsertAsset(db, { asset: 'hl:FOO', symbol: 'FOO', chain: 'hyperliquid', price_id: 'hl:FOO', verified: 1 });
  upsertAsset(db, { asset: 'hl:USDC', symbol: 'USDC', chain: 'hyperliquid', price_id: 'hl:USDC', verified: 1 });
  insertEvents(db, [
    ev('1', 'w1', T0, 'f1', 'hl:FOO', 10, { kind: 'trade', price_usd: 7 }),
    ev('2', 'w1', T0, 'f1', 'hl:USDC', -70, { kind: 'trade', price_usd: 1 }),
    ev('3', 'w1', T0, 'f1', 'hl:FOO', -0.1, { kind: 'fee' }),
    ev('4', 'w1', T0 + 5, 'airdrop', 'base:0xspam', 5000, { counterparty: '0xscammer' }),
  ]);
  const ledger = await buildLedger(db, loadConfig(db));
  const foo = ledger.get('FOO');
  assert.ok(Math.abs(foo.qty - 9.9) < 1e-9);
  assert.ok(Math.abs(foo.avgCost - 7) < 1e-9);
  assert.ok(Math.abs(foo.realized + 0.7) < 1e-9);
  assert.equal(ledger.get('USDC')?.events.some((e) => e.asset === 'base:0xspam') ?? false, false);
});

test('manual override reclassifies an event and sets its price', async () => {
  const db = setup();
  insertEvents(db, [ev('1', 'w1', T0, 't1', 'base:0xfoo', 100, { counterparty: '0xotc' })]);
  db.prepare("INSERT INTO overrides (event_id, class, price_usd) VALUES ('1', 'buy', 1.5)").run();
  const foo = (await buildLedger(db, loadConfig(db))).get('FOO');
  assert.equal(foo.avgCost, 1.5);
  assert.equal(foo.events[0].cls, 'buy');
  assert.equal(foo.events[0].overridden, true);
});
