'use strict';

const { brier, accuracy, logLoss } = require('./mlBaseline');
const { FLIP_TIERS, hasTier, target, precisionRecallF1 } = require('./flipBaseline');

/**
 * First real feature-vector model over featureSnapshot, as opposed to the
 * two categorical group-rate baselines (signalLabel|riskLevel, with and
 * without wallet-exposure folded in) that both came back flat this session.
 * Hand-rolled logistic regression, not an npm ML package — this codebase
 * has zero ML dependencies anywhere (checked package.json directly), and
 * the existing baseline is entirely hand-rolled group-rate/brier/logLoss
 * math; a small, fully-inspectable gradient descent implementation matches
 * that precedent rather than introducing a new dependency.
 *
 * CRITICAL — features excluded on purpose, not merely omitted: the
 * peak-time volume1h/buys1h/sells1h/msFromAth columns (from this session's
 * volume-reliability work) describe conditions AT THE TOKEN'S OWN EVENTUAL
 * PEAK. Using them as inputs here would mean predicting flip magnitude
 * using information only knowable once the flip has already happened —
 * label leakage, not a feature. Only featureSnapshot.market/safety/scores/
 * context fields are used, all captured at qualification time, before the
 * outcome exists. Do not add the peak-time fields to FEATURE_FIELDS.
 *
 * One featureSnapshot field remains 0% populated across the historical
 * dataset (context.socialSignals.socialScore — confirmed by direct
 * inspection of all 2,082 snapshot rows, not assumed) and stays excluded —
 * another instance of this project's "captured in schema, never actually
 * populated" pattern (early_wallet_activity, recovered_description).
 * safety.score used to be in this same bucket, but that was a field-name
 * bug in alertDecision.js (it read `safety.score`; rugcheckService.js only
 * ever produces `riskScore`), not genuine absence of the data — fixed
 * 2026-09, re-added below as `rugcheckScore`. Historical rows written
 * before that fix still carry score: null and will impute to the train
 * median until enough post-fix rows accumulate; don't mistake a mostly-null
 * ablation run on this feature for "still dead" the way mintAuthorityHeld
 * etc. genuinely are below — check the post-fix row count first.
 *
 * FEATURE_FIELDS was originally 17 fields; five were removed entirely after
 * analyze-flip-feature-importance.js showed, against the real 5,738-row v3
 * dataset, that all five had exactly 0.0000 coefficient weight AND zero
 * ablation effect on BOTH tiers: mintAuthorityHeld, freezeAuthorityHeld,
 * socialSignalsAvailable (zero-variance in this dataset), and
 * walletExposedWalletRatio / walletMaxPriorRuggedTokenCount (never
 * populated on these rows at all — wallet-rug-exposure was only ever wired
 * into the categorical baseline's row-level walletExposedWalletCount, never
 * into these featureSnapshot-derived vectors; see train-flip-baseline.js's
 * header for that distinction). If wallet exposure is ever joined into
 * these feature vectors for real, re-add it here and re-run the ablation
 * script before trusting it — don't assume it's still dead just because it
 * was dead when nothing populated it.
 *
 * 2026-09 additions, NOT yet ablated (added on the reasoning below only;
 * re-run analyze-flip-feature-importance.js once real post-fix data exists
 * and don't assume these help just because the reasoning is plausible):
 * rugcheckScore (see fix note above), volumeToLiquidityRatio and
 * liquidityToMarketCapRatio (interaction terms a linear model can't derive
 * on its own from the separately-included raw volume/liquidity/marketCap
 * fields — motivated by the JUPCAT/METCAT/PUMPCAT/CATURN cluster, four
 * themed-copycat launches that all had a huge volume-to-liquidity ratio on
 * a thin pool and all rugged; a raw-volume feature can't see that, the
 * ratio has to be handed to the model explicitly).
 */

// Monetary/count fields get log1p — heavily right-skewed in a memecoin
// market (volume/marketCap/liquidity span orders of magnitude), which hurts
// a linear model's ability to use them sensibly untransformed. Percentages,
// already-bounded scores, and small counts stay raw.
const FEATURE_FIELDS = [
  { name: 'buys1h', extract: (r) => r.featureSnapshot?.market?.buys1h, transform: 'log1p' },
  { name: 'sells1h', extract: (r) => r.featureSnapshot?.market?.sells1h, transform: 'log1p' },
  { name: 'volume1hAtQualification', extract: (r) => r.featureSnapshot?.market?.volume1h, transform: 'log1p' },
  { name: 'marketCap', extract: (r) => r.featureSnapshot?.market?.marketCap, transform: 'log1p' },
  { name: 'liquidityUsd', extract: (r) => r.featureSnapshot?.market?.liquidityUsd, transform: 'log1p' },
  { name: 'ageMinutes', extract: (r) => r.featureSnapshot?.market?.ageMinutes, transform: 'log1p' },
  { name: 'priceChange1h', extract: (r) => r.featureSnapshot?.market?.priceChange1h, transform: 'raw' },
  { name: 'lpLockedPct', extract: (r) => r.featureSnapshot?.safety?.lpLockedPct, transform: 'raw' },
  { name: 'topHolderPct', extract: (r) => r.featureSnapshot?.safety?.topHolderPct, transform: 'raw' },
  { name: 'riskFlagCount', extract: (r) => (Array.isArray(r.featureSnapshot?.safety?.risks) ? r.featureSnapshot.safety.risks.length : null), transform: 'raw' },
  { name: 'hypeScore', extract: (r) => r.featureSnapshot?.scores?.hypeScore, transform: 'raw' },
  { name: 'recurringWalletCount', extract: (r) => (Array.isArray(r.featureSnapshot?.context?.recurringWallets) ? r.featureSnapshot.context.recurringWallets.length : null), transform: 'log1p' },
  // rugcheckScore: distinct from lpLockedPct/topHolderPct above — this is
  // Rugcheck's own composite 0-100 risk score, not one of the individual
  // signals that feed it. Bounded like a percentage, so raw (not log1p),
  // same treatment as lpLockedPct/topHolderPct.
  { name: 'rugcheckScore', extract: (r) => r.featureSnapshot?.safety?.score, transform: 'raw' },
  // Ratio features — see the 2026-09 additions note above. Guard against
  // liquidityUsd/marketCap being 0, null, or missing so a bad denominator
  // produces a clean "missing" (null, imputed to train median) rather than
  // Infinity/NaN silently corrupting the standardized vector.
  {
    name: 'volumeToLiquidityRatio',
    extract: (r) => {
      const volume = r.featureSnapshot?.market?.volume1h;
      const liquidity = r.featureSnapshot?.market?.liquidityUsd;
      if (!Number.isFinite(volume) || !Number.isFinite(liquidity) || liquidity <= 0) return null;
      return volume / liquidity;
    },
    transform: 'log1p', // can span orders of magnitude on a thin pool, same reasoning as the raw monetary fields above
  },
  {
    name: 'liquidityToMarketCapRatio',
    extract: (r) => {
      const liquidity = r.featureSnapshot?.market?.liquidityUsd;
      const marketCap = r.featureSnapshot?.market?.marketCap;
      if (!Number.isFinite(liquidity) || !Number.isFinite(marketCap) || marketCap <= 0) return null;
      return liquidity / marketCap;
    },
    transform: 'raw', // rough float/depth ratio, not the multi-order-of-magnitude spread the volume ratio has
  },
];

// Per-tier exclusions on top of FEATURE_FIELDS, additive to the dead-feature
// removal above — these three are NOT globally dead, they're tier-specific:
// leave-one-out ablation against the real v3 dataset showed removing them
// IMPROVES validation recall at each tier's own operating threshold
// (small_flip: 0.5, big_flip: 0.6), i.e. they're actively hurting held-out
// performance for that specific tier, not merely unhelpful. Deliberately
// per-tier rather than a shared exclusion list: riskFlagCount cuts the
// OPPOSITE direction for big_flip (removing it there COSTS -0.054 recall)
// — a global exclusion would silently help small_flip while quietly
// hurting big_flip. Measured on a modest per-tier validation slice (37
// big_flip positives, 70 small_flip positives at the time) — revisit by
// re-running analyze-flip-feature-importance.js once meaningfully more
// data has accumulated, rather than assuming these hold forever.
const TIER_EXCLUDED_FEATURES = {
  no_flip: [],
  small_flip: ['recurringWalletCount', 'riskFlagCount'],
  big_flip: ['volume1hAtQualification'],
};

function fieldsForTier(tier) {
  const excluded = new Set(TIER_EXCLUDED_FEATURES[tier] || []);
  return FEATURE_FIELDS.filter((f) => !excluded.has(f.name));
}

function hasUsableFeatures(row) { return !!(row.hasFeatureSnapshot && row.featureSnapshot); }

function applyTransform(value, transform) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (transform === 'log1p') return Math.log1p(Math.max(0, value));
  return value;
}

function extractRaw(row, fields = FEATURE_FIELDS) {
  return Object.fromEntries(fields.map(({ name, extract, transform }) => [name, applyTransform(extract(row), transform)]));
}

/**
 * Median/mean/std computed from TRAIN rows only — used both to impute
 * missing values and to standardize, and stored on the returned model so
 * validation/test/production rows are transformed with train-only
 * statistics, never their own. Computing stats from validation/test would
 * leak their distribution into how features are scaled.
 */
function computeFeatureStats(trainRows, fields = FEATURE_FIELDS) {
  const usable = trainRows.filter(hasUsableFeatures);
  const stats = {};
  for (const { name } of fields) {
    const values = usable.map((row) => extractRaw(row, fields)[name]).filter((v) => v !== null).sort((a, b) => a - b);
    const median = values.length ? values[Math.floor(values.length / 2)] : 0;
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const variance = values.length ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length : 0;
    const std = Math.sqrt(variance) || 1; // guard against a zero-variance feature producing a divide-by-zero
    stats[name] = { median, mean, std };
  }
  return stats;
}

/** Impute missing with train median, then standardize with train mean/std. Order matters: fields' order, fixed, so weight vectors line up positionally with feature names. */
function toVector(row, stats, fields = FEATURE_FIELDS) {
  const raw = extractRaw(row, fields);
  return fields.map(({ name }) => {
    const value = raw[name] === null ? stats[name].median : raw[name];
    return (value - stats[name].mean) / stats[name].std;
  });
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

/**
 * Batch gradient descent, L2-regularized (bias term excluded from the
 * penalty), with balanced class weighting. Class weighting matters here
 * specifically because BOTH earlier categorical baselines this session
 * ended up with tp=0 everywhere — no group ever crossed the 0.5 threshold
 * because positive rates (9-15%) never dominated a group. Unweighted
 * logistic regression trained on unbalanced cross-entropy has the same
 * failure mode; weighting positive examples by (negativeCount /
 * positiveCount) is the standard, simplest fix, and lets this model
 * actually attempt positive predictions instead of defaulting to "always
 * predict the majority class" the way both baselines effectively did.
 */
function trainLogisticRegression(X, y, { l2 = 1, learningRate = 0.3, iterations = 3000 } = {}) {
  const n = X.length;
  const d = X[0].length;
  const positiveCount = y.filter((v) => v === 1).length;
  const negativeCount = n - positiveCount;
  const positiveWeight = positiveCount > 0 ? Math.min(20, negativeCount / positiveCount) : 1; // capped so a very rare class doesn't blow up the gradient
  const sampleWeights = y.map((v) => (v === 1 ? positiveWeight : 1));
  const weights = new Array(d).fill(0);
  let bias = 0;
  const lossHistory = [];
  for (let iter = 0; iter < iterations; iter += 1) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    let lossSum = 0;
    for (let i = 0; i < n; i += 1) {
      const z = weights.reduce((sum, w, j) => sum + w * X[i][j], bias);
      const p = sigmoid(z);
      const err = (p - y[i]) * sampleWeights[i];
      for (let j = 0; j < d; j += 1) gradW[j] += err * X[i][j];
      gradB += err;
      const clipped = Math.min(1 - 1e-15, Math.max(1e-15, p));
      lossSum += -sampleWeights[i] * (y[i] * Math.log(clipped) + (1 - y[i]) * Math.log(1 - clipped));
    }
    for (let j = 0; j < d; j += 1) {
      const reg = (l2 / n) * weights[j];
      weights[j] -= learningRate * (gradW[j] / n + reg);
    }
    bias -= learningRate * (gradB / n);
    if (iter % Math.max(1, Math.floor(iterations / 10)) === 0 || iter === iterations - 1) lossHistory.push({ iteration: iter, loss: lossSum / n });
  }
  return { weights, bias, lossHistory, positiveWeight, trainCount: n, positiveCount };
}

// pool: optional, defaults to FEATURE_FIELDS — every existing call site
// (predictLogit/predictProba below, with their own default) resolves
// against FEATURE_FIELDS exactly as before. Added so a model trained with
// a WIDER field set (FEATURE_FIELDS + walletExperienceFeatures.js's
// WALLET_FEATURE_FIELDS, see flipWalletShadowModel.js) can still resolve
// its own model.featureNames back to {extract, transform} descriptors at
// inference time — model.featureNames is just an array of name strings,
// so whichever field pool produced those names at TRAINING time must also
// be given at INFERENCE time to look them back up correctly.
function fieldsByName(names, pool = FEATURE_FIELDS) {
  const map = new Map(pool.map((f) => [f.name, f]));
  return names.map((name) => map.get(name));
}

function predictProbaVector(model, x) {
  const z = model.weights.reduce((sum, w, j) => sum + w * x[j], model.bias);
  return sigmoid(z);
}

function predictLogit(model, row, fieldPool = FEATURE_FIELDS) {
  const x = toVector(row, model.featureStats, fieldsByName(model.featureNames, fieldPool));
  return model.weights.reduce((sum, w, j) => sum + w * x[j], model.bias);
}

function predictProba(model, row, fieldPool = FEATURE_FIELDS) { return predictProbaVector(model, toVector(row, model.featureStats, fieldsByName(model.featureNames, fieldPool))); }

/**
 * Platt scaling: fits calibrated_p = sigmoid(A*z + B) where z is the base
 * model's raw LOGIT (pre-sigmoid), not its already-squashed probability —
 * squashing twice throws away information the calibration step needs.
 * Fit on VALIDATION only, never train (the base model already saw train,
 * so calibrating against it would just re-fit the same overconfidence) and
 * never test (test must stay an untouched final check). Reuses
 * trainLogisticRegression directly — a 1D logistic regression is exactly
 * what Platt scaling is, no separate implementation needed.
 */
// targetFn/hasTargetFn default to flipBaseline.js's flipTier-shaped
// target()/hasTier() so every EXISTING call site (trainBaseline's own
// FLIP_TIERS loop, and every prior caller of calibrate() directly) keeps
// byte-identical behavior without passing anything new — this is purely
// additive plumbing so the wallet-enhanced hit_5x shadow experiment
// (src/core/flipWalletShadowModel.js) can reuse this same calibration
// logic for a differently-shaped binary target, not a change to what
// flipTier calibration already does. See trainTier's own comment just
// below for the identical reasoning. fields: optional, same default/
// reasoning as fieldsByName's pool param just above — must match
// whatever field set the model itself was trained with, since calibrate()
// calls predictLogit internally to build its 1D calibration input.
function calibrate(model, validationRows, tier, options = {}) {
  const { targetFn = target, hasTargetFn = hasTier, fields = FEATURE_FIELDS, ...regressionOptions } = options;
  const usableRows = validationRows.filter((row) => hasTargetFn(row) && hasUsableFeatures(row));
  const X = usableRows.map((row) => [predictLogit(model, row, fields)]);
  const y = usableRows.map((row) => targetFn(row, tier));
  const fit = trainLogisticRegression(X, y, { l2: 0, learningRate: 0.3, iterations: 2000, ...regressionOptions });
  return { tier, a: fit.weights[0], b: fit.bias, fittedOn: usableRows.length };
}

function predictCalibrated(model, calibration, row, fieldPool = FEATURE_FIELDS) {
  const z = predictLogit(model, row, fieldPool);
  return sigmoid(calibration.a * z + calibration.b);
}

// targetFn/hasTargetFn: optional, default to flipBaseline.js's flipTier-
// shaped target()/hasTier(). Every existing call site (trainBaseline's own
// FLIP_TIERS loop below, train-flip-feature-model.js) never passes these,
// so this is a pure behavioral no-op for the existing baseline/feature
// models — confirmed by test/flip_feature_model.test.js and
// test/flip_baseline.test.js still passing unmodified. Added so
// src/core/flipWalletShadowModel.js can train against a differently-
// shaped binary target (hit_5x: row.peakRoiMultiple >= 5, not
// row.flipTier === tier) using this same, one-definition-only logistic
// regression/calibration/evaluation machinery, rather than a second,
// parallel implementation that could quietly drift from this one.
function trainTier(trainRows, tier, options = {}) {
  const { fields = FEATURE_FIELDS, targetFn = target, hasTargetFn = hasTier, ...regressionOptions } = options;
  const usableRows = trainRows.filter((row) => hasTargetFn(row) && hasUsableFeatures(row));
  const featureStats = computeFeatureStats(usableRows, fields);
  const X = usableRows.map((row) => toVector(row, featureStats, fields));
  const y = usableRows.map((row) => targetFn(row, tier));
  const fit = trainLogisticRegression(X, y, regressionOptions);
  return { tier, featureNames: fields.map((f) => f.name), featureStats, weights: fit.weights, bias: fit.bias, lossHistory: fit.lossHistory, positiveWeight: fit.positiveWeight, trainCount: fit.trainCount, positiveCount: fit.positiveCount };
}

function identify(row) { return { pairAddress: row.pairAddress, mintAddress: row.mintAddress || null, source: row.source || null }; }

// options.targetFn/hasTargetFn: same optional, default-to-flipTier-shaped
// pattern as trainTier/calibrate above, added as a 5th param specifically
// so it can't collide with `calibration` (the pre-existing 4th positional
// param every current call site already uses) — every existing call
// (train-flip-feature-model.js, trainBaseline below) passes at most 4
// arguments, so options is always {} for them and this is a pure no-op.
// options.fields: same default-FEATURE_FIELDS, must-match-training-fields
// reasoning as fieldsByName/calibrate above.
function evaluate(model, rows, tier, calibration = null, options = {}) {
  const { targetFn = target, hasTargetFn = hasTier, fields = FEATURE_FIELDS } = options;
  const usableRows = rows.filter((row) => hasTargetFn(row) && hasUsableFeatures(row));
  const predictions = usableRows.map((row) => ({
    ...identify(row),
    probability: calibration ? predictCalibrated(model, calibration, row, fields) : predictProba(model, row, fields),
    actual: targetFn(row, tier),
    signalLabel: row.signalLabel,
    riskLevel: row.riskLevel,
  }));
  return {
    tier,
    count: predictions.length,
    positiveCount: predictions.filter((p) => p.actual === 1).length,
    brierScore: brier(predictions),
    accuracy: accuracy(predictions),
    logLoss: logLoss(predictions),
    ...precisionRecallF1(predictions),
    predictions,
  };
}

function trainBaseline(trainRows, validationRows, testRows, { minTrain = 50, minValidation = 10, minTest = 10, ...regressionOptions } = {}) {
  const tiers = {};
  const gates = {};
  const trainCount = trainRows.filter((row) => hasTier(row) && hasUsableFeatures(row)).length;
  const validationCount = validationRows.filter((row) => hasTier(row) && hasUsableFeatures(row)).length;
  const testCount = testRows.filter((row) => hasTier(row) && hasUsableFeatures(row)).length;
  for (const tier of FLIP_TIERS) {
    gates[tier] = { trainCount, validationCount, testCount, pass: trainCount >= minTrain && validationCount >= minValidation && testCount >= minTest };
    if (gates[tier].pass) {
      const model = trainTier(trainRows, tier, { fields: fieldsForTier(tier), ...regressionOptions });
      // Calibration is fit on validation, then applied to BOTH validation
      // and test for reporting — validation's own calibrated numbers are
      // optimistic (same data used to fit A/B), test's are the honest
      // check. Both are reported so the gap between them is visible, not
      // hidden.
      const calibration = calibrate(model, validationRows, tier);
      tiers[tier] = {
        model,
        calibration,
        validation: evaluate(model, validationRows, tier),
        test: evaluate(model, testRows, tier),
        validationCalibrated: evaluate(model, validationRows, tier, calibration),
        testCalibrated: evaluate(model, testRows, tier, calibration),
      };
    }
  }
  const trainable = Object.values(gates).some((g) => g.pass);
  return { modelType: 'flip_tier_logistic_regression_v1', trainable, gates, tiers };
}

module.exports = {
  FEATURE_FIELDS,
  TIER_EXCLUDED_FEATURES,
  fieldsForTier,
  hasUsableFeatures,
  extractRaw,
  computeFeatureStats,
  toVector,
  fieldsByName,
  trainLogisticRegression,
  predictProba,
  predictLogit,
  calibrate,
  predictCalibrated,
  trainTier,
  evaluate,
  trainBaseline,
};
