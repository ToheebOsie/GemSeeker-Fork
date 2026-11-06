'use strict';

/**
 * Production EDPI-L scoring layer.
 *
 * This module is deliberately pure. It consumes the wallet evidence already
 * reconstructed by the EDPI behavioral/position-lifecycle layers and returns
 * a fully auditable scoring package. It does not perform I/O, call an LLM, or
 * inspect discovery-outcome observations.
 */

const { computeDistributionStats } = require('./edpiLive');

const EDPI_L_SCORING_VERSION = 'edpi-l-scoring-v1';
const EDPI_L_STRENGTH_VERSION = 'edpi-l-strength-v1';
const ACTIVE_CLASSES = [1, 2, 4];
const POINTS_PER_WALLET = 2;
const MAX_SCORING_WALLETS = 5;
const MAX_CLASS_SCORE = POINTS_PER_WALLET * MAX_SCORING_WALLETS;

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validateScoringConfiguration(config = {}) {
  const minSampleSize = Number(config.minSampleSize);
  const deviationRatioMultiplier = Number(config.deviationRatioMultiplier);
  const shortDurationMs = Number(config.shortDurationMs);
  if (!Number.isFinite(minSampleSize) || !Number.isInteger(minSampleSize) || minSampleSize < 1) {
    throw new Error(`EDPI-L minSampleSize must be a finite integer >= 1; got ${config.minSampleSize}`);
  }
  if (!Number.isFinite(deviationRatioMultiplier) || deviationRatioMultiplier <= 1) {
    throw new Error(`EDPI-L deviationRatioMultiplier must be finite and > 1; got ${config.deviationRatioMultiplier}`);
  }
  if (!Number.isFinite(shortDurationMs) || shortDurationMs <= 0) {
    throw new Error(`EDPI-L shortDurationMs must be finite and > 0; got ${config.shortDurationMs}`);
  }
  return { minSampleSize, deviationRatioMultiplier, shortDurationMs };
}

function scoreFromQualifyingCount(count) {
  const qualifying = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
  return Math.min(qualifying, MAX_SCORING_WALLETS) * POINTS_PER_WALLET;
}

function deriveStrength(averageClassScore, activeClassCount) {
  const average = finiteOrNull(averageClassScore);
  const count = Number.isFinite(Number(activeClassCount)) ? Number(activeClassCount) : 0;
  if (count <= 0 || average === null) return 'No Active Scoring Evidence';

  if (average > 7) {
    if (count === 1) return 'Focused';
    if (count === 2) return 'Strong';
    if (count === 3) return 'Very Strong';
    return 'Exceptional';
  }

  if (count === 1) return 'Limited';
  if (count === 2) return 'Multi-Signal';
  if (count === 3) return 'Broad-Signal';
  return 'Multi-Dimensional';
}

function normalizeWalletEvidence(wallet, profile, currentEntryMcUsd, currentCapitalSol, config) {
  const baseline = profile?.baseline || {};
  const entryDeviation = profile?.entryMcDeviation || { available: false, status: 'not_available' };
  const capitalDeviation = profile?.capitalDeviation || { available: false, status: 'not_available' };
  const completed = Array.isArray(wallet?.processedPositions)
    ? wallet.processedPositions.filter((p) => p?.category === 'completed_meaningful')
    : [];

  const entryFlagged = profile?.entryMcDeviationFlagged === true;
  const capitalFlagged = profile?.capitalDeviationFlagged === true;

  // Class 4 reuses the existing behavioral-pattern evidence for the
  // relevant short-duration-loss observation instead of requiring the
  // latest completed position to be the loss. The historical holding
  // baseline is reconstructed from the same point-in-time completed
  // positions, so both sides of the comparison remain bounded by the
  // immutable evaluation cutoff supplied by the scanner.
  const holdingValues = completed
    .map((p) => p?.position?.holdingDurationMs)
    .filter((v) => Number.isFinite(v) && v >= 0);
  const shortDurationMs = Number(config.shortDurationMs);
  const holdingStats = computeDistributionStats(holdingValues);
  const derivedHoldingMedian = finiteOrNull(holdingStats.median);
  const class4BaselineAvailable = holdingValues.length >= Number(config.minSampleSize);
  const shortLossEvidence = profile?.repeatedPatterns?.repeatedShortDurationLosses || null;
  const shortLossCount = Number(shortLossEvidence?.recentShortDurationLossCount);
  const hasRelevantShortLoss = Number.isFinite(shortLossCount) && shortLossCount > 0;
  const class4Qualifies = class4BaselineAvailable &&
    derivedHoldingMedian !== null && derivedHoldingMedian > shortDurationMs &&
    hasRelevantShortLoss;

  const historySampleSize = Number.isFinite(Number(baseline.positionSampleSize)) ? Number(baseline.positionSampleSize) : completed.length;
  const hasAnyHistory = historySampleSize > 0 || Array.isArray(wallet?.processedPositions) && wallet.processedPositions.length > 0;
  const eligible = historySampleSize >= Number(config?.minSampleSize || 3);

  const status = eligible
    ? 'eligible'
    : hasAnyHistory
      ? 'insufficient_history'
      : 'insufficient_history';

  return {
    walletAddress: wallet?.walletAddress || null,
    holderPct: finiteOrNull(wallet?.holderPct),
    status,
    eligible,
    excluded: false,
    exclusionReason: null,
    historyDepth: historySampleSize,
    current: {
      entryMcUsd: finiteOrNull(currentEntryMcUsd),
      capitalSol: finiteOrNull(currentCapitalSol),
    },
    class1: {
      qualifying: entryFlagged,
      points: entryFlagged ? POINTS_PER_WALLET : 0,
      deviation: entryDeviation,
      baseline: baseline.entryMcUsd || { available: false, sampleSize: 0 },
      threshold: { type: 'ratio_to_median', multiplier: Number(config?.deviationRatioMultiplier || 2) },
    },
    class2: {
      qualifying: capitalFlagged,
      points: capitalFlagged ? POINTS_PER_WALLET : 0,
      deviation: capitalDeviation,
      baseline: baseline.capitalSol || { available: false, sampleSize: 0 },
      threshold: { type: 'ratio_to_median', multiplier: Number(config?.deviationRatioMultiplier || 2) },
    },
    class4: {
      qualifying: class4Qualifies,
      points: class4Qualifies ? POINTS_PER_WALLET : 0,
      historicalHoldDuration: {
        available: holdingValues.length > 0,
        sampleSize: holdingValues.length,
        medianMs: derivedHoldingMedian,
        sufficient: class4BaselineAvailable,
      },
      relevantShortDurationLoss: {
        available: shortLossEvidence !== null,
        recentShortDurationLossCount: Number.isFinite(shortLossCount) ? shortLossCount : null,
        shortDurationThresholdMs: shortDurationMs,
        source: 'behavioral.repeatedPatterns.repeatedShortDurationLosses',
      },
      qualificationReason: class4Qualifies
        ? 'relevant_short_duration_realized_loss_exists_and_is_below_established_hold_duration_baseline'
        : 'comparative_holding_behavior_not_qualified',
    },
  };
}

function buildReportOnlyEvidence(walletEvidence, walletProfiles, ctoEvidence, candidateWalletCount, candidateWallets) {
  const profiles = Array.isArray(walletProfiles) ? walletProfiles : [];
  const class3 = {
    historicalRoiAndPeakMc: profiles.map((w) => ({
      walletAddress: w.walletAddress,
      profile: w.profile || null,
    })),
  };

  const class6 = {
    repeatedSizeBehavior: walletEvidence.map((w) => ({
      walletAddress: w.walletAddress,
      evidence: w.behavioral?.repeatedPatterns?.repeatedSimilarSizeEntries || null,
      class2Relationship: w.class2?.qualifying ? 'represented_in_class_2' : 'not_class_2_qualifying',
    })),
  };

  const class7 = {
    deadOrRuggedActivity: walletEvidence.map((w) => ({
      walletAddress: w.walletAddress,
      evidence: w.behavioral?.surroundingActivity?.deadOrRugged || null,
    })),
  };

  const class8 = {
    stableHighMcActivity: walletEvidence.map((w) => ({
      walletAddress: w.walletAddress,
      evidence: w.behavioral?.surroundingActivity?.stableSurvivor || null,
      marketCapClassification: w.behavioral?.surroundingActivity?.marketCapClassification || { available: false, class: 'unknown' },
    })),
  };

  const top5Addresses = new Set((candidateWallets || []).slice(0, 5).map((w) => w.owner || w.walletAddress));
  const top5Evidence = walletEvidence.filter((w) => top5Addresses.has(w.walletAddress));
  const class9 = {
    top5BehavioralConvergence: {
      candidateWalletCount: Number.isFinite(Number(candidateWalletCount)) ? Number(candidateWalletCount) : null,
      top5WalletCount: top5Addresses.size,
      eligibleWalletCount: top5Evidence.filter((w) => w.eligible).length,
      class1QualifyingWallets: top5Evidence.filter((w) => w.class1.qualifying).length,
      class2QualifyingWallets: top5Evidence.filter((w) => w.class2.qualifying).length,
      class4QualifyingWallets: top5Evidence.filter((w) => w.class4.qualifying).length,
      overlapAllThree: top5Evidence.filter((w) => w.class1.qualifying && w.class2.qualifying && w.class4.qualifying).length,
      overlapClass1Class2: top5Evidence.filter((w) => w.class1.qualifying && w.class2.qualifying).length,
    },
  };

  const class10 = {
    ctoSharedTokenEvidence: ctoEvidence || { available: false, status: 'not_attempted' },
  };

  return { class3, class6, class7, class8, class9, class10 };
}

/**
 * Build the complete production EDPI-L evaluation.
 *
 * `walletProfiles` should be derived from the existing position-lifecycle
 * evidence. `behavioralProfiles` should be the corresponding outputs from
 * edpiBehavioralPatterns.evaluateWalletBehavioralProfile.
 */
function calculateEdpiL({
  candidateWallets = [],
  walletProfiles = [],
  behavioralProfiles = [],
  currentEntryMcUsd = null,
  currentCapitalByWallet = {},
  ctoEvidence = null,
  config = {},
  scoringVersion = EDPI_L_SCORING_VERSION,
  strengthVersion = EDPI_L_STRENGTH_VERSION,
  evaluationAtMs = null,
  rawCandidateWalletCount = null,
} = {}) {
  const scoringConfig = validateScoringConfiguration({
    minSampleSize: config.minSampleSize === undefined ? 3 : config.minSampleSize,
    deviationRatioMultiplier: config.deviationRatioMultiplier === undefined ? 2 : config.deviationRatioMultiplier,
    shortDurationMs: config.shortDurationMs === undefined ? 3 * 60 * 60 * 1000 : config.shortDurationMs,
  });

  const rawCandidateWalletCountResolved = rawCandidateWalletCount !== null && rawCandidateWalletCount !== undefined
    && Number.isFinite(Number(rawCandidateWalletCount)) && Number(rawCandidateWalletCount) >= 0
    ? Math.trunc(Number(rawCandidateWalletCount))
    : (Array.isArray(candidateWallets) ? candidateWallets.length : 0);
  const candidateByWallet = new Map((candidateWallets || [])
    .filter((w) => w && (w.owner || w.walletAddress))
    .map((w) => [w.owner || w.walletAddress, w]));
  const profileByWallet = new Map((walletProfiles || []).map((w) => [w.walletAddress, w]));
  const behavioralByWallet = new Map((behavioralProfiles || []).map((w) => [w.walletAddress, w]));

  const excluded = [];
  const insufficientHistory = [];
  const eligibleEvidence = [];

  for (const [walletAddress, holder] of candidateByWallet.entries()) {
    const walletProfile = profileByWallet.get(walletAddress);
    const behavioral = behavioralByWallet.get(walletAddress);
    if (!walletProfile || !behavioral) {
      const missing = {
        walletAddress,
        holderPct: finiteOrNull(holder?.pct),
        status: 'insufficient_history',
        eligible: false,
        excluded: false,
        exclusionReason: null,
        reason: !walletProfile ? 'no_position_history' : 'behavioral_profile_unavailable',
        historyDepth: 0,
        current: { entryMcUsd: finiteOrNull(currentEntryMcUsd), capitalSol: finiteOrNull(currentCapitalByWallet[walletAddress] ?? null) },
        class1: { qualifying: false, points: 0, baseline: { available: false, sampleSize: 0 }, deviation: { available: false, status: 'insufficient_history' } },
        class2: { qualifying: false, points: 0, baseline: { available: false, sampleSize: 0 }, deviation: { available: false, status: 'insufficient_history' } },
        class4: { qualifying: false, points: 0, historicalHoldDuration: { available: false, sampleSize: 0, medianMs: null, sufficient: false }, relevantShortDurationLoss: { available: false }, qualificationReason: 'insufficient_history' },
        behavioral: behavioral || null,
        walletProfile: walletProfile?.profile || null,
      };
      insufficientHistory.push(missing);
      eligibleEvidence.push(missing);
      continue;
    }

    const evidence = normalizeWalletEvidence(
      { walletAddress, holderPct: holder?.pct, processedPositions: walletProfile.processedPositions },
      behavioral,
      currentEntryMcUsd,
      currentCapitalByWallet[walletAddress] ?? null,
      scoringConfig,
    );
    evidence.behavioral = behavioral;
    evidence.walletProfile = walletProfile.profile || null;
    eligibleEvidence.push(evidence);
    if (!evidence.eligible) insufficientHistory.push(evidence);
  }

  // Candidate wallets rejected before scoring (for example infrastructure
  // exclusions) are already absent from candidateWallets. Keep the explicit
  // count separate so the final record can distinguish population selection
  // from insufficient history.
  const excludedWallets = Array.isArray(config.excludedWallets) ? config.excludedWallets : [];
  const excludedWalletCount = Number.isFinite(Number(config.excludedWalletCount))
    ? Number(config.excludedWalletCount)
    : excludedWallets.length;

  for (const excluded of excludedWallets) {
    eligibleEvidence.push({
      walletAddress: excluded.owner || null,
      holderPct: finiteOrNull(excluded.pct),
      status: 'excluded',
      eligible: false,
      excluded: true,
      exclusionReason: excluded.type ? `infrastructure:${excluded.type}` : 'infrastructure',
      historyDepth: null,
      current: { entryMcUsd: finiteOrNull(currentEntryMcUsd), capitalSol: null },
      class1: { qualifying: false, points: 0, baseline: { available: false, sampleSize: 0 }, deviation: { available: false, status: 'excluded' } },
      class2: { qualifying: false, points: 0, baseline: { available: false, sampleSize: 0 }, deviation: { available: false, status: 'excluded' } },
      class4: { qualifying: false, points: 0, historicalHoldDuration: { available: false, sampleSize: 0, medianMs: null, sufficient: false }, relevantShortDurationLoss: { available: false }, qualificationReason: 'excluded_wallet' },
      behavioral: null,
      walletProfile: null,
    });
  }

  const qualifying = {
    class1: eligibleEvidence.filter((w) => w.eligible && w.class1?.qualifying),
    class2: eligibleEvidence.filter((w) => w.eligible && w.class2?.qualifying),
    class4: eligibleEvidence.filter((w) => w.eligible && w.class4?.qualifying),
  };

  const classScores = {
    class_1: scoreFromQualifyingCount(qualifying.class1.length),
    class_2: scoreFromQualifyingCount(qualifying.class2.length),
    class_4: scoreFromQualifyingCount(qualifying.class4.length),
  };

  const activeClassCount = ACTIVE_CLASSES.filter((n) => classScores[`class_${n}`] > 0).length;
  const activeScores = ACTIVE_CLASSES.map((n) => classScores[`class_${n}`]).filter((score) => score > 0);
  const averageClassScore = activeScores.length > 0
    ? activeScores.reduce((sum, score) => sum + score, 0) / activeScores.length
    : 0;
  const edpiLScore = averageClassScore;
  const strengthLabel = deriveStrength(averageClassScore, activeClassCount);

  const reportOnlyEvidence = buildReportOnlyEvidence(
    eligibleEvidence,
    walletProfiles,
    ctoEvidence,
    candidateWallets.length,
    candidateWallets,
  );

  return {
    edpi_l_scoring_version: scoringVersion,
    evaluation_at_ms: finiteOrNull(evaluationAtMs),
    edpi_l_strength_version: strengthVersion,
    scoring_configuration: {
      min_history_sample_size: scoringConfig.minSampleSize,
      material_deviation_ratio_multiplier: scoringConfig.deviationRatioMultiplier,
      short_duration_threshold_ms: scoringConfig.shortDurationMs,
      points_per_qualifying_wallet: POINTS_PER_WALLET,
      max_scoring_wallets_per_class: MAX_SCORING_WALLETS,
      max_class_score: MAX_CLASS_SCORE,
      active_scoring_classes: ACTIVE_CLASSES,
      class_5_is_non_additive: true,
    },
    class_scores: classScores,
    class_5_composite: classScores.class_1 > 0 && classScores.class_2 > 0
      ? (classScores.class_1 + classScores.class_2) / 2
      : null,
    active_class_count: activeClassCount,
    average_class_score: averageClassScore,
    edpi_l_score: edpiLScore,
    score_status: activeClassCount > 0 ? 'scored' : 'no_active_scoring_evidence',
    strength_label: strengthLabel,
    qualifying_wallet_counts: {
      class_1: qualifying.class1.length,
      class_2: qualifying.class2.length,
      class_4: qualifying.class4.length,
    },
    scoring_wallet_counts: {
      class_1: Math.min(qualifying.class1.length, MAX_SCORING_WALLETS),
      class_2: Math.min(qualifying.class2.length, MAX_SCORING_WALLETS),
      class_4: Math.min(qualifying.class4.length, MAX_SCORING_WALLETS),
    },
    wallet_sample_size: candidateByWallet.size,
    raw_candidate_wallet_count: rawCandidateWalletCountResolved,
    unique_candidate_wallet_count: candidateByWallet.size,
    eligible_wallet_count: eligibleEvidence.filter((w) => w.eligible).length,
    insufficient_history_count: insufficientHistory.length,
    excluded_wallet_count: excludedWalletCount,
    data_coverage: {
      candidate_wallet_count: candidateByWallet.size,
      raw_candidate_wallet_count: rawCandidateWalletCountResolved,
      unique_candidate_wallet_count: candidateByWallet.size,
      wallets_with_position_profiles: profileByWallet.size,
      wallets_with_behavioral_profiles: behavioralByWallet.size,
      wallets_with_current_capital: eligibleEvidence.filter((w) => w.current.capitalSol !== null).length,
      current_entry_mc_available: finiteOrNull(currentEntryMcUsd) !== null,
      historical_entry_mc_eligible_wallets: eligibleEvidence.filter((w) => w.class1.baseline.available).length,
      historical_capital_eligible_wallets: eligibleEvidence.filter((w) => w.class2.baseline.available).length,
      class4_baseline_eligible_wallets: eligibleEvidence.filter((w) => w.class4.historicalHoldDuration.sufficient).length,
    },
    wallet_evidence: eligibleEvidence,
    report_only_evidence: reportOnlyEvidence,
    no_lookahead: {
      evaluation_at_ms: finiteOrNull(evaluationAtMs),
      discovery_outcome_learning_used: false,
      future_price_or_market_cap_used: false,
      future_peak_or_drawdown_used: false,
      future_liquidity_or_volume_used: false,
    },
  };
}

function attachEdpiLResult(evidence, result) {
  if (result) evidence.edpiL = result;
  return evidence;
}

module.exports = {
  EDPI_L_SCORING_VERSION,
  EDPI_L_STRENGTH_VERSION,
  ACTIVE_CLASSES,
  scoreFromQualifyingCount,
  deriveStrength,
  calculateEdpiL,
  attachEdpiLResult,
  validateScoringConfiguration,
};
