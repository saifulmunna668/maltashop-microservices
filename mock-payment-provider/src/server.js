'use strict';
const { createApp } = require('./app');

const app = createApp({
  apiKey: process.env.PSP_API_KEY,
  failureRate: Number(process.env.FAILURE_RATE || 0),
  latencyMs: Number(process.env.LATENCY_MS || 0),
});
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => console.log(JSON.stringify({ service: 'mock-payment-provider', msg: 'listening', port })));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
