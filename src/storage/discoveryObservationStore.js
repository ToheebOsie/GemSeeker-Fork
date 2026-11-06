'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

const DISCOVERY_OUTCOME_HORIZONS = Object.freeze([
  { key: '5m', minutes: 5 },
  { key: '15m', minutes: 15 },
  { key: '1h', minutes: 60 },
  { key: '6h', minutes: 360 },
  { key: '24h', minutes: 1440 },
  { key: '72h', minutes: 4320 },
]);

async function enqueueDiscoveryOutcomeJobs(discoveryEvents) {
  const jobs = [];
  for (const event of discoveryEvents || []) {
    const discoveredAt = new Date(event.discoveredAt);
    for (const horizon of DISCOVERY_OUTCOME_HORIZONS) {
      const idempotencyKey = `discovery-observation:${event.discoveryEventId}:${horizon.key}`;
      const payload = {
        discoveryEventId: event.discoveryEventId,
        pairAddress: event.pairAddress,
        mintAddress: event.mintAddress,
        source: event.source,
        horizon: horizon.key,
        horizonMinutes: horizon.minutes,
        discoveredAt: discoveredAt.toISOString(),
      };
      const { rows } = await query(
        `INSERT INTO research_jobs (job_id, job_type, idempotency_key, payload, available_at)
         VALUES ($1,'discovery_observation',$2,$3::jsonb,$4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING job_id`,
        [crypto.randomUUID(), idempotencyKey, JSON.stringify(payload), new Date(discoveredAt.getTime() + horizon.minutes * 60000)],
      );
      if (rows[0]) jobs.push(rows[0].job_id);
    }
  }
  return jobs;
}

async function upsertDiscoveryObservation(input) {
  const { rows } = await query(
    `INSERT INTO discovery_outcome_observations (
       observation_id, discovery_event_id, horizon_key, target_at, observed_at,
       status, data_quality_status, source, source_observed_at, pair_resolvable,
       price_usd, market_cap_usd, liquidity_usd, volume_1h, raw_observation, error_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
     ON CONFLICT (discovery_event_id, horizon_key) DO UPDATE SET
       target_at=EXCLUDED.target_at, observed_at=EXCLUDED.observed_at,
       status=EXCLUDED.status, data_quality_status=EXCLUDED.data_quality_status,
       source=EXCLUDED.source, source_observed_at=EXCLUDED.source_observed_at,
       pair_resolvable=EXCLUDED.pair_resolvable, price_usd=EXCLUDED.price_usd,
       market_cap_usd=EXCLUDED.market_cap_usd, liquidity_usd=EXCLUDED.liquidity_usd,
       volume_1h=EXCLUDED.volume_1h, raw_observation=EXCLUDED.raw_observation,
       error_code=EXCLUDED.error_code
     RETURNING *`,
    [crypto.randomUUID(), input.discoveryEventId, input.horizonKey, new Date(input.targetAt), input.observedAt ? new Date(input.observedAt) : null,
      input.status || 'complete', input.dataQualityStatus || 'complete', input.source || null,
      input.sourceObservedAt ? new Date(input.sourceObservedAt) : null, input.pairResolvable ?? null,
      input.priceUsd ?? null, input.marketCapUsd ?? null, input.liquidityUsd ?? null, input.volume1h ?? null,
      JSON.stringify(input.rawObservation || null), input.errorCode || null],
  );
  return rows[0];
}

async function getDiscoveryObservationRows() {
  const { rows } = await query(
    `SELECT e.discovery_event_id, e.source, e.pair_address, e.mint_address,
            e.discovered_at, e.discovery_volume_1h_usd, e.discovery_total_volume_usd,
            e.discovery_liquidity_usd, e.discovery_market_cap_usd, e.discovery_price_usd,
            e.discovery_age_minutes, e.discovery_cohort_key, e.discovery_threshold,
            e.filter_version, e.discovery_version, e.provider_path,
            o.horizon_key, o.target_at, o.observed_at, o.status, o.data_quality_status,
            o.price_usd, o.market_cap_usd, o.liquidity_usd, o.volume_1h,
            o.source_observed_at
     FROM discovery_events e
     LEFT JOIN discovery_outcome_observations o ON o.discovery_event_id=e.discovery_event_id
     ORDER BY e.discovered_at, o.target_at`,
  );
  return rows;
}

module.exports = { DISCOVERY_OUTCOME_HORIZONS, enqueueDiscoveryOutcomeJobs, upsertDiscoveryObservation, getDiscoveryObservationRows };
