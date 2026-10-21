'use strict';
const express = require('express');
const { requestContext, sendError } = require('./lib/requestContext');
const { healthRoutes } = require('./lib/health');

// HTTP side of notification-service: health, metrics and one operator endpoint.
// It is internal only (no gateway route) and the operator endpoint needs an admin token.
function createApp({ logger, metrics, consumer, adminToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(logger));
  app.use(metrics.middleware);
  healthRoutes(app, async () => ({ ok: consumer.connected(), consumer: consumer.connected() ? 'connected' : 'disconnected' }));
  app.get('/metrics', async (req, res, next) => {
    try {
      const depth = await consumer.dlqDepth().catch(() => null);
      if (depth !== null) metrics.dlqDepth.set(depth);
    } catch { /* metrics still served */ }
    return metrics.handler(req, res, next);
  });
  app.post('/internal/dlq/replay', async (req, res) => {
    if (!adminToken || req.get('authorization') !== `Bearer ${adminToken}`) return sendError(res, 401, 'UNAUTHENTICATED', 'Admin token required.');
    const moved = await consumer.replayDlq();
    req.log.warn({ moved }, 'DLQ replayed by operator');
    return res.json({ replayed: moved });
  });
  return app;
}
module.exports = { createApp };
