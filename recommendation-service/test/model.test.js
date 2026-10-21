'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createModel } = require('../src/model');

const ev = (id, items) => ({ eventId: id, type: 'OrderPlaced', data: { customerId: 'c', contact: { email: 'x@y.z' }, items } });

test('ranks products by quantity sold and ignores duplicate events', () => {
  const m = createModel();
  m.apply(ev('1', [{ productId: 'a', quantity: 1 }, { productId: 'b', quantity: 3 }]));
  m.apply(ev('2', [{ productId: 'a', quantity: 1 }]));
  assert.strictEqual(m.apply(ev('2', [{ productId: 'a', quantity: 9 }])), false);
  assert.deepStrictEqual(m.top(2).map((r) => r.productId), ['b', 'a']);
});

test('stores no personal data from the event', () => {
  const m = createModel();
  m.apply(ev('1', [{ productId: 'a', quantity: 1 }]));
  assert.doesNotMatch(JSON.stringify(m.top(10)), /x@y\.z|"c"/);
});

test('browsing events count, but a purchase outweighs a view', () => {
  const m = createModel();
  for (let i = 0; i < 3; i++) m.apply({ eventId: `v${i}`, type: 'ProductViewed', data: { productId: 'viewed' } });
  m.apply(ev('o1', [{ productId: 'bought', quantity: 1 }]));
  assert.deepStrictEqual(m.top(2).map((r) => r.productId), ['bought', 'viewed']);
});
