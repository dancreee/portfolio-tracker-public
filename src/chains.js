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
//   rpcs  : free public JSON-RPC endpoints, tried in order, for balance reads (see sources/rpc.js).
//           Editable from Settings (stored as setting "rpcs"); an empty list switches RPC reads off.
// More chains can be added from Settings (stored as setting "chains") without code changes.

const ETH = { symbol: 'ETH', priceId: 'coingecko:ethereum' };

export const DEFAULT_CHAINS = {
  ethereum: { chainId: 1, alchemy: 'eth-mainnet', alchemyInternal: true, keyless: true, api: 'https://eth.blockscout.com', llama: 'ethereum', gt: 'eth', cg: 'ethereum', native: ETH },
  base: { chainId: 8453, alchemy: 'base-mainnet', preferAlchemy: true, api: 'https://base.blockscout.com', llama: 'base', gt: 'base', cg: 'base', native: ETH },
  arbitrum: { chainId: 42161, alchemy: 'arb-mainnet', api: 'https://arbitrum.blockscout.com', llama: 'arbitrum', gt: 'arbitrum', cg: 'arbitrum-one', native: ETH },
  optimism: { chainId: 10, alchemy: 'opt-mainnet', keyless: true, api: 'https://optimism.blockscout.com', llama: 'optimism', gt: 'optimism', cg: 'optimistic-ethereum', native: ETH },
  robinhood: { chainId: 4663, alchemy: 'robinhood-mainnet', api: 'https://robinhoodchain.blockscout.com', llama: 'robinhood', gt: 'robinhood', cg: null, native: ETH },
  polygon: { chainId: 137, alchemy: 'polygon-mainnet', api: 'https://polygon.blockscout.com', llama: 'polygon', gt: 'polygon_pos', cg: 'polygon-pos', native: { symbol: 'POL', priceId: 'coingecko:polygon-ecosystem-token' } },
  unichain: { chainId: 130, api: 'https://unichain.blockscout.com', llama: 'unichain', gt: 'unichain', cg: 'unichain', native: ETH },
  gnosis: { chainId: 100, api: 'https://gnosis.blockscout.com', llama: 'xdai', gt: 'xdai', cg: 'xdai', native: { symbol: 'XDAI', priceId: 'coingecko:xdai' } },
  scroll: { chainId: 534352, api: 'https://scroll.blockscout.com', llama: 'scroll', gt: 'scroll', cg: 'scroll', native: ETH },
  zksync: { chainId: 324, api: 'https://zksync.blockscout.com', llama: 'era', gt: 'zksync', cg: 'zksync', native: ETH },
};

// Public endpoints checked on 11 Nov 2026: each answered and has Multicall3 at the usual address.
export const DEFAULT_RPCS = {
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://public.1rpc.io/eth'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
  optimism: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'],
  robinhood: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com', 'https://4663.rpc.thirdweb.com'],
  polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'],
  unichain: ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com', 'https://unichain.drpc.org'],
  gnosis: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'],
  scroll: ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com', 'https://scroll.drpc.org'],
  zksync: ['https://mainnet.era.zksync.io', 'https://zksync.drpc.org', 'https://1rpc.io/zksync2-era'],
  // Solana has no second free endpoint that serves token accounts and history; add a private one in Settings.
  solana: ['https://api.mainnet-beta.solana.com'],
};

// Chains scanned by default for every EVM wallet. The rest are opt-in per account.
const DEFAULT_SCAN = ['ethereum', 'base', 'arbitrum', 'optimism', 'robinhood'];

export const cleanRpcs = (list) => [...new Set((Array.isArray(list) ? list : []).map((u) => String(u).trim()).filter((u) => /^https?:\/\/\S+$/i.test(u)))];

/** Effective endpoint list for a chain: the saved override if there is one, otherwise the defaults. */
export const rpcsFor = (name, rpcOverrides = {}) => (Array.isArray(rpcOverrides?.[name]) ? cleanRpcs(rpcOverrides[name]) : DEFAULT_RPCS[name] || []);

export function resolveChains(overrides = {}, blockscoutKey = '', alchemyKey = '', rpcOverrides = {}) {
  const out = {};
  for (const [name, c] of Object.entries(DEFAULT_CHAINS)) out[name] = { name, ...c };
  for (const [name, c] of Object.entries(overrides)) out[name] = { name, ...(out[name] || {}), ...c };
  for (const c of Object.values(out)) { c.blockscoutKey = blockscoutKey; c.alchemyKey = alchemyKey; c.rpcs = rpcsFor(c.name, rpcOverrides); }
  return out;
}

export function autoChains(chains, scan = DEFAULT_SCAN) {
  return scan.filter((n) => chains[n]);
}
