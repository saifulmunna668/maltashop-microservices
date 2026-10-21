// Small helpers shared by the end-to-end scripts. Node 22+, no dependencies.
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

export const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:8080';
export const INBOX = process.env.INBOX_URL || 'http://127.0.0.1:8025';
export const PROMETHEUS = process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
export function summary() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

export async function call(method, path, { token, apiKey, body, key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  if (key) headers['idempotency-key'] = key;
  const started = Date.now();
  const res = await fetch(`${GATEWAY}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, headers: res.headers, ms: Date.now() - started };
}

export async function login(username, password) {
  const res = await call('POST', '/auth/token', { body: { username, password } });
  return res.body && res.body.access_token;
}

export const newKey = () => `e2e-${randomUUID()}`;
export const basket = (paymentToken = 'tok_visa', partnerRef) => ({
  items: [{ productId: 'p-1001', quantity: 1 }, { productId: 'p-1003', quantity: 2 }],
  paymentToken,
  ...(partnerRef ? { partnerRef } : {}),
});

export async function waitForEmail(orderId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${INBOX}/v1/messages`);
      const inbox = await res.json();
      const hit = inbox.data.find((m) => m.subject.includes(orderId.slice(0, 8)));
      if (hit) return hit;
    } catch { /* provider may be stopped */ }
    await sleep(500);
  }
  return null;
}

export async function promQuery(expr) {
  const res = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expr)}`);
  const json = await res.json();
  return json.data.result;
}

export async function alertState(name) {
  const res = await fetch(`${PROMETHEUS}/api/v1/alerts`);
  const json = await res.json();
  const a = json.data.alerts.find((x) => x.labels.alertname === name);
  return a ? a.state : 'inactive';
}

export const compose = (args) => execSync(`docker compose ${args}`, { cwd: new URL('../../', import.meta.url).pathname, stdio: 'pipe' }).toString();
