'use strict';
// Services do not trust the network: the gateway forwards a short-lived signed internal token
// that every service verifies again (defence in depth, "zero trust", L4 p.125-126).
const jwt = require('jsonwebtoken');
const { sendError } = require('./requestContext');

// Tokens may be issued by the gateway (for end-user calls) or by order-service (for its own
// service-to-service calls to payment-service).
const ISSUERS = ['api-gateway', 'order-service'];

function requireInternalAuth(secret) {
  if (!secret) throw new Error('INTERNAL_JWT_SECRET is required');
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return sendError(res, 401, 'UNAUTHENTICATED', 'Missing internal token.');
    try {
      req.principal = jwt.verify(token, secret, { audience: 'internal', issuer: ISSUERS, algorithms: ['HS256'] });
      return next();
    } catch {
      return sendError(res, 401, 'UNAUTHENTICATED', 'Invalid internal token.');
    }
  };
}

function requireScope(scope) {
  return (req, res, next) => {
    const scopes = (req.principal && req.principal.scopes) || [];
    if (!scopes.includes(scope)) return sendError(res, 403, 'FORBIDDEN', `Missing scope ${scope}.`);
    return next();
  };
}

module.exports = { requireInternalAuth, requireScope };
