'use strict';

/**
 * Shared contracts for the first worker/outbox slice.
 * Keep these values stable once events are persisted; add new values rather
 * than changing the meaning of an existing one.
 */

const CONTRACT_VERSION = 1;
const ALERT_EVENT_SCHEMA_VERSION = 1;

const EVENT_TYPES = Object.freeze({
  ALERT_QUALIFIED: 'alert.qualified',
  ALERT_SUPPRESSED: 'alert.suppressed',
});

const QUALIFICATION_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  ERROR: 'ERROR',
  UNKNOWN: 'UNKNOWN',
});

const SIGNAL_STATUS = Object.freeze({
  SIGNALLED: 'SIGNALLED',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  AI_NO_VERDICT: 'AI_NO_VERDICT',
});

const BROADCAST_DISPOSITION = Object.freeze({
  ALLOW: 'ALLOW',
  SUPPRESS_CLASS: 'SUPPRESS_CLASS',
  SUPPRESS_VERDICT: 'SUPPRESS_VERDICT',
  SUPPRESS_DUPLICATE: 'SUPPRESS_DUPLICATE',
});

const CONSUMERS = Object.freeze({
  RESEARCH: 'research-worker',
  TELEGRAM: 'telegram-worker',
});

function buildEvent({ eventId, eventType, aggregateType, aggregateId, payload, occurredAt = new Date().toISOString() }) {
  if (!eventId || !eventType || !aggregateType || !aggregateId || payload === undefined) {
    throw new Error('eventId, eventType, aggregateType, aggregateId, and payload are required');
  }
  return {
    eventId,
    eventType,
    schemaVersion: ALERT_EVENT_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    aggregateType,
    aggregateId,
    payload,
    occurredAt,
  };
}

module.exports = {
  CONTRACT_VERSION,
  ALERT_EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  QUALIFICATION_STATUS,
  SIGNAL_STATUS,
  BROADCAST_DISPOSITION,
  CONSUMERS,
  buildEvent,
};
