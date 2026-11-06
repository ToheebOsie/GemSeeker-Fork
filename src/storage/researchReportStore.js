'use strict';

const { query } = require('../db/pool');

async function getSignalPerformance({ since = null, limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT * FROM v_alert_signal_performance
     WHERE ($1::timestamptz IS NULL OR qualified_at >= $1)
     ORDER BY qualified_at DESC LIMIT $2`,
    [since, limit],
  );
  return rows;
}

async function getSignalSummary({ since = null } = {}) {
  const { rows } = await query(
    `SELECT signal_label, risk_level,
            COUNT(*)::int AS alert_count,
            COUNT(*) FILTER (WHERE outcome_label IS NOT NULL)::int AS evaluated_count,
            COUNT(*) FILTER (WHERE confidence <> 'unresolved')::int AS resolved_count,
            ROUND(AVG(analytical_score) FILTER (WHERE analytical_score IS NOT NULL), 2) AS avg_analytical_score,
            ROUND(AVG(observation_coverage) FILTER (WHERE observation_coverage IS NOT NULL), 3) AS avg_observation_coverage,
            COUNT(*) FILTER (WHERE outcome_label IN ('BUY_STRONG', 'BUY_CONFIRMED', 'WAIT_VALIDATED', 'WAIT_PROTECTIVE', 'SKIP_VALIDATED_RISK', 'SKIP_VALIDATED_NOISE'))::int AS validated_count
     FROM v_alert_signal_performance
     WHERE ($1::timestamptz IS NULL OR qualified_at >= $1)
     GROUP BY signal_label, risk_level
     ORDER BY signal_label NULLS LAST, risk_level`,
    [since],
  );
  return rows;
}

async function getDataQualitySummary({ since = null } = {}) {
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS alerts,
       SUM(has_feature_snapshot)::int AS feature_snapshots,
       SUM(has_source_snapshot)::int AS source_snapshots,
       SUM(has_ai_input)::int AS ai_inputs,
       COALESCE(SUM(observation_count), 0)::int AS observations,
       COALESCE(SUM(complete_observations), 0)::int AS complete_observations,
       COALESCE(SUM(partial_observations), 0)::int AS partial_observations,
       COALESCE(SUM(unavailable_observations), 0)::int AS unavailable_observations,
       MAX(last_observed_at) AS last_observed_at
     FROM v_alert_data_quality
     WHERE ($1::timestamptz IS NULL OR qualified_at >= $1)`,
    [since],
  );
  return rows[0] || null;
}

async function getAlertAudit(alertId) {
  const { rows } = await query(
    'SELECT * FROM v_alert_audit WHERE alert_id = $1::uuid',
    [alertId],
  );
  return rows[0] || null;
}

async function getDataQualityBreakdown({ since = null } = {}) {
  const { rows } = await query(
    `SELECT signal_status,
            COUNT(*)::int AS alerts,
            SUM(has_feature_snapshot)::int AS feature_snapshots,
            SUM(has_source_snapshot)::int AS source_snapshots,
            SUM(has_ai_input)::int AS ai_inputs,
            COALESCE(SUM(complete_observations), 0)::int AS complete_observations,
            COALESCE(SUM(partial_observations), 0)::int AS partial_observations,
            COALESCE(SUM(unavailable_observations), 0)::int AS unavailable_observations
     FROM v_alert_data_quality
     WHERE ($1::timestamptz IS NULL OR qualified_at >= $1)
     GROUP BY signal_status
     ORDER BY signal_status`,
    [since],
  );
  return rows;
}

async function getFunnel({ since = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM v_alert_funnel
     WHERE ($1::timestamptz IS NULL OR day >= $1::timestamptz)
     ORDER BY day DESC`,
    [since],
  );
  return rows;
}

async function getDeliverySummary({ since = null } = {}) {
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(recipients), 0)::int AS recipients,
       COALESCE(SUM(sent), 0)::int AS sent,
       COALESCE(SUM(failed), 0)::int AS failed,
       COALESCE(SUM(suppressed), 0)::int AS suppressed,
       ROUND(AVG(avg_delivery_seconds), 2) AS avg_delivery_seconds,
       MAX(max_delivery_seconds) AS max_delivery_seconds
     FROM v_alert_delivery_performance d
     JOIN alert_decisions a ON a.alert_id = d.alert_id
     WHERE ($1::timestamptz IS NULL OR a.qualified_at >= $1)`,
    [since],
  );
  return rows[0] || null;
}

module.exports = {
  getSignalPerformance,
  getSignalSummary,
  getDataQualitySummary,
  getDataQualityBreakdown,
  getDeliverySummary,
  getFunnel,
  getAlertAudit,
};
