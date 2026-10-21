'use strict';
// Minimal circuit breaker (L4 p.25-26). After `failureThreshold` consecutive failures the
// breaker opens and calls fail fast for `resetTimeoutMs`; one trial call is then allowed
// (half-open). This stops checkout threads piling up behind a dead dependency.
class CircuitOpenError extends Error {
  constructor(name) { super(`circuit for ${name} is open`); this.name = 'CircuitOpenError'; }
}

function createCircuitBreaker({ name, failureThreshold = 5, resetTimeoutMs = 10000, now = Date.now, onStateChange = () => {} }) {
  let state = 'CLOSED';
  let failures = 0;
  let openedAt = 0;
  const setState = (s) => { if (s !== state) { state = s; onStateChange(s); } };

  async function exec(fn) {
    if (state === 'OPEN') {
      if (now() - openedAt < resetTimeoutMs) throw new CircuitOpenError(name);
      setState('HALF_OPEN');
    }
    try {
      const result = await fn();
      failures = 0;
      setState('CLOSED');
      return result;
    } catch (err) {
      failures += 1;
      if (state === 'HALF_OPEN' || failures >= failureThreshold) { openedAt = now(); setState('OPEN'); }
      throw err;
    }
  }
  return { exec, state: () => state };
}

module.exports = { createCircuitBreaker, CircuitOpenError };
