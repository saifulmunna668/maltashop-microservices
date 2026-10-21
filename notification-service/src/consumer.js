'use strict';
// RabbitMQ wiring for notification-service.
//   platform.events (topic) --order.placed / order.payment_declined--> notification.order-events
//   failure  -> notification.retry  (TTL back-off, then dead-letters back to the main queue)
//   give up  -> notification.dlq    (kept 7 days, alert when not empty)
const amqp = require('amqplib');

const EXCHANGE = 'platform.events';
const QUEUE = 'notification.order-events';
const RETRY_QUEUE = 'notification.retry';
const DLQ = 'notification.dlq';
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

async function setupTopology(ch, retryDelayMs) {
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
  await ch.assertQueue(QUEUE, { durable: true });
  await ch.bindQueue(QUEUE, EXCHANGE, 'order.placed');
  await ch.bindQueue(QUEUE, EXCHANGE, 'order.payment_declined');
  await ch.assertQueue(RETRY_QUEUE, {
    durable: true,
    arguments: { 'x-message-ttl': retryDelayMs, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': QUEUE },
  });
  // Storage limitation (GDPR Art. 5(1)(e)): parked messages contain an email address, so they expire.
  await ch.assertQueue(DLQ, { durable: true, arguments: { 'x-message-ttl': SEVEN_DAYS_MS } });
}

function startConsumer({ url, handle, logger, metrics, prefetch = 10, retryDelayMs = 5000 }) {
  let conn = null;
  let ch = null;
  let stopped = false;

  async function run() {
    try {
      conn = await amqp.connect(url);
      ch = await conn.createConfirmChannel();
      await setupTopology(ch, retryDelayMs);
      await ch.prefetch(prefetch);
      metrics.notification.connected.set(1);
      logger.info({ queue: QUEUE }, 'consuming');
      conn.on('close', () => {
        ch = null;
        metrics.notification.connected.set(0);
        if (!stopped) { logger.warn('broker connection lost; reconnecting'); setTimeout(run, 2000); }
      });
      conn.on('error', (err) => logger.warn({ err: err.message }, 'broker error'));

      await ch.consume(QUEUE, async (msg) => {
        if (!msg) return;
        const attempt = Number((msg.properties.headers || {})['x-attempt'] || 1);
        const outcome = await handle(msg.content.toString(), attempt);
        const props = { persistent: true, contentType: 'application/json', messageId: msg.properties.messageId, headers: { ...msg.properties.headers } };
        try {
          if (outcome === 'retry') {
            props.headers['x-attempt'] = attempt + 1;
            await publishConfirmed(ch, RETRY_QUEUE, msg.content, props);
          } else if (outcome === 'dlq') {
            props.headers['x-failed-at'] = new Date().toISOString();
            await publishConfirmed(ch, DLQ, msg.content, props);
          }
          ch.ack(msg); // only after the retry/DLQ copy is safely stored
        } catch (err) {
          logger.error({ err: err.message }, 'could not route failed message; requeueing');
          ch.nack(msg, false, true);
        }
      });
    } catch (err) {
      metrics.notification.connected.set(0);
      logger.warn({ err: err.message }, 'broker not reachable; retrying');
      if (!stopped) setTimeout(run, 2000);
    }
  }

  function publishConfirmed(channel, queue, content, props) {
    return new Promise((resolve, reject) => channel.sendToQueue(queue, content, props, (err) => (err ? reject(err) : resolve())));
  }

  // Operator action after an incident: move parked messages back for another try.
  async function replayDlq(max = 1000) {
    if (!ch) throw new Error('not connected');
    let moved = 0;
    for (; moved < max; moved += 1) {
      const msg = await ch.get(DLQ, { noAck: false });
      if (!msg) break;
      const headers = { ...msg.properties.headers, 'x-attempt': 1, 'x-replayed': true };
      await publishConfirmed(ch, QUEUE, msg.content, { persistent: true, contentType: 'application/json', messageId: msg.properties.messageId, headers });
      ch.ack(msg);
    }
    return moved;
  }

  async function dlqDepth() {
    if (!ch) return null;
    const q = await ch.checkQueue(DLQ);
    return q.messageCount;
  }

  run();
  return {
    connected: () => ch !== null,
    replayDlq,
    dlqDepth,
    async stop() { stopped = true; if (conn) await conn.close().catch(() => {}); },
  };
}

module.exports = { startConsumer, QUEUE, RETRY_QUEUE, DLQ };
