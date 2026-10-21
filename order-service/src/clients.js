'use strict';
// Synchronous dependencies of checkout. Only three, each genuinely needed before the customer
// can be told the result: current prices (catalogue), a stock reservation (inventory) and the
// payment decision (payment).
// The recommendation service is deliberately NOT here: checkout never waits for it.
const jwt = require('jsonwebtoken');
const { fetchJson, withRetry } = require('./lib/http');

class DependencyUnavailable extends Error {}
class OutOfStock extends Error {
  constructor(productIds) { super('out of stock'); this.productIds = productIds; }
}

function serviceToken(secret) {
  // order-service's own identity for service-to-service calls (short-lived).
  return jwt.sign({ sub: 'order-service', role: 'service', scopes: ['catalog:read', 'inventory:reserve', 'payments:create'] }, secret,
    { audience: 'internal', issuer: 'order-service', expiresIn: 60, algorithm: 'HS256' });
}

function createCatalogClient({ baseUrl, secret, timeoutMs = 800 }) {
  return {
    async getProducts(ids) {
      const call = async () => {
        try {
          const res = await fetchJson(`${baseUrl}/v1/products?ids=${encodeURIComponent(ids.join(','))}`,
            { timeoutMs, headers: { authorization: `Bearer ${serviceToken(secret)}` } });
          if (res.status !== 200) throw new DependencyUnavailable(`catalog ${res.status}`);
          return res.body.data;
        } catch (err) {
          throw err instanceof DependencyUnavailable ? err : new DependencyUnavailable(`catalog ${err.name}`);
        }
      };
      return withRetry(call, { retries: 1, baseDelayMs: 100 }); // GET is idempotent: safe to retry
    },
  };
}

function createInventoryClient({ baseUrl, secret, timeoutMs = 800 }) {
  return {
    // Saga step 1. The reservation id is derived from the order id, so retrying this POST (or the
    // whole checkout) can never reserve the same order's stock twice: it is safe to retry.
    async reserve({ orderId, items, requestId }) {
      const call = async () => {
        let res;
        try {
          res = await fetchJson(`${baseUrl}/v1/reservations`, {
            method: 'POST',
            timeoutMs,
            headers: { authorization: `Bearer ${serviceToken(secret)}`, 'x-request-id': requestId },
            body: { reservationId: `order-${orderId}`, items: items.map(({ productId, quantity }) => ({ productId, quantity })) },
          });
        } catch (err) {
          throw new DependencyUnavailable(`inventory ${err.name}`);
        }
        if (res.status === 409) throw new OutOfStock(res.body.productIds || []);
        if (res.status !== 200 && res.status !== 201) throw new DependencyUnavailable(`inventory ${res.status}`);
        return res.body; // { id, status: RESERVED | CONFIRMED, expiresAt }
      };
      return withRetry(call, { retries: 1, baseDelayMs: 100, shouldRetry: (e) => e instanceof DependencyUnavailable });
    },
  };
}

function createPaymentClient({ baseUrl, secret, breaker, timeoutMs = 5000 }) {
  return {
    async pay({ orderId, amountMinor, currency, paymentToken, requestId }) {
      return breaker.exec(async () => {
        let res;
        try {
          res = await fetchJson(`${baseUrl}/v1/payments`, {
            method: 'POST',
            timeoutMs,
            // The order id is the idempotency key, so a retried checkout can never pay twice.
            headers: { authorization: `Bearer ${serviceToken(secret)}`, 'idempotency-key': `order-${orderId}`, 'x-request-id': requestId },
            body: { orderId, amountMinor, currency, paymentToken },
          });
        } catch (err) {
          throw new DependencyUnavailable(`payment ${err.name}`);
        }
        if (res.status >= 500) throw new DependencyUnavailable(`payment ${res.status}`);
        if (res.status >= 400) {
          const e = new Error(`payment rejected request: ${res.body && res.body.code}`);
          e.clientError = true;
          throw e;
        }
        return res.body; // { paymentId, status: APPROVED | DECLINED, declineCode }
      });
    },
  };
}

module.exports = { createCatalogClient, createInventoryClient, createPaymentClient, DependencyUnavailable, OutOfStock };
