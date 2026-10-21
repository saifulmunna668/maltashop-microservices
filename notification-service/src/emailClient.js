'use strict';
const { fetchJson } = require('./lib/http');
const { PermanentError } = require('./handler');

// Adapter for the external email provider. Only this file knows the provider's API.
function createEmailClient({ baseUrl, apiKey, timeoutMs = 2000 }) {
  return {
    async send({ to, subject, text, idempotencyKey }) {
      const res = await fetchJson(`${baseUrl}/v1/messages`, {
        method: 'POST', timeoutMs,
        headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': idempotencyKey },
        body: { to, subject, text },
      });
      if (res.status === 202 || res.status === 200) return res.body;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentError(`email provider rejected: ${res.status}`);
      throw new Error(`email provider error: ${res.status}`);
    },
  };
}

module.exports = { createEmailClient };
