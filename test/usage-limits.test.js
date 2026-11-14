import test from 'node:test';
import assert from 'node:assert/strict';
import { moved } from '../src/sources/rpc.js';
import { syncEvmHistory, resetBlockscout } from '../src/sources/evm.js';
import { hlInfo, hlWeightUsed, resetHlLimiter, syncHlAccount, syncHlHistory, refreshHlMarket } from '../src/sources/hyperliquid.js';
import { userRefresh } from '../src/config.js';
import { buildSummary } from '../src/portfolio.js';
import { openDb, kvGet, upsertAsset, replaceBalances } from '../src/db.js';
import { usage } from '../src/util.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const withFetch = async (fake, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { await fn(); } finally { globalThis.fetch = real; }
};

test('interest creeping up on a token is not a move; drops and native changes are', () => {
  assert.equal(moved('t', '1000000', '1000000'), false);
  assert.equal(moved('t', '1000000', '1000001'), false); // aToken / stETH style growth
  assert.equal(moved('t', '1000000', '1000600'), true); // +0.06%
  assert.equal(moved('t', '1000000', '999999'), true); // any drop
  assert.equal(moved('t', '0', '5'), true);
  assert.equal(moved('native', '1000000', '1000001'), true);
});

test('only the intervals shown in Settings are taken from saved settings', () => {
  assert.deepEqual(userRefresh({ pricesSeconds: 20, rpcHistoryHours: 6, evmHistoryMinutes: 1, historyMinutes: '10' }), { pricesSeconds: 20, historyMinutes: 10 });
  assert.deepEqual(userRefresh(null), {});
});

test('a Hyperliquid 429 pauses every request instead of retrying', async () => {
  resetHlLimiter();
  let calls = 0;
  await withFetch(async () => { calls++; return json({}, 429); }, async () => {
    await assert.rejects(hlInfo({ type: 'allMids' }), /slow down/);
    await assert.rejects(hlInfo({ type: 'allMids' }), /slow down/);
    assert.equal(calls, 1);
  });
  resetHlLimiter();
});

test('Hyperliquid: idle wallets are skipped, fills are read only after a move', async () => {
  resetHlLimiter();
  const db = openDb(':memory:');
  const account = { id: 'w1', address: '0x' + 'a'.repeat(40) };
  const seen = [];
  let total = '0';
  await withFetch(async (url, opts) => {
    const b = JSON.parse(opts.body);
    seen.push(b.type);
    if (b.type === 'spotMetaAndAssetCtxs') return json([{ tokens: [{ index: 0, name: 'USDC' }, { index: 1, name: 'HYPE' }], universe: [{ name: '@1', tokens: [1, 0] }] }, [{ coin: '@1', midPx: '40', prevDayPx: '39', dayNtlVlm: '1' }]]);
    if (b.type === 'metaAndAssetCtxs') return json([{ universe: [] }, []]);
    if (b.type === 'allMids') return json({ '@1': '41' });
    if (b.type === 'spotClearinghouseState') return json({ balances: total === '0' ? [] : [{ coin: 'HYPE', total, entryNtl: '0', hold: '0' }] });
    if (b.type === 'clearinghouseState') return json({ marginSummary: { accountValue: '0' }, assetPositions: [] });
    if (b.type === 'delegatorSummary') return json({ delegated: '0', undelegated: '0', totalPendingWithdrawal: '0' });
    return json([]);
  }, async () => {
    await syncHlAccount(db, {}, account);
    const first = seen.length;
    await syncHlAccount(db, {}, account); // holds nothing: not read again for ten minutes
    assert.equal(seen.length, first);

    await syncHlHistory(db, {}, account, { maxAge: 600 }); // first read after start
    const afterHist = seen.length;
    await syncHlHistory(db, {}, account, { maxAge: 600 }); // nothing moved
    assert.equal(seen.length, afterHist);

    total = '5';
    await syncHlAccount(db, {}, account, { force: true });
    assert.equal(db.prepare("SELECT qty FROM balances WHERE asset = 'hl:HYPE'").get().qty, 5);
    await syncHlAccount(db, {}, account); // now active: read every round, without the staking request
    assert.deepEqual(seen.slice(-2).sort(), ['clearinghouseState', 'spotClearinghouseState']);
    const n = seen.length;
    await syncHlHistory(db, {}, account, { maxAge: 600 }); // the balance moved, so fills are read
    assert.ok(seen.length > n);

    await refreshHlMarket(db); // between full reads only the light mid prices are fetched
    assert.equal(seen.at(-1), 'allMids');
    assert.equal(db.prepare("SELECT price FROM prices WHERE price_id = 'hl:HYPE'").get().price, 41);
    assert.equal(db.prepare("SELECT ok FROM source_status WHERE source = 'hyperliquid-market'").get().ok, 1);
    assert.ok(hlWeightUsed() < 500);
  });
  resetHlLimiter();
});

test('EVM history: a failed first read waits an hour, then resumes where it stopped', async () => {
  resetBlockscout();
  const db = openDb(':memory:');
  const chain = { name: 'testchain', chainId: 5, api: 'https://explorer.example', keyless: true, rpcs: [], llama: 'x', native: { symbol: 'ETH', priceId: 'coingecko:ethereum' } };
  const cfg = { chains: { testchain: chain }, refresh: {} };
  const me = '0x' + 'a'.repeat(40);
  const account = { id: 'w1', address: me, chains: ['testchain'] };
  const tx = (n) => ({ hash: `0x${n}`, block_number: n, timestamp: '2026-01-01T00:00:00Z', status: 'ok', value: '1000000000000000000', from: { hash: '0x' + 'b'.repeat(40) }, to: { hash: me }, fee: { value: '0' } });
  const reqs = [];
  let failPage2 = true;
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    await withFetch(async (url) => {
      const u = new URL(url);
      reqs.push(u.pathname.split('/').pop() + (u.searchParams.get('page') ? `?${u.searchParams.get('page')}` : ''));
      if (u.pathname.endsWith('/token-transfers') || u.pathname.endsWith('/internal-transactions')) return json({ items: [], next_page_params: null });
      if (!u.searchParams.get('page')) return json({ items: [tx(20), tx(19)], next_page_params: { page: 2 } });
      if (failPage2) return json({ message: 'boom' }, 400);
      return json({ items: [tx(18)], next_page_params: null });
    }, async () => {
      await syncEvmHistory(db, cfg, account);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2); // page one is kept
      assert.equal(kvGet(db, 'cursor:w1:testchain', null), null);
      assert.equal(db.prepare("SELECT ok FROM source_status WHERE source = 'evm-history:w1:testchain'").get().ok, 0);

      const n = reqs.length;
      clock += 5 * 60_000;
      await syncEvmHistory(db, cfg, account); // five minutes later: still waiting
      assert.equal(reqs.length, n);

      failPage2 = false;
      clock += 60 * 60_000;
      await syncEvmHistory(db, cfg, account);
      assert.deepEqual(reqs.slice(n), ['transactions?2', 'internal-transactions']); // no re-read of finished work
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 3);
      assert.equal(kvGet(db, 'cursor:w1:testchain', null), 20);
      assert.equal(db.prepare("SELECT ok FROM source_status WHERE source = 'evm-history:w1:testchain'").get().ok, 1);
    });
    assert.ok(usage.counts.Blockscout === undefined || usage.counts.Blockscout >= 0);
  } finally { Date.now = realNow; }
});

test('summary carries 7 and 30 day change, and hides status rows of disabled accounts', () => {
  const db = openDb(':memory:');
  upsertAsset(db, { asset: 'hl:HYPE', symbol: 'HYPE', chain: 'hyperliquid', price_id: 'hl:HYPE', verified: 1 });
  upsertAsset(db, { asset: 'hl:NEW', symbol: 'NEW', chain: 'hyperliquid', price_id: 'hl:NEW', verified: 1 });
  replaceBalances(db, 'aaaa1111', 'hl:', [{ asset: 'hl:HYPE', qty: 10 }, { asset: 'hl:NEW', qty: 1 }]);
  db.prepare("INSERT INTO prices (price_id, price, change24h, confidence, updated_at) VALUES ('hl:HYPE', 50, 0.1, 1, 0), ('hl:NEW', 5, NULL, 1, 0)").run();
  db.prepare("INSERT INTO price_refs (price_id, p7d, p30d, updated_at) VALUES ('hl:HYPE', 40, 100, 0)").run();
  db.prepare("INSERT INTO source_status (source, ok, message, updated_at) VALUES ('evm:aaaa1111:base', 1, '', 0), ('evm:bbbb2222:base', 0, 'old', 0), ('prices', 1, '', 0)").run();
  const cfg = { accounts: [{ id: 'aaaa1111', label: 'A', type: 'evm' }], aliases: {}, stables: new Set() };
  const s = buildSummary(db, cfg, new Map());
  const hype = s.assets.find((a) => a.group === 'HYPE');
  assert.ok(Math.abs(hype.change7d - 0.25) < 1e-9);
  assert.ok(Math.abs(hype.change30d + 0.5) < 1e-9);
  assert.equal(s.assets.find((a) => a.group === 'NEW').change7d, null);
  assert.deepEqual(s.status.map((x) => x.source), ['evm:aaaa1111:base', 'prices']);
});

test('EVM history: a wallet with no activity on a chain is not read again on every round', async () => {
  resetBlockscout();
  const db = openDb(':memory:');
  const chain = { name: 'testchain', chainId: 5, api: 'https://explorer.example', keyless: true, rpcs: [], llama: 'x', native: { symbol: 'ETH', priceId: 'coingecko:ethereum' } };
  const cfg = { chains: { testchain: chain }, refresh: {} };
  const account = { id: 'w1', address: '0x' + 'a'.repeat(40), chains: ['testchain'] };
  let calls = 0;
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    await withFetch(async () => { calls++; return json({ items: [], next_page_params: null }); }, async () => {
      await syncEvmHistory(db, cfg, account);
      assert.equal(calls, 3);
      assert.equal(kvGet(db, 'cursor:w1:testchain', null), 0);
      for (let i = 0; i < 5; i++) { clock += 5 * 60_000; await syncEvmHistory(db, cfg, account); } // 25 minutes of history rounds
      assert.equal(calls, 3); // it used to be read again on every one of them
    });
  } finally { Date.now = realNow; }
});
