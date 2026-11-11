// Manual accounts: holdings and trades typed into Settings (for anything with no API).
import { upsertAsset, replaceBalances, insertEvents, setStatus } from '../db.js';

export function syncManual(db, cfg, account) {
  const holdings = account.extra?.holdings || [];
  const rows = holdings.map((h) => {
    const asset = `manual:${account.id}:${h.symbol.toUpperCase()}`;
    upsertAsset(db, { asset, symbol: h.symbol.toUpperCase(), name: h.name || h.symbol, chain: 'manual', price_id: h.price || `manual:${h.symbol.toUpperCase()}` });
    db.prepare('UPDATE assets SET verified = 1 WHERE asset = ?').run(asset);
    if (h.price?.startsWith?.('manual:') && h.usd) {
      db.prepare("INSERT OR REPLACE INTO prices (price_id, price, change24h, confidence, updated_at, source) VALUES (?, ?, 0, 1, ?, 'manual')").run(h.price, h.usd, Math.floor(Date.now() / 1000));
    }
    return { asset, qty: Number(h.qty) };
  });
  replaceBalances(db, account.id, 'manual:', rows);
  const events = (account.extra?.trades || []).map((t, i) => ({
    id: `manual:${account.id}:${i}:${t.date}:${t.symbol}:${t.qty}`,
    account_id: account.id, ts: Math.floor(new Date(t.date).getTime() / 1000), tx: `manual:${account.id}:${i}`,
    asset: `manual:${account.id}:${t.symbol.toUpperCase()}`, qty: Number(t.qty), kind: 'trade', price_usd: Number(t.price),
  }));
  insertEvents(db, events);
  setStatus(db, `manual:${account.id}`, true, `${rows.length} holdings`);
}
