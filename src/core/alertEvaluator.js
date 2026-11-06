'use strict';

const RULES_VERSION = 'analytical-v1';
const DEFAULT_RULES = Object.freeze({
  positiveMovePct: 25,
  strongPositiveMovePct: 50,
  adverseMovePct: -20,
  severeAdverseMovePct: -50,
  waitConfirmationMovePct: 10,
  waitConfirmationWindowHours: 1,
  evaluationWindowHours: 24,
  minimumCoverage: 0.70,
});

function pct(price, reference) {
  if (!Number.isFinite(price) || !Number.isFinite(reference) || reference <= 0) return null;
  return ((price / reference) - 1) * 100;
}

/**
 * Parses a possibly-missing numeric field. Returns null ONLY for a value that
 * is genuinely absent or unparseable, and preserves a legitimate 0.
 *
 * POST-AUDIT FIX (Finding 6): this file used `Number(x) || null`, which turns
 * a real 0 into null (0 is falsy). A price or pool liquidity of exactly 0 is
 * the clearest rug signal there is, and it was silently dropped from the
 * evidence (severeRisk even tests `liquidityUsd <= 0`, a branch that could
 * never see 0). The obvious replacement, a bare Number(x), is worse: null,
 * '' and whitespace all convert to 0, so every UNAVAILABLE observation would
 * read as a total collapse. Absent must stay absent.
 */
function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeObservation(row) {
  return {
    horizonKey: row.horizonKey || row.horizon_key,
    targetAt: row.targetAt || row.target_at,
    observedAt: row.observedAt || row.observed_at,
    status: row.status,
    dataQualityStatus: row.dataQualityStatus || row.data_quality_status,
    priceUsd: finiteOrNull(row.priceUsd ?? row.price_usd),
    liquidityUsd: finiteOrNull(row.liquidityUsd ?? row.liquidity_usd),
    pairResolvable: row.pairResolvable ?? row.pair_resolvable,
    lpLockedPct: row.lpLockedPct ?? row.lp_locked_pct,
    topHolderPct: row.topHolderPct ?? row.top_holder_pct,
  };
}

// Coverage below this fraction is not evidence at all (-> 'unresolved'), and
// 'high' additionally requires this much coverage. Fixed constants: they are
// not part of DEFAULT_RULES, so they are not stored in each result's
// evidence.rules. Only the low/medium boundary is configurable.
const UNRESOLVED_COVERAGE_FLOOR = 0.5;
const HIGH_CONFIDENCE_COVERAGE = 0.9;
const HIGH_CONFIDENCE_MIN_OBSERVATIONS = 5;

/**
 * POST-AUDIT FIX (Finding 7): this used to take no `rules` argument and hard-
 * code 0.7 for the low/medium boundary, so DEFAULT_RULES.minimumCoverage
 * looked configurable but changing it had no effect. That boundary now comes
 * from rules.minimumCoverage (falling back to the default for a partial rules
 * object), and 'high' is never granted below it. Behaviour at the default
 * (0.70) is identical to before.
 */
function confidenceFor(coverage, observations, evidenceClass, rules = DEFAULT_RULES) {
  const minimumCoverage = Number.isFinite(rules?.minimumCoverage) ? rules.minimumCoverage : DEFAULT_RULES.minimumCoverage;
  if (coverage < UNRESOLVED_COVERAGE_FLOOR) return 'unresolved';
  if (evidenceClass === 'forward' && coverage >= Math.max(HIGH_CONFIDENCE_COVERAGE, minimumCoverage) && observations.length >= HIGH_CONFIDENCE_MIN_OBSERVATIONS) return 'high';
  if (coverage >= minimumCoverage) return 'medium';
  return 'low';
}

function buildEvidence(observations, referencePrice, rules) {
  const normalized = observations.map(normalizeObservation);
  const usable = normalized.filter((o) => o.priceUsd !== null);
  const moves = usable.map((o) => ({ horizonKey: o.horizonKey, movePct: pct(o.priceUsd, referencePrice), liquidityUsd: o.liquidityUsd, pairResolvable: o.pairResolvable }));
  const maxMove = moves.reduce((max, item) => Math.max(max, item.movePct ?? -Infinity), -Infinity);
  const minMove = moves.reduce((min, item) => Math.min(min, item.movePct ?? Infinity), Infinity);
  const firstPositive = moves.filter((m) => m.movePct >= rules.positiveMovePct).sort((a, b) => String(a.horizonKey).localeCompare(String(b.horizonKey)))[0] || null;
  const firstAdverse = moves.filter((m) => m.movePct <= rules.adverseMovePct).sort((a, b) => String(a.horizonKey).localeCompare(String(b.horizonKey)))[0] || null;
  const at24h = moves.find((m) => m.horizonKey === '24h') || null;
  const severeRisk = normalized.some((o) => o.pairResolvable === false || (o.liquidityUsd !== null && o.liquidityUsd <= 0));
  return {
    referencePrice,
    observedCount: normalized.length,
    usablePriceCount: usable.length,
    moves,
    maxMovePct: Number.isFinite(maxMove) ? maxMove : null,
    minMovePct: Number.isFinite(minMove) ? minMove : null,
    firstPositive,
    firstAdverse,
    at24h,
    severeRisk,
  };
}

function scoreBuy(evidence, rules) {
  let score = 0;
  if (evidence.maxMovePct >= rules.positiveMovePct) score += 30;
  if (evidence.maxMovePct >= rules.strongPositiveMovePct) score += 15;
  if (evidence.at24h && evidence.at24h.movePct >= 0) score += 10;
  if (evidence.maxMovePct >= rules.positiveMovePct && evidence.minMovePct > rules.severeAdverseMovePct) score += 15;
  if (evidence.minMovePct > rules.adverseMovePct) score += 15;
  if (evidence.severeRisk) score -= 40;
  if (evidence.firstAdverse && !evidence.firstPositive) score -= 30;
  return Math.max(0, Math.min(100, score));
}

function scoreWait(evidence, rules) {
  let score = 0;
  if (evidence.minMovePct <= rules.adverseMovePct) score += 30;
  if (evidence.severeRisk) score += 40;
  if (evidence.maxMovePct >= rules.waitConfirmationMovePct) score += 20;
  if (evidence.minMovePct > rules.severeAdverseMovePct) score += 15;
  if (evidence.maxMovePct >= rules.positiveMovePct && evidence.minMovePct > rules.adverseMovePct) score -= 35;
  if (evidence.maxMovePct >= rules.strongPositiveMovePct && evidence.minMovePct > rules.adverseMovePct) score -= 20;
  return Math.max(0, Math.min(100, score));
}

function scoreSkip(evidence, rules) {
  let score = 0;
  if (evidence.minMovePct <= rules.adverseMovePct) score += 30;
  if (evidence.minMovePct <= rules.severeAdverseMovePct) score += 45;
  if (evidence.severeRisk) score += 25;
  if (evidence.maxMovePct < rules.positiveMovePct) score += 10;
  if (evidence.maxMovePct >= rules.positiveMovePct) score -= 25;
  if (evidence.maxMovePct >= rules.strongPositiveMovePct) score -= 25;
  return Math.max(0, Math.min(100, score));
}

function outcomeFor(label, evidence, rules) {
  if (label === 'BUY') {
    if (evidence.maxMovePct >= rules.strongPositiveMovePct && !evidence.severeRisk) return 'BUY_STRONG';
    if (evidence.maxMovePct >= rules.positiveMovePct && evidence.minMovePct > rules.severeAdverseMovePct && !evidence.severeRisk) return 'BUY_CONFIRMED';
    if (evidence.maxMovePct >= rules.positiveMovePct && (evidence.minMovePct <= rules.severeAdverseMovePct || evidence.severeRisk)) return 'BUY_MIXED';
    if (evidence.minMovePct <= rules.adverseMovePct || evidence.severeRisk) return 'BUY_FAILED';
    return 'BUY_INCONCLUSIVE';
  }
  if (label === 'WAIT') {
    if (evidence.severeRisk || evidence.minMovePct <= rules.adverseMovePct) return 'WAIT_PROTECTIVE';
    if (evidence.maxMovePct >= rules.positiveMovePct && evidence.minMovePct > rules.adverseMovePct) return 'WAIT_MISSED_OPPORTUNITY';
    if (evidence.maxMovePct >= rules.waitConfirmationMovePct) return 'WAIT_VALIDATED';
    return 'WAIT_INCONCLUSIVE';
  }
  if (label === 'SKIP') {
    if (evidence.minMovePct <= rules.severeAdverseMovePct || evidence.severeRisk) return 'SKIP_VALIDATED_RISK';
    if (evidence.minMovePct <= rules.adverseMovePct) return 'SKIP_VALIDATED_RISK';
    if (evidence.maxMovePct >= rules.strongPositiveMovePct) return 'SKIP_FALSE_NEGATIVE';
    if (evidence.maxMovePct >= rules.positiveMovePct) return 'SKIP_FALSE_NEGATIVE';
    if (evidence.maxMovePct < rules.positiveMovePct) return 'SKIP_VALIDATED_NOISE';
    return 'SKIP_NEUTRAL';
  }
  return 'UNKNOWN_SIGNAL';
}

function evaluateAlert({ signalLabel, referencePrice, observations = [], evidenceClass = 'forward', rules = DEFAULT_RULES }) {
  const normalized = observations.map(normalizeObservation);
  const coverage = normalized.length / 6;
  const evidence = buildEvidence(normalized, Number(referencePrice), rules);
  const confidence = confidenceFor(coverage, normalized, evidenceClass, rules);
  if (confidence === 'unresolved' || evidence.usablePriceCount === 0) {
    return {
      rulesVersion: RULES_VERSION,
      evidenceClass,
      observationCoverage: coverage,
      outcomeLabel: `${signalLabel || 'UNKNOWN'}_UNRESOLVED`,
      analyticalScore: null,
      confidence: 'unresolved',
      evidence,
    };
  }

  const score = signalLabel === 'BUY' ? scoreBuy(evidence, rules)
    : signalLabel === 'WAIT' ? scoreWait(evidence, rules)
      : signalLabel === 'SKIP' ? scoreSkip(evidence, rules) : null;
  return {
    rulesVersion: RULES_VERSION,
    evidenceClass,
    observationCoverage: coverage,
    outcomeLabel: outcomeFor(signalLabel, evidence, rules),
    analyticalScore: score,
    confidence,
    evidence: { ...evidence, rules },
  };
}

module.exports = { RULES_VERSION, DEFAULT_RULES, evaluateAlert, normalizeObservation, pct };
