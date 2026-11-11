// EVM wallets via Blockscout's REST API (v2).
// Blockscout lists every token an address holds (including new standards such as the
// ERC-8056 tokenized stocks on Robinhood Chain), so new assets show up on their own.
import { fetchJson, fromUnits, num, log, nowSec } from '../util.js';
import { autoChains } from '../chains.js';
import { syncAlchemyBalances, syncAlchemyHistory } from './alchemy.js';
import { upsertAsset, replaceBalances, insertEvents, kvGet, kvSet, setStatus } from '../db.js';

const NFT_TYPES = new Set(['ERC-721', 'ERC-1155', 'ERC-404']);
const MAX_PAGES_FIRST_SYNC = 200; // 50 items per page

const tokenAssetKey = (chain, addr) => `${chain.name}:${addr.toLowerCase()}`;
const nativeKey = (chain) => `${chain.name}:native`;

function registerNative(db, chain) {
  upsertAsset(db, { asset: nativeKey(chain), symbol: chain.native.symbol, name: chain.native.symbol, chain: chain.name, decimals: 18, price_id: chain.native.priceId, verified: 1 });
}

// Token amounts: raw integer / 10^decimals, times the UI multiplier when the token has one
// (rebasing share tokens such as tokenized stocks after splits/dividends).
export function tokenAmount(raw, decimals, uiMultiplier) {
  let v = fromUnits(raw, decimals ?? 18);
  if (uiMultiplier && uiMultiplier !== '1000000000000000000') v *= fromUnits(uiMultiplier, 18);
  return v;
}

function registerToken(db, chain, token) {
  const addr = token.address_hash || token.address;
  const rate = num(token.exchange_rate);
  upsertAsset(db, {
    asset: tokenAssetKey(chain, addr),
    symbol: token.symbol || '?',
    name: token.name || token.symbol,
    chain: chain.name,
    decimals: token.decimals == null ? null : Number(token.decimals),
    price_id: `${chain.llama}:${addr.toLowerCase()}`,
    verified: rate > 0 && token.reputation !== 'scam' ? 1 : 0,
    logo: token.icon_url || null,
  });
  // Explorer price as a fallback until/unless DefiLlama prices the token.
  if (rate > 0) {
    db.prepare(
      `INSERT INTO prices (price_id, price, change24h, confidence, updated_at, source) VALUES (?, ?, NULL, 0.9, ?, 'blockscout')
       ON CONFLICT(price_id) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at, source = 'blockscout', confidence = 0.9
       WHERE prices.source = 'blockscout' OR prices.updated_at < excluded.updated_at - 900`
    ).run(`${chain.llama}:${addr.toLowerCase()}`, rate, nowSec());
  }
  return tokenAssetKey(chain, addr);
}

const api = async (chain, path, params) => {
  const q = new URLSearchParams(params || {});
  let base = `${chain.api}/api/v2`;
  const out = nowSec() < creditsOutUntil;
  if (out && !chain.keyless) throw new Error(OUT_MSG);
  if (chain.blockscoutKey && chain.chainId && !out) {
    base = `https://api.blockscout.com/${chain.chainId}/api/v2`;
    q.set('apikey', chain.blockscoutKey);
  }
  const qs = q.size ? `?${q}` : '';
  try {
    return await fetchJson(`${base}${path}${qs}`, { timeoutMs: 30000, retries: 1 });
  } catch (e) {
    if (/HTTP 402/.test(e.message)) {
      if (/Featured chain/i.test(e.message)) throw new Error(`${chain.name} is not on Blockscout's free plan: add a free Alchemy API key under Settings`);
      if (/out of credits/i.test(e.message)) {
        creditsOutUntil = nowSec() + 3600;
        if (chain.keyless) return api(chain, path, params); // this chain's own explorer answers without a key
        throw new Error(OUT_MSG);
      }
      throw new Error(`Blockscout refused the request: ${String(e.message).replace(/apikey=[^&\s]+/g, 'apikey=…').slice(0, 220)}`);
    }
    if (/HTTP 403/.test(e.message) && /Just a moment|<!DOCTYPE/i.test(e.message)) {
      throw new Error(`${chain.name} explorer needs a Blockscout API key: add a free one under Settings`);
    }
    // never leak the key into logs or status messages
    throw new Error(String(e.message).replace(/apikey=[^&\s]+/g, 'apikey=…'));
  }
};

// Walk a paginated Blockscout list (newest first).
async function* pages(chain, path, { maxPages = MAX_PAGES_FIRST_SYNC } = {}) {
  let params = null;
  for (let i = 0; i < maxPages; i++) {
    const r = await api(chain, path, params);
    yield r.items || [];
    if (!r.next_page_params) return;
    params = Object.fromEntries(Object.entries(r.next_page_params).filter(([, v]) => v != null));
  }
}

const chainsFor = (cfg, account) => (account.chains || autoChains(cfg.chains)).map((n) => cfg.chains[n]).filter((c) => c?.api);

const useAlchemy = (chain) => chain.preferAlchemy && chain.alchemy && chain.alchemyKey;

// Blockscout's free plan has a daily credit allowance, so each wallet+chain is read on its own
// clock: often where it holds something, rarely where it is empty. "Refresh now" skips the wait.
export const evmForce = { until: 0 };
function due(db, key, seconds) {
  const k = `bs-last:${key}`;
  if (nowSec() >= evmForce.until && nowSec() - kvGet(db, k, 0) < seconds - 5) return false;
  kvSet(db, k, nowSec());
  return true;
}
const holdsSomething = (db, account, chain) => kvGet(db, `bs-count:${account.id}:${chain.name}`, 1) > 0;

// Set when Blockscout answers "Out of credits": keyed requests pause until then.
let creditsOutUntil = 0;
const OUT_MSG = 'Blockscout daily credits are used up. Showing the last known data and retrying within the hour';

// Alchemy bills per request, so its calls run on their own slower clock.
function alchemyDue(db, key, minutes) {
  const k = `alchemy-last:${key}`;
  if (nowSec() - kvGet(db, k, 0) < minutes * 60 - 5) return false;
  kvSet(db, k, nowSec());
  return true;
}

export async function syncEvmBalances(db, cfg, account) {
  for (const chain of chainsFor(cfg, account)) {
    if (useAlchemy(chain)) {
      if (alchemyDue(db, `balances:${account.id}:${chain.name}`, cfg.refresh?.alchemyBalancesMinutes ?? 10)) await syncAlchemyBalances(db, cfg, account, chain);
      continue;
    }
    const src = `evm:${account.id}:${chain.name}`;
    const every = holdsSomething(db, account, chain) ? (cfg.refresh?.evmBalancesSeconds ?? 300) : (cfg.refresh?.evmEmptyMinutes ?? 60) * 60;
    if (!due(db, `balances:${account.id}:${chain.name}`, every)) continue;
    try {
      const rows = [];
      registerNative(db, chain);
      let info;
      try {
        info = await api(chain, `/addresses/${account.address}`);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) info = { coin_balance: '0', has_tokens: false }; // address never seen on this chain
        else throw e;
      }
      rows.push({ asset: nativeKey(chain), qty: fromUnits(info.coin_balance || '0', 18) });
      if (info.has_tokens !== false) {
        for await (const items of pages(chain, `/addresses/${account.address}/tokens`, { maxPages: 20 })) {
          for (const it of items) {
            const t = it.token || {};
            if (NFT_TYPES.has(t.type) || t.decimals == null) continue;
            const asset = registerToken(db, chain, t);
            rows.push({ asset, qty: tokenAmount(it.value, t.decimals, t.ui_multiplier) });
          }
        }
      }
      replaceBalances(db, account.id, `${chain.name}:`, rows);
      kvSet(db, `bs-count:${account.id}:${chain.name}`, rows.filter((r) => r.qty).length);
      setStatus(db, src, true, `${rows.filter((r) => r.qty).length} assets`);
    } catch (e) {
      // Blockscout is down, erroring or out of credits: read this chain through Alchemy if possible.
      if (chain.alchemy && chain.alchemyKey && holdsSomething(db, account, chain)) {
        log.warn(src, `${e.message}; using Alchemy for this round`);
        if (alchemyDue(db, `balances:${account.id}:${chain.name}`, cfg.refresh?.alchemyBalancesMinutes ?? 10)) await syncAlchemyBalances(db, cfg, account, chain);
        continue;
      }
      setStatus(db, src, false, e.message);
      log.warn(src, e.message);
    }
  }
}

// Pure mappers from Blockscout items to event rows (exported for tests).
const lc = (a) => a?.hash?.toLowerCase() || null;
const tsOf = (s) => Math.floor(new Date(s).getTime() / 1000);

export function tokenTransferEvents(chain, accountId, me, t, asset) {
  const tok = t.token || {};
  if (NFT_TYPES.has(tok.type) || !t.total || t.total.decimals == null) return [];
  const qty = tokenAmount(t.total.value, t.total.decimals, t.total.ui_multiplier ?? tok.ui_multiplier);
  if (!qty) return [];
  const hash = t.transaction_hash || t.tx_hash;
  const base = { account_id: accountId, ts: tsOf(t.timestamp), tx: `${chain.name}:${hash}`, asset, kind: 'transfer' };
  const id = `${chain.name}:${hash}:tok:${t.log_index}`;
  const out = [];
  if (lc(t.to) === me) out.push({ ...base, id: `${id}:in`, qty, counterparty: lc(t.from) });
  if (lc(t.from) === me) out.push({ ...base, id: `${id}:out`, qty: -qty, counterparty: lc(t.to) });
  return out;
}

export function transactionEvents(chain, accountId, me, t) {
  const ts = tsOf(t.timestamp);
  const tx = `${chain.name}:${t.hash}`;
  const asset = nativeKey(chain);
  const fromMe = lc(t.from) === me;
  const out = [];
  const v = fromUnits(t.value || '0', 18);
  if (v && t.status === 'ok') {
    if (fromMe) out.push({ account_id: accountId, id: `${tx}:native:out`, ts, tx, asset, qty: -v, kind: 'transfer', counterparty: lc(t.to) });
    if (lc(t.to) === me) out.push({ account_id: accountId, id: `${tx}:native:in`, ts, tx, asset, qty: v, kind: 'transfer', counterparty: lc(t.from) });
  }
  const fee = fromUnits(t.fee?.value || '0', 18);
  if (fromMe && fee) out.push({ account_id: accountId, id: `${tx}:gas`, ts, tx, asset, qty: -fee, kind: 'fee' });
  return out;
}

export function internalEvents(chain, accountId, me, t) {
  if (t.success === false) return [];
  const v = fromUnits(t.value || '0', 18);
  if (!v) return [];
  const ts = tsOf(t.timestamp);
  const tx = `${chain.name}:${t.transaction_hash || t.tx_hash}`;
  const asset = nativeKey(chain);
  const id = `${tx}:int:${t.index ?? ''}:${t.transaction_index ?? ''}`;
  const out = [];
  if (lc(t.to) === me) out.push({ account_id: accountId, id: `${id}:in`, ts, tx, asset, qty: v, kind: 'transfer', counterparty: lc(t.from) });
  if (lc(t.from) === me) out.push({ account_id: accountId, id: `${id}:out`, ts, tx, asset, qty: -v, kind: 'transfer', counterparty: lc(t.to) });
  return out;
}

export async function syncEvmHistory(db, cfg, account) {
  const me = account.address;
  for (const chain of chainsFor(cfg, account)) {
    const src = `evm-history:${account.id}:${chain.name}`;
    const cursorKey = `cursor:${account.id}:${chain.name}`;
    // Blockscout (free) is the default. Alchemy (paid per request) is used only where Blockscout
    // cannot serve the chain (Base) or where its history sync failed before anything was stored.
    // A chain never mixes the two sources: their event ids differ and mixing would double count.
    const srcKey = `history-source:${account.id}:${chain.name}`;
    const histSrc = kvGet(db, srcKey, null);
    const canAlchemy = chain.alchemy && chain.alchemyKey;
    if (useAlchemy(chain) || (canAlchemy && histSrc === 'alchemy')) {
      if (alchemyDue(db, `history:${account.id}:${chain.name}`, cfg.refresh?.alchemyHistoryMinutes ?? 60)) await syncAlchemyHistory(db, cfg, account, chain);
      continue;
    }
    const from = kvGet(db, cursorKey, -1); // highest block already synced
    if (from >= 0) {
      const mins = holdsSomething(db, account, chain) ? (cfg.refresh?.evmHistoryMinutes ?? 30) : (cfg.refresh?.evmEmptyHistoryHours ?? 6) * 60;
      if (!due(db, `history:${account.id}:${chain.name}`, mins * 60)) continue;
    }
    try {
      registerNative(db, chain);
      const ev = [];
      let maxBlock = from;
      const walk = async (path, handle) => {
        outer: for await (const items of pages(chain, `/addresses/${me}/${path}`)) {
          for (const it of items) {
            const block = Number(it.block_number ?? 0);
            if (block < from) break outer; // already synced (the cursor block is re-read; ids dedupe)
            maxBlock = Math.max(maxBlock, block);
            ev.push(...handle(it));
          }
        }
      };
      await walk('token-transfers', (t) => {
        const tok = t.token || {};
        if (NFT_TYPES.has(tok.type) || !t.total || t.total.decimals == null) return [];
        return tokenTransferEvents(chain, account.id, me, t, registerToken(db, chain, tok));
      });
      await walk('transactions', (t) => transactionEvents(chain, account.id, me, t));
      await walk('internal-transactions', (t) => internalEvents(chain, account.id, me, t));

      const added = insertEvents(db, ev);
      kvSet(db, cursorKey, maxBlock);
      setStatus(db, src, true, `${added} new events`);
      if (added) log.info(src, `${added} new events`);
    } catch (e) {
      if (/HTTP 404/.test(e.message)) { setStatus(db, src, true, 'no activity'); continue; }
      if (canAlchemy && !histSrc && kvGet(db, cursorKey, null) == null) {
        try {
          log.warn(src, `${e.message}; falling back to Alchemy`);
          await syncAlchemyHistory(db, cfg, account, chain, { rethrowNotEnabled: true });
          kvSet(db, srcKey, 'alchemy');
          kvSet(db, `alchemy-last:history:${account.id}:${chain.name}`, nowSec());
          continue;
        } catch (e2) {
          if (!e2.alchemyNotEnabled) throw e2; // otherwise report the Blockscout error below
        }
      }
      setStatus(db, src, false, e.message);
      log.warn(src, e.message);
    }
  }
}
