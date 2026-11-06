'use strict';

const { query } = require('../db/pool');

const MAX_ATTEMPTS = 8;
const LEASE_MINUTES = 5;

function retryAt(attempts) {
  const seconds = Math.min(300, Math.max(5, 2 ** Math.min(attempts, 8)));
  return new Date(Date.now() + seconds * 1000);
}

async function claimConsumerEvent(consumerName, workerId) {
  const { rows } = await query(
    `WITH next_event AS (
       SELECT ec.event_id
       FROM event_consumptions ec
       WHERE ec.consumer_name = $1
         AND ec.available_at <= now()
         AND (
           ec.status IN ('pending', 'failed')
           OR (ec.status = 'processing' AND ec.claimed_at < now() - ($3::int * interval '1 minute'))
         )
       ORDER BY ec.available_at, ec.event_id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE event_consumptions ec
     SET status = 'processing',
         claimed_by = $2,
         claimed_at = now(),
         attempts = ec.attempts + 1
     FROM next_event ne
     WHERE ec.event_id = ne.event_id
       AND ec.consumer_name = $1
     RETURNING ec.*`,
    [consumerName, workerId, LEASE_MINUTES],
  );

  if (rows.length === 0) return null;
  const event = await query('SELECT * FROM outbox_events WHERE event_id = $1', [rows[0].event_id]);
  if (event.rows.length === 0) {
    await failConsumerEvent(rows[0].event_id, consumerName, workerId, 'outbox_event_missing', rows[0].attempts);
    return null;
  }
  return { consumption: rows[0], event: event.rows[0] };
}

async function completeConsumerEvent(eventId, consumerName, workerId) {
  const { rowCount } = await query(
    `UPDATE event_consumptions
     SET status = 'completed', completed_at = now(), claimed_by = NULL
     WHERE event_id = $1 AND consumer_name = $2
       AND status = 'processing' AND claimed_by = $3`,
    [eventId, consumerName, workerId],
  );
  return rowCount > 0;
}

async function failConsumerEvent(eventId, consumerName, workerId, errorMessage, attempts = 1) {
  const terminal = attempts >= MAX_ATTEMPTS;
  const { rowCount } = await query(
    `UPDATE event_consumptions
     SET status = $4,
         available_at = $5,
         last_error = $6,
         claimed_by = NULL
     WHERE event_id = $1 AND consumer_name = $2
       AND status = 'processing' AND claimed_by = $3`,
    [eventId, consumerName, workerId, terminal ? 'dead_letter' : 'failed', terminal ? new Date() : retryAt(attempts), String(errorMessage || 'unknown error').slice(0, 4000)],
  );
  return rowCount > 0;
}

async function getOutboxStats() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count
     FROM outbox_events
     GROUP BY status
     ORDER BY status`,
  );
  return rows;
}

module.exports = {
  MAX_ATTEMPTS,
  claimConsumerEvent,
  completeConsumerEvent,
  failConsumerEvent,
  getOutboxStats,
};
