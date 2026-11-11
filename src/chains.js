// Known EVM chains, read through Blockscout's explorer API. With a (free) Blockscout API key the
// unified endpoint api.blockscout.com/<chainId> is used; without one, each chain's own instance,
// some of which sit behind a browser challenge and refuse API clients.
//   api   : Blockscout instance base URL
//   llama : DefiLlama chain slug (token prices by contract address)
//   gt    : GeckoTerminal network id (DEX price fallback for new/long-tail tokens)
//   cg    : CoinGecko platform id (public token list, used to filter spam)
//   keyless : the chain's own explorer answers API clients without a key (used when credits run out)
//   alchemy : Alchemy network slug. Chains marked preferAlchemy (Base: not on Blockscout's free plan)
//             are read through Alchemy when an Alchemy key is set.
// More chains can be added from Settings (stored as setting "chains") without code changes.

const ETH = { symbol: 'ETH', priceId: 'coingecko:ethereum' };

export const DEFAULT_CHAINS = {
  ethereum: { chainId: 1, alchemy: 'eth-mainnet', alchemyInternal: true, keyless: true, api: 'https://eth.blockscout.com', llama: 'ethereum', gt: 'eth', cg: 'ethereum', native: ETH },
  base: { chainId: 8453, alchemy: 'base-mainnet', preferAlchemy: true, api: 'https://base.blockscout.com', llama: 'base', gt: 'base', cg: 'base', native: ETH },
  arbitrum: { chainId: 42161, alchemy: 'arb-mainnet', api: 'https://arbitrum.blockscout.com', llama: 'arbitrum', gt: 'arbitrum', cg: 'arbitrum-one', native: ETH },
  optimism: { chainId: 10, alchemy: 'opt-mainnet', keyless: true, api: 'https://optimism.blockscout.com', llama: 'optimism', gt: 'optimism', cg: 'optimistic-ethereum', native: ETH },
  robinhood: { chainId: 4663, api: 'https://robinhoodchain.blockscout.com', llama: 'robinhood', gt: 'robinhood', cg: null, native: ETH },
  polygon: { chainId: 137, alchemy: 'polygon-mainnet', api: 'https://polygon.blockscout.com', llama: 'polygon', gt: 'polygon_pos', cg: 'polygon-pos', native: { symbol: 'POL', priceId: 'coingecko:polygon-ecosystem-token' } },
  unichain: { chainId: 130, api: 'https://unichain.blockscout.com', llama: 'unichain', gt: 'unichain', cg: 'unichain', native: ETH },
  gnosis: { chainId: 100, api: 'https://gnosis.blockscout.com', llama: 'xdai', gt: 'xdai', cg: 'xdai', native: { symbol: 'XDAI', priceId: 'coingecko:xdai' } },
  scroll: { chainId: 534352, api: 'https://scroll.blockscout.com', llama: 'scroll', gt: 'scroll', cg: 'scroll', native: ETH },
  zksync: { chainId: 324, api: 'https://zksync.blockscout.com', llama: 'era', gt: 'zksync', cg: 'zksync', native: ETH },
};

// Chains scanned by default for every EVM wallet. The rest are opt-in per account.
const DEFAULT_SCAN = ['ethereum', 'base', 'arbitrum', 'optimism', 'robinhood'];

export function resolveChains(overrides = {}, blockscoutKey = '', alchemyKey = '') {
  const out = {};
  for (const [name, c] of Object.entries(DEFAULT_CHAINS)) out[name] = { name, ...c };
  for (const [name, c] of Object.entries(overrides)) out[name] = { name, ...(out[name] || {}), ...c };
  for (const c of Object.values(out)) { c.blockscoutKey = blockscoutKey; c.alchemyKey = alchemyKey; }
  return out;
}

export function autoChains(chains, scan = DEFAULT_SCAN) {
  return scan.filter((n) => chains[n]);
}
