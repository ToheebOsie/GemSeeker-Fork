/**
 * Generic retry-with-exponential-backoff wrapper for a single async
 * call. Built for scripts/backfill-early-wallets.js's on-chain
 * signature walk (the sig-cap timeout investigation — see that file's
 * header comment) but deliberately dependency-free and not
 * Solana-specific, since retrying a flaky async call under backoff is a
 * generic enough pattern other RPC/API call sites in this project could
 * reuse later without needing their own copy.
 *
 * Root cause this exists to fix: the signature walk made
 * getSignaturesForAddress calls with ZERO retry — a single transient
 * failure anywhere in a walk of up to --sig-cap*1000 sequential calls
 * discarded the entire row's progress and marked it 'error'. That's why
 * the error rate roughly doubled (25% -> 55%) going from sig-cap=100 to
 * sig-cap=1000 in production: with even a small, constant per-call
 * failure probability p, the odds that ALL N sequential calls succeed
 * is (1-p)^N, which collapses fast as N grows — at p=0.001, ~90% of
 * 100-call walks succeed end-to-end, but only ~37% of 1000-call walks
 * do, an order-of-magnitude difference in failure rate purely from
 * exposure, with no change in the RPC provider's actual per-call
 * reliability. A flat "wait longer between every call" doesn't fix
 * that — it doesn't reduce N, and it slows down the ~99.9% of calls that
 * were going to succeed anyway. Retrying only the calls that actually
 * fail, with backoff, is the targeted fix.
 *
 * @param {() => Promise<any>} fn - the async call to attempt
 * @param {object} [opts]
 * @param {number} [opts.retries=3] - retry attempts AFTER the first try
 *                  (so retries=3 means up to 4 total attempts)
 * @param {number} [opts.baseMs=500] - backoff base; retry k waits
 *                  baseMs * 2^(k-1) ms before firing (500, 1000, 2000ms
 *                  for the default retries=3)
 * @param {(err: Error, attempt: number) => void} [opts.onRetry] -
 *                  optional callback fired before each retry, for
 *                  callers that want to log/count retries without this
 *                  module knowing anything about their logging format
 * @returns {Promise<any>} fn()'s resolved value
 * @throws {Error} fn()'s last rejection, once retries are exhausted
 */
async function retryWithBackoff(fn, opts = {}) {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let attempt = 0;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop -- inherent to retrying: each attempt must settle before deciding whether to retry
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries) throw err;
      if (opts.onRetry) opts.onRetry(err, attempt);
      // eslint-disable-next-line no-await-in-loop -- see above
      await new Promise((resolve) => { setTimeout(resolve, baseMs * (2 ** (attempt - 1))); });
    }
  }
}

module.exports = { retryWithBackoff };
