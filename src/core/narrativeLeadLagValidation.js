'use strict';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
function getAt(obj, paths) {
  for (const path of paths) {
    let value = obj;
    for (const key of path.split('.')) value = value?.[key];
    const n = finite(value);
    if (n !== null) return n;
  }
  return null;
}
function normalizeAttention(row) {
  const observation = row.observation || row;
  const sourceObservations = observation.attention?.sourceObservations || observation.sourceObservations || {};
  const mentions = getAt(observation, ['attention.mentions', 'summary.redditMentions', 'mentions']);
  return {
    narrativeTag: row.narrativeTag ?? row.narrative_tag,
    at: finite(row.observedAtMs ?? row.observed_at_ms) ?? (row.observedAt || row.observed_at ? new Date(row.observedAt ?? row.observed_at).getTime() : null),
    mentions,
    redditAvailable: mentions !== null || sourceObservations.reddit?.available === true,
    trendInterest: getAt(observation, ['attention.trendInterest', 'trendInterest', 'attention.trend_interest']),
  };
}
function normalizeMarket(row) {
  return {
    narrativeTag: row.narrativeTag ?? row.narrative_tag,
    // bucket_at is the bucket start, not the time the data was observed. Use
    // observed_at_max so a bucket containing post-attention snapshots cannot
    // leak those values into the baseline. Missing event-time coverage is
    // excluded rather than guessed from the bucket boundary.
    at: finite(row.observedAtMax ?? row.observed_at_max),
    bucketAt: finite(row.bucketAt ?? row.bucket_at),
    tokenCount: finite(row.tokenCount ?? row.token_count),
    medianVolume1h: finite(row.medianVolume1h ?? row.median_volume_1h),
    totalVolume1h: finite(row.totalVolume1h ?? row.total_volume_1h),
    totalBuys1h: finite(row.totalBuys1h ?? row.total_buys_1h),
    totalSells1h: finite(row.totalSells1h ?? row.total_sells_1h),
    medianPriceUsd: finite(row.medianPriceUsd ?? row.median_price_usd),
    volumeKnownTokenCount: finite(row.volumeKnownTokenCount ?? row.volume_known_token_count),
  };
}
function relativeChange(previous, current) {
  if (previous === null || current === null || previous < 0 || current < 0 || previous === 0) return null;
  return (current - previous) / previous;
}
function log1pChange(previous, current) {
  if (previous === null || current === null || previous < 0 || current < 0) return null;
  return Math.log1p(current) - Math.log1p(previous);
}
function nearestAtOrBefore(rows, at, maxAgeMs) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].at <= at && rows[i].bucketAt <= at && at - rows[i].at <= maxAgeMs) return rows[i];
  }
  return null;
}
function nearestAfter(rows, at, maxLagMs) {
  // A response bucket must start after the attention timestamp. Its maximum
  // observation time being later is not enough: a bucket spanning the
  // attention timestamp can contain pre-attention snapshots in its aggregate.
  return rows.find((row) => row.bucketAt > at && row.at > at && row.at - at <= maxLagMs) || null;
}

/**
 * Descriptive forward-response test. For each attention transition, the market
 * baseline uses an observed market timestamp at/before the current attention
 * reading; the response bucket must start after that reading so the aggregate
 * cannot contain pre-attention snapshots. It remains observational,
 * vulnerable to confounding, and uses rolling snapshot metrics, not exact flow.
 */
function buildNarrativeLeadLagReport(attentionRows, marketRows, options = {}) {
  const maxLagMs = options.maxLagMs ?? 3 * 60 * 60 * 1000;
  const maxBaselineAgeMs = options.maxBaselineAgeMs ?? 3 * 60 * 60 * 1000;
  const minPairs = options.minPairs ?? 3;
  if (!Number.isFinite(maxLagMs) || maxLagMs <= 0) throw new TypeError('maxLagMs must be positive');
  if (!Number.isFinite(maxBaselineAgeMs) || maxBaselineAgeMs < 0) throw new TypeError('maxBaselineAgeMs must be non-negative');
  if (!Number.isInteger(minPairs) || minPairs < 1) throw new TypeError('minPairs must be a positive integer');
  const attention = (attentionRows || []).map(normalizeAttention).filter((r) => Number.isFinite(r.at));
  const market = (marketRows || []).map(normalizeMarket).filter((r) => Number.isFinite(r.at));
  const narratives = new Set([...attention.map((r) => r.narrativeTag), ...market.map((r) => r.narrativeTag)].filter(Boolean));
  const reports = [];
  for (const narrativeTag of [...narratives].sort()) {
    const aRows = attention.filter((r) => r.narrativeTag === narrativeTag).sort((a, b) => a.at - b.at);
    const mRows = market.filter((r) => r.narrativeTag === narrativeTag).sort((a, b) => a.at - b.at);
    const pairs = [];
    for (let i = 1; i < aRows.length; i += 1) {
      const previousAttention = aRows[i - 1];
      const currentAttention = aRows[i];
      if (currentAttention.at <= previousAttention.at || previousAttention.mentions === null || currentAttention.mentions === null) continue;
      const baseline = nearestAtOrBefore(mRows, currentAttention.at, maxBaselineAgeMs);
      const response = nearestAfter(mRows, currentAttention.at, maxLagMs);
      if (!baseline || !response || response.at <= baseline.at) continue;
      const attentionDelta = currentAttention.mentions - previousAttention.mentions;
      const attentionLogChange = log1pChange(previousAttention.mentions, currentAttention.mentions);
      const volumeLogChange = log1pChange(baseline.medianVolume1h, response.medianVolume1h);
      const buysLogChange = log1pChange(baseline.totalBuys1h, response.totalBuys1h);
      const priceChange = relativeChange(baseline.medianPriceUsd, response.medianPriceUsd);
      pairs.push({
        attentionFromAt: previousAttention.at,
        attentionAt: currentAttention.at,
        marketBaselineAt: baseline.at,
        marketResponseAt: response.at,
        marketBaselineBucketAt: baseline.bucketAt,
        marketResponseBucketAt: response.bucketAt,
        responseLagMs: response.at - currentAttention.at,
        previousMentions: previousAttention.mentions,
        currentMentions: currentAttention.mentions,
        attentionMentionDelta: attentionDelta,
        attentionLogChange,
        medianVolumeLogChange: volumeLogChange,
        buysLogChange,
        medianPriceChange: priceChange,
        marketBaselineTokenCount: baseline.tokenCount,
        marketResponseTokenCount: response.tokenCount,
        attentionAndVolumeUp: attentionDelta > 0 && volumeLogChange !== null && volumeLogChange > 0,
        attentionUpVolumeFlatOrDown: attentionDelta > 0 && volumeLogChange !== null && volumeLogChange <= 0,
        volumeUpAttentionFlatOrDown: attentionDelta <= 0 && volumeLogChange !== null && volumeLogChange > 0,
      });
    }
    const valid = pairs.filter((p) => p.attentionLogChange !== null && p.medianVolumeLogChange !== null);
    reports.push({
      narrativeTag,
      attentionObservationCount: aRows.length,
      marketBucketCount: mRows.length,
      pairedWindowCount: pairs.length,
      validAttentionVolumePairs: valid.length,
      medianAttentionLogChange: median(valid.map((p) => p.attentionLogChange)),
      medianVolumeLogChange: median(valid.map((p) => p.medianVolumeLogChange)),
      medianBuysLogChange: median(valid.map((p) => p.buysLogChange).filter((v) => v !== null)),
      medianPriceChange: median(valid.map((p) => p.medianPriceChange).filter((v) => v !== null)),
      attentionAndVolumeUpCount: valid.filter((p) => p.attentionAndVolumeUp).length,
      attentionUpVolumeFlatOrDownCount: valid.filter((p) => p.attentionUpVolumeFlatOrDown).length,
      volumeUpAttentionFlatOrDownCount: valid.filter((p) => p.volumeUpAttentionFlatOrDown).length,
      coverageSufficient: valid.length >= minPairs,
      validationReady: false,
      predictiveValidationReady: false,
      readinessReason: valid.length >= minPairs ? 'descriptive_pairs_only_predictive_validation_not_run' : 'insufficient_aligned_forward_response_pairs',
      pairs,
    });
  }
  return {
    generatedAt: options.now ?? Date.now(),
    maxLagMs,
    maxBaselineAgeMs,
    minPairs,
    validationStatus: 'descriptive_coverage_only',
    interpretation: 'Descriptive forward association only; not causal, not a BUY signal, and not a fixed-horizon token outcome estimate. Market measures are rolling snapshot readings. Pair-count sufficiency is not predictive validation.',
    reports,
  };
}
module.exports = { buildNarrativeLeadLagReport, relativeChange, log1pChange };
