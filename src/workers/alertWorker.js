'use strict';

const { startScanLoop } = require('../core/tokenScanner');

/**
 * The current scanner is already the Alert Worker implementation. This
 * wrapper gives it an explicit process boundary without changing broadcast
 * behavior; the callback is supplied by the caller during migration.
 */
function startAlertWorker(onQualifiedTokens, options = {}) {
  if (typeof onQualifiedTokens !== 'function') {
    throw new TypeError('startAlertWorker requires an onQualifiedTokens callback');
  }
  return startScanLoop(onQualifiedTokens, options);
}

module.exports = { startAlertWorker };
