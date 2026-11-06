'use strict';

const { FEATURE_FIELDS, hasUsableFeatures, trainTier, calibrate, evaluate, predictCalibrated } = require('./flipFeatureModel');
const { WALLET_FEATURE_FIELDS } = require('./walletExperienceFeatures');
const { loadFlipWalletShadowModel } = require('./flipWalletShadowModelLoader');

/**
 * Wallet-enhanced flip shadow model — a SEPARATE experiment from
 * flipBaseline.js/flipFeatureModel.js's existing no_flip/small_flip/
 * big_flip tier models, not a fourth tier bolted onto that system. The
 * historical offline analysis (run against a local Postgres dump, not in
 * this repo) found experienced-wallet features add measurable ROC-AUC
 * over the existing feature set specifically for a >= 5x peak-ROI binary
 * target — a genuinely different label shape from flipTier's 1.5x/3x
 * tier boundaries, so this gets its own target function rather than
 * reusing flipBaseline.js's target()/FLIP_TIERS.
 *
 * Trains and predicts TWO models side by side for this one target:
 *   - baseline: existing qualification-time features only
 *     (flipFeatureModel.js's own FEATURE_FIELDS) — the existing feature
 *     set, just retargeted at hit_5x instead of the flipTier tiers.
 *   - walletEnhanced: FEATURE_FIELDS + the three wallet-experience
 *     features (walletExperienceFeatures.js's WALLET_FEATURE_FIELDS).
 *
 * Deliberately reuses flipFeatureModel.js's trainTier/calibrate/evaluate
 * (generalized there to accept an optional targetFn/hasTargetFn, default
 * flipTier-shaped, so those existing exports and their existing callers
 * are unchanged) rather than a second, parallel logistic-regression
 * implementation — one definition of "train/calibrate/evaluate a
 * feature-vector model," not two that could quietly drift, same
 * principle this codebase applies everywhere else a computation is
 * shared across call sites (computeObservedPeak, chronologicalGroupedSplit,
 * flipTier(), etc — see this project's own established comments on that).
 *
 * Strictly shadow-only, exactly like the two existing flipShadowScoring.js
 * models: attachWalletShadowPrediction below only ever ADDS a new key to
 * the live_evidence object tokenScanner.js is already building
 * (flipWalletShadowPrediction, alongside the existing
 * flipShadowPrediction/flipShadowPredictionFeatureModel keys) and never
 * throws, never touches qualification/signal/riskLevel/alert broadcasting.
 */

const HIT_5X_TARGET = 'hit_5x';
const HIT_5X_THRESHOLD = 5;

// The current sample is too sparse for a reliable >= 10x target (see the
// implementation spec this module was built from) — hit_5x is the only
// primary training target this module supports. Do not add a >= 10x
// variant here without re-checking sample size first.
function hasHit5xLabel(row) { return Number.isFinite(row.peakRoiMultiple); }
function hit5xTarget(row) { return row.peakRoiMultiple >= HIT_5X_THRESHOLD ? 1 : 0; }

const WALLET_ENHANCED_FIELDS = FEATURE_FIELDS.concat(WALLET_FEATURE_FIELDS);

// Fixed identifiers for the two model VARIANTS of this one target — not a
// hash (see flipWalletShadowModelLoader.js for the actual artifact hash,
// computed from the real persisted model file, never hard-coded). Bump
// the trailing version suffix if FEATURE_FIELDS/WALLET_FEATURE_FIELDS
// composition or the training methodology changes in a way that makes an
// old model.json incomparable with a new one.
const MODEL_VERSIONS = {
  baseline: 'flip-hit5x-baseline-v1',
  walletEnhanced: 'flip-hit5x-wallet-enhanced-v1',
};

/**
 * Trains both variants for the hit_5x target against the SAME
 * chronological/mint-grouped/embargoed train/validation/test split
 * split-flip-dataset.js already produces for the existing flip-tier
 * models — reused as-is, not re-split, per the implementation spec's
 * "keep the existing chronological/mint-grouped evaluation methodology."
 *
 * Single shared gate (not one gate per variant) — both variants train
 * off the exact same rows (same hasHit5xLabel/hasUsableFeatures filter,
 * neither variant has a feature that could make more/fewer rows usable
 * than the other), so a single trainCount/validationCount/testCount
 * correctly describes both.
 */
function trainWalletShadowModels(trainRows, validationRows, testRows, { minTrain = 50, minValidation = 10, minTest = 10, fields: callerFieldsOverride, ...regressionOptions } = {}) {
  // callerFieldsOverride is deliberately destructured out and discarded,
  // not forwarded — regressionOptions gets spread into trainTier's call
  // below AFTER the per-variant `fields` (see the loop), so a stray
  // `fields` key surviving in regressionOptions would silently overwrite
  // the intended per-variant field set for BOTH baseline and
  // walletEnhanced, collapsing them onto whatever was passed here. That's
  // not a hypothetical: constructing this exact input confirmed it
  // (identical model.featureNames for both variants, silently wrong, no
  // error) before this line existed. This function trains BOTH variants
  // as a pair by design — overriding the field set for one without the
  // other doesn't have a coherent meaning here, so it's rejected loudly
  // rather than silently accepted for one variant and silently ignored
  // for the metadata that claims to describe it.
  if (callerFieldsOverride !== undefined) {
    console.error('[flipWalletShadowModel] trainWalletShadowModels does not accept a fields override — baseline/walletEnhanced field sets are fixed by design; ignoring the passed value.');
  }
  const usable = (rows) => rows.filter((row) => hasHit5xLabel(row) && hasUsableFeatures(row));
  const trainCount = usable(trainRows).length;
  const validationCount = usable(validationRows).length;
  const testCount = usable(testRows).length;
  const gate = { trainCount, validationCount, testCount, pass: trainCount >= minTrain && validationCount >= minValidation && testCount >= minTest };

  const result = { targetName: HIT_5X_TARGET, threshold: HIT_5X_THRESHOLD, trainable: gate.pass, gate, baseline: null, walletEnhanced: null };
  if (!gate.pass) return result;

  const variantFields = { baseline: FEATURE_FIELDS, walletEnhanced: WALLET_ENHANCED_FIELDS };
  const targetOptions = { targetFn: hit5xTarget, hasTargetFn: hasHit5xLabel };

  for (const [variantName, fields] of Object.entries(variantFields)) {
    const model = trainTier(trainRows, HIT_5X_TARGET, { fields, ...targetOptions, ...regressionOptions });
    // Calibration fit on validation only, never train/test — identical
    // rule and reasoning as flipFeatureModel.js's own calibrate() header.
    // fields passed through so calibrate()'s internal predictLogit call
    // resolves model.featureNames against the SAME pool this variant was
    // trained with (see fieldsByName's own header for why this matters).
    const calibration = calibrate(model, validationRows, HIT_5X_TARGET, { fields, ...targetOptions });
    result[variantName] = {
      modelVersion: MODEL_VERSIONS[variantName],
      featureFieldNames: fields.map((f) => f.name),
      model,
      calibration,
      validation: evaluate(model, validationRows, HIT_5X_TARGET, null, { fields, ...targetOptions }),
      test: evaluate(model, testRows, HIT_5X_TARGET, null, { fields, ...targetOptions }),
      validationCalibrated: evaluate(model, validationRows, HIT_5X_TARGET, calibration, { fields, ...targetOptions }),
      testCalibrated: evaluate(model, testRows, HIT_5X_TARGET, calibration, { fields, ...targetOptions }),
    };
  }
  return result;
}

const WALLET_SHADOW_PREDICTION_SCHEMA_VERSION = 'flip-wallet-shadow-prediction-v1';
// Describes the WALLET-ENHANCED feature composition specifically
// (FEATURE_FIELDS + WALLET_FEATURE_FIELDS), a narrower claim than
// alertDecision.js's own FEATURE_SCHEMA_VERSION (which describes the
// whole featureSnapshot shape all consumers read from) — bump this if
// WALLET_ENHANCED_FIELDS' composition changes, independent of whether
// featureSnapshot's own shape changed at all.
const WALLET_SHADOW_FEATURE_SCHEMA_VERSION = 'flip-wallet-shadow-features-v1';

/**
 * Builds the live_evidence record for this experiment — both the
 * baseline and wallet-enhanced probabilities, both model versions, and
 * both model hashes, exactly as the implementation spec's live_evidence
 * section requires. `row` must be the SAME { featureSnapshot,
 * hasFeatureSnapshot: true } shape attachFeatureModelShadowPrediction
 * already requires (built via alertDecision.js's buildFeatureSnapshot) —
 * both baseline and walletEnhanced predict off this one row, so the
 * baseline here is judged on the exact same example as the
 * wallet-enhanced model, not a different slice of data.
 */
function buildWalletShadowPrediction({ baseline, walletEnhanced, row, predictedAt = new Date().toISOString() }) {
  return {
    schemaVersion: WALLET_SHADOW_PREDICTION_SCHEMA_VERSION,
    featureSchemaVersion: WALLET_SHADOW_FEATURE_SCHEMA_VERSION,
    target: HIT_5X_TARGET,
    predictedAt,
    baselineModelVersion: baseline.modelVersion,
    baselineModelHash: baseline.modelHash,
    // baseline/walletEnhanced are the FLAT, loader-shaped objects
    // (featureNames/featureStats/weights/bias/calibration as direct
    // properties, calibration alongside the rest) — same convention
    // flipShadowScoring.js's predictFeatureModelTierProbabilities
    // already uses (predictCalibrated(model, model.calibration, row)),
    // not the nested { model, calibration } shape
    // trainWalletShadowModels' own in-memory training result uses
    // internally (mirroring trainBaseline's per-tier result shape).
    // Field pool differs per variant on purpose: baseline was trained on
    // plain FEATURE_FIELDS (predictCalibrated's own default, so omitted
    // here), walletEnhanced was trained on FEATURE_FIELDS +
    // WALLET_FEATURE_FIELDS and must be resolved against that same wider
    // pool at inference time too — see fieldsByName's header in
    // flipFeatureModel.js for why a mismatch here would silently break.
    baselineProbability: predictCalibrated(baseline, baseline.calibration, row),
    walletModelVersion: walletEnhanced.modelVersion,
    walletModelHash: walletEnhanced.modelHash,
    walletEnhancedProbability: predictCalibrated(walletEnhanced, walletEnhanced.calibration, row, WALLET_ENHANCED_FIELDS),
    // Not yet resolved — this token hasn't reached its own eventual peak
    // yet. Scoring this against the real outcome once it resolves is
    // deliberately out of scope for this shadow-attach step, same
    // "attach now, score later in a separate offline batch job" split
    // flipShadowScoring.js already uses for the other two models.
    scoredOutcome: null,
    // Explicit, not just true-by-convention: this is the one field a
    // future reader of live_evidence can check without having to also
    // know this whole module's calling convention never wires the
    // decision path to it.
    shadowOnly: true,
  };
}

/**
 * Live hot-path integration point — called alongside (not instead of)
 * attachFlipShadowPrediction/attachFeatureModelShadowPrediction (see
 * tokenScanner.js). Same never-throws contract as both of those: a
 * missing/malformed model file, a row with no featureSnapshot yet, or
 * anything else in here degrades to "no flipWalletShadowPrediction
 * attached this run," logged once, never an exception that could
 * interrupt alert_decisions persistence. Wrapped in its OWN try/catch,
 * independent of the other two attach calls — a problem with this model
 * can never suppress or be suppressed by either of them.
 *
 * Missing wallet-experience data on `row` (an older-shaped featureSnapshot,
 * or a token whose wallet clustering lookup failed this run) is NOT a
 * failure here: the three wallet fields simply extract to null and get
 * imputed to the walletEnhanced model's own train-median, the same safe,
 * deterministic "missing value" handling every other featureSnapshot
 * field already gets from flipFeatureModel.js's toVector/computeFeatureStats
 * — never a crash, never a fabricated non-zero value.
 */
function attachWalletShadowPrediction(evidence, row) {
  try {
    const model = loadFlipWalletShadowModel();
    if (!model) return evidence;
    if (!hasUsableFeatures(row)) return evidence;
    evidence.flipWalletShadowPrediction = buildWalletShadowPrediction({ baseline: model.baseline, walletEnhanced: model.walletEnhanced, row });
  } catch (error) {
    console.error(`[flipWalletShadowModel] attachWalletShadowPrediction failed, continuing without it: ${error.message}`);
  }
  return evidence;
}

module.exports = {
  HIT_5X_TARGET,
  HIT_5X_THRESHOLD,
  hasHit5xLabel,
  hit5xTarget,
  WALLET_ENHANCED_FIELDS,
  MODEL_VERSIONS,
  WALLET_SHADOW_PREDICTION_SCHEMA_VERSION,
  WALLET_SHADOW_FEATURE_SCHEMA_VERSION,
  trainWalletShadowModels,
  buildWalletShadowPrediction,
  attachWalletShadowPrediction,
};
