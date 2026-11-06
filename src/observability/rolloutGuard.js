'use strict';

const DEFAULTS = Object.freeze({
  maxGeminiInvalidRatio: 0.10,
  maxGeminiErrorRatio: 0.20,
  maxPendingQueue: 100,
  minGeminiSamples: 20,
  geminiWindowMs: 15 * 60 * 1000,
  startupGraceMs: 60 * 1000,
  alertDedupMs: 10 * 60 * 1000,
});

const emittedAt = new Map();

function boundedNumber(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function thresholds() {
  return {
    maxGeminiInvalidRatio: boundedNumber('ROLLOUT_MAX_GEMINI_INVALID_RATIO', DEFAULTS.maxGeminiInvalidRatio, 0, 1),
    maxGeminiErrorRatio: boundedNumber('ROLLOUT_MAX_GEMINI_ERROR_RATIO', DEFAULTS.maxGeminiErrorRatio, 0, 1),
    maxPendingQueue: boundedNumber('ROLLOUT_MAX_PENDING_QUEUE', DEFAULTS.maxPendingQueue, 0, Number.MAX_SAFE_INTEGER),
    minGeminiSamples: Math.floor(boundedNumber('ROLLOUT_MIN_GEMINI_SAMPLES', DEFAULTS.minGeminiSamples, 1, 1000000)),
    geminiWindowMs: boundedNumber('ROLLOUT_GEMINI_WINDOW_MS', DEFAULTS.geminiWindowMs, 1000, 7 * 24 * 60 * 60 * 1000),
    startupGraceMs: boundedNumber('ROLLOUT_STARTUP_GRACE_MS', DEFAULTS.startupGraceMs, 0, 24 * 60 * 60 * 1000),
    alertDedupMs: boundedNumber('ROLLOUT_ALERT_DEDUP_MS', DEFAULTS.alertDedupMs, 0, 7 * 24 * 60 * 60 * 1000),
  };
}

function recentCount(gemini, name, now, windowMs) {
  const timestamps = Array.isArray(gemini[name]) ? gemini[name] : null;
  if (timestamps) return timestamps.filter((t) => Number.isFinite(Date.parse(t)) && now - Date.parse(t) <= windowMs).length;
  return Number(gemini[name]) || 0;
}

function incidentKey(alert) {
  return [alert.code, alert.worker || '', alert.queue || ''].join(':');
}

function deduplicateAlerts(alerts, now, dedupMs) {
  const newAlerts = [];
  for (const alert of alerts) {
    const key = incidentKey(alert);
    const previous = emittedAt.get(key);
    const isNew = !previous || now - previous >= dedupMs;
    if (isNew) {
      emittedAt.set(key, now);
      newAlerts.push({ ...alert, incidentKey: key });
    }
  }
  for (const [key, time] of emittedAt.entries()) if (now - time > dedupMs * 2) emittedAt.delete(key);
  return { activeAlerts: alerts.map((a) => ({ ...a, incidentKey: incidentKey(a) })), newAlerts };
}

function evaluateRolloutHealth({ health = {}, gemini = {}, queues = {}, now = Date.now(), maxAgeMs, startupGraceMs, dedupMs } = {}) {
  const alerts = [];
  const limit = thresholds();
  const effectiveMaxAge = Number.isFinite(maxAgeMs) ? maxAgeMs : 120000;
  const effectiveGrace = Number.isFinite(startupGraceMs) ? startupGraceMs : limit.startupGraceMs;
  const effectiveDedup = Number.isFinite(dedupMs) ? dedupMs : limit.alertDedupMs;
  const uptimeMs = (Number(health.uptimeSeconds) || 0) * 1000;
  const requests = recentCount(gemini, 'requests_total', now, limit.geminiWindowMs);
  const invalid = recentCount(gemini, 'structured_invalid_total', now, limit.geminiWindowMs);
  const errors = recentCount(gemini, 'request_errors_total', now, limit.geminiWindowMs);
  if (requests >= limit.minGeminiSamples && invalid / requests > limit.maxGeminiInvalidRatio) alerts.push({ code: 'gemini_structured_invalid_ratio_high', severity: 'critical', value: invalid / requests, samples: requests });
  if (requests >= limit.minGeminiSamples && errors / requests > limit.maxGeminiErrorRatio) alerts.push({ code: 'gemini_request_error_ratio_high', severity: 'critical', value: errors / requests, samples: requests });
  for (const [name, worker] of Object.entries(health.workers || {})) {
    if (worker.status === 'degraded') alerts.push({ code: 'worker_degraded', severity: 'critical', worker: name });
    if (worker.status === 'starting' && uptimeMs > effectiveGrace) alerts.push({ code: 'worker_startup_timeout', severity: 'critical', worker: name, graceMs: effectiveGrace });
    const tick = worker.lastTickAt ? Date.parse(worker.lastTickAt) : null;
    if (worker.status !== 'starting' && (!tick || now - tick > effectiveMaxAge)) alerts.push({ code: 'worker_stale', severity: 'warning', worker: name, ageMs: tick ? now - tick : null });
  }
  for (const [queue, value] of Object.entries(queues)) {
    const pending = Number(value) || 0;
    if (pending > limit.maxPendingQueue) alerts.push({ code: 'queue_backlog_high', severity: 'warning', queue, value: pending });
  }
  const deduped = deduplicateAlerts(alerts, now, effectiveDedup);
  return { ok: alerts.every((a) => a.severity !== 'critical'), thresholds: limit, alerts: deduped.activeAlerts, newAlerts: deduped.newAlerts };
}

module.exports = { DEFAULTS, thresholds, evaluateRolloutHealth, deduplicateAlerts };
