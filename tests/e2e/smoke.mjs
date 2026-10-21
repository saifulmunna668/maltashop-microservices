// End-to-end smoke test against a running stack (docker compose up -d).
// Usage: node tests/e2e/smoke.mjs
import { call, login, newKey, basket, waitForEmail, check, summary, INBOX, sleep, compose } from './lib.mjs';

const stockOf = async (token, id) => (await call('GET', `/api/v1/stock?ids=${id}`, { token })).body.data[0].available;
async function eventually(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(500); }
  return false;
}

const alice = await login('alice', 'alice-demo-pass');
const bob = await login('bob', 'bob-demo-pass');
check('customer login returns a token', Boolean(alice && bob));
check('wrong password is rejected', (await call('POST', '/auth/token', { body: { username: 'alice', password: 'x' } })).status === 401);
check('API call without credentials gets 401', (await call('GET', '/api/v1/products')).status === 401);

const products = await call('GET', '/api/v1/products', { token: alice });
check('customer can browse the catalogue', products.status === 200 && products.body.data.length > 0, `${products.body.data.length} products`);

const stockBefore = await stockOf(alice, 'p-1003');
const key = newKey();
const order = await call('POST', '/api/v1/orders', { token: alice, key, body: basket('tok_visa', 'partner-sliema-retail') });
check('checkout succeeds (201, PAID)', order.status === 201 && order.body.status === 'PAID', `${order.ms} ms, total ${order.body && order.body.totalMinor}`);
check('total is calculated from catalogue prices', order.body.totalMinor === 8999 + 2 * 2999);
const retry = await call('POST', '/api/v1/orders', { token: alice, key, body: basket('tok_visa', 'partner-sliema-retail') });
check('retry with same Idempotency-Key returns the same order', retry.status === 200 && retry.body.orderId === order.body.orderId);
check('saga: paid order keeps 2 units of p-1003 reserved and sold (stock -2, not -4 after the retry)', await stockOf(alice, 'p-1003') === stockBefore - 2);
check('checkout without Idempotency-Key is rejected', (await call('POST', '/api/v1/orders', { token: alice, body: basket() })).status === 400);

const beforeDecline = await stockOf(alice, 'p-1003');
const declined = await call('POST', '/api/v1/orders', { token: alice, key: newKey(), body: basket('tok_declined') });
check('declined card returns 402 PAYMENT_DECLINED', declined.status === 402 && declined.body.code === 'PAYMENT_DECLINED');
check('saga compensation: stock reserved for the declined order is released again', await eventually(async () => (await stockOf(alice, 'p-1003')) === beforeDecline));
const noStock = await call('POST', '/api/v1/orders', { token: alice, key: newKey(), body: { items: [{ productId: 'p-1008', quantity: 1 }], paymentToken: 'tok_visa' } });
check('out-of-stock item is refused before any payment (409)', noStock.status === 409 && noStock.body.code === 'OUT_OF_STOCK');
const pan = await call('POST', '/api/v1/orders', { token: alice, key: newKey(), body: basket('4111 1111 1111 1111') });
check('raw card number never reaches the provider (422)', pan.status === 422 && pan.body.code === 'PAYMENT_REJECTED');

const own = await call('GET', `/api/v1/orders/${order.body.orderId}`, { token: alice });
const other = await call('GET', `/api/v1/orders/${order.body.orderId}`, { token: bob });
check('customer can read own order', own.status === 200);
check('another customer cannot read it (404)', other.status === 404);

const sliema = await call('GET', `/api/v1/orders/${order.body.orderId}`, { apiKey: 'sliema-retail-demo-key' });
check('attributed partner can read the order', sliema.status === 200);
check('partner view has no customer personal data', sliema.body && sliema.body.customerId === undefined && !JSON.stringify(sliema.body).includes('alice'));
const gozo = await call('GET', `/api/v1/orders/${order.body.orderId}`, { apiKey: 'gozo-homeware-demo-key' });
check('partner without order scope is refused (403)', gozo.status === 403);
check('partners cannot place orders (403)', (await call('POST', '/api/v1/orders', { apiKey: 'sliema-retail-demo-key', key: newKey(), body: basket() })).status === 403);
check('unknown API key is rejected (401)', (await call('GET', '/api/v1/products', { apiKey: 'nope' })).status === 401);

const reco = await call('GET', '/api/v1/recommendations?limit=3', { token: alice });
check('recommendations respond', reco.status === 200, `source=${reco.body && reco.body.source}, ${reco.ms} ms`);
for (let i = 0; i < 6; i++) await call('GET', '/api/v1/products/p-1007', { token: bob });
check('browsing events reach the recommendation model', await eventually(async () => {
  const r = await call('GET', '/api/v1/recommendations?limit=8', { token: alice });
  return r.body && r.body.source !== 'fallback-bestsellers' && r.body.data.some((x) => x.productId === 'p-1007');
}));

const email = await waitForEmail(order.body.orderId);
check('order confirmation email delivered asynchronously', Boolean(email), email ? `inbox ${INBOX}` : 'not received');

// One correlation ID follows the order through every service it touches (brief 4.2 and 6.3).
const correlationId = order.headers.get('x-request-id');
const servicesWithId = async () => {
  const logs = compose('logs --no-color --no-log-prefix api-gateway order-service inventory-service payment-service notification-service');
  const lines = logs.split('\n').filter((l) => l.includes(`"correlationId":"${correlationId}"`));
  return new Set(lines.map((l) => { try { return JSON.parse(l).service; } catch { return null; } }).filter(Boolean));
};
let seenIn = new Set();
await eventually(async () => { seenIn = await servicesWithId(); return seenIn.size >= 5; });
check('the same correlation ID appears in the logs of all five services', seenIn.size === 5, `${correlationId}: ${[...seenIn].sort().join(', ')}`);

summary();
