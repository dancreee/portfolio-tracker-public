// Pearl (prl1... addresses): a Bitcoin-like UTXO chain with no JSON API. The explorer is server-rendered
// Next.js and embeds the address data as escaped JSON inside self.__next_f.push(...) script chunks.
import { sleep, log, num } from '../util.js';
import { upsertAsset, replaceBalances, insertEvents, setStatus } from '../db.js';

const EXPLORER = 'https://explorer.pearlresearch.ai';
export const PEARL_ASSET = 'pearl:PRL';

async function fetchText(url, { timeoutMs = 20000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': 'Mozilla/5.0 (compatible; portfolio-tracker/0.1)',
        },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return await res.text();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`Timeout fetching ${new URL(url).host}`) : e;
      if (attempt < retries) await sleep(1500);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// Return the balanced {...} or [...] starting at text[start] (string-aware), or null.
function extractBalanced(text, start, maxLen = 4_000_000) {
  const open = text[start];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inStr = false;
  const end = Math.min(text.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (--depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const tryJson = (s) => {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
};

const NUM = '(-?\\d[\\d.eE+-]*)';
// Read a numeric value for `key` out of a JSON-ish fragment without parsing it.
function readNum(fragment, key) {
  const m = new RegExp(`"${key}":"?${NUM}`).exec(fragment);
  return m ? num(m[1]) : null;
}

function normalizeTx(o) {
  if (!o || typeof o !== 'object' || !/^[0-9a-f]{64}$/i.test(String(o.txid || ''))) return null;
  const has = (k) => o[k] !== undefined && o[k] !== null && Number.isFinite(Number(o[k]));
  if (!has('netAmount') && !(has('sent') && has('received'))) return null; // nested vin/vout refs etc
  const sent = num(o.sent);
  const received = num(o.received);
  return {
    txid: String(o.txid).toLowerCase(),
    time: has('time') ? Math.floor(Number(o.time)) : 0,
    sent,
    received,
    netAmount: has('netAmount') ? Number(o.netAmount) : received - sent,
    fee: num(o.fee),
    confirmations: has('confirmations') ? Number(o.confirmations) : null,
  };
}

/**
 * Pure parser for the explorer's address page.
 * Returns { address, balance, unconfirmedBalance, received, sent, txCount, transactions: [{ txid, time, sent,
 * received, netAmount, fee, confirmations }] }. Throws if the address summary cannot be found.
 */
export function parsePearlAddressPage(html) {
  const text = String(html ?? '')
    // The flight payload can be split across consecutive push() chunks: stitch them back together.
    .replace(/"\]\)\s*<\/script>\s*<script[^>]*>\s*self\.__next_f\.push\(\[\d+,\s*"/g, '')
    .replace(/\\+"/g, '"');

  // --- address summary ---
  let info = null;
  let infoAt = -1;
  const marker = '"addressInfo":';
  for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) {
    const start = i + marker.length;
    const raw = extractBalanced(text, start);
    const parsed = tryJson(raw);
    if (parsed && parsed.balance !== undefined) { info = parsed; infoAt = i; break; }
    // Not valid JSON (odd escaping): read the keys individually from the flat fragment.
    const frag = raw || text.slice(start, start + 600);
    if (readNum(frag, 'balance') !== null) {
      info = {
        a_id: /"a_id":"([^"]+)"/.exec(frag)?.[1],
        balance: readNum(frag, 'balance'),
        unconfirmedBalance: readNum(frag, 'unconfirmedBalance'),
        received: readNum(frag, 'received'),
        sent: readNum(frag, 'sent'),
        tx_count: readNum(frag, 'tx_count'),
      };
      infoAt = i;
      break;
    }
  }
  if (!info) throw new Error('Pearl explorer: address summary not found in page (layout changed?)');

  // --- transactions (first page) ---
  const byId = new Map();
  const add = (t) => { if (t && !byId.has(t.txid)) byId.set(t.txid, t); };
  const tMarker = '"transactions":';
  let from = text.indexOf(tMarker, infoAt);
  if (from === -1) from = text.indexOf(tMarker);
  if (from !== -1) {
    const arr = tryJson(extractBalanced(text, from + tMarker.length));
    if (Array.isArray(arr)) arr.forEach((o) => add(normalizeTx(o)));
  }
  if (byId.size === 0) {
    // Fallback: locate each object holding a txid and read its keys one by one (order independent).
    const re = /"txid":"([0-9a-f]{64})"/gi;
    const hits = [...text.matchAll(re)];
    hits.forEach((m, idx) => {
      const start = text.lastIndexOf('{', m.index);
      if (start === -1) return;
      const raw = extractBalanced(text, start, 200_000);
      const parsed = tryJson(raw);
      if (parsed) return add(normalizeTx(parsed));
      const stop = Math.min(hits[idx + 1]?.index ?? text.length, start + 4000);
      const frag = raw || text.slice(start, stop);
      const o = { txid: m[1] };
      for (const k of ['time', 'sent', 'received', 'netAmount', 'fee', 'confirmations']) {
        const v = readNum(frag, k);
        if (v !== null) o[k] = v;
      }
      add(normalizeTx(o));
    });
  }

  return {
    address: info.a_id || null,
    balance: num(info.balance),
    unconfirmedBalance: num(info.unconfirmedBalance),
    received: num(info.received),
    sent: num(info.sent),
    txCount: info.tx_count == null ? null : num(info.tx_count),
    transactions: [...byId.values()],
  };
}

const r8 = (x) => Math.round(x * 1e8) / 1e8;

/** Pure: turn parsed transactions into ledger events for one account. Unconfirmed txs are left for a later sync. */
export function pearlEvents(parsed, accountId) {
  const ev = [];
  for (const t of parsed.transactions) {
    if (!t.time || t.confirmations === 0) continue;
    const base = { account_id: accountId, ts: t.time, tx: `pearl:${t.txid}`, asset: PEARL_ASSET };
    let qty = r8(t.netAmount);
    if (qty < 0 && t.fee > 0) {
      // The miner fee is included in the net outflow: report it separately.
      qty = r8(qty + t.fee);
      if (qty > 0) qty = r8(t.netAmount); // fee was not paid by this address after all: keep the raw net
      else ev.push({ ...base, id: `pearl:${t.txid}:${accountId}:fee`, qty: -r8(t.fee), kind: 'fee' });
    }
    if (qty) ev.push({ ...base, id: `pearl:${t.txid}:${accountId}`, qty, kind: 'transfer', meta: { confirmations: t.confirmations } });
  }
  return ev;
}

export async function syncPearl(db, cfg, account) {
  const src = `pearl:${account.id}`;
  try {
    const address = String(account.address || '').trim();
    if (!/^prl1[0-9a-z]{10,100}$/i.test(address)) throw new Error('Not a Pearl address (expected prl1...)');
    const html = await fetchText(`${EXPLORER}/address/${encodeURIComponent(address)}?network=mainnet`);
    const parsed = parsePearlAddressPage(html);
    if (parsed.address && parsed.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error('Pearl explorer returned data for a different address');
    }
    upsertAsset(db, { asset: PEARL_ASSET, symbol: 'PRL', name: 'Pearl', chain: 'pearl', decimals: 8, price_id: 'coingecko:pearl-2', verified: true });
    replaceBalances(db, account.id, 'pearl:', [
      { asset: PEARL_ASSET, qty: parsed.balance, meta: parsed.unconfirmedBalance ? { unconfirmed: parsed.unconfirmedBalance } : undefined },
    ]);
    const added = insertEvents(db, pearlEvents(parsed, account.id));
    const n = parsed.transactions.length;
    let msg = `${parsed.balance} PRL, ${n} txs parsed, ${added} new events`;
    if (parsed.txCount != null && parsed.txCount > n) msg += `; only the first page is read (${n} of ${parsed.txCount} txs), older history is missing`;
    setStatus(db, src, true, msg);
    if (added) log.info(src, `${added} new events`);
  } catch (e) {
    setStatus(db, src, false, e.message);
    log.warn(src, e.message);
  }
}
