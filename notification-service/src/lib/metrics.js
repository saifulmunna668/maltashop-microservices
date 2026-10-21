'use strict';
// Prometheus metrics: request rate, errors and latency for every route (L6 p.121-122).
const client = require('prom-client');

function createMetrics(service) {
  const register = new client.Registry();
  register.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register],
  });

  function middleware(req, res, next) {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  }

  async function handler(_req, res) {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  }

  return { client, register, middleware, handler };
}

module.exports = { createMetrics };
