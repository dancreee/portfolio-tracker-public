import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, kvGet, upsertAsset } from '../src/db.js';
import {
  parseSolanaTransaction, summarizeTokenAccounts, parseJupiterTokens, syncSolanaBalances, syncSolanaHistory,
  TOKEN_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT,
} from '../src/sources/solana.js';

// Made-up base58-looking addresses (no real wallets).
const addr = (tag) => (tag + 'x'.repeat(44)).slice(0, 44);
const OWNER = addr('owner');
const OTHER = addr('sender');
const USDC = addr('mintUSDC');
const BONK = addr('mintBNK');
const T22 = addr('mintT22');
const NFT = addr('mintNFT');
const TA_USDC = addr('taUSDC');
const TA_USDC2 = addr('taUSDCsecond');
const TA_BONK = addr('taBNK');
const TA_T22 = addr('taT22');
const TA_NFT = addr('taNFT');
const TA_OTHER = addr('taSender');
const POOL = addr('pool');
const sig = (tag) => (tag + '5'.repeat(88)).slice(0, 88);

const key = (pubkey, signer = false, source = 'transaction') => ({ pubkey, signer, writable: true, source });
const tb = (accountIndex, mint, owner, amount, decimals, programId = TOKEN_PROGRAM) => ({
  accountIndex, mint, owner, programId,
  uiTokenAmount: { amount: String(amount), decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) },
});
const mkTx = ({ signature, blockTime = 1790000000, keys, pre, post, fee = 5000, preTok = [], postTok = [], err = null }) => ({
  blockTime, slot: 300000000, version: 0,
  meta: { err, fee, preBalances: pre, postBalances: post, preTokenBalances: preTok, postTokenBalances: postTok, innerInstructions: [], logMessages: [] },
  transaction: { signatures: [signature], message: { accountKeys: keys, instructions: [], recentBlockhash: addr('blockhash') } },
});

// Owner swaps 1.5 SOL for 210.25 USDC (temp WSOL account opened and closed inside the tx), paying the fee.
const SWAP = mkTx({
  signature: sig('swap'),
  keys: [key(OWNER, true), key(TA_USDC), key(POOL), key(addr('poolUSDC'), false, 'lookupTable')],
  pre: [5_000_000_000, 2_039_280, 90_000_000_000, 2_039_280],
  post: [5_000_000_000 - 1_500_000_000 - 5000, 2_039_280, 91_500_000_000, 2_039_280],
  preTok: [tb(1, USDC, OWNER, 1_000_000, 6), tb(3, USDC, POOL, 900_000_000_000, 6)],
  postTok: [tb(1, USDC, OWNER, 211_250_000, 6), tb(3, USDC, POOL, 899_789_750_000, 6)],
});

// Someone sends the owner 1,000,000 BONK: the owner's wallet address is not in the tx at all.
const INCOMING = mkTx({
  signature: sig('incoming'),
  blockTime: 1790000500,
  keys: [key(OTHER, true), key(TA_OTHER), key(TA_BONK)],
  pre: [1_000_000_000, 2_039_280, 2_039_280],
  post: [999_995_000, 2_039_280, 2_039_280],
  preTok: [tb(1, BONK, OTHER, 5_000_000_00000, 5)], // owner's account had no pre entry (0)
  postTok: [tb(1, BONK, OTHER, 4_000_000_00000, 5), tb(2, BONK, OWNER, 1_000_000_00000, 5)],
});

test('swap where the owner pays the fee: native out, token in, separate fee', () => {
  const legs = parseSolanaTransaction(SWAP, OWNER);
  const s = sig('swap');
  assert.deepEqual(legs.map((l) => [l.id, l.asset, l.qty, l.kind]), [
    [`solana:${s}:native`, 'solana:native', -1.5, 'transfer'],
    [`solana:${s}:fee`, 'solana:native', -0.000005, 'fee'],
    [`solana:${s}:${USDC}`, `solana:${USDC}`, 210.25, 'transfer'],
  ]);
  assert.ok(legs.every((l) => l.tx === `solana:${s}` && l.ts === 1790000000));
  assert.equal(legs[2].decimals, 6);
});

test('incoming SPL transfer where the owner is not a signer', () => {
  const legs = parseSolanaTransaction(INCOMING, OWNER);
  assert.deepEqual(legs.map((l) => [l.id, l.qty, l.kind]), [[`solana:${sig('incoming')}:${BONK}`, 1_000_000, 'transfer']]);
  // The sender's view of the same tx: token out plus fee, no native leg.
  assert.deepEqual(parseSolanaTransaction(INCOMING, OTHER).map((l) => [l.asset, l.qty, l.kind]), [
    ['solana:native', -0.000005, 'fee'],
    [`solana:${BONK}`, -1_000_000, 'transfer'],
  ]);
});

test('failed transaction is skipped', () => {
  assert.deepEqual(parseSolanaTransaction({ ...SWAP, meta: { ...SWAP.meta, err: { InstructionError: [2, { Custom: 6001 }] } } }, OWNER), []);
  assert.deepEqual(parseSolanaTransaction(null, OWNER), []);
});

test('plain SOL receive, dust ignored, fee payer with no other movement', () => {
  const recv = mkTx({ signature: sig('recv'), keys: [key(OTHER, true), key(OWNER)], pre: [10e9, 1e9], post: [10e9 - 250_000_000 - 5000, 1e9 + 250_000_000] });
  assert.deepEqual(parseSolanaTransaction(recv, OWNER).map((l) => [l.asset, l.qty, l.kind]), [['solana:native', 0.25, 'transfer']]);
  const dust = mkTx({ signature: sig('dust'), keys: [key(OTHER, true), key(OWNER)], pre: [10e9, 1e9], post: [10e9 - 5001, 1e9 + 1] });
  assert.deepEqual(parseSolanaTransaction(dust, OWNER), []);
  const vote = mkTx({ signature: sig('feeonly'), keys: [key(OWNER, true), key(POOL)], pre: [1e9, 5], post: [1e9 - 5000, 5] });
  assert.deepEqual(parseSolanaTransaction(vote, OWNER).map((l) => [l.id, l.qty, l.kind]), [[`solana:${sig('feeonly')}:fee`, -0.000005, 'fee']]);
});

test('token deltas: several accounts of one mint net out, WSOL is its own asset, NFTs skipped, closed account', () => {
  const t = mkTx({
    signature: sig('multi'),
    keys: [key(OWNER, true), key(TA_USDC), key(TA_USDC2), key(addr('taWSOL')), key(TA_NFT), key(TA_T22)],
    pre: [3e9, 2_039_280, 2_039_280, 2_039_280, 2_039_280, 2_039_280],
    post: [3e9 - 5000 + 2_039_280, 2_039_280, 0, 2_039_280, 2_039_280, 2_039_280],
    preTok: [tb(1, USDC, OWNER, 1_000_000, 6), tb(2, USDC, OWNER, 4_000_000, 6), tb(5, T22, OWNER, 700, 2, TOKEN_2022_PROGRAM)],
    // account 2 was emptied into account 1 and closed (no post entry); WSOL and an NFT arrive; T22 fully sent
    postTok: [tb(1, USDC, OWNER, 5_000_000, 6), tb(3, WSOL_MINT, OWNER, 2_000_000_000, 9), tb(4, NFT, OWNER, 1, 0)],
  });
  assert.deepEqual(parseSolanaTransaction(t, OWNER).map((l) => [l.asset, l.qty, l.kind]), [
    ['solana:native', 0.00203928, 'transfer'], // rent refund from the closed account
    ['solana:native', -0.000005, 'fee'],
    [`solana:${T22}`, -7, 'transfer'],
    [`solana:${WSOL_MINT}`, 2, 'transfer'],
  ]);
});

test('legacy shapes: string account keys with loadedAddresses, token balances without owner', () => {
  const t = mkTx({
    signature: sig('legacy'),
    keys: [OTHER, TA_OTHER],
    pre: [1e9, 2_039_280, 2_039_280],
    post: [1e9 - 5000, 2_039_280, 2_039_280],
    preTok: [],
    postTok: [{ accountIndex: 2, mint: BONK, uiTokenAmount: { amount: '250000', decimals: 5 } }],
  });
  t.meta.loadedAddresses = { writable: [TA_BONK], readonly: [] };
  assert.deepEqual(parseSolanaTransaction(t, OWNER), []); // cannot attribute without the account list
  assert.deepEqual(parseSolanaTransaction(t, OWNER, [TA_BONK]).map((l) => [l.asset, l.qty]), [[`solana:${BONK}`, 2.5]]);
});

const tokenAccount = (pubkey, mint, amount, decimals, program = 'spl-token') => ({
  pubkey,
  account: { lamports: 2039280, owner: program === 'spl-token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM, data: { program, space: 165,
    parsed: { type: 'account', info: { isNative: false, mint, owner: OWNER, state: 'initialized',
      tokenAmount: { amount: String(amount), decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) } } } } },
});
const SPL_ACCOUNTS = [
  tokenAccount(TA_USDC, USDC, 211_250_000, 6),
  tokenAccount(TA_USDC2, USDC, 750_000, 6),
  tokenAccount(TA_BONK, BONK, 0, 5),
  tokenAccount(TA_NFT, NFT, 1, 0),
];
const T22_ACCOUNTS = [tokenAccount(TA_T22, T22, 12345, 2, 'spl-token-2022')];

test('summarizeTokenAccounts sums per mint and flags NFTs', () => {
  const s = summarizeTokenAccounts([...SPL_ACCOUNTS, ...T22_ACCOUNTS, { pubkey: 'junk' }]);
  assert.deepEqual(s.map((h) => [h.mint, h.qty, h.isNft, h.accounts.length]), [
    [USDC, 212, false, 2], [BONK, 0, false, 1], [NFT, 1, true, 1], [T22, 123.45, false, 1],
  ]);
  assert.equal(s[0].amount, '212000000');
});

test('parseJupiterTokens tolerates shape differences', () => {
  const m = parseJupiterTokens([
    { id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, icon: 'https://img.test/usdc.png', isVerified: true },
    { id: BONK, symbol: 'Bonk', name: 'Bonk', decimals: 5, icon: 'javascript:alert(1)', isVerified: false },
    { id: T22, name: 'no symbol' }, null, 'x',
  ]);
  assert.deepEqual(m.get(USDC), { symbol: 'USDC', name: 'USD Coin', decimals: 6, icon: 'https://img.test/usdc.png', verified: true });
  assert.deepEqual([m.get(BONK).icon, m.get(BONK).verified], [null, false]);
  assert.equal(m.has(T22), false);
  assert.equal(parseJupiterTokens({ tokens: [{ address: USDC, symbol: 'USDC', logoURI: 'https://x.test/a.png', tags: ['verified'] }] }).get(USDC).verified, true);
  assert.equal(parseJupiterTokens({ error: 'nope' }).size, 0);
  assert.equal(parseJupiterTokens(undefined).size, 0);
});

// ---- end-to-end against a fake RPC (global fetch is stubbed; no network) ----
function fakeNetwork(t, handlers) {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'lite-api.jup.ag') {
      calls.push({ method: 'jupiter', params: u.searchParams.get('query').split(',') });
      return handlers.jupiter ? json(handlers.jupiter(u)) : json({ error: 'down' }, 404);
    }
    const req = JSON.parse(init.body);
    calls.push({ method: req.method, params: req.params });
    const result = handlers[req.method]?.(...req.params);
    if (result instanceof Error) return json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: result.message } });
    return json({ jsonrpc: '2.0', id: req.id, result: result ?? null });
  };
  return calls;
}
const cfg = { settings: { solanaRpc: 'http://rpc.test/' } };
const account = { id: 'sol1', label: 'Sol', type: 'solana', address: OWNER };
const balanceHandlers = {
  getBalance: () => ({ context: { slot: 1 }, value: 3_498_495_000 }),
  getTokenAccountsByOwner: (owner, filter) => ({ context: { slot: 1 }, value: filter.programId === TOKEN_PROGRAM ? SPL_ACCOUNTS : filter.programId === TOKEN_2022_PROGRAM ? T22_ACCOUNTS : [] }),
};

test('syncSolanaBalances: SOL + SPL + Token-2022, metadata, NFT and zero skipped', async (t) => {
  const db = openDb(':memory:');
  const calls = fakeNetwork(t, {
    ...balanceHandlers,
    jupiter: () => [{ id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, icon: 'https://img.test/usdc.png', isVerified: true }],
  });
  upsertAsset(db, { asset: `solana:${T22}`, symbol: 'TTT', chain: 'solana', decimals: 2, price_id: `solana:${T22}` }); // symbol backfilled earlier
  await syncSolanaBalances(db, cfg, account);

  const st = db.prepare('SELECT * FROM source_status WHERE source = ?').get('solana:sol1');
  assert.deepEqual([st.ok, st.message], [1, '3 assets']);
  const bal = Object.fromEntries(db.prepare('SELECT asset, qty FROM balances WHERE account_id = ?').all('sol1').map((r) => [r.asset, r.qty]));
  assert.deepEqual(bal, { 'solana:native': 3.498495, [`solana:${USDC}`]: 212, [`solana:${T22}`]: 123.45 });

  const asset = (k) => ({ ...db.prepare('SELECT symbol, name, chain, decimals, price_id, verified, logo FROM assets WHERE asset = ?').get(k) });
  assert.deepEqual(asset('solana:native'), { symbol: 'SOL', name: 'Solana', chain: 'solana', decimals: 9, price_id: 'coingecko:solana', verified: 1, logo: null });
  assert.deepEqual(asset(`solana:${USDC}`), { symbol: 'USDC', name: 'USD Coin', chain: 'solana', decimals: 6, price_id: `solana:${USDC}`, verified: 1, logo: 'https://img.test/usdc.png' });
  assert.equal(asset(`solana:${T22}`).symbol, 'TTT'); // unknown to Jupiter: known symbol is not replaced by '?'
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets WHERE asset = ?').get(`solana:${NFT}`).n, 0);

  // token accounts remembered for history (NFT excluded, empty account included)
  assert.deepEqual(kvGet(db, 'solana-token-accounts:sol1'), { [USDC]: [TA_USDC, TA_USDC2], [BONK]: [TA_BONK], [T22]: [TA_T22] });
  assert.deepEqual(calls.filter((c) => c.method === 'jupiter').map((c) => c.params.sort()), [[USDC, T22].sort()]);

  // second run: metadata comes from the kv cache (hit and miss both cached)
  await syncSolanaBalances(db, cfg, account);
  assert.equal(calls.filter((c) => c.method === 'jupiter').length, 1);
});

test('syncSolanaBalances degrades to "?" when the metadata API fails, and reports RPC errors as status', async (t) => {
  const db = openDb(':memory:');
  const handlers = { ...balanceHandlers };
  fakeNetwork(t, handlers);
  await syncSolanaBalances(db, cfg, account);
  assert.equal(db.prepare('SELECT symbol FROM assets WHERE asset = ?').get(`solana:${USDC}`).symbol, '?');
  assert.equal(db.prepare('SELECT qty FROM balances WHERE asset = ?').get(`solana:${USDC}`).qty, 212);

  handlers.getBalance = () => new Error('node is behind');
  await syncSolanaBalances(db, cfg, account); // must not throw
  const st = db.prepare('SELECT * FROM source_status WHERE source = ?').get('solana:sol1');
  assert.equal(st.ok, 0);
  assert.match(st.message, /getBalance: node is behind/);

  await syncSolanaBalances(db, cfg, { ...account, address: '0xnotsolana' });
  assert.match(db.prepare('SELECT message FROM source_status WHERE source = ?').get('solana:sol1').message, /Not a Solana address/);
});

test('syncSolanaHistory: owner + token-account signatures, dedupe, failed skipped, cursors, resume', async (t) => {
  const db = openDb(':memory:');
  const FAILED = sig('failed');
  const sigsFor = {
    [OWNER]: [{ signature: FAILED, slot: 30, err: { InstructionError: [0, 'Custom'] }, blockTime: 1790000900 }, { signature: sig('swap'), slot: 10, err: null, blockTime: 1790000000 }],
    [TA_USDC]: [{ signature: sig('swap'), slot: 10, err: null, blockTime: 1790000000 }],
    [TA_BONK]: [{ signature: sig('incoming'), slot: 20, err: null, blockTime: 1790000500 }],
  };
  const txs = { [sig('swap')]: SWAP, [sig('incoming')]: INCOMING };
  const handlers = {
    ...balanceHandlers,
    jupiter: () => [{ id: BONK, symbol: 'Bonk', name: 'Bonk', decimals: 5, isVerified: true }],
    getSignaturesForAddress: (address, opts) => {
      const all = sigsFor[address] || [];
      const stop = opts.until ? all.findIndex((s) => s.signature === opts.until) : -1;
      return stop === -1 ? all : all.slice(0, stop);
    },
    getTransaction: (s, opts) => {
      assert.deepEqual(opts, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 });
      return txs[s] ?? null;
    },
  };
  const calls = fakeNetwork(t, handlers);
  const count = (m) => calls.filter((c) => c.method === m).length;

  // kv has no token accounts yet (balances never ran): history discovers them itself
  await syncSolanaHistory(db, cfg, account);
  let st = db.prepare('SELECT * FROM source_status WHERE source = ?').get('solana-history:sol1');
  assert.deepEqual([st.ok, st.message], [1, '4 new events from 2 txs']);
  assert.equal(count('getSignaturesForAddress'), 5); // owner + 4 token accounts
  assert.equal(count('getTransaction'), 2); // swap fetched once, failed tx never fetched

  const ev = db.prepare('SELECT id, account_id, ts, tx, asset, qty, kind FROM events ORDER BY ts, id').all().map((r) => ({ ...r }));
  assert.deepEqual(ev.map((e) => [e.id, e.qty, e.kind]), [
    [`solana:${sig('swap')}:fee`, -0.000005, 'fee'],
    [`solana:${sig('swap')}:${USDC}`, 210.25, 'transfer'],
    [`solana:${sig('swap')}:native`, -1.5, 'transfer'],
    [`solana:${sig('incoming')}:${BONK}`, 1_000_000, 'transfer'],
  ]);
  assert.ok(ev.every((e) => e.account_id === 'sol1'));
  // every event asset is registered so the ledger join works
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events e LEFT JOIN assets a ON a.asset = e.asset WHERE a.asset IS NULL').get().n, 0);
  assert.equal(db.prepare('SELECT symbol FROM assets WHERE asset = ?').get(`solana:${BONK}`).symbol, 'Bonk');
  assert.equal(kvGet(db, `solana-sig:sol1:${OWNER}`), FAILED);
  assert.equal(kvGet(db, `solana-sig:sol1:${TA_BONK}`), sig('incoming'));
  assert.deepEqual(kvGet(db, 'solana-pending:sol1'), []);

  // nothing new: only signature polls, with `until` cursors
  await syncSolanaHistory(db, cfg, account);
  assert.equal(count('getTransaction'), 2);
  assert.equal(calls.at(-1).method, 'getSignaturesForAddress');
  assert.equal(calls.filter((c) => c.method === 'getSignaturesForAddress' && c.params[0] === OWNER).at(-1).params[1].until, FAILED);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 4);

  // a new tx appears but the RPC errors on getTransaction: status fails, the signature stays queued, and the next run resumes
  const NEW = sig('recv');
  sigsFor[OWNER].unshift({ signature: NEW, slot: 40, err: null, blockTime: 1790001000 });
  handlers.getTransaction = () => new Error('overloaded');
  await syncSolanaHistory(db, cfg, account);
  st = db.prepare('SELECT * FROM source_status WHERE source = ?').get('solana-history:sol1');
  assert.equal(st.ok, 0);
  assert.equal(kvGet(db, `solana-sig:sol1:${OWNER}`), NEW);
  assert.deepEqual(kvGet(db, 'solana-pending:sol1'), [[NEW, 40, 0]]);

  handlers.getTransaction = (s) => (s === NEW
    ? mkTx({ signature: NEW, blockTime: 1790001000, keys: [key(OTHER, true), key(OWNER)], pre: [10e9, 1e9], post: [10e9 - 250_005_000, 1e9 + 250_000_000] })
    : null);
  await syncSolanaHistory(db, cfg, account);
  st = db.prepare('SELECT * FROM source_status WHERE source = ?').get('solana-history:sol1');
  assert.deepEqual([st.ok, st.message], [1, '1 new events from 1 txs']);
  assert.equal(db.prepare('SELECT qty FROM events WHERE id = ?').get(`solana:${NEW}:native`).qty, 0.25);
  assert.deepEqual(kvGet(db, 'solana-pending:sol1'), []);
});
