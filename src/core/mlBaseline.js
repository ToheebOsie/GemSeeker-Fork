'use strict';

const crypto = require('crypto');
const HORIZONS = ['5m', '15m', '1h', '6h', '24h', '72h'];

function outcome(row, horizon) { return row.labelBundle?.horizons?.[horizon]?.outcome || null; }
function usable(row, horizon) { return ['positive', 'negative', 'neutral'].includes(outcome(row, horizon)); }
function target(row, horizon) { return outcome(row, horizon) === 'positive' ? 1 : 0; }
function key(row) { return `${row.signalLabel || 'UNKNOWN'}|${row.riskLevel || 'UNKNOWN'}`; }
function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }

function trainHorizon(rows, horizon) {
  const usableRows = rows.filter((row) => usable(row, horizon));
  const global = mean(usableRows.map((row) => target(row, horizon))) ?? 0.5;
  const groups = {};
  for (const row of usableRows) {
    const group = key(row);
    if (!groups[group]) groups[group] = [];
    groups[group].push(target(row, horizon));
  }
  const rates = Object.fromEntries(Object.entries(groups).map(([group, values]) => [group, { probability: mean(values), count: values.length }]));
  return { horizon, trainCount: usableRows.length, positiveCount: usableRows.filter((row) => target(row, horizon) === 1).length, globalProbability: global, groupRates: rates };
}

function predict(model, row) { return model.groupRates[key(row)]?.probability ?? model.globalProbability; }
function brier(predictions) { return mean(predictions.map((p) => (p.probability - p.actual) ** 2)); }
function accuracy(predictions) { return mean(predictions.map((p) => (p.probability >= 0.5 ? 1 : 0) === p.actual ? 1 : 0)); }
function logLoss(predictions) { return mean(predictions.map((p) => { const probability = Math.min(1 - 1e-15, Math.max(1e-15, p.probability)); return -(p.actual ? Math.log(probability) : Math.log(1 - probability)); })); }

function evaluate(model, rows, horizon) {
  const predictions = rows.filter((row) => usable(row, horizon)).map((row) => ({ exampleId: row.exampleId, alertId: row.alertId, probability: predict(model, row), actual: target(row, horizon), signalLabel: row.signalLabel, riskLevel: row.riskLevel, evidenceClass: row.evidenceClass || row.evidence_class || 'unknown' }));
  return { horizon, count: predictions.length, positiveCount: predictions.filter((p) => p.actual === 1).length, brierScore: brier(predictions), accuracy: accuracy(predictions), logLoss: logLoss(predictions), predictions };
}

function evaluateByEvidenceClass(model, rows, horizon) {
  const classes = ['forward', 'legacy', 'reconstructed', 'unknown'];
  return Object.fromEntries(classes.map((evidenceClass) => {
    const subset = rows.filter((row) => (row.evidenceClass || row.evidence_class || 'unknown') === evidenceClass);
    const metrics = evaluate(model, subset, horizon);
    return [evidenceClass, { ...metrics, predictions: undefined }];
  }).filter(([, metrics]) => metrics.count > 0));
}

function trainBaseline(trainRows, validationRows, testRows, { minTrain = 20, minValidation = 10, minTest = 10 } = {}) {
  const horizons = {};
  const gates = {};
  for (const horizon of HORIZONS) {
    const trainCount = trainRows.filter((row) => usable(row, horizon)).length;
    const validationCount = validationRows.filter((row) => usable(row, horizon)).length;
    const testCount = testRows.filter((row) => usable(row, horizon)).length;
    gates[horizon] = { trainCount, validationCount, testCount, pass: trainCount >= minTrain && validationCount >= minValidation && testCount >= minTest };
    if (gates[horizon].pass) {
      const model = trainHorizon(trainRows, horizon);
      horizons[horizon] = { model, validation: evaluate(model, validationRows, horizon), test: evaluate(model, testRows, horizon), validationByEvidence: evaluateByEvidenceClass(model, validationRows, horizon), testByEvidence: evaluateByEvidenceClass(model, testRows, horizon) };
    }
  }
  const trainable = Object.values(gates).some((gate) => gate.pass);
  return { modelVersion: `empirical-rate-v1-${crypto.createHash('sha256').update(JSON.stringify(gates)).digest('hex').slice(0, 12)}`, trainable, gates, horizons };
}

module.exports = { HORIZONS, usable, target, key, trainHorizon, predict, evaluate, evaluateByEvidenceClass, trainBaseline, mean, brier, accuracy, logLoss };
