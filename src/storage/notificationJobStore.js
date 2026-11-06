'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

const MAX_ATTEMPTS = 8;
const LEASE_MINUTES = 5;

function retryAt(attempts) {
  const seconds = Math.min(300, Math.max(5, 2 ** Math.min(attempts, 8)));
  return new Date(Date.now() + seconds * 1000);
}

async function enqueueNotificationJobs({ alertId, deliveries }) {
  const jobs = [];
  for (const delivery of deliveries) {
    const subscriberId = delivery.subscriber_id || delivery.subscriberId;
    const idempotencyKey = `notification:${alertId}:${subscriberId}`;
    const jobId = crypto.randomUUID();
    const { rows } = await query(
      `INSERT INTO notification_jobs (
         job_id, alert_id, subscriber_id, idempotency_key, status
       ) VALUES ($1,$2,$3,$4,'pending')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [jobId, alertId, subscriberId, idempotencyKey],
    );
    if (rows.length > 0) jobs.push(rows[0]);
  }
  return jobs;
}

async function claimNotificationJob(workerId) {
  const { rows } = await query(
    `WITH next_job AS (
       SELECT job_id
       FROM notification_jobs
       WHERE available_at <= now()
         AND (
           status IN ('pending', 'failed')
           OR (status = 'processing' AND claimed_at < now() - ($2::int * interval '1 minute'))
         )
       ORDER BY available_at, created_at, job_id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE notification_jobs nj
     SET status = 'processing', claimed_by = $1,
         claimed_at = now(), attempts = nj.attempts + 1
     FROM next_job
     WHERE nj.job_id = next_job.job_id
     RETURNING nj.*`,
    [workerId, LEASE_MINUTES],
  );
  return rows[0] || null;
}

async function completeNotificationJob(jobId, workerId, telegramMessageId) {
  const { rowCount } = await query(
    `UPDATE notification_jobs
     SET status = 'sent', sent_at = now(), telegram_message_id = $3,
         claimed_by = NULL
     WHERE job_id = $1 AND claimed_by = $2 AND status = 'processing'`,
    [jobId, workerId, telegramMessageId || null],
  );
  return rowCount > 0;
}

async function failNotificationJob(jobId, workerId, errorMessage, attempts = 1) {
  const terminal = attempts >= MAX_ATTEMPTS;
  const { rowCount } = await query(
    `UPDATE notification_jobs
     SET status = $3, available_at = $4, last_error = $5, claimed_by = NULL
     WHERE job_id = $1 AND claimed_by = $2 AND status = 'processing'`,
    [jobId, workerId, terminal ? 'dead_letter' : 'failed', terminal ? new Date() : retryAt(attempts), String(errorMessage || 'unknown error').slice(0, 4000)],
  );
  return rowCount > 0;
}

async function releaseNotificationJob(jobId, workerId) {
  const { rowCount } = await query(
    `UPDATE notification_jobs
     SET status = 'pending', available_at = now() + interval '30 seconds',
         claimed_by = NULL
     WHERE job_id = $1 AND claimed_by = $2 AND status = 'processing'`,
    [jobId, workerId],
  );
  return rowCount > 0;
}

async function suppressNotificationJob(jobId, workerId, reason) {
  const { rowCount } = await query(
    `UPDATE notification_jobs
     SET status = 'suppressed', last_error = $3, claimed_by = NULL
     WHERE job_id = $1 AND claimed_by = $2 AND status = 'processing'`,
    [jobId, workerId, String(reason || 'suppressed').slice(0, 4000)],
  );
  return rowCount > 0;
}

async function getNotificationJobStats() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count
     FROM notification_jobs
     GROUP BY status
     ORDER BY status`,
  );
  return rows;
}

module.exports = {
  MAX_ATTEMPTS,
  enqueueNotificationJobs,
  claimNotificationJob,
  completeNotificationJob,
  failNotificationJob,
  suppressNotificationJob,
  releaseNotificationJob,
  getNotificationJobStats,
};
