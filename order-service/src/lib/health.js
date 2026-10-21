'use strict';
// Liveness only says "the process is running"; readiness checks dependencies.
// Keeping them separate avoids restart storms when a dependency blips (L6 p.100-101).
function healthRoutes(app, readinessCheck = async () => ({ ok: true })) {
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try {
      const result = await readinessCheck();
      res.status(result.ok ? 200 : 503).json({ status: result.ok ? 'ready' : 'not-ready', ...result });
    } catch (err) {
      res.status(503).json({ status: 'not-ready', error: err.message });
    }
  });
}

module.exports = { healthRoutes };
