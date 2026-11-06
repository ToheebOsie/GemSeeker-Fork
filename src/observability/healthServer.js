'use strict';

const http = require('http');
const health = require('./workerHealth');
const geminiTelemetry = require('./geminiTelemetry');
const { evaluateRolloutHealth } = require('./rolloutGuard');
const { query } = require('../db/pool');
const shadowMetrics = require('./shadowMetrics');

async function getQueueCounts() {
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM research_jobs WHERE status IN ('pending', 'failed'))::int AS research_jobs,
      (SELECT count(*) FROM notification_jobs WHERE status IN ('pending', 'failed'))::int AS notification_jobs,
      (SELECT count(*) FROM outbox_events WHERE status IN ('pending', 'failed'))::int AS outbox_events`);
  return rows[0] || {};
}

function startHealthServer({ port = Number(process.env.HEALTH_PORT || 8080), requiredWorkers = [] } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...health.snapshot(), gemini: geminiTelemetry.snapshot() }));
      return;
    }
    if (req.url === '/readyz') {
      const ready = health.isReady(requiredWorkers);
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready, requiredWorkers, ...health.snapshot(), gemini: geminiTelemetry.snapshot() }));
      return;
    }
    if (req.url === '/alerts') {
      const snapshot = health.snapshot();
      let queues = {};
      let databaseAlert = null;
      try {
        queues = await getQueueCounts();
      } catch (err) {
        databaseAlert = { code: 'queue_metrics_unavailable', severity: 'critical', error: String(err.message).slice(0, 200) };
      }
      const evaluation = evaluateRolloutHealth({ health: snapshot, gemini: geminiTelemetry.snapshot(), queues });
      if (databaseAlert) {
        evaluation.alerts.push(databaseAlert);
        evaluation.newAlerts.push(databaseAlert);
        evaluation.ok = false;
      }
      res.writeHead(evaluation.ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...evaluation, queues }));
      return;
    }
    if (req.url === '/shadow-metrics') {
      try {
        const metrics = await shadowMetrics.getShadowMetrics();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ generatedAt: new Date().toISOString(), ...metrics }));
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'shadow_metrics_unavailable', message: String(err.message).slice(0, 200) }));
      }
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(`${health.prometheus()}${geminiTelemetry.prometheus()}`);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(port, '0.0.0.0');
  return server;
}

module.exports = { startHealthServer, getQueueCounts };
