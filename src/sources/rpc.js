// Balances through free public JSON-RPC endpoints, tried in order.
// A plain RPC can answer "how much of token X does this wallet hold" but cannot list which tokens
// a wallet holds or its transfer history. So it only refreshes tokens the explorer already found,
// and reports whether anything moved, which is what triggers the next explorer read.
import { fetchJson, fromUnits, log, nowSec } from '../util.js';
import { kvGet, kvSet, replaceBalances, setStatus } from '../db.js';

export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const AGGREGATE3 = '82ad56cb'; // aggregate3((address,bool,bytes)[])
const GET_ETH_BALANCE = '4d2301cc'; // getEthBalance(address)
const BALANCE_OF = '70a08231'; // balanceOf(address)
const CHUNK = 150; // tokens per multicall
const BENCH_SECONDS = 600; // a failing endpoint is skipped this long

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

/** Call data for Multicall3.aggregate3 where every inner call is a 4-byte selector plus one address. */
export function encodeAggregate3(calls) {
  const n = calls.length;
  const TUPLE = 6 * 32; // target, allowFailure, bytes offset, bytes length, 36 bytes of data padded to 64
  let out = AGGREGATE3 + word(32) + word(n);
  for (let i = 0; i < n; i++) out += word(n * 32 + i * TUPLE);
  for (const c of calls) {
    out += pad(c.target) + word(1) + word(96) + word(36) + (c.selector + pad(c.arg)).padEnd(128, '0');
  }
  return `0x${out}`;
}

/** Decode aggregate3's (bool success, bytes returnData)[] into BigInt values (null where a call failed). */
export function decodeAggregate3(hex, n) {
  const d = String(hex || '').replace(/^0x/, '');
  const at = (byte) => {
    const s = d.slice(byte * 2, byte * 2 + 64);
    if (s.length !== 64) throw new Error('short multicall response');
    return BigInt(`0x${s}`);
  };
  const arr = Number(at(0));
  if (Number(at(arr)) !== n) throw new Error('unexpected multicall response');
  const base = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + Number(at(base + i * 32));
    const ok = at(t) === 1n;
    const b = t + Number(at(t + 32));
    out.push(ok && Number(at(b)) >= 32 ? at(b + 32) : null);
  }
  return out;
}

const benched = new Map(); // url -> unix seconds until which it is skipped
const hostOf = (url) => { try { return new URL(url).host; } catch { return 'rpc'; } };

/** One JSON-RPC call against the first endpoint that answers. Never includes a URL path in errors (may hold a key). */
export async function rpcCall(urls, method, params, { chainId } = {}) {
  let lastErr = new Error('no public RPC configured');
  const now = nowSec();
  const live = urls.filter((u) => !(benched.get(u) > now));
  for (const url of live.length ? live : urls) {
    try {
      if (chainId && !verified.has(url)) {
        const id = await raw(url, 'eth_chainId', []);
        if (Number(BigInt(id)) !== Number(chainId)) throw new Error(`serves chain ${Number(BigInt(id))}, expected ${chainId}`);
        verified.add(url);
      }
      return await raw(url, method, params);
    } catch (e) {
      benched.set(url, nowSec() + BENCH_SECONDS);
      lastErr = new Error(`${hostOf(url)}: ${String(e.message).replaceAll(url, hostOf(url)).slice(0, 160)}`);
    }
  }
  throw lastErr;
}
const verified = new Set(); // endpoints whose chain id has been checked this run

async function raw(url, method, params) {
  const r = await fetchJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, timeoutMs: 12000, retries: 0 });
  if (!r || r.error || !('result' in r)) throw new Error(r?.error?.message || 'malformed response');
  return r.result;
}

/** Native balance plus balanceOf for each token, as decimal strings (null where the token call failed). */
export async function readBalances(chain, owner, tokens) {
  const opt = { chainId: chain.chainId };
  const mc = chain.multicall === false ? null : (chain.multicall || MULTICALL3);
  if (mc) {
    try {
      const calls = [{ target: mc, selector: GET_ETH_BALANCE, arg: owner }, ...tokens.map((t) => ({ target: t, selector: BALANCE_OF, arg: owner }))];
      const vals = [];
      for (let i = 0; i < calls.length; i += CHUNK) {
        const part = calls.slice(i, i + CHUNK);
        const res = await rpcCall(chain.rpcs, 'eth_call', [{ to: mc, data: encodeAggregate3(part) }, 'latest'], opt);
        vals.push(...decodeAggregate3(res, part.length));
      }
      if (vals[0] == null) throw new Error('multicall returned no native balance');
      return { native: vals[0].toString(), tokens: vals.slice(1).map((v) => (v == null ? null : v.toString())) };
    } catch (e) {
      if (tokens.length > 25) throw e; // too many single calls for a public endpoint
    }
  }
  const native = BigInt(await rpcCall(chain.rpcs, 'eth_getBalance', [owner, 'latest'], opt)).toString();
  const out = [];
  for (const t of tokens) {
    try {
      const r = await rpcCall(chain.rpcs, 'eth_call', [{ to: t, data: `0x${BALANCE_OF}${pad(owner)}` }, 'latest'], opt);
      out.push(r && r.length >= 66 ? BigInt(r.slice(0, 66)).toString() : null);
    } catch { out.push(null); }
  }
  return { native, tokens: out };
}

/**
 * Refresh one wallet's balances on one chain from public RPCs, for the tokens it is already known to hold.
 * Returns null when no endpoint answered, otherwise { changed } (false on the very first read).
 */
export async function syncRpcBalances(db, account, chain) {
  if (!chain.rpcs?.length) return null;
  const key = `${account.id}:${chain.name}`;
  const prefix = `${chain.name}:`;
  const held = db.prepare(
    `SELECT b.asset, a.decimals FROM balances b JOIN assets a ON a.asset = b.asset
     WHERE b.account_id = ? AND b.asset LIKE ? AND a.decimals IS NOT NULL`
  ).all(account.id, `${prefix}0x%`);
  let res;
  try {
    res = await readBalances(chain, account.address, held.map((h) => h.asset.slice(prefix.length)));
  } catch (e) {
    log.warn(`rpc:${key}`, e.message);
    return null;
  }
  // A token whose call failed keeps its last known amount rather than dropping to zero.
  const prev = new Map(db.prepare('SELECT asset, qty FROM balances WHERE account_id = ? AND asset LIKE ?').all(account.id, `${prefix}%`).map((r) => [r.asset, r.qty]));
  const rows = [{ asset: `${prefix}native`, qty: fromUnits(res.native, 18) }];
  held.forEach((h, i) => {
    const v = res.tokens[i];
    if (v == null) { rows.push({ asset: h.asset, qty: prev.get(h.asset) || 0 }); return; }
    let qty = fromUnits(v, h.decimals);
    const mult = kvGet(db, `ui-mult:${h.asset}`, null); // share tokens (tokenized stocks) after splits
    if (mult && mult !== '1000000000000000000') qty *= fromUnits(mult, 18);
    rows.push({ asset: h.asset, qty });
  });
  replaceBalances(db, account.id, prefix, rows);
  // Raw amounts from the last read. Only assets present in both reads are compared, so a token the
  // explorer has just added does not count as a move.
  const fp = { native: res.native };
  held.forEach((h, i) => { if (res.tokens[i] != null) fp[h.asset] = res.tokens[i]; });
  const old = kvGet(db, `rpc-fp:${key}`, null);
  const changed = !!old && Object.keys(fp).some((k) => k in old && old[k] !== fp[k]);
  if (!old || JSON.stringify(old) !== JSON.stringify(fp)) kvSet(db, `rpc-fp:${key}`, fp);
  kvSet(db, `rpc-ok:${key}`, nowSec());
  setStatus(db, `evm:${key}`, true, `${rows.filter((r) => r.qty).length} assets (public RPC)`);
  return { changed };
}
