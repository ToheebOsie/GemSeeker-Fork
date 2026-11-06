'use strict';

const { CONSUMERS } = require('../contracts/events');
const { startConsumerWorker } = require('./consumerWorker');
const { getAlertDecision } = require('../storage/alertDecisionStore');
const { enqueueAlertObservationJobs } = require('../storage/researchJobStore');

async function handleResearchEvent(event) {
  const eventId = event.event_id || event.eventId;
  const payload = event.payload || {};
  const alertId = payload.alertId || payload.alert_id || event.aggregate_id || event.aggregateId;
  const decision = await getAlertDecision(alertId);
  if (!decision) throw new Error(`alert decision not found: ${alertId}`);

  const jobIds = await enqueueAlertObservationJobs({
    alertId,
    pairAddress: decision.pairAddress,
    mintAddress: decision.mintAddress,
    qualifiedAt: decision.alertDecision.qualifiedAt,
  });
  console.log(`[research-worker] scheduled ${jobIds.length} observation job(s) for ${alertId} from event ${eventId}`);
}

function startResearchWorker(options = {}) {
  return startConsumerWorker({
    consumerName: CONSUMERS.RESEARCH,
    handleEvent: handleResearchEvent,
    dryRun: options.dryRun ?? true,
    pollMs: options.pollMs,
  });
}

if (require.main === module) {
  startResearchWorker({ dryRun: process.env.WORKER_DRY_RUN !== 'false' });
  console.log('[research-worker] started');
}

module.exports = { startResearchWorker, handleResearchEvent };
