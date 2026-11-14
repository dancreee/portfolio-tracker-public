// Hyperliquid: public info API, no key. Spot balances, staking, perps, fills and ledger updates.
import { fetchJson, num, log, sleep, nowSec } from '../util.js';
import { upsertAsset, replaceBalances, insertEvents, kvGet, kvSet, setStatus, tx } from '../db.js';

const INFO = 'https://api.hyperliquid.xyz/info';

// Hyperliquid allows 1200 "weight" a minute per IP address, shared with anything else running on
// the same machine. Light requests cost 2, most others 20. Everything here goes through one budget
// that stays well under that, and a 429 pauses all requests for a minute instead of retrying.
const WEIGHT = { clearinghouseState: 2, spotClearinghouseState: 2, allMids: 2 };
const BUDGET_PER_MINUTE = 500;
const PAUSE_SECONDS = 60;
let spent = []; // [ms, weight] of the last minute
let pausedUntil = 0;
const SLOW_MSG = 'Hyperliquid asked us to slow down. Pausing its requests for a minute';
export const hlWeightUsed = () => { const t = Date.now() - 60_000; spent = spent.filter((x) => x[0] > t); return spent.reduce((s, x) => s + x[1], 0); };
export async function hlInfo(body) {
  const w = WEIGHT[body.type] ?? 20;
  for (let i = 0; ; i++) {
    if (Date.now() < pausedUntil) throw new Error(SLOW_MSG);
    if (hlWeightUsed() + w <= BUDGET_PER_MINUTE) break;
    if (i >= 30) throw new Error('Hyperliquid request budget is full, trying again shortly');
    await sleep(1000);
  }
  spent.push([Date.now(), w]);
  try {
    return await fetchJson(INFO, { method: 'POST', body, retry429: false });
  } catch (e) {
    if (e.status === 429) { pausedUntil = Date.now() + PAUSE_SECONDS * 1000; throw new Error(SLOW_MSG); }
    throw e;
  }
}
const info = hlInfo;
export function resetHlLimiter() { spent = []; pausedUntil = 0; lastFull = 0; lastRun.clear(); lastHist.clear(); fp.clear(); dirty.clear(); stakingCache.clear(); spotMeta = null; }

// ---- Market data ----
// Full market data (names, previous-day prices) once a minute; in between only the mid prices,
// which is a tenth of the cost.
let spotMeta = null; // { tokens, universe }
let pairByName = new Map(); // "@107" -> { base, quote }
let tokenPair = new Map(); // token name -> pair name quoted in USDC
let midKeys = new Map(); // price id -> { key in allMids, prev: previous-day price }
let lastFull = 0;
const FULL_SECONDS = 60;

const UPSERT_PRICE = `INSERT INTO prices (price_id, price, change24h, confidence, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(price_id) DO UPDATE SET price = excluded.price, change24h = excluded.change24h, updated_at = excluded.updated_at`;

export async function refreshHlMarket(db, { full = false } = {}) {
  if (!full && spotMeta && nowSec() - lastFull < FULL_SECONDS) {
    const mids = await info({ type: 'allMids' });
    const now = nowSec();
    const upd = db.prepare(UPSERT_PRICE);
    tx(db, () => {
      for (const [id, m] of midKeys) {
        const px = num(mids[m.key]);
        if (px) upd.run(id, px, m.prev ? px / m.prev - 1 : null, now);
      }
    });
    setStatus(db, 'hyperliquid-market', true, `${midKeys.size} markets`);
    return;
  }
  const [spot, perp] = await Promise.all([info({ type: 'spotMetaAndAssetCtxs' }), info({ type: 'metaAndAssetCtxs' })]);
  const [meta, spotCtxs] = spot;
  spotMeta = meta;
  pairByName = new Map();
  tokenPair = new Map();
  midKeys = new Map();
  const tokenByIndex = new Map(meta.tokens.map((t) => [t.index, t]));
  const ctxByCoin = new Map(spotCtxs.map((c) => [c.coin, c]));
  const now = Math.floor(Date.now() / 1000);
  const upd = db.prepare(UPSERT_PRICE);
  tx(db, () => {
    meta.universe.forEach((u, i) => {
      const base = tokenByIndex.get(u.tokens[0]);
      const quote = tokenByIndex.get(u.tokens[1]);
      if (!base || !quote) return;
      pairByName.set(u.name, { base: base.name, quote: quote.name });
      const ctx = ctxByCoin.get(u.name); // contexts are NOT index-aligned with the universe
      if (!ctx) return;
      const px = num(ctx.midPx ?? ctx.markPx);
      const prev = num(ctx.prevDayPx);
      // Only USDC-quoted pairs give a USD price; keep the most liquid one per token.
      if (quote.name !== 'USDC' || !px) return;
      const existing = tokenPair.get(base.name);
      if (existing && existing.vol >= num(ctx.dayNtlVlm)) return;
      tokenPair.set(base.name, { pair: u.name, vol: num(ctx.dayNtlVlm) });
      midKeys.set(`hl:${base.name}`, { key: u.name, prev });
      upd.run(`hl:${base.name}`, px, prev ? px / prev - 1 : null, now);
    });
    upd.run('hl:USDC', 1, 0, now);
    const [pmeta, pctxs] = perp;
    pmeta.universe.forEach((u, i) => {
      const c = pctxs[i];
      if (!c) return;
      const px = num(c.midPx ?? c.markPx);
      const prev = num(c.prevDayPx);
      if (px) { upd.run(`hlperp:${u.name}`, px, prev ? px / prev - 1 : null, now); midKeys.set(`hlperp:${u.name}`, { key: u.name, prev }); }
    });
  });
  lastFull = nowSec();
  setStatus(db, 'hyperliquid-market', true, `${midKeys.size} markets`);
}

function hlTokenAsset(db, name) {
  const asset = `hl:${name}`;
  // Spot tokens without their own USDC market (rare) fall back to the perp price of the same name.
  const priceId = tokenPair.has(name) || name === 'USDC' ? `hl:${name}` : `hlperp:${name.replace(/^U(?=BTC|ETH|SOL)/, '')}`;
  upsertAsset(db, { asset, symbol: name, name, chain: 'hyperliquid', decimals: null, price_id: priceId, verified: 1 });
  return asset;
}

// Spot "@107" / "PURR/USDC" -> base token name
const spotBase = (coin) => pairByName.get(coin)?.base || (coin.includes('/') ? coin.split('/')[0] : null);
const spotQuote = (coin) => pairByName.get(coin)?.quote || (coin.includes('/') ? coin.split('/')[1] : 'USDC');
const isSpotCoin = (coin) => coin.startsWith('@') || coin.includes('/');

// Accounts that hold something on Hyperliquid are read every round (two light requests). The rest
// are looked at every ten minutes, and staking (a heavier request) every five.
const IDLE_SECONDS = 600;
const STAKING_SECONDS = 300;
const lastRun = new Map(); // account id -> unix seconds
const stakingCache = new Map(); // account id -> { at, value }
const fp = new Map(); // account id -> balances + position sizes at the last read
const dirty = new Set(); // accounts whose balances or positions moved since their fills were last read
const lastHist = new Map(); // account id -> unix seconds of the last fills read
const hlActive = (db, id) => !!db.prepare("SELECT 1 FROM balances WHERE account_id = ? AND asset LIKE 'hl:%' AND qty > 0 LIMIT 1").get(id)
  || !!db.prepare("SELECT 1 FROM positions WHERE account_id = ? AND venue = 'hyperliquid' LIMIT 1").get(id);

export async function syncHlAccount(db, cfg, account, { force = false } = {}) {
  const src = `hyperliquid:${account.id}`;
  const active = hlActive(db, account.id);
  if (!force && !active && nowSec() - (lastRun.get(account.id) || 0) < IDLE_SECONDS) return;
  try {
    if (!spotMeta) await refreshHlMarket(db, { full: true });
    const user = account.address;
    const cached = stakingCache.get(account.id);
    const stakingDue = force || !cached || nowSec() - cached.at >= STAKING_SECONDS;
    const [spot, perp, freshStaking] = await Promise.all([
      info({ type: 'spotClearinghouseState', user }),
      info({ type: 'clearinghouseState', user }),
      stakingDue ? info({ type: 'delegatorSummary', user }).catch(() => undefined) : undefined,
    ]);
    if (freshStaking !== undefined) stakingCache.set(account.id, { at: nowSec(), value: freshStaking });
    const staking = freshStaking !== undefined ? freshStaking : cached?.value;
    lastRun.set(account.id, nowSec());
    const print = JSON.stringify([(spot.balances || []).map((b) => [b.coin, b.total]), (perp.assetPositions || []).map((p) => [p.position?.coin, p.position?.szi])]);
    if (fp.get(account.id) !== print) { fp.set(account.id, print); dirty.add(account.id); }
    const rows = [];
    for (const b of spot.balances || []) {
      const qty = num(b.total);
      if (!qty) continue;
      rows.push({ asset: hlTokenAsset(db, b.coin), qty, meta: { entryNtl: num(b.entryNtl), hold: num(b.hold) } });
    }
    if (staking) {
      const staked = num(staking.delegated) + num(staking.undelegated) + num(staking.totalPendingWithdrawal);
      if (staked) {
        upsertAsset(db, { asset: 'hl:HYPE:staked', symbol: 'HYPE', name: 'Staked HYPE', chain: 'hyperliquid', price_id: 'hl:HYPE' });
        rows.push({ asset: 'hl:HYPE:staked', qty: staked, meta: { staked: true } });
      }
    }
    // Perp account equity (margin + unrealized PnL) counts toward the total as USD.
    const equity = num(perp.marginSummary?.accountValue);
    if (equity) {
      upsertAsset(db, { asset: 'hl:perp-equity', symbol: 'USDC', name: 'Perps account equity', chain: 'hyperliquid', price_id: 'hl:USDC' });
      rows.push({ asset: 'hl:perp-equity', qty: equity, meta: { perpEquity: true, withdrawable: num(perp.withdrawable) } });
    }
    replaceBalances(db, account.id, 'hl:', rows);

    const now = Math.floor(Date.now() / 1000);
    tx(db, () => {
      db.prepare("DELETE FROM positions WHERE account_id = ? AND venue = 'hyperliquid'").run(account.id);
      const ins = db.prepare(`INSERT INTO positions (account_id, venue, coin, size, entry_px, mark_px, value, upnl, leverage, liq_px, margin, funding, updated_at)
                              VALUES (?, 'hyperliquid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const ap of perp.assetPositions || []) {
        const p = ap.position;
        const size = num(p.szi);
        if (!size) continue;
        const value = num(p.positionValue);
        ins.run(account.id, p.coin, size, num(p.entryPx), Math.abs(value / size), value, num(p.unrealizedPnl),
          num(p.leverage?.value), p.liquidationPx ? num(p.liquidationPx) : null, num(p.marginUsed), num(p.cumFunding?.sinceOpen), now);
      }
    });
    setStatus(db, src, true, `${rows.length} balances, ${(perp.assetPositions || []).length} perps`);
  } catch (e) {
    setStatus(db, src, false, e.message);
    log.warn(src, e.message);
  }
}

// Fills and transfers are heavier requests, so they are read when the account's balances or
// positions moved, and otherwise only every `maxAge` seconds as a safety net.
export async function syncHlHistory(db, cfg, account, { maxAge = 0 } = {}) {
  const src = `hyperliquid-history:${account.id}`;
  if (!dirty.has(account.id) && nowSec() - (lastHist.get(account.id) || 0) < maxAge) return 0;
  try {
    if (!spotMeta) await refreshHlMarket(db, { full: true });
    dirty.delete(account.id);
    lastHist.set(account.id, nowSec());
    const user = account.address;
    const key = `hl-fills:${account.id}`;
    let start = kvGet(db, key, 0);
    const events = [];
    const perpFills = [];
    for (let i = 0; i < 20; i++) {
      const fills = await info({ type: 'userFillsByTime', user, startTime: start, aggregateByTime: true });
      if (!fills?.length) break;
      for (const f of fills) {
        const ts = Math.floor(f.time / 1000);
        const px = num(f.px);
        const sz = num(f.sz);
        const id = `hl:${f.tid ?? f.hash + ':' + f.oid}`;
        if (isSpotCoin(f.coin)) {
          const base = spotBase(f.coin);
          if (!base) continue;
          const quote = spotQuote(f.coin);
          const sign = f.side === 'B' ? 1 : -1;
          const txid = `hl:${f.hash}:${f.oid}:${f.tid}`; // one trade per fill
          events.push({ id: `${id}:base`, account_id: account.id, ts, tx: txid, asset: hlTokenAsset(db, base), qty: sign * sz, kind: 'trade',
            price_usd: quote === 'USDC' ? px : null, meta: { venue: 'hyperliquid', px, quote } });
          events.push({ id: `${id}:quote`, account_id: account.id, ts, tx: txid, asset: hlTokenAsset(db, quote), qty: -sign * sz * px, kind: 'trade',
            price_usd: quote === 'USDC' ? 1 : null, meta: { venue: 'hyperliquid' } });
          const fee = num(f.fee);
          if (fee && f.feeToken) events.push({ id: `${id}:fee`, account_id: account.id, ts, tx: txid, asset: hlTokenAsset(db, f.feeToken), qty: -fee, kind: 'fee' });
        } else {
          perpFills.push({ id, account_id: account.id, ts, coin: f.coin, dir: f.dir, px, sz, closed_pnl: num(f.closedPnl), fee: num(f.fee) });
        }
      }
      const last = fills[fills.length - 1].time;
      if (fills.length < 2000 || last <= start) { start = last + 1; break; }
      start = last; // overlapping ms is fine: ids dedupe
    }
    const added = insertEvents(db, events);
    const insP = db.prepare(`INSERT OR IGNORE INTO perp_fills (id, account_id, ts, coin, dir, px, sz, closed_pnl, fee)
                             VALUES (@id, @account_id, @ts, @coin, @dir, @px, @sz, @closed_pnl, @fee)`);
    tx(db, () => perpFills.forEach((p) => insP.run(p)));
    kvSet(db, key, start);

    // Deposits / withdrawals / transfers, so cost basis can follow funds between accounts.
    const lkey = `hl-ledger:${account.id}`;
    const lstart = kvGet(db, lkey, 0);
    const updates = await info({ type: 'userNonFundingLedgerUpdates', user, startTime: lstart });
    const lev = [];
    let lmax = lstart;
    for (const u of updates || []) {
      lmax = Math.max(lmax, u.time + 1);
      const d = u.delta || {};
      const ts = Math.floor(u.time / 1000);
      const base = { account_id: account.id, ts, tx: `hl:${u.hash}`, kind: 'transfer' };
      const usdc = hlTokenAsset(db, 'USDC');
      if (d.type === 'deposit') lev.push({ ...base, id: `hl:${u.hash}:dep`, asset: usdc, qty: num(d.usdc), counterparty: 'bridge' });
      else if (d.type === 'withdraw') lev.push({ ...base, id: `hl:${u.hash}:wd`, asset: usdc, qty: -num(d.usdc), counterparty: 'bridge' });
      else if (d.type === 'spotTransfer' || d.type === 'send') {
        // "send" is the unified transfer: between users, or between the same user's spot/perp balances.
        const src = d.user?.toLowerCase();
        const dst = d.destination?.toLowerCase();
        if (src === dst) continue; // spot <-> perp move inside one account
        const out = src === user;
        const token = String(d.token || 'USDC').split(':')[0];
        lev.push({ ...base, id: `hl:${u.hash}:${d.nonce ?? ''}:st:${out ? 'out' : 'in'}`, asset: hlTokenAsset(db, token), qty: (out ? -1 : 1) * num(d.amount),
          counterparty: out ? dst : src });
        const fee = num(d.fee);
        if (out && fee) lev.push({ ...base, id: `hl:${u.hash}:${d.nonce ?? ''}:fee`, kind: 'fee', asset: hlTokenAsset(db, String(d.feeToken || token).split(':')[0]), qty: -fee });
      } else if (d.type === 'internalTransfer') {
        const out = d.user?.toLowerCase() === user;
        lev.push({ ...base, id: `hl:${u.hash}:it:${out ? 'out' : 'in'}`, asset: usdc, qty: (out ? -1 : 1) * num(d.usdc), counterparty: (out ? d.destination : d.user)?.toLowerCase() });
      }
    }
    const ladded = insertEvents(db, lev);
    kvSet(db, lkey, lmax);
    setStatus(db, src, true, `${added} new spot fills, ${perpFills.length} perp fills, ${ladded} transfers`);
    return added + ladded + perpFills.length;
  } catch (e) {
    setStatus(db, src, false, e.message);
    log.warn(src, e.message);
    return 0;
  }
}

// Pair name to use for candles of a spot token (e.g. "HYPE" -> "@107"), or perp coin as fallback.
export const hlPairFor = (name) => tokenPair.get(name)?.pair || (name === 'USDC' ? null : name.replace(/^U(?=BTC|ETH|SOL)/, ''));
