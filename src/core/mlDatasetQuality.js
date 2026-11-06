'use strict';

const fs = require('fs');
const crypto = require('crypto');

const OUTCOMES = new Set(['positive', 'negative', 'neutral', 'unknown', 'censored']);
const HORIZONS = new Set(['5m', '15m', '1h', '6h', '24h', '72h']);

function sha256(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
function dateMs(value) { const n = Date.parse(value || ''); return Number.isFinite(n) ? n : null; }
function addIssue(report, severity, code, message, rowNumber = null, details = {}) { report.issues.push({ severity, code, message, rowNumber, ...details }); }

function inspectFutureDates(value, qualifiedMs, report, rowNumber, path = '') {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) return value.forEach((item, index) => inspectFutureDates(item, qualifiedMs, report, rowNumber, `${path}[${index}]`));
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (typeof child === 'string' && /(at|timestamp|time)$/i.test(key)) {
      const parsed = dateMs(child);
      if (parsed !== null && parsed > qualifiedMs) addIssue(report, 'error', 'future_feature_timestamp', `${childPath} is after qualified_at`, rowNumber, { value: child });
    }
    inspectFutureDates(child, qualifiedMs, report, rowNumber, childPath);
  }
}

function inspectForbiddenFeatureKeys(value, report, rowNumber, path = '') {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach((item, index) => inspectForbiddenFeatureKeys(item, report, rowNumber, `${path}[${index}]`));
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (/^(outcome|label|rugged|future|targetAt|observedAt|evaluation|evidenceObservationIds)$/i.test(key)) addIssue(report, 'error', 'future_feature_field', `${childPath} is not allowed in qualification-time features`, rowNumber);
    inspectForbiddenFeatureKeys(child, report, rowNumber, childPath);
  }
}

function validateRow(row, rowNumber, cutoffMs, report) {
  const id = row.exampleId || row.example_id;
  const alertId = row.alertId || row.alert_id;
  if (!id) addIssue(report, 'error', 'missing_example_id', 'exampleId is required', rowNumber);
  if (!alertId) addIssue(report, 'error', 'missing_alert_id', 'alertId is required', rowNumber);
  if (id) { if (report.ids.has(id)) addIssue(report, 'error', 'duplicate_example_id', `Duplicate exampleId ${id}`, rowNumber); report.ids.add(id); }
  if (alertId) { if (report.alertIds.has(alertId)) addIssue(report, 'error', 'duplicate_alert_id', `Duplicate alertId ${alertId}`, rowNumber); report.alertIds.add(alertId); }
  const qualifiedMs = dateMs(row.qualifiedAt || row.qualified_at);
  if (qualifiedMs === null) addIssue(report, 'error', 'invalid_qualified_at', 'qualifiedAt is missing or invalid', rowNumber);
  else {
    if (qualifiedMs > cutoffMs) addIssue(report, 'error', 'decision_after_cutoff', 'qualifiedAt is after export cutoff', rowNumber);
    inspectFutureDates(row.featureSnapshot, qualifiedMs, report, rowNumber, 'featureSnapshot');
  }
  if (!row.featureSnapshot || typeof row.featureSnapshot !== 'object') addIssue(report, 'error', 'missing_feature_snapshot', 'featureSnapshot is required', rowNumber);
  else inspectForbiddenFeatureKeys(row.featureSnapshot, report, rowNumber, 'featureSnapshot');
  const evidenceClass = row.evidenceClass || row.evidence_class || null;
  if (!['forward', 'legacy', 'reconstructed'].includes(evidenceClass)) addIssue(report, 'warning', 'missing_or_invalid_evidence_class', 'evidenceClass must be forward, legacy, or reconstructed', rowNumber);
  else {
    report.evidenceStrata[evidenceClass] = (report.evidenceStrata[evidenceClass] || 0) + 1;
    if (evidenceClass === 'reconstructed' && (!row.evidenceSnapshot || typeof row.evidenceSnapshot !== 'object')) addIssue(report, 'error', 'missing_reconstructed_evidence', 'reconstructed rows require evidenceSnapshot', rowNumber);
    if (row.evidenceSnapshot?.evidenceClass && row.evidenceSnapshot.evidenceClass !== evidenceClass) addIssue(report, 'error', 'evidence_class_mismatch', 'evidenceClass does not match evidenceSnapshot.evidenceClass', rowNumber);
  }
  if (!row.labelBundle || typeof row.labelBundle !== 'object') addIssue(report, 'error', 'missing_label_bundle', 'labelBundle is required', rowNumber);
  else {
    const horizons = row.labelBundle.horizons || {};
    for (const key of Object.keys(horizons)) {
      if (!HORIZONS.has(key)) addIssue(report, 'error', 'invalid_horizon', `Unknown horizon ${key}`, rowNumber);
      const outcome = horizons[key]?.outcome;
      if (!OUTCOMES.has(outcome)) addIssue(report, 'error', 'invalid_outcome', `Invalid outcome ${outcome}`, rowNumber);
      const quality = horizons[key]?.quality || {};
      if (Number(quality.observationCount || 0) < Number(quality.validObservationCount || 0)) addIssue(report, 'error', 'invalid_quality_counts', 'valid observations exceed total observations', rowNumber);
      const maxRoi = horizons[key]?.maxRoiMultiple;
      if (maxRoi !== undefined && maxRoi !== null && (!Number.isFinite(Number(maxRoi)) || Number(maxRoi) < 0)) addIssue(report, 'error', 'impossible_roi', 'maxRoiMultiple is invalid', rowNumber);
      report.outcomeCounts[outcome] = (report.outcomeCounts[outcome] || 0) + 1;
      report.horizonCounts[key] = (report.horizonCounts[key] || 0) + 1;
    }
  }
  report.signalCounts[row.signalLabel || 'UNKNOWN'] = (report.signalCounts[row.signalLabel || 'UNKNOWN'] || 0) + 1;
  report.rowsChecked += 1;
}

function analyzeRows(rows, { cutoffAt, minQuality = 0.8 } = {}) {
  const cutoffMs = dateMs(cutoffAt);
  if (cutoffMs === null) throw new Error('A valid cutoffAt is required');
  const report = { status: 'pass', rowsChecked: 0, ids: new Set(), alertIds: new Set(), issues: [], outcomeCounts: {}, horizonCounts: {}, signalCounts: {}, evidenceStrata: {}, missingness: { featureSnapshot: 0, aiInputSanitized: 0, labelBundle: 0, evidenceSnapshot: 0 } };
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') { addIssue(report, 'error', 'malformed_row', 'Row is not an object', i + 1); continue; }
    report.missingness.featureSnapshot += row.featureSnapshot ? 0 : 1;
    report.missingness.aiInputSanitized += row.aiInputSanitized ? 0 : 1;
    report.missingness.labelBundle += row.labelBundle ? 0 : 1;
    report.missingness.evidenceSnapshot += row.evidenceSnapshot ? 0 : 1;
    validateRow(row, i + 1, cutoffMs, report);
  }
  const denominator = Math.max(1, report.rowsChecked);
  report.missingness = Object.fromEntries(Object.entries(report.missingness).map(([key, count]) => [key, { count, rate: count / denominator }]));
  for (const [key, value] of Object.entries(report.missingness)) if (value.rate > 1 - minQuality) addIssue(report, 'warning', 'missingness_threshold', `${key} missingness exceeds configured quality threshold`, null, { rate: value.rate });
  for (const [label, count] of Object.entries(report.outcomeCounts)) if (count / Math.max(1, Object.values(report.outcomeCounts).reduce((a, b) => a + b, 0)) > 0.99) addIssue(report, 'warning', 'label_distribution_concentration', `${label} represents more than 99% of horizon labels`, null, { count });
  report.ids = undefined; report.alertIds = undefined;
  report.errorCount = report.issues.filter((i) => i.severity === 'error').length;
  report.warningCount = report.issues.filter((i) => i.severity === 'warning').length;
  report.status = report.errorCount ? 'fail' : report.warningCount ? 'warn' : 'pass';
  return report;
}

function loadNdjson(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { return { __parseError: error.message, __rowNumber: index + 1 }; }
  });
}

module.exports = { OUTCOMES, HORIZONS, sha256, loadNdjson, analyzeRows, addIssue };
