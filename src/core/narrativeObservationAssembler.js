'use strict';

const { deriveNarrativeVocabulary } = require('./narrativeVocabulary');

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sumKnown(items, getter) {
  const values = items.map(getter).filter((v) => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

function median(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    const value = finite(obj?.[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Assemble one source-neutral observation per narrative. Token market inputs
 * are aggregated only when present; missing values stay null rather than being
 * silently converted to zero. `attentionByNarrative` is supplied by a future
 * adapter and is never fetched here.
 */
function assembleNarrativeObservations({ tokens = [], attentionByNarrative = {}, observedAt = Date.now() } = {}) {
  const grouped = new Map();
  for (const token of tokens) {
    const narrativeTag = String(token?.narrativeTag || token?.narrative_tag || 'uncategorized').trim() || 'uncategorized';
    if (!grouped.has(narrativeTag)) grouped.set(narrativeTag, []);
    grouped.get(narrativeTag).push(token);
  }

  return [...grouped.entries()].map(([narrativeTag, members]) => {
    const attention = attentionByNarrative[narrativeTag] || {};
    const vocabulary = deriveNarrativeVocabulary({ narrativeTag, tokens: members });
    const attentionAvailable = ['mentions', 'uniqueAuthors', 'engagement', 'trendInterest'].some((key) => {
      const snake = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      return finite(attention[key] ?? attention[snake]) !== null;
    });
    const volumes = members.map((t) => pickNumber(t, ['volume1h', 'volume_1h', 'volumeUsd1h', 'volume_usd_1h']));
    const buyers = members.map((t) => pickNumber(t, ['uniqueBuyers', 'unique_buyers', 'buyers1h', 'buyers_1h']));
    const holders = members.map((t) => pickNumber(t, ['holderCount', 'holder_count', 'holders']));
    const liquidities = members.map((t) => pickNumber(t, ['liquidityUsd', 'liquidity_usd', 'liquidity']));
    const tokenAges = members.map((t) => pickNumber(t, ['ageMinutes', 'age_minutes']));

    return {
      narrativeTag,
      observedAt,
      tokenCount: members.length,
      vocabulary,
      attention: {
        mentions: finite(attention.mentions),
        uniqueAuthors: finite(attention.uniqueAuthors ?? attention.unique_authors),
        engagement: finite(attention.engagement),
        trendInterest: finite(attention.trendInterest ?? attention.trend_interest),
        sourceCount: finite(attention.sourceCount ?? attention.source_count),
        sources: Array.isArray(attention.sources) ? [...new Set(attention.sources.map(String))] : [],
        sourceObservations: attention.sourceObservations ?? attention.source_observations ?? null,
      },
      market: {
        volumeUsd1h: sumKnown(members, (t) => pickNumber(t, ['volume1h', 'volume_1h', 'volumeUsd1h', 'volume_usd_1h'])),
        uniqueBuyers: sumKnown(members, (t) => pickNumber(t, ['uniqueBuyers', 'unique_buyers', 'buyers1h', 'buyers_1h'])),
        holderCount: sumKnown(members, (t) => pickNumber(t, ['holderCount', 'holder_count', 'holders'])),
        liquidityUsd: sumKnown(members, (t) => pickNumber(t, ['liquidityUsd', 'liquidity_usd', 'liquidity'])),
        medianTokenAgeMinutes: median(tokenAges),
        tokensWithVolume: volumes.filter((v) => v !== null).length,
        tokensWithBuyerData: buyers.filter((v) => v !== null).length,
        tokensWithHolderData: holders.filter((v) => v !== null).length,
        tokensWithLiquidityData: liquidities.filter((v) => v !== null).length,
      },
      provenance: {
        marketSource: 'provided_token_observations',
        attentionSource: attention.source || null,
        attentionAvailable,
      },
    };
  });
}

module.exports = { assembleNarrativeObservations };
