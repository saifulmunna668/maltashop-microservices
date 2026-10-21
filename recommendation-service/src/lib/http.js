'use strict';
// Outbound HTTP with a hard timeout (L4 p.25). Retries are applied only by callers whose
// request is idempotent (L4 p.41-42).
async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 1000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { retries = 2, baseDelayMs = 200, shouldRetry = () => true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) break;
      await sleep(baseDelayMs * 2 ** attempt); // exponential back-off: 200 ms, 400 ms, ...
    }
  }
  throw lastErr;
}

module.exports = { fetchJson, withRetry, sleep };
