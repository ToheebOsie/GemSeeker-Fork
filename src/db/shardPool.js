const { Pool } = require('pg');
const { db, earlyWalletShards } = require('../config');
const primary = require('./pool');

/**
 * Horizontal sharding for early_wallet_activity (item 41) — the table
 * driving Gem Seeker's storage growth once backfill-early-wallets.js
 * started running at a sig-cap high enough to actually complete walks
 * (see the session that produced this file: sig-cap=1000 pulled 20-40
 * buyer/seller rows per token instead of ~0-2, and that's what filled
 * the database).
 *
 * SHARD KEY: wallet_address, not pair_address. This isn't arbitrary —
 * it's forced by the one query this whole table exists to serve,
 * getRecurringEarlyWallets in tokenPatternStore.js:
 *
 *   SELECT wallet_address, COUNT(DISTINCT pair_address) ...
 *   FROM early_wallet_activity
 *   WHERE wallet_address = ANY($1) AND is_meaningful AND role = 'buyer'
 *   GROUP BY wallet_address
 *   HAVING COUNT(DISTINCT pair_address) >= $2
 *
 * That's a per-wallet aggregation across every launch the wallet
 * touched. Sharding by pair_address would scatter one wallet's history
 * across every shard and force a cross-shard JOIN to answer "does this
 * wallet recur" — exactly the query Stage 2/3's wallet-clustering work
 * depends on. Sharding by wallet_address keeps a wallet's full history
 * on exactly one shard, so getRecurringEarlyWallets becomes "bucket the
 * candidate wallets by shard, run the identical query per shard, concat
 * the results" — no cross-shard merge logic needed, because a wallet
 * literally cannot appear in two shards' result sets.
 *
 * The cost of that choice: queries keyed by pair_address instead of
 * wallet_address (review-early-wallet-backfill.js's COUNT(DISTINCT
 * pair_address), the test suite's "all activity for this pair" lookup)
 * have to fan out to every shard and merge in the app layer, since a
 * single token's buyers/sellers are typically scattered across several
 * shards. That's the deliberate trade-off: this table exists to answer
 * "does this wallet recur," not "who bought this token" — pattern_archive
 * and tracked_tokens already answer per-token questions, unsharded, on
 * the primary DB.
 *
 * SHARD 0 IS THE PRIMARY DB. Deliberately not a separate pool — a
 * wallet_address hashing to shard 0 lives in early_wallet_activity on
 * the same `db/pool.js` connection this codebase has always used. That
 * means: (a) with EARLY_WALLET_SHARD_URLS unset, shardCount() is 1 and
 * every wallet routes to shard 0, so behavior is byte-for-byte identical
 * to before this file existed — no migration is forced by deploying this
 * code; (b) migrating to N shards only has to move the ~(N-1)/N of rows
 * that hash to shards 1..N-1, not all of it.
 *
 * FIXED SHARD COUNT, NOT CONSISTENT HASHING. Plain `hash % N` doesn't
 * support adding a shard without reshuffling every row's assignment —
 * consistent hashing (or virtual nodes) fixes that, but it's real
 * complexity this project doesn't need yet. Given the actual shape of
 * this problem (a solo/small-team bot outgrowing one free-tier Postgres,
 * not a service elastically scaling shard count in production), a fixed
 * N chosen with headroom and a full re-shard script (see
 * scripts/migrate-early-wallet-activity-to-shards.js) if N ever needs to
 * grow is the right-sized answer — same reasoning this project already
 * applied when it chose a modular monolith over microservices.
 */

// FNV-1a, 32-bit. Not for security — just a fast, deterministic,
// well-distributed string hash with no dependency beyond what's already
// in node_modules. Must never change without a full re-shard: it's the
// only thing that decides which physical database a wallet's rows live
// in, on every process, forever, until someone deliberately migrates.
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const extraPools = [];

function getExtraPool(extraIndex) {
  if (!extraPools[extraIndex]) {
    const connectionString = earlyWalletShards.extraShardUrls[extraIndex];
    extraPools[extraIndex] = new Pool({
      connectionString,
      ssl: earlyWalletShards.ssl ? { rejectUnauthorized: false } : false,
      max: earlyWalletShards.poolMax,
      connectionTimeoutMillis: earlyWalletShards.connectionTimeoutMs,
      idleTimeoutMillis: earlyWalletShards.idleTimeoutMs,
      statement_timeout: earlyWalletShards.statementTimeoutMs,
      query_timeout: earlyWalletShards.queryTimeoutMs,
      keepAlive: earlyWalletShards.keepAlive,
      application_name: `${earlyWalletShards.applicationName}-${extraIndex + 1}`,
    });
    extraPools[extraIndex].on('error', (err) => {
      console.error(`[shardPool] unexpected error on idle client (shard ${extraIndex + 1}): ${err.message}`);
    });
  }
  return extraPools[extraIndex];
}

/**
 * Total shard count, including shard 0 (the primary DB). 1 when no
 * EARLY_WALLET_SHARD_URLS are configured — see the module comment for
 * why that's the deliberate, safe default.
 */
function shardCount() {
  return 1 + earlyWalletShards.extraShardUrls.length;
}

/**
 * Which shard index (0..shardCount()-1) owns this wallet_address. Pure
 * function of the address and the CURRENT shard count — changing shard
 * count reassigns most wallets and requires a re-shard, same caveat as
 * any mod-N hash scheme.
 *
 * @param {string} walletAddress
 * @returns {number}
 */
function shardIndexFor(walletAddress) {
  const n = shardCount();
  if (n === 1) return 0;
  return fnv1a(walletAddress) % n;
}

/**
 * Runs one query against one shard index. Shard 0 goes through the
 * existing primary pool (src/db/pool.js) so nothing about the main
 * bot's connection handling changes; shards 1..N-1 go through this
 * module's own pools.
 *
 * @param {number} shardIndex
 * @param {string} text
 * @param {Array} params
 */
function queryShard(shardIndex, text, params) {
  if (shardIndex === 0) return primary.query(text, params);
  const extraIndex = shardIndex - 1;
  if (extraIndex >= earlyWalletShards.extraShardUrls.length) {
    throw new Error(`[shardPool] shard index ${shardIndex} is out of range (shardCount=${shardCount()})`);
  }
  return getExtraPool(extraIndex).query(text, params);
}

/**
 * Fan-out helper: runs the SAME query+params against every configured
 * shard in parallel. Returns per-shard results — deliberately NOT
 * merged here, because the right way to combine them depends on the
 * query (see the module comment: distinct-wallet counts are safely
 * additive across shards, distinct-pair-address counts are not). Callers
 * combine explicitly; this just does the fan-out and keeps shard 0 in
 * the mix like any other shard.
 *
 * @param {string} text
 * @param {Array} params
 * @returns {Promise<Array<{shardIndex: number, rows: Array}>>}
 */
async function queryAllShards(text, params) {
  const n = shardCount();
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => queryShard(i, text, params).then((r) => ({ shardIndex: i, rows: r.rows }))),
  );
  return results;
}

/**
 * Buckets a list of wallet addresses by the shard that owns them.
 * Building block for any query keyed by "here's a list of wallets, tell
 * me something about each" (getRecurringEarlyWallets's exact shape) —
 * callers run one query per non-empty bucket instead of one query per
 * wallet or one blind fan-out to shards with nothing relevant.
 *
 * @param {string[]} walletAddresses
 * @returns {Map<number, string[]>} shardIndex -> wallet addresses on it
 */
function bucketByShard(walletAddresses) {
  const buckets = new Map();
  for (const addr of walletAddresses) {
    const idx = shardIndexFor(addr);
    if (!buckets.has(idx)) buckets.set(idx, []);
    buckets.get(idx).push(addr);
  }
  return buckets;
}

async function closeAllShardPools() {
  await Promise.all(extraPools.filter(Boolean).map((p) => p.end()));
  extraPools.length = 0;
}

module.exports = {
  shardCount,
  shardIndexFor,
  queryShard,
  queryAllShards,
  bucketByShard,
  closeAllShardPools,
  // exported for the migration script and smoketest only — not part of
  // the routing API other call sites should depend on
  _fnv1a: fnv1a,
};
