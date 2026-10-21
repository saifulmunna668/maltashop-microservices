'use strict';
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../src/app');

const app = createApp({ apiKey: 'k' });
const charge = (key, source = 'tok_visa') => request(app).post('/v1/charges')
  .set('authorization', 'Bearer k').set('idempotency-key', key)
  .send({ amount: 1000, currency: 'EUR', source });

test('requires the API key', async () => {
  const res = await request(app).post('/v1/charges').send({});
  assert.strictEqual(res.status, 401);
});

test('repeating a charge with the same key returns the same charge', async () => {
  const a = await charge('k1');
  const b = await charge('k1');
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.id, b.body.id);
});

test('tok_declined is declined', async () => {
  const res = await charge('k2', 'tok_declined');
  assert.strictEqual(res.status, 402);
  assert.strictEqual(res.body.failure_code, 'card_declined');
});

test('simulated outage returns 503', async () => {
  const flaky = createApp({ apiKey: 'k', failureRate: 1 });
  const res = await request(flaky).post('/v1/charges').set('authorization', 'Bearer k').set('idempotency-key', 'x').send({ amount: 1, currency: 'EUR', source: 'tok_visa' });
  assert.strictEqual(res.status, 503);
});
