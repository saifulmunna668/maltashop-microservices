'use strict';
// Decides what happens to one event. Returns:
//   'ack'   - done (sent, duplicate, or nothing to send)
//   'retry' - temporary failure; try again later with back-off
//   'dlq'   - give up: park it in the dead letter queue and raise an alert (L4 p.84-85)
const { TEMPLATES } = require('./templates');

class PermanentError extends Error {}

function createHandler({ emailClient, dedupe, metrics, logger, maxAttempts = 4 }) {
  const m = metrics.notification;
  return async function handle(raw, attempt) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      m.deadLettered.inc({ reason: 'malformed' });
      logger.error('malformed event sent to DLQ');
      return 'dlq';
    }
    const log = logger.child({ eventId: event.eventId, correlationId: event.correlationId, type: event.type, attempt });
    const build = TEMPLATES[event.type];
    if (!build) return 'ack'; // not an event we notify on
    if (dedupe.has(event.eventId)) { m.duplicates.inc(); log.info('duplicate event skipped'); return 'ack'; }

    const to = event.data && event.data.contact && event.data.contact.email;
    if (!to) {
      m.deadLettered.inc({ reason: 'no_contact' });
      log.error('event has no contact address; sent to DLQ');
      return 'dlq';
    }

    const msg = build(event.data);
    try {
      await emailClient.send({ to, subject: msg.subject, text: msg.text, idempotencyKey: event.eventId });
      dedupe.add(event.eventId);
      m.sent.inc({ template: msg.template });
      m.lastSuccess.setToCurrentTime();
      m.endToEndLatency.observe((Date.now() - Date.parse(event.occurredAt)) / 1000);
      log.info({ template: msg.template }, 'notification sent');
      return 'ack';
    } catch (err) {
      const reason = err instanceof PermanentError ? 'rejected' : 'provider_error';
      m.failedAttempts.inc({ reason });
      if (err instanceof PermanentError || attempt >= maxAttempts) {
        m.deadLettered.inc({ reason });
        log.error({ err: err.message }, 'notification failed permanently; sent to DLQ');
        return 'dlq';
      }
      log.warn({ err: err.message }, 'notification failed; will retry');
      return 'retry';
    }
  };
}

// Bounded memory of processed event ids. Prototype simplification: a production service would
// store processed ids in its own database so de-duplication survives restarts.
function createDedupe(max = 10000) {
  const set = new Set();
  return {
    has: (id) => set.has(id),
    add: (id) => { set.add(id); if (set.size > max) set.delete(set.values().next().value); },
  };
}

module.exports = { createHandler, createDedupe, PermanentError };
