'use strict';

const { collectNarrativeAttention } = require('../core/narrativeAttentionCollector');

/**
 * Collect and persist one narrative's raw term-level observations. Callers must
 * explicitly supply adapters; this service does not silently start polling.
 */
async function collectAndPersistNarrativeAttention({ store = null, ...options } = {}) {
  const observation = await collectNarrativeAttention(options);
  if (observation.summary.termsAttempted === 0) return { observation, persisted: false, reason: 'no_terms' };
  const targetStore = store || require('../storage/narrativeAttentionStore');
  await targetStore.upsertObservation({
    narrativeTag: observation.narrativeTag,
    observedAt: observation.observedAt,
    ...observation,
  });
  return { observation, persisted: true, reason: null };
}

module.exports = { collectAndPersistNarrativeAttention };
