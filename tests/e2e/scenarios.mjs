// Failure scenarios that demonstrate the architecture's resilience claims.
// Requires a running stack: docker compose up -d. Takes about 3 minutes.
// Usage: node tests/e2e/scenarios.mjs [reco|payment|broker|notification]   (default: all)
import { call, login, newKey, basket, waitForEmail, check, summary, sleep, compose, alertState, promQuery } from './lib.mjs';

const only = process.argv[2];
const run = (name) => !only || only === name;
const alice = await login('alice', 'alice-demo-pass');
const execIn = (svc, js) => compose(`exec -T ${svc} node -e "${js.replace(/"/g, '\\"')}"`).trim();
const metric = (svc, name) => {
  const text = execIn(svc, "fetch('http://127.0.0.1:3000/metrics').then(r=>r.text()).then(t=>console.log(t))");
  const line = text.split('\n').find((l) => l.startsWith(name));
  return line ? Number(line.split(' ').pop()) : NaN;
};

if (run('reco')) {
  console.log('\n--- Scenario 1: recommendation service is down ---');
  compose('stop recommendation-service');
  const order = await call('POST', '/api/v1/orders', { token: alice, key: newKey(), body: basket() });
  check('checkout still succeeds with recommendations down', order.status === 201, `${order.ms} ms`);
  const reco = await call('GET', '/api/v1/recommendations', { token: alice });
  check('recommendations fall back to bestsellers', reco.status === 200 && reco.body.source === 'fallback-bestsellers', `${reco.ms} ms`);
  compose('start recommendation-service');
}

if (run('payment')) {
  console.log('\n--- Scenario 2: external payment provider is down ---');
  compose('stop mock-payment-provider');
  const key = newKey();
  const first = await call('POST', '/api/v1/orders', { token: alice, key, body: basket() });
  check('checkout returns 503 PAYMENT_UNAVAILABLE (no false success)', first.status === 503 && first.body.code === 'PAYMENT_UNAVAILABLE', `${first.ms} ms, Retry-After=${first.headers.get('retry-after')}`);
  compose('start mock-payment-provider');
  await sleep(4000);
  const second = await call('POST', '/api/v1/orders', { token: alice, key, body: basket() });
  check('retry with the same key completes the SAME order once the provider is back', second.status === 201 && second.body.orderId === first.body.orderId);
}

if (run('broker')) {
  console.log('\n--- Scenario 3: message broker is down ---');
  compose('stop rabbitmq');
  const order = await call('POST', '/api/v1/orders', { token: alice, key: newKey(), body: basket() });
  check('checkout still succeeds while RabbitMQ is down', order.status === 201, `${order.ms} ms`);
  let pending = 0;
  for (let i = 0; i < 20 && !(pending >= 1); i += 1) { await sleep(1000); pending = metric('order-service', 'order_outbox_pending'); }
  check('OrderPlaced waits in the transactional outbox', pending >= 1, `order_outbox_pending=${pending}`);
  compose('start rabbitmq');
  const email = await waitForEmail(order.body.orderId, 90000);
  check('email is delivered after the broker recovers (nothing lost)', Boolean(email));
}

if (run('notification')) {
  console.log('\n--- Scenario 4: Notification incident (email provider outage) ---');
  compose('stop mock-email-provider');
  const order = await call('POST', '/api/v1/orders', { token: alice, key: newKey(), body: basket() });
  check('checkout is unaffected by the email outage', order.status === 201);
  let depth = 0;
  for (let i = 0; i < 40 && depth < 1; i += 1) { await sleep(1000); depth = metric('notification-service', 'notification_dlq_depth'); }
  check('after 4 failed attempts the message is parked in the DLQ', depth >= 1, `notification_dlq_depth=${depth}`);
  let state = 'inactive';
  for (let i = 0; i < 30 && state !== 'firing'; i += 1) { await sleep(5000); state = await alertState('NotificationDeadLettersPresent'); }
  check('Prometheus alert NotificationDeadLettersPresent fires', state === 'firing', `state=${state}`);
  const failed = await promQuery('sum(notifications_failed_attempts_total)');
  console.log(`      notifications_failed_attempts_total = ${failed[0] && failed[0].value[1]}`);
  compose('start mock-email-provider');
  await sleep(3000);
  const replay = execIn('notification-service', "fetch('http://127.0.0.1:3000/internal/dlq/replay',{method:'POST',headers:{authorization:'Bearer '+process.env.ADMIN_TOKEN}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))");
  check('operator replays the DLQ', JSON.parse(replay).replayed >= 1, replay);
  const email = await waitForEmail(order.body.orderId, 30000);
  check('the delayed confirmation email is delivered after replay', Boolean(email));
  check('DLQ is empty again', metric('notification-service', 'notification_dlq_depth') === 0);
}

summary();
