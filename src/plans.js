// Trade plans: one living plan per asset. Every save adds a version; the newest is the plan.
// "Closed trades" are not stored: they are read off the ledger as the stretches in which an asset
// went from nothing held to something held and back to nothing. A plan version belongs to the
// trade that was open (or next to open) when it was written, so buying an asset back after a full
// exit starts with a clean plan while the old one stays with its closed trade.
import { kvGet, kvSet } from './db.js';
import { nowSec } from './util.js';

export const plansEnabled = (cfg) => cfg.settings.plans === true;
export const DEFAULT_MIN_USD = 100;
/** Closed trades with a cost basis under this many dollars are left off the Closed tab. */
export const plansMinUsd = (cfg) => { const n = Number(cfg.settings.plansMinUsd); return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_USD; };
/** When trade plans were first switched on here. Trades closed before it never ask for an exit note. */
export const plansSince = (cfg) => Number(cfg.settings.plansSince) || 0;

const DUST = 0.001; // a position is fully exited once under 0.1% of its largest size is left
const MIN_USD = 1; // closed trades smaller than this are noise (dust, spam, airdrops)
const TEXT_FIELDS = ['thesis', 'invalidation', 'bear', 'base', 'bull'];

/**
 * Splits one asset's ledger events (newest first, as the ledger returns them) into trades, oldest
 * first. A trade opens with the first buy or deposit while nothing is held and closes when a sale takes
 * the holding down to dust. The last one has closedAt null while still open.
 */
export function tradeRounds(events) {
  const out = [];
  let qty = 0;
  let cur = null;
  for (let n = events.length - 1; n >= 0; n--) {
    const e = events[n];
    const q = Math.abs(e.qty || 0);
    if (e.cls === 'buy' || e.cls === 'deposit' || e.cls === 'income') {
      if (!cur) cur = { openedAt: e.ts, closedAt: null, buys: 0, sells: 0, inQty: 0, inUsd: 0, boughtQty: 0, boughtUsd: 0, soldQty: 0, proceeds: 0, realized: 0, peak: 0, minBuy: null, maxBuy: null, lastTrade: null };
      qty += q;
      cur.peak = Math.max(cur.peak, qty);
      cur.inQty += q;
      cur.inUsd += e.usd || 0;
      if (e.cls === 'buy') {
        cur.buys++;
        cur.boughtQty += q;
        cur.boughtUsd += e.usd || 0;
        if (e.unitPrice > 0) {
          cur.minBuy = cur.minBuy == null ? e.unitPrice : Math.min(cur.minBuy, e.unitPrice);
          cur.maxBuy = cur.maxBuy == null ? e.unitPrice : Math.max(cur.maxBuy, e.unitPrice);
        }
        cur.lastTrade = { ts: e.ts, cls: 'buy', qty: q, unitPrice: e.unitPrice ?? null };
      }
    } else if (e.cls === 'sell' || e.cls === 'withdraw' || e.cls === 'fee') {
      const covered = Math.min(q, qty);
      qty -= covered;
      if (!cur) continue;
      if (e.cls === 'sell') {
        cur.sells++;
        cur.soldQty += covered;
        cur.proceeds += q ? (e.usd || 0) * (covered / q) : 0;
        cur.lastTrade = { ts: e.ts, cls: 'sell', qty: q, unitPrice: e.unitPrice ?? null };
      }
      cur.realized += e.realized || 0;
      // Only a sale ends a trade (or a fee or transfer that sweeps up the last crumbs after one).
      // Moving the whole holding somewhere the tracker cannot see, such as a staking contract,
      // leaves the trade open so its plan stays attached.
      const ends = e.cls === 'sell' || (cur.sells > 0 && covered <= cur.peak * 0.01);
      if (ends && qty <= cur.peak * DUST) {
        cur.closedAt = e.ts;
        out.push(cur);
        cur = null;
        qty = 0;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Trades are recomputed only when the ledger is rebuilt (a new Map each time).
const cache = new WeakMap();
function roundsOf(ledger, group) {
  if (!ledger) return [];
  let m = cache.get(ledger);
  if (!m) cache.set(ledger, (m = new Map()));
  if (!m.has(group)) m.set(group, tradeRounds(ledger.get(group)?.events || []));
  return m.get(group);
}
// A closed trade worth listing: it ended with at least one sale and was more than dust.
const isClosedTrade = (r) => r.closedAt != null && r.sells > 0 && Math.max(r.proceeds, r.proceeds - r.realized) >= MIN_USD;
const closedOf = (ledger, group) => roundsOf(ledger, group).filter(isClosedTrade);
const costOf = (r) => r.proceeds - r.realized;
const openOf = (ledger, group) => { const r = roundsOf(ledger, group).at(-1); return r && r.closedAt == null ? r : null; };

const planRow = (r) => ({ id: r.id, at: r.created_at, thesis: r.thesis || '', invalidation: r.invalidation || '', entry: r.entry || '', stop: r.stop, target: r.target, bear: r.bear || '', base: r.base || '', bull: r.bull || '' });
const versionsOf = (db, group) => db.prepare('SELECT * FROM plans WHERE grp = ? ORDER BY created_at DESC, id DESC').all(group).map(planRow);

/** Versions of the current plan, newest first: everything written since the last closed trade. */
function currentVersions(db, ledger, group) {
  const lastClose = closedOf(ledger, group).at(-1)?.closedAt ?? -1;
  return versionsOf(db, group).filter((v) => v.at > lastClose);
}
const reviewedAt = (db, group) => kvGet(db, `planReviewed:${group}`, 0) || 0;
/** The latest buy or sell made after the plan was last written or confirmed, if any. */
function pendingReview(db, ledger, group, plan) {
  const t = openOf(ledger, group)?.lastTrade;
  return plan && t && t.ts > Math.max(plan.at, reviewedAt(db, group)) ? t : null;
}

/** For the summary: plan state per asset group ('ok' | 'review'; absent = no plan) and the closed count. */
export function plansOverview(db, cfg, ledger) {
  const state = new Map();
  for (const { grp } of db.prepare('SELECT DISTINCT grp FROM plans').all()) {
    const plan = currentVersions(db, ledger, grp)[0];
    if (plan) state.set(grp, pendingReview(db, ledger, grp, plan) ? 'review' : 'ok');
  }
  let closed = 0;
  const min = plansMinUsd(cfg);
  if (ledger) for (const g of ledger.keys()) if (!cfg.stables.has(g)) closed += closedOf(ledger, g).filter((r) => costOf(r) >= min).length;
  return { state, closed };
}

/** Everything the asset view needs about one asset's plan. */
export function planFor(db, cfg, ledger, group) {
  const versions = currentVersions(db, ledger, group);
  const open = openOf(ledger, group);
  return {
    plan: versions[0] || null,
    versions,
    review: pendingReview(db, ledger, group, versions[0]),
    // what the app already knows about the entry, to pre-fill the form
    entry: open ? { since: open.openedAt, buys: open.buys, avgBuy: open.boughtQty ? open.boughtUsd / open.boughtQty : null, minBuy: open.minBuy, maxBuy: open.maxBuy } : null,
  };
}

const level = (v, name) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a price above zero, or left blank`);
  return n;
};
export function savePlan(db, cfg, ledger, b) {
  const group = String(b.group || '').trim();
  if (!group) throw new Error('group required');
  const row = { grp: group, created_at: nowSec(), entry: String(b.entry ?? '').trim().slice(0, 80), stop: level(b.stop, 'Stop'), target: level(b.target, 'Target') };
  for (const k of TEXT_FIELDS) row[k] = String(b[k] ?? '').trim().slice(0, 4000);
  if (!row.thesis && !row.invalidation && row.stop == null && row.target == null && !TEXT_FIELDS.some((k) => row[k])) throw new Error('Write a thesis, an invalidation or a level before saving');
  const last = currentVersions(db, ledger, group)[0];
  const same = last && ['entry', 'stop', 'target', ...TEXT_FIELDS].every((k) => (last[k] ?? '') === (row[k] ?? ''));
  if (!same) {
    // two saves within the same second still need distinct, ordered versions
    if (last && row.created_at <= last.at) row.created_at = last.at + 1;
    db.prepare('INSERT INTO plans (grp, created_at, thesis, invalidation, entry, stop, target, bear, base, bull) VALUES (@grp, @created_at, @thesis, @invalidation, @entry, @stop, @target, @bear, @base, @bull)').run(row);
  }
  return planFor(db, cfg, ledger, group);
}
export function markReviewed(db, group) {
  kvSet(db, `planReviewed:${group}`, nowSec());
}

/**
 * Fully exited trades, newest first, each with the plan as it stood at the exit and its notes.
 * Trades under the size set in Settings are counted in `hidden` instead of listed. `wantsNote`
 * marks a trade closed since plans were switched on that has no exit note yet.
 */
export function closedTrades(db, cfg, ledger) {
  const min = plansMinUsd(cfg);
  const since = plansSince(cfg);
  const out = [];
  let hidden = 0;
  if (!ledger) return { trades: out, hidden, minUsd: min, since };
  const notes = new Map(db.prepare('SELECT * FROM trade_notes').all().map((n) => [`${n.grp}|${n.closed_at}`, n]));
  for (const group of ledger.keys()) {
    if (cfg.stables.has(group)) continue;
    const closed = closedOf(ledger, group);
    if (!closed.length) continue;
    const versions = versionsOf(db, group);
    let prev = -1;
    for (const r of closed) {
      const mine = versions.filter((v) => v.at > prev && v.at <= r.closedAt);
      prev = r.closedAt;
      const note = notes.get(`${group}|${r.closedAt}`);
      const cost = costOf(r);
      if (cost < min) { hidden++; continue; }
      out.push({
        group, openedAt: r.openedAt, closedAt: r.closedAt, buys: r.buys, sells: r.sells,
        cost, proceeds: r.proceeds, realized: r.realized, realizedPct: cost > 0 ? r.realized / cost : null,
        avgBuy: r.boughtQty ? r.boughtUsd / r.boughtQty : r.inQty ? r.inUsd / r.inQty : null,
        avgSell: r.soldQty ? r.proceeds / r.soldQty : null,
        plan: mine[0] || null, versions: mine,
        exitNote: note?.exit_note || '', lesson: note?.lesson || '',
        wantsNote: !note?.exit_note && r.closedAt >= since,
      });
    }
  }
  out.sort((a, b) => b.closedAt - a.closedAt);
  return { trades: out, hidden, minUsd: min, since };
}
export function saveTradeNote(db, cfg, ledger, b) {
  const group = String(b.group || '');
  const closedAt = Number(b.closedAt);
  if (!closedOf(ledger, group).some((r) => r.closedAt === closedAt)) throw new Error('That closed trade no longer exists');
  db.prepare(`INSERT INTO trade_notes (grp, closed_at, exit_note, lesson, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(grp, closed_at) DO UPDATE SET exit_note = excluded.exit_note, lesson = excluded.lesson, updated_at = excluded.updated_at`)
    .run(group, closedAt, String(b.exitNote ?? '').trim().slice(0, 4000), String(b.lesson ?? '').trim().slice(0, 1000), nowSec());
}
