// Turns raw events (transfers, fills, fees) into classified buys/sells and runs average-cost basis.
//
// Classification, per transaction:
//   - Legs are netted per asset group (so wrapping ETH -> WETH is a no-op).
//   - Explicit fills (Hyperliquid, CEX, manual) are buys/sells at their execution price.
//   - A transaction that sends one asset and receives another is a swap: buy + sell,
//     both valued at the USD value of the swap (stablecoin side preferred).
//   - A one-way move to/from one of your own addresses, or one that matches an opposite move
//     in another of your accounts (same asset, ~same amount, within 3 days) is internal: basis carries over.
//   - Anything else received is a deposit at market price; anything else sent is a withdrawal
//     (reduces holdings and basis proportionally, no realized PnL). Gas/trading fees are realized losses.
// Every classification can be overridden per event from the UI.
import { groupOf } from './config.js';
import { historicalPrices } from './prices.js';
import { hourBucket } from './util.js';

const MATCH_WINDOW = 3 * 86400;
const MATCH_TOLERANCE = 0.03; // bridges and CEX withdrawals take fees

const TRUSTED_PREFIX = /^(hl:|cex:|manual:|pearl:)/;

// Hyperliquid system addresses that move a token between HyperCore and HyperEVM. The asset stays
// yours on the other side, so these moves keep their cost basis instead of counting as a sale.
const isHlBridge = (a) => a === '0x2222222222222222222222222222222222222222' || /^0x20{30,}[0-9a-f]*$/.test(a);

export async function buildLedger(db, cfg) {
  const rows = db.prepare(`
    SELECT e.*, a.symbol, a.price_id, a.verified, a.chain, o.class AS o_class, o.price_usd AS o_price, o.note AS o_note,
           p.price AS cur_price, p.confidence
    FROM events e JOIN assets a ON a.asset = e.asset
    LEFT JOIN overrides o ON o.event_id = e.id
    LEFT JOIN prices p ON p.price_id = a.price_id
    ORDER BY e.ts, e.id`).all();

  // Drop spam: only assets on a token list, priced with confidence, or from trusted venues.
  const legs = rows.filter((r) => TRUSTED_PREFIX.test(r.asset) || r.verified || (r.cur_price > 0 && (r.confidence ?? 0) >= 0.9) || r.o_class)
    .map((r) => ({ ...r, group: groupOf(r.symbol, cfg), meta: r.meta ? JSON.parse(r.meta) : null }));

  // ---- 1. per-transaction netting & classification ----
  const byTx = new Map();
  for (const l of legs) {
    const k = `${l.account_id}|${l.tx}`;
    if (!byTx.has(k)) byTx.set(k, []);
    byTx.get(k).push(l);
  }
  const items = []; // classified legs
  for (const group of byTx.values()) {
    const fees = group.filter((l) => l.kind === 'fee');
    const moves = group.filter((l) => l.kind !== 'fee');
    // net per asset group
    const net = new Map();
    for (const l of moves) {
      const n = net.get(l.group) || { ...l, qty: 0, ids: [], explicit: false, priceUsd: null };
      n.qty += l.qty;
      n.ids.push(l.id);
      if (l.kind === 'trade') n.explicit = true;
      if (l.price_usd != null) n.priceUsd = l.price_usd;
      if (l.o_class) { n.o_class = l.o_class; n.o_price = l.o_price; n.o_note = l.o_note; n.id = l.id; }
      net.set(l.group, n);
    }
    const nets = [...net.values()].filter((n) => Math.abs(n.qty) > 1e-12 || n.o_class);
    const ins = nets.filter((n) => n.qty > 0);
    const outs = nets.filter((n) => n.qty < 0);
    const isSwap = (ins.length && outs.length) || nets.some((n) => n.explicit);
    for (const n of nets) {
      let cls;
      if (isSwap) cls = n.qty > 0 ? 'buy' : 'sell';
      else if (n.counterparty && (cfg.ownAddresses.has(n.counterparty) || isHlBridge(n.counterparty))) cls = 'internal';
      else cls = n.qty > 0 ? 'deposit' : 'withdraw';
      items.push({ ...n, auto: cls, cls: n.o_class || cls, txLegs: nets });
    }
    for (const f of fees) items.push({ ...f, ids: [f.id], auto: 'fee', cls: f.o_class || 'fee', txLegs: [] });
  }

  // ---- 2. cross-account matching of one-way transfers -> internal ----
  const deposits = items.filter((i) => i.cls === 'deposit' && !i.o_class).sort((a, b) => a.ts - b.ts);
  const withdraws = items.filter((i) => i.cls === 'withdraw' && !i.o_class).sort((a, b) => a.ts - b.ts);
  for (const w of withdraws) {
    const amt = -w.qty;
    const match = deposits.find((d) => !d.matched && d.group === w.group && d.tx !== w.tx &&
      d.ts >= w.ts - 600 && d.ts - w.ts <= MATCH_WINDOW && d.qty <= amt * 1.001 && d.qty >= amt * (1 - MATCH_TOLERANCE));
    if (match) {
      match.matched = w.matched = true;
      match.cls = w.cls = 'internal';
      match.pair = w.id;
      w.pair = match.id;
    }
  }

  // ---- 3. prices for valuation ----
  const needs = [];
  // A swap leg needs no market price when the other side is a stablecoin or an exact fill.
  const anchored = (i) => (i.cls === 'buy' || i.cls === 'sell') &&
    (i.txLegs || []).some((l) => l.group !== i.group && (cfg.stables.has(l.group) || l.priceUsd != null || l.o_price != null));
  for (const i of items) {
    if (['internal', 'fee', 'ignore'].includes(i.cls) || i.priceUsd != null || i.o_price != null || !i.price_id || cfg.stables.has(i.group) || anchored(i)) continue;
    needs.push({ priceId: i.price_id, ts: i.ts });
  }
  const hist = await historicalPrices(db, needs);
  const unitPrice = (i) => {
    if (i.o_price != null) return { p: i.o_price, src: 'override' };
    if (i.priceUsd != null) return { p: i.priceUsd, src: 'fill' };
    if (cfg.stables.has(i.group)) return { p: 1, src: 'stable' };
    const h = hist.get(`${i.price_id}@${hourBucket(i.ts)}`);
    if (h != null) return { p: h, src: 'historical' };
    if (i.cur_price) return { p: i.cur_price, src: 'current (no history)' };
    return { p: null, src: 'unknown' };
  };
  for (const i of items) {
    const u = unitPrice(i);
    i.unitPrice = u.p;
    i.priceSrc = u.src;
    i.marketUsd = u.p != null ? Math.abs(i.qty) * u.p : null;
  }
  // swap valuation: both sides take the value of the most reliable side
  const swapTx = new Map();
  for (const i of items) if (i.cls === 'buy' || i.cls === 'sell') {
    const k = `${i.account_id}|${i.tx}`;
    if (!swapTx.has(k)) swapTx.set(k, []);
    swapTx.get(k).push(i);
  }
  for (const legsOfTx of swapTx.values()) {
    const buys = legsOfTx.filter((l) => l.cls === 'buy');
    const sells = legsOfTx.filter((l) => l.cls === 'sell');
    const sideValue = (side) => {
      if (!side.length || side.some((l) => l.marketUsd == null)) return null;
      return side.reduce((s, l) => s + l.marketUsd, 0);
    };
    const reliability = (side) => (side.some((l) => l.priceSrc === 'stable' || l.priceSrc === 'fill' || l.priceSrc === 'override') ? 2 : side.every((l) => l.priceSrc === 'historical') ? 1 : 0);
    const bv = sideValue(buys);
    const sv = sideValue(sells);
    let value = null;
    if (bv != null && sv != null) value = reliability(sells) >= reliability(buys) ? sv : bv;
    else value = sv ?? bv;
    for (const side of [buys, sells]) {
      const total = side.reduce((s, l) => s + (l.marketUsd ?? 0), 0);
      for (const l of side) {
        l.usd = value == null ? l.marketUsd : side.length === 1 ? value : total ? value * ((l.marketUsd ?? 0) / total) : value / side.length;
        // fills carry their own exact price
        if (l.priceSrc === 'fill' || l.priceSrc === 'override') l.usd = l.marketUsd;
      }
    }
  }
  for (const i of items) if (i.usd === undefined) i.usd = i.marketUsd;

  // ---- 4. average cost per asset group ----
  items.sort((a, b) => a.ts - b.ts || (a.qty > 0 ? -1 : 1));
  const groups = new Map();
  const G = (g) => {
    if (!groups.has(g)) groups.set(g, { group: g, qty: 0, cost: 0, realized: 0, uncovered: 0, buys: 0, sells: 0, fees: 0, events: [] });
    return groups.get(g);
  };
  for (const i of items) {
    if (i.cls === 'ignore') { G(i.group).events.push(view(i, null)); continue; }
    const g = G(i.group);
    const stable = cfg.stables.has(i.group);
    const q = Math.abs(i.qty);
    const avg = g.qty > 1e-12 ? g.cost / g.qty : 0;
    let realized = null;
    switch (i.cls) {
      case 'internal':
        break;
      case 'buy':
      case 'deposit':
      case 'income': {
        g.qty += q;
        g.cost += stable ? q : (i.usd ?? 0);
        if (i.cls === 'buy') g.buys++;
        break;
      }
      case 'sell':
      case 'withdraw':
      case 'fee': {
        const covered = Math.min(q, Math.max(g.qty, 0));
        const basis = covered * avg;
        if (q - covered > 1e-9) g.uncovered += q - covered;
        if (i.cls === 'sell' && !stable) {
          const proceeds = i.usd ?? 0;
          realized = proceeds * (covered / q) - basis;
          g.realized += realized;
          g.sells++;
        } else if (i.cls === 'fee' && !stable) {
          realized = -basis;
          g.realized += realized;
          g.fees += basis;
        }
        g.qty -= covered;
        g.cost -= basis;
        break;
      }
    }
    g.events.push(view(i, realized, g.qty > 1e-12 ? g.cost / g.qty : 0));
  }
  for (const g of groups.values()) {
    g.avgCost = g.qty > 1e-12 ? g.cost / g.qty : null;
    g.events.reverse(); // newest first for display
  }
  return groups;
}

function view(i, realized, avgAfter) {
  return {
    id: i.id,
    ts: i.ts,
    account: i.account_id,
    tx: i.tx,
    asset: i.asset,
    chain: i.chain,
    symbol: i.symbol,
    qty: i.qty,
    cls: i.cls,
    auto: i.auto,
    overridden: !!i.o_class || i.o_price != null,
    note: i.o_note || null,
    unitPrice: i.usd != null && i.qty ? i.usd / Math.abs(i.qty) : i.unitPrice,
    usd: i.usd,
    priceSrc: i.priceSrc,
    realized,
    avgAfter: avgAfter ?? null,
    counterparty: i.counterparty || null,
    pair: i.pair || null,
    swapWith: (i.txLegs || []).filter((l) => l.group !== i.group).map((l) => `${l.qty > 0 ? '+' : ''}${+l.qty.toPrecision(6)} ${l.symbol}`),
  };
}
