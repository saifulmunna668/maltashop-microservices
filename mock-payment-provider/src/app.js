'use strict';
// Simulates the EXTERNAL payment service provider (PSP). It is not part of the platform:
// it runs on its own network and the only component allowed to call it is payment-service.
// Behaviour is driven by test tokens, in the style real PSP sandboxes use:
//   tok_visa      -> succeeded
//   tok_declined  -> card_declined
// FAILURE_RATE (0..1) and LATENCY_MS simulate an unreliable provider.
const express = require('express');
const { randomUUID } = require('node:crypto');

function createApp({ apiKey, failureRate = 0, latencyMs = 0, random = Math.random }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  const charges = new Map(); // idempotency_key -> response

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  app.post('/v1/charges', async (req, res) => {
    if (req.get('authorization') !== `Bearer ${apiKey}`) {
      return res.status(401).json({ error: { type: 'authentication_error' } });
    }
    const key = req.get('idempotency-key');
    if (!key) return res.status(400).json({ error: { type: 'invalid_request_error', message: 'Idempotency-Key required' } });
    if (charges.has(key)) return res.status(200).json(charges.get(key));

    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    if (random() < failureRate) return res.status(503).json({ error: { type: 'api_error', message: 'temporarily unavailable' } });

    const { amount, currency, source } = req.body || {};
    if (!Number.isInteger(amount) || amount <= 0 || !currency || !source) {
      return res.status(400).json({ error: { type: 'invalid_request_error' } });
    }
    const declined = source === 'tok_declined';
    const body = {
      id: `ch_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      object: 'charge',
      amount,
      currency,
      status: declined ? 'failed' : 'succeeded',
      failure_code: declined ? 'card_declined' : null,
    };
    charges.set(key, body);
    return res.status(declined ? 402 : 200).json(body);
  });

  return app;
}

module.exports = { createApp };
