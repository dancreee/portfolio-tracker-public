import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAggregate3, decodeAggregate3, syncRpcBalances, MULTICALL3 } from '../src/sources/rpc.js';
import { resolveChains, rpcsFor, DEFAULT_RPCS } from '../src/chains.js';
import { openDb, upsertAsset, replaceBalances, kvSet } from '../src/db.js';

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const owner = '0x' + 'a'.repeat(40);
const tokA = '0x' + 'c'.repeat(40);
const tokB = '0x' + 'd'.repeat(40);

// The shape a real node returns for three calls where the last one returned no data.
const response = (vals) => {
  const tuples = vals.map((v) => (v == null ? w(1) + w(64) + w(0) : w(1) + w(64) + w(32) + w(v)));
  let off = vals.length * 32;
  let head = '';
  for (const t of tuples) { head += w(off); off += t.length / 2; }
  return `0x${w(32)}${w(vals.length)}${head}${tuples.join('')}`;
};

test('aggregate3 call data layout', () => {
  const data = encodeAggregate3([
    { target: MULTICALL3, selector: '4d2301cc', arg: owner },
    { target: tokA, selector: '70a08231', arg: owner },
  ]);
  const body = data.slice(10);
  assert.equal(data.slice(0, 10), '0x82ad56cb');
  assert.equal(body.length % 64, 0);
  const word = (i) => body.slice(i * 64, i * 64 + 64);
  assert.equal(word(0), w(32));
  assert.equal(word(1), w(2));
  assert.equal(word(2), w(64)); // first tuple starts right after the two offsets
  assert.equal(word(3), w(64 + 192)); // each tuple is six words
  assert.equal(word(4), w(BigInt(MULTICALL3)));
  assert.equal(word(7), w(36));
  assert.ok(word(8).startsWith('4d2301cc' + '0'.repeat(24) + 'a'.repeat(32)));
  assert.equal(word(10), w(BigInt(tokA)));
  assert.equal(body.length / 64, 2 + 2 + 2 * 6);
});

test('aggregate3 response decodes, empty return data is a failed read', () => {
  assert.deepEqual(decodeAggregate3(response([0x2b6beb6635d556a8n, 5n, null]), 3), [0x2b6beb6635d556a8n, 5n, null]);
  assert.throws(() => decodeAggregate3(response([1n]), 2));
  assert.throws(() => decodeAggregate3('0x', 1));
});

test('rpc lists: defaults, overrides and switching off', () => {
  assert.deepEqual(resolveChains().base.rpcs, DEFAULT_RPCS.base);
  assert.deepEqual(resolveChains({}, '', '', { base: ['https://x.example/rpc', 'ftp://bad', ' https://x.example/rpc '] }).base.rpcs, ['https://x.example/rpc']);
  assert.deepEqual(rpcsFor('base', { base: [] }), []);
  for (const [name, urls] of Object.entries(DEFAULT_RPCS)) assert.ok(urls.length >= 1 && urls.every((u) => u.startsWith('https://')), name);
});

test('rpc balance sync: falls over to the next endpoint, reports moves, keeps failed tokens', async () => {
  const db = openDb(':memory:');
  const chain = { name: 'base', chainId: 8453, rpcs: ['https://down.example', 'https://up.example'] };
  const account = { id: 'w1', address: owner };
  upsertAsset(db, { asset: `base:${tokA}`, symbol: 'AAA', decimals: 6 });
  upsertAsset(db, { asset: `base:${tokB}`, symbol: 'BBB', decimals: 18 });
  replaceBalances(db, 'w1', 'base:', [{ asset: `base:${tokA}`, qty: 1 }, { asset: `base:${tokB}`, qty: 7 }]);
  kvSet(db, `ui-mult:base:${tokB}`, '2000000000000000000');

  let vals = [10n ** 18n, 2_500_000n, 3n * 10n ** 18n];
  const hits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const { method } = JSON.parse(opts.body);
    hits.push(`${new URL(url).host} ${method}`);
    if (String(url).includes('down.example')) return new Response('nope', { status: 403 });
    const result = method === 'eth_chainId' ? '0x2105' : response(vals);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const qty = () => Object.fromEntries(db.prepare("SELECT asset, qty FROM balances WHERE account_id = 'w1'").all().map((r) => [r.asset, r.qty]));
    assert.deepEqual(await syncRpcBalances(db, account, chain), { changed: false }); // first read is the baseline
    assert.deepEqual(qty(), { 'base:native': 1, [`base:${tokA}`]: 2.5, [`base:${tokB}`]: 6 });
    assert.ok(hits.includes('down.example eth_chainId') && hits.includes('up.example eth_call'));

    hits.length = 0;
    assert.deepEqual(await syncRpcBalances(db, account, chain), { changed: false });
    assert.deepEqual(hits, ['up.example eth_call']); // the failing endpoint is skipped, chain id is checked once

    vals = [10n ** 18n, 4_000_000n, null];
    assert.deepEqual(await syncRpcBalances(db, account, chain), { changed: true });
    assert.deepEqual(qty(), { 'base:native': 1, [`base:${tokA}`]: 4, [`base:${tokB}`]: 6 }); // tokB read failed: last amount kept

    assert.equal(await syncRpcBalances(db, account, { ...chain, rpcs: ['https://down.example'] }), null);
    assert.equal(await syncRpcBalances(db, account, { ...chain, rpcs: [] }), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
