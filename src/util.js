// Small shared helpers: logging, HTTP with retries and per-host pacing.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const log = {
  info: (...a) => console.log(new Date().toISOString(), '[info]', ...a),
  warn: (...a) => console.warn(new Date().toISOString(), '[warn]', ...a),
  error: (...a) => console.error(new Date().toISOString(), '[error]', ...a),
};

// Per-host minimum spacing between requests, to stay inside free-tier rate limits.
const hostSpacingMs = {
  'api.etherscan.io': 220,
  'coins.llama.fi': 120,
  'query1.finance.yahoo.com': 200,
  'api.hyperliquid.xyz': 50,
  'api.blockscout.com': 220, // free tier: 5 req/s
  'api.kraken.com': 250,
  'api.binance.com': 120,
  'api.mainnet-beta.solana.com': 260, // public RPC: stay under ~4 req/s
  'lite-api.jup.ag': 1100, // free tier is about 1 req/s
};
const DEFAULT_SPACING = 200; // blockscout and others
const hostQueues = new Map();

async function paced(host, fn) {
  const spacing = hostSpacingMs[host] ?? DEFAULT_SPACING;
  const prev = hostQueues.get(host) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  hostQueues.set(host, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    setTimeout(release, spacing);
  }
}

// Requests sent per service, so Settings can show what each one is really used for.
// Counted in memory per UTC day; the server saves it to the database now and then.
export const usage = { day: '', counts: {} };
const utcDay = () => new Date().toISOString().slice(0, 10);
export function serviceOf(host) {
  if (/blockscout\.com$/.test(host)) return 'Blockscout';
  if (/alchemy\.com$/.test(host)) return 'Alchemy';
  if (host === 'api.hyperliquid.xyz') return 'Hyperliquid';
  if (host === 'coins.llama.fi') return 'DefiLlama';
  if (/kraken\.com$|binance\.com$/.test(host)) return 'Exchanges';
  return 'Other';
}
export function countRequest(service) {
  const d = utcDay();
  if (usage.day !== d) { usage.day = d; usage.counts = {}; }
  usage.counts[service] = (usage.counts[service] || 0) + 1;
}

export async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 20000, retries = 3, service, retry429 = true } = {}) {
  const host = new URL(url).host;
  const svc = service || serviceOf(host);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await paced(host, async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          countRequest(svc);
          const res = await fetch(url, {
            method,
            headers: {
              accept: 'application/json',
              'user-agent': 'portfolio-tracker/0.1',
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
          });
          if (res.status === 429 || res.status >= 500) {
            const err = new Error(`HTTP ${res.status} from ${host}`);
            err.retryable = res.status !== 429 || retry429;
            err.status = res.status;
            throw err;
          }
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} from ${host}: ${text.slice(0, 200)}`);
          }
          return await res.json();
        } finally {
          clearTimeout(t);
        }
      });
    } catch (e) {
      lastErr = e;
      const retryable = e.retryable || e.name === 'AbortError' || e.cause?.code === 'ECONNRESET' || e.message?.includes('fetch failed');
      if (!retryable || attempt === retries) break;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Convert an integer string amount with decimals into a float (precision is fine for display/PnL).
export function fromUnits(raw, decimals) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const d = Number(decimals) || 0;
  const s = String(raw).replace(/^-/, '');
  const neg = String(raw).startsWith('-');
  if (!/^\d+$/.test(s)) return num(raw);
  const padded = s.padStart(d + 1, '0');
  const intPart = padded.slice(0, padded.length - d) || '0';
  const frac = d ? padded.slice(padded.length - d) : '';
  const v = parseFloat(`${intPart}.${frac || '0'}`);
  return neg ? -v : v;
}

export const hourBucket = (ts) => Math.floor(ts / 3600) * 3600;
export const nowSec = () => Math.floor(Date.now() / 1000);
