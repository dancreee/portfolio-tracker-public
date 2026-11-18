// Imports a portfolio history exported from another tracker, so the value chart, cost basis and
// category breakdown do not start from the day this tracker was installed.
//
// Input: one JSON object per line (JSONL), one per snapshot:
//   { "t": "2025-03-01T00:00:00Z",          time (ISO string or unix seconds)
//     "v": 12000,                            total portfolio value in USD
//     "p": [ { "sy": "ETH", "amt": 1.5, "px": 3300, "usd": 4950, "cat": "MAJOR.ETH", "ty": "Idle" } ] }
// "p" (positions) is optional; without it only the value chart is filled.
//
// What it writes:
//   - snapshots (src = 'import') for the time before this tracker's own first snapshot;
//   - imported_prices: one price per asset group per UTC day, a fallback for cost basis;
//   - setting:categories: a category per asset group.
// Running it again replaces what an earlier import wrote.
import { tx, kvSet } from './db.js';
import { groupOf } from './config.js';
import { categoryLabel, OTHER } from './categories.js';

const DERIVATIVE = /^futures/i; // a futures row's value is exposure or margin, not a holding
const toSec = (t) => (typeof t === 'number' ? Math.floor(t > 1e11 ? t / 1000 : t) : Math.floor(Date.parse(t) / 1000));

export function parseHistory(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    const ts = toSec(o.t);
    if (!Number.isFinite(ts) || !Number.isFinite(o.v)) continue;
    out.push({ ts, total: o.v, positions: Array.isArray(o.p) ? o.p : [] });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// skip: [[fromSec, toSec], ...] periods to leave out (for example while the other tracker was missing accounts)
export function importHistory(db, cfg, snaps, { skip = [] } = {}) {
  const skipped = (ts) => skip.some(([a, b]) => ts >= a && ts < b);
  const own = db.prepare('SELECT MIN(ts) AS ts FROM snapshots WHERE src IS NULL').get().ts ?? Infinity;
  const prices = new Map(); // "grp|day" -> { price, usd }
  const cats = new Map(); // grp -> { label, usd }
  let chart = 0;
  let left = 0;

  tx(db, () => {
    db.prepare("DELETE FROM snapshots WHERE src = 'import'").run();
    db.prepare('DELETE FROM imported_prices').run();
    const ins = db.prepare("INSERT OR REPLACE INTO snapshots (ts, total, data, src) VALUES (?, ?, ?, 'import')");
    for (const s of snaps) {
      const day = Math.floor(s.ts / 86400);
      const byGroup = {};
      for (const p of s.positions) {
        if (!p?.sy || DERIVATIVE.test(p.ty || '')) continue;
        const grp = groupOf(p.sy, cfg);
        const usd = Math.abs(Number(p.usd) || 0);
        if (Number(p.usd) > 0) byGroup[grp] = (byGroup[grp] || 0) + Number(p.usd);
        if (p.px > 0 && p.amt > 0 && !cfg.stables.has(grp)) {
          const k = `${grp}|${day}`;
          if (!prices.has(k) || usd >= prices.get(k).usd) prices.set(k, { price: Number(p.px), usd });
        }
        const label = categoryLabel(p.cat);
        if (label && label !== OTHER && (!cats.has(grp) || usd >= cats.get(grp).usd)) cats.set(grp, { label, usd });
      }
      if (skipped(s.ts) || s.ts >= own || !(s.total > 0)) { left++; continue; }
      const top = Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([g, v]) => [g, Math.round(v * 100) / 100]);
      ins.run(s.ts, s.total, JSON.stringify(Object.fromEntries(top)));
      chart++;
    }
    const insP = db.prepare('INSERT OR REPLACE INTO imported_prices (grp, day, price) VALUES (?, ?, ?)');
    for (const [k, v] of prices) { const [grp, day] = k.split('|'); insP.run(grp, Number(day), v.price); }
  });
  const categories = Object.fromEntries([...cats].map(([g, c]) => [g, c.label]));
  kvSet(db, 'setting:categories', categories);
  return { snapshots: chart, leftOut: left, prices: prices.size, categories: Object.keys(categories).length };
}
