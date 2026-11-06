'use strict';

const { collectAndPersistNarrativeAttention } = require('./narrativeAttentionCollectionService');
const { createNarrativeAttentionAdapters } = require('./narrativeAttentionAdapters');

/**
 * Explicit one-shot production entry point. It is not scheduled or imported
 * by the scanner. Collection remains disabled unless
 * NARRATIVE_ATTENTION_COLLECTION_ENABLED=true; existing Reddit/Trends source
 * flags are independent additional gates.
 */
async function collectProductionNarrativeAttention({
  narrativeTag,
  vocabulary,
  observedAt = Date.now(),
  store = null,
  adapters = null,
  collectionConfig = null,
  socialConfig = null,
} = {}) {
  const config = (!collectionConfig || (collectionConfig.enabled === true && !socialConfig)) ? require('../config') : null;
  const effectiveCollectionConfig = collectionConfig || config.narrativeAttention;
  if (effectiveCollectionConfig?.enabled !== true) {
    return { persisted: false, reason: 'disabled', observation: null };
  }
  const effectiveSocialConfig = socialConfig || config.socialSignals;
  if (!narrativeTag || !vocabulary) {
    throw new TypeError('narrativeTag and vocabulary are required');
  }
  const resolvedAdapters = adapters || createNarrativeAttentionAdapters({
    socialConfig: effectiveSocialConfig,
    redditWindowMinutes: effectiveCollectionConfig.redditWindowMinutes,
  });
  return collectAndPersistNarrativeAttention({
    store,
    narrativeTag,
    vocabulary,
    observedAt,
    maxTerms: effectiveCollectionConfig.maxTerms,
    pauseMs: effectiveCollectionConfig.pauseMs,
    ...resolvedAdapters,
  });
}

module.exports = { collectProductionNarrativeAttention };
