'use strict';

const TelegramBot = require('../services/telegramBotApi');
const { telegram, payments } = require('../config');
const { getAlertDecision } = require('../storage/alertDecisionStore');
const {
  getDelivery,
  markDeliveryStarted,
  markDeliverySent,
  recordTrialCountAfter,
  markDeliveryFailed,
  reclaimStuckDeliveries,
} = require('../storage/deliveryStore');
const {
  claimNotificationJob,
  completeNotificationJob,
  failNotificationJob,
  releaseNotificationJob,
} = require('../storage/notificationJobStore');
const { formatAlert } = require('../bot/alertFormatter');
const health = require('../observability/workerHealth');
const { startHealthServer } = require('../observability/healthServer');

const WORKER_NAME = 'notification';
health.ensureWorker(WORKER_NAME);

const POLL_MS = Number(process.env.NOTIFICATION_POLL_MS || 1000);
const WORKER_ID = `notification-worker-${process.pid}-${Math.random().toString(16).slice(2)}`;
// How often (at most) a worker sweeps for deliveries stranded in 'sending'
// with an expired lease. The sweep is one indexed UPDATE, but there is no
// reason to run it every second.
const RECLAIM_INTERVAL_MS = Number(process.env.NOTIFICATION_RECLAIM_INTERVAL_MS || 60000);
let lastReclaimAt = 0;

/**
 * POST-AUDIT FIX (Finding 4): recover deliveries whose send lease expired
 * (worker crash or hung Telegram call between claim and completion) and revive
 * their notification jobs — see reclaimStuckDeliveries for the full reasoning
 * and the duplicate-send trade-off. Never runs in dry-run mode (dry-run must
 * not write), and a failure here is logged but must never block delivery of
 * healthy jobs.
 */
async function reclaimStuckDeliveriesIfDue({ dryRun, reclaimIntervalMs = RECLAIM_INTERVAL_MS, now = Date.now() } = {}) {
  if (dryRun) return null;
  if (now - lastReclaimAt < reclaimIntervalMs) return null;
  lastReclaimAt = now;
  try {
    const result = await reclaimStuckDeliveries();
    if (result.reclaimed > 0 || result.expired > 0) {
      const counters = health.ensureWorker(WORKER_NAME).counters;
      counters.deliveries_reclaimed_total = (counters.deliveries_reclaimed_total || 0) + result.reclaimed;
      counters.deliveries_expired_total = (counters.deliveries_expired_total || 0) + result.expired;
      console.warn(`[notification-worker] reclaimed ${result.reclaimed} stuck deliver${result.reclaimed === 1 ? 'y' : 'ies'} (${result.revivedJobs} job(s) revived), expired ${result.expired} too old to resend`);
    }
    return result;
  } catch (err) {
    health.markError(WORKER_NAME, err, 'reclaim_errors_total');
    console.error(`[notification-worker] stuck-delivery reclaim failed: ${err.message}`);
    return null;
  }
}

async function dispatchNotificationJob(bot, job, { dryRun = true } = {}) {
  const delivery = await getDelivery(job.alert_id, job.subscriber_id);
  if (!delivery) throw new Error(`delivery audit not found: ${job.alert_id}/${job.subscriber_id}`);

  if (delivery.disposition === 'sent') {
    await recordTrialCountAfter(job.alert_id, job.subscriber_id);
    await completeNotificationJob(job.job_id, WORKER_ID, delivery.telegram_message_id);
    return { status: 'already_sent', jobId: job.job_id };
  }

  if (dryRun) {
    await releaseNotificationJob(job.job_id, WORKER_ID);
    console.log(`[notification-worker] dry-run retained pending job ${job.job_id}`);
    return { status: 'dry_run', jobId: job.job_id };
  }

  const decision = await getAlertDecision(job.alert_id);
  if (!decision) throw new Error(`alert decision not found: ${job.alert_id}`);
  const started = await markDeliveryStarted(job.alert_id, job.subscriber_id, WORKER_ID);
  if (!started) {
    const latest = await getDelivery(job.alert_id, job.subscriber_id);
    if (latest?.disposition === 'sent') {
      await completeNotificationJob(job.job_id, WORKER_ID, latest.telegram_message_id);
      return { status: 'already_sent', jobId: job.job_id };
    }
    throw new Error(`delivery audit is not sendable: ${job.alert_id}/${job.subscriber_id}`);
  }

  try {
    const response = await bot.sendMessage(job.subscriber_id, formatAlert(decision), {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    const completed = await markDeliverySent(job.alert_id, job.subscriber_id, response?.message_id, null, WORKER_ID);
    if (!completed) throw new Error(`delivery lease lost before completion: ${job.alert_id}/${job.subscriber_id}`);
    // Telegram has accepted the message. Account for trial usage only after
    // the sent state and message ID are durable; if accounting fails, the
    // retry sees disposition=sent and repairs accounting without resending.
    await recordTrialCountAfter(job.alert_id, job.subscriber_id);
    await completeNotificationJob(job.job_id, WORKER_ID, response?.message_id);
    return { status: 'sent', jobId: job.job_id, messageId: response?.message_id };
  } catch (err) {
    await markDeliveryFailed(job.alert_id, job.subscriber_id, err.message, WORKER_ID);
    throw err;
  }
}

async function runNotificationTick(bot, { dryRun = true, reclaimIntervalMs = RECLAIM_INTERVAL_MS } = {}) {
  health.markTick(WORKER_NAME);
  await reclaimStuckDeliveriesIfDue({ dryRun, reclaimIntervalMs });
  let job;
  try {
    job = await claimNotificationJob(WORKER_ID);
  } catch (err) {
    health.markError(WORKER_NAME, err, 'claim_errors_total');
    console.error(`[notification-worker] claim failed: ${err.message}`);
    return { status: 'degraded', error: err.message };
  }
  if (!job) {
    health.markSuccess(WORKER_NAME, 'empty_polls_total');
    return null;
  }
  try {
    const result = await dispatchNotificationJob(bot, job, { dryRun });
    health.markSuccess(WORKER_NAME, result.status === 'sent' ? 'jobs_sent_total' : 'jobs_skipped_total');
    return result;
  } catch (err) {
    health.markError(WORKER_NAME, err, 'job_errors_total');
    await failNotificationJob(job.job_id, WORKER_ID, err.message, job.attempts);
    console.error(`[notification-worker] job ${job.job_id} failed: ${err.message}`);
    return { status: 'failed', jobId: job.job_id, error: err.message };
  }
}

function startNotificationWorker({ dryRun = process.env.NOTIFICATION_WORKER_DRY_RUN !== 'false', pollMs = POLL_MS, healthPort = Number(process.env.HEALTH_PORT || 8080) } = {}) {
  if (!telegram.token) throw new Error('TELEGRAM_BOT_TOKEN is not set — cannot start notification worker.');
  const bot = new TelegramBot(telegram.token, { polling: false });
  health.markStarted(WORKER_NAME);
  const healthServer = healthPort === false ? { close() {} } : startHealthServer({ requiredWorkers: [WORKER_NAME], port: healthPort });
  let stopped = false;
  let inFlight = null;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = runNotificationTick(bot, { dryRun }).finally(() => { inFlight = null; });
  }, pollMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      healthServer.close();
      if (inFlight) await inFlight;
    },
  };
}

if (require.main === module) {
  startNotificationWorker();
  console.log(`[notification-worker] started in ${process.env.NOTIFICATION_WORKER_DRY_RUN === 'false' ? 'live' : 'dry-run'} mode`);
}

module.exports = { dispatchNotificationJob, runNotificationTick, startNotificationWorker, reclaimStuckDeliveriesIfDue, WORKER_ID };
