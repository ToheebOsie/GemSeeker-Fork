const { Pool, types } = require('pg');
const { db } = require('../config');

/**
 * node-postgres returns BIGINT (OID 20) and NUMERIC (OID 1700) columns as
 * JS strings by default — that's a deliberate safety choice on their part
 * (a BIGINT can exceed Number.MAX_SAFE_INTEGER, and NUMERIC can hold more
 * precision than a JS double), but it's a silent behavior change from the
 * JSON stores this replaces, where every value that came out of
 * JSON.parse was always a plain JS number.
 *
 * Every price, score, percentage, and epoch-ms timestamp in this codebase
 * is used in direct arithmetic (Math.max, division for ROI multiples,
 * subtraction for time-since-X) and is comfortably within
 * Number.MAX_SAFE_INTEGER (epoch-ms doesn't overflow it until the year
 * ~287396; Telegram chat IDs don't come close either). So: force both
 * types back to plain numbers globally, once, here — this is the standard
 * fix for this exact footgun, not a workaround for something unusual.
 * Without this, e.g. `record.athPriceUsd / record.firstPriceUsd` in
 * patternReviewer.js would silently do string concatenation/coercion
 * instead of division the moment those columns came from Postgres instead
 * of JSON.
 */
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10))); // BIGINT
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val))); // NUMERIC

/**
 * Same footgun, same fix, one more type: node-postgres's default DATE
 * (OID 1082) parser turns the wire value into a JS `Date` object at UTC
 * midnight — but every DATE column in this schema (market_state_daily's
 * `date`) is written and compared as a plain 'YYYY-MM-DD' string
 * (marketStateEngine.js's `utcDateString()`), and a `Date` object
 * interpolated into a template literal renders as e.g. "Sat Aug 01 2026
 * 00:00:00 GMT+0000 (...)", not 'YYYY-MM-DD' — silently wrong the moment
 * anything displays a DATE column's value directly, and shiftable by a day
 * on a server whose local TZ isn't UTC. The raw wire value is already
 * 'YYYY-MM-DD' text before pg's parser touches it, so the fix is just: use
 * it as-is, don't parse it into a Date object at all. Found via
 * marketStateStore.js's `date` field — see /insightshistory's test, which
 * is the first place that renders a DATE column's value directly rather
 * than a separately-computed utcDateString().
 */
types.setTypeParser(1082, (val) => val); // DATE

let pool = null;
let directPool = null;

function getPool() {
  if (!pool) {
    if (!db.connectionString) {
      throw new Error('DATABASE_URL is not set — cannot connect to Postgres. See .env.example.');
    }
    pool = new Pool({
      connectionString: db.connectionString,
      ssl: db.ssl ? { rejectUnauthorized: false } : false,
      max: db.poolMax,
      connectionTimeoutMillis: db.connectionTimeoutMs,
      idleTimeoutMillis: db.idleTimeoutMs,
      statement_timeout: db.statementTimeoutMs,
      query_timeout: db.queryTimeoutMs,
      keepAlive: db.keepAlive,
      application_name: db.applicationName,
    });
    pool.on('error', (err) => {
      // Fires on a background/idle client error (e.g. connection dropped
      // by the server) — must be handled or an unhandled 'error' event
      // crashes the whole Node process, same class of bug the JSON
      // stores' write-queue code went out of its way to avoid.
      console.error(`[db] unexpected error on idle client: ${err.message}`);
    });

    // Heuristic, not authoritative: Neon's own convention is that a
    // connection string containing "-pooler" in the hostname is the
    // transaction-mode pooled endpoint, and the same string with that
    // removed is the direct one. This can't detect every transaction-mode
    // pooler out there (a hand-rolled PgBouncer wouldn't have "-pooler" in
    // its hostname at all), so it's a best-effort warning aimed at the
    // specific incident that motivated directConnectionString existing,
    // not a substitute for actually configuring it.
    if (/-pooler\./.test(db.connectionString) && !db.directConnectionString) {
      console.warn(
        '[db] DATABASE_URL looks like a pooled (transaction-mode) connection string '
        + '("-pooler" in the hostname) but DIRECT_DATABASE_URL is not set. '
        + 'src/db/advisoryLock.js will fall back to this same pooled connection for its '
        + 'session-level locks, which transaction-mode pooling does not support reliably — '
        + 'set DIRECT_DATABASE_URL to the non-pooled connection string to fix this.',
      );
    }
  }
  return pool;
}

/**
 * A separate pool, deliberately never the same object as getPool()'s,
 * for connections that need real session-level state to survive across
 * multiple statements — currently just src/db/advisoryLock.js. See
 * config.js's directConnectionString comment for why this can't just
 * reuse getPool(): a transaction-mode pooler (Neon's built-in PgBouncer,
 * Supabase's Supavisor, etc.) is free to hand the physical backend to a
 * different client between any two statements on what Node considers one
 * stable connection, silently breaking session-scoped features like
 * pg_advisory_lock/pg_advisory_unlock. Kept small (max: 4) since it's only
 * ever used for the couple of process-level locks in LOCK_IDS, never for
 * general query traffic.
 */
function getDirectPool() {
  if (!directPool) {
    const connectionString = db.directConnectionString || db.connectionString;
    directPool = new Pool({
      connectionString,
      ssl: db.ssl ? { rejectUnauthorized: false } : false,
      max: 4,
      connectionTimeoutMillis: db.connectionTimeoutMs,
      idleTimeoutMillis: db.idleTimeoutMs,
      keepAlive: db.keepAlive,
      application_name: `${db.applicationName}-direct`,
    });
    directPool.on('error', (err) => {
      console.error(`[db] unexpected error on idle direct-pool client: ${err.message}`);
    });
  }
  return directPool;
}

/**
 * Runs a single query. Thin wrapper mainly so every call site imports from
 * one place — makes it a one-line change later if query logging/metrics
 * are ever added (Phase 19's territory, not now).
 */
function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Runs `fn` inside a single transaction on a dedicated client, committing
 * on success and rolling back on any error. This is what replaces the
 * JSON stores' in-process write-queue for atomicity — e.g.
 * reserveTxSignature's check-and-insert, or extendSubscription's
 * read-compute-write. Unlike the old queue, this also protects against
 * more than one process instance, which the JSON stores' own comments
 * flagged as a known gap.
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error(`[db] rollback also failed: ${rollbackErr.message}`);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (directPool) {
    await directPool.end();
    directPool = null;
  }
}

module.exports = { getPool, getDirectPool, query, withTransaction, closePool };
