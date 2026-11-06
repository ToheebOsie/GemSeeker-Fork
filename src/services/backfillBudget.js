'use strict';

class BackfillBudgetExceededError extends Error {
  constructor(kind, limit, used) {
    super(`backfill ${kind} budget exceeded: limit=${limit}, used=${used}`);
    this.name = 'BackfillBudgetExceededError';
    this.kind = kind;
    this.limit = limit;
    this.used = used;
  }
}

function finiteLimit(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative finite number`);
  return Math.floor(n);
}

function createBackfillBudget({ maxRequests = Infinity, maxElapsedMs = Infinity, maxWrites = Infinity, clock = () => Date.now() } = {}) {
  const limits = {
    requests: finiteLimit(maxRequests, 'maxRequests'),
    elapsedMs: finiteLimit(maxElapsedMs, 'maxElapsedMs'),
    writes: finiteLimit(maxWrites, 'maxWrites'),
  };
  const startedAt = clock();
  const used = { requests: 0, writes: 0 };
  function checkTime() {
    const elapsed = clock() - startedAt;
    if (elapsed > limits.elapsedMs) throw new BackfillBudgetExceededError('elapsed-ms', limits.elapsedMs, elapsed);
  }
  function consumeRequests(count = 1) {
    const n = finiteLimit(count, 'request count');
    checkTime();
    if (used.requests + n > limits.requests) throw new BackfillBudgetExceededError('requests', limits.requests, used.requests + n);
    used.requests += n;
    return used.requests;
  }
  function consumeWrites(count = 1) {
    const n = finiteLimit(count, 'write count');
    checkTime();
    if (used.writes + n > limits.writes) throw new BackfillBudgetExceededError('writes', limits.writes, used.writes + n);
    used.writes += n;
    return used.writes;
  }
  function snapshot() {
    return { ...used, elapsedMs: clock() - startedAt, limits: { ...limits } };
  }
  return { checkTime, consumeRequests, consumeWrites, snapshot };
}

module.exports = { BackfillBudgetExceededError, createBackfillBudget };
