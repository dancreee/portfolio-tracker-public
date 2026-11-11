// Centralised exchanges (Kraken, Binance) over their native REST APIs, using READ-ONLY API keys
// entered in Settings (stored only in the local DB). No dependencies: signing is node:crypto.
//
// Safety: every private call goes through an allowlist of read endpoints (KRAKEN_READ_METHODS,
// BINANCE_READ_PATHS). There is no order, withdrawal or transfer call anywhere in this file, and
// keys, secrets and signatures are never logged or put into error messages.
//
// Layout: pure, exported, unit-testable parts first (signing, symbol normalisation, payload -> balances /
// event mappers), then the HTTP plumbing, then the two exported sync functions.
import crypto from 'node:crypto';
import { num, log, sleep } from '../util.js';
import { upsertAsset, replaceBalances, insertEvents, kvGet, kvSet, setStatus } from '../db.js';

const KRAKEN = 'https://api.kraken.com';
const BINANCE = 'https://api.binance.com';

// Test seams: tests replace sleep (no real waiting) and may shift the clock.
export const internals = {
  sleep,
  now: () => Date.now(),
  resetCaches() {
    krakenPairsCache = null;
    binanceInfoCache = null;
    binanceTimeOffset = 0;
    binanceBanUntil = 0;
    binanceWeightPauseUntil = 0;
    krakenBudgets.clear();
    lastNonce.clear();
    serialQueues.clear();
    hostQueues.clear();
  },
};

// ------------------------------------------------------------------------------------------------
// Shared conventions
// ------------------------------------------------------------------------------------------------

export const USDISH = new Set(['USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'DAI', 'ZUSD', 'TUSD', 'USDE']);
export const assetKey = (account, sym) => `cex:${account.id}:${sym}`;
export const priceIdFor = (exchange, sym) => (USDISH.has(sym) ? 'cex:usd' : `cex:${exchange}:${sym}`);
const symbolOfAssetKey = (account, key) => key.slice(`cex:${account.id}:`.length);
const DUST = 1e-12;

// On-chain transaction ids: lower-case EVM hashes so they compare equal to wallet-side hashes;
// exchange-internal pseudo ids ("Internal transfer 123", "Off-chain transfer ...") are not txids.
export function normTxid(txid) {
  const s = String(txid ?? '').trim();
  if (!s || /^(internal|off-?chain)\b/i.test(s) || /\s/.test(s)) return null;
  return /^0x[0-9a-f]+$/i.test(s) ? s.toLowerCase() : s;
}
export function normAddress(addr) {
  const s = String(addr ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  return /^0x[0-9a-f]{40}$/i.test(s) ? s.toLowerCase() : s;
}

// Split [fromMs, toMs] into consecutive windows no longer than spanMs (oldest first).
export function timeWindows(fromMs, toMs, spanMs) {
  const out = [];
  for (let s = fromMs; s < toMs; s += spanMs) out.push([s, Math.min(s + spanMs - 1, toMs)]);
  return out;
}

// Never let credentials leak into a status message or log line, whatever the upstream error says.
export function redact(message, account) {
  let s = String(message ?? '');
  for (const secret of [account?.api_key, account?.secret, account?.password]) {
    if (secret && String(secret).length >= 6) s = s.split(String(secret)).join('[redacted]');
  }
  return s.replace(/signature=[0-9a-f]+/gi, 'signature=[redacted]').replace(/(API-Sign|X-MBX-APIKEY|API-Key)["':=\s]+[^\s"',}]+/gi, '$1=[redacted]');
}

// ------------------------------------------------------------------------------------------------
// Kraken: signing
// ------------------------------------------------------------------------------------------------

// API-Sign = base64( HMAC-SHA512( base64decode(secret), path + SHA256(nonce + postdata) ) )
export function krakenSign(path, nonce, postdata, secret) {
  const hash = crypto.createHash('sha256').update(String(nonce) + postdata).digest();
  return crypto.createHmac('sha512', Buffer.from(String(secret), 'base64'))
    .update(Buffer.concat([Buffer.from(path, 'utf8'), hash]))
    .digest('base64');
}

// ------------------------------------------------------------------------------------------------
// Kraken: asset and pair normalisation
// ------------------------------------------------------------------------------------------------

// Legacy ISO-4217-style codes: X prefix for crypto, Z prefix for fiat. Only this fixed, historical
// set carries a prefix; newer assets (ZETA, XION, ZRX, XTZ, XRP...) must not be stripped.
const KRAKEN_LEGACY = {
  XXBT: 'XBT', XETH: 'ETH', XLTC: 'LTC', XXRP: 'XRP', XXLM: 'XLM', XXMR: 'XMR', XZEC: 'ZEC', XETC: 'ETC',
  XREP: 'REP', XMLN: 'MLN', XXDG: 'XDG', XICN: 'ICN', XDAO: 'DAO', XNMC: 'NMC', XXVN: 'XVN',
  ZUSD: 'USD', ZEUR: 'EUR', ZGBP: 'GBP', ZCAD: 'CAD', ZJPY: 'JPY', ZAUD: 'AUD', ZCHF: 'CHF', ZKRW: 'KRW',
};
const KRAKEN_ALIAS = { XBT: 'BTC', XDG: 'DOGE', ETH2: 'ETH' };
const KRAKEN_VARIANT = { S: 'staked', M: 'earn', B: 'earn', F: 'earn', P: 'earn', T: 'tokenized', HOLD: 'hold' };

// 'XXBT' -> { symbol: 'BTC', variant: 'spot' }, 'DOT28.S' -> { symbol: 'DOT', variant: 'staked' }
export function krakenAssetInfo(code) {
  let s = String(code ?? '').trim().toUpperCase();
  let variant = 'spot';
  const m = s.match(/^(.+)\.(HOLD|[A-Z])$/);
  if (m) {
    s = m[1];
    variant = KRAKEN_VARIANT[m[2]] || 'earn';
    // Legacy bonded-staking codes carry the lock period: DOT28.S, KSM07.S, ATOM21.S, FLOW14.S
    if (variant === 'staked') s = s.replace(/^([A-Z]{2,})\d{2}$/, '$1');
  }
  s = KRAKEN_LEGACY[s] || s;
  if (s === 'ETH2') variant = variant === 'spot' ? 'staked' : variant;
  s = KRAKEN_ALIAS[s] || s;
  return { symbol: s, variant };
}
export const krakenAsset = (code) => krakenAssetInfo(code).symbol;

// Build lookup tables from the public /0/public/AssetPairs result.
//   byName: every spelling of a pair (key 'XXBTZUSD', altname 'XBTUSD', wsname 'XBT/USD') -> { base, quote, key }
//   bySymbols: 'BTC/USD' -> pair key (for Ticker lookups)
export function buildKrakenPairMap(assetPairs) {
  const byName = new Map();
  const bySymbols = new Map();
  for (const [key, p] of Object.entries(assetPairs || {})) {
    if (!p || !p.base || !p.quote) continue;
    const entry = { base: krakenAsset(p.base), quote: krakenAsset(p.quote), key };
    for (const name of [key, p.altname, p.wsname, p.wsname?.replace('/', '')]) {
      if (name && !byName.has(name)) byName.set(name, entry);
    }
    if (key.endsWith('.d')) continue; // dark-pool pairs have no public ticker
    const k = `${entry.base}/${entry.quote}`;
    if (!bySymbols.has(k)) bySymbols.set(k, key);
  }
  return { byName, bySymbols };
}

// Longest/most specific first, so XXBTZUSD ends with ZUSD (not USD) and USDCUSDT ends with USDT.
const KRAKEN_QUOTE_GUESS = ['ZUSD', 'ZEUR', 'ZGBP', 'ZCAD', 'ZJPY', 'ZAUD', 'ZCHF', 'XXBT', 'XETH', 'USDT', 'USDC', 'USD', 'EUR', 'GBP',
  'CAD', 'JPY', 'AUD', 'CHF', 'DAI', 'XBT', 'BTC', 'ETH'];

// 'XXBTZUSD' | 'SOLUSD' | 'XBT/USD' -> { base: 'BTC', quote: 'USD' }; null if it cannot be split.
export function splitKrakenPair(pair, pairMap) {
  const name = String(pair ?? '').trim();
  const hit = pairMap?.byName?.get(name) || pairMap?.byName?.get(name.toUpperCase());
  if (hit) return { base: hit.base, quote: hit.quote };
  const up = name.toUpperCase();
  if (up.includes('/')) {
    const [b, q] = up.split('/');
    if (b && q) return { base: krakenAsset(b), quote: krakenAsset(q) };
  }
  for (const q of KRAKEN_QUOTE_GUESS) {
    if (up.length > q.length && up.endsWith(q)) return { base: krakenAsset(up.slice(0, -q.length)), quote: krakenAsset(q) };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Kraken: payload mappers
// ------------------------------------------------------------------------------------------------

// Balance ({ XXBT: "0.5" }) or BalanceEx ({ XXBT: { balance, hold_trade } }) -> [{ symbol, qty, parts }]
// Staked / earn / held variants (XBT.M, ETH2.S, USD.HOLD, DOT.B ...) are summed into the base symbol.
// `balance` in BalanceEx already includes funds held by open orders, so hold_trade is not added.
export function krakenBalances(result) {
  const by = new Map();
  for (const [code, v] of Object.entries(result || {})) {
    const qty = num(v && typeof v === 'object' ? v.balance : v);
    if (!(Math.abs(qty) > DUST)) continue;
    const { symbol, variant } = krakenAssetInfo(code);
    if (symbol === 'KFEE') continue; // fee credits, not an asset
    const b = by.get(symbol) || { symbol, qty: 0, parts: {} };
    b.qty += qty;
    b.parts[variant] = (b.parts[variant] || 0) + qty;
    by.set(symbol, b);
  }
  return [...by.values()].filter((b) => b.qty > DUST);
}

// TradesHistory `trades` object -> events. Each fill becomes a base leg, a quote leg and a fee leg
// sharing one tx. Kraken charges the fee in the quote currency. Margin fills are skipped: they open
// or close a leveraged position and do not move the spot balance of the base asset.
export function krakenTradesToEvents(account, tradesObj, pairMap) {
  const events = [];
  for (const [id, t] of Object.entries(tradesObj || {})) {
    if (!t || num(t.margin) > 0) continue;
    const split = splitKrakenPair(t.pair, pairMap);
    if (!split) continue;
    const { base, quote } = split;
    const ts = Math.floor(num(t.time));
    const sign = t.type === 'buy' ? 1 : -1;
    const vol = num(t.vol);
    const price = num(t.price);
    const cost = num(t.cost) || vol * price;
    if (!vol || !ts) continue;
    const quoteUsd = USDISH.has(quote) ? 1 : null;
    const tx = `${account.id}:${t.ordertxid || id}:${id}`;
    const common = { account_id: account.id, ts, tx };
    events.push({ ...common, id: `${account.id}:t:${id}:b`, asset: assetKey(account, base), qty: sign * vol, kind: 'trade',
      price_usd: quoteUsd ? price : null, meta: { venue: account.exchange, symbol: `${base}/${quote}`, price, side: t.type, order: t.ordertxid || null } });
    events.push({ ...common, id: `${account.id}:t:${id}:q`, asset: assetKey(account, quote), qty: -sign * cost, kind: 'trade', price_usd: quoteUsd });
    const fee = num(t.fee);
    if (fee > 0) events.push({ ...common, id: `${account.id}:t:${id}:f`, asset: assetKey(account, quote), qty: -fee, kind: 'fee', price_usd: quoteUsd });
  }
  return events;
}

// DepositStatus / WithdrawStatus rows -> { [refid]: { txid, address } }. The result is either a plain
// array or (with cursor pagination) an object holding the array.
export function krakenStatusRows(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    for (const k of ['deposits', 'deposit', 'withdrawals', 'withdrawal']) if (Array.isArray(result[k])) return result[k];
  }
  return [];
}
export function krakenStatusIndex(rows, index = {}) {
  for (const r of rows || []) {
    if (!r?.refid) continue;
    index[r.refid] = { txid: normTxid(r.txid), address: normAddress(r.info) };
  }
  return index;
}

const KRAKEN_INCOME_SUBTYPES = new Set(['reward', 'bonus', '']);

// Ledgers `ledger` object -> events.
//   deposit / withdrawal -> 'transfer' (signed amount) plus a 'fee' leg; tx is the on-chain txid when
//     DepositStatus / WithdrawStatus knows it (matched by refid), so it lines up with wallet transfers.
//   staking, and earn rewards -> 'transfer' in with meta.income, so rewards enter the cost basis.
//   Earn allocations / deallocations only move funds between BTC and BTC.B and net to zero: skipped.
export function krakenLedgerToEvents(account, ledgerObj, statusIndex = {}) {
  const events = [];
  for (const [id, l] of Object.entries(ledgerObj || {})) {
    if (!l) continue;
    const type = String(l.type || '');
    const subtype = String(l.subtype || '');
    const amount = num(l.amount);
    const fee = num(l.fee);
    const ts = Math.floor(num(l.time));
    if (!ts || (!amount && !fee)) continue;
    const symbol = krakenAsset(l.asset);
    const asset = assetKey(account, symbol);
    const refid = l.refid || id;
    let ev = null;
    if (type === 'deposit' || type === 'withdrawal') {
      const st = statusIndex[refid] || {};
      ev = { tx: st.txid || `${account.id}:${refid}`, counterparty: type === 'withdrawal' ? st.address || null : null,
        meta: { venue: account.exchange, type, refid, ...(st.txid ? { txid: st.txid } : {}), ...(st.address ? { address: st.address } : {}) } };
    } else if (type === 'staking' || type === 'dividend' || type === 'reward' || (type === 'earn' && KRAKEN_INCOME_SUBTYPES.has(subtype))) {
      if (amount <= 0) continue;
      ev = { tx: `${account.id}:${refid}`, counterparty: null, meta: { venue: account.exchange, type, income: type === 'earn' ? 'earn' : type, refid } };
    } else continue;
    const common = { account_id: account.id, ts, tx: ev.tx };
    if (amount) events.push({ ...common, id: `${account.id}:l:${id}`, asset, qty: amount, kind: 'transfer', counterparty: ev.counterparty, meta: ev.meta });
    if (fee > 0) events.push({ ...common, id: `${account.id}:l:${id}:f`, asset, qty: -fee, kind: 'fee' });
  }
  return events;
}

// Which ticker to ask for each symbol: <SYM>/USD, else USD/<SYM> inverted (USDJPY, USDCHF, USDCAD), else
// a USD-stablecoin quote.
export function krakenPricePlan(symbols, pairMap) {
  const plan = [];
  for (const symbol of symbols) {
    if (USDISH.has(symbol)) continue;
    const direct = ['USD', 'USDT', 'USDC'].map((q) => pairMap.bySymbols.get(`${symbol}/${q}`)).find(Boolean);
    if (direct) { plan.push({ symbol, pair: direct, invert: false }); continue; }
    const inv = pairMap.bySymbols.get(`USD/${symbol}`);
    if (inv) plan.push({ symbol, pair: inv, invert: true });
  }
  return plan;
}

// Ticker result -> Map(symbol -> { price, change24h }). c[0] = last trade, o = today's opening price.
export function krakenTickerToPrices(plan, ticker) {
  const out = new Map();
  for (const { symbol, pair, invert } of plan) {
    const t = ticker?.[pair];
    let last = num(t?.c?.[0]);
    let open = num(Array.isArray(t?.o) ? t.o[0] : t?.o);
    if (!(last > 0)) continue;
    if (invert) { last = 1 / last; open = open > 0 ? 1 / open : 0; }
    out.set(symbol, { price: last, change24h: open > 0 ? last / open - 1 : null });
  }
  return out;
}

const KRAKEN_PERMISSION = {
  Balance: 'Query Funds',
  BalanceEx: 'Query Funds',
  TradesHistory: 'Query closed orders & trades',
  Ledgers: 'Query ledger entries',
  DepositStatus: 'Query Funds',
  WithdrawStatus: 'Query ledger entries',
};

// Kraken `error` array -> one actionable sentence.
export function krakenErrorMessage(errors, method = '') {
  const list = (Array.isArray(errors) ? errors : [errors]).map(String);
  const has = (re) => list.some((e) => re.test(e));
  if (has(/Permission denied/i)) {
    const perm = KRAKEN_PERMISSION[method];
    return `Kraken: permission denied for ${method || 'this request'}. Edit the API key on Kraken and enable "${perm || 'the matching Query permission'}"` +
      ' (this tracker needs: Query Funds, Query closed orders & trades, Query ledger entries; nothing else).';
  }
  if (has(/Invalid key/i)) return 'Kraken: invalid API key. Check that the key was pasted completely and has not been deleted or expired.';
  if (has(/Invalid signature/i)) return 'Kraken: invalid signature. The private key (secret) does not match the API key; paste it again.';
  if (has(/Invalid nonce/i)) return 'Kraken: invalid nonce. Use an API key dedicated to this tracker, or raise its "Nonce window" in the key settings.';
  if (has(/Rate limit|Throttled/i)) return 'Kraken: API rate limit exceeded. The sync will resume on the next run.';
  if (has(/Temporary lockout/i)) return 'Kraken: temporary lockout after too many failed requests. Wait about 15 minutes, then check the key and secret.';
  if (has(/Unavailable|Busy|Internal error/i)) return 'Kraken: service temporarily unavailable. Will retry on the next sync.';
  return `Kraken: ${list.join(', ') || 'unknown error'}`;
}

// ------------------------------------------------------------------------------------------------
// Binance: signing
// ------------------------------------------------------------------------------------------------

// signature = hex( HMAC-SHA256( secret, querystring ) )
export function binanceSign(query, secret) {
  return crypto.createHmac('sha256', String(secret)).update(query).digest('hex');
}

// ------------------------------------------------------------------------------------------------
// Binance: payload mappers
// ------------------------------------------------------------------------------------------------

// Flexible Simple Earn positions show up in the spot wallet as LD-prefixed receipt tokens (LDBTC = BTC).
// LDO (Lido) is a real asset: only strip when something sensible remains, and when the list of
// exchange assets is known, only when the remainder is a listed asset and the full name is not.
export function binanceAsset(code, knownAssets = null) {
  const s = String(code ?? '').trim().toUpperCase();
  if (!s.startsWith('LD') || s.length < 4) return { symbol: s, earn: false };
  const rest = s.slice(2);
  if (knownAssets && knownAssets.size && (knownAssets.has(s) || !knownAssets.has(rest))) return { symbol: s, earn: false };
  return { symbol: rest, earn: true };
}

// Combine the wallets into [{ symbol, qty, parts }].
//   spot:     POST /sapi/v3/asset/getUserAsset rows  { asset, free, locked, freeze, withdrawing, ipoable }
//   account:  GET /api/v3/account (fallback)         { balances: [{ asset, free, locked }] }
//   funding:  POST /sapi/v1/asset/get-funding-asset  [{ asset, free, locked, freeze, withdrawing }]
//   flexible: Simple Earn flexible position rows     [{ asset, totalAmount }]
//   locked:   Simple Earn locked position rows       [{ asset, amount }]
// Flexible earn is reported twice (LD tokens in spot and the earn position): the larger figure is used,
// never the sum.
export function binanceBalances({ spot, account, funding, flexible, locked } = {}, knownAssets = null) {
  const by = new Map();
  const add = (symbol, part, qty) => {
    if (!(Math.abs(qty) > DUST)) return;
    const b = by.get(symbol) || { symbol, parts: {} };
    b.parts[part] = (b.parts[part] || 0) + qty;
    by.set(symbol, b);
  };
  const walletQty = (r) => num(r.free) + num(r.locked) + num(r.freeze) + num(r.withdrawing) + num(r.ipoable);
  const spotRows = Array.isArray(spot) ? spot : account?.balances || [];
  for (const r of spotRows) {
    const { symbol, earn } = binanceAsset(r.asset, knownAssets);
    add(symbol, earn ? 'ld' : 'spot', walletQty(r));
  }
  for (const r of funding || []) add(binanceAsset(r.asset, knownAssets).symbol, 'funding', walletQty(r));
  for (const r of flexible || []) add(String(r.asset).toUpperCase(), 'flexible', num(r.totalAmount ?? r.amount));
  for (const r of locked || []) add(String(r.asset).toUpperCase(), 'lockedEarn', num(r.amount ?? r.totalAmount));
  const out = [];
  for (const b of by.values()) {
    const p = b.parts;
    const earn = Math.max(p.ld || 0, p.flexible || 0) + (p.lockedEarn || 0);
    const parts = {};
    if (p.spot) parts.spot = p.spot;
    if (p.funding) parts.funding = p.funding;
    if (earn) parts.earn = earn;
    const qty = (p.spot || 0) + (p.funding || 0) + earn;
    if (qty > DUST) out.push({ symbol: b.symbol, qty, parts });
  }
  return out;
}

// /api/v3/exchangeInfo -> Map(symbol -> { base, quote, trading })
export function buildBinanceSymbolMap(exchangeInfo) {
  const map = new Map();
  for (const s of exchangeInfo?.symbols || []) {
    if (s?.symbol && s.baseAsset && s.quoteAsset) map.set(s.symbol, { base: s.baseAsset, quote: s.quoteAsset, trading: s.status === 'TRADING' });
  }
  return map;
}

export const BINANCE_DEFAULT_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH'];

// myTrades needs a symbol. Candidates: every listed market whose base is an asset this account holds or
// has held, quoted in one of the default quotes or in another asset the account has held (BTCEUR if
// EUR was ever seen).
export function binanceCandidateSymbols(heldSymbols, symbolMap) {
  const held = new Set(heldSymbols);
  const quotes = new Set([...BINANCE_DEFAULT_QUOTES, ...held]);
  const out = [];
  for (const [symbol, m] of symbolMap) {
    if (held.has(m.base) && quotes.has(m.quote) && m.base !== m.quote) out.push(symbol);
  }
  return out.sort();
}

// GET /api/v3/myTrades rows for one symbol -> events. Trade ids are only unique per symbol.
export function binanceTradesToEvents(account, trades, market) {
  const events = [];
  for (const t of trades || []) {
    const base = market?.base;
    const quote = market?.quote;
    if (!t || !base || !quote) continue;
    const ts = Math.floor(num(t.time) / 1000);
    const qty = num(t.qty);
    const price = num(t.price);
    const quoteQty = num(t.quoteQty) || qty * price;
    if (!ts || !qty) continue;
    const sign = t.isBuyer ? 1 : -1;
    const quoteUsd = USDISH.has(quote) ? 1 : null;
    const sym = t.symbol || `${base}${quote}`;
    const tx = `${account.id}:${sym}:${t.orderId ?? t.id}:${t.id}`;
    const common = { account_id: account.id, ts, tx };
    events.push({ ...common, id: `${account.id}:t:${sym}:${t.id}:b`, asset: assetKey(account, base), qty: sign * qty, kind: 'trade',
      price_usd: quoteUsd ? price : null, meta: { venue: account.exchange, symbol: `${base}/${quote}`, price, side: t.isBuyer ? 'buy' : 'sell', order: t.orderId ?? null } });
    events.push({ ...common, id: `${account.id}:t:${sym}:${t.id}:q`, asset: assetKey(account, quote), qty: -sign * quoteQty, kind: 'trade', price_usd: quoteUsd });
    const fee = num(t.commission);
    if (fee > 0 && t.commissionAsset) {
      const feeSym = String(t.commissionAsset).toUpperCase();
      events.push({ ...common, id: `${account.id}:t:${sym}:${t.id}:f`, asset: assetKey(account, feeSym), qty: -fee, kind: 'fee',
        price_usd: USDISH.has(feeSym) ? 1 : feeSym === base && quoteUsd ? price : null });
    }
  }
  return events;
}

// GET /sapi/v1/capital/deposit/hisrec rows -> events. status 1 = success, 6 = credited (withdrawal locked).
// The sender is not reported (address is the account's own deposit address), so counterparty stays null.
export function binanceDepositsToEvents(account, rows) {
  const events = [];
  for (const d of rows || []) {
    if (!d || ![1, 6].includes(Number(d.status))) continue;
    const qty = num(d.amount);
    const ts = Math.floor(num(d.insertTime ?? d.completeTime) / 1000);
    const symbol = String(d.coin || '').toUpperCase();
    if (!qty || !ts || !symbol) continue;
    const id = d.id ?? d.txId;
    const txid = normTxid(d.txId);
    events.push({ id: `${account.id}:dep:${id}`, account_id: account.id, ts, tx: txid || `${account.id}:dep:${id}`, asset: assetKey(account, symbol), qty,
      kind: 'transfer', counterparty: null,
      meta: { venue: account.exchange, type: 'deposit', network: d.network || null, ...(txid ? { txid } : {}), ...(d.address ? { address: normAddress(d.address) } : {}) } });
  }
  return events;
}

const binanceTime = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(`${String(v).trim().replace(' ', 'T')}Z`); // "2021-04-29 16:08:00" is UTC
  return Number.isFinite(t) ? t : 0;
};

// GET /sapi/v1/capital/withdraw/history rows -> events. status 6 = completed. `amount` is what arrives at
// the destination; transactionFee is charged on top.
export function binanceWithdrawalsToEvents(account, rows) {
  const events = [];
  for (const w of rows || []) {
    if (!w || Number(w.status) !== 6) continue;
    const qty = num(w.amount);
    const ts = Math.floor((binanceTime(w.completeTime) || binanceTime(w.applyTime)) / 1000);
    const symbol = String(w.coin || '').toUpperCase();
    if (!qty || !ts || !symbol) continue;
    const txid = normTxid(w.txId);
    const address = normAddress(w.address);
    const common = { account_id: account.id, ts, tx: txid || `${account.id}:wd:${w.id}`, asset: assetKey(account, symbol) };
    events.push({ ...common, id: `${account.id}:wd:${w.id}`, qty: -qty, kind: 'transfer', counterparty: address,
      meta: { venue: account.exchange, type: 'withdrawal', network: w.network || null, ...(txid ? { txid } : {}), ...(address ? { address } : {}) } });
    const fee = num(w.transactionFee);
    if (fee > 0) events.push({ ...common, id: `${account.id}:wd:${w.id}:f`, qty: -fee, kind: 'fee' });
  }
  return events;
}

// GET /sapi/v1/convert/tradeFlow `list` -> events (two 'trade' legs per successful conversion).
export function binanceConvertToEvents(account, list) {
  const events = [];
  for (const c of list || []) {
    if (!c || (c.orderStatus && c.orderStatus !== 'SUCCESS')) continue;
    const from = String(c.fromAsset || '').toUpperCase();
    const to = String(c.toAsset || '').toUpperCase();
    const fromAmt = num(c.fromAmount);
    const toAmt = num(c.toAmount);
    const ts = Math.floor(num(c.createTime) / 1000);
    const oid = c.orderId ?? c.quoteId;
    if (!from || !to || !fromAmt || !toAmt || !ts || oid == null) continue;
    const fromUsd = USDISH.has(from);
    const toUsd = USDISH.has(to);
    const common = { account_id: account.id, ts, tx: `${account.id}:convert:${oid}`, kind: 'trade' };
    events.push({ ...common, id: `${account.id}:c:${oid}:f`, asset: assetKey(account, from), qty: -fromAmt,
      price_usd: fromUsd ? 1 : toUsd ? toAmt / fromAmt : null, meta: { venue: account.exchange, symbol: `${from}/${to}`, convert: true } });
    events.push({ ...common, id: `${account.id}:c:${oid}:t`, asset: assetKey(account, to), qty: toAmt,
      price_usd: toUsd ? 1 : fromUsd ? fromAmt / toAmt : null });
  }
  return events;
}

// Which <SYM><QUOTE> ticker prices each symbol (USDT first, then other USD stablecoins).
export function binancePricePlan(symbols, symbolMap) {
  const plan = [];
  for (const symbol of symbols) {
    if (USDISH.has(symbol)) continue;
    const cands = ['USDT', 'USDC', 'FDUSD'].map((q) => `${symbol}${q}`).filter((s) => symbolMap.has(s));
    const pair = cands.find((s) => symbolMap.get(s).trading) || cands[0];
    if (pair) plan.push({ symbol, pair });
  }
  return plan;
}

// /api/v3/ticker/24hr rows -> Map(symbol -> { price, change24h })
export function binanceTickerToPrices(plan, tickers) {
  const by = new Map((Array.isArray(tickers) ? tickers : tickers ? [tickers] : []).map((t) => [t.symbol, t]));
  const out = new Map();
  for (const { symbol, pair } of plan) {
    const t = by.get(pair);
    const price = num(t?.lastPrice);
    if (!(price > 0)) continue;
    out.set(symbol, { price, change24h: t.priceChangePercent != null && t.priceChangePercent !== '' ? num(t.priceChangePercent) / 100 : null });
  }
  return out;
}

// HTTP status + Binance { code, msg } body -> one actionable sentence.
export function binanceErrorMessage(status, body, path = '') {
  const code = Number(body?.code);
  const msg = String(body?.msg || '');
  const perms = 'On Binance, edit the API key and tick "Enable Reading" (leave trading and withdrawals off); if the key is IP-restricted, add this machine\'s public IP.';
  if (status === 418) return 'Binance: this IP is temporarily banned for exceeding rate limits. Syncing pauses until the ban lifts.';
  if (status === 429) return 'Binance: rate limit reached. The sync will resume on the next run.';
  if (status === 451 || /restricted location|unavailable.*(region|country)/i.test(msg)) return 'Binance: the API is not available from this location (HTTP 451). Binance.com blocks some regions.';
  if (code === -2014 || /API-key format invalid/i.test(msg)) return 'Binance: invalid API key format. Check that the key was pasted completely.';
  if (code === -2015) return `Binance: invalid API key, IP not allowed, or missing permission for ${path || 'this request'}. ${perms}`;
  if (code === -2008) return 'Binance: invalid API key. Check that the key exists and was pasted completely.';
  if (code === -1022) return 'Binance: invalid signature. The secret key does not match the API key; paste it again.';
  if (code === -1021) return 'Binance: request timestamp outside the allowed window. Check this computer\'s clock.';
  if (code === -1002 || status === 401) return `Binance: not authorised for ${path || 'this request'}. ${perms}`;
  if (code === -1003) return 'Binance: too many requests. The sync will resume on the next run.';
  return `Binance: ${msg || `HTTP ${status}`}${Number.isFinite(code) && code ? ` (code ${code})` : ''}`;
}

// ------------------------------------------------------------------------------------------------
// HTTP plumbing (global fetch, per-host pacing, timeouts)
// ------------------------------------------------------------------------------------------------

const SPACING_MS = { 'api.kraken.com': 250, 'api.binance.com': 120 };
const hostQueues = new Map();

class ApiError extends Error {
  constructor(message, { auth = false, retryable = false, code = null } = {}) {
    super(message);
    this.auth = auth; // bad key / secret / permission: no point trying further calls
    this.retryable = retryable;
    this.code = code;
  }
}

// One request at a time per host, with a minimum gap. Returns { status, headers, data, text }; throws only
// on network failure or timeout.
async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const host = new URL(url).host;
  const prev = hostQueues.get(host) || Promise.resolve();
  let release;
  hostQueues.set(host, new Promise((r) => (release = r)));
  await prev;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, body, signal: ctrl.signal,
        headers: { accept: 'application/json', 'user-agent': 'portfolio-tracker/0.1', ...headers } });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* HTML error page */ }
      return { status: res.status, headers: res.headers, data, text };
    } catch (e) {
      throw new ApiError(e.name === 'AbortError' ? `Timeout talking to ${host}` : `Network error talking to ${host}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    Promise.resolve(internals.sleep(SPACING_MS[host] ?? 200)).then(release, release);
  }
}

const serialQueues = new Map();
// Run fn after every earlier fn for the same key has finished (Kraken nonces must arrive in order).
function serial(key, fn) {
  const prev = serialQueues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  serialQueues.set(key, run.catch(() => {}));
  return run;
}

function requireCredentials(account) {
  if (!account?.api_key || !String(account.api_key).trim()) throw new ApiError('No API key set. Add a read-only API key for this account in Settings.', { auth: true });
  if (!account.secret || !String(account.secret).trim()) throw new ApiError('No API secret set. Add the secret (private key) of the read-only API key in Settings.', { auth: true });
}

// ------------------------------------------------------------------------------------------------
// Kraken client
// ------------------------------------------------------------------------------------------------

export const KRAKEN_READ_METHODS = new Set(['Balance', 'BalanceEx', 'TradesHistory', 'Ledgers', 'DepositStatus', 'WithdrawStatus']);
const KRAKEN_COST = { TradesHistory: 2, Ledgers: 2 };
// Kraken's private API counter: starter tier allows 15, decaying 0.33/s. Mirror it so we wait instead of
// tripping "EAPI:Rate limit exceeded".
const KRAKEN_BUDGET_MAX = 14;
const KRAKEN_BUDGET_DECAY = 0.33;
const krakenBudgets = new Map();
const lastNonce = new Map();

async function krakenBudget(key, cost) {
  const now = internals.now();
  const b = krakenBudgets.get(key) || { level: 0, t: now };
  b.level = Math.max(0, b.level - ((now - b.t) / 1000) * KRAKEN_BUDGET_DECAY);
  b.t = now;
  if (b.level + cost > KRAKEN_BUDGET_MAX) {
    const waitMs = Math.ceil(((b.level + cost - KRAKEN_BUDGET_MAX) / KRAKEN_BUDGET_DECAY) * 1000);
    await internals.sleep(waitMs);
    b.level = Math.max(0, KRAKEN_BUDGET_MAX - cost);
    b.t = internals.now();
  }
  b.level += cost;
  krakenBudgets.set(key, b);
}

function nextNonce(key) {
  const n = Math.max(internals.now(), (lastNonce.get(key) || 0) + 1);
  lastNonce.set(key, n);
  return String(n);
}

function krakenResult(res, method) {
  const errors = res.data?.error;
  if (Array.isArray(errors) && errors.length) {
    const joined = errors.join(',');
    throw new ApiError(krakenErrorMessage(errors, method), {
      auth: /Permission denied|Invalid key|Invalid signature|Invalid nonce|Temporary lockout/i.test(joined),
      retryable: /Rate limit|Throttled|Unavailable|Busy|Internal error/i.test(joined),
      code: joined,
    });
  }
  if (!res.data || res.status >= 400) throw new ApiError(`Kraken: HTTP ${res.status} for ${method}`, { retryable: res.status >= 500 || res.status === 429 });
  return res.data.result;
}

async function withRetries(fn, { retries = 2, baseMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (!e.retryable || attempt >= retries) throw e;
      await internals.sleep(baseMs * 2 ** attempt);
    }
  }
}

async function krakenPublic(method, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return withRetries(async () => krakenResult(await http(`${KRAKEN}/0/public/${method}${qs ? `?${qs}` : ''}`), method));
}

async function krakenPrivate(account, method, params = {}) {
  if (!KRAKEN_READ_METHODS.has(method)) throw new Error(`Refusing to call non-read Kraken method ${method}`);
  const path = `/0/private/${method}`;
  const key = String(account.api_key).trim();
  const secret = String(account.secret).trim();
  return serial(`kraken:${key}`, () => withRetries(async () => {
    await krakenBudget(key, KRAKEN_COST[method] ?? 1);
    const nonce = nextNonce(key);
    const postdata = new URLSearchParams({ nonce, ...params }).toString();
    const res = await http(KRAKEN + path, { method: 'POST', body: postdata,
      headers: { 'API-Key': key, 'API-Sign': krakenSign(path, nonce, postdata, secret), 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } });
    return krakenResult(res, method);
  }, { retries: 3, baseMs: 5000 }));
}

const CACHE_MS = 6 * 3600_000;
let krakenPairsCache = null;
async function krakenPairs() {
  if (krakenPairsCache && internals.now() - krakenPairsCache.at < CACHE_MS) return krakenPairsCache.promise;
  const entry = { at: internals.now(), promise: krakenPublic('AssetPairs').then(buildKrakenPairMap) };
  krakenPairsCache = entry;
  entry.promise.catch(() => { if (krakenPairsCache === entry) krakenPairsCache = null; });
  return entry.promise;
}

async function krakenFetchBalances(account) {
  let result;
  try {
    result = await krakenPrivate(account, 'BalanceEx');
  } catch (e) {
    if (e.auth) throw e; // bad key or missing "Query Funds": Balance would fail the same way
    result = await krakenPrivate(account, 'Balance');
  }
  return krakenBalances(result);
}

async function krakenFetchPrices(symbols) {
  const out = new Map();
  const pairMap = await krakenPairs();
  const plan = krakenPricePlan(symbols, pairMap);
  for (let i = 0; i < plan.length; i += 40) {
    const chunk = plan.slice(i, i + 40);
    const ticker = await krakenPublic('Ticker', { pair: chunk.map((p) => p.pair).join(',') });
    for (const [s, p] of krakenTickerToPrices(chunk, ticker)) out.set(s, p);
  }
  return out;
}

const KRAKEN_MAX_PAGES = 400; // 20,000 rows per run; a longer backfill continues on the next sync

// Page through a Kraken history method (newest first, 50 rows per page) with a resumable cursor:
//   cur = { newest, oldest, done }  (unix seconds)
// First everything newer than `newest`, then, until `done`, the backfill older than `oldest`.
async function krakenWalk(account, method, params, listKey, cur, onPage) {
  const page = async (extra, track) => {
    let ofs = 0;
    for (let n = 0; n < KRAKEN_MAX_PAGES; n++) {
      const res = await krakenPrivate(account, method, { ...params, ...extra, ofs });
      const obj = res?.[listKey] || {};
      const rows = Object.entries(obj);
      if (!rows.length) return true;
      await onPage(obj);
      track(rows.map(([, r]) => Math.floor(num(r.time))).filter(Boolean));
      ofs += rows.length;
      if (ofs >= num(res.count)) return true;
    }
    return false;
  };
  if (cur.newest != null) {
    let top = cur.newest;
    const complete = await page({ start: cur.newest - 1 }, (times) => { top = Math.max(top, ...times); });
    if (complete) cur.newest = top;
  }
  if (!cur.done) {
    const extra = cur.oldest != null ? { end: cur.oldest + 1 } : {};
    cur.done = await page(extra, (times) => {
      if (!times.length) return;
      cur.newest = Math.max(cur.newest ?? 0, ...times);
      cur.oldest = Math.min(cur.oldest ?? Infinity, ...times);
    });
  }
}

async function krakenStatusLookup(account, method) {
  const index = {};
  let cursor = 'true';
  for (let n = 0; n < 20; n++) {
    const res = await krakenPrivate(account, method, { cursor, limit: 50 });
    const rows = krakenStatusRows(res);
    krakenStatusIndex(rows, index);
    const next = res && !Array.isArray(res) ? res.next_cursor : null;
    if (!next || !rows.length) break;
    cursor = next;
  }
  return index;
}

async function krakenHistory(db, account, state, save, problems) {
  const st = (state.kraken ||= {});
  let added = 0;
  const store = (events) => { added += storeEvents(db, account, events); };
  const part = async (label, fn) => {
    try { await fn(); } catch (e) {
      if (e.auth && !/Permission denied/i.test(e.code || '')) throw e; // bad key: stop
      problems.push(redact(e.message, account));
      log.warn(`cex-history:${account.id}`, label, redact(e.message, account));
    }
  };

  await part('trades', async () => {
    const pairMap = await krakenPairs().catch(() => null); // the heuristic split still works without it
    const cur = (st.trades ||= {});
    await krakenWalk(account, 'TradesHistory', {}, 'trades', cur, (trades) => { store(krakenTradesToEvents(account, trades, pairMap)); save(); });
    save();
  });

  // On-chain txids and addresses, keyed by refid (best effort: transfers still import without them).
  const status = {};
  for (const m of ['DepositStatus', 'WithdrawStatus']) {
    try { Object.assign(status, await krakenStatusLookup(account, m)); } catch (e) {
      if (e.auth && !/Permission denied/i.test(e.code || '')) throw e;
      log.warn(`cex-history:${account.id}`, `${m} unavailable (transfers imported without on-chain txid):`, redact(e.message, account));
    }
  }

  let ledgerDenied = false;
  for (const type of ['deposit', 'withdrawal', 'staking', 'earn']) {
    if (ledgerDenied) break;
    await part(`ledger ${type}`, async () => {
      const cur = (st[`ledger:${type}`] ||= {});
      try {
        await krakenWalk(account, 'Ledgers', { type }, 'ledger', cur, (ledger) => { store(krakenLedgerToEvents(account, ledger, status)); save(); });
      } catch (e) {
        if (/Permission denied/i.test(e.code || '')) ledgerDenied = true;
        // Older API versions reject unknown ledger types; rewards are optional.
        if ((type === 'staking' || type === 'earn') && !e.auth && /Invalid arguments/i.test(e.code || '')) return;
        throw e;
      }
      save();
    });
  }
  return added;
}

// ------------------------------------------------------------------------------------------------
// Binance client
// ------------------------------------------------------------------------------------------------

export const BINANCE_READ_PATHS = new Set([
  '/sapi/v3/asset/getUserAsset',          // POST, but a pure query (spot balances)
  '/sapi/v1/asset/get-funding-asset',     // POST, but a pure query (funding wallet balances)
  '/api/v3/account',
  '/sapi/v1/simple-earn/flexible/position',
  '/sapi/v1/simple-earn/locked/position',
  '/api/v3/myTrades',
  '/sapi/v1/capital/deposit/hisrec',
  '/sapi/v1/capital/withdraw/history',
  '/sapi/v1/convert/tradeFlow',
]);
let binanceTimeOffset = 0;
let binanceBanUntil = 0;
let binanceWeightPauseUntil = 0;

// Stay well inside the per-minute weight limits (6000 IP weight on /api, 180000 UID / 12000 IP on /sapi).
function binanceNoteWeight(headers) {
  const over = num(headers.get('x-mbx-used-weight-1m')) > 4500 || num(headers.get('x-sapi-used-ip-weight-1m')) > 9000 ||
    num(headers.get('x-sapi-used-uid-weight-1m')) > 120000;
  if (over) binanceWeightPauseUntil = (Math.floor(internals.now() / 60000) + 1) * 60000 + 500;
}

async function binanceRequest(url, opts, path) {
  for (let attempt = 0; ; attempt++) {
    const now = internals.now();
    if (binanceBanUntil > now) throw new ApiError(`${binanceErrorMessage(418, null)} (about ${Math.ceil((binanceBanUntil - now) / 60000)} min left)`);
    if (binanceWeightPauseUntil > now) await internals.sleep(binanceWeightPauseUntil - now);
    let res;
    try {
      res = await http(url(), opts);
    } catch (e) {
      if (attempt >= 2) throw e;
      await internals.sleep(1500 * 2 ** attempt);
      continue;
    }
    binanceNoteWeight(res.headers);
    if (res.status === 418 || res.status === 429) {
      const retryAfter = Math.max(1, num(res.headers.get('retry-after')) || (res.status === 418 ? 120 : 10));
      if (res.status === 418) {
        binanceBanUntil = internals.now() + retryAfter * 1000;
        throw new ApiError(binanceErrorMessage(418, res.data, path));
      }
      if (attempt >= 3 || retryAfter > 90) throw new ApiError(binanceErrorMessage(429, res.data, path));
      await internals.sleep(retryAfter * 1000);
      continue;
    }
    if (res.status >= 500) {
      if (attempt >= 2) throw new ApiError(`Binance: HTTP ${res.status} for ${path}`);
      await internals.sleep(1500 * 2 ** attempt);
      continue;
    }
    return res;
  }
}

async function binancePublic(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await binanceRequest(() => `${BINANCE}${path}${qs ? `?${qs}` : ''}`, {}, path);
  if (res.status >= 400 || res.data == null) throw new ApiError(binanceErrorMessage(res.status, res.data, path));
  return res.data;
}

async function binanceSigned(account, method, path, params = {}) {
  if (!BINANCE_READ_PATHS.has(path)) throw new Error(`Refusing to call non-read Binance endpoint ${path}`);
  const key = String(account.api_key).trim();
  const secret = String(account.secret).trim();
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  for (let attempt = 0; ; attempt++) {
    const url = () => {
      const query = new URLSearchParams({ ...clean, recvWindow: 10000, timestamp: internals.now() + binanceTimeOffset }).toString();
      return `${BINANCE}${path}?${query}&signature=${binanceSign(query, secret)}`;
    };
    const res = await binanceRequest(url, { method, headers: { 'X-MBX-APIKEY': key } }, path);
    if (res.status < 400 && res.data != null) return res.data;
    const code = Number(res.data?.code);
    if (code === -1021 && attempt === 0) { // clock skew: learn the server time once and retry
      try {
        const t = await binancePublic('/api/v3/time');
        binanceTimeOffset = num(t.serverTime) - internals.now();
        continue;
      } catch { /* fall through to the error below */ }
    }
    throw new ApiError(binanceErrorMessage(res.status, res.data, path), {
      auth: [-2014, -2015, -2008, -1022, -1002, -1021].includes(code) || res.status === 401 || res.status === 451, code });
  }
}

let binanceInfoCache = null;
async function binanceSymbols() {
  if (binanceInfoCache && internals.now() - binanceInfoCache.at < CACHE_MS) return binanceInfoCache.promise;
  const entry = { at: internals.now(), promise: binancePublic('/api/v3/exchangeInfo').then(buildBinanceSymbolMap) };
  binanceInfoCache = entry;
  entry.promise.catch(() => { if (binanceInfoCache === entry) binanceInfoCache = null; });
  return entry.promise;
}

async function binanceEarnRows(account, path) {
  const rows = [];
  for (let current = 1; current <= 20; current++) {
    const res = await binanceSigned(account, 'GET', path, { current, size: 100 });
    const page = res?.rows || [];
    rows.push(...page);
    if (page.length < 100 || rows.length >= num(res.total)) break;
  }
  return rows;
}

async function binanceFetchBalances(account) {
  const src = `cex:${account.id}`;
  const payload = {};
  try {
    payload.spot = await binanceSigned(account, 'POST', '/sapi/v3/asset/getUserAsset', { needBtcValuation: false });
    if (!Array.isArray(payload.spot)) throw new ApiError('Binance: unexpected getUserAsset response');
  } catch {
    // Some key types (or a bad key) cannot use /sapi: /api/v3/account gives the definitive answer.
    payload.spot = undefined;
    payload.account = await binanceSigned(account, 'GET', '/api/v3/account', { omitZeroBalances: true });
  }
  const notes = [];
  const optional = async (name, fn) => {
    try { payload[name] = await fn(); } catch (e) {
      notes.push(name);
      log.warn(src, `${name} wallet not readable:`, redact(e.message, account));
    }
  };
  await optional('funding', () => binanceSigned(account, 'POST', '/sapi/v1/asset/get-funding-asset', { needBtcValuation: false }));
  await optional('flexible', () => binanceEarnRows(account, '/sapi/v1/simple-earn/flexible/position'));
  await optional('locked', () => binanceEarnRows(account, '/sapi/v1/simple-earn/locked/position'));
  let known = null;
  try {
    const map = await binanceSymbols();
    known = new Set();
    for (const m of map.values()) { known.add(m.base); known.add(m.quote); }
  } catch { /* LD stripping falls back to the name-only rule */ }
  return { balances: binanceBalances(payload, known), notes };
}

async function binanceFetchPrices(symbols) {
  const out = new Map();
  const plan = binancePricePlan(symbols, await binanceSymbols());
  for (let i = 0; i < plan.length; i += 80) {
    const chunk = plan.slice(i, i + 80);
    const tickers = await binancePublic('/api/v3/ticker/24hr', { symbols: JSON.stringify(chunk.map((p) => p.pair)) });
    for (const [s, p] of binanceTickerToPrices(chunk, tickers)) out.set(s, p);
  }
  return out;
}

const DAY = 86400_000;
const BINANCE_FIRST_SYNC_MS = 730 * DAY;
const BINANCE_OVERLAP_MS = 7 * DAY; // re-read a week: pending transfers complete later, ids make it idempotent
const BINANCE_RECHECK_MS = DAY;     // markets that never had a trade are re-polled once a day

async function binanceHistory(db, account, state, save, problems) {
  const src = `cex-history:${account.id}`;
  const st = (state.binance ||= {});
  st.trades ||= {};
  st.checked ||= {};
  let added = 0;
  const store = (events) => { added += storeEvents(db, account, events); };
  const now = internals.now();
  const part = async (label, fn) => {
    try { await fn(); } catch (e) {
      if (e.auth && e.code !== -2015 && e.code !== -1002) throw e; // bad key / signature: stop. Permission problems: keep going
      problems.push(redact(e.message, account));
      log.warn(src, label, redact(e.message, account));
    }
  };

  // Walk [cursor - overlap, now] (or the last two years on the first sync) in fixed-size windows.
  const windowed = async (cursorKey, spanMs, fetchWindow) => {
    const from = st[cursorKey] ? st[cursorKey] - BINANCE_OVERLAP_MS : now - BINANCE_FIRST_SYNC_MS;
    for (const [startTime, endTime] of timeWindows(from, now, spanMs)) await fetchWindow(startTime, endTime);
    st[cursorKey] = now;
    save();
  };
  const offsetPaged = async (path, params) => {
    const rows = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      const page = await binanceSigned(account, 'GET', path, { ...params, offset, limit: 1000 });
      if (!Array.isArray(page)) break;
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return rows;
  };

  // Transfers and conversions first: they introduce assets whose markets the trade scan must cover.
  await part('deposits', () => windowed('deposits', 90 * DAY, async (startTime, endTime) => {
    store(binanceDepositsToEvents(account, await offsetPaged('/sapi/v1/capital/deposit/hisrec', { startTime, endTime })));
  }));
  await part('withdrawals', () => windowed('withdrawals', 90 * DAY, async (startTime, endTime) => {
    store(binanceWithdrawalsToEvents(account, await offsetPaged('/sapi/v1/capital/withdraw/history', { startTime, endTime })));
  }));
  await part('convert', () => windowed('convert', 30 * DAY, async (startTime, endTime) => {
    const res = await binanceSigned(account, 'GET', '/sapi/v1/convert/tradeFlow', { startTime, endTime, limit: 1000 });
    store(binanceConvertToEvents(account, res?.list));
  }));

  await part('trades', async () => {
    const symbolMap = await binanceSymbols();
    const held = db.prepare('SELECT DISTINCT symbol FROM assets WHERE asset LIKE ?').all(`cex:${account.id}:%`).map((r) => r.symbol);
    let failures = 0;
    for (const symbol of binanceCandidateSymbols(held, symbolMap)) {
      const last = st.trades[symbol];
      if (last == null && st.checked[symbol] && now - st.checked[symbol] < BINANCE_RECHECK_MS) continue;
      try {
        let fromId = last != null ? last + 1 : 0;
        for (let n = 0; n < 200; n++) {
          const trades = await binanceSigned(account, 'GET', '/api/v3/myTrades', { symbol, fromId, limit: 1000 });
          if (!Array.isArray(trades) || !trades.length) break;
          store(binanceTradesToEvents(account, trades, symbolMap.get(symbol)));
          fromId = Math.max(...trades.map((t) => Number(t.id))) + 1;
          st.trades[symbol] = fromId - 1;
          save();
          if (trades.length < 1000) break;
        }
        st.checked[symbol] = now;
      } catch (e) {
        if (e.auth) throw e;
        if (++failures > 5) throw e; // something systemic (ban, outage): stop hammering
        log.warn(src, symbol, redact(e.message, account));
      }
    }
    save();
  });
  return added;
}

// ------------------------------------------------------------------------------------------------
// Sync entry points
// ------------------------------------------------------------------------------------------------

const ADAPTERS = {
  kraken: {
    balances: async (account) => ({ balances: await krakenFetchBalances(account), notes: [] }),
    prices: krakenFetchPrices,
    history: krakenHistory,
  },
  binance: { balances: binanceFetchBalances, prices: binanceFetchPrices, history: binanceHistory },
};

function adapterFor(account) {
  const ex = ADAPTERS[String(account?.exchange || '').toLowerCase()];
  if (!ex) throw new ApiError(`Unsupported exchange "${account?.exchange}". Supported: ${Object.keys(ADAPTERS).join(', ')}.`);
  requireCredentials(account);
  return ex;
}

function ensureAsset(db, account, symbol) {
  upsertAsset(db, { asset: assetKey(account, symbol), symbol, name: symbol, chain: account.exchange, price_id: priceIdFor(account.exchange, symbol), verified: true });
}

// Insert events (idempotent on id) after making sure every referenced asset row exists.
function storeEvents(db, account, events) {
  if (!events.length) return 0;
  for (const key of new Set(events.map((e) => e.asset))) ensureAsset(db, account, symbolOfAssetKey(account, key));
  return insertEvents(db, events);
}

function writePrices(db, exchange, prices) {
  const now = Math.floor(internals.now() / 1000);
  const up = db.prepare(`INSERT INTO prices (price_id, price, change24h, confidence, updated_at, source) VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(price_id) DO UPDATE SET price = excluded.price, change24h = excluded.change24h, confidence = 1,
      updated_at = excluded.updated_at, source = excluded.source`);
  up.run('cex:usd', 1, 0, now, 'fixed');
  for (const [symbol, p] of prices) up.run(`cex:${exchange}:${symbol}`, p.price, p.change24h ?? null, now, exchange);
}

export async function syncCexBalances(db, cfg, account) {
  const src = `cex:${account?.id}`;
  try {
    const ex = adapterFor(account);
    const { balances, notes } = await ex.balances(account);
    const rows = [];
    for (const b of balances) {
      ensureAsset(db, account, b.symbol);
      const multi = Object.keys(b.parts || {}).some((k) => k !== 'spot');
      rows.push({ asset: assetKey(account, b.symbol), qty: b.qty, meta: multi ? { parts: b.parts } : null });
    }
    replaceBalances(db, account.id, 'cex:', rows);

    // Prices from the exchange's own public tickers. A ticker failure must not hide the balances.
    let priceNote = '';
    const symbols = balances.map((b) => b.symbol).filter((s) => !USDISH.has(s));
    let prices = new Map();
    try {
      if (symbols.length) prices = await ex.prices(symbols);
    } catch (e) {
      priceNote = `; prices unavailable (${redact(e.message, account)})`;
      log.warn(src, 'prices', redact(e.message, account));
    }
    writePrices(db, account.exchange, prices);
    const unpriced = symbols.filter((s) => !prices.has(s));
    if (!priceNote && unpriced.length) priceNote = `; no USD market for ${unpriced.slice(0, 8).join(', ')}${unpriced.length > 8 ? '...' : ''}`;
    const walletNote = notes?.length ? `; could not read: ${notes.join(', ')}` : '';
    setStatus(db, src, true, `${rows.length} balances${priceNote}${walletNote}`);
  } catch (e) {
    const msg = redact(e?.message || e, account);
    try { setStatus(db, src, false, msg); } catch { /* db closed */ }
    log.warn(src, msg);
  }
}

export async function syncCexHistory(db, cfg, account) {
  const src = `cex-history:${account?.id}`;
  try {
    const ex = adapterFor(account);
    const kvKey = `cex-since:${account.id}`;
    let state = kvGet(db, kvKey, null);
    if (!state || typeof state !== 'object' || state.v !== 2) state = { v: 2 }; // older versions stored a bare timestamp
    const save = () => kvSet(db, kvKey, state);
    const problems = [];
    const added = await ex.history(db, account, state, save, problems);
    save();
    if (problems.length) setStatus(db, src, false, `${added} new events; ${[...new Set(problems)].join(' | ')}`);
    else setStatus(db, src, true, `${added} new events`);
  } catch (e) {
    const msg = redact(e?.message || e, account);
    try { setStatus(db, src, false, msg); } catch { /* db closed */ }
    log.warn(src, msg);
  }
}
