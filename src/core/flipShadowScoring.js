'use strict';

const { FLIP_TIERS, hasTier, predictWithKey } = require('./flipBaseline');
const { key, mean } = require('./mlBaseline');
const { predictCalibrated, hasUsableFeatures } = require('./flipFeatureModel');
const { loadFlipShadowModel } = require('./flipShadowModelLoader');
const { loadFlipFeatureModel } = require('./flipFeatureModelLoader');

/**
 * Turns a trained flip baseline (flipBaseline.js's trainBaseline output) and
 * a computeObservedPeak-style resolution signal (audit-training-data.js)
 * into a live shadow-prediction/scoring loop — the piece identified as
 * missing while investigating whether "shadow mode" (option 3) was already
 * usable for big_flip: everything in this pipeline already runs
 * shadow-only, but nothing scored a shadow prediction against what a token
 * actually went on to do. This module is that scoring logic, kept fully
 * pure and DB-free on purpose (mirrors flipBaseline.js/mlPromotion.js's own
 * separation of pure scoring from I/O) so it can be tested without a
 * database — the actual persistence/backfill loop lives in
 * scripts/score-flip-shadow-predictions.js and is NOT covered by these
 * tests, since it needs a real database this sandbox doesn't have access
 * to; see that script's header for what still needs verifying before it's
 * trusted in production.
 *
 * Deliberately reuses, not reimplements: predictWithKey/FLIP_TIERS/hasTier
 * (flipBaseline.js), brier/mean/key (mlBaseline.js), and flipTier()
 * (build-flip-dataset.js) — the last one specifically so a live prediction
 * can never be scored against a DIFFERENT definition of "big_flip" than the
 * offline dataset used to train the model that made the prediction. Same
 * "one definition, not two" principle this session has followed throughout
 * (computeObservedPeak, chronologicalGroupedSplit's embargo logic, etc).
 *
 * build-flip-dataset.js is required LAZILY (inside scoreFlipShadowPrediction
 * below), not at module top level, even though that function is the only
 * user of it — confirmed the hard way: tokenScanner.js requires this whole
 * file to reach attachFlipShadowPrediction, so a top-level require here
 * made the live bot process's ability to boot at all depend on
 * scripts/build-flip-dataset.js existing in the deployed container, even
 * though attachFlipShadowPrediction never touches it. That's exactly
 * backwards for a feature whose entire premise is "cannot affect the live
 * alert path" — a missing/misconfigured scripts/ directory should disable
 * offline shadow-scoring, not crash Telegram alerts. A lazy require moves
 * that failure to where score-flip-shadow-predictions.js actually calls
 * this function, which is a batch job, not the bot process.
 */

const SHADOW_PREDICTION_SCHEMA_VERSION = 'flip-shadow-prediction-v1';

// tierModels: { no_flip: <trainTier() model>, small_flip: <...>, big_flip: <...> }
// — i.e. Object.fromEntries(FLIP_TIERS.map(t => [t, baselineResult.tiers[t]?.model]))
// from a train-flip-baseline.js run. A tier with no trained model (gate
// didn't pass) is skipped, not defaulted to some fabricated probability.
function predictFlipTierProbabilities(tierModels, row, keyFn = key) {
  const probabilities = {};
  for (const tier of FLIP_TIERS) {
    const model = tierModels[tier];
    if (model) probabilities[tier] = predictWithKey(model, row, keyFn);
  }
  return probabilities;
}

/**
 * Built at qualification time, when signalLabel/riskLevel are known but the
 * eventual flipTier is not. Intentionally uses the PLAIN key() (signalLabel|
 * riskLevel) model, not flipBaseline.js's exposure-augmented variant —
 * walletExposedWalletCount's availability at the exact moment of
 * qualification (vs. filled in by a later join) wasn't verified this
 * session, and predicting with a field that might not actually be populated
 * yet would silently fall back to every group's globalProbability without
 * any signal that the intended feature was missing. Safer to under-use a
 * feature we're not sure is live than to spuriously look like it's being
 * used.
 */
function buildFlipShadowPrediction({ tierModels, modelVersion, row, keyFn = key, predictedAt = new Date().toISOString() }) {
  return {
    schemaVersion: SHADOW_PREDICTION_SCHEMA_VERSION,
    modelVersion,
    predictedAt,
    groupKey: keyFn(row),
    tierProbabilities: predictFlipTierProbabilities(tierModels, row, keyFn),
    scoredOutcome: null,
  };
}

/**
 * The live hot-path integration point: tokenScanner.js calls this right
 * after building its evidence object, with signalLabel/riskLevel already
 * in scope at that call site (verified by reading tokenScanner.js
 * directly — both are plain local variables computed earlier in the same
 * function, not something this had to guess at). Mutates and returns
 * `evidence` for a convenient call-site one-liner, but NEVER throws: a
 * missing model file (loadFlipShadowModel already handles that, returning
 * null), a bad row shape, or anything else in here degrades to "no
 * flipShadowPrediction attached this run," logged once, never an
 * exception that could interrupt alert_decisions persistence — the same
 * non-negotiable requirement this whole module was built to respect
 * (docs/gemseeker-engineering-skill/SKILL.md: never let a research feature
 * accidentally break core alert behavior).
 *
 * NOT exercised against the live scanner in this session (no way to run
 * tokenScanner.js's actual scan loop without live Solana/DexScreener/DB
 * access) — covered instead by flipShadowModelLoader's own tests (every
 * failure mode of loadFlipShadowModel) and this file's own tests (the
 * prediction-building logic once a model IS loaded). The one thing not
 * independently verified is this exact call site inside tokenScanner.js;
 * treat that edit as needing a smoke-test before trusting it in
 * production, same as the DB-touching scripts.
 */
function attachFlipShadowPrediction(evidence, { signalLabel, riskLevel } = {}) {
  try {
    const model = loadFlipShadowModel();
    if (!model) return evidence;
    evidence.flipShadowPrediction = buildFlipShadowPrediction({ tierModels: model.tierModels, modelVersion: model.modelVersion, row: { signalLabel, riskLevel } });
  } catch (error) {
    console.error(`[flipShadowScoring] attachFlipShadowPrediction failed, continuing without it: ${error.message}`);
  }
  return evidence;
}

/**
 * Second, independent live prediction path — the flip_tier_logistic_
 * regression_v1 model (flipFeatureModel.js/train-flip-feature-model.js),
 * wired in after the empirical group-rate baseline above came back with no
 * measurable edge over the plain population base rate on real live-scored
 * data (191 scored predictions, argmaxAccuracy exactly equal to no_flip's
 * own positive rate — i.e. the baseline's argmax never once picked
 * small_flip or big_flip). Kept as a fully separate attach/predict path,
 * not a branch inside the functions above, for the same reason
 * flipBaseline.js and flipFeatureModel.js are separate files: the two
 * models need genuinely different inputs (signalLabel|riskLevel vs. a
 * captured featureSnapshot) and can be trained, deployed, or missing
 * independently of one another.
 *
 * scoreFlipShadowPrediction/aggregateFlipShadowScores below are REUSED
 * as-is for this model too, not duplicated — both only ever operate on the
 * generic {tierProbabilities, scoredOutcome} shape built here, never on
 * anything baseline-specific (predictWithKey/groupKey are never
 * referenced by either function). One scoring implementation for both
 * models, same "one definition, not two" principle as everywhere else in
 * this pipeline.
 */
function predictFeatureModelTierProbabilities(tierModels, row) {
  const probabilities = {};
  for (const tier of FLIP_TIERS) {
    const model = tierModels[tier];
    if (model) probabilities[tier] = predictCalibrated(model, model.calibration, row);
  }
  return probabilities;
}

const FEATURE_MODEL_SHADOW_PREDICTION_SCHEMA_VERSION = 'flip-feature-model-shadow-prediction-v1';

function buildFeatureModelShadowPrediction({ tierModels, modelType, row, predictedAt = new Date().toISOString() }) {
  return {
    schemaVersion: FEATURE_MODEL_SHADOW_PREDICTION_SCHEMA_VERSION,
    modelType,
    predictedAt,
    tierProbabilities: predictFeatureModelTierProbabilities(tierModels, row),
    scoredOutcome: null,
  };
}

/**
 * Live hot-path integration point, called alongside (not instead of)
 * attachFlipShadowPrediction — see tokenScanner.js. row must be
 * { featureSnapshot, hasFeatureSnapshot: true } built via
 * alertDecision.js's buildFeatureSnapshot, the SAME function that builds
 * what actually gets persisted to alert_decisions.feature_snapshot, so the
 * live model sees byte-identical feature shape to what it was trained on.
 * Never throws, degrades to "no flipShadowPredictionFeatureModel attached
 * this run" on any failure (missing model file, no featureSnapshot yet,
 * etc.) — identical contract to attachFlipShadowPrediction, and
 * deliberately wrapped in its OWN try/catch so a problem with one model
 * can never suppress the other.
 */
function attachFeatureModelShadowPrediction(evidence, row) {
  try {
    const model = loadFlipFeatureModel();
    if (!model) return evidence;
    if (!hasUsableFeatures(row)) return evidence;
    evidence.flipShadowPredictionFeatureModel = buildFeatureModelShadowPrediction({ tierModels: model.tierModels, modelType: model.modelType, row });
  } catch (error) {
    console.error(`[flipShadowScoring] attachFeatureModelShadowPrediction failed, continuing without it: ${error.message}`);
  }
  return evidence;
}

/**
 * peakRow must already have passed computeObservedPeak's
 * includedInEnrichment gate (rolledOverFromPeak === true) — this function
 * doesn't re-check that, it trusts the caller already filtered for
 * resolved-only rows, matching computeObservedPeak's own documented
 * rationale for why an unresolved peak must never be treated as final.
 */
function scoreFlipShadowPrediction(prediction, { observedPeakRoiMultiple, config, resolvedAt = new Date().toISOString() }) {  // Lazy, call-time require — see the module header for why this can't be
  // a top-level require. Wrapped with a clearer error than Node's default
  // MODULE_NOT_FOUND, since this function is the one place that failure
  // should actually surface (a batch job log), not a bot crash loop.
  let computeFlipTier;
  try {
    ({ flipTier: computeFlipTier } = require('../../scripts/build-flip-dataset'));
  } catch (error) {
    throw new Error(`scoreFlipShadowPrediction: could not load scripts/build-flip-dataset.js (${error.message}). This only affects offline shadow scoring, not the live bot.`);
  }
  const actualTier = computeFlipTier(observedPeakRoiMultiple, config);
  if (!hasTier({ flipTier: actualTier })) return null;
  const perTierBrier = {};
  for (const tier of FLIP_TIERS) {
    const probability = prediction.tierProbabilities[tier];
    if (probability === undefined) continue;
    const actual = actualTier === tier ? 1 : 0;
    perTierBrier[tier] = (probability - actual) ** 2;
  }
  const predictedTier = Object.entries(prediction.tierProbabilities)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    resolvedAt,
    observedPeakRoiMultiple,
    actualTier,
    perTierBrier,
    predictedTier,
    argmaxCorrect: predictedTier !== null ? predictedTier === actualTier : null,
  };
}

/**
 * scoredPredictions: array of { tierProbabilities, scoredOutcome } records
 * (the shape stored in live_evidence->'flipShadowPrediction' once scored).
 * Mirrors flipBaseline.js's evaluate() output shape (brierScore/count) so
 * live and offline numbers can be read side by side without translating
 * field names, but this is a DIFFERENT population (live, later-resolved
 * predictions) from evaluate()'s offline validation/test rows — the two
 * should be compared, never merged.
 */
function aggregateFlipShadowScores(scoredPredictions) {
  const scored = scoredPredictions.filter((p) => p.scoredOutcome);
  const byTier = {};
  for (const tier of FLIP_TIERS) {
    const withTier = scored.filter((p) => p.scoredOutcome.perTierBrier[tier] !== undefined);
    byTier[tier] = {
      count: withTier.length,
      brierScore: withTier.length ? mean(withTier.map((p) => p.scoredOutcome.perTierBrier[tier])) : null,
      positiveCount: withTier.filter((p) => p.scoredOutcome.actualTier === tier).length,
    };
  }
  const withArgmax = scored.filter((p) => p.scoredOutcome.argmaxCorrect !== null);
  return {
    totalScored: scored.length,
    totalPending: scoredPredictions.length - scored.length,
    argmaxAccuracy: withArgmax.length ? mean(withArgmax.map((p) => (p.scoredOutcome.argmaxCorrect ? 1 : 0))) : null,
    byTier,
  };
}

module.exports = {
  SHADOW_PREDICTION_SCHEMA_VERSION,
  FEATURE_MODEL_SHADOW_PREDICTION_SCHEMA_VERSION,
  predictFlipTierProbabilities,
  buildFlipShadowPrediction,
  attachFlipShadowPrediction,
  predictFeatureModelTierProbabilities,
  buildFeatureModelShadowPrediction,
  attachFeatureModelShadowPrediction,
  scoreFlipShadowPrediction,
  aggregateFlipShadowScores,
};
