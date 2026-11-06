'use strict';

const DEFAULT_MIN_SAMPLE_SIZE = 30;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateMs(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function normalizeHorizons(horizons) {
  if (!horizons) return [];
  if (Array.isArray(horizons)) return horizons;
  return Object.entries(horizons).map(([horizonKey, value]) => ({ horizonKey, ...value }));
}

function calculateOutcomeMetrics(discovery, horizons) {
  const discoveryPrice = finite(discovery?.discovery_price_usd ?? discovery?.discoveryPriceUsd);
  const discoveryMc = finite(discovery?.discovery_market_cap_usd ?? discovery?.discoveryMarketCapUsd);
  const discoveryLiquidity = finite(discovery?.discovery_liquidity_usd ?? discovery?.discoveryLiquidityUsd);
  const discoveryVolume1h = finite(discovery?.discovery_volume_1h_usd ?? discovery?.discoveryVolume1hUsd);
  const discoveryAt = dateMs(discovery?.first_discovery_at ?? discovery?.firstDiscoveryAt);
  const observations = normalizeHorizons(horizons)
    .map((o) => ({ ...o, observedMs: dateMs(o.observedAt), priceUsd: finite(o.priceUsd), marketCapUsd: finite(o.marketCapUsd), liquidityUsd: finite(o.liquidityUsd), volume1h: finite(o.volume1h) }))
    .filter((o) => !['unavailable', 'failed'].includes(o.status) && o.observedMs !== null);
  const withMc = observations.filter((o) => o.marketCapUsd !== null);
  const withPrice = observations.filter((o) => o.priceUsd !== null);
  const peakMcObs = withMc.reduce((best, o) => !best || o.marketCapUsd > best.marketCapUsd ? o : best, null);
  const peakPriceObs = withPrice.reduce((best, o) => !best || o.priceUsd > best.priceUsd ? o : best, null);
  const peakMc = peakMcObs?.marketCapUsd ?? null;
  const peakPrice = peakPriceObs?.priceUsd ?? null;
  const timeToPeakMs = peakMcObs && discoveryAt !== null ? Math.max(0, peakMcObs.observedMs - discoveryAt) : null;
  const postPeak = peakMcObs ? withMc.filter((o) => o.observedMs >= peakMcObs.observedMs) : [];
  const drawdownFromPeak = peakMc && postPeak.length ? Math.min(...postPeak.map((o) => o.marketCapUsd / peakMc - 1)) : null;
  const horizonMetrics = {};
  for (const o of observations) {
    horizonMetrics[o.horizonKey] = {
      observedAt: o.observedAt,
      priceUsd: o.priceUsd,
      marketCapUsd: o.marketCapUsd,
      liquidityUsd: o.liquidityUsd,
      volume1h: o.volume1h,
      priceMultiple: discoveryPrice > 0 && o.priceUsd !== null ? o.priceUsd / discoveryPrice : null,
      marketCapMultiple: discoveryMc > 0 && o.marketCapUsd !== null ? o.marketCapUsd / discoveryMc : null,
      drawdownFromDiscovery: discoveryMc > 0 && o.marketCapUsd !== null ? o.marketCapUsd / discoveryMc - 1 : null,
      liquidityChange: discoveryLiquidity > 0 && o.liquidityUsd !== null ? o.liquidityUsd / discoveryLiquidity - 1 : null,
      volumeChange: discoveryVolume1h > 0 && o.volume1h !== null ? o.volume1h / discoveryVolume1h - 1 : null,
      dataQualityStatus: o.dataQualityStatus || null,
    };
  }
  return { observationCount: observations.length, discoveryPriceUsd: discoveryPrice, discoveryMarketCapUsd: discoveryMc, discoveryLiquidityUsd: discoveryLiquidity, maxMarketCap: peakMc, maxPrice: peakPrice, timeToPeakMs, drawdownFromPeak, horizons: horizonMetrics };
}

function computeDiscoveryLatency(firstDiscoveryAt, eventAt) {
  const start = dateMs(firstDiscoveryAt); const end = dateMs(eventAt);
  return start === null || end === null ? null : Math.max(0, end - start);
}

function buildCandidateOutcome(row) {
  const outcome = calculateOutcomeMetrics(row, row.horizons);
  const qualified = Boolean(row.alert_id);
  const evaluationHistory = Array.isArray(row.evaluation_history) ? row.evaluation_history : [];
  const failedEvaluation = evaluationHistory.filter((e) => e && e.passed === false).sort((a, b) => new Date(b.evaluatedAt) - new Date(a.evaluatedAt))[0] || null;
  const qualificationState = qualified ? 'passed' : (failedEvaluation ? 'failed' : 'unknown');
  const qualifiedLatencyMs = qualified ? computeDiscoveryLatency(row.first_discovery_at, row.qualified_at) : null;
  return {
    pairAddress: row.pair_address,
    mintAddress: row.mint_address,
    firstDiscoveredBy: row.first_discovered_by || null,
    discoverySources: row.discovery_sources || [],
    sourceDiscoveryTimes: row.source_discovery_times || {},
    firstDiscoveryAt: row.first_discovery_at || null,
    discoveryCohortKey: row.first_cohort_key || null,
    discoveryConditions: {
      volume1hUsd: finite(row.discovery_volume_1h_usd), totalVolumeUsd: finite(row.discovery_total_volume_usd), liquidityUsd: finite(row.discovery_liquidity_usd), marketCapUsd: finite(row.discovery_market_cap_usd), priceUsd: finite(row.discovery_price_usd), ageMinutes: finite(row.discovery_age_minutes), threshold: row.discovery_threshold || null, filterVersion: row.filter_version || null, discoveryVersion: row.discovery_version || null, providerPath: row.provider_path || null,
    },
    qualification: { state: qualificationState, passed: qualified, reason: failedEvaluation?.reason || null, failedStage: failedEvaluation?.stage || null, qualifiedAt: row.qualified_at || null, latencyMs: qualifiedLatencyMs, signalLabel: row.signal_label || null, riskLevel: row.risk_level || null },
    evaluationHistory,
    observationDataQuality: { total: Number(row.observation_count || 0), complete: Number(row.complete_observation_count || 0), unavailable: Number(row.unavailable_observation_count || 0) },
    outcome: { outcome: row.outcome || null, outcomeDetail: row.outcome_detail || null, rugMechanism: row.rug_mechanism || null, archivedAt: row.archived_at || null, timeToRugFromQualificationHours: finite(row.time_to_rug_from_qualification_hours), ...outcome },
  };
}

function summarizeByFirstDiscoverySource(candidates, minSampleSize = DEFAULT_MIN_SAMPLE_SIZE) {
  const groups = new Map();
  for (const c of candidates || []) { const source = c.firstDiscoveredBy || 'unknown'; if (!groups.has(source)) groups.set(source, []); groups.get(source).push(c); }
  return Array.from(groups.entries()).map(([source, group]) => {
    const qualified = group.filter((c) => c.qualification.passed);
    const safetyEvaluated = group.filter((c) => Array.isArray(c.evaluationHistory) && c.evaluationHistory.some((e) => e.stage === 'safety'));
    const safetyPassed = group.filter((c) => Array.isArray(c.evaluationHistory) && c.evaluationHistory.some((e) => e.stage === 'safety' && e.passed === true));
    const observed = qualified.filter((c) => c.outcome.observationCount > 0);
    const signalled = qualified.filter((c) => c.qualification.signalLabel);
    const archived = qualified.filter((c) => c.outcome.outcome);
    const rugged = archived.filter((c) => c.outcome.outcome === 'rugged');
    const survived = archived.filter((c) => c.outcome.outcome === 'survived');
    const peaks = observed.map((c) => c.outcome.discoveryMarketCapUsd > 0 && c.outcome.maxMarketCap !== null ? c.outcome.maxMarketCap / c.outcome.discoveryMarketCapUsd : null).filter(Number.isFinite);
    const sufficient = group.length >= minSampleSize;
    return {
      source, discoveredCandidates: group.length, qualifiedCandidates: qualified.length, safetyEvaluatedCandidates: safetyEvaluated.length, safetyPassedCandidates: safetyPassed.length, observedCandidates: observed.length, signalledCandidates: signalled.length,
      archivedOutcomeCandidates: archived.length, ruggedCandidates: rugged.length, survivedCandidates: survived.length,
      sampleSufficientForComparison: sufficient, minimumSampleSize: minSampleSize,
      comparisonMetrics: sufficient ? {
        qualificationRate: group.length ? qualified.length / group.length : null,
        safetyPassRateAmongEvaluated: safetyEvaluated.length ? safetyPassed.length / safetyEvaluated.length : null,
        observationRateAmongQualified: qualified.length ? observed.length / qualified.length : null,
        signalRateAmongQualified: qualified.length ? signalled.length / qualified.length : null,
        rugRateAmongArchived: archived.length ? rugged.length / archived.length : null,
        survivalRateAmongArchived: archived.length ? survived.length / archived.length : null,
        medianPeakMarketCapMultiple: median(peaks),
      } : null,
    };
  }).sort((a, b) => a.source.localeCompare(b.source));
}

function summarizeByCohort(candidates, minSampleSize = DEFAULT_MIN_SAMPLE_SIZE) {
  const groups = new Map();
  for (const c of candidates || []) {
    const key = c.discoveryCohortKey || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return Array.from(groups.entries()).map(([cohortKey, group]) => ({
    cohortKey,
    source: group[0]?.firstDiscoveredBy || null,
    discoveredCandidates: group.length,
    qualifiedCandidates: group.filter((c) => c.qualification.passed).length,
    archivedCandidates: group.filter((c) => c.outcome.outcome).length,
    ruggedCandidates: group.filter((c) => c.outcome.outcome === 'rugged').length,
    survivedCandidates: group.filter((c) => c.outcome.outcome === 'survived').length,
    sampleSufficientForComparison: group.length >= minSampleSize,
    minimumSampleSize: minSampleSize,
  }));
}

function buildEventLatencySummary(candidates, multiple) {
  const rows = [];
  for (const c of candidates || []) {
    const base = c.outcome.discoveryMarketCapUsd;
    if (!(base > 0)) continue;
    const event = normalizeHorizons(c.outcome.horizons).find((o) => { const mc = finite(o.marketCapUsd); return mc !== null && mc / base >= multiple; });
    if (event) rows.push(computeDiscoveryLatency(c.firstDiscoveryAt, event.observedAt));
  }
  const valid = rows.filter(Number.isFinite);
  return { event: `${multiple}x_market_cap`, sampleSize: valid.length, medianLatencyMs: median(valid) };
}

module.exports = { DEFAULT_MIN_SAMPLE_SIZE, calculateOutcomeMetrics, computeDiscoveryLatency, buildCandidateOutcome, summarizeByFirstDiscoverySource, summarizeByCohort, buildEventLatencySummary };
