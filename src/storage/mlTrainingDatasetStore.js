'use strict';

const { randomUUID } = require('crypto');
const { query, withTransaction } = require('../db/pool');

const QUERY_VERSION = 'ml-base-v2';
const FEATURE_SCHEMA_VERSION = 'qualification-features-v2';

// The feature side of this query comes exclusively from alert_decisions. The
// observation aggregate is diagnostic context only and is not part of the
// qualification-time feature payload.
const BASE_EXAMPLES_SQL = `
  SELECT
    d.alert_id,
    d.qualified_at,
    d.pair_address,
    d.mint_address,
    d.signal_label,
    d.signal_status,
    d.risk_level,
    d.hype_score,
    d.feature_snapshot,
    d.source_snapshot,
    d.social_snapshot,
    d.live_evidence,
    d.ai_input_sanitized,
    d.ai_decision_json,
    d.ai_model,
    d.prompt_version,
    d.scoring_version,
    d.feature_schema_version AS source_feature_schema_version,
    d.config_version,
    jsonb_build_object(
      'observation_count', COUNT(o.observation_id)::int,
      'complete_observation_count', COUNT(o.observation_id) FILTER (WHERE o.data_quality_status = 'complete')::int,
      'partial_observation_count', COUNT(o.observation_id) FILTER (WHERE o.data_quality_status = 'partial')::int,
      'unavailable_observation_count', COUNT(o.observation_id) FILTER (WHERE o.data_quality_status IN ('unavailable', 'not_observed'))::int,
      'latest_observed_at', MAX(o.observed_at)
    ) AS observation_quality
  FROM alert_decisions d
  LEFT JOIN alert_observations o ON o.alert_id = d.alert_id
  WHERE d.qualified_at <= $1
    AND d.feature_snapshot IS NOT NULL
    AND ($2::timestamptz IS NULL OR (d.qualified_at, d.alert_id) > ($2::timestamptz, $3::uuid))
  GROUP BY d.alert_id
  ORDER BY d.qualified_at ASC, d.alert_id ASC
  LIMIT $4`;

const OBSERVATIONS_FOR_LABELS_SQL = `
  SELECT observation_id, alert_id, horizon_key, target_at, observed_at, status,
         data_quality_status, source, source_observed_at, pair_resolvable,
         price_usd, liquidity_usd, volume_1h, buys_1h, sells_1h,
         top_holder_pct, lp_locked_pct, mint_authority_held, freeze_authority_held,
         raw_observation
  FROM alert_observations
  WHERE alert_id = ANY($1::uuid[])
    AND observed_at IS NOT NULL
    AND observed_at >= $2
    AND observed_at <= $3
  ORDER BY alert_id, observed_at, horizon_key`;

async function listBaseExamples({ cutoffAt, limit = 1000, afterQualifiedAt = null, afterAlertId = null } = {}) {
  if (!cutoffAt) throw new Error('cutoffAt is required');
  const safeLimit = Math.max(1, Math.min(10000, Number(limit) || 1000));
  const { rows } = await query(BASE_EXAMPLES_SQL, [cutoffAt, afterQualifiedAt || null, afterAlertId || '00000000-0000-0000-0000-000000000000', safeLimit]);
  return rows;
}

async function listLabelObservations(alertIds, fromAt, toAt) {
  if (!Array.isArray(alertIds) || alertIds.length === 0) return [];
  const { rows } = await query(OBSERVATIONS_FOR_LABELS_SQL, [alertIds, fromAt, toAt]);
  return rows;
}

async function persistTrainingLabel({ exampleId, labelBundle, labelPolicyVersion, evaluatorVersion = null, evidence = [], qualityStatus = 'pass', revisionKey = 'canonical', parentLabelId = null, labelOrigin = 'deterministic' } = {}) {
  if (!exampleId || !labelBundle || !labelPolicyVersion) throw new Error('exampleId, labelBundle, and labelPolicyVersion are required');
  const labelId = randomUUID();
  const { rows } = await query(`
    INSERT INTO ml_training_labels
      (label_id, example_id, label_policy_version, evaluator_version, label_bundle, evidence, revision_key, parent_label_id, label_origin, quality_status)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)
    ON CONFLICT (example_id, label_policy_version, revision_key) DO NOTHING
    RETURNING *`, [labelId, exampleId, labelPolicyVersion, evaluatorVersion, JSON.stringify(labelBundle), JSON.stringify(evidence), revisionKey, parentLabelId, labelOrigin, qualityStatus]);
  return { inserted: rows.length > 0, row: rows[0] || null };
}

async function listReviewCandidates({ limit = 100, qualityStatus = null } = {}) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const { rows } = await query(`SELECT * FROM v_ml_review_candidates WHERE ($1::text IS NULL OR quality_status = $1) ORDER BY qualified_at ASC, example_id ASC LIMIT $2`, [qualityStatus, safeLimit]);
  return rows;
}

async function recordLabelReview({ reviewId = randomUUID(), exampleId, horizonKey = null, originalLabel = null, revisedLabel = null, reasonCode, reviewer, reviewNotes = null, evidence = [], reviewPolicyVersion } = {}) {
  if (!exampleId || !reasonCode || !reviewer || !reviewPolicyVersion) throw new Error('exampleId, reasonCode, reviewer, and reviewPolicyVersion are required');
  if (!horizonKey) throw new Error('horizonKey is required for an immutable horizon label correction');
  return withTransaction(async (client) => {
    const review = await client.query(`INSERT INTO ml_label_reviews (review_id, example_id, horizon_key, original_label, revised_label, reason_code, reviewer, review_notes, evidence, review_policy_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`, [reviewId, exampleId, horizonKey, originalLabel, revisedLabel, reasonCode, reviewer, reviewNotes, JSON.stringify(evidence), reviewPolicyVersion]);
    const prior = await client.query(`SELECT * FROM ml_training_labels WHERE example_id = $1 ORDER BY created_at DESC, label_id DESC LIMIT 1`, [exampleId]);
    if (!prior.rows[0]) throw new Error(`no prior label found for example: ${exampleId}`);
    const previousBundle = prior.rows[0].label_bundle && typeof prior.rows[0].label_bundle === 'object' ? prior.rows[0].label_bundle : {};
    const horizons = { ...(previousBundle.horizons || {}) };
    horizons[horizonKey] = { ...(horizons[horizonKey] || {}), outcome: revisedLabel, labelOrigin: 'human_review', reviewId };
    const mergedBundle = { ...previousBundle, horizons, labelOrigin: 'human_review', lastReviewId: reviewId };
    const label = await client.query(`INSERT INTO ml_training_labels (label_id, example_id, label_policy_version, evaluator_version, label_bundle, evidence, revision_key, parent_label_id, label_origin, quality_status) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,'human_review','pass') ON CONFLICT (example_id, label_policy_version, revision_key) DO NOTHING RETURNING *`, [randomUUID(), exampleId, reviewPolicyVersion, 'human-review-v1', JSON.stringify(mergedBundle), JSON.stringify(evidence), reviewId, prior.rows[0].label_id]);
    const projection = await client.query(`UPDATE ml_training_examples SET label_bundle = $2::jsonb, label_policy_version = $3, label_status = 'labeled', quality_status = 'pass', updated_at = now() WHERE example_id = $1 RETURNING example_id, label_bundle, label_policy_version`, [exampleId, JSON.stringify(mergedBundle), reviewPolicyVersion]);
    return { review: review.rows[0], labelRevision: label.rows[0] || null, effectiveExample: projection.rows[0] || null };
  });
}

async function getDatasetManifest(datasetId) {
  const { rows } = await query('SELECT * FROM ml_dataset_manifests WHERE dataset_id = $1', [datasetId]);
  return rows[0] || null;
}

async function persistTrainingExample({ exampleId, datasetId, alertId, qualifiedAt, featureObservedAt, sourceDecisionVersion, featureSnapshot, sourceSnapshot, socialSnapshot, evidenceClass = 'forward', evidenceSnapshot = null, aiInputSanitized, featureSchemaVersion = FEATURE_SCHEMA_VERSION, labelBundle = {}, labelPolicyVersion = null, labelStatus = 'unlabeled', qualityStatus = 'pending', qualityFlags = [] } = {}) {
  const { rows } = await query(`
    INSERT INTO ml_training_examples
      (example_id, dataset_id, alert_id, qualified_at, feature_observed_at,
       feature_schema_version, source_decision_version, feature_snapshot,
       source_snapshot, social_snapshot, evidence_class, evidence_snapshot,
       ai_input_sanitized, label_bundle, label_policy_version, label_status,
       quality_status, quality_flags)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18::jsonb)
    ON CONFLICT (alert_id, feature_schema_version, source_decision_version)
    DO UPDATE SET dataset_id = EXCLUDED.dataset_id, label_bundle = EXCLUDED.label_bundle,
      label_policy_version = EXCLUDED.label_policy_version, label_status = EXCLUDED.label_status,
      evidence_class = EXCLUDED.evidence_class, evidence_snapshot = EXCLUDED.evidence_snapshot,
      quality_status = EXCLUDED.quality_status, quality_flags = EXCLUDED.quality_flags,
      updated_at = now()
    RETURNING *`, [exampleId, datasetId, alertId, qualifiedAt, featureObservedAt, featureSchemaVersion, sourceDecisionVersion, JSON.stringify(featureSnapshot), JSON.stringify(sourceSnapshot), JSON.stringify(socialSnapshot), evidenceClass, JSON.stringify(evidenceSnapshot), JSON.stringify(aiInputSanitized), JSON.stringify(labelBundle), labelPolicyVersion, labelStatus, qualityStatus, JSON.stringify(qualityFlags)]);
  return rows[0];
}

async function createDatasetManifest({ datasetName, datasetVersion, cutoffAt, labelPolicyVersion, featureSchemaVersion = FEATURE_SCHEMA_VERSION, evaluatorVersion = null } = {}) {
  if (!datasetName || !datasetVersion || !cutoffAt || !labelPolicyVersion) throw new Error('datasetName, datasetVersion, cutoffAt, and labelPolicyVersion are required');
  const datasetId = randomUUID();
  const { rows } = await query(`
    INSERT INTO ml_dataset_manifests
      (dataset_id, dataset_name, dataset_version, cutoff_at, label_policy_version,
       feature_schema_version, evaluator_version, query_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *`, [datasetId, datasetName, datasetVersion, cutoffAt, labelPolicyVersion, featureSchemaVersion, evaluatorVersion, QUERY_VERSION]);
  return rows[0];
}

module.exports = {
  QUERY_VERSION,
  FEATURE_SCHEMA_VERSION,
  BASE_EXAMPLES_SQL,
  OBSERVATIONS_FOR_LABELS_SQL,
  listBaseExamples,
  listLabelObservations,
  createDatasetManifest,
  getDatasetManifest,
  listReviewCandidates,
  recordLabelReview,
  persistTrainingExample,
  persistTrainingLabel,
};
