'use strict';
const { buildNarrativeWalletBuckets } = require('../core/narrativeWalletParticipation');

function boundedRowLimit(value) {
  return Math.max(1000, Math.min(500000, Math.floor(Number(value) || 100000)));
}

async function loadShardedWalletRows({ sinceMs, now, rowLimit, queryAllShardsFn = null, queryPairTagsFn = null }) {
  const shardPool = queryAllShardsFn ? null : require('../db/shardPool');
  const queryAllShards = queryAllShardsFn || shardPool.queryAllShards.bind(shardPool);
  const queryPairTags = queryPairTagsFn || ((sql, params) => require('../db/pool').query(sql, params));
  // early_wallet_activity is sharded by wallet_address. Extra shards contain
  // only that table, so narrative joins must happen on the primary DB after
  // the bounded per-shard reads, not inside the shard query.
  const perShard = await queryAllShards(
    `SELECT wallet_address AS "walletAddress", role,
            is_meaningful AS "isMeaningful", value_sol AS "valueSol",
            economic_confidence AS "economicConfidence", block_time AS "blockTime",
            pair_address AS "pairAddress"
       FROM early_wallet_activity
      WHERE block_time >= $1 AND block_time <= $2
      ORDER BY block_time DESC
      LIMIT $3`,
    [Math.floor(sinceMs), Math.floor(now), rowLimit],
  );
  const shardRows = perShard.flatMap((shard) => shard.rows || []);
  const shardLimitReached = perShard.some((shard) => (shard.rows || []).length >= rowLimit);
  // Global cap selects the newest transaction-time rows across all shards.
  // This is bounded even with multiple configured shards; truncation is
  // surfaced below rather than silently presented as complete coverage.
  shardRows.sort((a, b) => Number(b.blockTime) - Number(a.blockTime));
  const globallyTruncated = shardRows.length > rowLimit;
  const selected = shardRows.slice(0, rowLimit);
  const pairAddresses = [...new Set(selected.map((row) => row.pairAddress).filter(Boolean).map(String))];
  if (pairAddresses.length === 0) {
    return { rows: [], rowsFetchedAcrossShards: shardRows.length, shardLimitReached, globallyTruncated };
  }
  const tagsResult = await queryPairTags(
    `WITH candidates AS (
       SELECT pair_address, narrative_tag, 1 AS priority, NULL AS archive_time
         FROM tracked_tokens WHERE pair_address = ANY($1::text[])
       UNION ALL
       SELECT pair_address, narrative_tag, 0 AS priority, archived_at AS archive_time
         FROM pattern_archive WHERE pair_address = ANY($1::text[])
     ), ranked AS (
       SELECT pair_address, narrative_tag,
              row_number() OVER (
                PARTITION BY pair_address ORDER BY priority DESC, archive_time DESC NULLS LAST
              ) AS rn
         FROM candidates
     )
     SELECT pair_address, narrative_tag FROM ranked WHERE rn = 1`,
    [pairAddresses],
  );
  const tagByPair = new Map(tagsResult.rows.map((row) => [String(row.pair_address), row.narrative_tag]));
  const rows = selected.map((row) => ({
    ...row,
    narrativeTag: tagByPair.get(String(row.pairAddress)) ?? null,
  })).filter((row) => row.narrativeTag);
  return { rows, rowsFetchedAcrossShards: shardRows.length, shardLimitReached, globallyTruncated };
}

async function collectNarrativeWalletParticipation(options = {}) {
  const now = options.now ?? Date.now();
  const lookbackDays = Math.max(1, Math.min(3650, Math.floor(Number(options.lookbackDays ?? 30) || 30)));
  const sinceMs = options.sinceMs ?? now - lookbackDays * 24 * 60 * 60 * 1000;
  const rowLimit = boundedRowLimit(options.rowLimit);
  let loaded;
  if (typeof options.getWalletRows === 'function') {
    const rows = await options.getWalletRows({ sinceMs, now, rowLimit });
    loaded = { rows, rowsFetchedAcrossShards: rows.length, shardLimitReached: false, globallyTruncated: rows.length > rowLimit };
  } else {
    loaded = await loadShardedWalletRows({ sinceMs, now, rowLimit, queryAllShardsFn: options.queryAllShardsFn, queryPairTagsFn: options.queryPairTagsFn });
  }
  const rows = (loaded.rows || []).slice().sort((a, b) => Number(a.blockTime ?? a.block_time) - Number(b.blockTime ?? b.block_time));
  const buckets = buildNarrativeWalletBuckets(rows, { bucketMinutes: options.bucketMinutes ?? 60 });
  return {
    sourceRowsRead: rows.length,
    sourceRowsFetchedAcrossShards: loaded.rowsFetchedAcrossShards,
    sourceRowLimit: rowLimit,
    sourceRowsMayBeTruncated: loaded.shardLimitReached || loaded.globallyTruncated || rows.length >= rowLimit,
    sourceShardLimitReached: loaded.shardLimitReached,
    narrativeCount: new Set(buckets.map((r) => r.narrativeTag)).size,
    bucketCount: buckets.length,
    lookbackDays,
    sinceMs,
    buckets,
    caveat: 'Reads recent transaction-time rows from every configured early-wallet shard, then joins pair addresses to narrative tags on the primary database. A reached row cap means the sample may be incomplete. Rows without block_time or a known narrative tag are excluded; value_sol coverage may be incomplete, and recorded early-wallet activity is not all market participation or total capital flow.',
  };
}
module.exports = { collectNarrativeWalletParticipation, loadShardedWalletRows, boundedRowLimit };
