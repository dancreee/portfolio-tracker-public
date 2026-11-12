// EVM wallets via Alchemy (free API key), for chains the Blockscout free plan does not cover (e.g. Base).
// Tokens are discovered from the wallet's ERC-20 balances; names/decimals come from the price API
// (DefiLlama) so spam tokens never cost a metadata call.
import { fetchJson, fromUnits, num, log, nowSec } from '../util.js';
import { upsertAsset, replaceBalances, insertEvents, kvGet, kvSet, setStatus } from '../db.js';

const nativeKey = (chain) => `${chain.name}:native`;
const tokenKey = (chain, addr) => `${chain.name}:${addr.toLowerCase()}`;
const hexToDec = (h) => (h && h !== '0x' ? BigInt(h).toString() : '0');

// The Alchemy app behind the key must have the network switched on (dashboard -> app -> Networks).
function notEnabled(chain) {
  const e = new Error(`${chain.name} is switched off for your Alchemy app: open the app in the Alchemy dashboard, go to Networks and enable ${chain.alchemy}`);
  e.alchemyNotEnabled = true;
  return e;
}

let rpcId = 0;
async function rpc(chain, method, params) {
  const url = `https://${chain.alchemy}.g.alchemy.com/v2/${chain.alchemyKey}`;
  let r;
  try {
    r = await fetchJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: ++rpcId, method, params }, timeoutMs: 30000 });
  } catch (e) {
    if (/is not enabled for this app/i.test(e.message)) throw notEnabled(chain);
    throw new Error(String(e.message).replaceAll(chain.alchemyKey, '…')); // never leak the key
  }
  if (r.error && /is not enabled for this app/i.test(r.error.message || '')) throw notEnabled(chain);
  if (r.error) throw new Error(`Alchemy ${method}: ${r.error.message || JSON.stringify(r.error)}`.replaceAll(chain.alchemyKey, '…'));
  return r.result;
}

function registerNative(db, chain) {
  upsertAsset(db, { asset: nativeKey(chain), symbol: chain.native.symbol, name: chain.native.symbol, chain: chain.name, decimals: 18, price_id: chain.native.priceId, verified: 1 });
}

// Look up symbol/decimals/price for unknown contracts in one DefiLlama call per 50.
// Contracts DefiLlama does not know are remembered and skipped for a day (almost always spam).
async function resolveTokens(db, chain, addrs) {
  const known = new Map();
  const getAsset = db.prepare('SELECT asset, decimals, symbol FROM assets WHERE asset = ?');
  const ignored = kvGet(db, `alchemy-ignored:${chain.name}`, {});
  const now = nowSec();
  const todo = [];
  for (const a of addrs) {
    const row = getAsset.get(tokenKey(chain, a));
    if (row && row.decimals != null) known.set(a, row);
    else if (!(ignored[a] > now - 86400)) todo.push(a);
  }
  for (let i = 0; i < todo.length; i += 50) {
    const part = todo.slice(i, i + 50);
    let coins = {};
    try {
      coins = (await fetchJson(`https://coins.llama.fi/prices/current/${part.map((a) => `${chain.llama}:${a}`).join(',')}?searchWidth=12h`)).coins || {};
    } catch (e) {
      log.warn('alchemy token lookup', e.message);
      continue; // try again next round
    }
    for (const a of part) {
      const c = coins[`${chain.llama}:${a}`];
      if (!c || c.decimals == null) { ignored[a] = now; continue; }
      const asset = tokenKey(chain, a);
      upsertAsset(db, { asset, symbol: String(c.symbol || '?').toUpperCase(), name: c.symbol, chain: chain.name, decimals: Number(c.decimals), price_id: `${chain.llama}:${a}`, verified: (c.confidence ?? 0) >= 0.9 ? 1 : 0 });
      known.set(a, { asset, decimals: Number(c.decimals) });
    }
  }
  kvSet(db, `alchemy-ignored:${chain.name}`, ignored);
  return known;
}

export async function syncAlchemyBalances(db, cfg, account, chain) {
  const src = `evm:${account.id}:${chain.name}`;
  try {
    registerNative(db, chain);
    const rows = [{ asset: nativeKey(chain), qty: fromUnits(hexToDec(await rpc(chain, 'eth_getBalance', [account.address, 'latest'])), 18) }];
    const raw = new Map();
    let pageKey;
    for (let i = 0; i < 20; i++) {
      const r = await rpc(chain, 'alchemy_getTokenBalances', [account.address, 'erc20', ...(pageKey ? [{ pageKey }] : [])]);
      for (const t of r.tokenBalances || []) {
        const v = hexToDec(t.tokenBalance);
        if (v !== '0') raw.set(t.contractAddress.toLowerCase(), v);
      }
      pageKey = r.pageKey;
      if (!pageKey) break;
    }
    const meta = await resolveTokens(db, chain, [...raw.keys()]);
    for (const [addr, v] of raw) {
      const m = meta.get(addr);
      if (!m) continue;
      let qty = fromUnits(v, m.decimals);
      const mult = kvGet(db, `ui-mult:${tokenKey(chain, addr)}`, null); // share tokens (tokenized stocks) after splits
      if (mult && mult !== '1000000000000000000') qty *= fromUnits(mult, 18);
      rows.push({ asset: tokenKey(chain, addr), qty });
    }
    replaceBalances(db, account.id, `${chain.name}:`, rows);
    setStatus(db, src, true, `${rows.filter((r) => r.qty).length} assets (${raw.size - (rows.length - 1)} unpriced tokens ignored)`);
    return true;
  } catch (e) {
    setStatus(db, src, false, e.message);
    log.warn(src, e.message);
    return false;
  }
}

// Pure mapper (exported for tests): one Alchemy transfer -> event row, or null.
export function transferEvent(chain, accountId, me, t, known) {
  const hash = t.hash;
  const ts = Math.floor(new Date(t.metadata?.blockTimestamp).getTime() / 1000);
  if (!hash || !Number.isFinite(ts)) return null;
  const from = t.from?.toLowerCase();
  const to = t.to?.toLowerCase();
  const dir = to === me ? 'in' : from === me ? 'out' : null;
  if (!dir) return null;
  let asset;
  let qty;
  if (t.category === 'external' || t.category === 'internal') {
    asset = nativeKey(chain);
    qty = t.rawContract?.value ? fromUnits(hexToDec(t.rawContract.value), 18) : num(t.value);
  } else if (t.category === 'erc20') {
    const addr = t.rawContract?.address?.toLowerCase();
    if (!addr || !known.has(addr)) return null; // unpriced / spam token
    asset = tokenKey(chain, addr);
    const dec = t.rawContract.decimal != null ? Number(BigInt(t.rawContract.decimal)) : known.get(addr).decimals;
    qty = t.rawContract.value ? fromUnits(hexToDec(t.rawContract.value), dec) : num(t.value);
  } else return null;
  if (!qty) return null;
  return {
    id: `${chain.name}:${t.uniqueId || `${hash}:${t.category}:${from}:${to}`}:${dir}`,
    account_id: accountId, ts, tx: `${chain.name}:${hash}`, asset, qty: dir === 'in' ? qty : -qty, kind: 'transfer',
    counterparty: dir === 'in' ? from : to,
  };
}

export async function syncAlchemyHistory(db, cfg, account, chain, { rethrowNotEnabled = false } = {}) {
  const src = `evm-history:${account.id}:${chain.name}`;
  const cursorKey = `cursor:${account.id}:${chain.name}`;
  const from = Math.max(0, kvGet(db, cursorKey, 0));
  const me = account.address;
  try {
    registerNative(db, chain);
    const transfers = [];
    let maxBlock = from;
    for (const side of ['fromAddress', 'toAddress']) {
      let pageKey;
      for (let i = 0; i < 100; i++) {
        const r = await rpc(chain, 'alchemy_getAssetTransfers', [{
          fromBlock: `0x${from.toString(16)}`, toBlock: 'latest', [side]: me,
          category: chain.alchemyInternal ? ['external', 'internal', 'erc20'] : ['external', 'erc20'],
          withMetadata: true, excludeZeroValue: true, maxCount: '0x3e8', order: 'asc', ...(pageKey ? { pageKey } : {}),
        }]);
        for (const t of r.transfers || []) {
          transfers.push(t);
          maxBlock = Math.max(maxBlock, Number(BigInt(t.blockNum)));
        }
        pageKey = r.pageKey;
        if (!pageKey) break;
      }
    }
    const addrs = [...new Set(transfers.filter((t) => t.category === 'erc20' && t.rawContract?.address).map((t) => t.rawContract.address.toLowerCase()))];
    const known = await resolveTokens(db, chain, addrs);
    const events = transfers.map((t) => transferEvent(chain, account.id, me, t, known)).filter(Boolean);
    const added = insertEvents(db, events);
    kvSet(db, cursorKey, maxBlock);
    setStatus(db, src, true, `${added} new events`);
    if (added) log.info(src, `${added} new events`);
  } catch (e) {
    if (rethrowNotEnabled && e.alchemyNotEnabled) throw e;
    setStatus(db, src, false, e.message);
    log.warn(src, e.message);
  }
}
