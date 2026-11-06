const { getDirectPool } = require('./pool');

/**
 * Fixed, arbitrary-but-stable lock IDs for pg_try_advisory_lock. One per
 * thing that must never run concurrently across more than one process —
 * NOT per-tick, per-token, or per-pair; this guards "is another whole
 * process already mid-cycle," not row-level contention (that's what
 * FOR UPDATE SKIP LOCKED / ON CONFLICT are for elsewhere in this
 * codebase, e.g. outboxStore.js's claimConsumerEvent). Keep this list
 * short and add a new distinct constant — never reuse one — if another
 * process-level singleton section needs the same protection.
 */
const LOCK_IDS = {
  SCAN_LOOP: 7501001,
  PATTERN_REVIEW_LOOP: 7501002,
};

/**
 * Runs `fn` only if this process can acquire the named session-level
 * advisory lock; otherwise skips `fn` entirely and returns
 * { skipped: true }. Non-blocking (pg_try_advisory_lock returns
 * immediately either way) — this is a "let exactly one instance work per
 * cycle" guard, not a queue, so a process that loses the race doesn't
 * wait around, it just sits out this cycle and tries again next tick.
 *
 * WHY THIS EXISTS: startPatternReviewLoop's `running` flag and
 * tokenScanner's alertedPairs/dbAlertedPairs check are both correct
 * within a single process, but neither protects against a second whole
 * process (an accidental duplicate Railway Service, or two replicas of
 * what's meant to be a singleton, or a brief overlap during a deploy)
 * running the same cycle concurrently against the same database — see
 * HANDOFF.md's "duplicate Railway service" incident and its follow-up.
 * This closes that gap at the process level, independent of whatever
 * caused there to be two processes in the first place; it's a safety
 * net, not a substitute for fixing the Railway config.
 *
 * WHY A DEDICATED CLIENT, FROM A DEDICATED DIRECT (NON-POOLED) POOL:
 * pg_advisory_lock/unlock are tied to the specific database SESSION
 * (physical backend connection) that acquired them, not to the query.
 * Calling the pool's shared `query()` helper for acquire and again for
 * release would very likely run each call on a DIFFERENT pooled
 * connection, so the unlock would silently affect nothing
 * (pg_advisory_unlock just returns false if the current session doesn't
 * hold the lock) and the lock would stay held by the original
 * connection — indefinitely, until that connection happens to close.
 * Checking out one client via pool.connect() and using it for both the
 * lock and the unlock (in a try/finally) is the standard safe pattern —
 * but it is NOT sufficient on its own if that pool talks to a
 * transaction-mode connection pooler (Neon's built-in PgBouncer,
 * Supabase's Supavisor, plain PgBouncer in transaction mode, etc.).
 * AUDIT FIX: this originally called getPool() — the same shared pool
 * every other query in this codebase uses. In production that pool is
 * configured against Neon's "-pooler" hostname, which runs PgBouncer in
 * transaction mode: the physical backend can be handed back to the pool
 * (and reused by a completely different logical client) between ANY two
 * statements, even two statements sent back-to-back on what Node
 * considers one stable, held client connection — because from the
 * pooler's point of view, each bare autocommit statement is its own
 * transaction, and transaction-mode pooling's whole point is to not
 * guarantee the same backend across transaction boundaries. So the
 * "acquire" and "unlock" calls below, despite sharing one node-postgres
 * Client object, could each land on a different real Postgres session —
 * silently defeating this entire lock with no error anywhere. Confirmed
 * this was happening in production: duplicate archive/alert rows kept
 * appearing in pairs 2-9 seconds apart, continuously, for days after
 * this lock was deployed — consistent with the lock providing near-zero
 * real protection over a pooled connection, not with an occasional
 * redeploy-overlap race. Fixed by sourcing the client from
 * getDirectPool() (see pool.js), a separate pool pointed at
 * DIRECT_DATABASE_URL — a real, non-pooled connection where session
 * state genuinely persists across statements on one client.
 *
 * This deliberately does NOT wrap `fn` in a transaction or route its
 * queries through this dedicated client — `fn` is a whole review/scan
 * cycle that does many independent queries plus slow external API calls
 * (Rugcheck, Gemini, Helius), and holding one long transaction open
 * across all of that would be its own problem (lock bloat, replication
 * lag). `fn` keeps using the shared pool exactly as it does today; this
 * helper only holds one extra "coordinator" connection for the cycle's
 * duration, purely to hold the advisory lock.
 *
 * If a process holding the lock crashes or its connection drops for any
 * reason, Postgres releases session-level advisory locks automatically
 * when the session ends — no separate cleanup/expiry logic needed here.
 *
 * Fails CLOSED on any error acquiring the lock (logs and returns
 * { skipped: true } rather than proceeding): unlike some other
 * best-effort dedup layers in this codebase that intentionally fail
 * open (e.g. tokenScanner.js's dbAlertedPairs read, which is a backstop
 * on top of an in-memory Set), this lock IS the primary defense against
 * the multi-process case, so silently proceeding without it on a DB
 * hiccup would defeat the whole point — and a skipped cycle just tries
 * again next tick, which is cheap.
 *
 * @param {number} lockId - one of LOCK_IDS' values
 * @param {() => Promise<any>} fn
 * @returns {Promise<{skipped: boolean, result?: any}>}
 */
async function withAdvisoryLock(lockId, fn) {
  let client;
  try {
    client = await getDirectPool().connect();
  } catch (err) {
    console.error(`[advisoryLock] failed to check out a connection for lock ${lockId}: ${err.message}`);
    return { skipped: true };
  }

  try {
    let acquired;
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockId]);
      acquired = rows[0].acquired;
    } catch (err) {
      console.error(`[advisoryLock] failed to acquire lock ${lockId}: ${err.message}`);
      return { skipped: true };
    }

    if (!acquired) {
      return { skipped: true };
    }

    try {
      const result = await fn();
      return { skipped: false, result };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
      } catch (err) {
        // The connection is about to be released back to the pool either
        // way (see outer finally) — an unlock failure here just means
        // Postgres will clear the lock itself once this connection
        // closes/resets, per the crash-safety note above. Logged, not
        // fatal.
        console.error(`[advisoryLock] failed to release lock ${lockId}: ${err.message}`);
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { withAdvisoryLock, LOCK_IDS };
