'use strict';

const crypto = require('crypto');
const { key, mean, brier, accuracy, logLoss } = require('./mlBaseline');

/**
 * Baseline for build-flip-dataset.js's flipTier target — one-vs-rest per
 * tier, mirroring mlBaseline.js's per-horizon binary target structurally,
 * but NOT a modification to that file's horizon loop. flipTier is decided
 * once at a token's own eventual peak, not re-evaluated at fixed calendar
 * checkpoints, and rows here have no labelBundle/exampleId/alertId/
 * evidenceClass at all (confirmed by reading mlBaseline.js directly, not
 * assumed) — a genuinely different label shape, not just different field
 * names.
 *
 * What IS reused, unmodified: key() (signalLabel|riskLevel grouping),
 * predict(), and the pure scoring functions (mean/brier/accuracy/logLoss)
 * from mlBaseline.js, exported additively from that file for this purpose
 * with zero change to its existing behavior (confirmed: test/ml_baseline.test.js
 * still passes unmodified). One definition of "group-rate model" and
 * "probability score" shared by both pipelines, not two that could drift —
 * same principle as computeObservedPeak/volumeCoverageNearAth earlier this
 * project.
 *
 * evidenceClass-style stratification is replaced with source (archived vs.
 * tracked_enriched) and volumeReliableAtPeak, since those are the actual
 * quality-stratification axes this dataset has — evidenceClass doesn't
 * exist on these rows, and source/volumeReliableAtPeak are exactly the
 * fields this session already found matter (tracked_enriched's
 * volume-reliability rate is meaningfully lower for flip tiers specifically,
 * per the earlier audit of flip-dataset-report.json).
 *
 * Every row in build-flip-dataset.js's output always has a defined flipTier
 * (confirmed: byFlipTier counts summed to the full row count in the real
 * 2,541-row export, no nulls) — unlike mlBaseline.js's usable(), which must
 * filter out 'unknown'/'censored' horizon outcomes, hasTier() here is a
 * defensive check, not an expected-to-exclude-many filter.
 */

const FLIP_TIERS = ['no_flip', 'small_flip', 'big_flip'];

function hasTier(row) { return FLIP_TIERS.includes(row.flipTier); }
function target(row, tier) { return row.flipTier === tier ? 1 : 0; }

// Exposure-augmented key, additive to key() — appends whether ANY of the
// token's holders had prior exposure to an already-known rug (see
// tokenPatternStore.js's listPriorRuggedWalletExposureFor). Bucketed
// binary (exposed/clean), not by walletMaxPriorRuggedTokenCount's raw
// value: only ~20% of rows have any exposure at all (511/2,541 in the real
// dataset), so a finer split would fragment already-thin signalLabel|
// riskLevel groups (e.g. UNKNOWN|Low has 4 training rows total) into cells
// too small to estimate a rate from at all — the same failure mode that
// already made the plain-key model overfit and lose to naive prevalence on
// held-out log-loss. Binary is the least fragmentation for the cheapest
// test of "does folding exposure into the group key help."
function keyWithExposure(row) { return `${key(row)}|${row.walletExposedWalletCount > 0 ? 'exposed' : 'clean'}`; }

// predict()/key() in mlBaseline.js are hardwired to signalLabel|riskLevel
// internally (not parameterized) — reusing them here would silently ignore
// whatever keyFn was actually trained with. This is the one thing in this
// file NOT reused from mlBaseline.js, specifically because reusing it here
// would be wrong, not because of general reluctance to reuse.
function predictWithKey(model, row, keyFn) { return model.groupRates[keyFn(row)]?.probability ?? model.globalProbability; }

function trainTier(rows, tier, keyFn = key) {
  const usableRows = rows.filter(hasTier);
  const global = mean(usableRows.map((row) => target(row, tier))) ?? 0;
  const groups = {};
  for (const row of usableRows) {
    const group = keyFn(row);
    if (!groups[group]) groups[group] = [];
    groups[group].push(target(row, tier));
  }
  const rates = Object.fromEntries(Object.entries(groups).map(([group, values]) => [group, { probability: mean(values), count: values.length }]));
  return { tier, trainCount: usableRows.length, positiveCount: usableRows.filter((row) => target(row, tier) === 1).length, globalProbability: global, groupRates: rates };
}

// Naive comparator: ignores signalLabel|riskLevel grouping entirely, always
// predicts train's own global rate for this tier. This IS the "prevalence
// baseline" the project's plan calls for comparing against — if the grouped
// model doesn't beat this, grouping by signalLabel|riskLevel isn't adding
// signal over the base rate.
function naivePrevalenceModel(trainRows, tier) {
  const usableRows = trainRows.filter(hasTier);
  const global = mean(usableRows.map((row) => target(row, tier))) ?? 0;
  return { tier, trainCount: usableRows.length, globalProbability: global, groupRates: {} };
}

// Threshold-based classification metrics on top of mlBaseline.js's
// continuous scores (brier/logLoss), since the project's own plan explicitly
// calls out precision/recall on small_flip/big_flip as the numbers that
// matter, not accuracy. Caveat worth carrying forward, not hidden: at a 0.5
// threshold, a rare-tier group-rate model can end up never predicting
// "positive" at all if no signalLabel|riskLevel group's rate exceeds 50% —
// that shows up here as precision/recall being null (no positive
// predictions), not as a bug. This is a pre-existing property of the
// empirical-rate approach shared with mlBaseline.js's own horizon models
// (rug/survive is similarly imbalanced), not something new introduced here.
function precisionRecallF1(predictions, threshold = 0.5) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of predictions) {
    const predicted = p.probability >= threshold ? 1 : 0;
    if (predicted === 1 && p.actual === 1) tp += 1;
    else if (predicted === 1 && p.actual === 0) fp += 1;
    else if (predicted === 0 && p.actual === 1) fn += 1;
    else tn += 1;
  }
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : null;
  const f1 = (precision !== null && recall !== null && (precision + recall) > 0) ? (2 * precision * recall) / (precision + recall) : null;
  return { threshold, tp, fp, fn, tn, precision, recall, f1 };
}

// pairAddress substitutes for mlBaseline.js's exampleId/alertId — confirmed
// globally unique across all 2,541 real flip-dataset rows and never shared
// across source values (checked directly, not assumed), so it's a safe,
// ready-made row identifier for shadow predictions without inventing a new
// id scheme.
function identify(row) { return { pairAddress: row.pairAddress, mintAddress: row.mintAddress || null, source: row.source || null }; }

function evaluate(model, rows, tier, keyFn = key) {
  const predictions = rows.filter(hasTier).map((row) => ({
    ...identify(row),
    probability: predictWithKey(model, row, keyFn),
    actual: target(row, tier),
    signalLabel: row.signalLabel,
    riskLevel: row.riskLevel,
    volumeReliableAtPeak: row.volumeReliableAtPeak === true,
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

function evaluateGroupedBy(model, rows, tier, groupFn, groupNames, keyFn = key) {
  return Object.fromEntries(
    groupNames
      .map((name) => {
        const subset = rows.filter((row) => groupFn(row) === name);
        const metrics = evaluate(model, subset, tier, keyFn);
        return [name, { ...metrics, predictions: undefined }];
      })
      .filter(([, metrics]) => metrics.count > 0),
  );
}

function evaluateBySource(model, rows, tier, keyFn = key) {
  return evaluateGroupedBy(model, rows, tier, (row) => row.source || 'unknown', ['archived', 'tracked_enriched', 'unknown'], keyFn);
}

function evaluateByVolumeReliability(model, rows, tier, keyFn = key) {
  return evaluateGroupedBy(model, rows, tier, (row) => (row.volumeReliableAtPeak === true ? 'reliable' : 'unreliable'), ['reliable', 'unreliable'], keyFn);
}

function trainBaseline(trainRows, validationRows, testRows, { minTrain = 20, minValidation = 10, minTest = 10 } = {}) {
  const tiers = {};
  const gates = {};
  // Gate is "enough total labeled rows," matching mlBaseline.js's own
  // semantics exactly (its gate isn't positive-class-specific either) — not
  // a per-tier positive-class-count threshold. positiveCount is still
  // surfaced in trainTier()/evaluate()'s output for a human to judge
  // adequacy per tier (e.g. big_flip's real scarcity), it just isn't itself
  // a blocking condition, by design parallel to the existing pattern.
  const trainCount = trainRows.filter(hasTier).length;
  const validationCount = validationRows.filter(hasTier).length;
  const testCount = testRows.filter(hasTier).length;
  for (const tier of FLIP_TIERS) {
    gates[tier] = { trainCount, validationCount, testCount, pass: trainCount >= minTrain && validationCount >= minValidation && testCount >= minTest };
    if (gates[tier].pass) {
      const model = trainTier(trainRows, tier);
      const naive = naivePrevalenceModel(trainRows, tier);
      // Same rows, same tier, same gate — only the group key differs. This
      // is a direct test of "does folding wallet-exposure into the group
      // key add anything over signalLabel|riskLevel alone," not a separate
      // experiment run in isolation.
      const exposureModel = trainTier(trainRows, tier, keyWithExposure);
      tiers[tier] = {
        model,
        validation: evaluate(model, validationRows, tier),
        test: evaluate(model, testRows, tier),
        validationBySource: evaluateBySource(model, validationRows, tier),
        testBySource: evaluateBySource(model, testRows, tier),
        validationByVolumeReliability: evaluateByVolumeReliability(model, validationRows, tier),
        testByVolumeReliability: evaluateByVolumeReliability(model, testRows, tier),
        naivePrevalence: {
          model: naive,
          validation: evaluate(naive, validationRows, tier),
          test: evaluate(naive, testRows, tier),
        },
        exposureAugmented: {
          model: exposureModel,
          validation: evaluate(exposureModel, validationRows, tier, keyWithExposure),
          test: evaluate(exposureModel, testRows, tier, keyWithExposure),
        },
      };
    }
  }
  const trainable = Object.values(gates).some((gate) => gate.pass);
  return {
    modelVersion: `flip-empirical-rate-v1-${crypto.createHash('sha256').update(JSON.stringify(gates)).digest('hex').slice(0, 12)}`,
    trainable,
    gates,
    tiers,
  };
}

module.exports = {
  FLIP_TIERS,
  hasTier,
  target,
  keyWithExposure,
  predictWithKey,
  trainTier,
  naivePrevalenceModel,
  precisionRecallF1,
  evaluate,
  evaluateBySource,
  evaluateByVolumeReliability,
  trainBaseline,
};
