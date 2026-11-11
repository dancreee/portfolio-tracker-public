import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { parsePearlAddressPage, pearlEvents, syncPearl, PEARL_ASSET } from '../src/sources/pearl.js';

const ADDR = 'prl1qtestaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TX_IN = 'a1'.repeat(32);
const TX_OUT = 'b2'.repeat(32);
const TX_IN2 = 'c3'.repeat(32);
const TX_UNCONF = 'd4'.repeat(32);

// Build a page the way Next.js does: JSON embedded in a JS string inside self.__next_f.push.
function page(payload, { split = false } = {}) {
  const flight = `7:["$","$L1f",null,${JSON.stringify(payload)}]\n`;
  const esc = JSON.stringify(flight).slice(1, -1); // escaped as inside a JS string literal
  let script;
  if (split) {
    const cut = esc.indexOf('netAmount') + 4; // split mid-key, as the stream may do
    script = `<script>self.__next_f.push([1,"${esc.slice(0, cut)}"])</script><script>self.__next_f.push([1,"${esc.slice(cut)}"])</script>`;
  } else {
    script = `<script>self.__next_f.push([1,"${esc}"])</script>`;
  }
  return `<!DOCTYPE html><html><head><title>Address</title></head><body><div id="app">Address ${ADDR}</div>` +
    `<script>self.__next_f.push([1,"3:I[1234,[],\\"default\\"]\\n"])</script>${script}</body></html>`;
}

const payload = {
  network: 'mainnet',
  addressInfo: { a_id: ADDR, balance: 120.5, unconfirmedBalance: 0, received: 171.50004, sent: 51.00004, tx_count: 3 },
  transactions: [
    { time: 1793005725, txid: TX_IN2, sent: 0, received: 71.5, netAmount: 71.5, fee: 0.007673, confirmations: 7584, vsize: 152,
      vin: [{ txid: 'ee'.repeat(32), vout: 1 }] },
    { time: 1792000000, txid: TX_OUT, sent: 100.00004, received: 49, netAmount: -51.00004, fee: 0.00004, confirmations: 9000, vsize: 141 },
    { time: 1791000000, txid: TX_IN, sent: 0, received: 100.00004, netAmount: 100.00004, fee: 1e-5, confirmations: 12000, vsize: 110 },
  ],
  pagination: { page: 1, total: 3 },
};

test('parsePearlAddressPage reads balance and transactions', () => {
  const p = parsePearlAddressPage(page(payload));
  assert.equal(p.address, ADDR);
  assert.equal(p.balance, 120.5);
  assert.equal(p.txCount, 3);
  assert.equal(p.transactions.length, 3); // nested vin txid is not a transaction
  assert.deepEqual(p.transactions[1], { txid: TX_OUT, time: 1792000000, sent: 100.00004, received: 49, netAmount: -51.00004, fee: 0.00004, confirmations: 9000 });
  assert.equal(p.transactions[2].fee, 0.00001); // exponent form
});

test('parsePearlAddressPage handles a payload split across push chunks', () => {
  const p = parsePearlAddressPage(page(payload, { split: true }));
  assert.equal(p.balance, 120.5);
  assert.deepEqual(p.transactions.map((t) => t.txid), [TX_IN2, TX_OUT, TX_IN]);
  assert.equal(p.transactions[0].netAmount, 71.5);
});

test('parsePearlAddressPage: verified fragment shape, integer balance, reordered keys', () => {
  const frag = `"addressInfo":{"a_id":"${ADDR}","balance":20740,"unconfirmedBalance":0,"received":20740,"sent":0,"tx_count":3},` +
    `"transactions":[{"time":1793005725,"txid":"${TX_IN}","sent":0,"received":5603.0519294,"netAmount":5603.0519294,"fee":0.007673,"confirmations":7584,"vsize":152},` +
    `{"txid":"${TX_OUT}","confirmations":3,"fee":0.001,"netAmount":-10.001,"received":0,"sent":10.001,"time":1793009999}]`;
  const html = `<script>self.__next_f.push([1,"${frag.replaceAll('"', '\\"')}"])</script>`;
  const p = parsePearlAddressPage(html);
  assert.equal(p.balance, 20740);
  assert.equal(p.transactions.length, 2);
  assert.equal(p.transactions[0].received, 5603.0519294);
  assert.equal(p.transactions[1].netAmount, -10.001);
  assert.equal(p.transactions[1].time, 1793009999);
});

test('parsePearlAddressPage falls back to per-key extraction when the array is not valid JSON', () => {
  const frag = `"addressInfo":{"a_id":"${ADDR}","balance":5.5,"tx_count":1,"extra":$undefined},` +
    `"transactions":[{"time":1793005725,"txid":"${TX_OUT}","sent":2,"received":0,"netAmount":-2,"fee":0.5,"confirmations":4,"block":$undefined}]`;
  const p = parsePearlAddressPage(`<script>self.__next_f.push([1,"${frag.replaceAll('"', '\\"')}"])</script>`);
  assert.equal(p.balance, 5.5);
  assert.equal(p.txCount, 1);
  assert.deepEqual(p.transactions, [{ txid: TX_OUT, time: 1793005725, sent: 2, received: 0, netAmount: -2, fee: 0.5, confirmations: 4 }]);
});

test('parsePearlAddressPage throws when the page has no address data', () => {
  assert.throws(() => parsePearlAddressPage('<html><body>Just a moment...</body></html>'), /address summary not found/);
});

test('pearlEvents: receive, send with fee split, unconfirmed skipped', () => {
  const parsed = parsePearlAddressPage(page({
    ...payload,
    transactions: [{ time: 0, txid: TX_UNCONF, sent: 0, received: 1, netAmount: 1, fee: 0.001, confirmations: 0 }, ...payload.transactions],
  }));
  const ev = pearlEvents(parsed, 'acc1');
  assert.deepEqual(ev.map((e) => e.id), [
    `pearl:${TX_IN2}:acc1`,
    `pearl:${TX_OUT}:acc1:fee`,
    `pearl:${TX_OUT}:acc1`,
    `pearl:${TX_IN}:acc1`,
  ]);
  const [recv, fee, send] = ev;
  assert.deepEqual({ qty: recv.qty, kind: recv.kind, ts: recv.ts, tx: recv.tx, asset: recv.asset },
    { qty: 71.5, kind: 'transfer', ts: 1793005725, tx: `pearl:${TX_IN2}`, asset: PEARL_ASSET }); // receiver does not pay the fee
  assert.deepEqual({ qty: fee.qty, kind: fee.kind }, { qty: -0.00004, kind: 'fee' });
  assert.deepEqual({ qty: send.qty, kind: send.kind, tx: send.tx }, { qty: -51, kind: 'transfer', tx: `pearl:${TX_OUT}` });
});

test('pearlEvents: pure consolidation (only the fee leaves) gives just a fee event', () => {
  const ev = pearlEvents({ transactions: [{ txid: TX_OUT, time: 10, sent: 5, received: 4.999, netAmount: -0.001, fee: 0.001, confirmations: 1 }] }, 'a');
  assert.deepEqual(ev.map((e) => [e.kind, e.qty]), [['fee', -0.001]]);
});

test('syncPearl stores balance, events and status; is idempotent; never throws', async (t) => {
  const db = openDb(':memory:');
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const account = { id: 'p1', label: 'Pearl', type: 'pearl', address: ADDR };
  const urls = [];
  let body = page({ ...payload, addressInfo: { ...payload.addressInfo, tx_count: 40 } });
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }); };

  await syncPearl(db, {}, account);
  assert.equal(urls[0], `https://explorer.pearlresearch.ai/address/${ADDR}?network=mainnet`);
  assert.deepEqual({ ...db.prepare('SELECT asset, qty FROM balances WHERE account_id = ?').get('p1') }, { asset: 'pearl:PRL', qty: 120.5 });
  const a = db.prepare('SELECT * FROM assets WHERE asset = ?').get('pearl:PRL');
  assert.deepEqual([a.symbol, a.name, a.chain, a.decimals, a.price_id, a.verified], ['PRL', 'Pearl', 'pearl', 8, 'coingecko:pearl-2', 1]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 4);
  const sum = db.prepare('SELECT SUM(qty) s FROM events').get().s;
  assert.ok(Math.abs(sum - 120.5) < 1e-9); // events reconcile with the balance
  let st = db.prepare('SELECT * FROM source_status WHERE source = ?').get('pearl:p1');
  assert.equal(st.ok, 1);
  assert.match(st.message, /3 of 40 txs/);

  await syncPearl(db, {}, account);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 4);

  body = '<html>blocked</html>';
  await syncPearl(db, {}, account);
  st = db.prepare('SELECT * FROM source_status WHERE source = ?').get('pearl:p1');
  assert.equal(st.ok, 0);
  assert.match(st.message, /not found/);
  assert.equal(db.prepare('SELECT qty FROM balances WHERE account_id = ?').get('p1').qty, 120.5); // old balance kept
});
