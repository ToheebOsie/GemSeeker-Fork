'use strict';

const { NARRATIVE_RULES } = require('./narrativeClassifier');
const { extractKeywords } = require('./descriptionClassifier');

const STOP_WORDS = new Set([
  'coin', 'token', 'crypto', 'cryptocurrency', 'solana', 'sol', 'meme', 'memecoin', 'community',
  'official', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'our', 'new', 'just',
  'launch', 'launched', 'project', 'based', 'powered', 'fun', 'finance', 'web3', 'pump', 'fun',
]);

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
}

function descriptionTerms(description) {
  try {
    const result = extractKeywords(String(description || ''));
    if (Array.isArray(result)) return result.map((x) => typeof x === 'string' ? x : x?.keyword).filter(Boolean);
    if (Array.isArray(result?.keywords)) return result.keywords.map((x) => typeof x === 'string' ? x : x?.keyword).filter(Boolean);
  } catch (_) { /* malformed descriptions should not break observation assembly */ }
  return words(description);
}

function deriveNarrativeVocabulary({ narrativeTag = 'uncategorized', tokens = [], minTokenCount = 2, maxTerms = 30 } = {}) {
  const rule = NARRATIVE_RULES.find((r) => r.tag === narrativeTag);
  const curatedTerms = rule ? [...new Set(rule.keywords.map((x) => String(x).toLowerCase()))] : [];
  const counts = new Map();
  for (const token of tokens) {
    const text = `${token?.name || ''} ${token?.symbol || ''} ${token?.description || ''}`;
    const unique = new Set([...words(`${token?.name || ''} ${token?.symbol || ''}`), ...descriptionTerms(token?.description)]
      .map((x) => String(x).toLowerCase())
      .filter((x) => x.length >= 3 && !STOP_WORDS.has(x)));
    for (const term of unique) counts.set(term, (counts.get(term) || 0) + 1);
  }
  const recurringTerms = [...counts.entries()]
    .filter(([term, count]) => count >= minTokenCount && !curatedTerms.includes(term))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term, tokenCount]) => ({ term, tokenCount }));
  const queryTerms = [...new Set([...curatedTerms, ...recurringTerms.map((x) => x.term)])];
  return { narrativeTag, tokenCount: tokens.length, curatedTerms, recurringTerms, queryTerms };
}

module.exports = { deriveNarrativeVocabulary, STOP_WORDS };
