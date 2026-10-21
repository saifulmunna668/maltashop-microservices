'use strict';
const amqp = require('amqplib');
const { createApp } = require('./app');
const { createModel } = require('./model');
const { createLogger } = require('./lib/logger');
const { createMetrics } = require('./lib/metrics');

const logger = createLogger('recommendation-service');
const metrics = createMetrics('recommendation-service');
const applied = new metrics.client.Counter({ name: 'recommendation_events_applied_total', help: 'OrderPlaced and ProductViewed events applied to the model', registers: [metrics.register] });
const model = createModel();

// Consumes OrderPlaced and ProductViewed asynchronously. If this service is down, events wait in its own queue;
// nothing upstream (checkout) is affected.
async function consume() {
  try {
    const conn = await amqp.connect(process.env.AMQP_URL);
    const ch = await conn.createChannel();
    await ch.assertExchange('platform.events', 'topic', { durable: true });
    // A bounded queue: if the model falls behind, the oldest browsing signals are dropped rather
    // than growing without limit. Checkout never waits on this queue.
    await ch.assertQueue('recommendation.events', { durable: true, arguments: { 'x-max-length': 100000 } });
    await ch.bindQueue('recommendation.events', 'platform.events', 'order.placed');
    await ch.bindQueue('recommendation.events', 'platform.events', 'product.viewed');
    await ch.prefetch(50);
    conn.on('close', () => { logger.warn('broker connection lost; reconnecting'); setTimeout(consume, 2000); });
    conn.on('error', () => {});
    await ch.consume('recommendation.events', (msg) => {
      try {
        if (model.apply(JSON.parse(msg.content.toString()))) applied.inc();
      } catch (err) {
        logger.warn({ err: err.message }, 'skipping unreadable event'); // derived data: safe to drop
      }
      ch.ack(msg);
    });
    logger.info('consuming order.placed and product.viewed');
  } catch (err) {
    logger.warn({ err: err.message }, 'broker not reachable; retrying');
    setTimeout(consume, 2000);
  }
}

const app = createApp({
  logger, metrics, model, internalSecret: process.env.INTERNAL_JWT_SECRET,
  fault: { delayMs: Number(process.env.FAULT_DELAY_MS || 0), errorRate: Number(process.env.FAULT_ERROR_RATE || 0) },
});
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => logger.info({ port }, 'recommendation-service listening'));
consume();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
