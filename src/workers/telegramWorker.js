'use strict';

const { CONSUMERS } = require('../contracts/events');
const { startConsumerWorker } = require('./consumerWorker');
const { getAlertDecision } = require('../storage/alertDecisionStore');
const subscriberStore = require('../storage/subscriberStore');
const { formatAlert } = require('../bot/alertFormatter');
const { payments, admin } = require('../config');
const { isAlertable } = require('../core/alertPolicy');
const { entitlementForSubscriber, queueDeliveryAudits, listDispatchableDeliveries } = require('../storage/deliveryStore');
const { enqueueNotificationJobs } = require('../storage/notificationJobStore');

function getEventAlertId(event) {
  const payload = event.payload || {};
  return payload.alertId || payload.alert_id || event.aggregate_id || event.aggregateId;
}

async function handleTelegramEvent(event, _consumption, { dryRun = true } = {}) {
  const alertId = getEventAlertId(event);
  const decision = await getAlertDecision(alertId);
  if (!decision) throw new Error(`alert decision not found: ${alertId}`);

  // Preserve CLASS_ALERTS/VERDICT_ALERTS semantics. The Alert Worker stores
  // all qualified decisions; this consumer decides what becomes user-facing.
  if (!isAlertable(decision)) {
    console.log(`[telegram-worker] alert ${alertId} suppressed by alert policy`);
    return { alertId, disposition: 'suppressed' };
  }

  const subscribers = await subscriberStore.getAllSubscribers();
  const queued = await queueDeliveryAudits({
    alertId,
    subscribers,
    trialAlertCount: payments.trialAlertCount,
    adminChatIds: admin.chatIds,
  });

  const text = formatAlert(decision);
  const dispatchable = await listDispatchableDeliveries(alertId);
  const jobs = await enqueueNotificationJobs({ alertId, deliveries: dispatchable });
  console.log(`[telegram-worker] ${dryRun ? 'dry-run ' : ''}queued ${jobs.length} notification job(s) for ${alertId}; text length ${text.length}`);
  return { alertId, disposition: dryRun ? 'dry_run' : 'queued', queued: jobs.length, textLength: text.length };
}

function startTelegramWorker(options = {}) {
  return startConsumerWorker({
    consumerName: CONSUMERS.TELEGRAM,
    handleEvent: (event, consumption, context) => handleTelegramEvent(event, consumption, context),
    dryRun: options.dryRun ?? true,
    pollMs: options.pollMs,
  });
}

if (require.main === module) {
  startTelegramWorker({ dryRun: process.env.WORKER_DRY_RUN !== 'false' });
  console.log('[telegram-worker] started');
}

module.exports = { startTelegramWorker, handleTelegramEvent, entitlementForSubscriber };
