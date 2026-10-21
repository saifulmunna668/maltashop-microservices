'use strict';
// Event envelope shared by every event the platform publishes. Events are facts in the
// past tense (L4 p.93-94). eventId lets consumers de-duplicate (at-least-once delivery).
const { randomUUID } = require('node:crypto');

const ROUTING_KEYS = {
  OrderPlaced: 'order.placed',
  OrderPaymentDeclined: 'order.payment_declined',
  OrderCancelled: 'order.cancelled',
};

function buildEvent(type, data, correlationId) {
  return {
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId,
    data,
  };
}

module.exports = { buildEvent, ROUTING_KEYS };
