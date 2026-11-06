'use strict';

const crypto = require('crypto');
const { FLIP_TIERS } = require('./flipBaseline');

/**
 * Tier-aware equivalent of mlPromotion.js's evaluatePromotion, built because
 * that function is hardcoded to HORIZONS/usableCounts[horizon]/
 * metrics[horizon] — the export-ml-dataset.js/labelBundle model's shape —
 * and cannot ingest flip's tiers/gates shape (flipBaseline.js's
 * trainBaseline output) at all. Confirmed by reading both files directly,
 * not assumed: before this module existed, the ONLY thing gating the flip
 * pipeline was train-flip-baseline.js's blanket `provisionalSplit` flag,
 * which is a single boolean for the WHOLE split (true whenever
 * embargoMs < 72h) and doesn't distinguish no_flip (basically leak-free
 * even at 24h) from big_flip (genuinely risky) at all.
 *
 * The one gate mlPromotion.js has no concept of, added here specifically
 * because of that gap: leakage_exposure, reading split-manifest.json's
 * embargoCoverage (population-wide "how slow does this tier resolve," see
 * split-flip-dataset.js) per tier. maxEmbargoCoveragePct defaults to 0.10 —
 * chosen because it's the line that, on both real exports measured this
 * session, cleanly separates no_flip/small_flip (0.7-4.8%) from big_flip at
 * the project's chosen 24h embargo (18.4-20.0%) while still passing big_flip
 * at 72h (8.1%) — i.e. it's calibrated to actually distinguish "fails at
 * 24h" from "would pass at 72h" rather than being an arbitrary round
 * number. Override via policy.maxEmbargoCoveragePct if that calibration
 * doesn't hold on a future export.
 *
 * Every other gate (minimum_samples, validation/test_metric_validity,
 * non_regression) mirrors mlPromotion.js's checks structurally, one gate
 * per tier instead of one per horizon, reusing candidate.gates[tier] (from
 * flipBaseline.js's trainBaseline, NOT recomputed here — one definition of
 * "enough samples," not two) for the sample-count numbers themselves.
 */

const DEFAULT_FLIP_GATES = Object.freeze({
  minTrain: 20,
  minValidation: 10,
  minTest: 10,
  maxBrierScore: 0.25,
  maxBrierDegradation: 0.02,
  maxEmbargoCoveragePct: 0.10,
  requireAllTierGates: false,
});

function finite(value) { return Number.isFinite(Number(value)); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function evaluateFlipPromotion({ candidate, splitManifest = null, incumbent = null, gates = DEFAULT_FLIP_GATES } = {}) {
  const policy = { ...DEFAULT_FLIP_GATES, ...gates };
  const checks = [];
  const tierGates = candidate?.gates || {};
  const tiers = candidate?.tiers || {};
  const embargoCoverageByTier = splitManifest?.embargoCoverage?.byTier || {};

  for (const tier of FLIP_TIERS) {
    const counts = tierGates[tier] || {};
    const samplePass = Number(counts.trainCount || 0) >= policy.minTrain && Number(counts.validationCount || 0) >= policy.minValidation && Number(counts.testCount || 0) >= policy.minTest;
    checks.push({ tier, gate: 'minimum_samples', pass: samplePass, counts });

    const validationMetric = tiers[tier]?.validation || {};
    const validationPass = finite(validationMetric.brierScore) && Number(validationMetric.brierScore) <= policy.maxBrierScore;
    checks.push({ tier, gate: 'validation_metric_validity', pass: validationPass, brierScore: validationMetric.brierScore ?? null });

    const testMetric = tiers[tier]?.test || {};
    const testPass = finite(testMetric.brierScore) && Number(testMetric.brierScore) <= policy.maxBrierScore;
    checks.push({ tier, gate: 'test_metric_validity', pass: testPass, brierScore: testMetric.brierScore ?? null });

    const incumbentMetric = incumbent?.tiers?.[tier]?.test?.brierScore;
    // Treat "no incumbent" and "incumbent exists but this tier's own metric
    // is null" identically — both mean there's nothing valid to regress
    // against. A tier that failed to train previously (e.g. big_flip on an
    // earlier, worse split) has its test.brierScore written as a literal
    // JSON null by train-flip-baseline.js, not an absent key — Number(null)
    // is 0, so leaving this as `incumbentMetric === undefined` would demand
    // candidateBrierScore <= 0 + maxBrierDegradation, an almost-impossible
    // bar, instead of skipping the comparison as intended. Confirmed this
    // reproduces against a real null-incumbent case, not just theorized.
    const hasIncumbentMetric = incumbentMetric !== undefined && incumbentMetric !== null && finite(incumbentMetric);
    const nonRegressionPass = !hasIncumbentMetric || (testPass && Number(testMetric.brierScore) <= Number(incumbentMetric) + policy.maxBrierDegradation);
    checks.push({ tier, gate: 'non_regression', pass: nonRegressionPass, candidateBrierScore: testMetric.brierScore ?? null, incumbentBrierScore: hasIncumbentMetric ? incumbentMetric : null });

    // null/undefined exceedsEmbargoPct means embargoCoverage had no rows
    // with a known resolution time for this tier at all — that tier will
    // already fail minimum_samples in that case, so this passes rather
    // than inventing a second failure reason for the same underlying
    // emptiness.
    const exceedsEmbargoPct = embargoCoverageByTier[tier]?.exceedsEmbargoPct;
    const leakagePass = exceedsEmbargoPct === null || exceedsEmbargoPct === undefined || Number(exceedsEmbargoPct) <= policy.maxEmbargoCoveragePct;
    checks.push({ tier, gate: 'leakage_exposure', pass: leakagePass, exceedsEmbargoPct: exceedsEmbargoPct ?? null, maxEmbargoCoveragePct: policy.maxEmbargoCoveragePct });
  }

  const failing = checks.filter((check) => !check.pass);
  const requiredTiers = policy.requireAllTierGates ? FLIP_TIERS.length : 1;
  const gateNames = ['minimum_samples', 'validation_metric_validity', 'test_metric_validity', 'non_regression', 'leakage_exposure'];
  const passingTiers = new Set(
    FLIP_TIERS.filter((tier) => gateNames.every((gate) => checks.some((check) => check.tier === tier && check.gate === gate && check.pass))),
  );
  // Same default-deny pattern as mlPromotion.js: candidate.shadowOnly must
  // be explicitly true, not just falsy/absent, for anything to approve —
  // absence of the field fails closed rather than passing open.
  const approved = passingTiers.size >= requiredTiers && candidate?.shadowOnly === true;
  return {
    status: approved ? 'approved_shadow' : 'rejected',
    approved,
    shadowOnly: true,
    passingTiers: [...passingTiers],
    checks,
    failingChecks: failing,
    promotionPolicy: policy,
    decisionHash: digest({ checks, policy }),
  };
}

function buildFlipRegistryRecord({ candidate, evaluation, artifactPaths = {}, registeredBy = 'automation' } = {}) {
  return {
    registryVersion: 'flip-registry-v1',
    modelId: candidate.modelVersion,
    modelType: 'flip-empirical-rate',
    status: evaluation.status,
    shadowOnly: true,
    registeredBy,
    registeredAt: new Date().toISOString(),
    sourceManifest: candidate.sourceManifest || null,
    artifactPaths,
    evaluation,
    rollbackTarget: null,
  };
}

module.exports = { DEFAULT_FLIP_GATES, evaluateFlipPromotion, buildFlipRegistryRecord };
