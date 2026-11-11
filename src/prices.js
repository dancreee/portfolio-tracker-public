// Prices: live and historical, discovered by contract address so new tokens price themselves.
//  1. DefiLlama (coins.llama.fi): chain:address and coingecko ids, plus history for cost basis.
//  2. GeckoTerminal: DEX prices for long-tail/new tokens DefiLlama doesn't know yet.
//  3. Hyperliquid: own markets (see sources/hyperliquid.js).
//  4. Yahoo Finance: stock:TICKER for stock-like assets.
// Spam filtering: a token counts only if it's on a public token list (CoinGecko / Uniswap),
// DefiLlama prices it with good confidence, or it has real DEX liquidity.
import { fetchJson, num, hourBucket, log, nowSec } from './util.js';
import { kvGet, kvSet, setStatus, tx } from './db.js';
import { hlPairFor } from './sources/hyperliquid.js';

const LLAMA = 'https://coins.llama.fi';
const MIN_DEX_LIQUIDITY = 25_000;

function savePrice(db, priceId, price, change24h, confidence, source) {
  db.prepare(
    `INSERT INTO prices (price_id, price, change24h, confidence, updated_at, source) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(price_id) DO UPDATE SET price = excluded.price,
       change24h = COALESCE(excluded.change24h, prices.change24h), confidence = excluded.confidence,
       updated_at = excluded.updated_at, source = excluded.source`
  ).run(priceId, price, change24h ?? null, confidence ?? null, nowSec(), source);
}

// Price ids we care about: anything held now, or that appears in history.
function wantedPriceIds(db) {
  return db.prepare(`SELECT DISTINCT a.price_id, a.asset, a.chain FROM assets a
                     WHERE a.price_id IS NOT NULL AND (a.asset IN (SELECT asset FROM balances) OR a.asset IN (SELECT asset FROM events))`).all();
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

let tick = 0;
export async function refreshPrices(db, cfg) {
  tick++;
  const rows = wantedPriceIds(db);
  const llamaIds = [...new Set(rows.map((r) => r.price_id).filter((id) => !/^(hl|hlperp|stock|cex|gt|manual):/.test(id)))];
  let ok = true;
  const msgs = [];

  // DefiLlama current prices (+ 24h change every ~minute)
  try {
    const withChange = tick % 4 === 1;
    for (const ids of chunk(llamaIds, 60)) {
      const joined = ids.map(encodeURIComponent).join(',');
      const [cur, pct] = await Promise.all([
        fetchJson(`${LLAMA}/prices/current/${joined}?searchWidth=4h`),
        withChange ? fetchJson(`${LLAMA}/percentage/${joined}?period=24h`).catch(() => null) : null,
      ]);
      for (const [id, c] of Object.entries(cur.coins || {})) {
        const change = pct?.coins?.[id] != null ? pct.coins[id] / 100 : undefined;
        savePrice(db, id, num(c.price), change, c.confidence ?? 1, 'defillama');
        if ((c.confidence ?? 1) >= 0.9) db.prepare('UPDATE assets SET verified = 1 WHERE price_id = ? AND verified = 0').run(id);
        // Backfill names for tokens whose source had no metadata (e.g. Solana mints).
        if (c.symbol) db.prepare("UPDATE assets SET symbol = ?, name = COALESCE(NULLIF(name, '?'), ?) WHERE price_id = ? AND (symbol IS NULL OR symbol = '?')").run(String(c.symbol).toUpperCase(), c.symbol, id);
      }
    }
    msgs.push(`defillama ${llamaIds.length}`);
  } catch (e) {
    ok = false;
    msgs.push(`defillama: ${e.message}`);
  }

  // GeckoTerminal fallback for chain tokens DefiLlama doesn't price (every ~2 min)
  if (tick % 8 === 1) {
    try {
      const priced = new Set(db.prepare("SELECT price_id FROM prices WHERE source = 'defillama' AND price > 0").all().map((r) => r.price_id));
      const missing = rows.filter((r) => /^[a-z0-9-]+:0x[0-9a-f]{40}$/.test(r.price_id) && !priced.has(r.price_id));
      const byChain = {};
      for (const r of missing) {
        const chain = cfg.chains[r.chain];
        if (!chain?.gt) continue;
        (byChain[chain.gt] ||= []).push({ addr: r.price_id.split(':')[1], priceId: r.price_id });
      }
      let n = 0;
      for (const [net, list] of Object.entries(byChain)) {
        for (const part of chunk(list, 30)) {
          const url = `https://api.geckoterminal.com/api/v2/simple/networks/${net}/token_price/${part.map((p) => p.addr).join(',')}` +
            '?include_24hr_price_change=true&include_total_reserve_in_usd=true';
          const r = await fetchJson(url, { headers: { accept: 'application/json;version=20230302' } });
          const a = r?.data?.attributes || {};
          for (const p of part) {
            const price = num(a.token_prices?.[p.addr]);
            if (!price) continue;
            const reserve = num(a.total_reserve_in_usd?.[p.addr]);
            const change = a.h24_price_change_percentage?.[p.addr];
            savePrice(db, p.priceId, price, change != null ? num(change) / 100 : undefined, reserve >= MIN_DEX_LIQUIDITY ? 0.9 : 0.3, 'geckoterminal');
            if (reserve >= MIN_DEX_LIQUIDITY) db.prepare('UPDATE assets SET verified = 1 WHERE price_id = ?').run(p.priceId);
            n++;
          }
        }
      }
      msgs.push(`geckoterminal ${n}/${missing.length}`);
    } catch (e) {
      msgs.push(`geckoterminal: ${e.message}`);
    }
  }

  // Stocks via Yahoo (every ~minute)
  if (tick % 4 === 1) {
    const stocks = [...new Set(rows.map((r) => r.price_id).filter((id) => id.startsWith('stock:')))];
    for (const id of stocks) {
      try {
        const t = id.slice(6);
        const r = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1d&interval=5m`);
        const m = r.chart?.result?.[0]?.meta;
        if (m?.regularMarketPrice) {
          const prev = num(m.chartPreviousClose ?? m.previousClose);
          savePrice(db, id, num(m.regularMarketPrice), prev ? m.regularMarketPrice / prev - 1 : null, 1, 'yahoo');
        }
      } catch (e) {
        msgs.push(`yahoo ${id}: ${e.message}`);
      }
    }
  }
  setStatus(db, 'prices', ok, msgs.join(' · '));
}

// ---- Public token lists: mark tokens as verified so airdropped spam stays out of totals ----
export async function refreshTokenLists(db, cfg) {
  const last = kvGet(db, 'tokenlists:at', 0);
  if (nowSec() - last < 24 * 3600) return;
  const verified = new Set();
  const sources = [];
  try {
    const uni = await fetchJson('https://tokens.uniswap.org', { timeoutMs: 30000 });
    const byChainId = Object.fromEntries(Object.values(cfg.chains).map((c) => [c.chainId, c.name]));
    for (const t of uni.tokens || []) if (byChainId[t.chainId]) verified.add(`${byChainId[t.chainId]}:${t.address.toLowerCase()}`);
    sources.push('uniswap');
  } catch (e) { log.warn('uniswap token list', e.message); }
  for (const c of Object.values(cfg.chains)) {
    if (!c.cg) continue;
    try {
      const list = await fetchJson(`https://tokens.coingecko.com/${c.cg}/all.json`, { timeoutMs: 30000, retries: 1 });
      for (const t of list.tokens || []) verified.add(`${c.name}:${t.address.toLowerCase()}`);
      sources.push(c.cg);
    } catch { /* some chains have no list */ }
  }
  const upd = db.prepare('UPDATE assets SET verified = 1 WHERE asset = ?');
  tx(db, () => verified.forEach((a) => upd.run(a)));
  kvSet(db, 'tokenlists:set', [...verified]);
  kvSet(db, 'tokenlists:at', nowSec());
  setStatus(db, 'token-lists', true, `${verified.size} tokens from ${sources.length} lists`);
}

export function markVerifiedFromLists(db) {
  const set = kvGet(db, 'tokenlists:set', []);
  if (!set.length) return;
  const upd = db.prepare('UPDATE assets SET verified = 1 WHERE asset = ? AND verified = 0');
  tx(db, () => set.forEach((a) => upd.run(a)));
}

// ---- Historical prices for cost basis ----
// needs: array of { priceId, ts }. Returns Map key `${priceId}@${hour}` -> price.
export async function historicalPrices(db, needs) {
  const out = new Map();
  const get = db.prepare('SELECT price FROM price_history WHERE price_id = ? AND ts = ?');
  const put = db.prepare('INSERT OR REPLACE INTO price_history (price_id, ts, price) VALUES (?, ?, ?)');
  const missing = {};
  for (const { priceId, ts } of needs) {
    const h = hourBucket(ts);
    const k = `${priceId}@${h}`;
    if (out.has(k)) continue;
    const row = get.get(priceId, h);
    if (row) out.set(k, row.price);
    else (missing[priceId] ||= new Set()).add(h);
  }
  const now = nowSec();
  // DefiLlama batchHistorical for chain tokens and coingecko ids
  const llama = Object.entries(missing).filter(([id]) => !/^(hl|hlperp|stock|cex|manual):/.test(id));
  let batch = {};
  let count = 0;
  const flush = async () => {
    if (!count) return;
    try {
      const q = encodeURIComponent(JSON.stringify(batch));
      const r = await fetchJson(`${LLAMA}/batchHistorical?coins=${q}&searchWidth=6h`, { timeoutMs: 45000 });
      for (const [id, c] of Object.entries(r.coins || {})) {
        for (const p of c.prices || []) {
          const h = hourBucket(p.timestamp);
          // match back to the requested hour (llama returns the nearest point)
          const want = [...(missing[id] || [])].reduce((best, x) => (Math.abs(x - p.timestamp) < Math.abs(best - p.timestamp) ? x : best), h);
          put.run(id, want, num(p.price));
          out.set(`${id}@${want}`, num(p.price));
        }
      }
    } catch (e) {
      log.warn('historical prices', e.message);
    }
    batch = {};
    count = 0;
  };
  for (const [id, hours] of llama) {
    for (const h of hours) {
      if (h > now - 3600) continue; // too recent, use live price
      (batch[id] ||= []).push(h);
      if (++count >= 80) await flush();
    }
  }
  await flush();

  // Hyperliquid tokens: hourly candles from HL itself
  for (const [id, hours] of Object.entries(missing).filter(([id]) => id.startsWith('hl:') || id.startsWith('hlperp:'))) {
    const coin = id.startsWith('hlperp:') ? id.slice(7) : hlPairFor(id.slice(3));
    if (!coin) continue;
    const sorted = [...hours].sort((a, b) => a - b);
    // HL returns at most 5000 candles per request: fetch in windows
    for (let i = 0; i < sorted.length; ) {
      const start = sorted[i];
      const end = Math.min(start + 4000 * 3600, now);
      try {
        const candles = await fetchJson('https://api.hyperliquid.xyz/info', { method: 'POST',
          body: { type: 'candleSnapshot', req: { coin, interval: '1h', startTime: start * 1000, endTime: end * 1000 + 3600_000 } } });
        const byHour = new Map((candles || []).map((c) => [hourBucket(Math.floor(c.t / 1000)), num(c.c)]));
        while (i < sorted.length && sorted[i] <= end) {
          const p = byHour.get(sorted[i]);
          if (p) { put.run(id, sorted[i], p); out.set(`${id}@${sorted[i]}`, p); }
          i++;
        }
      } catch (e) {
        log.warn('hl candles', coin, e.message);
        break;
      }
    }
  }

  // Stocks: daily closes from Yahoo
  for (const [id, hours] of Object.entries(missing).filter(([id]) => id.startsWith('stock:'))) {
    const sorted = [...hours].sort((a, b) => a - b);
    try {
      const r = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(id.slice(6))}?period1=${sorted[0] - 7 * 86400}&period2=${sorted.at(-1) + 86400}&interval=1d`);
      const res = r.chart?.result?.[0];
      const ts = res?.timestamp || [];
      const closes = res?.indicators?.quote?.[0]?.close || [];
      for (const h of sorted) {
        let best = null;
        for (let j = 0; j < ts.length; j++) if (ts[j] <= h + 86400 && closes[j] != null) best = closes[j];
        if (best != null) { put.run(id, h, best); out.set(`${id}@${h}`, best); }
      }
    } catch (e) {
      log.warn('yahoo history', id, e.message);
    }
  }
  return out;
}
