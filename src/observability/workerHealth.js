'use strict';

const startedAt = Date.now();
const state = new Map();

function ensureWorker(name) {
  if (!state.has(name)) {
    state.set(name, {
      status: 'starting',
      lastTickAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      counters: {},
    });
  }
  return state.get(name);
}

function markStarted(name) {
  ensureWorker(name).status = 'running';
}

function markTick(name) {
  const worker = ensureWorker(name);
  worker.status = 'running';
  worker.lastTickAt = new Date().toISOString();
}

function markSuccess(name, counter = null) {
  const worker = ensureWorker(name);
  worker.status = 'running';
  worker.lastSuccessAt = new Date().toISOString();
  if (counter) worker.counters[counter] = (worker.counters[counter] || 0) + 1;
}

function markError(name, error, counter = 'errors_total') {
  const worker = ensureWorker(name);
  worker.status = 'degraded';
  worker.lastErrorAt = new Date().toISOString();
  worker.lastError = String(error?.message || error || 'unknown error').slice(0, 500);
  worker.counters[counter] = (worker.counters[counter] || 0) + 1;
}

function snapshot() {
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    workers: Object.fromEntries(state.entries()),
  };
}

function isReady(requiredWorkers = []) {
  return requiredWorkers.every((name) => {
    const worker = state.get(name);
    return worker && worker.status !== 'starting';
  });
}

function prometheus() {
  const lines = [
    '# HELP gemseeker_process_uptime_seconds Process uptime in seconds.',
    '# TYPE gemseeker_process_uptime_seconds gauge',
    `gemseeker_process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
  ];
  for (const [name, worker] of state.entries()) {
    const label = name.replace(/[^a-zA-Z0-9_]/g, '_');
    lines.push(`# TYPE gemseeker_worker_status gauge`);
    lines.push(`gemseeker_worker_status{worker="${label}",status="${worker.status}"} 1`);
    for (const [counter, value] of Object.entries(worker.counters)) {
      lines.push(`gemseeker_worker_${counter}{worker="${label}"} ${value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { ensureWorker, markStarted, markTick, markSuccess, markError, snapshot, isReady, prometheus };
