'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

function createObservationId() {
  return crypto.randomUUID();
}

async function getObservation(alertId, horizonKey) {
  const { rows } = await query(
    `SELECT * FROM alert_observations WHERE alert_id = $1 AND horizon_key = $2`,
    [alertId, horizonKey],
  );
  return rows[0] || null;
}

async function upsertObservation(input) {
  const observationId = input.observationId || createObservationId();
  const { rows } = await query(
    `INSERT INTO alert_observations (
       observation_id, alert_id, horizon_key, target_at, observed_at, status,
       data_quality_status, source, evidence_class, source_observed_at, backfill_run_id, pair_resolvable,
       price_usd, market_cap_usd, liquidity_usd, volume_1h, buys_1h, sells_1h,
       top_holder_pct, lp_locked_pct, mint_authority_held, freeze_authority_held,
       raw_observation, error_code
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24
     )
     ON CONFLICT (alert_id, horizon_key) DO UPDATE SET
       target_at = EXCLUDED.target_at,
       observed_at = EXCLUDED.observed_at,
       status = EXCLUDED.status,
       data_quality_status = EXCLUDED.data_quality_status,
       source = EXCLUDED.source,
       evidence_class = EXCLUDED.evidence_class,
       source_observed_at = EXCLUDED.source_observed_at,
       backfill_run_id = EXCLUDED.backfill_run_id,
       pair_resolvable = EXCLUDED.pair_resolvable,
       price_usd = EXCLUDED.price_usd,
       market_cap_usd = EXCLUDED.market_cap_usd,
       liquidity_usd = EXCLUDED.liquidity_usd,
       volume_1h = EXCLUDED.volume_1h,
       buys_1h = EXCLUDED.buys_1h,
       sells_1h = EXCLUDED.sells_1h,
       top_holder_pct = EXCLUDED.top_holder_pct,
       lp_locked_pct = EXCLUDED.lp_locked_pct,
       mint_authority_held = EXCLUDED.mint_authority_held,
       freeze_authority_held = EXCLUDED.freeze_authority_held,
       raw_observation = EXCLUDED.raw_observation,
       error_code = EXCLUDED.error_code
     RETURNING *`,
    [
      observationId,
      input.alertId,
      input.horizonKey,
      new Date(input.targetAt),
      input.observedAt ? new Date(input.observedAt) : null,
      input.status || 'complete',
      input.dataQualityStatus || 'complete',
      input.source || null,
      input.evidenceClass || input.evidence_class || 'forward',
      input.sourceObservedAt ? new Date(input.sourceObservedAt) : null,
      input.backfillRunId || input.backfill_run_id || null,
      input.pairResolvable ?? null,
      input.priceUsd ?? null,
      input.marketCapUsd ?? null,
      input.liquidityUsd ?? null,
      input.volume1h ?? null,
      input.buys1h ?? null,
      input.sells1h ?? null,
      input.topHolderPct ?? null,
      input.lpLockedPct ?? null,
      input.mintAuthorityHeld ?? null,
      input.freezeAuthorityHeld ?? null,
      JSON.stringify(input.rawObservation || null),
      input.errorCode || null,
    ],
  );
  return rows[0];
}

async function listAlertObservations(alertId) {
  const { rows } = await query(
    `SELECT * FROM alert_observations WHERE alert_id = $1 ORDER BY target_at`,
    [alertId],
  );
  return rows;
}

module.exports = { createObservationId, getObservation, upsertObservation, listAlertObservations };
