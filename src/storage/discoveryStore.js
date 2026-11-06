'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

// Single source of truth for the INSERT's column list AND its per-row value
// width (see the POST-AUDIT FIX note in recordDiscoveries).
const INSERT_COLUMNS = [
  'discovery_id', 'source', 'chain', 'mint_address', 'pair_address', 'symbol', 'name',
  'first_seen_at', 'last_seen_at', 'discovery_volume_1h_usd',
  'discovery_total_volume_usd', 'discovery_threshold', 'filter_version', 'provider_path',
];

/**
 * Persistent provenance for production discovery. Rejected candidates retain
 * discovery history here; qualified candidates also carry the same
 * provenance in their immutable feature_snapshot.
 */
async function recordDiscoveries(candidates, seenAt = new Date()) {
  const rows = [];
  for (const candidate of candidates || []) {
    const sourceCandidates = candidate?.sourceCandidates || {};
    for (const [source, sourceCandidate] of Object.entries(sourceCandidates)) {
      const discovery = sourceCandidate?.discovery;
      if (!discovery || !sourceCandidate.pairAddress || !sourceCandidate.baseToken?.address) continue;
      rows.push({
        discoveryId: crypto.randomUUID(),
        source,
        chain: 'solana',
        mintAddress: sourceCandidate.baseToken.address,
        pairAddress: sourceCandidate.pairAddress,
        symbol: sourceCandidate.baseToken.symbol || null,
        name: sourceCandidate.baseToken.name || null,
        seenAt,
        discoveryVolume1hUsd: discovery.discoveryVolume1hUsd ?? null,
        discoveryTotalVolumeUsd: discovery.discoveryTotalVolumeUsd ?? null,
        threshold: discovery.discoveryThresholdUsd || null,
        filterVersion: discovery.filterVersion || null,
        providerPath: discovery.providerPath || null,
      });
    }
  }
  if (rows.length === 0) return { attempted: 0, inserted: 0 };

  // Postgres rejects an INSERT ... ON CONFLICT DO UPDATE that would touch the
  // same row twice ("cannot affect row a second time"), which would fail the
  // WHOLE batch. If a provider ever surfaces the same (source, pair) twice in
  // one cycle, keep the latest observation for that key.
  const byKey = new Map();
  for (const row of rows) byKey.set(`${row.source}:${row.pairAddress}`, row);
  const uniqueRows = [...byKey.values()];

  const values = [];
  const placeholders = [];
  uniqueRows.forEach((row) => {
    // POST-AUDIT FIX: the column list has 14 entries but this used to build
    // 13 placeholders/values per row (first_seen_at and last_seen_at share
    // row.seenAt but only ONE value was pushed), so every call failed with
    // "INSERT has more target columns than expressions" and
    // discovery_observations never received a single row. Width and column
    // list now come from the same COLUMNS array, and the per-row value
    // count is asserted, so they cannot drift apart again.
    const rowValues = [
      row.discoveryId,
      row.source,
      row.chain,
      row.mintAddress,
      row.pairAddress,
      row.symbol,
      row.name,
      row.seenAt, // first_seen_at (never updated on conflict)
      row.seenAt, // last_seen_at
      row.discoveryVolume1hUsd,
      row.discoveryTotalVolumeUsd,
      JSON.stringify(row.threshold),
      row.filterVersion,
      row.providerPath,
    ];
    if (rowValues.length !== INSERT_COLUMNS.length) {
      throw new Error(`discovery_observations insert builder mismatch: ${rowValues.length} values for ${INSERT_COLUMNS.length} columns`);
    }
    const base = values.length;
    placeholders.push(`(${INSERT_COLUMNS.map((_, i) => `$${base + i + 1}`).join(',')})`);
    values.push(...rowValues);
  });

  const result = await query(
    `INSERT INTO discovery_observations
       (${INSERT_COLUMNS.join(', ')})
     VALUES ${placeholders.join(',')}
     ON CONFLICT (source, pair_address) DO UPDATE SET
       last_seen_at = EXCLUDED.last_seen_at,
       discovery_volume_1h_usd = EXCLUDED.discovery_volume_1h_usd,
       discovery_total_volume_usd = EXCLUDED.discovery_total_volume_usd,
       discovery_threshold = EXCLUDED.discovery_threshold,
       filter_version = EXCLUDED.filter_version,
       provider_path = EXCLUDED.provider_path`,
    values,
  );
  return { attempted: uniqueRows.length, inserted: result.rowCount || 0 };
}

async function getPairProvenance(pairAddress) {
  const { rows } = await query(
    `SELECT source, mint_address, pair_address, symbol, name,
            first_seen_at, last_seen_at, discovery_volume_1h_usd,
            discovery_total_volume_usd, discovery_threshold, filter_version,
            provider_path
     FROM discovery_observations
     WHERE pair_address = $1
     ORDER BY first_seen_at ASC, source ASC`,
    [pairAddress],
  );
  return rows;
}

module.exports = { recordDiscoveries, getPairProvenance };
