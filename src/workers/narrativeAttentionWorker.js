'use strict';

const { deriveNarrativeVocabulary, STOP_WORDS } = require('../core/narrativeVocabulary');
const { classifyNarrative, NARRATIVE_RULES } = require('../core/narrativeClassifier');
const { extractKeywords } = require('../core/descriptionClassifier');

function runtimeConfig() { return require('../config').narrativeAttention; }

const WORKER_NAME = 'narrative-attention';
const CURATED_KEYWORDS = new Set(NARRATIVE_RULES.flatMap((rule) => rule.keywords.map((term) => String(term).toLowerCase())));

function tokenForVocabulary(token) {
  const base = token?.baseToken && typeof token.baseToken === 'object' ? token.baseToken : {};
  return {
    mintAddress: token?.mintAddress || token?.mint_address || token?.baseToken?.address || null,
    name: base.name || token?.name || '',
    symbol: base.symbol || token?.symbol || '',
    description: token?.description || '',
  };
}

function discoveryTerms(token) {
  const identityWords = `${token.name || ''} ${token.symbol || ''}`.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
  let descriptionWords = [];
  if (token.description) {
    try {
      const result = extractKeywords(String(token.description));
      const values = Array.isArray(result) ? result : Array.isArray(result?.keywords) ? result.keywords : [];
      descriptionWords = values.map((item) => typeof item === 'string' ? item : item?.keyword).filter(Boolean);
    } catch (_) { descriptionWords = []; }
  }
  return [...new Set([...identityWords, ...descriptionWords]
    .map((term) => String(term).toLowerCase().trim())
    .filter((term) => /^[a-z][a-z0-9]{2,}$/.test(term) && !STOP_WORDS.has(term) && !CURATED_KEYWORDS.has(term)))];
}

/**
 * Combine the independent first-seen discovery feed with production-tracked
 * tokens. Known taxonomy tags use the existing classifier. Unknown names are
 * grouped into emerging:<term> cohorts only when a term occurs across at least
 * three distinct unqualified mints in the recent discovery sample.
 */
function buildNarrativeGroups(trackedTokens = [], discoveryCandidates = [], minEmergingMints = 3) {
  const groups = new Map();
  const add = (tag, token) => {
    if (!groups.has(tag)) groups.set(tag, new Map());
    const key = token.mintAddress || `${token.symbol}|${token.name}|${token.description}`;
    groups.get(tag).set(key, token);
  };

  for (const raw of trackedTokens || []) {
    const token = tokenForVocabulary(raw);
    const tag = String(raw?.narrativeTag || classifyNarrative(token) || 'uncategorized').trim() || 'uncategorized';
    add(tag, token);
  }

  const unknownCandidates = [];
  for (const raw of discoveryCandidates || []) {
    const token = tokenForVocabulary(raw);
    if (!token.name && !token.symbol && !token.description) continue;
    const tag = classifyNarrative(token);
    if (tag !== 'uncategorized') add(tag, token);
    else unknownCandidates.push(token);
  }

  const termMintSets = new Map();
  const termTokens = new Map();
  for (const token of unknownCandidates) {
    const tokenKey = token.mintAddress || `${token.symbol}|${token.name}`;
    for (const term of discoveryTerms(token)) {
      if (!termMintSets.has(term)) termMintSets.set(term, new Set());
      termMintSets.get(term).add(tokenKey);
      if (!termTokens.has(term)) termTokens.set(term, new Map());
      termTokens.get(term).set(tokenKey, token);
    }
  }
  const emergingTerms = [...termMintSets.entries()]
    .filter(([, mints]) => mints.size >= minEmergingMints)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  for (const [term] of emergingTerms) {
    groups.set(`emerging:${term}`, termTokens.get(term));
  }

  return [...groups.entries()].map(([narrativeTag, tokenMap]) => ({
    narrativeTag,
    tokens: [...tokenMap.values()],
    vocabulary: deriveNarrativeVocabulary({ narrativeTag, tokens: [...tokenMap.values()] }),
  }));
}

async function chooseDueNarratives(trackedTokens, store, limit = 3, discoveryCandidates = [], minEmergingMints = 3) {
  const groups = buildNarrativeGroups(trackedTokens, discoveryCandidates, minEmergingMints);
  const candidates = [];
  for (const group of groups) {
    // Sequential reads are intentional: the narrative set is bounded and this
    // keeps DB pressure predictable. Missing history gets first priority.
    // eslint-disable-next-line no-await-in-loop
    const latest = await store.getLatestObservation(group.narrativeTag);
    const latestMs = latest?.observedAt ? new Date(latest.observedAt).getTime() : null;
    candidates.push({
      ...group,
      latestObservedAt: Number.isFinite(latestMs) ? latestMs : null,
    });
  }
  candidates.sort((a, b) => {
    if (a.latestObservedAt === null && b.latestObservedAt !== null) return -1;
    if (a.latestObservedAt !== null && b.latestObservedAt === null) return 1;
    return (a.latestObservedAt ?? 0) - (b.latestObservedAt ?? 0) || a.narrativeTag.localeCompare(b.narrativeTag);
  });
  return candidates.slice(0, Math.max(1, Math.floor(Number(limit) || 1)));
}

async function runNarrativeAttentionCycle({
  enabled = undefined,
  maxNarrativesPerRun = undefined,
  now = Date.now(),
  getTrackedTokens = null,
  getDiscoveryCandidates = null,
  store = null,
  collect = null,
} = {}) {
  const configForEnabled = enabled === undefined ? runtimeConfig() : null;
  const isEnabled = enabled === undefined ? configForEnabled.enabled : enabled;
  if (!isEnabled) return { status: 'disabled', selected: 0, persisted: 0 };
  const config = maxNarrativesPerRun === undefined ? (configForEnabled || runtimeConfig()) : null;
  const resolvedGetTrackedTokens = getTrackedTokens || (() => require('../storage/tokenPatternStore').getTrackedTokens());
  const resolvedGetDiscoveryCandidates = getDiscoveryCandidates || (() => require('../storage/earlyDiscoveryStore').getRecentDiscoveryCandidates({
    lookbackHours: runtimeConfig().discoveryLookbackHours,
    limit: runtimeConfig().maxDiscoveryCandidates,
  }));
  const resolvedStore = store || require('../storage/narrativeAttentionStore');
  const resolvedCollect = collect || require('../services/productionNarrativeAttentionCollection').collectProductionNarrativeAttention;
  const [trackedTokens, discoveryCandidates] = await Promise.all([
    resolvedGetTrackedTokens(),
    resolvedGetDiscoveryCandidates().catch((error) => {
      console.error(`[narrative-attention] independent discovery feed unavailable: ${error.message}`);
      return [];
    }),
  ]);
  const due = await chooseDueNarratives(
    trackedTokens,
    resolvedStore,
    maxNarrativesPerRun ?? config.maxNarrativesPerRun,
    discoveryCandidates,
    config?.minEmergingMints ?? 3,
  );
  const results = [];
  for (const item of due) {
    // Keep work sequential to limit source/API bursts.
    // eslint-disable-next-line no-await-in-loop
    const result = await resolvedCollect({
      narrativeTag: item.narrativeTag,
      vocabulary: item.vocabulary,
      observedAt: now,
      store: resolvedStore,
    });
    results.push({ narrativeTag: item.narrativeTag, ...result });
  }
  return {
    status: results.length ? 'completed' : 'no_narratives',
    selected: due.length,
    discoveryCandidates: discoveryCandidates.length,
    emergingNarratives: due.filter((item) => item.narrativeTag.startsWith('emerging:')).length,
    persisted: results.filter((result) => result.persisted).length,
    results,
  };
}

function startNarrativeAttentionWorker({
  enabled = undefined,
  intervalMs = undefined,
  runCycle = runNarrativeAttentionCycle,
} = {}) {
  const config = (enabled === undefined || intervalMs === undefined) ? runtimeConfig() : null;
  const isEnabled = enabled === undefined ? config.enabled : enabled;
  const interval = intervalMs === undefined ? config.intervalMs : intervalMs;
  if (!isEnabled) {
    console.log('[narrative-attention] disabled; scheduler not started.');
    return { stop: async () => {} };
  }
  let stopped = false;
  let inFlight = null;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = require('../db/advisoryLock').withAdvisoryLock(require('../db/advisoryLock').LOCK_IDS.NARRATIVE_ATTENTION_LOOP, async () => runCycle({ enabled: true }))
      .then((result) => {
        if (result?.skipped) console.log('[narrative-attention] skipped cycle: advisory lock unavailable or held.');
        else console.log(`[narrative-attention] cycle result: ${JSON.stringify(result.result || {})}`);
      })
      .catch((error) => console.error(`[narrative-attention] cycle failed: ${error.message}`))
      .finally(() => { inFlight = null; });
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, interval);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}

if (require.main === module) {
  const worker = startNarrativeAttentionWorker();
  const shutdown = async () => { await worker.stop(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const config = runtimeConfig();
  console.log(`[narrative-attention] worker ${config.enabled ? 'enabled' : 'disabled'}; interval=${config.intervalMs}ms`);
}

module.exports = { buildNarrativeGroups, chooseDueNarratives, runNarrativeAttentionCycle, startNarrativeAttentionWorker };
