'use strict';
const { buildNarrativeMarketBuckets } = require('../core/narrativeMarketOutcomeEngine');

/**
 * Aggregate snapshots for both currently tracked and archived tokens. Snapshot
 * rows are retained after archive, so filtering to tracked_tokens alone would
 * systematically lose the historical outcomes needed for validation.
 * One bounded SQL read replaces an N+1 query loop over every token.
 */
async function collectNarrativeMarketOutcomes(options = {}) {
  const now = options.now ?? Date.now();
  const bucketMinutes = options.bucketMinutes ?? 60;
  if (!Number.isFinite(bucketMinutes) || bucketMinutes <= 0) throw new TypeError('bucketMinutes must be positive');
  const bucketMs = Math.max(1, Math.floor(bucketMinutes * 60_000));
  const lookbackDays = Math.max(1, Math.min(3650, Math.floor(Number(options.lookbackDays ?? 90) || 90)));
  const sinceMs = options.sinceMs ?? (now - lookbackDays * 24 * 60 * 60 * 1000);
  const rowLimit = Math.max(1000, Math.min(500000, Math.floor(Number(options.rowLimit) || 100000)));
  const loadRows = options.getSnapshotRows || (async ({ sinceMs: querySinceMs, now: queryNow, bucketMs: queryBucketMs, rowLimit: queryRowLimit }) => {
    // The market engine uses only the latest snapshot for each pair in each
    // bucket. Deduplicate in SQL first and cap the result, rather than loading
    // every raw snapshot from a long lookback into Node memory.
    const sql = `WITH latest_per_pair_bucket AS (
         SELECT DISTINCT ON (s.pair_address, (s.t / $2::bigint))
                s.pair_address AS "pairAddress", s.t,
                s.price_usd AS "priceUsd", s.volume_1h AS "volume1h",
                s.buys_1h AS "buys1h", s.sells_1h AS "sells1h",
                COALESCE(
                  (SELECT tt.narrative_tag FROM tracked_tokens tt WHERE tt.pair_address = s.pair_address LIMIT 1),
                  (SELECT pa.narrative_tag FROM pattern_archive pa WHERE pa.pair_address = s.pair_address LIMIT 1),
                  'uncategorized'
                ) AS "narrativeTag"
           FROM snapshots s
          WHERE s.t >= $1 AND s.t <= $3 AND (
            EXISTS (SELECT 1 FROM tracked_tokens tt WHERE tt.pair_address = s.pair_address)
            OR EXISTS (SELECT 1 FROM pattern_archive pa WHERE pa.pair_address = s.pair_address)
          )
          ORDER BY s.pair_address, (s.t / $2::bigint), s.t DESC
       )
       SELECT * FROM latest_per_pair_bucket ORDER BY t DESC LIMIT $4`;
    const params = [querySinceMs, queryBucketMs, queryNow, queryRowLimit];
    const result = options.querySnapshotRowsFn
      ? await options.querySnapshotRowsFn(sql, params)
      : await require('../db/pool').query(sql, params);
    return result.rows;
  });
  const loadedRows = await loadRows({ sinceMs, now, bucketMinutes, bucketMs, rowLimit });
  const orderedRows = (loadedRows || []).slice().sort((a, b) => Number(b.t) - Number(a.t));
  const sourceRowsMayBeTruncated = orderedRows.length >= rowLimit;
  // Keep the most recent observations when an injected adapter exceeds the cap;
  // the production SQL applies the same cap at the database boundary.
  const rows = orderedRows.slice(0, rowLimit).sort((a, b) => Number(a.t) - Number(b.t));
  const tokensByPair = new Map();
  const snapshotsByPair = {};
  for (const row of rows) {
    if (!row?.pairAddress || !row?.narrativeTag || !Number.isFinite(Number(row.t))) continue;
    if (!tokensByPair.has(row.pairAddress)) tokensByPair.set(row.pairAddress, { pairAddress: row.pairAddress, narrativeTag: row.narrativeTag });
    if (!snapshotsByPair[row.pairAddress]) snapshotsByPair[row.pairAddress] = [];
    snapshotsByPair[row.pairAddress].push({
      t: Number(row.t), priceUsd: row.priceUsd, volume1h: row.volume1h,
      buys1h: row.buys1h, sells1h: row.sells1h,
    });
  }
  const buckets = buildNarrativeMarketBuckets([...tokensByPair.values()], snapshotsByPair, { bucketMinutes })
    .filter((bucket) => bucket.bucketAt <= now);
  const targetStore = options.store || require('../storage/narrativeMarketOutcomeStore');
  for (const bucket of buckets) await targetStore.upsertBucket(bucket);
  return {
    tokenCount: tokensByPair.size,
    snapshotCount: rows.length,
    sourceRowLimit: rowLimit,
    sourceRowsMayBeTruncated,
    bucketCount: buckets.length,
    buckets,
    lookbackDays,
    sinceMs,
  };
}
module.exports = { collectNarrativeMarketOutcomes };
