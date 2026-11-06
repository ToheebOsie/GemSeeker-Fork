'use strict';

const { query } = require('../db/pool');

function rowToObservation(row) {
  return {
    id: row.id,
    narrativeTag: row.narrative_tag,
    observedAt: row.observed_at,
    observation: row.observation,
    createdAt: row.created_at,
  };
}

async function upsertObservation(observation) {
  if (!observation || !observation.narrativeTag || observation.observedAt === null || observation.observedAt === undefined) {
    throw new TypeError('narrativeTag and observedAt are required');
  }
  const observedAt = new Date(observation.observedAt);
  if (Number.isNaN(observedAt.getTime())) throw new TypeError('observedAt must be a valid date or timestamp');
  const { rows } = await query(
    `INSERT INTO narrative_attention_observations (narrative_tag, observed_at, observation)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (narrative_tag, observed_at) DO UPDATE SET observation = EXCLUDED.observation
     RETURNING id, narrative_tag, observed_at, observation, created_at`,
    [String(observation.narrativeTag), observedAt.toISOString(), JSON.stringify(observation)],
  );
  return rows[0] ? rowToObservation(rows[0]) : null;
}

async function getLatestObservation(narrativeTag) {
  const { rows } = await query(
    `SELECT id, narrative_tag, observed_at, observation, created_at
     FROM narrative_attention_observations WHERE narrative_tag = $1
     ORDER BY observed_at DESC LIMIT 1`,
    [narrativeTag],
  );
  return rows[0] ? rowToObservation(rows[0]) : null;
}

async function getRecentObservations({ limit = 1000, since = null } = {}) {
  const boundedLimit = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 1000)));
  const sinceDate = since === null ? null : new Date(since);
  if (sinceDate && Number.isNaN(sinceDate.getTime())) throw new TypeError('since must be a valid date or timestamp');
  const { rows } = await query(
    `SELECT id, narrative_tag, observed_at, observation, created_at
     FROM narrative_attention_observations
     WHERE ($1::timestamptz IS NULL OR observed_at >= $1)
     ORDER BY observed_at DESC LIMIT $2`,
    [sinceDate ? sinceDate.toISOString() : null, boundedLimit],
  );
  return rows.map(rowToObservation);
}

async function getObservationHistory(narrativeTag, { limit = 100, before = null } = {}) {
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
  const beforeDate = before === null ? null : new Date(before);
  if (beforeDate && Number.isNaN(beforeDate.getTime())) throw new TypeError('before must be a valid date or timestamp');
  const { rows } = await query(
    `SELECT id, narrative_tag, observed_at, observation, created_at
     FROM narrative_attention_observations
     WHERE narrative_tag = $1 AND ($2::timestamptz IS NULL OR observed_at < $2)
     ORDER BY observed_at DESC LIMIT $3`,
    [narrativeTag, beforeDate ? beforeDate.toISOString() : null, boundedLimit],
  );
  return rows.map(rowToObservation).reverse();
}

module.exports = { upsertObservation, getLatestObservation, getObservationHistory, getRecentObservations };
