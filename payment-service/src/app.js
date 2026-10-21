'use strict';
const express = require('express');
const { randomUUID } = require('node:crypto');
const { requestContext, sendError } = require('./lib/requestContext');
const { requireInternalAuth, requireScope } = require('./lib/internalAuth');
const { healthRoutes } = require('./lib/health');
const { ProviderUnavailable } = require('./providerAdapter');

// Raw card data must never enter the platform: the client app tokenises the card directly
// with the provider and sends only the token.
const PAN_PATTERN = /\b(?:\d[ -]?){13,19}\b/;
const containsCardData = (body) => {
  const keys = Object.keys(body || {}).map((k) => k.toLowerCase());
  if (keys.some((k) => ['cardnumber', 'pan', 'cvv', 'cvc'].includes(k))) return true;
  return Object.values(body || {}).some((v) => typeof v === 'string' && PAN_PATTERN.test(v));
};

function createApp({ logger, metrics, repo, provider, internalSecret, allowedCallers = ['order-service'] }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(requestContext(logger));
  app.use(metrics.middleware);
  healthRoutes(app, async () => { await repo.ping(); return { ok: true }; });
  app.get('/metrics', metrics.handler);

  const outcomes = new metrics.client.Counter({
    name: 'payments_total', help: 'Payment attempts by outcome', labelNames: ['outcome'], registers: [metrics.register],
  });

  const present = (p) => ({ paymentId: p.id, orderId: p.orderId, status: p.status, amountMinor: p.amountMinor, currency: p.currency, declineCode: p.declineCode || undefined });

  // Only checkout (order-service) may move money: authorisation by service identity (L4 p.126).
  const callerAllowed = (req, res, next) => (allowedCallers.includes(req.principal.sub)
    ? next() : sendError(res, 403, 'FORBIDDEN', 'This service may not create payments.'));

  app.post('/v1/payments', requireInternalAuth(internalSecret), requireScope('payments:create'), callerAllowed, async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key) return sendError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required.');
    if (containsCardData(req.body)) {
      outcomes.inc({ outcome: 'rejected_card_data' });
      return sendError(res, 400, 'CARD_DATA_NOT_ACCEPTED', 'Send a provider token, never card numbers.');
    }
    const { orderId, amountMinor, currency, paymentToken } = req.body || {};
    if (!orderId || !Number.isInteger(amountMinor) || amountMinor <= 0 || !/^[A-Z]{3}$/.test(currency || '') || !paymentToken) {
      return sendError(res, 400, 'INVALID_PAYMENT', 'orderId, amountMinor, currency and paymentToken are required.');
    }

    let payment = await repo.insertPending({ id: randomUUID(), idempotencyKey: key, orderId, amountMinor, currency });
    if (!payment) {
      payment = await repo.findByKey(key);
      if (payment.orderId !== orderId || payment.amountMinor !== amountMinor) {
        return sendError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This key was used for a different payment.');
      }
      if (['APPROVED', 'DECLINED'].includes(payment.status)) return res.status(200).json(present(payment)); // replay
      // PENDING/UNKNOWN: fall through and ask the provider again with the same key.
    }

    try {
      const result = await provider.charge({ idempotencyKey: key, amountMinor, currency, paymentToken });
      payment = await repo.update(payment.id, result);
      outcomes.inc({ outcome: result.status.toLowerCase() });
      req.log.info({ orderId, paymentId: payment.id, status: payment.status }, 'payment processed');
      return res.status(201).json(present(payment));
    } catch (err) {
      await repo.update(payment.id, { status: 'UNKNOWN' });
      outcomes.inc({ outcome: 'provider_unavailable' });
      req.log.warn({ orderId, err: err.message }, 'payment provider unavailable');
      const code = err instanceof ProviderUnavailable ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR';
      return sendError(res, 503, code, 'Payment provider is not responding. Retry with the same Idempotency-Key.');
    }
  });

  return app;
}

module.exports = { createApp, containsCardData };
