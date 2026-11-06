'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

async function upsertEvaluation(input) {
  const evaluationId = input.evaluationId || crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO alert_evaluations (
       evaluation_id, alert_id, evaluation_rules_version, evidence_class,
       observation_coverage, outcome_label, analytical_score, confidence,
       evidence
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (alert_id, evaluation_rules_version) DO UPDATE SET
       evidence_class = EXCLUDED.evidence_class,
       observation_coverage = EXCLUDED.observation_coverage,
       outcome_label = EXCLUDED.outcome_label,
       analytical_score = EXCLUDED.analytical_score,
       confidence = EXCLUDED.confidence,
       evidence = EXCLUDED.evidence,
       computed_at = now()
     RETURNING *`,
    [
      evaluationId,
      input.alertId,
      input.rulesVersion,
      input.evidenceClass,
      input.observationCoverage ?? null,
      input.outcomeLabel,
      input.analyticalScore ?? null,
      input.confidence,
      JSON.stringify(input.evidence || {}),
    ],
  );
  return rows[0];
}

async function listEvaluations(alertId) {
  const { rows } = await query(
    `SELECT * FROM alert_evaluations WHERE alert_id = $1 ORDER BY computed_at`,
    [alertId],
  );
  return rows;
}

module.exports = { upsertEvaluation, listEvaluations };
