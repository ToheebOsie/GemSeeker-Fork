'use strict';

const RULE_VERSION = 'high-roi-pattern-v1';
const PRE_ENRICHMENT_RULE_VERSION = 'high-roi-pre-enrichment-v1';

const DEFAULT_RULES = Object.freeze({
  maxPriorityPoints: 12,
  priorityMinimumPoints: 8,
  watchMinimumPoints: 5,
  preEnrichmentMaximumPoints: 10,
  preEnrichmentMinimumPoints: 6,
  ageVeryEarlyMinutes: 5,
  ageEarlyMinutes: 15,
  marketCapVeryEarlyUsd: 100000,
  marketCapEarlyUsd: 250000,
  discoveryVolumeMaxUsd: 100000,
  discoveryLiquidityMinUsd: 10000,
  discoveryLiquidityMaxUsd: 50000,
  hypeBelow: 9,
  topHolderMaxPct: 30,
  firstLpLockMinPct: 99,
  currentLpLockMinPct: 90,
  currentVolumeMinUsd: 0,
});

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value) {
  return value === true;
}

function buildDiscoveryPoints({ token = {}, safety = {}, hypeScore = null } = {}, rules) {
  const ageMinutes = token.pairCreatedAt === null ? null : finiteOrNull(token.ageMinutes);
  const marketCapUsd = finiteOrNull(token.marketCap);
  const volume1hUsd = finiteOrNull(token.volume1h);
  const liquidityUsd = finiteOrNull(token.liquidity);
  const topHolderPct = finiteOrNull(safety.topHolderPct);
  const lpLockedPct = finiteOrNull(safety.lpLockedPct);
  const normalizedHype = finiteOrNull(hypeScore);
  const points = [];

  if (ageMinutes !== null) {
    if (ageMinutes <= rules.ageVeryEarlyMinutes) points.push(['discovery_age_very_early', 3]);
    else if (ageMinutes <= rules.ageEarlyMinutes) points.push(['discovery_age_early', 2]);
  }
  if (marketCapUsd !== null) {
    if (marketCapUsd < rules.marketCapVeryEarlyUsd) points.push(['market_cap_very_early', 2]);
    else if (marketCapUsd <= rules.marketCapEarlyUsd) points.push(['market_cap_early', 1]);
  }
  if (volume1hUsd !== null && volume1hUsd <= rules.discoveryVolumeMaxUsd) points.push(['discovery_volume_controlled', 1]);
  if (liquidityUsd !== null && liquidityUsd >= rules.discoveryLiquidityMinUsd && liquidityUsd <= rules.discoveryLiquidityMaxUsd) points.push(['discovery_liquidity_band', 1]);
  if (normalizedHype !== null && normalizedHype < rules.hypeBelow) points.push(['hype_below_9', 1]);
  if (topHolderPct !== null && topHolderPct <= rules.topHolderMaxPct) points.push(['first_top_holder_controlled', 1]);
  if (lpLockedPct !== null && lpLockedPct >= rules.firstLpLockMinPct) points.push(['first_lp_lock_confirmed', 1]);

  return {
    ageMinutes,
    marketCapUsd,
    volume1hUsd,
    liquidityUsd,
    hypeScore: normalizedHype,
    firstTopHolderPct: topHolderPct,
    firstLpLockedPct: lpLockedPct,
    componentPoints: Object.fromEntries(points),
    points: points.reduce((sum, [, value]) => sum + value, 0),
    maxPoints: rules.preEnrichmentMaximumPoints,
  };
}

function preEnrichmentComponents({ token = {}, safety = {}, hypeScore = null } = {}, rules = DEFAULT_RULES) {
  const discovery = buildDiscoveryPoints({ token, safety, hypeScore }, rules);
  const missingFeatures = [];
  for (const [key, value] of Object.entries({
    discoveryAgeMinutes: discovery.ageMinutes,
    discoveryMarketCapUsd: discovery.marketCapUsd,
    discoveryVolume1hUsd: discovery.volume1hUsd,
    discoveryLiquidityUsd: discovery.liquidityUsd,
    hypeScore: discovery.hypeScore,
    firstTopHolderPct: discovery.firstTopHolderPct,
    firstLpLockedPct: discovery.firstLpLockedPct,
  })) {
    if (value === null) missingFeatures.push(key);
  }
  return { ...discovery, missingFeatures };
}

function evaluatePreEnrichmentGate({ token = {}, safety = {}, hypeScore = null, rules = DEFAULT_RULES } = {}) {
  const discovery = preEnrichmentComponents({ token, safety, hypeScore }, rules);
  return {
    schemaVersion: PRE_ENRICHMENT_RULE_VERSION,
    shadowOnly: false,
    affectsLiveDecision: true,
    pass: discovery.points >= rules.preEnrichmentMinimumPoints,
    threshold: rules.preEnrichmentMinimumPoints,
    discovery,
    context: {
      platform: token.dexId || null,
      discoverySource: token.discovery?.source || null,
      discoverySources: Array.isArray(token.discovery?.sources) ? token.discovery.sources.slice() : [],
      pairCreatedAt: token.pairCreatedAt || null,
    },
  };
}

function discoveryComponents({ token = {}, safety = {}, hypeScore = null, signalLabel = null } = {}, rules) {
  const discovery = buildDiscoveryPoints({ token, safety, hypeScore }, rules);
  const points = Object.entries(discovery.componentPoints).map(([key, value]) => [key, value]);
  if (signalLabel === 'WAIT') points.push(['signal_wait', 2]);
  else if (signalLabel === 'SKIP') points.push(['signal_skip', -1]);

  const componentPoints = Object.fromEntries(points);
  return {
    ageMinutes: discovery.ageMinutes,
    marketCapUsd: discovery.marketCapUsd,
    volume1hUsd: discovery.volume1hUsd,
    liquidityUsd: discovery.liquidityUsd,
    signalLabel: signalLabel || null,
    hypeScore: discovery.hypeScore,
    firstTopHolderPct: discovery.firstTopHolderPct,
    firstLpLockedPct: discovery.firstLpLockedPct,
    componentPoints,
    points: points.reduce((sum, [, value]) => sum + value, 0),
    maxPoints: rules.maxPriorityPoints,
  };
}

function currentStateGate(currentState, rules) {
  const state = currentState && typeof currentState === 'object' ? currentState : null;
  const adverseKnown = Boolean(state && Object.prototype.hasOwnProperty.call(state, 'lastBelowSurvivalThresholdAt'));
  const holderPct = finiteOrNull(state?.topHolderPct);
  const volume1hUsd = finiteOrNull(state?.volume1hUsd);
  const lpLockedPct = finiteOrNull(state?.lpLockedPct);
  const checks = {
    noRecordedAdverseState: adverseKnown && !state.lastBelowSurvivalThresholdAt,
    holderControlled: holderPct !== null && holderPct <= rules.topHolderMaxPct,
    currentActivity: volume1hUsd !== null && volume1hUsd > rules.currentVolumeMinUsd,
    lpConfirmed: lpLockedPct !== null && lpLockedPct >= rules.currentLpLockMinPct,
  };
  return {
    available: Boolean(state),
    adverseStateKnown: adverseKnown,
    checks,
    pass: Object.values(checks).every(bool),
    missing: Object.entries({ adverseStateKnown: adverseKnown, holderPct, volume1hUsd, lpLockedPct })
      .filter(([key, value]) => key === 'adverseStateKnown' ? !value : value === null)
      .map(([key]) => key),
  };
}

function evaluateHighRoiPattern({ token = {}, safety = {}, hypeScore = null, signalLabel = null, currentState = null, observedAt = new Date().toISOString(), rules = DEFAULT_RULES } = {}) {
  const discovery = discoveryComponents({ token, safety, hypeScore, signalLabel }, rules);
  const current = currentStateGate(currentState, rules);
  const className = discovery.points >= rules.priorityMinimumPoints ? 'priority_shadow_candidate'
    : discovery.points >= rules.watchMinimumPoints ? 'watchlist_shadow_candidate'
      : 'low_similarity_or_insufficient_data';
  return {
    schemaVersion: RULE_VERSION,
    observedAt,
    shadowOnly: true,
    affectsLiveDecision: false,
    discovery,
    context: {
      platform: token.dexId || null,
      discoverySource: token.discovery?.source || null,
      discoverySources: Array.isArray(token.discovery?.sources) ? token.discovery.sources.slice() : [],
      pairCreatedAt: token.pairCreatedAt || null,
    },
    currentStateGate: current,
    classification: className,
    modelRankStatus: 'not_available_in_rule_only_mode',
    ruleReady: discovery.points >= rules.priorityMinimumPoints && current.pass,
  };
}

function attachHighRoiPatternShadow(evidence, args = {}) {
  try {
    if (!evidence || typeof evidence !== 'object') return evidence;
    evidence.highRoiPatternShadow = evaluateHighRoiPattern(args);
  } catch (error) {
    console.error(`[highRoiPatternRule] shadow evaluation failed, continuing without it: ${error.message}`);
  }
  return evidence;
}

module.exports = {
  RULE_VERSION,
  PRE_ENRICHMENT_RULE_VERSION,
  DEFAULT_RULES,
  discoveryComponents,
  preEnrichmentComponents,
  evaluatePreEnrichmentGate,
  currentStateGate,
  evaluateHighRoiPattern,
  attachHighRoiPatternShadow,
};
