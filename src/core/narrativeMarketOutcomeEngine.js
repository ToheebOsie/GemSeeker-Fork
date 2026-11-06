'use strict';

/**
 * Pure, research-only aggregation of existing Gem Seeker snapshots into
 * fixed UTC time buckets per narrative. This is not external attention data
 * and does not infer unique buyers, holders, or liquidity where the current
 * snapshot schema does not store them.
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bucketStart(timestampMs, bucketMinutes = 60) {
  const t = finiteOrNull(timestampMs);
  if (t === null || t < 0 || !Number.isFinite(bucketMinutes) || bucketMinutes <= 0) return null;
  const width = Math.floor(bucketMinutes * 60_000);
  return Math.floor(t / width) * width;
}

function aggregateNarrativeMarketBucket(narrativeTag, bucketAt, observations) {
  const rows = Array.isArray(observations) ? observations : [];
  const validRows = rows.filter((row) => finiteOrNull(row.t) !== null);
  const latestByPair = new Map();
  for (const row of validRows) {
    const pair = row.pairAddress;
    if (!pair) continue;
    const existing = latestByPair.get(pair);
    if (!existing || Number(row.t) > Number(existing.t)) latestByPair.set(pair, row);
  }
  const latest = [...latestByPair.values()];
  const volumes = latest.map((r) => finiteOrNull(r.volume1h)).filter((v) => v !== null);
  const prices = latest.map((r) => finiteOrNull(r.priceUsd)).filter((v) => v !== null && v > 0);
  const buys = latest.map((r) => finiteOrNull(r.buys1h)).filter((v) => v !== null);
  const sells = latest.map((r) => finiteOrNull(r.sells1h)).filter((v) => v !== null);
  const pairAddresses = latest.map((r) => r.pairAddress);
  const timestamps = latest.map((r) => Number(r.t));
  return {
    narrativeTag,
    bucketAt,
    observedAtMin: timestamps.length ? Math.min(...timestamps) : null,
    observedAtMax: timestamps.length ? Math.max(...timestamps) : null,
    tokenCount: pairAddresses.length,
    volumeKnownTokenCount: volumes.length,
    medianVolume1h: median(volumes),
    totalVolume1h: volumes.length ? volumes.reduce((sum, v) => sum + v, 0) : null,
    buyKnownTokenCount: buys.length,
    totalBuys1h: buys.length ? buys.reduce((sum, v) => sum + v, 0) : null,
    sellKnownTokenCount: sells.length,
    totalSells1h: sells.length ? sells.reduce((sum, v) => sum + v, 0) : null,
    priceKnownTokenCount: prices.length,
    medianPriceUsd: median(prices),
    // These are intentionally null: current snapshots do not record unique
    // buyers, holder counts, or absolute liquidity in a time-aligned series.
    uniqueBuyers: null,
    holders: null,
    liquidityUsd: null,
    source: 'gem_seeker_snapshots',
  };
}

function buildNarrativeMarketBuckets(tokens, snapshotsByPair, options = {}) {
  const bucketMinutes = options.bucketMinutes ?? 60;
  if (!Number.isFinite(bucketMinutes) || bucketMinutes <= 0) throw new TypeError('bucketMinutes must be positive');
  const tokensByPair = new Map((Array.isArray(tokens) ? tokens : [])
    .filter((t) => t && t.pairAddress)
    .map((t) => [t.pairAddress, t]));
  const groups = new Map();
  for (const [pairAddress, snapshots] of Object.entries(snapshotsByPair || {})) {
    const token = tokensByPair.get(pairAddress);
    if (!token) continue;
    const narrativeTag = token.narrativeTag || 'uncategorized';
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      const bucketAt = bucketStart(snapshot.t, bucketMinutes);
      if (bucketAt === null) continue;
      const key = `${narrativeTag}\u0000${bucketAt}`;
      if (!groups.has(key)) groups.set(key, { narrativeTag, bucketAt, observations: [] });
      groups.get(key).observations.push({ ...snapshot, pairAddress });
    }
  }
  return [...groups.values()]
    .map((g) => aggregateNarrativeMarketBucket(g.narrativeTag, g.bucketAt, g.observations))
    .sort((a, b) => a.bucketAt - b.bucketAt || a.narrativeTag.localeCompare(b.narrativeTag));
}

function computeForwardOutcome(token, horizonMs, nowMs = Date.now()) {
  const qualifiedAt = finiteOrNull(token?.qualifiedAt);
  const archivedAt = finiteOrNull(token?.archivedAt);
  const peakRoiMultiple = finiteOrNull(token?.peakRoiMultiple);
  if (qualifiedAt === null || horizonMs <= 0 || !Number.isFinite(horizonMs)) {
    return { eligible: false, reason: 'invalid_or_missing_time', outcome: null, peakRoiMultiple: null };
  }
  const horizonEnd = qualifiedAt + horizonMs;
  if (nowMs < horizonEnd) {
    return { eligible: false, reason: 'horizon_not_elapsed', outcome: null, peakRoiMultiple: null };
  }
  // Archive-level ATH/outcome summaries are not time-censored to a horizon.
  // Do not mislabel them as outcomes within the requested forward window.
  if (archivedAt !== null && archivedAt > horizonEnd) {
    return { eligible: false, reason: 'archive_outcome_exceeds_horizon', outcome: null, peakRoiMultiple: null };
  }
  if (archivedAt === null || token?.outcome == null || peakRoiMultiple === null) {
    return { eligible: false, reason: 'insufficient_horizon_outcome_data', outcome: null, peakRoiMultiple: null };
  }
  return { eligible: true, reason: null, outcome: token.outcome, peakRoiMultiple };
}

module.exports = {
  aggregateNarrativeMarketBucket,
  bucketStart,
  buildNarrativeMarketBuckets,
  computeForwardOutcome,
  median,
};
