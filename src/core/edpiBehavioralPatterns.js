'use strict';

/**
 * EDPI-L behavioral-pattern expansion — investigates OBSERVABLE patterns
 * in a wallet's own historical trading behavior and compares them
 * against its CURRENT position. This is NOT a verdict about intent: every
 * function here returns measurements (ratios, counts, distributions),
 * never a bullish/bearish flag or a single opaque
 * `edpiSuspicious = true` — see the spec's own explicit "avoid a single
 * opaque boolean... prefer structured evidence" instruction.
 *
 * BUILT ON POSITION-LIFECYCLE DATA (positionLifecycle.js /
 * walletOutcomeProfile.js), NOT edpiLive.js's older campaign-based
 * baseline. See docs/edpi-behavioral-patterns.md's "Relationship to
 * EDPI-L's existing anomaly ratio" section for why both exist side by
 * side rather than one replacing the other — in short, a "campaign" is
 * just a fragmented-buy window with no sell/exit concept, while a
 * "position" is the real accumulate-hold-exit unit this feature's own
 * spec asks for.
 *
 * REUSES edpiLive.js's `computeAnomalyRatio` / `computeDistributionStats`
 * DIRECTLY rather than re-deriving the same ratio-to-median math a
 * second time — that function already does exactly what "compare a
 * current value against a wallet's own historical distribution" needs
 * (see edpiLive.js's own header comment on it, "kept STRUCTURALLY
 * INDEPENDENT throughout"), and it already returns `{available: false}`
 * cleanly on missing/insufficient data. The only new code this file adds
 * for entry-MC/capital deviation is the ADAPTER that builds a baseline
 * from position-lifecycle data instead of campaigns
 * (buildPositionLifecycleBaseline) — everything downstream of that is
 * the same shared function.
 *
 * PATTERN INDEPENDENCE (spec sections 8/13): entry-MC deviation, capital
 * deviation, dead/rugged surrounding activity, stable-survivor/pump-and-dump/unknown
 * surrounding activity, repeated-similar-size entries, and consecutive
 * losses are all computed independently and returned as SEPARATE fields
 * on `evaluateWalletBehavioralProfile`'s output — a wallet can show any
 * subset of them, and a missing/unavailable one never disables another.
 */

const { computeAnomalyRatio, computeDistributionStats } = require('./edpiLive');

// ---------------------------------------------------------------------
// Token status classification (spec section 5).
//
// `outcome === 'survived'` is an archive outcome, NOT a stable/high-MC
// observation. Where available, Phase 8's `outcome_detail` gives the
// narrower observable class produced at archive time:
//
//   rugged          -> dead_or_rugged
//   survived+dead   -> dead_or_rugged
//   survived+pump-and-dump -> pump_and_dump
//   survived+stable-survivor -> stable_survivor
//   survived+missing/unknown detail -> unknown
//
// Market-cap class is deliberately separate. pattern_archive does not
// contain a historical MC field/snapshot that establishes "high_mc", so
// this function reports marketCapClass='unknown' rather than inventing a
// threshold from ROI, price, survival, or holding duration.
// ---------------------------------------------------------------------

function classifyTokenStatus(outcome) {
  if (!outcome || typeof outcome.outcome !== 'string') {
    return {
      status: 'unknown',
      marketCapClass: 'unknown',
      outcome: null,
      outcomeDetail: null,
      reason: 'no_resolved_outcome',
    };
  }

  const outcomeDetail = typeof outcome.outcomeDetail === 'string'
    ? outcome.outcomeDetail
    : null;

  if (outcome.outcome === 'rugged') {
    return {
      status: 'dead_or_rugged',
      marketCapClass: 'unknown',
      outcome: outcome.outcome,
      outcomeDetail,
      reason: null,
    };
  }

  if (outcome.outcome !== 'survived') {
    return {
      status: 'unknown',
      marketCapClass: 'unknown',
      outcome: outcome.outcome,
      outcomeDetail,
      reason: `unrecognized_outcome_value:${outcome.outcome}`,
    };
  }

  if (outcomeDetail === 'dead') {
    return {
      status: 'dead_or_rugged',
      marketCapClass: 'unknown',
      outcome: outcome.outcome,
      outcomeDetail,
      reason: null,
    };
  }

  if (outcomeDetail === 'pump-and-dump') {
    return {
      status: 'pump_and_dump',
      marketCapClass: 'unknown',
      outcome: outcome.outcome,
      outcomeDetail,
      reason: null,
    };
  }

  if (outcomeDetail === 'stable-survivor') {
    return {
      status: 'stable_survivor',
      marketCapClass: 'unknown',
      outcome: outcome.outcome,
      outcomeDetail,
      reason: null,
    };
  }

  return {
    status: 'unknown',
    marketCapClass: 'unknown',
    outcome: outcome.outcome,
    outcomeDetail,
    reason: outcomeDetail === null
      ? 'survived_without_outcome_detail'
      : `unrecognized_outcome_detail:${outcomeDetail}`,
  };
}

// ---------------------------------------------------------------------
// Position-lifecycle baseline (adapter feeding edpiLive.js's
// computeAnomalyRatio) — see this file's header.
// ---------------------------------------------------------------------

/**
 * @param {Array<{position, economics, category}>} processedPositions - ONE wallet's, from walletOutcomeProfile.js's buildWalletProcessedPositions
 * @param {number} minSampleSize
 */
function buildPositionLifecycleBaseline(processedPositions, minSampleSize) {
  const completed = (processedPositions || []).filter((p) => p.category === 'completed_meaningful');
  const capitalValues = completed.map((p) => p.position.totalSolBought);
  const entryMcValues = completed.filter((p) => p.economics.entryMc.available).map((p) => p.economics.entryMc.entryMcUsd);
  const capitalStats = computeDistributionStats(capitalValues);
  const entryMcStats = computeDistributionStats(entryMcValues);
  return {
    eligibleForBaseline: completed.length >= minSampleSize,
    positionSampleSize: completed.length,
    capitalSol: { available: capitalStats.sampleSize >= minSampleSize, ...capitalStats },
    entryMcUsd: { available: entryMcStats.sampleSize >= minSampleSize, ...entryMcStats },
  };
}

/**
 * Entry-MC and capital deviation, computed INDEPENDENTLY (spec section
 * 8's four states: neither/MC-only/capital-only/both must all remain
 * representable — never gated on each other here or by the caller).
 *
 * @param {number|null} currentEntryMcUsd
 * @param {number|null} currentCapitalSol
 * @param {ReturnType<typeof buildPositionLifecycleBaseline>} baseline
 * @param {number} minSampleSize
 */
function computeEntryMcAndCapitalDeviation(currentEntryMcUsd, currentCapitalSol, baseline, minSampleSize) {
  return {
    entryMc: computeAnomalyRatio(currentEntryMcUsd, baseline.entryMcUsd, minSampleSize),
    capital: computeAnomalyRatio(currentCapitalSol, baseline.capitalSol, minSampleSize),
  };
}

/**
 * Whether a computeAnomalyRatio result counts as "deviation flagged" for
 * cross-wallet PREVALENCE counting (spec section 12's "number exhibiting
 * the pattern"). An explicit, tunable research multiplier
 * (config.edpiBehavioralPatterns.deviationRatioMultiplier), same kind of
 * parameter as edpiLive.comparableEntryBandMultiplier — NOT a validated
 * threshold. Returns null (not decidable), never false, when the
 * underlying ratio itself wasn't available — "not flagged" and "can't
 * tell" must stay distinguishable all the way through.
 */
function isDeviationFlagged(anomalyResult, deviationRatioMultiplier) {
  if (!anomalyResult.available) return null;
  const ratio = anomalyResult.ratioToMedian;
  return ratio >= deviationRatioMultiplier || ratio <= 1 / deviationRatioMultiplier;
}

// ---------------------------------------------------------------------
// Dead/rugged & stable-survivor/pump-and-dump/unknown surrounding activity (spec section 5) —
// bought/held/sold distinction per spec doc's later "Holding versus
// selling" section: a position still `open` at data-capture time is
// "held", one that reached its major exit is "sold" — the most precise
// distinction position-lifecycle data can support without a live price
// feed.
// ---------------------------------------------------------------------

function emptyActivityBucket() {
  return {
    tokensTraded: 0,
    positionsHeld: 0,
    positionsSold: 0,
    capitalProfile: { available: false, sampleSize: 0, median: null, p25: null, p75: null, p90: null },
    holdDurationMsProfile: { available: false, sampleSize: 0, median: null, p25: null, p75: null, p90: null },
    mostRecentActivityAtMs: null,
    repeatedActivity: false,
  };
}

function computeWalletSurroundingActivity(processedPositions, outcomesByPair) {
  const buckets = {
    deadOrRugged: [],
    stableSurvivor: [],
    pumpAndDump: [],
    unknown: [],
  };
  const pairsByBucket = {
    deadOrRugged: new Set(),
    stableSurvivor: new Set(),
    pumpAndDump: new Set(),
    unknown: new Set(),
  };

  for (const p of processedPositions || []) {
    const { status } = classifyTokenStatus(outcomesByPair?.[p.position.pairAddress]);
    const key = status === 'dead_or_rugged'
      ? 'deadOrRugged'
      : status === 'stable_survivor'
        ? 'stableSurvivor'
        : status === 'pump_and_dump'
          ? 'pumpAndDump'
          : 'unknown';
    buckets[key].push(p);
    pairsByBucket[key].add(p.position.pairAddress);
  }

  const summarize = (positions, pairSet) => {
    if (positions.length === 0) return emptyActivityBucket();
    const capitalValues = positions.map((p) => p.position.totalSolBought);
    const completedWithDuration = positions.filter((p) => p.position.status === 'completed').map((p) => p.position.holdingDurationMs);
    const capitalStats = computeDistributionStats(capitalValues);
    const durationStats = computeDistributionStats(completedWithDuration);
    return {
      tokensTraded: pairSet.size,
      positionsHeld: positions.filter((p) => p.position.status === 'open').length,
      positionsSold: positions.filter((p) => p.position.status === 'completed').length,
      capitalProfile: { available: capitalStats.sampleSize > 0, ...capitalStats },
      holdDurationMsProfile: { available: durationStats.sampleSize > 0, ...durationStats },
      mostRecentActivityAtMs: Math.max(...positions.map((p) => p.position.lastActivityAtMs)),
      repeatedActivity: pairSet.size >= 2,
    };
  };

  return {
    deadOrRugged: summarize(buckets.deadOrRugged, pairsByBucket.deadOrRugged),
    stableSurvivor: summarize(buckets.stableSurvivor, pairsByBucket.stableSurvivor),
    pumpAndDump: summarize(buckets.pumpAndDump, pairsByBucket.pumpAndDump),
    unknown: summarize(buckets.unknown, pairsByBucket.unknown),
    marketCapClassification: {
      available: false,
      class: 'unknown',
      reason: 'no_historical_market_cap_evidence',
    },
  };
}

// ---------------------------------------------------------------------
// Repeated similar-size entries / repeated short-duration losses /
// consecutive loss sequence (spec section 7).
//
// Deliberately uses EVERY completed position (regardless of
// `meaningfulFloorMet`/category), unlike the historical-outcome profile
// in walletOutcomeProfile.js — the anti-farming floor there exists to
// stop a wash-trade pattern from inflating ROI/peak-MC statistics; HERE,
// detecting exactly that kind of repetitive small-scale activity is the
// whole point of the pattern, so excluding it first would hide the very
// thing being measured. "Realized loss" is approximated as this
// position's OWN reconstructed exit MC below its OWN entry MC (reuses
// the identical comparison walletOutcomeProfile.js's buybackExitAboveEntry
// already makes, just without the buyback-only restriction) — a more
// direct measure of what THIS wallet actually realized than the token's
// overall pattern_archive outcome would be, since a wallet can exit
// profitably before a token eventually rugs, or exit at a loss on a
// token that later "survives."
// ---------------------------------------------------------------------

function computeRepeatedPatternEvidence(processedPositions, config) {
  const completed = (processedPositions || [])
    .filter((p) => p.position.status === 'completed')
    .sort((a, b) => a.position.majorExitAtMs - b.position.majorExitAtMs);

  if (completed.length === 0) {
    return { available: false, reason: 'no_completed_positions' };
  }

  const recent = completed.slice(-config.recentPositionCount);

  const capitalValues = completed.map((p) => p.position.totalSolBought);
  const capitalStats = computeDistributionStats(capitalValues);
  const dispersion = capitalStats.median !== null && capitalStats.median > 0 && capitalStats.p75 !== null && capitalStats.p25 !== null
    ? (capitalStats.p75 - capitalStats.p25) / capitalStats.median
    : null;
  const repeatedSimilarSizeEntriesAvailable = capitalStats.sampleSize >= config.minSampleSize;
  const repeatedSimilarSizeEntries = {
    available: repeatedSimilarSizeEntriesAvailable,
    sampleSize: capitalStats.sampleSize,
    dispersion,
    // `flagged` must be null whenever `available` is false — an
    // insufficient sample is "not decidable," never a confident true/
    // false, and a caller (aggregateBehavioralPatternsAcrossWallets)
    // counts `flagged === true` toward prevalence without re-checking
    // `available` itself, so a stray boolean here would silently corrupt
    // that count.
    flagged: repeatedSimilarSizeEntriesAvailable && dispersion !== null ? dispersion <= config.similarSizeDispersionMax : null,
    medianCapitalSol: capitalStats.median,
  };

  const hasRealizedOutcome = (p) => p.economics.entryMc.available && p.economics.exitMc.available;
  const isRealizedLoss = (p) => p.economics.exitMc.marketCapUsd < p.economics.entryMc.entryMcUsd;
  const withRealizedOutcome = completed.filter(hasRealizedOutcome);
  const recentWithOutcome = recent.filter(hasRealizedOutcome);

  const repeatedShortDurationLosses = {
    available: recentWithOutcome.length > 0,
    recentSampleSize: recentWithOutcome.length,
    recentShortDurationLossCount: recentWithOutcome.filter((p) => p.position.holdingDurationMs <= config.shortDurationMs && isRealizedLoss(p)).length,
    recentLossProportion: recentWithOutcome.length > 0
      ? Number((recentWithOutcome.filter(isRealizedLoss).length / recentWithOutcome.length).toFixed(3))
      : null,
  };

  let consecutiveLossCount = 0;
  for (let i = withRealizedOutcome.length - 1; i >= 0; i -= 1) {
    if (isRealizedLoss(withRealizedOutcome[i])) consecutiveLossCount += 1;
    else break;
  }
  const consecutiveLossSequence = {
    available: withRealizedOutcome.length > 0,
    consecutiveLossCount,
    evaluatedSampleSize: withRealizedOutcome.length,
  };

  return { available: true, repeatedSimilarSizeEntries, repeatedShortDurationLosses, consecutiveLossSequence };
}

// ---------------------------------------------------------------------
// Recent-vs-established regime comparison (spec's "behavioral-regime
// analysis" section) — splits COMPLETED, meaningful positions
// chronologically into an "established" head and a "recent" tail
// (config.recentPositionCount long) and compares medians between the
// two, independently for entry MC and capital. Distinct from
// computeEntryMcAndCapitalDeviation above, which compares the CURRENT
// token against the wallet's WHOLE history — this compares the wallet's
// OWN recent history against its OWN older history, with no current-token
// involvement at all.
// ---------------------------------------------------------------------

function computeRecentVsEstablishedRegime(processedPositions, config) {
  const completed = (processedPositions || [])
    .filter((p) => p.category === 'completed_meaningful')
    .sort((a, b) => a.position.majorExitAtMs - b.position.majorExitAtMs);

  if (completed.length < config.minSampleSize * 2) {
    return { available: false, reason: 'insufficient_history_for_recent_vs_established_split', totalSampleSize: completed.length };
  }

  const recent = completed.slice(-config.recentPositionCount);
  const established = completed.slice(0, -config.recentPositionCount);
  if (established.length < config.minSampleSize || recent.length === 0) {
    return { available: false, reason: 'insufficient_positions_in_one_or_both_windows', establishedSampleSize: established.length, recentSampleSize: recent.length };
  }

  const compare = (extractor) => {
    const establishedValues = established.map(extractor).filter((v) => v !== null && Number.isFinite(v));
    const recentValues = recent.map(extractor).filter((v) => v !== null && Number.isFinite(v));
    const establishedStats = computeDistributionStats(establishedValues);
    if (establishedStats.median === null || recentValues.length === 0) return { available: false };
    const recentStats = computeDistributionStats(recentValues);
    return {
      available: true,
      establishedMedian: establishedStats.median,
      establishedSampleSize: establishedStats.sampleSize,
      recentMedian: recentStats.median,
      recentSampleSize: recentStats.sampleSize,
      ratioRecentToEstablished: establishedStats.median !== 0 ? Number((recentStats.median / establishedStats.median).toFixed(4)) : null,
    };
  };

  return {
    available: true,
    entryMc: compare((p) => (p.economics.entryMc.available ? p.economics.entryMc.entryMcUsd : null)),
    capital: compare((p) => p.position.totalSolBought),
  };
}

// ---------------------------------------------------------------------
// Per-wallet composite + cross-wallet prevalence (spec sections 12/13) —
// GENERAL BEHAVIORAL convergence only. Deliberately does NOT group by
// historical-token identity — that is the CTO-specific aggregation the
// spec's own "Important Correction" document says must stay a SEPARATE
// mechanism (same-token identity as the join key), not built in this
// pass — see docs/edpi-behavioral-patterns.md's "Deliberately not built"
// section.
// ---------------------------------------------------------------------

/**
 * @param {string} walletAddress
 * @param {Array<{position, economics, category}>} processedPositions - this wallet's, from walletOutcomeProfile.js
 * @param {Record<string,object>} outcomesByPair
 * @param {number|null} currentEntryMcUsd - the CURRENT token's own entry MC (typically its qualification-time snapshot market cap — same value for every wallet being compared)
 * @param {number|null} currentCapitalSol - this wallet's own current-token capital, in SOL, if reconstructable; null if not (see docs — never fabricated from a different unit)
 * @param {object} config - edpiBehavioralPatterns config block
 */
function evaluateWalletBehavioralProfile(walletAddress, processedPositions, outcomesByPair, currentEntryMcUsd, currentCapitalSol, config) {
  const baseline = buildPositionLifecycleBaseline(processedPositions, config.minSampleSize);
  const deviation = computeEntryMcAndCapitalDeviation(currentEntryMcUsd, currentCapitalSol, baseline, config.minSampleSize);
  return {
    walletAddress,
    baseline,
    entryMcDeviation: deviation.entryMc,
    entryMcDeviationFlagged: isDeviationFlagged(deviation.entryMc, config.deviationRatioMultiplier),
    capitalDeviation: deviation.capital,
    capitalDeviationFlagged: isDeviationFlagged(deviation.capital, config.deviationRatioMultiplier),
    surroundingActivity: computeWalletSurroundingActivity(processedPositions, outcomesByPair),
    repeatedPatterns: computeRepeatedPatternEvidence(processedPositions, config),
    recentVsEstablishedRegime: computeRecentVsEstablishedRegime(processedPositions, config),
  };
}

/**
 * Cross-wallet PATTERN prevalence — "how many of the evaluated wallets
 * independently exhibit each pattern," never "did they trade the same
 * tokens" (see this section's header). `eligibleWallets` per pattern is
 * always reported alongside `walletsExhibitingPattern` so a low count
 * can be read correctly as "few wallets had enough history" vs. "few
 * wallets showed the pattern" — collapsing those two would be
 * misleading, per the spec's own repeated emphasis on preserving
 * uncertainty rather than an artificially confident summary.
 *
 * @param {Array<ReturnType<typeof evaluateWalletBehavioralProfile>>} perWalletProfiles
 */
function aggregateBehavioralPatternsAcrossWallets(perWalletProfiles) {
  const list = perWalletProfiles || [];
  const countWhere = (pred) => list.filter(pred).length;
  const hasSurroundingActivity = (w) => (
    w.surroundingActivity.deadOrRugged.tokensTraded > 0
    || w.surroundingActivity.stableSurvivor.tokensTraded > 0
    || w.surroundingActivity.pumpAndDump.tokensTraded > 0
    || w.surroundingActivity.unknown.tokensTraded > 0
  );

  return {
    walletsEvaluated: list.length,
    entryMcDeviation: {
      eligibleWallets: countWhere((w) => w.entryMcDeviationFlagged !== null),
      walletsExhibitingPattern: countWhere((w) => w.entryMcDeviationFlagged === true),
    },
    capitalDeviation: {
      eligibleWallets: countWhere((w) => w.capitalDeviationFlagged !== null),
      walletsExhibitingPattern: countWhere((w) => w.capitalDeviationFlagged === true),
    },
    deadOrRuggedSurroundingActivity: {
      eligibleWallets: countWhere(hasSurroundingActivity),
      walletsExhibitingPattern: countWhere((w) => w.surroundingActivity.deadOrRugged.repeatedActivity),
    },
    stableSurvivorSurroundingActivity: {
      eligibleWallets: countWhere(hasSurroundingActivity),
      walletsExhibitingPattern: countWhere((w) => w.surroundingActivity.stableSurvivor.repeatedActivity),
    },
    pumpAndDumpSurroundingActivity: {
      eligibleWallets: countWhere((w) => w.surroundingActivity.deadOrRugged.tokensTraded > 0 || w.surroundingActivity.stableSurvivor.tokensTraded > 0 || w.surroundingActivity.pumpAndDump.tokensTraded > 0 || w.surroundingActivity.unknown.tokensTraded > 0),
      walletsExhibitingPattern: countWhere((w) => w.surroundingActivity.pumpAndDump.repeatedActivity),
    },
    repeatedSimilarSizeEntries: {
      eligibleWallets: countWhere((w) => w.repeatedPatterns.available && w.repeatedPatterns.repeatedSimilarSizeEntries.available),
      walletsExhibitingPattern: countWhere((w) => w.repeatedPatterns.available && w.repeatedPatterns.repeatedSimilarSizeEntries.flagged === true),
    },
    consecutiveLossSequence: {
      eligibleWallets: countWhere((w) => w.repeatedPatterns.available && w.repeatedPatterns.consecutiveLossSequence.available),
      walletsWithAtLeastTwoConsecutiveLosses: countWhere((w) => w.repeatedPatterns.available && w.repeatedPatterns.consecutiveLossSequence.consecutiveLossCount >= 2),
    },
    recentVsEstablishedRegimeShift: {
      eligibleWallets: countWhere((w) => w.recentVsEstablishedRegime.available),
    },
  };
}

module.exports = {
  classifyTokenStatus,
  buildPositionLifecycleBaseline,
  computeEntryMcAndCapitalDeviation,
  isDeviationFlagged,
  computeWalletSurroundingActivity,
  computeRepeatedPatternEvidence,
  computeRecentVsEstablishedRegime,
  evaluateWalletBehavioralProfile,
  aggregateBehavioralPatternsAcrossWallets,
};
