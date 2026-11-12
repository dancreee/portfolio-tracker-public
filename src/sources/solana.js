// Solana wallets via plain JSON-RPC (public endpoint by default): SOL + SPL / Token-2022 balances and history.
import { fetchJson, fromUnits, sleep, log, nowSec } from '../util.js';
import { DEFAULT_RPCS } from '../chains.js';
import { upsertAsset, replaceBalances, insertEvents, kvGet, kvSet, setStatus } from '../db.js';

const JUP_SEARCH = 'https://lite-api.jup.ag/tokens/v2/search';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_ASSET = 'solana:native';

const LAMPORTS = 1e9;
const MIN_NATIVE_LAMPORTS = 1000; // 0.000001 SOL: smaller native moves are ignored
const SIG_PAGE = 1000; // RPC maximum, and the per-address cap on first sync
const MAX_SIG_PAGES = 10; // incremental syncs: at most 10k new signatures per address per run
const DEFAULT_MAX_TX_PER_SYNC = 400; // the rest stays queued in kv for the next run
const MAX_TX_TRIES = 3; // getTransaction returning null this many runs in a row: give up on it
const META_KEY = 'solana-token-meta';
const META_TTL = 7 * 86400;
const META_MISS_TTL = 86400;

// Endpoints to try in order (Settings; defaults in chains.js).
const rpcUrl = (cfg) => (cfg?.solanaRpcs?.length ? cfg.solanaRpcs : DEFAULT_RPCS.solana);
const tokenAccountsKey = (accountId) => `solana-token-accounts:${accountId}`;
const pendingKey = (accountId) => `solana-pending:${accountId}`;
const cursorKey = (accountId, address) => `solana-sig:${accountId}:${address}`;

function checkAddress(address) {
  const a = String(address || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) throw new Error('Not a Solana address (expected a base58 public key)');
  return a;
}

const benched = new Map(); // endpoint -> unix seconds until which it is skipped
const hostOf = (u) => { try { return new URL(u).host; } catch { return 'rpc'; } };

// Tries each endpoint in turn. Errors name only the host, since custom URLs often carry a key.
async function rpc(urls, method, params) {
  const list = [urls].flat();
  const live = list.filter((u) => !(benched.get(u) > nowSec()));
  let last;
  for (const url of live.length ? live : list) {
    try {
      return await rpcOne(url, method, params);
    } catch (e) {
      if (list.length > 1) benched.set(url, nowSec() + 600);
      last = new Error(String(e.message).replaceAll(url, hostOf(url)));
    }
  }
  throw last;
}

async function rpcOne(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetchJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, timeoutMs: 30000 });
    if (r && !r.error && 'result' in r) return r.result;
    const err = r?.error || { message: 'malformed response' };
    // Some providers report rate limiting inside a 200 response.
    const limited = err.code === 429 || err.code === -32005 || /rate limit|too many requests/i.test(err.message || '');
    if (limited && attempt < 3) { await sleep(1500 * 2 ** attempt); continue; }
    throw new Error(`Solana RPC ${method}: ${err.message || JSON.stringify(err)}`);
  }
}

// ---------- pure helpers (exported for tests) ----------

/**
 * Sum jsonParsed token accounts (the `value` arrays of getTokenAccountsByOwner) per mint.
 * Returns [{ mint, decimals, amount (raw integer string), qty, accounts: [pubkey], isNft }].
 */
export function summarizeTokenAccounts(values) {
  const byMint = new Map();
  for (const v of values || []) {
    const info = v?.account?.data?.parsed?.info;
    const ta = info?.tokenAmount;
    if (!info?.mint || !ta || !/^\d+$/.test(String(ta.amount ?? ''))) continue;
    let h = byMint.get(info.mint);
    if (!h) byMint.set(info.mint, (h = { mint: info.mint, decimals: Number(ta.decimals) || 0, raw: 0n, accounts: [] }));
    h.raw += BigInt(ta.amount);
    if (v.pubkey && !h.accounts.includes(v.pubkey)) h.accounts.push(v.pubkey);
  }
  return [...byMint.values()].map((h) => ({
    mint: h.mint,
    decimals: h.decimals,
    amount: h.raw.toString(),
    qty: fromUnits(h.raw.toString(), h.decimals),
    accounts: h.accounts,
    isNft: h.decimals === 0 && h.raw === 1n,
  }));
}

/** Normalize a Jupiter tokens-v2 search response into Map(mint -> { symbol, name, decimals, icon, verified }). */
export function parseJupiterTokens(json) {
  const out = new Map();
  const list = Array.isArray(json) ? json : Array.isArray(json?.tokens) ? json.tokens : Array.isArray(json?.data) ? json.data : [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const mint = t.id || t.address || t.mint;
    if (typeof mint !== 'string' || typeof t.symbol !== 'string' || !t.symbol.trim()) continue;
    const icon = t.icon || t.logoURI || null;
    out.set(mint, {
      symbol: t.symbol.trim().slice(0, 32),
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 100) : null,
      decimals: Number.isInteger(t.decimals) ? t.decimals : null,
      icon: typeof icon === 'string' && /^https:\/\//.test(icon) ? icon : null,
      verified: t.isVerified === true || (Array.isArray(t.tags) && t.tags.includes('verified')),
    });
  }
  return out;
}

/**
 * Net deltas of `owner` in one getTransaction (jsonParsed) result, as event legs:
 * [{ id, ts, tx, asset, qty, kind: 'transfer' | 'fee', mint?, decimals? }]. Failed transactions give [].
 * `tokenAccounts` (optional iterable of the owner's token-account addresses) is only used for old
 * transactions whose token balance entries carry no `owner` field.
 */
export function parseSolanaTransaction(txJson, owner, tokenAccounts) {
  const meta = txJson?.meta;
  const message = txJson?.transaction?.message;
  const sig = txJson?.transaction?.signatures?.[0];
  if (!meta || !message || !sig || meta.err) return [];

  // jsonParsed lists every account (including address-table ones) as objects; raw encodings keep
  // loaded addresses separately. Either way the index order matches pre/postBalances.
  const keys = (message.accountKeys || []).map((k) => (typeof k === 'string' ? k : k?.pubkey));
  if (keys.length < (meta.postBalances || []).length && meta.loadedAddresses) {
    keys.push(...(meta.loadedAddresses.writable || []), ...(meta.loadedAddresses.readonly || []));
  }

  const ts = Number(txJson.blockTime) || 0;
  const tx = `solana:${sig}`;
  const legs = [];

  const i = keys.indexOf(owner);
  if (i !== -1 && meta.preBalances && meta.postBalances) {
    let lamports = Number(meta.postBalances[i] ?? 0) - Number(meta.preBalances[i] ?? 0);
    const fee = i === 0 ? Number(meta.fee) || 0 : 0;
    lamports += fee; // the fee is reported on its own leg
    if (Math.abs(lamports) > MIN_NATIVE_LAMPORTS) {
      legs.push({ id: `solana:${sig}:native`, ts, tx, asset: SOL_ASSET, qty: lamports / LAMPORTS, kind: 'transfer' });
    }
    if (fee > 0) legs.push({ id: `solana:${sig}:fee`, ts, tx, asset: SOL_ASSET, qty: -fee / LAMPORTS, kind: 'fee' });
  }

  const mine = tokenAccounts ? new Set(tokenAccounts) : null;
  const byMint = new Map();
  const collect = (entries, sign) => {
    for (const b of entries || []) {
      const amt = b?.uiTokenAmount?.amount;
      if (!b?.mint || !/^\d+$/.test(String(amt ?? ''))) continue;
      const isMine = b.owner ? b.owner === owner : !!mine?.has(keys[b.accountIndex]);
      if (!isMine) continue;
      let d = byMint.get(b.mint);
      if (!d) byMint.set(b.mint, (d = { raw: 0n, decimals: Number(b.uiTokenAmount.decimals) || 0 }));
      d.raw += sign * BigInt(amt);
    }
  };
  collect(meta.preTokenBalances, -1n);
  collect(meta.postTokenBalances, 1n);
  for (const [mint, d] of byMint) {
    if (d.raw === 0n) continue;
    if (d.decimals === 0 && (d.raw === 1n || d.raw === -1n)) continue; // NFT
    legs.push({
      id: `solana:${sig}:${mint}`, ts, tx, asset: `solana:${mint}`, qty: fromUnits(d.raw.toString(), d.decimals), kind: 'transfer',
      mint, decimals: d.decimals,
    });
  }
  return legs;
}

// ---------- token metadata ----------

// Look up symbol/name/logo for mints via Jupiter, cached in kv. Never throws: unknown mints are just absent.
async function tokenMeta(db, mints) {
  const cache = kvGet(db, META_KEY, {}) || {};
  const now = nowSec();
  const out = new Map();
  const need = [];
  for (const mint of new Set(mints)) {
    const c = cache[mint];
    if (c && !c.miss) out.set(mint, c);
    if (!c || now - (c.ts || 0) > (c.miss ? META_MISS_TTL : META_TTL)) need.push(mint);
  }
  let dirty = false;
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    try {
      const json = await fetchJson(`${JUP_SEARCH}?query=${chunk.join(',')}`, { retries: 1, timeoutMs: 15000 });
      const found = parseJupiterTokens(json);
      for (const mint of chunk) {
        const m = found.get(mint);
        if (m) {
          cache[mint] = { ...m, ts: now };
          out.set(mint, cache[mint]);
        } else if (!cache[mint] || cache[mint].miss) {
          cache[mint] = { miss: 1, ts: now };
        } else {
          cache[mint].ts = now; // keep the older good entry
        }
        dirty = true;
      }
    } catch (e) {
      log.warn('solana token metadata lookup failed:', e.message);
      break; // keep whatever is cached; symbols get backfilled from the price API
    }
  }
  if (dirty) kvSet(db, META_KEY, cache);
  return out;
}

function registerNative(db) {
  upsertAsset(db, { asset: SOL_ASSET, symbol: 'SOL', name: 'Solana', chain: 'solana', decimals: 9, price_id: 'coingecko:solana', verified: true });
}

// Register `solana:<mint>` assets. decimalsByMint: Map(mint -> decimals).
async function registerMints(db, decimalsByMint) {
  if (!decimalsByMint.size) return;
  const lookup = [...decimalsByMint.keys()].filter((m) => m !== WSOL_MINT);
  const metas = lookup.length ? await tokenMeta(db, lookup) : new Map();
  const existing = db.prepare('SELECT symbol FROM assets WHERE asset = ?');
  for (const [mint, decimals] of decimalsByMint) {
    const asset = `solana:${mint}`;
    const m = mint === WSOL_MINT ? { symbol: 'WSOL', name: 'Wrapped SOL', verified: true } : metas.get(mint);
    const known = existing.get(asset)?.symbol;
    upsertAsset(db, {
      asset,
      symbol: m?.symbol || (known && known !== '?' ? known : '?'), // never downgrade a known symbol
      name: m?.name ?? null,
      chain: 'solana',
      decimals: decimals ?? m?.decimals ?? null,
      price_id: `solana:${mint}`,
      verified: !!m?.verified,
      logo: m?.icon || undefined,
    });
  }
}

// ---------- balances ----------

async function fetchTokenHoldings(url, owner) {
  const values = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const r = await rpc(url, 'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]);
    values.push(...(r?.value || []));
  }
  return summarizeTokenAccounts(values);
}

// Remember token-account addresses per mint (union with earlier ones, so recently closed accounts
// still get their last transactions picked up by the history sync).
function rememberTokenAccounts(db, accountId, holdings) {
  const stored = kvGet(db, tokenAccountsKey(accountId), {}) || {};
  for (const h of holdings) {
    if (h.isNft) continue;
    stored[h.mint] = [...new Set([...(stored[h.mint] || []), ...h.accounts])];
  }
  kvSet(db, tokenAccountsKey(accountId), stored);
  return stored;
}

export async function syncSolanaBalances(db, cfg, account) {
  const src = `solana:${account.id}`;
  try {
    const owner = checkAddress(account.address);
    const url = rpcUrl(cfg);
    registerNative(db);
    const bal = await rpc(url, 'getBalance', [owner]);
    const lamports = typeof bal === 'object' && bal !== null ? bal.value : bal;
    const rows = [{ asset: SOL_ASSET, qty: fromUnits(String(lamports ?? 0), 9) }];

    const holdings = await fetchTokenHoldings(url, owner);
    rememberTokenAccounts(db, account.id, holdings);
    const held = holdings.filter((h) => !h.isNft && h.qty > 0);
    await registerMints(db, new Map(held.map((h) => [h.mint, h.decimals])));
    for (const h of held) rows.push({ asset: `solana:${h.mint}`, qty: h.qty });

    replaceBalances(db, account.id, 'solana:', rows);
    setStatus(db, src, true, `${rows.filter((r) => r.qty).length} assets`);
  } catch (e) {
    setStatus(db, src, false, e.message);
    log.warn(src, e.message);
  }
}

// ---------- history ----------

// New signatures for one address, newest first, back to `until` (exclusive).
async function collectSignatures(url, address, until) {
  const sigs = [];
  let before;
  let capped = false;
  for (let page = 0; ; page++) {
    const opts = { limit: SIG_PAGE };
    if (before) opts.before = before;
    if (until) opts.until = until;
    const batch = (await rpc(url, 'getSignaturesForAddress', [address, opts])) || [];
    sigs.push(...batch);
    if (batch.length < SIG_PAGE) break;
    // First sync: one page only. Incremental: keep paging, within reason.
    if (!until || page + 1 >= MAX_SIG_PAGES) { capped = true; break; }
    before = batch[batch.length - 1].signature;
  }
  return { sigs, capped };
}

export async function syncSolanaHistory(db, cfg, account) {
  const src = `solana-history:${account.id}`;
  try {
    const owner = checkAddress(account.address);
    const url = rpcUrl(cfg);
    registerNative(db);

    let byMint = kvGet(db, tokenAccountsKey(account.id));
    if (!byMint) byMint = rememberTokenAccounts(db, account.id, await fetchTokenHoldings(url, owner));
    const tokenAccounts = [...new Set(Object.values(byMint).flat())].filter((a) => a !== owner);

    // Work queue of signatures still to fetch, persisted so an interrupted or rate-limited run resumes.
    // Entries: [signature, slot, failedTries]
    const pKey = pendingKey(account.id);
    const pending = new Map((kvGet(db, pKey, []) || []).map(([s, slot, tries]) => [s, { slot: slot || 0, tries: tries || 0 }]));
    const savePending = () => kvSet(db, pKey, [...pending].map(([s, p]) => [s, p.slot, p.tries]));

    let capped = 0;
    for (const address of [owner, ...tokenAccounts]) {
      const cKey = cursorKey(account.id, address);
      const { sigs, capped: c } = await collectSignatures(url, address, kvGet(db, cKey));
      if (!sigs.length) continue;
      if (c) capped++;
      for (const s of sigs) {
        if (s.err || !s.signature || pending.has(s.signature)) continue; // failed txs moved nothing but the fee
        pending.set(s.signature, { slot: s.slot || 0, tries: 0 });
      }
      savePending(); // queue first, then advance the cursor: nothing is lost if we stop in between
      kvSet(db, cKey, sigs[0].signature);
    }

    const maxTx = Number(cfg?.settings?.solanaMaxTxPerSync) || DEFAULT_MAX_TX_PER_SYNC;
    const queue = [...pending].sort((a, b) => a[1].slot - b[1].slot).slice(0, maxTx);
    let events = [];
    let mints = new Map();
    let added = 0;
    let processed = 0;
    let missing = 0;
    const flush = async () => {
      await registerMints(db, mints);
      added += insertEvents(db, events);
      events = [];
      mints = new Map();
      savePending();
    };
    try {
      for (const [sig, p] of queue) {
        const txJson = await rpc(url, 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
        if (!txJson) {
          // Not available (yet) on this node: retry on later runs, then give up.
          if (++p.tries >= MAX_TX_TRIES) { pending.delete(sig); missing++; }
          continue;
        }
        for (const leg of parseSolanaTransaction(txJson, owner, tokenAccounts)) {
          const { mint, decimals, ...ev } = leg;
          if (mint) mints.set(mint, decimals);
          events.push({ ...ev, account_id: account.id });
        }
        pending.delete(sig);
        if (++processed % 25 === 0) await flush();
      }
    } finally {
      await flush();
    }

    let msg = `${added} new events from ${processed} txs`;
    if (pending.size) msg += `, ${pending.size} txs queued for next sync`;
    if (missing) msg += `, ${missing} txs unavailable from RPC`;
    if (capped) msg += `; signature list capped for ${capped} address(es), older history may be missing`;
    setStatus(db, src, true, msg);
    if (added) log.info(src, `${added} new events`);
  } catch (e) {
    setStatus(db, src, false, e.message);
    log.warn(src, e.message);
  }
}
