'use strict';

const { query, withTransaction } = require('../db/pool');

const DELIVERY_LEASE_MINUTES = 15;
// A stuck delivery is only re-sent while its alert is still fresh: a BUY/WAIT
// verdict delivered hours late is misleading, so an older stuck delivery is
// closed as 'expired' instead of being retried.
const RECLAIM_MAX_ALERT_AGE_MINUTES = 60;
// Bounds crash-looping: each reclaim gives the job a fresh retry budget, and
// alert_deliveries.attempts is the persisted total across all of them.
const RECLAIM_MAX_DELIVERY_ATTEMPTS = 20;

function entitlementForSubscriber(subscriber, { trialAlertCount, adminChatIds = [] }) {
  const chatId = String(subscriber.chatId);
  const isAdmin = adminChatIds.map(String).includes(chatId);
  const expiresAt = subscriber.subscriptionExpiresAt ? new Date(subscriber.subscriptionExpiresAt).getTime() : 0;
  const hasActiveSubscription = expiresAt > Date.now();
  const trialRemaining = Math.max(0, trialAlertCount - (subscriber.alertsSent || 0));
  if (isAdmin) return { eligible: true, state: 'admin', trialRemaining, isAdmin, hasActiveSubscription };
  if (hasActiveSubscription) return { eligible: true, state: 'paid', trialRemaining, isAdmin, hasActiveSubscription };
  if (trialRemaining > 0) return { eligible: true, state: 'trial', trialRemaining, isAdmin, hasActiveSubscription };
  return { eligible: false, state: 'expired', trialRemaining, isAdmin, hasActiveSubscription };
}

async function queueDeliveryAudits({ alertId, subscribers, trialAlertCount, adminChatIds = [], requestedAt = new Date() }) {
  const queued = [];
  for (const subscriber of subscribers) {
    const entitlement = entitlementForSubscriber(subscriber, { trialAlertCount, adminChatIds });
    if (!entitlement.eligible) continue;
    const { rows } = await query(
      `INSERT INTO alert_deliveries (
         alert_id, subscriber_id, entitlement_state, disposition,
         broadcast_requested_at, attempts, trial_count_before
       ) VALUES ($1,$2,$3,'queued',$4,0,$5)
       ON CONFLICT (alert_id, subscriber_id) DO NOTHING
       RETURNING alert_id, subscriber_id, disposition`,
      [alertId, subscriber.chatId, entitlement.state, requestedAt, subscriber.alertsSent || 0],
    );
    if (rows.length > 0) queued.push({ ...rows[0], ...entitlement });
  }
  return queued;
}

/** Atomically claims the delivery. A live lease owned by another worker blocks a second send. */
async function markDeliveryStarted(alertId, subscriberId, workerId) {
  if (!workerId) throw new Error('workerId is required to claim a delivery');
  const { rows } = await query(
    `UPDATE alert_deliveries
     SET disposition = 'sending', send_started_at = now(),
         send_lease_owner = $3, send_lease_expires_at = now() + ($4::int * interval '1 minute'),
         attempts = attempts + 1
     WHERE alert_id = $1 AND subscriber_id = $2
       AND disposition IN ('queued', 'failed')
     RETURNING alert_id, subscriber_id, disposition, send_lease_owner, send_lease_expires_at`,
    [alertId, subscriberId, workerId, DELIVERY_LEASE_MINUTES],
  );
  return rows[0] || null;
}

async function markDeliverySent(alertId, subscriberId, telegramMessageId, trialCountAfter = null, workerId) {
  if (!workerId) throw new Error('workerId is required to complete a delivery');
  const { rowCount } = await query(
    `UPDATE alert_deliveries
     SET disposition = 'sent', delivered_at = now(), telegram_message_id = $3,
         trial_count_after = COALESCE($4, trial_count_after),
         send_lease_owner = NULL, send_lease_expires_at = NULL
     WHERE alert_id = $1 AND subscriber_id = $2 AND disposition = 'sending' AND send_lease_owner = $5`,
    [alertId, subscriberId, telegramMessageId || null, trialCountAfter, workerId],
  );
  return rowCount > 0;
}

async function listDispatchableDeliveries(alertId) {
  const { rows } = await query(
    `SELECT * FROM alert_deliveries
     WHERE alert_id = $1 AND disposition IN ('queued', 'failed')
     ORDER BY subscriber_id`,
    [alertId],
  );
  return rows;
}

async function getDelivery(alertId, subscriberId) {
  const { rows } = await query(
    'SELECT * FROM alert_deliveries WHERE alert_id = $1 AND subscriber_id = $2',
    [alertId, subscriberId],
  );
  return rows[0] || null;
}

async function recordTrialCountAfter(alertId, subscriberId) {
  return withTransaction(async (client) => {
    const deliveryResult = await client.query(
      `SELECT disposition, entitlement_state, trial_count_after
       FROM alert_deliveries
       WHERE alert_id = $1 AND subscriber_id = $2
       FOR UPDATE`,
      [alertId, subscriberId],
    );
    const delivery = deliveryResult.rows[0];
    if (!delivery) throw new Error(`delivery audit not found: ${alertId}/${subscriberId}`);
    if (delivery.disposition !== 'sent') throw new Error(`delivery is not sent: ${alertId}/${subscriberId}`);
    if (delivery.entitlement_state !== 'trial' || delivery.trial_count_after !== null) {
      return delivery.trial_count_after;
    }

    const subscriberResult = await client.query(
      `UPDATE subscribers
       SET alerts_sent = alerts_sent + 1
       WHERE chat_id = $1
       RETURNING alerts_sent`,
      [subscriberId],
    );
    if (subscriberResult.rows.length === 0) throw new Error(`subscriber not found: ${subscriberId}`);
    const trialCountAfter = subscriberResult.rows[0].alerts_sent;
    await client.query(
      `UPDATE alert_deliveries
       SET trial_count_after = $3
       WHERE alert_id = $1 AND subscriber_id = $2 AND trial_count_after IS NULL`,
      [alertId, subscriberId, trialCountAfter],
    );
    return trialCountAfter;
  });
}

async function markDeliveryFailed(alertId, subscriberId, failureCode, workerId) {
  if (!workerId) throw new Error('workerId is required to fail a delivery');
  const { rowCount } = await query(
    `UPDATE alert_deliveries
     SET disposition = 'failed', failure_code = $3,
         send_lease_owner = NULL, send_lease_expires_at = NULL
     WHERE alert_id = $1 AND subscriber_id = $2 AND disposition = 'sending' AND send_lease_owner = $4`,
    [alertId, subscriberId, String(failureCode || 'unknown').slice(0, 500), workerId],
  );
  return rowCount > 0;
}

/**
 * Recovers deliveries stranded in 'sending' after their lease expired.
 *
 * POST-AUDIT FIX (Finding 4). markDeliveryStarted() only claims rows in
 * ('queued','failed') and stamps a 15-minute send lease, but nothing ever read
 * that lease. If a worker died (OOM, redeploy) or a Telegram call hung between
 * claim and completion, the row stayed 'sending' forever: every retry failed
 * with "delivery audit is not sendable" and that subscriber silently never
 * received the alert.
 *
 * Two things had to be true for recovery to actually work:
 *  1. The delivery row must leave 'sending' (-> 'failed', which is claimable
 *     again). Done for every row whose lease has expired.
 *  2. The notification job must still be alive to retry it. The job retry
 *     schedule (5s..128s, MAX_ATTEMPTS=8, ~4.5 minutes in total) is shorter
 *     than the 15-minute delivery lease, so by the time a lease expires the job
 *     is normally already dead-lettered. Reclaiming only the delivery row would
 *     leave it stranded again, so the matching job is revived (status back to
 *     'pending', attempts reset) in the SAME transaction.
 *
 * Duplicate-send trade-off (deliberate): if the worker died AFTER Telegram
 * accepted the message but BEFORE markDeliverySent committed, that outcome is
 * unknowable, and this reclaim will resend once. That is the price of
 * at-least-once delivery for a crash window; it does not weaken the invariant
 * that a delivery already persisted as 'sent' is never reopened (rows in
 * 'sent' are untouched here, and a late markDeliverySent from a reclaimed
 * worker is rejected because it requires disposition='sending' and its own
 * lease owner).
 *
 * Rows too old to be worth sending (or past the attempt cap) are closed as
 * 'expired' rather than retried. Legacy 'sending' rows that predate the lease
 * columns (NULL lease) are treated as expiring DELIVERY_LEASE_MINUTES after
 * send_started_at.
 */
async function reclaimStuckDeliveries({
  maxAlertAgeMinutes = RECLAIM_MAX_ALERT_AGE_MINUTES,
  maxDeliveryAttempts = RECLAIM_MAX_DELIVERY_ATTEMPTS,
} = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE alert_deliveries
       SET disposition = CASE
             WHEN broadcast_requested_at >= now() - ($1::int * interval '1 minute') AND attempts < $2::int
             THEN 'failed' ELSE 'expired' END,
           failure_code = CASE
             WHEN broadcast_requested_at >= now() - ($1::int * interval '1 minute') AND attempts < $2::int
             THEN 'send_lease_expired' ELSE 'send_lease_expired_not_retried' END,
           send_lease_owner = NULL, send_lease_expires_at = NULL
       WHERE disposition = 'sending'
         AND COALESCE(send_lease_expires_at,
                      send_started_at + ($3::int * interval '1 minute'),
                      broadcast_requested_at) < now()
       RETURNING alert_id, subscriber_id, disposition`,
      [maxAlertAgeMinutes, maxDeliveryAttempts, DELIVERY_LEASE_MINUTES],
    );
    const retryable = rows.filter((row) => row.disposition === 'failed');
    let revivedJobs = 0;
    if (retryable.length > 0) {
      const revived = await client.query(
        `UPDATE notification_jobs nj
         SET status = 'pending', attempts = 0, available_at = now(), claimed_by = NULL,
             last_error = 'revived: delivery send lease expired while sending'
         FROM unnest($1::uuid[], $2::bigint[]) AS r(alert_id, subscriber_id)
         WHERE nj.alert_id = r.alert_id AND nj.subscriber_id = r.subscriber_id
           AND nj.status IN ('failed', 'dead_letter')`,
        [retryable.map((row) => row.alert_id), retryable.map((row) => row.subscriber_id)],
      );
      revivedJobs = revived.rowCount || 0;
    }
    return {
      reclaimed: retryable.length,
      expired: rows.length - retryable.length,
      revivedJobs,
      deliveries: rows.map((row) => ({ alertId: row.alert_id, subscriberId: row.subscriber_id, disposition: row.disposition })),
    };
  });
}

module.exports = {
  DELIVERY_LEASE_MINUTES,
  RECLAIM_MAX_ALERT_AGE_MINUTES,
  RECLAIM_MAX_DELIVERY_ATTEMPTS,
  reclaimStuckDeliveries,
  entitlementForSubscriber,
  queueDeliveryAudits,
  markDeliveryStarted,
  markDeliverySent,
  recordTrialCountAfter,
  markDeliveryFailed,
  getDelivery,
  listDispatchableDeliveries,
};
