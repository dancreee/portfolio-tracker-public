// Builds the portfolio view: live balances x live prices, merged with cost basis from the ledger.
import { groupOf } from './config.js';

const isTrusted = (r) => /^(hl:|cex:|manual:|pearl:)/.test(r.asset) || r.verified || ((r.price ?? 0) > 0 && (r.confidence ?? 0) >= 0.9);

export function buildSummary(db, cfg, ledger) {
  const accounts = new Map(cfg.accounts.map((a) => [a.id, a]));
  const rows = db.prepare(`
    SELECT b.account_id, b.asset, b.qty, b.meta, b.updated_at, a.symbol, a.name, a.chain, a.verified, a.price_id,
           p.price, p.change24h, p.confidence, p.source AS price_source, p.updated_at AS price_at
    FROM balances b JOIN assets a ON a.asset = b.asset LEFT JOIN prices p ON p.price_id = a.price_id`).all()
    .filter((r) => accounts.has(r.account_id));

  const groups = new Map();
  const hidden = [];
  let total = 0;
  let change = 0;
  for (const r of rows) {
    const value = (r.price || 0) * r.qty;
    if (!isTrusted(r)) {
      hidden.push({ account: r.account_id, asset: r.asset, symbol: r.symbol, chain: r.chain, qty: r.qty, price: r.price, value });
      continue;
    }
    const g = groupOf(r.symbol, cfg);
    if (!groups.has(g)) groups.set(g, { group: g, qty: 0, value: 0, change24hUsd: 0, holdings: [], priceAt: 0 });
    const G = groups.get(g);
    G.qty += r.qty;
    G.value += value;
    const ch = r.change24h != null ? value - value / (1 + r.change24h) : 0;
    G.change24hUsd += ch;
    G.priceAt = Math.max(G.priceAt, r.price_at || 0);
    G.holdings.push({
      account: r.account_id, accountLabel: accounts.get(r.account_id)?.label, asset: r.asset, chain: r.chain, symbol: r.symbol, name: r.name,
      qty: r.qty, price: r.price, change24h: r.change24h, value, priceSource: r.price_source, meta: r.meta ? JSON.parse(r.meta) : null,
    });
    total += value;
    change += ch;
  }

  const assets = [...groups.values()].map((G) => {
    const L = ledger?.get(G.group);
    const price = G.qty ? G.value / G.qty : 0;
    const stable = cfg.stables.has(G.group);
    // Cost basis from the ledger; if history only explains part of the holding, the rest is "unknown basis".
    let avgCost = L?.avgCost ?? null;
    let source = 'ledger';
    if (avgCost == null) {
      // Hyperliquid reports its own entry notional for spot balances
      const hl = G.holdings.filter((h) => h.meta?.entryNtl);
      const hlQty = hl.reduce((s, h) => s + h.qty, 0);
      if (hlQty) { avgCost = hl.reduce((s, h) => s + h.meta.entryNtl, 0) / hlQty; source = 'hyperliquid'; }
    }
    if (stable) { avgCost = 1; source = 'stable'; }
    const coveredQty = stable ? G.qty : Math.min(G.qty, L?.qty ?? (source === 'hyperliquid' ? G.qty : 0));
    const costBasis = avgCost != null ? avgCost * coveredQty : null;
    const unrealized = avgCost != null && !stable ? price * coveredQty - costBasis : null;
    const changes = G.holdings.filter((h) => h.change24h != null);
    return {
      group: G.group,
      qty: G.qty,
      price,
      value: G.value,
      change24h: changes.length ? G.change24hUsd / (G.value - G.change24hUsd || 1) : null,
      change24hUsd: G.change24hUsd,
      share: total ? G.value / total : 0,
      avgCost,
      costSource: source,
      coverage: G.qty > 0 ? coveredQty / G.qty : 1,
      costBasis,
      unrealized,
      unrealizedPct: costBasis ? unrealized / costBasis : null,
      realized: L?.realized ?? 0,
      // PnL is simply value minus cost basis for what is held now; profit from past sells stays in `realized`.
      pnl: unrealized,
      pnlPct: costBasis ? unrealized / costBasis : null,
      trades: (L?.buys || 0) + (L?.sells || 0),
      stable,
      holdings: G.holdings.sort((a, b) => b.value - a.value),
      priceAt: G.priceAt,
    };
  }).sort((a, b) => b.value - a.value);

  const byAccount = new Map();
  for (const a of cfg.accounts) byAccount.set(a.id, { id: a.id, label: a.label, type: a.type, address: a.address, exchange: a.exchange, value: 0, assets: 0 });
  for (const A of assets) for (const h of A.holdings) {
    const acc = byAccount.get(h.account);
    if (acc) { acc.value += h.value; acc.assets++; }
  }

  const positions = db.prepare('SELECT * FROM positions ORDER BY ABS(value) DESC').all();
  const perpRealized = db.prepare('SELECT COALESCE(SUM(closed_pnl - fee), 0) AS pnl FROM perp_fills').get().pnl;
  const totalUnrealized = assets.reduce((s, a) => s + (a.unrealized || 0), 0);
  const status = db.prepare('SELECT * FROM source_status ORDER BY source').all();

  return {
    at: Math.floor(Date.now() / 1000),
    total,
    change24hUsd: change,
    change24h: total - change ? change / (total - change) : 0,
    unrealized: totalUnrealized,
    pnl: totalUnrealized,
    realized: assets.reduce((s, a) => s + a.realized, 0),
    perpRealized,
    assets,
    accounts: [...byAccount.values()].sort((a, b) => b.value - a.value),
    positions,
    hidden: hidden.sort((a, b) => b.value - a.value).slice(0, 200),
    status,
  };
}
