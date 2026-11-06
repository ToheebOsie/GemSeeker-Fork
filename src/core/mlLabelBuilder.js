'use strict';

const LABEL_POLICY_VERSION = 'label-policy-v1';
const RECONSTRUCTED_LABEL_POLICY_VERSION = 'label-policy-v2-reconstructed';
const HORIZONS = Object.freeze([
  { key: '5m', minutes: 5 },
  { key: '15m', minutes: 15 },
  { key: '1h', minutes: 60 },
  { key: '6h', minutes: 360 },
  { key: '24h', minutes: 1440 },
  { key: '72h', minutes: 4320 },
]);
const DEFAULT_POLICY = Object.freeze({
  positiveMovePct: 25,
  adverseMovePct: -20,
  severeAdverseMovePct: -50,
  minimumValidObservations: 1,
  maxObservationLatencyMs: 30 * 60 * 1000,
});

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function movePct(price, reference) {
  if (price === null || reference === null || reference <= 0) return null;
  return ((price / reference) - 1) * 100;
}

function normalizeObservation(row) {
  return {
    observationId: row.observationId || row.observation_id || null,
    horizonKey: row.horizonKey || row.horizon_key || null,
    targetAt: row.targetAt || row.target_at || null,
    observedAt: row.observedAt || row.observed_at || null,
    status: row.status || null,
    dataQualityStatus: row.dataQualityStatus || row.data_quality_status || null,
    source: row.source || null,
    evidenceClass: row.evidenceClass || row.evidence_class || 'forward',
    sourceObservedAt: row.sourceObservedAt || row.source_observed_at || null,
    pairResolvable: row.pairResolvable ?? row.pair_resolvable ?? null,
    priceUsd: finite(row.priceUsd ?? row.price_usd),
    liquidityUsd: finite(row.liquidityUsd ?? row.liquidity_usd),
    evidence: row.evidence || null,
  };
}

function policyWithDefaults(policy = {}) {
  return {
    ...DEFAULT_POLICY,
    ...policy,
    positiveMovePct: finite(policy.positiveMovePct) ?? DEFAULT_POLICY.positiveMovePct,
    adverseMovePct: finite(policy.adverseMovePct) ?? DEFAULT_POLICY.adverseMovePct,
    severeAdverseMovePct: finite(policy.severeAdverseMovePct) ?? DEFAULT_POLICY.severeAdverseMovePct,
    minimumValidObservations: Math.max(1, Math.floor(finite(policy.minimumValidObservations) ?? DEFAULT_POLICY.minimumValidObservations)),
    maxObservationLatencyMs: Math.max(0, finite(policy.maxObservationLatencyMs) ?? DEFAULT_POLICY.maxObservationLatencyMs),
  };
}

function qualityFor(observations, referencePrice, targetAt, policy) {
  const normalized = observations.map(normalizeObservation).sort((a, b) => Date.parse(a.observedAt || 0) - Date.parse(b.observedAt || 0));
  const valid = normalized.filter((o) => o.priceUsd !== null && o.status !== 'failed' && o.status !== 'unavailable');
  const complete = normalized.filter((o) => o.dataQualityStatus === 'complete');
  const partial = normalized.filter((o) => o.dataQualityStatus === 'partial');
  const stale = normalized.filter((o) => o.dataQualityStatus === 'stale');
  const unavailable = normalized.filter((o) => ['unavailable', 'not_observed'].includes(o.dataQualityStatus) || o.status === 'unavailable');
  const moves = valid.map((o) => ({
    observationId: o.observationId,
    observedAt: o.observedAt,
    movePct: movePct(o.priceUsd, referencePrice),
    priceUsd: o.priceUsd,
    liquidityUsd: o.liquidityUsd,
    pairResolvable: o.pairResolvable,
  })).filter((m) => m.movePct !== null);
  const latencyViolations = normalized.filter((o) => {
    if (!o.observedAt || !o.sourceObservedAt) return false;
    return Date.parse(o.observedAt) - Date.parse(o.sourceObservedAt) > policy.maxObservationLatencyMs;
  });
  return {
    observationCount: normalized.length,
    validObservationCount: moves.length,
    completeObservationCount: complete.length,
    partialObservationCount: partial.length,
    staleObservationCount: stale.length,
    unavailableObservationCount: unavailable.length,
    latencyViolationCount: latencyViolations.length,
    evidenceObservationIds: normalized.map((o) => o.observationId).filter(Boolean),
    moves,
    targetAt,
  };
}

function resolveEvidenceClass(observations, requestedEvidenceClass = null) {
  if (requestedEvidenceClass) return requestedEvidenceClass;
  const classes = new Set(observations.map((row) => normalizeObservation(row).evidenceClass));
  if (classes.has('reconstructed')) return 'reconstructed';
  if (classes.has('legacy')) return 'legacy';
  return 'forward';
}

function reconstructedQualityGate(observations, targetAt) {
  const rows = observations.map(normalizeObservation);
  const hasUnknownTiming = rows.some((row) => !row.observedAt || !row.sourceObservedAt);
  const hasPartialEvidence = rows.some((row) => ['partial', 'stale', 'unavailable', 'not_observed'].includes(row.dataQualityStatus));
  const reachesTarget = rows.some((row) => Date.parse(row.observedAt || 0) >= Date.parse(targetAt || 0));
  return { pass: !hasUnknownTiming && !hasPartialEvidence && reachesTarget, hasUnknownTiming, hasPartialEvidence, reachesTarget };
}

function buildHorizonLabel({ signalLabel = null, referencePrice, qualifiedAt, targetAt, observations = [], now = Date.now(), policy = DEFAULT_POLICY, evidenceClass: requestedEvidenceClass = null } = {}) {
  const rules = policyWithDefaults(policy);
  const reference = finite(referencePrice);
  const quality = qualityFor(observations, reference, targetAt, rules);
  const targetMs = Date.parse(targetAt || 0);
  const qualifiedMs = Date.parse(qualifiedAt || 0);
  const valid = quality.moves;
  const hasEnough = reference !== null && valid.length >= rules.minimumValidObservations;
  const evidenceClass = resolveEvidenceClass(observations, requestedEvidenceClass);
  const reconstruction = evidenceClass === 'reconstructed' ? reconstructedQualityGate(observations, targetAt) : { pass: true };
  const base = { labelPolicyVersion: evidenceClass === 'reconstructed' ? RECONSTRUCTED_LABEL_POLICY_VERSION : LABEL_POLICY_VERSION, signalLabel, evidenceClass, quality: { ...quality, reconstruction }, rules };

  if (evidenceClass === 'reconstructed' && !reconstruction.pass) {
    const future = Number.isFinite(targetMs) && targetMs > now;
    return { ...base, outcome: future ? 'censored' : 'unknown', reason: 'reconstructed_evidence_incomplete' };
  }

  if (!hasEnough) {
    const future = Number.isFinite(targetMs) && targetMs > now;
    return { ...base, outcome: future ? 'censored' : 'unknown', reason: reference === null ? 'missing_reference_price' : future ? 'target_not_reached' : 'insufficient_valid_observations' };
  }

  const positive = valid.find((m) => m.movePct >= rules.positiveMovePct);
  const adverse = valid.find((m) => m.movePct <= rules.adverseMovePct);
  let outcome = 'neutral';
  let reason = 'neither_threshold_reached';
  if (positive && adverse) {
    if (Date.parse(positive.observedAt || 0) <= Date.parse(adverse.observedAt || 0)) {
      outcome = 'positive'; reason = 'positive_threshold_reached_first';
    } else {
      outcome = 'negative'; reason = 'adverse_threshold_reached_first';
    }
  } else if (positive) {
    outcome = 'positive'; reason = 'positive_threshold_reached';
  } else if (adverse) {
    outcome = 'negative'; reason = 'adverse_threshold_reached';
  }
  const maxMove = Math.max(...valid.map((m) => m.movePct));
  const minMove = Math.min(...valid.map((m) => m.movePct));
  return {
    ...base,
    outcome,
    reason,
    maxRoiMultiple: 1 + (maxMove / 100),
    maxMovePct: maxMove,
    maxDrawdownPct: minMove,
    severeAdverseObserved: minMove <= rules.severeAdverseMovePct,
    positiveEvidence: positive || null,
    adverseEvidence: adverse || null,
    observedThroughAt: valid[valid.length - 1].observedAt,
  };
}

function buildLabelBundle({ signalLabel = null, referencePrice, qualifiedAt, observations = [], now = Date.now(), policy = DEFAULT_POLICY, evidenceClass = null } = {}) {
  const rules = policyWithDefaults(policy);
  const normalized = observations.map(normalizeObservation);
  const byHorizon = {};
  for (const horizon of HORIZONS) {
    const targetAt = new Date(Date.parse(qualifiedAt) + horizon.minutes * 60 * 1000).toISOString();
    const horizonRows = normalized.filter((o) => o.horizonKey === horizon.key || (o.targetAt && Date.parse(o.targetAt) <= Date.parse(targetAt)));
    byHorizon[horizon.key] = buildHorizonLabel({ signalLabel, referencePrice, qualifiedAt, targetAt, observations: horizonRows, now, policy: rules, evidenceClass });
  }
  const statuses = Object.values(byHorizon).map((x) => x.outcome);
  const labelStatus = statuses.every((x) => ['positive', 'negative', 'neutral'].includes(x)) ? 'labeled' : statuses.some((x) => ['positive', 'negative', 'neutral'].includes(x)) ? 'partial' : statuses.every((x) => x === 'censored') ? 'unknown' : 'partial';
  const bundleEvidenceClass = resolveEvidenceClass(observations, evidenceClass);
  return { labelPolicyVersion: bundleEvidenceClass === 'reconstructed' ? RECONSTRUCTED_LABEL_POLICY_VERSION : LABEL_POLICY_VERSION, evidenceClass: bundleEvidenceClass, policy: rules, labelStatus, horizons: byHorizon };
}

module.exports = { LABEL_POLICY_VERSION, RECONSTRUCTED_LABEL_POLICY_VERSION, HORIZONS, DEFAULT_POLICY, normalizeObservation, resolveEvidenceClass, reconstructedQualityGate, buildHorizonLabel, buildLabelBundle };
