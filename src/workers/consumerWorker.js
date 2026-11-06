'use strict';

const crypto = require('crypto');
const {
  claimConsumerEvent,
  completeConsumerEvent,
  failConsumerEvent,
} = require('../storage/outboxStore');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWorkerId(name) {
  return `${name}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Runs one consumer in a controlled loop. Handlers should be idempotent.
 * `dryRun` is intentionally supported so the new boundaries can shadow the
 * existing monolith without sending Telegram messages or changing research.
 */
function startConsumerWorker({ consumerName, handleEvent, pollMs = 1000, dryRun = true, logger = console }) {
  const workerId = createWorkerId(consumerName);
  let stopped = false;
  let active = false;

  const tick = async () => {
    if (stopped || active) return;
    active = true;
    let claimed = null;
    try {
      claimed = await claimConsumerEvent(consumerName, workerId);
      if (!claimed) return;

      if (dryRun) {
        logger.log(`[${consumerName}] dry-run event ${claimed.event.event_id || claimed.event.eventId} (${claimed.event.event_type || claimed.event.eventType})`);
      }
      await handleEvent(claimed.event, claimed.consumption, { dryRun });
      await completeConsumerEvent(claimed.consumption.event_id, consumerName, workerId);
    } catch (err) {
      logger.error(`[${consumerName}] event processing failed: ${err.message}`);
      if (claimed) {
        await failConsumerEvent(
          claimed.consumption.event_id,
          consumerName,
          workerId,
          err.message,
          claimed.consumption.attempts,
        );
      }
    } finally {
      active = false;
    }
  };

  const handle = setInterval(tick, pollMs);
  tick();

  return async function stop() {
    stopped = true;
    clearInterval(handle);
    while (active) await sleep(10);
  };
}

module.exports = { startConsumerWorker, createWorkerId };
