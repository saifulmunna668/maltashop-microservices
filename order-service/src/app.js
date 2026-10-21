'use strict';
// Order service: owns checkout and order state, and orchestrates the place-order saga.
// Checkout path (synchronous, because the customer is waiting for the answer):
//   gateway -> order-service -> catalog-service (prices)
//                            -> inventory-service (reserve stock)          saga step 1
//                            -> payment-service -> external provider       saga step 2
// The outcome is saved together with an event in ONE local transaction (transactional outbox):
//   OrderPlaced          -> inventory confirms the reservation, notification emails the customer
//   OrderPaymentDeclined -> inventory releases the reservation (compensation), customer is told
//   OrderCancelled       -> inventory releases the reservation (compensation)
// Everything else (notifications, recommendations) reacts to events afterwards.
const express = require('express');
const { randomUUID } = require('node:crypto');
const { requestContext, sendError } = require('./lib/requestContext');
const { requireInternalAuth, requireScope } = require('./lib/internalAuth');
const { healthRoutes } = require('./lib/health');
const { buildEvent, ROUTING_KEYS } = require('./events');
const { DependencyUnavailable, OutOfStock } = require('./clients');

// Order statuses: PENDING -> PAID | PAYMENT_DECLINED | OUT_OF_STOCK | REJECTED | PAYMENT_UNCONFIRMED.
// A retry with the same Idempotency-Key resumes PENDING and PAYMENT_UNCONFIRMED orders from the
// start of the saga; every step is idempotent, so repeating a completed step changes nothing.
const RESUMABLE = ['PENDING', 'PAYMENT_UNCONFIRMED'];
const KEY_PATTERN = /^[\w-]{8,64}$/;
const PARTNER_PATTERN = /^partner-[\w-]{1,40}$/;

// Partners see only what they need: no customer identifiers or contact details (data minimisation).
const partnerView = (o) => ({ orderId: o.id, status: o.status, items: o.items, totalMinor: o.totalMinor, currency: o.currency, partnerId: o.partnerId, createdAt: o.createdAt });
const customerView = (o) => ({ orderId: o.id, status: o.status, items: o.items, totalMinor: o.totalMinor, currency: o.currency, paymentId: o.paymentId || undefined, createdAt: o.createdAt });

function createApp({ logger, metrics, repo, catalog, inventory, payments, internalSecret, readiness }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));
  app.use(requestContext(logger));
  app.use(metrics.middleware);
  healthRoutes(app, readiness || (async () => { await repo.ping(); return { ok: true }; }));
  app.get('/metrics', metrics.handler);

  const ordersTotal = new metrics.client.Counter({ name: 'orders_created_total', help: 'Checkout outcomes', labelNames: ['status'], registers: [metrics.register] });
  const auth = requireInternalAuth(internalSecret);

  function validate(body) {
    const { items, paymentToken, partnerRef } = body || {};
    if (!Array.isArray(items) || items.length < 1 || items.length > 20) return 'items must contain 1 to 20 lines.';
    for (const i of items) {
      if (typeof i.productId !== 'string' || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 10) {
        return 'each item needs productId and an integer quantity from 1 to 10.';
      }
    }
    if (typeof paymentToken !== 'string' || paymentToken.length > 100) return 'paymentToken is required.';
    if (partnerRef !== undefined && !PARTNER_PATTERN.test(partnerRef)) return 'partnerRef is not valid.';
    return null;
  }

  // Saves the final status together with the event that drives the rest of the saga.
  async function finish(req, order, status, type, paymentId) {
    const event = buildEvent(type, {
      orderId: order.id,
      customerId: order.customerId,
      partnerId: order.partnerId || null,
      items: order.items,
      totalMinor: order.totalMinor,
      currency: order.currency,
      // Needed by notification-service to send the receipt. GDPR trade-off: see the README "Known limitations".
      contact: { email: order.customerEmail },
    }, req.id);
    const saved = await repo.setStatusWithEvent(order.id, status, paymentId, { id: event.eventId, routingKey: ROUTING_KEYS[type], payload: event });
    ordersTotal.inc({ status });
    req.log.info({ orderId: order.id, status, event: type }, 'checkout finished');
    return saved;
  }

  async function runSaga(req, res, order, paymentToken) {
    // Step 1: reserve stock, so nobody pays for something that cannot be delivered.
    try {
      await inventory.reserve({ orderId: order.id, items: order.items, requestId: req.id });
    } catch (err) {
      if (err instanceof OutOfStock) {
        await repo.setStatus(order.id, 'OUT_OF_STOCK');
        ordersTotal.inc({ status: 'OUT_OF_STOCK' });
        return sendError(res, 409, 'OUT_OF_STOCK', 'Some items are out of stock.', { orderId: order.id, productIds: err.productIds });
      }
      req.log.warn({ orderId: order.id, err: err.message }, 'inventory unavailable');
      res.set('Retry-After', '5');
      return sendError(res, 503, 'INVENTORY_UNAVAILABLE', 'Stock could not be reserved. Retry with the same Idempotency-Key.', { orderId: order.id });
    }

    // Step 2: take payment.
    let result;
    try {
      result = await payments.pay({ orderId: order.id, amountMinor: order.totalMinor, currency: order.currency, paymentToken, requestId: req.id });
    } catch (err) {
      if (err.clientError) {
        // Compensation: OrderCancelled makes inventory release the reservation.
        await finish(req, order, 'REJECTED', 'OrderCancelled', null);
        return sendError(res, 422, 'PAYMENT_REJECTED', 'The payment request was rejected.', { orderId: order.id });
      }
      // Payment outcome unknown (timeout, outage or open circuit). The order and its stock
      // reservation are kept so the client can retry with the same Idempotency-Key;
      // payment-service de-duplicates. If nobody retries, the reservation expires.
      await repo.setStatus(order.id, 'PAYMENT_UNCONFIRMED');
      ordersTotal.inc({ status: 'PAYMENT_UNCONFIRMED' });
      req.log.warn({ orderId: order.id, err: err.message }, 'payment unavailable');
      res.set('Retry-After', '5');
      return sendError(res, 503, 'PAYMENT_UNAVAILABLE', 'Payment could not be confirmed. Retry with the same Idempotency-Key.', { orderId: order.id });
    }

    // Step 3: record the outcome; the event confirms or releases the reservation.
    const approved = result.status === 'APPROVED';
    const saved = await finish(req, order, approved ? 'PAID' : 'PAYMENT_DECLINED', approved ? 'OrderPlaced' : 'OrderPaymentDeclined', result.paymentId);
    if (!approved) return sendError(res, 402, 'PAYMENT_DECLINED', 'The payment was declined.', { orderId: order.id, declineCode: result.declineCode });
    return res.status(201).location(`/v1/orders/${saved.id}`).json(customerView(saved));
  }

  app.post('/v1/orders', auth, requireScope('orders:create'), async (req, res) => {
    const { principal } = req;
    if (principal.role !== 'customer') return sendError(res, 403, 'FORBIDDEN', 'Only customers can place orders.');
    const key = req.get('idempotency-key');
    if (!key || !KEY_PATTERN.test(key)) return sendError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header (8-64 chars).');
    const problem = validate(req.body);
    if (problem) return sendError(res, 400, 'INVALID_ORDER', problem);

    // A retried checkout returns the original result instead of creating a second order (L2 p.144-145).
    const existing = await repo.findByIdempotencyKey(principal.sub, key);
    if (existing) {
      if (RESUMABLE.includes(existing.status)) return runSaga(req, res, existing, req.body.paymentToken);
      return res.status(200).json(customerView(existing));
    }

    let products;
    try {
      products = await catalog.getProducts([...new Set(req.body.items.map((i) => i.productId))]);
    } catch (err) {
      req.log.warn({ err: err.message }, 'catalogue unavailable');
      return sendError(res, 503, 'CATALOG_UNAVAILABLE', 'Prices could not be confirmed. Please retry.');
    }
    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = req.body.items.filter((i) => !byId.has(i.productId)).map((i) => i.productId);
    if (missing.length) return sendError(res, 422, 'UNKNOWN_PRODUCT', 'Some products do not exist.', { productIds: missing });
    const currencies = new Set(products.map((p) => p.currency));
    if (currencies.size !== 1) return sendError(res, 422, 'MIXED_CURRENCY', 'All items must share one currency.');

    // Prices always come from the catalogue, never from the client.
    const items = req.body.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPriceMinor: byId.get(i.productId).priceMinor }));
    const order = await repo.create({
      id: randomUUID(),
      customerId: principal.sub,
      customerEmail: principal.email || null,
      partnerId: req.body.partnerRef || null,
      idempotencyKey: key,
      items,
      totalMinor: items.reduce((sum, i) => sum + i.unitPriceMinor * i.quantity, 0),
      currency: [...currencies][0],
      status: 'PENDING',
    });
    if (!order) { // lost a race with a concurrent retry of the same request
      const raced = await repo.findByIdempotencyKey(principal.sub, key);
      return res.status(200).json(customerView(raced));
    }
    return runSaga(req, res, order, req.body.paymentToken);
  });

  // Object-level authorisation: every read checks that the caller may see THIS order
  // (OWASP API Security Top 10, API1:2023). Unknown and forbidden both return 404.
  app.get('/v1/orders/:id', auth, async (req, res) => {
    const { principal } = req;
    const order = /^[0-9a-f-]{36}$/.test(req.params.id) ? await repo.findById(req.params.id) : null;
    if (order && principal.role === 'customer' && principal.scopes.includes('orders:read:self') && order.customerId === principal.sub) {
      return res.json(customerView(order));
    }
    if (order && principal.role === 'partner' && principal.scopes.includes('orders:read:partner') && order.partnerId === principal.partnerId) {
      return res.json(partnerView(order));
    }
    return sendError(res, 404, 'ORDER_NOT_FOUND', 'No such order.');
  });

  app.get('/v1/orders', auth, async (req, res) => {
    const { principal } = req;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    if (principal.role === 'customer' && principal.scopes.includes('orders:read:self')) {
      return res.json({ data: (await repo.list({ customerId: principal.sub, limit, offset })).map(customerView), limit, offset });
    }
    if (principal.role === 'partner' && principal.scopes.includes('orders:read:partner')) {
      return res.json({ data: (await repo.list({ partnerId: principal.partnerId, limit, offset })).map(partnerView), limit, offset });
    }
    return sendError(res, 403, 'FORBIDDEN', 'Not allowed to list orders.');
  });

  return app;
}

module.exports = { createApp, DependencyUnavailable };
