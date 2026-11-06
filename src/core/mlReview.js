'use strict';

function horizons(row) { return Object.entries(row.labelBundle?.horizons || {}); }
function candidateReasons(row) {
  const reasons = [];
  if (row.qualityStatus === 'fail') reasons.push('quality_failure');
  if (row.qualityStatus === 'warn') reasons.push('quality_warning');
  if (row.labelBundle?.labelStatus === 'unknown' || row.labelBundle?.labelStatus === 'partial') reasons.push('incomplete_label');
  if (horizons(row).some(([, value]) => value?.severeAdverseObserved === true)) reasons.push('severe_adverse_outcome');
  if (horizons(row).some(([, value]) => Number(value?.maxRoiMultiple) >= 10)) reasons.push('high_roi_outlier');
  return [...new Set(reasons)];
}
function buildReviewQueue(rows) {
  return rows.flatMap((row) => {
    const reasons = candidateReasons(row);
    return reasons.length ? [{ exampleId: row.exampleId, alertId: row.alertId, qualifiedAt: row.qualifiedAt, signalLabel: row.signalLabel, riskLevel: row.riskLevel, reasons, labelBundle: row.labelBundle, featureSnapshot: row.featureSnapshot, reviewStatus: 'pending' }] : [];
  });
}
module.exports = { candidateReasons, buildReviewQueue };
