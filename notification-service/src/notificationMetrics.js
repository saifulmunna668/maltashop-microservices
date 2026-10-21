'use strict';
// Metrics chosen so that a silent notification outage is visible within minutes
// (see monitoring/alerts.yml and the Notification incident discussion in the report).
function addNotificationMetrics(metrics) {
  const { client, register } = metrics;
  metrics.notification = {
    sent: new client.Counter({ name: 'notifications_sent_total', help: 'Notifications accepted by the email provider', labelNames: ['template'], registers: [register] }),
    failedAttempts: new client.Counter({ name: 'notifications_failed_attempts_total', help: 'Failed send attempts (each retry counts)', labelNames: ['reason'], registers: [register] }),
    deadLettered: new client.Counter({ name: 'notifications_dead_lettered_total', help: 'Events parked in the DLQ', labelNames: ['reason'], registers: [register] }),
    duplicates: new client.Counter({ name: 'notifications_duplicates_skipped_total', help: 'Redelivered events skipped by de-duplication', registers: [register] }),
    lastSuccess: new client.Gauge({ name: 'notifications_last_success_timestamp_seconds', help: 'Unix time of the last successful send', registers: [register] }),
    connected: new client.Gauge({ name: 'notification_consumer_connected', help: '1 when consuming from the broker', registers: [register] }),
    endToEndLatency: new client.Histogram({ name: 'notification_end_to_end_seconds', help: 'Time from event occurrence to email accepted', buckets: [1, 5, 15, 30, 60, 300, 900], registers: [register] }),
  };
  return metrics;
}
module.exports = { addNotificationMetrics };
