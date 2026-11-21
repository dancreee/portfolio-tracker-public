import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertAsset, insertEvents, kvSet } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildLedger } from '../src/ledger.js';
import { tradeRounds, plansEnabled, plansMinUsd, plansSince, plansOverview, planFor, savePlan, markReviewed, closedTrades, saveTradeNote } from '../src/plans.js';

const T0 = 1_750_000_000;
const DAY = 86400;

function setup() {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO accounts (id, label, type, address, enabled) VALUES (?, ?, ?, ?, 1)').run('w1', 'Wallet 1', 'evm', '0x' + 'a'.repeat(40));
  upsertAsset(db, { asset: 'base:0xusdc', symbol: 'USDC', chain: 'base', price_id: 'base:0xusdc', verified: 1 });
  upsertAsset(db, { asset: 'base:0xfoo', symbol: 'FOO', chain: 'base', price_id: 'base:0xfoo', verified: 1 });
  const price = db.prepare("INSERT INTO prices (price_id, price, change24h, confidence, updated_at, source) VALUES (?, ?, 0, 0.99, 0, 'test')");
  price.run('base:0xusdc', 1);
  price.run('base:0xfoo', 3);
  return db;
}
let seq = 0;
// one swap between USDC and FOO: positive foo = buy, negative = sell, at `px` USDC each
function swap(db, ts, foo, px) {
  const tx = `t${++seq}`;
  insertEvents(db, [
    { id: `${tx}a`, account_id: 'w1', ts, tx, asset: 'base:0xfoo', qty: foo, kind: 'transfer' },
    { id: `${tx}b`, account_id: 'w1', ts, tx, asset: 'base:0xusdc', qty: -foo * px, kind: 'transfer' },
  ]);
}
async function world(db) {
  const cfg = loadConfig(db);
  return { cfg, ledger: await buildLedger(db, cfg) };
}
// Plans are stamped with the wall clock; tests move them to where they need to be in the timeline.
const stamp = (db, ts) => db.prepare('UPDATE plans SET created_at = ? WHERE id = (SELECT MAX(id) FROM plans)').run(ts);

test('the feature is off until switched on in settings', () => {
  const db = setup();
  assert.equal(plansEnabled(loadConfig(db)), false);
  kvSet(db, 'setting:plans', true);
  assert.equal(plansEnabled(loadConfig(db)), true);
});

test('a full exit closes the trade with its cost, proceeds and realised PnL', async () => {
  const db = setup();
  swap(db, T0, 100, 2); // buy 100 @ 2
  swap(db, T0 + DAY, 100, 4); // buy 100 @ 4  -> avg 3
  swap(db, T0 + 2 * DAY, -50, 5); // sell 50 @ 5 -> +100
  swap(db, T0 + 3 * DAY, -150, 2); // sell the rest @ 2 -> -150
  swap(db, T0 + 10 * DAY, 10, 6); // buy back: a new, open trade
  const { cfg, ledger } = await world(db);
  const rounds = tradeRounds(ledger.get('FOO').events);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].closedAt, T0 + 3 * DAY);
  assert.equal(rounds[1].closedAt, null);

  const [c, ...rest] = closedTrades(db, cfg, ledger).trades;
  assert.equal(rest.length, 0);
  assert.equal(c.group, 'FOO');
  assert.equal(c.openedAt, T0);
  assert.equal(c.closedAt, T0 + 3 * DAY);
  assert.equal(c.buys, 2);
  assert.equal(c.sells, 2);
  assert.equal(c.cost, 600);
  assert.equal(c.proceeds, 550);
  assert.equal(c.realized, -50);
  assert.equal(c.avgBuy, 3);
  assert.equal(c.avgSell, 2.75);
  assert.equal(plansOverview(db, cfg, ledger).closed, 1);
});

test('a partial sell, a leftover speck of dust and a stablecoin are handled', async () => {
  const db = setup();
  swap(db, T0, 100, 2);
  swap(db, T0 + DAY, -40, 3);
  let w = await world(db);
  assert.equal(closedTrades(db, w.cfg, w.ledger).trades.length, 0); // still holding 60
  swap(db, T0 + 2 * DAY, -59.95, 3); // 0.05 left: under 0.1% of the 100 peak
  w = await world(db);
  const closed = closedTrades(db, w.cfg, w.ledger).trades;
  assert.deepEqual(closed.map((c) => c.group), ['FOO']); // USDC went to zero too but is never a "trade"
  assert.equal(closed[0].closedAt, T0 + 2 * DAY);
});

test('saving keeps every version; the newest is the plan', async () => {
  const db = setup();
  swap(db, T0, 100, 2);
  const { cfg, ledger } = await world(db);
  assert.equal(planFor(db, cfg, ledger, 'FOO').plan, null);
  assert.equal(plansOverview(db, cfg, ledger).state.get('FOO'), undefined);
  assert.throws(() => savePlan(db, cfg, ledger, { group: 'FOO' }), /Write a thesis/);
  assert.throws(() => savePlan(db, cfg, ledger, { group: 'FOO', thesis: 'x', stop: 'abc' }), /Stop must be a price/);

  savePlan(db, cfg, ledger, { group: 'FOO', thesis: 'first', stop: '1.5', target: '$6' });
  savePlan(db, cfg, ledger, { group: 'FOO', thesis: 'first', stop: '1.5', target: '$6' }); // unchanged: no new version
  const out = savePlan(db, cfg, ledger, { group: 'FOO', thesis: 'second', stop: 1.8, target: 6, entry: '2' });
  assert.equal(out.versions.length, 2);
  assert.equal(out.plan.thesis, 'second');
  assert.equal(out.plan.stop, 1.8);
  assert.equal(out.versions[1].thesis, 'first');
  assert.equal(out.versions[1].target, 6);
  assert.deepEqual(out.entry, { since: T0, buys: 1, avgBuy: 2, minBuy: 2, maxBuy: 2 });
  assert.equal(plansOverview(db, cfg, ledger).state.get('FOO'), 'ok');
});

test('a trade after the plan was written asks for a review until confirmed or updated', async () => {
  const db = setup();
  swap(db, T0, 100, 2);
  let { cfg, ledger } = await world(db);
  savePlan(db, cfg, ledger, { group: 'FOO', thesis: 'hold' });
  stamp(db, T0 + DAY);
  assert.equal(planFor(db, cfg, ledger, 'FOO').review, null); // the buy came before the plan

  swap(db, T0 + 2 * DAY, 50, 4);
  ({ cfg, ledger } = await world(db));
  assert.deepEqual(planFor(db, cfg, ledger, 'FOO').review, { ts: T0 + 2 * DAY, cls: 'buy', qty: 50, unitPrice: 4 });
  assert.equal(plansOverview(db, cfg, ledger).state.get('FOO'), 'review');

  markReviewed(db, 'FOO');
  assert.equal(planFor(db, cfg, ledger, 'FOO').review, null);
  assert.equal(plansOverview(db, cfg, ledger).state.get('FOO'), 'ok');
});

test('a closed trade keeps its final plan and notes; buying back starts clean', async () => {
  const db = setup();
  swap(db, T0, 100, 2);
  let { cfg, ledger } = await world(db);
  savePlan(db, cfg, ledger, { group: 'FOO', thesis: 'v1', stop: 1 });
  stamp(db, T0 + 10);
  savePlan(db, cfg, ledger, { group: 'FOO', thesis: 'v2', stop: 1.5 });
  stamp(db, T0 + 20);
  swap(db, T0 + DAY, -100, 3);
  swap(db, T0 + 5 * DAY, 20, 4);
  ({ cfg, ledger } = await world(db));

  // the old plan went with the closed trade
  assert.equal(planFor(db, cfg, ledger, 'FOO').plan, null);
  assert.equal(plansOverview(db, cfg, ledger).state.get('FOO'), undefined);
  let [c] = closedTrades(db, cfg, ledger).trades;
  assert.equal(c.plan.thesis, 'v2');
  assert.equal(c.versions.length, 2);
  assert.equal(c.realized, 100);
  assert.equal(c.exitNote, '');

  saveTradeNote(db, cfg, ledger, { group: 'FOO', closedAt: c.closedAt, exitNote: 'took profit', lesson: 'size up sooner' });
  saveTradeNote(db, cfg, ledger, { group: 'FOO', closedAt: c.closedAt, exitNote: 'took profit early', lesson: 'size up sooner' });
  assert.throws(() => saveTradeNote(db, cfg, ledger, { group: 'FOO', closedAt: 123, exitNote: 'x' }), /no longer exists/);
  [c] = closedTrades(db, cfg, ledger).trades;
  assert.equal(c.exitNote, 'took profit early');
  assert.equal(c.lesson, 'size up sooner');

  // a plan written now belongs to the new position only
  const out = savePlan(db, cfg, ledger, { group: 'FOO', thesis: 'round two' });
  assert.equal(out.versions.length, 1);
  assert.equal(out.entry.since, T0 + 5 * DAY);
  assert.equal(closedTrades(db, cfg, ledger).trades[0].plan.thesis, 'v2');
});

test('moving the whole holding out of sight does not close the trade or drop its plan', async () => {
  const db = setup();
  swap(db, T0, 100, 2);
  let { cfg, ledger } = await world(db);
  savePlan(db, cfg, ledger, { group: 'FOO', thesis: 'stake it' });
  stamp(db, T0 + 10);
  // everything sent to an unknown address (a staking contract, say), later returned and sold
  insertEvents(db, [{ id: 'out', account_id: 'w1', ts: T0 + DAY, tx: 'out', asset: 'base:0xfoo', qty: -100, kind: 'transfer', counterparty: '0xstake' }]);
  ({ cfg, ledger } = await world(db));
  assert.equal(closedTrades(db, cfg, ledger).trades.length, 0);
  assert.equal(planFor(db, cfg, ledger, 'FOO').plan.thesis, 'stake it');

  insertEvents(db, [{ id: 'back', account_id: 'w1', ts: T0 + 20 * DAY, tx: 'back', asset: 'base:0xfoo', qty: 100, kind: 'transfer', counterparty: '0xstake' }]);
  swap(db, T0 + 21 * DAY, -100, 5);
  ({ cfg, ledger } = await world(db));
  const [c] = closedTrades(db, cfg, ledger).trades;
  assert.equal(c.openedAt, T0);
  assert.equal(c.closedAt, T0 + 21 * DAY);
  assert.equal(c.plan.thesis, 'stake it');
});

test('small closed trades are hidden by a size set in settings, 100 dollars by default', async () => {
  const db = setup();
  swap(db, T0, 100, 2); // 200 in
  swap(db, T0 + DAY, -100, 3);
  swap(db, T0 + 2 * DAY, 10, 2); // 20 in: a test buy
  swap(db, T0 + 3 * DAY, -10, 3);
  let { cfg, ledger } = await world(db);
  assert.equal(plansMinUsd(cfg), 100);
  let out = closedTrades(db, cfg, ledger);
  assert.deepEqual(out.trades.map((c) => c.cost), [200]);
  assert.equal(out.hidden, 1);
  assert.equal(out.minUsd, 100);
  assert.equal(plansOverview(db, cfg, ledger).closed, 1);

  kvSet(db, 'setting:plansMinUsd', 0);
  ({ cfg, ledger } = await world(db));
  out = closedTrades(db, cfg, ledger);
  assert.deepEqual(out.trades.map((c) => c.cost), [20, 200]);
  assert.equal(out.hidden, 0);
  assert.equal(plansOverview(db, cfg, ledger).closed, 2);

  // a plan written for the small trade stays with it, not with the next one, even while it is hidden
  kvSet(db, 'setting:plansMinUsd', 100);
  ({ cfg, ledger } = await world(db));
  assert.equal(planFor(db, cfg, ledger, 'FOO').plan, null);
});

test('only trades closed since plans were switched on ask for an exit note', async () => {
  const db = setup();
  swap(db, T0, 100, 2);
  swap(db, T0 + DAY, -100, 3); // closed before the switch
  swap(db, T0 + 10 * DAY, 100, 2);
  swap(db, T0 + 11 * DAY, -100, 3); // closed after it
  kvSet(db, 'setting:plansSince', T0 + 5 * DAY);
  const { cfg, ledger } = await world(db);
  assert.equal(plansSince(cfg), T0 + 5 * DAY);
  let { trades, since } = closedTrades(db, cfg, ledger);
  assert.equal(since, T0 + 5 * DAY);
  assert.deepEqual(trades.map((c) => c.wantsNote), [true, false]);
  saveTradeNote(db, cfg, ledger, { group: 'FOO', closedAt: trades[0].closedAt, exitNote: 'done' });
  ({ trades } = closedTrades(db, cfg, ledger));
  assert.deepEqual(trades.map((c) => c.wantsNote), [false, false]);
});
