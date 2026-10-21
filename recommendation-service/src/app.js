'use strict';
const express = require('express');
const { requestContext } = require('./lib/requestContext');
const { requireInternalAuth, requireScope } = require('./lib/internalAuth');
const { healthRoutes } = require('./lib/health');

// FAULT_DELAY_MS / FAULT_ERROR_RATE let you make this service slow or broken on purpose to
// show that checkout is unaffected (L3 p.107-108 "breaking things on purpose").
function createApp({ logger, metrics, model, internalSecret, fault = { delayMs: 0, errorRate: 0 }, random = Math.random }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(logger));
  app.use(metrics.middleware);
  healthRoutes(app);
  app.get('/metrics', metrics.handler);

  app.get('/v1/recommendations', requireInternalAuth(internalSecret), requireScope('recommendations:read'), async (req, res) => {
    if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
    if (random() < fault.errorRate) return res.status(500).json({ status: 500, code: 'INJECTED_FAULT', message: 'Injected failure' });
    const limit = Math.min(Number(req.query.limit) || 4, 20);
    const exclude = req.query.exclude ? String(req.query.exclude).split(',') : [];
    return res.json({ source: 'model', data: model.top(limit, exclude) });
  });
  return app;
}
module.exports = { createApp };
