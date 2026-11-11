import test from 'node:test';
import assert from 'node:assert/strict';
import { transferEvent } from '../src/sources/alchemy.js';

const chain = { name: 'base', native: { symbol: 'ETH' } };
const me = '0x' + 'a'.repeat(40);
const tok = '0x' + 'c'.repeat(40);
const known = new Map([[tok, { decimals: 18 }]]);
const meta = { blockTimestamp: '2026-10-29T22:40:00.000Z' };

test('erc20 in, native out, spam skipped', () => {
  const inn = transferEvent(chain, 'w', me, { hash: '0x1', uniqueId: '0x1:log:5', from: '0xdead', to: me, category: 'erc20', value: 2.5,
    rawContract: { address: tok, value: '0x' + (25n * 10n ** 17n).toString(16), decimal: '0x12' }, metadata: meta }, known);
  assert.equal(inn.qty, 2.5);
  assert.equal(inn.asset, `base:${tok}`);
  assert.equal(inn.tx, 'base:0x1');
  assert.equal(inn.counterparty, '0xdead');
  assert.equal(inn.ts, 1793313600);
  const out = transferEvent(chain, 'w', me, { hash: '0x2', uniqueId: '0x2:external', from: me, to: '0xbeef', category: 'external', value: 0.1,
    rawContract: { value: '0x' + (10n ** 17n).toString(16), decimal: '0x12' }, metadata: meta }, known);
  assert.equal(out.qty, -0.1);
  assert.equal(out.asset, 'base:native');
  const spam = transferEvent(chain, 'w', me, { hash: '0x3', from: '0xdead', to: me, category: 'erc20', value: 1e6,
    rawContract: { address: '0x' + 'd'.repeat(40), value: '0x1', decimal: '0x12' }, metadata: meta }, known);
  assert.equal(spam, null);
});
