// Unit and end-to-end tests for the exchange adapter. No network: global fetch is stubbed with fixtures
// that follow the documented response shapes of Kraken and Binance.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  internals, krakenSign, binanceSign, krakenAsset, krakenAssetInfo, buildKrakenPairMap, splitKrakenPair, krakenBalances,
  krakenTradesToEvents, krakenLedgerToEvents, krakenStatusIndex, krakenStatusRows, krakenPricePlan, krakenTickerToPrices,
  krakenErrorMessage, binanceAsset, binanceBalances, buildBinanceSymbolMap, binanceCandidateSymbols, binanceTradesToEvents,
  binanceDepositsToEvents, binanceWithdrawalsToEvents, binanceConvertToEvents, binancePricePlan, binanceTickerToPrices,
  binanceErrorMessage, normTxid, timeWindows, redact, KRAKEN_READ_METHODS, BINANCE_READ_PATHS, syncCexBalances, syncCexHistory,
} from '../src/sources/cex.js';

// Not a real key: base64 of the text "not-a-real-secret:test-fixture-only.............".
const KRAKEN_SECRET = 'bm90LWEtcmVhbC1zZWNyZXQ6dGVzdC1maXh0dXJlLW9ubHkuLi4uLi4uLi4uLi4u';
const kraken = { id: 'k1', label: 'Kraken', exchange: 'kraken', api_key: 'KRAKEN-API-KEY-0001', secret: KRAKEN_SECRET, password: null };
const binance = { id: 'b1', label: 'Binance', exchange: 'binance', api_key: 'BINANCE-API-KEY-0001', secret: 'binance-secret-value-0001', password: null };

// ---------------------------------------------------------------- fixtures

const ASSET_PAIRS = {
  XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD' },
  XETHZUSD: { altname: 'ETHUSD', wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD' },
  XETHXXBT: { altname: 'ETHXBT', wsname: 'ETH/XBT', base: 'XETH', quote: 'XXBT' },
  XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBT/EUR', base: 'XXBT', quote: 'ZEUR' },
  SOLUSD: { altname: 'SOLUSD', wsname: 'SOL/USD', base: 'SOL', quote: 'ZUSD' },
  DOTUSD: { altname: 'DOTUSD', wsname: 'DOT/USD', base: 'DOT', quote: 'ZUSD' },
  XDGUSD: { altname: 'XDGUSD', wsname: 'XDG/USD', base: 'XXDG', quote: 'ZUSD' },
  ZEURZUSD: { altname: 'EURUSD', wsname: 'EUR/USD', base: 'ZEUR', quote: 'ZUSD' },
  USDZJPY: { altname: 'USDJPY', wsname: 'USD/JPY', base: 'ZUSD', quote: 'ZJPY' },
  USDTZUSD: { altname: 'USDTUSD', wsname: 'USDT/USD', base: 'USDT', quote: 'ZUSD' },
};
const pairMap = buildKrakenPairMap(ASSET_PAIRS);

const KRAKEN_TRADES = {
  'TCWJEG-FL4SZ-3FKGH6': { ordertxid: 'OQCLML-BW3P3-BUCMWZ', postxid: 'TKH2SE-M7IF5-CFI7LT', pair: 'XXBTZUSD', time: 1688667796.8802, type: 'buy',
    ordertype: 'limit', price: '30010.00000', cost: '600.20000', fee: '0.96032', vol: '0.02000000', margin: '0.00000', misc: '' },
  'TXYZAB-CDEF1-234567': { ordertxid: 'OAAAAA-BBBBB-CCCCCC', pair: 'SOLUSD', time: 1690000000.5, type: 'sell', ordertype: 'market',
    price: '25.00', cost: '250.00', fee: '0.65', vol: '10.00000000', margin: '0.00000', misc: '' },
  'TEUR00-00000-000001': { ordertxid: 'OEUR00-00000-000001', pair: 'XXBTZEUR', time: 1691000000.1, type: 'buy', ordertype: 'limit',
    price: '27000.0', cost: '2700.0', fee: '4.32', vol: '0.10000000', margin: '0.00000', misc: '' },
  'TMARGN-00000-000001': { ordertxid: 'OMARGN-00000-000001', pair: 'XETHZUSD', time: 1691500000.1, type: 'buy', ordertype: 'market',
    price: '1800.0', cost: '1800.0', fee: '4.0', vol: '1.00000000', margin: '360.00000', misc: '' },
};

const KRAKEN_LEDGER_DEPOSIT = {
  'L4UESK-KG3EQ-UFO4T5': { aclass: 'currency', amount: '0.5000000000', asset: 'XETH', balance: '0.5000000000', fee: '0.0000000000', refid: 'QGBHYJ5-VVFRVC-KUTJ2V',
    time: 1688464484.1787, type: 'deposit', subtype: '' },
  'LFIAT0-00000-000001': { aclass: 'currency', amount: '1000.0000', asset: 'ZEUR', balance: '1000.0000', fee: '0.0000', refid: 'QFIAT00-000000-000001',
    time: 1688000000.0, type: 'deposit', subtype: '' },
};
const KRAKEN_LEDGER_WITHDRAWAL = {
  'LWD000-00000-000001': { aclass: 'currency', amount: '-0.0100000000', asset: 'XXBT', balance: '0.0000000000', fee: '0.0001500000', refid: 'AGBSO6T-UFMTTQ-I7KGS6',
    time: 1689000000.25, type: 'withdrawal', subtype: '' },
};
const KRAKEN_LEDGER_STAKING = {
  'LSTK00-00000-000001': { aclass: 'currency', amount: '0.0123000000', asset: 'DOT.S', balance: '10.0123000000', fee: '0.0000000000', refid: 'STK0001-000000-000001',
    time: 1689500000.0, type: 'staking', subtype: '' },
};
const KRAKEN_LEDGER_EARN = {
  'LERN00-00000-000001': { aclass: 'currency', amount: '0.0000100000', asset: 'XBT.M', balance: '0.2000100000', fee: '0.0000020000', refid: 'ERN0001-000000-000001',
    time: 1689600000.0, type: 'earn', subtype: 'reward' },
  'LERN00-00000-000002': { aclass: 'currency', amount: '-0.2000000000', asset: 'XXBT', balance: '0.3', fee: '0', refid: 'ERN0002-000000-000001',
    time: 1689400000.0, type: 'earn', subtype: 'allocation' },
  'LERN00-00000-000003': { aclass: 'currency', amount: '0.2000000000', asset: 'XBT.M', balance: '0.2', fee: '0', refid: 'ERN0002-000000-000001',
    time: 1689400000.0, type: 'earn', subtype: 'allocation' },
};
const ETH_TXID = '0xAbCd00000000000000000000000000000000000000000000000000000000Ef12';
const KRAKEN_DEPOSIT_STATUS = [{ method: 'Ether (Hex)', aclass: 'currency', asset: 'XETH', refid: 'QGBHYJ5-VVFRVC-KUTJ2V', txid: ETH_TXID,
  info: '0x1111111111111111111111111111111111111111', amount: '0.5', fee: '0.0', time: 1688464300, status: 'Success' }];
const KRAKEN_WITHDRAW_STATUS = [{ method: 'Bitcoin', aclass: 'currency', asset: 'XXBT', refid: 'AGBSO6T-UFMTTQ-I7KGS6',
  txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16', info: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: '0.01', fee: '0.00015',
  time: 1688999900, status: 'Success', key: 'cold wallet' }];

const EXCHANGE_INFO = { timezone: 'UTC', symbols: [
  { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' },
  { symbol: 'ETHUSDT', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDT' },
  { symbol: 'ETHBTC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'BTC' },
  { symbol: 'SOLUSDT', status: 'TRADING', baseAsset: 'SOL', quoteAsset: 'USDT' },
  { symbol: 'LDOUSDT', status: 'TRADING', baseAsset: 'LDO', quoteAsset: 'USDT' },
  { symbol: 'BTCEUR', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'EUR' },
  { symbol: 'EURUSDT', status: 'TRADING', baseAsset: 'EUR', quoteAsset: 'USDT' },
  { symbol: 'USDCUSDT', status: 'TRADING', baseAsset: 'USDC', quoteAsset: 'USDT' },
  { symbol: 'BNBUSDT', status: 'TRADING', baseAsset: 'BNB', quoteAsset: 'USDT' },
  { symbol: 'XRPUSDT', status: 'TRADING', baseAsset: 'XRP', quoteAsset: 'USDT' },
] };
const symbolMap = buildBinanceSymbolMap(EXCHANGE_INFO);

const BINANCE_TRADES_BTCUSDT = [
  { symbol: 'BTCUSDT', id: 28457, orderId: 100234, orderListId: -1, price: '40000.00000000', qty: '0.05000000', quoteQty: '2000.00000000',
    commission: '0.00005000', commissionAsset: 'BTC', time: 1700000000000, isBuyer: true, isMaker: false, isBestMatch: true },
  { symbol: 'BTCUSDT', id: 28460, orderId: 100300, orderListId: -1, price: '42000.00000000', qty: '0.01000000', quoteQty: '420.00000000',
    commission: '0.42000000', commissionAsset: 'USDT', time: 1700100000000, isBuyer: false, isMaker: true, isBestMatch: true },
];
const BINANCE_DEPOSITS = [
  { id: '769800519366885376', amount: '0.50000000', coin: 'ETH', network: 'ETH', status: 1, address: '0x2222222222222222222222222222222222222222', addressTag: '',
    txId: '0xDEADBEEF00000000000000000000000000000000000000000000000000000001', insertTime: 1699000000000, transferType: 0, confirmTimes: '12/12' },
  { id: '769800519366885377', amount: '100', coin: 'USDT', network: 'BSC', status: 0, address: '0x2222222222222222222222222222222222222222', txId: '0xpending',
    insertTime: 1699000500000, transferType: 0 },
  { id: '769800519366885378', amount: '25', coin: 'USDT', network: 'BSC', status: 1, address: '0x2222222222222222222222222222222222222222',
    txId: 'Internal transfer 51376627901', insertTime: 1699001000000, transferType: 1 },
];
const BINANCE_WITHDRAWALS = [
  { id: 'b6ae22b3aa844210a7041aee7589627c', amount: '8.91000000', transactionFee: '0.004', coin: 'SOL', status: 6, address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    txId: '5wHu1qwD7q5ifaN5nwdcDqNFo53GJqa7nLp2BeeEpcHCusb4GzARz4GjgzsEHMkBMgCJMGa6GSQ1VG96Exv8kMbm', applyTime: '2023-11-10 10:00:00',
    completeTime: '2023-11-10 10:05:30', network: 'SOL', transferType: 0, walletType: 0 },
  { id: 'cancelled0001', amount: '1', transactionFee: '0.1', coin: 'USDT', status: 1, address: '0x3333333333333333333333333333333333333333', applyTime: '2023-11-11 10:00:00', network: 'ETH' },
];
const BINANCE_CONVERT = { list: [
  { quoteId: 'f3b91c525b2644c7bc1e1cd31b6e1aa6', orderId: 940708407462087195, orderStatus: 'SUCCESS', fromAsset: 'USDT', fromAmount: '20', toAsset: 'BNB',
    toAmount: '0.06154036', ratio: '0.00307702', inverseRatio: '324.99', createTime: 1698500000000 },
  { quoteId: 'failed', orderId: 940708407462087196, orderStatus: 'FAIL', fromAsset: 'USDT', fromAmount: '20', toAsset: 'BNB', toAmount: '0.06', createTime: 1698500001000 },
], startTime: 0, endTime: 0, limit: 1000, moreData: false };

// ---------------------------------------------------------------- signing

// Expected values were computed with an independent implementation (Python hmac/hashlib) that
// reproduces the worked examples in the Kraken and Binance API docs.
test('krakenSign matches an independently computed signature for the Kraken docs example request', () => {
  const sig = krakenSign('/0/private/AddOrder', '1616492376594',
    'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25', KRAKEN_SECRET);
  assert.equal(sig, 'Tgsbjq4d28F55POzwO0uFbKAB+djJXjgY/AbZYiZjgJI2P5sCLLOrUip91TorB/743IQUJU1udnWnQRkRVbJ3w==');
});

test('binanceSign matches an independently computed signature for the Binance docs example request', () => {
  const sig = binanceSign('symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559',
    binance.secret);
  assert.equal(sig, 'baff7a685be853eccce77ebc902caee02a96143b5cd4bfac25bd7b7a5959f2f9');
});

test('only read endpoints are allowlisted', () => {
  for (const m of KRAKEN_READ_METHODS) assert.doesNotMatch(m, /Order|Withdraw(?!Status)|Cancel|Transfer|Edit|Stake|Allocate|Add/i);
  for (const p of BINANCE_READ_PATHS) assert.doesNotMatch(p, /\/order|withdraw\/apply|transfer$|subscribe|redeem|purchase|acceptQuote|getQuote/i);
});

// ---------------------------------------------------------------- Kraken normalisation

test('krakenAsset normalises legacy codes and staking / earn variants', () => {
  const cases = { XXBT: 'BTC', XBT: 'BTC', XETH: 'ETH', ZUSD: 'USD', ZEUR: 'EUR', ZGBP: 'GBP', XXDG: 'DOGE', XDG: 'DOGE', XXRP: 'XRP', XLTC: 'LTC',
    'XBT.M': 'BTC', 'XXBT.F': 'BTC', 'ETH2.S': 'ETH', ETH2: 'ETH', 'DOT.S': 'DOT', 'DOT28.S': 'DOT', 'SOL.B': 'SOL', 'USDC.M': 'USDC', 'ADA.P': 'ADA',
    'USD.HOLD': 'USD', 'EUR.M': 'EUR', 'ZUSD.HOLD': 'USD',
    // not legacy: must keep their leading X / Z
    ZETA: 'ZETA', XION: 'XION', ZRX: 'ZRX', XTZ: 'XTZ', XRP: 'XRP', XCN: 'XCN', ZEUS: 'ZEUS', SOL: 'SOL', USDT: 'USDT', sol: 'SOL' };
  for (const [code, want] of Object.entries(cases)) assert.equal(krakenAsset(code), want, code);
  assert.deepEqual(krakenAssetInfo('ETH2.S'), { symbol: 'ETH', variant: 'staked' });
  assert.deepEqual(krakenAssetInfo('XBT.M'), { symbol: 'BTC', variant: 'earn' });
  assert.deepEqual(krakenAssetInfo('XXBT'), { symbol: 'BTC', variant: 'spot' });
});

test('splitKrakenPair uses AssetPairs and falls back to a heuristic', () => {
  assert.deepEqual(splitKrakenPair('XXBTZUSD', pairMap), { base: 'BTC', quote: 'USD' });
  assert.deepEqual(splitKrakenPair('XBTUSD', pairMap), { base: 'BTC', quote: 'USD' });
  assert.deepEqual(splitKrakenPair('XBT/USD', pairMap), { base: 'BTC', quote: 'USD' });
  assert.deepEqual(splitKrakenPair('SOLUSD', pairMap), { base: 'SOL', quote: 'USD' });
  assert.deepEqual(splitKrakenPair('XETHXXBT', pairMap), { base: 'ETH', quote: 'BTC' });
  // heuristic only (no pair map)
  assert.deepEqual(splitKrakenPair('XXBTZUSD', null), { base: 'BTC', quote: 'USD' });
  assert.deepEqual(splitKrakenPair('SOLUSD', null), { base: 'SOL', quote: 'USD' });
  assert.deepEqual(splitKrakenPair('XETHXXBT', null), { base: 'ETH', quote: 'BTC' });
  assert.deepEqual(splitKrakenPair('ETHXBT', null), { base: 'ETH', quote: 'BTC' });
  assert.deepEqual(splitKrakenPair('USDCUSDT', null), { base: 'USDC', quote: 'USDT' });
  assert.deepEqual(splitKrakenPair('USDTZUSD', null), { base: 'USDT', quote: 'USD' });
  assert.deepEqual(splitKrakenPair('XDGEUR', null), { base: 'DOGE', quote: 'EUR' });
  assert.deepEqual(splitKrakenPair('ADA/EUR', null), { base: 'ADA', quote: 'EUR' });
  assert.equal(splitKrakenPair('???', null), null);
});

test('krakenBalances sums staked / earn variants and accepts Balance and BalanceEx shapes', () => {
  const ex = krakenBalances({
    ZUSD: { balance: '1500.2500', hold_trade: '500.0000' }, 'USD.HOLD': { balance: '10.0000', hold_trade: '0' },
    XXBT: { balance: '0.3000000000', hold_trade: '0.0000000000' }, 'XBT.M': { balance: '0.2000100000', hold_trade: '0' },
    'ETH2.S': { balance: '1.5', hold_trade: '0' }, XETH: { balance: '0.5', hold_trade: '0' },
    'DOT28.S': { balance: '10.0123', hold_trade: '0' }, SOL: { balance: '0.0000000000', hold_trade: '0' }, KFEE: { balance: '120.00', hold_trade: '0' },
  });
  const by = Object.fromEntries(ex.map((b) => [b.symbol, b]));
  assert.deepEqual(Object.keys(by).sort(), ['BTC', 'DOT', 'ETH', 'USD']);
  assert.ok(Math.abs(by.BTC.qty - 0.50001) < 1e-12);
  assert.deepEqual(by.ETH.parts, { staked: 1.5, spot: 0.5 });
  assert.equal(by.ETH.qty, 2);
  assert.equal(by.USD.qty, 1510.25); // hold_trade is already inside balance
  assert.equal(by.DOT.qty, 10.0123);
  const plain = krakenBalances({ XXBT: '0.1', ZEUR: '50.5', XXDG: '1000' });
  assert.deepEqual(plain.map((b) => [b.symbol, b.qty]), [['BTC', 0.1], ['EUR', 50.5], ['DOGE', 1000]]);
});

// ---------------------------------------------------------------- Kraken mappers

test('krakenTradesToEvents builds base, quote and fee legs', () => {
  const ev = krakenTradesToEvents(kraken, KRAKEN_TRADES, pairMap);
  assert.equal(ev.length, 9); // 3 spot trades x 3 legs; the margin trade is skipped
  const [b, q, f] = ev.filter((e) => e.id.includes('TCWJEG-FL4SZ-3FKGH6'));
  assert.deepEqual({ id: b.id, asset: b.asset, qty: b.qty, kind: b.kind, price_usd: b.price_usd, ts: b.ts, tx: b.tx },
    { id: 'k1:t:TCWJEG-FL4SZ-3FKGH6:b', asset: 'cex:k1:BTC', qty: 0.02, kind: 'trade', price_usd: 30010, ts: 1688667796, tx: 'k1:OQCLML-BW3P3-BUCMWZ:TCWJEG-FL4SZ-3FKGH6' });
  assert.deepEqual({ id: q.id, asset: q.asset, qty: q.qty, kind: q.kind, price_usd: q.price_usd }, { id: 'k1:t:TCWJEG-FL4SZ-3FKGH6:q', asset: 'cex:k1:USD', qty: -600.2, kind: 'trade', price_usd: 1 });
  assert.deepEqual({ id: f.id, asset: f.asset, qty: f.qty, kind: f.kind }, { id: 'k1:t:TCWJEG-FL4SZ-3FKGH6:f', asset: 'cex:k1:USD', qty: -0.96032, kind: 'fee' });
  assert.equal(b.tx, q.tx);
  assert.equal(q.tx, f.tx);
  assert.equal(b.meta.symbol, 'BTC/USD');
  // sell: base out, quote in
  const sell = ev.filter((e) => e.id.includes('TXYZAB'));
  assert.equal(sell[0].qty, -10);
  assert.equal(sell[0].asset, 'cex:k1:SOL');
  assert.equal(sell[1].qty, 250);
  // non-USD quote: no USD price on either leg
  const eur = ev.filter((e) => e.id.includes('TEUR00'));
  assert.equal(eur[0].price_usd, null);
  assert.equal(eur[1].price_usd, null);
  assert.equal(eur[1].asset, 'cex:k1:EUR');
  assert.equal(eur[1].qty, -2700);
  // stable: same input -> same ids
  assert.deepEqual(krakenTradesToEvents(kraken, KRAKEN_TRADES, pairMap).map((e) => e.id), ev.map((e) => e.id));
  assert.equal(new Set(ev.map((e) => e.id)).size, ev.length);
});

test('krakenLedgerToEvents maps deposits, withdrawals and rewards', () => {
  const status = krakenStatusIndex([...KRAKEN_DEPOSIT_STATUS, ...KRAKEN_WITHDRAW_STATUS]);
  const dep = krakenLedgerToEvents(kraken, KRAKEN_LEDGER_DEPOSIT, status);
  assert.equal(dep.length, 2);
  assert.deepEqual({ id: dep[0].id, tx: dep[0].tx, asset: dep[0].asset, qty: dep[0].qty, kind: dep[0].kind, counterparty: dep[0].counterparty, ts: dep[0].ts },
    { id: 'k1:l:L4UESK-KG3EQ-UFO4T5', tx: ETH_TXID.toLowerCase(), asset: 'cex:k1:ETH', qty: 0.5, kind: 'transfer', counterparty: null, ts: 1688464484 });
  assert.equal(dep[1].tx, 'k1:QFIAT00-000000-000001'); // fiat: no on-chain txid
  assert.equal(dep[1].asset, 'cex:k1:EUR');

  const wd = krakenLedgerToEvents(kraken, KRAKEN_LEDGER_WITHDRAWAL, status);
  assert.equal(wd.length, 2);
  assert.equal(wd[0].qty, -0.01);
  assert.equal(wd[0].kind, 'transfer');
  assert.equal(wd[0].tx, 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16');
  assert.equal(wd[0].counterparty, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  assert.deepEqual({ id: wd[1].id, qty: wd[1].qty, kind: wd[1].kind, tx: wd[1].tx }, { id: 'k1:l:LWD000-00000-000001:f', qty: -0.00015, kind: 'fee', tx: wd[0].tx });

  const stk = krakenLedgerToEvents(kraken, KRAKEN_LEDGER_STAKING);
  assert.equal(stk.length, 1);
  assert.equal(stk[0].asset, 'cex:k1:DOT');
  assert.equal(stk[0].meta.income, 'staking');

  const earn = krakenLedgerToEvents(kraken, KRAKEN_LEDGER_EARN);
  assert.deepEqual(earn.map((e) => [e.id, e.asset, e.qty, e.kind]), [
    ['k1:l:LERN00-00000-000001', 'cex:k1:BTC', 0.00001, 'transfer'], ['k1:l:LERN00-00000-000001:f', 'cex:k1:BTC', -0.000002, 'fee']]); // allocations skipped

  // without status info the withdrawal still imports, keyed by refid
  const bare = krakenLedgerToEvents(kraken, KRAKEN_LEDGER_WITHDRAWAL);
  assert.equal(bare[0].tx, 'k1:AGBSO6T-UFMTTQ-I7KGS6');
  assert.equal(bare[0].counterparty, null);
  // cursor-paginated status shape
  assert.equal(krakenStatusRows({ deposits: KRAKEN_DEPOSIT_STATUS, next_cursor: 'abc' }).length, 1);
});

test('kraken price plan covers crypto, fiat and inverted fiat pairs', () => {
  const plan = krakenPricePlan(['BTC', 'DOGE', 'EUR', 'JPY', 'USD', 'USDT', 'NOPE'], pairMap);
  assert.deepEqual(plan, [{ symbol: 'BTC', pair: 'XXBTZUSD', invert: false }, { symbol: 'DOGE', pair: 'XDGUSD', invert: false },
    { symbol: 'EUR', pair: 'ZEURZUSD', invert: false }, { symbol: 'JPY', pair: 'USDZJPY', invert: true }]);
  const prices = krakenTickerToPrices(plan, {
    XXBTZUSD: { a: ['30300.1', '1', '1.000'], b: ['30300.0', '1', '1.000'], c: ['30303.00000', '0.00067643'], o: '30000.00000' },
    XDGUSD: { c: ['0.08', '100'], o: '0.1' }, ZEURZUSD: { c: ['1.0800', '10'], o: '1.0800' }, USDZJPY: { c: ['150.00', '10'], o: '149.00' },
  });
  assert.ok(Math.abs(prices.get('BTC').change24h - 0.0101) < 1e-9);
  assert.equal(prices.get('BTC').price, 30303);
  assert.ok(Math.abs(prices.get('DOGE').change24h + 0.2) < 1e-9);
  assert.equal(prices.get('EUR').price, 1.08);
  assert.ok(Math.abs(prices.get('JPY').price - 1 / 150) < 1e-12);
  assert.ok(prices.get('JPY').change24h < 0);
});

test('krakenErrorMessage names the permission to enable', () => {
  assert.match(krakenErrorMessage(['EGeneral:Permission denied'], 'BalanceEx'), /enable "Query Funds"/);
  assert.match(krakenErrorMessage(['EGeneral:Permission denied'], 'TradesHistory'), /enable "Query closed orders & trades"/);
  assert.match(krakenErrorMessage(['EGeneral:Permission denied'], 'Ledgers'), /enable "Query ledger entries"/);
  assert.match(krakenErrorMessage(['EAPI:Invalid key']), /invalid API key/);
  assert.match(krakenErrorMessage(['EAPI:Invalid signature']), /secret/);
  assert.match(krakenErrorMessage(['EAPI:Invalid nonce']), /[Nn]once window/);
  assert.match(krakenErrorMessage(['EAPI:Rate limit exceeded']), /rate limit/);
});

// ---------------------------------------------------------------- Binance mappers

test('binanceAsset strips the LD prefix but keeps LDO', () => {
  assert.deepEqual(binanceAsset('LDBTC'), { symbol: 'BTC', earn: true });
  assert.deepEqual(binanceAsset('LDUSDT'), { symbol: 'USDT', earn: true });
  assert.deepEqual(binanceAsset('LDO'), { symbol: 'LDO', earn: false });
  assert.deepEqual(binanceAsset('BTC'), { symbol: 'BTC', earn: false });
  const known = new Set(['BTC', 'LDO', 'USDT']);
  assert.deepEqual(binanceAsset('LDLDO', known), { symbol: 'LDO', earn: true });
  assert.deepEqual(binanceAsset('LDO', known), { symbol: 'LDO', earn: false });
  assert.deepEqual(binanceAsset('LDXYZ', known), { symbol: 'LDXYZ', earn: false }); // unknown remainder: leave alone
});

test('binanceBalances merges wallets without double counting flexible earn', () => {
  const out = binanceBalances({
    spot: [
      { asset: 'BTC', free: '0.10000000', locked: '0.05000000', freeze: '0', withdrawing: '0', ipoable: '0', btcValuation: '0' },
      { asset: 'LDBTC', free: '0.20000000', locked: '0', freeze: '0', withdrawing: '0', ipoable: '0' },
      { asset: 'USDT', free: '100', locked: '0', freeze: '5', withdrawing: '0', ipoable: '0' },
      { asset: 'LDO', free: '12', locked: '0', freeze: '0', withdrawing: '0', ipoable: '0' },
      { asset: 'XRP', free: '0', locked: '0', freeze: '0', withdrawing: '0', ipoable: '0' },
    ],
    funding: [{ asset: 'USDT', free: '50', locked: '0', freeze: '0', withdrawing: '0', btcValuation: '0' }],
    flexible: [{ asset: 'BTC', totalAmount: '0.20000100', productId: 'BTC001' }, { asset: 'ETH', totalAmount: '1.5' }],
    locked: [{ asset: 'SOL', amount: '10', positionId: '123' }],
  });
  const by = Object.fromEntries(out.map((b) => [b.symbol, b]));
  assert.deepEqual(Object.keys(by).sort(), ['BTC', 'ETH', 'LDO', 'SOL', 'USDT']);
  assert.ok(Math.abs(by.BTC.qty - 0.350001) < 1e-12); // 0.15 spot + max(0.2 LD, 0.200001 flexible)
  assert.equal(by.USDT.qty, 155);
  assert.deepEqual(by.USDT.parts, { spot: 105, funding: 50 });
  assert.equal(by.ETH.qty, 1.5);
  assert.equal(by.SOL.qty, 10);
  assert.equal(by.LDO.qty, 12);
  // fallback shape: GET /api/v3/account
  const fb = binanceBalances({ account: { balances: [{ asset: 'BTC', free: '1', locked: '0.5' }, { asset: 'LDETH', free: '2', locked: '0' }, { asset: 'BNB', free: '0', locked: '0' }] } });
  assert.deepEqual(fb.map((b) => [b.symbol, b.qty]), [['BTC', 1.5], ['ETH', 2]]);
});

test('binanceCandidateSymbols lists markets of held assets', () => {
  assert.deepEqual(binanceCandidateSymbols(['BTC', 'ETH', 'USDT'], symbolMap), ['BTCUSDT', 'ETHBTC', 'ETHUSDT']);
  assert.deepEqual(binanceCandidateSymbols(['BTC', 'EUR', 'USDC'], symbolMap), ['BTCEUR', 'BTCUSDT', 'EURUSDT', 'USDCUSDT']);
  assert.deepEqual(binanceCandidateSymbols([], symbolMap), []);
});

test('binanceTradesToEvents builds base, quote and fee legs', () => {
  const ev = binanceTradesToEvents(binance, BINANCE_TRADES_BTCUSDT, symbolMap.get('BTCUSDT'));
  assert.equal(ev.length, 6);
  assert.deepEqual(ev.slice(0, 3).map((e) => [e.id, e.asset, e.qty, e.kind, e.price_usd]), [
    ['b1:t:BTCUSDT:28457:b', 'cex:b1:BTC', 0.05, 'trade', 40000],
    ['b1:t:BTCUSDT:28457:q', 'cex:b1:USDT', -2000, 'trade', 1],
    ['b1:t:BTCUSDT:28457:f', 'cex:b1:BTC', -0.00005, 'fee', 40000],
  ]);
  assert.equal(new Set(ev.slice(0, 3).map((e) => e.tx)).size, 1);
  assert.equal(ev[0].ts, 1700000000);
  assert.deepEqual(ev.slice(3).map((e) => [e.asset, e.qty, e.kind]), [['cex:b1:BTC', -0.01, 'trade'], ['cex:b1:USDT', 420, 'trade'], ['cex:b1:USDT', -0.42, 'fee']]);
  // crypto quote: no USD price
  const cross = binanceTradesToEvents(binance, [{ symbol: 'ETHBTC', id: 1, orderId: 2, price: '0.05', qty: '2', quoteQty: '0.1', commission: '0.001', commissionAsset: 'BNB',
    time: 1700000000000, isBuyer: true }], symbolMap.get('ETHBTC'));
  assert.deepEqual(cross.map((e) => [e.asset, e.qty, e.price_usd]), [['cex:b1:ETH', 2, null], ['cex:b1:BTC', -0.1, null], ['cex:b1:BNB', -0.001, null]]);
  assert.equal(cross[0].id, 'b1:t:ETHBTC:1:b'); // ids are namespaced by symbol
});

test('binance deposit / withdrawal / convert mappers', () => {
  const dep = binanceDepositsToEvents(binance, BINANCE_DEPOSITS);
  assert.equal(dep.length, 2); // the pending one is skipped
  assert.deepEqual({ id: dep[0].id, tx: dep[0].tx, asset: dep[0].asset, qty: dep[0].qty, kind: dep[0].kind, ts: dep[0].ts, counterparty: dep[0].counterparty },
    { id: 'b1:dep:769800519366885376', tx: '0xdeadbeef00000000000000000000000000000000000000000000000000000001', asset: 'cex:b1:ETH', qty: 0.5, kind: 'transfer', ts: 1699000000, counterparty: null });
  assert.equal(dep[1].tx, 'b1:dep:769800519366885378'); // "Internal transfer ..." is not a txid

  const wd = binanceWithdrawalsToEvents(binance, BINANCE_WITHDRAWALS);
  assert.equal(wd.length, 2);
  assert.deepEqual({ id: wd[0].id, asset: wd[0].asset, qty: wd[0].qty, kind: wd[0].kind, counterparty: wd[0].counterparty, ts: wd[0].ts },
    { id: 'b1:wd:b6ae22b3aa844210a7041aee7589627c', asset: 'cex:b1:SOL', qty: -8.91, kind: 'transfer', counterparty: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      ts: Date.UTC(2023, 10, 10, 10, 5, 30) / 1000 });
  assert.match(wd[0].tx, /^5wHu1qwD/); // base58 txids keep their case
  assert.deepEqual([wd[1].id, wd[1].qty, wd[1].kind, wd[1].tx], ['b1:wd:b6ae22b3aa844210a7041aee7589627c:f', -0.004, 'fee', wd[0].tx]);

  const cv = binanceConvertToEvents(binance, BINANCE_CONVERT.list);
  assert.equal(cv.length, 2);
  assert.deepEqual([cv[0].asset, cv[0].qty, cv[0].price_usd, cv[0].kind], ['cex:b1:USDT', -20, 1, 'trade']);
  assert.equal(cv[1].asset, 'cex:b1:BNB');
  assert.ok(Math.abs(cv[1].price_usd - 20 / 0.06154036) < 1e-9);
  assert.equal(cv[0].tx, cv[1].tx);
});

test('binance price plan and ticker mapping', () => {
  const plan = binancePricePlan(['BTC', 'USDT', 'EUR', 'NOPE'], symbolMap);
  assert.deepEqual(plan, [{ symbol: 'BTC', pair: 'BTCUSDT' }, { symbol: 'EUR', pair: 'EURUSDT' }]);
  const prices = binanceTickerToPrices(plan, [{ symbol: 'BTCUSDT', lastPrice: '43000.10', priceChangePercent: '-2.500' }, { symbol: 'EURUSDT', lastPrice: '1.0850', priceChangePercent: '0.100' }]);
  assert.equal(prices.get('BTC').price, 43000.1);
  assert.ok(Math.abs(prices.get('BTC').change24h + 0.025) < 1e-12);
  assert.equal(prices.get('EUR').price, 1.085);
});

test('binanceErrorMessage explains key and permission problems', () => {
  assert.match(binanceErrorMessage(401, { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }, '/api/v3/account'), /Enable Reading/);
  assert.match(binanceErrorMessage(400, { code: -2014, msg: 'API-key format invalid.' }), /invalid API key format/);
  assert.match(binanceErrorMessage(400, { code: -1022, msg: 'Signature for this request is not valid.' }), /secret/);
  assert.match(binanceErrorMessage(418, null), /banned/);
  assert.match(binanceErrorMessage(451, { code: 0, msg: 'Service unavailable from a restricted location' }), /location/);
});

test('helpers: normTxid, timeWindows, redact', () => {
  assert.equal(normTxid('0xABCDEF'), '0xabcdef');
  assert.equal(normTxid('Internal transfer 123'), null);
  assert.equal(normTxid('Off-chain transfer 9'), null);
  assert.equal(normTxid(''), null);
  const w = timeWindows(0, 250, 100);
  assert.deepEqual(w, [[0, 99], [100, 199], [200, 250]]);
  assert.equal(timeWindows(Date.now() - 730 * 86400_000, Date.now(), 90 * 86400_000).length, 9);
  const r = redact(`boom ${kraken.api_key} ${kraken.secret} https://x/y?a=1&signature=abcdef0123`, kraken);
  assert.ok(!r.includes(kraken.api_key) && !r.includes(kraken.secret) && !r.includes('abcdef0123'));
});

// ---------------------------------------------------------------- end to end with a stubbed fetch

const realFetch = globalThis.fetch;
const realSleep = internals.sleep;
const realWarn = console.warn;
let calls = [];
let warnings = [];
beforeEach(() => {
  internals.resetCaches();
  internals.sleep = async () => {};
  calls = [];
  warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  internals.sleep = realSleep;
  console.warn = realWarn;
});

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (result) => json({ error: [], result });

// A fake Kraken that verifies API-Sign on every private call and serves `handlers[method](params)`.
function stubKraken(handlers, account = kraken) {
  let lastNonce = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    assert.equal(u.host, 'api.kraken.com');
    const method = u.pathname.split('/').pop();
    if (u.pathname.startsWith('/0/public/')) {
      calls.push({ method, params: Object.fromEntries(u.searchParams) });
      if (method === 'AssetPairs') return ok(ASSET_PAIRS);
      if (handlers[method]) return handlers[method](Object.fromEntries(u.searchParams));
      return json({ error: ['EGeneral:Unknown method'] });
    }
    assert.equal(opts.method, 'POST');
    assert.ok(KRAKEN_READ_METHODS.has(method), `unexpected private method ${method}`);
    const params = Object.fromEntries(new URLSearchParams(opts.body));
    assert.equal(opts.headers['API-Key'], account.api_key);
    assert.equal(opts.headers['API-Sign'], krakenSign(u.pathname, params.nonce, opts.body, account.secret));
    assert.ok(Number(params.nonce) > lastNonce, 'nonce must increase');
    lastNonce = Number(params.nonce);
    calls.push({ method, params });
    if (!handlers[method]) return json({ error: ['EGeneral:Permission denied'] });
    return handlers[method](params);
  };
}

const rowsOf = (db, sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));
const statusOf = (db, source) => ({ ...db.prepare('SELECT ok, message FROM source_status WHERE source = ?').get(source) });

test('kraken: balances sync end to end', async () => {
  const db = openDb(':memory:');
  stubKraken({
    BalanceEx: () => ok({ ZUSD: { balance: '1500.25', hold_trade: '0' }, XXBT: { balance: '0.3', hold_trade: '0.1' }, 'XBT.M': { balance: '0.2', hold_trade: '0' },
      'ETH2.S': { balance: '1.5', hold_trade: '0' }, ZEUR: { balance: '200', hold_trade: '0' }, USDT: { balance: '50', hold_trade: '0' }, SOL: { balance: '0', hold_trade: '0' } }),
    Ticker: (p) => {
      assert.deepEqual(p.pair.split(',').sort(), ['XETHZUSD', 'XXBTZUSD', 'ZEURZUSD']);
      return ok({ XXBTZUSD: { c: ['60000.0', '1'], o: '50000.0' }, XETHZUSD: { c: ['3000.0', '1'], o: '3000.0' }, ZEURZUSD: { c: ['1.1', '1'], o: '1.0' } });
    },
  });
  await syncCexBalances(db, {}, kraken);
  assert.deepEqual(statusOf(db, 'cex:k1'), { ok: 1, message: '5 balances' });
  const bal = Object.fromEntries(rowsOf(db, 'SELECT asset, qty FROM balances WHERE account_id = ?', 'k1').map((r) => [r.asset, r.qty]));
  assert.deepEqual(bal, { 'cex:k1:USD': 1500.25, 'cex:k1:BTC': 0.5, 'cex:k1:ETH': 1.5, 'cex:k1:EUR': 200, 'cex:k1:USDT': 50 });
  const assets = Object.fromEntries(rowsOf(db, 'SELECT asset, symbol, price_id, verified, chain FROM assets').map((r) => [r.asset, r]));
  assert.deepEqual(assets['cex:k1:BTC'], { asset: 'cex:k1:BTC', symbol: 'BTC', price_id: 'cex:kraken:BTC', verified: 1, chain: 'kraken' });
  assert.equal(assets['cex:k1:USD'].price_id, 'cex:usd');
  assert.equal(assets['cex:k1:USDT'].price_id, 'cex:usd');
  assert.equal(assets['cex:k1:EUR'].price_id, 'cex:kraken:EUR');
  const prices = Object.fromEntries(rowsOf(db, 'SELECT * FROM prices').map((r) => [r.price_id, r]));
  assert.equal(prices['cex:usd'].price, 1);
  assert.equal(prices['cex:kraken:BTC'].price, 60000);
  assert.ok(Math.abs(prices['cex:kraken:BTC'].change24h - 0.2) < 1e-9);
  assert.equal(prices['cex:kraken:BTC'].confidence, 1);
  assert.equal(prices['cex:kraken:BTC'].source, 'kraken');
  assert.ok(Math.abs(prices['cex:kraken:EUR'].price - 1.1) < 1e-12);
  const meta = JSON.parse(db.prepare("SELECT meta FROM balances WHERE asset = 'cex:k1:BTC'").get().meta);
  assert.deepEqual(meta, { parts: { spot: 0.3, earn: 0.2 } });

  // a sold-out asset disappears on the next sync
  stubKraken({ BalanceEx: () => ok({ ZUSD: { balance: '10', hold_trade: '0' } }) });
  await syncCexBalances(db, {}, kraken);
  assert.deepEqual(rowsOf(db, 'SELECT asset FROM balances'), [{ asset: 'cex:k1:USD' }]);
});

test('kraken: falls back to Balance when BalanceEx is unavailable', async () => {
  const db = openDb(':memory:');
  stubKraken({ BalanceEx: () => json({ error: ['EGeneral:Unknown method'] }), Balance: () => ok({ XXBT: '0.25' }), Ticker: () => ok({ XXBTZUSD: { c: ['60000', '1'], o: '60000' } }) });
  await syncCexBalances(db, {}, kraken);
  assert.equal(statusOf(db, 'cex:k1').ok, 1);
  assert.equal(db.prepare("SELECT qty FROM balances WHERE asset = 'cex:k1:BTC'").get().qty, 0.25);
});

test('kraken: clear errors for missing key, invalid key and missing permission; nothing leaks', async () => {
  const db = openDb(':memory:');
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  await syncCexBalances(db, {}, { ...kraken, api_key: '' });
  assert.match(statusOf(db, 'cex:k1').message, /No API key set/);
  await syncCexBalances(db, {}, { ...kraken, secret: '' });
  assert.match(statusOf(db, 'cex:k1').message, /No API secret set/);
  await syncCexHistory(db, {}, { ...kraken, api_key: null });
  assert.match(statusOf(db, 'cex-history:k1').message, /No API key set/);
  await syncCexBalances(db, {}, { ...kraken, exchange: 'mtgox' });
  assert.match(statusOf(db, 'cex:k1').message, /Unsupported exchange/);

  stubKraken({ BalanceEx: () => json({ error: ['EAPI:Invalid key'] }) });
  await syncCexBalances(db, {}, kraken);
  assert.deepEqual([statusOf(db, 'cex:k1').ok, /invalid API key/.test(statusOf(db, 'cex:k1').message)], [0, true]);
  assert.equal(calls.filter((c) => c.method === 'Balance').length, 0);

  stubKraken({ BalanceEx: () => json({ error: ['EGeneral:Permission denied'] }) });
  await syncCexBalances(db, {}, kraken);
  assert.match(statusOf(db, 'cex:k1').message, /enable "Query Funds"/);

  globalThis.fetch = async () => { throw new TypeError(`fetch failed ${kraken.api_key} ${kraken.secret}`); };
  await syncCexBalances(db, {}, kraken);
  assert.match(statusOf(db, 'cex:k1').message, /Network error/);
  const everything = warnings.join('\n') + JSON.stringify(rowsOf(db, 'SELECT * FROM source_status'));
  assert.ok(!everything.includes(kraken.api_key) && !everything.includes(kraken.secret));
});

test('kraken: history sync end to end, paged, incremental and idempotent', async () => {
  const db = openDb(':memory:');
  // 120 extra old trades to force 3 pages of 50
  const many = {};
  for (let i = 0; i < 120; i++) {
    many[`TOLD00-00000-${String(i).padStart(6, '0')}`] = { ordertxid: `OOLD00-00000-${String(i).padStart(6, '0')}`, pair: 'XETHZUSD', time: 1600000000 + i * 60, type: i % 2 ? 'sell' : 'buy',
      ordertype: 'limit', price: '400.0', cost: '40.0', fee: '0.1', vol: '0.1', margin: '0.00000', misc: '' };
  }
  let allTrades = { ...KRAKEN_TRADES, ...many };
  const tradesHandler = (p) => {
    let rows = Object.entries(allTrades).sort((a, b) => b[1].time - a[1].time); // newest first
    if (p.start) rows = rows.filter(([, t]) => t.time > Number(p.start));
    if (p.end) rows = rows.filter(([, t]) => t.time <= Number(p.end));
    const ofs = Number(p.ofs || 0);
    return ok({ trades: Object.fromEntries(rows.slice(ofs, ofs + 50)), count: rows.length });
  };
  const ledgers = { deposit: KRAKEN_LEDGER_DEPOSIT, withdrawal: KRAKEN_LEDGER_WITHDRAWAL, staking: KRAKEN_LEDGER_STAKING, earn: KRAKEN_LEDGER_EARN };
  const handlers = {
    TradesHistory: tradesHandler,
    Ledgers: (p) => {
      let rows = Object.entries(ledgers[p.type] || {});
      if (p.start) rows = rows.filter(([, l]) => l.time > Number(p.start));
      if (p.end) rows = rows.filter(([, l]) => l.time <= Number(p.end));
      return ok({ ledger: Object.fromEntries(rows), count: rows.length });
    },
    DepositStatus: () => ok(KRAKEN_DEPOSIT_STATUS),
    WithdrawStatus: () => ok({ withdrawals: KRAKEN_WITHDRAW_STATUS, next_cursor: null }),
  };
  stubKraken(handlers);
  await syncCexHistory(db, {}, kraken);
  // 123 spot trades x 3 legs (margin trade skipped) + 2 deposits + withdrawal (2) + staking (1) + earn reward (2)
  const expected = 123 * 3 + 2 + 2 + 1 + 2;
  assert.deepEqual(statusOf(db, 'cex-history:k1'), { ok: 1, message: `${expected} new events` });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, expected);
  assert.equal(calls.filter((c) => c.method === 'TradesHistory').length, 3);
  assert.deepEqual(calls.filter((c) => c.method === 'TradesHistory').map((c) => c.params.ofs), ['0', '50', '100']);
  // every event's asset exists (the ledger joins on it)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events e LEFT JOIN assets a ON a.asset = e.asset WHERE a.asset IS NULL').get().n, 0);
  const dep = { ...db.prepare("SELECT tx, qty, kind, asset FROM events WHERE id = 'k1:l:L4UESK-KG3EQ-UFO4T5'").get() };
  assert.deepEqual(dep, { tx: ETH_TXID.toLowerCase(), qty: 0.5, kind: 'transfer', asset: 'cex:k1:ETH' });
  const wd = { ...db.prepare("SELECT tx, counterparty FROM events WHERE id = 'k1:l:LWD000-00000-000001'").get() };
  assert.equal(wd.counterparty, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  const state = JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'cex-since:k1'").get().v);
  assert.equal(state.kraken.trades.done, true);
  assert.equal(state.kraken.trades.newest, 1691500000); // the skipped margin fill still advances the cursor

  // second run: only asks for what is newer, adds nothing
  calls = [];
  await syncCexHistory(db, {}, kraken);
  assert.deepEqual(statusOf(db, 'cex-history:k1'), { ok: 1, message: '0 new events' });
  const th = calls.filter((c) => c.method === 'TradesHistory');
  assert.equal(th.length, 1);
  assert.equal(th[0].params.start, String(1691500000 - 1));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, expected);

  // a new trade shows up on the third run
  allTrades = { ...allTrades, 'TNEW00-00000-000001': { ordertxid: 'ONEW00-00000-000001', pair: 'DOTUSD', time: 1692000000.2, type: 'buy', ordertype: 'limit', price: '5.0', cost: '50.0', fee: '0.13', vol: '10', margin: '0.00000' } };
  await syncCexHistory(db, {}, kraken);
  assert.deepEqual(statusOf(db, 'cex-history:k1'), { ok: 1, message: '3 new events' });
  assert.equal(db.prepare("SELECT qty FROM events WHERE id = 'k1:t:TNEW00-00000-000001:b'").get().qty, 10);
});

test('kraken: missing ledger permission is reported while trades still import', async () => {
  const db = openDb(':memory:');
  stubKraken({ TradesHistory: (p) => ok({ trades: p.ofs === '0' ? KRAKEN_TRADES : {}, count: 4 }) });
  await syncCexHistory(db, {}, kraken);
  const st = statusOf(db, 'cex-history:k1');
  assert.equal(st.ok, 0);
  assert.match(st.message, /^9 new events; .*enable "Query ledger entries"/);
  assert.equal(calls.filter((c) => c.method === 'Ledgers').length, 1); // no point asking four times
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 9);
});

test('kraken: rate-limit errors are retried', async () => {
  const db = openDb(':memory:');
  let n = 0;
  stubKraken({ BalanceEx: () => (n++ === 0 ? json({ error: ['EAPI:Rate limit exceeded'] }) : ok({ ZUSD: { balance: '5', hold_trade: '0' } })) });
  await syncCexBalances(db, {}, kraken);
  assert.deepEqual(statusOf(db, 'cex:k1'), { ok: 1, message: '1 balances' });
  assert.equal(n, 2);
});

// A fake Binance that verifies the signature of every signed call.
function stubBinance(handlers, account = binance) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    assert.equal(u.host, 'api.binance.com');
    const params = Object.fromEntries(u.searchParams);
    const path = u.pathname;
    if (params.signature) {
      assert.ok(BINANCE_READ_PATHS.has(path), `unexpected signed endpoint ${path}`);
      const query = u.search.slice(1).replace(/&signature=[0-9a-f]+$/, '');
      assert.equal(params.signature, binanceSign(query, account.secret));
      assert.equal(opts.headers['X-MBX-APIKEY'], account.api_key);
      assert.ok(params.timestamp && params.recvWindow);
      assert.equal(opts.body, undefined);
    }
    calls.push({ path, method: opts.method || 'GET', params });
    if (path === '/api/v3/exchangeInfo') return json(EXCHANGE_INFO);
    if (path === '/api/v3/time') return json({ serverTime: Date.now() + 5000 });
    if (!handlers[path]) return json({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }, 401);
    return handlers[path](params, opts);
  };
}

test('binance: balances sync end to end', async () => {
  const db = openDb(':memory:');
  stubBinance({
    '/sapi/v3/asset/getUserAsset': (p, o) => {
      assert.equal(o.method, 'POST');
      return json([{ asset: 'BTC', free: '0.1', locked: '0.05', freeze: '0', withdrawing: '0', ipoable: '0', btcValuation: '0' },
        { asset: 'LDBTC', free: '0.2', locked: '0', freeze: '0', withdrawing: '0', ipoable: '0' },
        { asset: 'LDO', free: '12', locked: '0', freeze: '0', withdrawing: '0', ipoable: '0' },
        { asset: 'USDT', free: '100', locked: '0', freeze: '0', withdrawing: '0', ipoable: '0' }]);
    },
    '/sapi/v1/asset/get-funding-asset': () => json([{ asset: 'USDT', free: '50', locked: '0', freeze: '0', withdrawing: '0' }]),
    '/sapi/v1/simple-earn/flexible/position': () => json({ rows: [{ asset: 'BTC', totalAmount: '0.2' }], total: 1 }),
    '/sapi/v1/simple-earn/locked/position': () => json({ rows: [{ asset: 'SOL', amount: '10' }], total: 1 }),
    '/api/v3/ticker/24hr': (p) => {
      assert.deepEqual(JSON.parse(p.symbols).sort(), ['BTCUSDT', 'LDOUSDT', 'SOLUSDT']);
      return json([{ symbol: 'BTCUSDT', lastPrice: '50000.00', priceChangePercent: '5.000' }, { symbol: 'LDOUSDT', lastPrice: '2.00', priceChangePercent: '-1.000' },
        { symbol: 'SOLUSDT', lastPrice: '100.00', priceChangePercent: '0.000' }]);
    },
  });
  await syncCexBalances(db, {}, binance);
  assert.deepEqual(statusOf(db, 'cex:b1'), { ok: 1, message: '4 balances' });
  const bal = Object.fromEntries(rowsOf(db, 'SELECT asset, qty FROM balances').map((r) => [r.asset, Math.round(r.qty * 1e8) / 1e8]));
  assert.deepEqual(bal, { 'cex:b1:BTC': 0.35, 'cex:b1:LDO': 12, 'cex:b1:USDT': 150, 'cex:b1:SOL': 10 });
  const prices = Object.fromEntries(rowsOf(db, 'SELECT price_id, price, change24h, source FROM prices').map((r) => [r.price_id, r]));
  assert.deepEqual(prices['cex:binance:BTC'], { price_id: 'cex:binance:BTC', price: 50000, change24h: 0.05, source: 'binance' });
  assert.equal(prices['cex:usd'].price, 1);
  assert.equal(db.prepare("SELECT price_id FROM assets WHERE asset = 'cex:b1:USDT'").get().price_id, 'cex:usd');
  assert.equal(db.prepare("SELECT verified FROM assets WHERE asset = 'cex:b1:SOL'").get().verified, 1);
});

test('binance: falls back to /api/v3/account and reports unreadable wallets', async () => {
  const db = openDb(':memory:');
  stubBinance({
    '/api/v3/account': () => json({ makerCommission: 10, canTrade: false, balances: [{ asset: 'ETH', free: '2', locked: '0' }, { asset: 'LDETH', free: '1', locked: '0' }] }),
    '/api/v3/ticker/24hr': () => json([{ symbol: 'ETHUSDT', lastPrice: '3000', priceChangePercent: '1' }]),
  });
  await syncCexBalances(db, {}, binance);
  const st = statusOf(db, 'cex:b1');
  assert.equal(st.ok, 1);
  assert.match(st.message, /^1 balances; could not read: funding, flexible, locked$/);
  assert.equal(db.prepare("SELECT qty FROM balances WHERE asset = 'cex:b1:ETH'").get().qty, 3);
});

test('binance: invalid key gives a clear message', async () => {
  const db = openDb(':memory:');
  stubBinance({});
  await syncCexBalances(db, {}, binance);
  const st = statusOf(db, 'cex:b1');
  assert.equal(st.ok, 0);
  assert.match(st.message, /invalid API key, IP not allowed, or missing permission.*Enable Reading/);
  await syncCexBalances(db, {}, { ...binance, api_key: ' ' });
  assert.match(statusOf(db, 'cex:b1').message, /No API key set/);
  const everything = warnings.join('\n') + JSON.stringify(rowsOf(db, 'SELECT * FROM source_status'));
  assert.ok(!everything.includes(binance.api_key) && !everything.includes(binance.secret) && !/signature=[0-9a-f]{10}/.test(everything));
});

test('binance: 429 backs off and retries, 418 stops and remembers the ban', async () => {
  const db = openDb(':memory:');
  const slept = [];
  internals.sleep = async (ms) => { slept.push(ms); };
  let n = 0;
  stubBinance({
    '/sapi/v3/asset/getUserAsset': () => (n++ === 0 ? json({ code: -1003, msg: 'Too many requests.' }, 429, { 'retry-after': '7' }) : json([{ asset: 'USDT', free: '1', locked: '0' }])),
    '/sapi/v1/asset/get-funding-asset': () => json([]),
    '/sapi/v1/simple-earn/flexible/position': () => json({ rows: [], total: 0 }),
    '/sapi/v1/simple-earn/locked/position': () => json({ rows: [], total: 0 }),
  });
  await syncCexBalances(db, {}, binance);
  assert.deepEqual(statusOf(db, 'cex:b1'), { ok: 1, message: '1 balances' });
  assert.ok(slept.includes(7000));

  stubBinance({ '/sapi/v3/asset/getUserAsset': () => json({ code: -1003, msg: 'Way too many requests; IP banned.' }, 418, { 'retry-after': '300' }) });
  await syncCexBalances(db, {}, binance);
  assert.match(statusOf(db, 'cex:b1').message, /temporarily banned/);
  calls = [];
  await syncCexBalances(db, {}, binance);
  assert.equal(calls.length, 0); // no request while banned
  assert.match(statusOf(db, 'cex:b1').message, /temporarily banned/);
});

test('binance: clock skew (-1021) is corrected once using the server time', async () => {
  const db = openDb(':memory:');
  let n = 0;
  stubBinance({
    '/sapi/v3/asset/getUserAsset': () => (n++ === 0 ? json({ code: -1021, msg: "Timestamp for this request is outside of the recvWindow." }, 400) : json([{ asset: 'USDT', free: '3', locked: '0' }])),
    '/sapi/v1/asset/get-funding-asset': () => json([]),
    '/sapi/v1/simple-earn/flexible/position': () => json({ rows: [], total: 0 }),
    '/sapi/v1/simple-earn/locked/position': () => json({ rows: [], total: 0 }),
  });
  await syncCexBalances(db, {}, binance);
  assert.deepEqual(statusOf(db, 'cex:b1'), { ok: 1, message: '1 balances' });
  assert.equal(calls.filter((c) => c.path === '/api/v3/time').length, 1);
});

test('binance: history sync end to end, windowed, incremental and idempotent', async () => {
  const db = openDb(':memory:');
  const now = Date.UTC(2023, 10, 20); // fixtures are dated Oct/Nov 2023
  internals.now = () => now;
  try {
    const inWindow = (p, t) => t >= Number(p.startTime) && t <= Number(p.endTime);
    let btcTrades = BINANCE_TRADES_BTCUSDT;
    const handlers = {
      '/sapi/v1/capital/deposit/hisrec': (p) => {
        assert.ok(Number(p.endTime) - Number(p.startTime) < 90 * 86400_000);
        return json(BINANCE_DEPOSITS.filter((d) => inWindow(p, d.insertTime)));
      },
      '/sapi/v1/capital/withdraw/history': (p) => {
        assert.ok(Number(p.endTime) - Number(p.startTime) < 90 * 86400_000);
        return json(BINANCE_WITHDRAWALS.filter((w) => inWindow(p, Date.parse(`${w.applyTime.replace(' ', 'T')}Z`))));
      },
      '/sapi/v1/convert/tradeFlow': (p) => {
        assert.ok(Number(p.endTime) - Number(p.startTime) < 30 * 86400_000);
        return json({ ...BINANCE_CONVERT, list: BINANCE_CONVERT.list.filter((c) => inWindow(p, c.createTime)) });
      },
      '/api/v3/myTrades': (p) => json(p.symbol === 'BTCUSDT' ? btcTrades.filter((t) => t.id >= Number(p.fromId)) : []),
    };
    stubBinance(handlers);
    // The account is known to hold BTC (from a balance sync); ETH, SOL, USDT, BNB arrive via transfers / convert.
    db.prepare("INSERT INTO assets (asset, symbol, chain, price_id) VALUES ('cex:b1:BTC', 'BTC', 'binance', 'cex:binance:BTC')").run();
    await syncCexHistory(db, {}, binance);
    // 2 deposits + withdrawal (2) + convert (2) + 2 trades x 3 legs
    assert.deepEqual(statusOf(db, 'cex-history:b1'), { ok: 1, message: '12 new events' });
    assert.equal(calls.filter((c) => c.path === '/sapi/v1/capital/deposit/hisrec').length, 9); // two years in 90-day windows
    assert.equal(calls.filter((c) => c.path === '/sapi/v1/capital/withdraw/history').length, 9);
    assert.equal(calls.filter((c) => c.path === '/sapi/v1/convert/tradeFlow').length, 25);
    const scanned = calls.filter((c) => c.path === '/api/v3/myTrades').map((c) => c.params.symbol).sort();
    assert.deepEqual(scanned, ['BNBUSDT', 'BTCUSDT', 'ETHBTC', 'ETHUSDT', 'SOLUSDT']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events e LEFT JOIN assets a ON a.asset = e.asset WHERE a.asset IS NULL').get().n, 0);
    const kinds = Object.fromEntries(rowsOf(db, 'SELECT kind, COUNT(*) AS n FROM events GROUP BY kind').map((r) => [r.kind, r.n]));
    assert.deepEqual(kinds, { fee: 3, trade: 6, transfer: 3 });
    const state = JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'cex-since:b1'").get().v);
    assert.equal(state.binance.trades.BTCUSDT, 28460);
    assert.equal(state.binance.deposits, now);

    // second run: one overlap window each, trades resume after the last id, quiet markets are not re-polled
    calls = [];
    await syncCexHistory(db, {}, binance);
    assert.deepEqual(statusOf(db, 'cex-history:b1'), { ok: 1, message: '0 new events' });
    assert.equal(calls.filter((c) => c.path === '/sapi/v1/capital/deposit/hisrec').length, 1);
    const mt = calls.filter((c) => c.path === '/api/v3/myTrades');
    assert.deepEqual(mt.map((c) => [c.params.symbol, c.params.fromId]), [['BTCUSDT', '28461']]);

    // a new fill is picked up
    btcTrades = [...btcTrades, { symbol: 'BTCUSDT', id: 28500, orderId: 100400, price: '45000', qty: '0.001', quoteQty: '45', commission: '0', commissionAsset: 'BNB', time: now - 1000, isBuyer: true }];
    await syncCexHistory(db, {}, binance);
    assert.deepEqual(statusOf(db, 'cex-history:b1'), { ok: 1, message: '2 new events' });
  } finally {
    internals.now = () => Date.now();
  }
});

test('legacy numeric cex-since cursor is replaced, not misread', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO kv (k, v) VALUES ('cex-since:k1', '1700000000000')").run();
  stubKraken({ TradesHistory: () => ok({ trades: {}, count: 0 }), Ledgers: () => ok({ ledger: {}, count: 0 }), DepositStatus: () => ok([]), WithdrawStatus: () => ok([]) });
  await syncCexHistory(db, {}, kraken);
  assert.deepEqual(statusOf(db, 'cex-history:k1'), { ok: 1, message: '0 new events' });
  assert.equal(JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'cex-since:k1'").get().v).v, 2);
});
