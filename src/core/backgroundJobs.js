'use strict';

const NOOP_STOP = async () => {};

// Workers that /readyz must see alive. A disabled worker never registers, so requiring it would make
// the health check fail forever and the platform would restart the process in a loop.
function requiredWorkers({ researchObservationWorkerEnabled, telegramWorkerName }) {
  return ['notification', ...(researchObservationWorkerEnabled ? ['research-observation'] : []), telegramWorkerName];
}

function startIf(enabled, start) {
  return enabled ? start() : NOOP_STOP;
}

module.exports = { requiredWorkers, startIf, NOOP_STOP };
