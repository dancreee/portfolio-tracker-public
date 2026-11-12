import test from 'node:test';
import assert from 'node:assert/strict';
import { syncEvmBalances } from '../src/sources/evm.js';
import { openDb, kvGet } from '../src/db.js';

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const owner = '0x' + 'a'.repeat(40);
const multicall = (native) => `0x${w(32)}${w(1)}${w(32)}${w(1)}${w(64)}${w(32)}${w(native)}`;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('explorer is only asked on the slow clock, or at its usual pace after a balance moved', async () => {
  const db = openDb(':memory:');
  const chain = { name: 'testchain', chainId: 5, api: 'https://explorer.example', rpcs: ['https://rpc.example'], llama: 'x', native: { symbol: 'ETH', priceId: 'coingecko:ethereum' } };
  const cfg = { chains: { testchain: chain }, refresh: {} };
  const account = { id: 'w1', address: owner, chains: ['testchain'] };
  let native = 10n ** 18n;
  let explorer = 0;
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://explorer.example')) { explorer++; return json({ coin_balance: native.toString(), has_tokens: false }); }
    const { method } = JSON.parse(opts.body);
    return json({ jsonrpc: '2.0', id: 1, result: method === 'eth_chainId' ? '0x5' : multicall(native) });
  };
  const round = async (minutes) => { clock += minutes * 60_000; await syncEvmBalances(db, cfg, account); };
  try {
    await round(0); // first ever round: the explorer supplies the token list
    assert.equal(explorer, 1);
    assert.ok(kvGet(db, 'evm-disc:w1:testchain', 0) > 0);

    for (let i = 0; i < 30; i++) await round(2); // an hour of quiet RPC rounds
    assert.equal(explorer, 1);
    assert.equal(db.prepare("SELECT qty FROM balances WHERE asset = 'testchain:native'").get().qty, 1);

    native = 2n * 10n ** 18n;
    await round(2); // the move shows up over RPC and the explorer is read again
    assert.equal(explorer, 2);
    assert.equal(db.prepare("SELECT qty FROM balances WHERE asset = 'testchain:native'").get().qty, 2);
    await round(2); // too soon for the follow-up read
    assert.equal(explorer, 2);
    await round(4); // follow-up read at the usual five minute pace
    assert.equal(explorer, 3);
    for (let i = 0; i < 20; i++) await round(2); // quiet again
    assert.equal(explorer, 3);

    for (let i = 0; i < 20; i++) { native += 1n; await round(1); } // a balance that moves every round (rebasing token)
    assert.ok(explorer - 3 <= 5, `explorer reads stay at the old pace, got ${explorer - 3}`);

    await round(130); // slow safety clock
    assert.ok(explorer >= 5);
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
});
