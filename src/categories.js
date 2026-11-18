// A category per asset group, for the allocation breakdown. Nothing here needs filling in by hand:
// categories saved by a history import win, then a few rules that hold for any portfolio.
export const OTHER = 'Other';

const MAJORS = new Set(['BTC', 'ETH', 'SOL', 'HYPE']);

export function categoryOf(group, holdings, cfg) {
  const saved = cfg.settings?.categories?.[group];
  if (saved) return saved;
  if (cfg.stables.has(group)) return 'Stablecoins';
  if (MAJORS.has(group)) return group;
  if (holdings.length && holdings.every((h) => String(h.priceId || '').startsWith('stock:'))) return 'Stocks';
  return OTHER;
}

// Turns a category code from another tracker's export ("TOKEN.AI", "RWA.STOCK", "MAJOR.HYPE") into a label.
const LABELS = {
  STABLECOIN: 'Stablecoins', STOCK: 'Stocks', COMMODITY: 'Commodities', AI: 'AI', DEFI: 'DeFi', PRIVACY: 'Privacy',
  LST_LRT: 'Staking', INFRA_DEPIN: 'Infrastructure', MEME: 'Memes', GAMING: 'Gaming', NFT: 'NFTs', OTHER,
};
export function categoryLabel(code) {
  const raw = String(code || '').trim();
  if (!raw) return null;
  const parts = raw.split('.');
  const last = parts.at(-1).toUpperCase();
  if (parts[0].toUpperCase() === 'MAJOR') return last;
  if (LABELS[last]) return LABELS[last];
  if (raw !== raw.toUpperCase()) return raw; // already a label
  return last.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join(' ');
}
