'use strict';
// Correlation IDs: every request carries X-Request-Id so one checkout can be followed
// across services and into the events it publishes (L4 p.127-129, L6 p.121-122).
const { randomUUID } = require('node:crypto');

function requestContext(logger) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.set('X-Request-Id', req.id);
    req.log = logger.child({ correlationId: req.id });
    const started = Date.now();
    res.on('finish', () => {
      req.log.info({ method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started }, 'request');
    });
    next();
  };
}

// RFC 9457-style problem body with a stable code, readable message and request id (L4 p.45).
function sendError(res, status, code, message, extra = {}) {
  res.status(status).json({ status, code, message, requestId: res.get('X-Request-Id'), ...extra });
}

module.exports = { requestContext, sendError };
