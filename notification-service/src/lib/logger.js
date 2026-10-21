'use strict';
// Structured JSON logs to stdout (12-Factor "Logs", L2 p.79-80; L5 p.89-90).
// Mandatory fields on every line (the platform log schema):
//   time (ISO 8601 UTC), level (label), service, version, msg
//   correlationId: on every line written while handling a request or an event
// Request lines add method, path, status and durationMs. Personal data and credentials are
// redacted before they are written (GDPR data minimisation).
const pino = require('pino');

function createLogger(service) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service, version: process.env.SERVICE_VERSION || 'dev' },
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        '*.email',
        '*.paymentToken',
        '*.contact',
        'email',
        'paymentToken',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

module.exports = { createLogger };
