import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChains } from './chains.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STABLES = ['USDC', 'USDT', 'DAI', 'USDS', 'USDE', 'PYUSD', 'FDUSD', 'USDH', 'USD1', 'GHO', 'FRAX', 'LUSD', 'TUSD', 'RLUSD', 'USDG', 'USDT0', 'USD₮0'];

// Wrapped / bridged variants that should count as the same asset for totals and cost basis.
export const DEFAULT_ALIASES = {
  WETH: 'ETH', UETH: 'ETH', WBTC: 'BTC', UBTC: 'BTC', CBBTC: 'BTC', TBTC: 'BTC', WHYPE: 'HYPE', WSOL: 'SOL', USOL: 'SOL',
  'USDC.E': 'USDC', USDBC: 'USDC', USDT0: 'USDT', 'USD₮0': 'USDT', 'USDT.E': 'USDT', WPOL: 'POL', WMATIC: 'POL', MATIC: 'POL',
  XBT: 'BTC', XXBT: 'BTC', XETH: 'ETH', ZUSD: 'USD',
};

// Accounts and settings live in the local SQLite database and are edited from the Settings page.
export function loadConfig(db) {
  const accounts = db.prepare('SELECT * FROM accounts WHERE enabled = 1 ORDER BY sort, label').all().map((a) => ({
    ...a,
    address: a.address ? (a.type === 'evm' ? a.address.toLowerCase() : a.address) : null,
    chains: a.chains ? JSON.parse(a.chains) : null,
    extra: a.extra ? JSON.parse(a.extra) : {},
  }));
  const settings = Object.fromEntries(db.prepare("SELECT k, v FROM kv WHERE k LIKE 'setting:%'").all().map((r) => [r.k.slice(8), JSON.parse(r.v)]));
  const aliases = { ...DEFAULT_ALIASES };
  for (const [k, v] of Object.entries(settings.aliases || {})) aliases[k.toUpperCase()] = String(v).toUpperCase();
  return {
    accounts,
    aliases,
    chains: resolveChains(settings.chains || {}, settings.blockscoutKey || process.env.BLOCKSCOUT_API_KEY || '', settings.alchemyKey || process.env.ALCHEMY_API_KEY || ''),
    stables: new Set([...STABLES, ...(settings.stables || []).map((s) => s.toUpperCase())]),
    refresh: { pricesSeconds: 15, hyperliquidSeconds: 10, balancesSeconds: 60, historyMinutes: 5, snapshotMinutes: 5, evmBalancesSeconds: 300, evmEmptyMinutes: 60, evmHistoryMinutes: 30, evmEmptyHistoryHours: 6, alchemyBalancesMinutes: 10, alchemyHistoryMinutes: 60, ...(settings.refresh || {}) },
    ownAddresses: new Set([
      ...accounts.filter((a) => a.address).map((a) => a.address.toLowerCase()),
      ...(settings.otherOwnAddresses || []).map((a) => a.toLowerCase()),
    ]),
    settings,
  };
}

export function groupOf(symbol, cfg) {
  const s = String(symbol || '?').toUpperCase().trim();
  return cfg.aliases[s] || s;
}
