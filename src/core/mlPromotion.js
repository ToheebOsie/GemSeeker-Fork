'use strict';

const crypto = require('crypto');
const HORIZONS = ['5m', '15m', '1h', '6h', '24h', '72h'];
const DEFAULT_GATES = Object.freeze({ minTrain: 20, minValidation: 10, minTest: 10, maxBrierScore: 0.25, maxBrierDegradation: 0.02, requireAllHorizonGates: false });

function finite(value) { return Number.isFinite(Number(value)); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function evaluatePromotion({ candidate, incumbent = null, gates = DEFAULT_GATES } = {}) {
  const policy = { ...DEFAULT_GATES, ...gates };
  const checks = [];
  const usable = candidate?.usableCounts || {};
  const metrics = candidate?.metrics || {};
  for (const horizon of HORIZONS) {
    const counts = usable[horizon] || {};
    const validationMetric = metrics[horizon]?.validation || {};
    const testMetric = metrics[horizon]?.test || {};
    const samplePass = Number(counts.train || 0) >= policy.minTrain && Number(counts.validation || 0) >= policy.minValidation && Number(counts.test || 0) >= policy.minTest;
    checks.push({ horizon, gate: 'minimum_samples', pass: samplePass, counts });
    const validationPass = finite(validationMetric.brierScore) && Number(validationMetric.brierScore) <= policy.maxBrierScore;
    checks.push({ horizon, gate: 'validation_metric_validity', pass: validationPass, brierScore: validationMetric.brierScore ?? null });
    const testPass = finite(testMetric.brierScore) && Number(testMetric.brierScore) <= policy.maxBrierScore;
    checks.push({ horizon, gate: 'test_metric_validity', pass: testPass, brierScore: testMetric.brierScore ?? null });
    const incumbentMetric = incumbent?.metrics?.[horizon]?.test?.brierScore;
    const nonRegressionPass = incumbentMetric === undefined || (testPass && Number(testMetric.brierScore) <= Number(incumbentMetric) + policy.maxBrierDegradation);
    checks.push({ horizon, gate: 'non_regression', pass: nonRegressionPass, candidateBrierScore: testMetric.brierScore ?? null, incumbentBrierScore: incumbentMetric ?? null });
  }
  const failing = checks.filter((check) => !check.pass);
  const requiredHorizons = policy.requireAllHorizonGates ? HORIZONS.length : 1;
  const passingHorizons = new Set(checks
    .filter((check) => check.gate === 'minimum_samples' && check.pass)
    .map((check) => check.horizon)
    .filter((horizon) => checks.some((check) => check.horizon === horizon && check.gate === 'validation_metric_validity' && check.pass))
    .filter((horizon) => checks.some((check) => check.horizon === horizon && check.gate === 'test_metric_validity' && check.pass))
    .filter((horizon) => checks.some((check) => check.horizon === horizon && check.gate === 'non_regression' && check.pass)));
  const approved = passingHorizons.size >= requiredHorizons && (!candidate?.shadowOnly ? false : true);
  return { status: approved ? 'approved_shadow' : 'rejected', approved, shadowOnly: true, passingHorizons: [...passingHorizons], checks, failingChecks: failing, promotionPolicy: policy, decisionHash: digest({ checks, policy }) };
}

function buildRegistryRecord({ candidate, evaluation, artifactPaths = {}, registeredBy = 'automation' } = {}) {
  return { registryVersion: 'registry-v1', modelId: candidate.modelVersion, modelType: candidate.modelType || 'unknown', status: evaluation.status, shadowOnly: true, registeredBy, registeredAt: new Date().toISOString(), sourceManifest: candidate.sourceManifest || null, artifactPaths, evaluation, rollbackTarget: null };
}
module.exports = { HORIZONS, DEFAULT_GATES, evaluatePromotion, buildRegistryRecord };
