'use strict';

const TIER2_SCORE_VERSION = 'tier2-fixed-window-v1';

const DEFAULT_TIER2_RULES = Object.freeze({
  threshold: 8,
  maxPoints: 8,
  minBuyerCountStrong: 5,
  minBuyerCountWeak: 3,
  maxTop1BuyerShareStrongPct: 35,
  maxTop1BuyerShareWeakPct: 50,
  maxBuyerHhi: 0.25,
  minBuySellTransactionRatio: 1.5,
  minBuySellValueRatio: 1.1,
  minPlatformActivity60m: 1,
  maxPlatformActivity60m: 100,
  requireCompleteDiscoveryWindows: true,
});

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value) {
  return value === true;
}

function ratio(numerator, denominator) {
  const n = finite(numerator);
  const d = finite(denominator);
  if (n === null || d === null || d <= 0) return null;
  return n / d;
}

function normalizeWindow(window = {}) {
  return {
    windowKey: window.windowKey || window.window_key || null,
    featurePhase: window.featurePhase || window.feature_phase || null,
    windowEndMs: finite(window.windowEndMs ?? window.window_end_ms),
    featureCutoffAtMs: finite(window.featureCutoffAtMs ?? window.feature_cutoff_at_ms),
    coverageStatus: window.coverageStatus || window.coverage_status || 'unavailable',
    eligibleForDiscoveryModel: Boolean(window.eligibleForDiscoveryModel ?? window.eligible_for_discovery_model),
    uniqueBuyers: finite(window.uniqueBuyers ?? window.unique_buyers),
    uniqueSellers: finite(window.uniqueSellers ?? window.unique_sellers),
    buyTransactionCount: finite(window.buyTransactionCount ?? window.buy_transaction_count),
    sellTransactionCount: finite(window.sellTransactionCount ?? window.sell_transaction_count),
    valueBasis: window.valueBasis || window.value_basis || ((window.buyVolumeUsd ?? window.buy_volume_usd) != null ? 'usd' : null),
    buyValue: finite(window.buyValue ?? ((window.valueBasis || window.value_basis) === 'token_amount' ? (window.buyTokenAmount ?? window.buy_token_amount) : (window.buyVolumeUsd ?? window.buy_volume_usd))),
    sellValue: finite(window.sellValue ?? ((window.valueBasis || window.value_basis) === 'token_amount' ? (window.sellTokenAmount ?? window.sell_token_amount) : (window.sellVolumeUsd ?? window.sell_volume_usd))),
    top1BuyerSharePct: finite(window.top1BuyerSharePct ?? window.top1_buyer_share_pct),
    top5BuyerSharePct: finite(window.top5BuyerSharePct ?? window.top5_buyer_share_pct),
    top10BuyerSharePct: finite(window.top10BuyerSharePct ?? window.top10_buyer_share_pct),
    buyerHhi: finite(window.buyerHhi ?? window.buyer_hhi),
    walletDataCompletenessPct: finite(window.walletDataCompletenessPct ?? window.wallet_data_completeness_pct),
  };
}

function choosePrimaryWindow(windows) {
  const normalized = (Array.isArray(windows) ? windows : Object.values(windows || {})).map(normalizeWindow);
  return normalized.find((window) => window.windowKey === 'pre_discovery_60m')
    || normalized.find((window) => window.windowKey === 'pre_discovery_30m')
    || normalized[0]
    || normalizeWindow();
}

function evaluateCoverage(windows, platformTiming, rules) {
  const normalized = (Array.isArray(windows) ? windows : Object.values(windows || {})).map(normalizeWindow);
  const byKey = new Map(normalized.map((window) => [window.windowKey, window]));
  const requiredKeys = ['pre_discovery_30m', 'pre_discovery_60m'];
  const missing = [];
  for (const key of requiredKeys) {
    const window = byKey.get(key);
    if (!window) {
      missing.push(`${key}:missing`);
      continue;
    }
    if (window.coverageStatus !== 'complete') missing.push(`${key}:coverage_${window.coverageStatus}`);
    if (window.featurePhase !== 'discovery') missing.push(`${key}:not_discovery_phase`);
    if (!window.eligibleForDiscoveryModel) missing.push(`${key}:not_eligible`);
    if (window.windowEndMs === null) missing.push(`${key}:missing_window_end`);
    if (window.featureCutoffAtMs === null) missing.push(`${key}:missing_feature_cutoff`);
    if (window.windowEndMs !== null && window.featureCutoffAtMs !== null && window.windowEndMs > window.featureCutoffAtMs) missing.push(`${key}:after_cutoff`);
  }
  const timing = platformTiming || {};
  const contextMissing = [];
  if (timing.platform === null || timing.platform === undefined || timing.platform === '') contextMissing.push('platform');
  if (finite(timing.discoveryHourUtc) === null) contextMissing.push('discovery_hour_utc');
  if (timing.activityCoverageStatus && timing.activityCoverageStatus !== 'complete') contextMissing.push(`platform_activity:${timing.activityCoverageStatus}`);
  const complete = missing.length === 0;
  return { complete, missing, contextMissing, requiredWindowKeys: requiredKeys, platformTimingPresent: contextMissing.indexOf('platform') === -1 && contextMissing.indexOf('discovery_hour_utc') === -1, enforceComplete: rules.requireCompleteDiscoveryWindows };
}

function component(key, points, passed, value, rule, reason) {
  return { key, points: passed ? points : 0, passed: Boolean(passed), value: value ?? null, rule, reason: reason || (passed ? 'matched' : 'not_matched') };
}

function scoreTier2FixedWindowFeatures({ windows = [], platformTiming = null, rules = DEFAULT_TIER2_RULES } = {}) {
  const primary = choosePrimaryWindow(windows);
  const coverage = evaluateCoverage(windows, platformTiming, rules);
  const noSells = primary.sellTransactionCount === 0 && primary.buyTransactionCount > 0;
  const txRatio = noSells ? Infinity : ratio(primary.buyTransactionCount, primary.sellTransactionCount);
  const valueRatio = noSells && primary.buyValue > 0 ? Infinity : ratio(primary.buyValue, primary.sellValue);
  const components = [];

  const buyerBreadthPoints = primary.uniqueBuyers !== null && primary.uniqueBuyers >= rules.minBuyerCountStrong ? 2
    : primary.uniqueBuyers !== null && primary.uniqueBuyers >= rules.minBuyerCountWeak ? 1 : 0;
  components.push(component(
    'buyer_breadth', buyerBreadthPoints, buyerBreadthPoints > 0, primary.uniqueBuyers,
    `2 points >=${rules.minBuyerCountStrong} unique buyers; 1 point >=${rules.minBuyerCountWeak}`,
    primary.uniqueBuyers === null ? 'missing_unique_buyers' : undefined,
  ));

  const concentrationPoints = primary.top1BuyerSharePct !== null && primary.top1BuyerSharePct <= rules.maxTop1BuyerShareStrongPct ? 2
    : primary.top1BuyerSharePct !== null && primary.top1BuyerSharePct <= rules.maxTop1BuyerShareWeakPct ? 1 : 0;
  components.push(component(
    'buyer_concentration', concentrationPoints, concentrationPoints > 0, primary.top1BuyerSharePct,
    `2 points top-1 share <=${rules.maxTop1BuyerShareStrongPct}%; 1 point <=${rules.maxTop1BuyerShareWeakPct}%`,
    primary.top1BuyerSharePct === null ? 'missing_top1_buyer_share' : undefined,
  ));

  components.push(component(
    'buyer_diversification', 1, primary.buyerHhi !== null && primary.buyerHhi <= rules.maxBuyerHhi,
    primary.buyerHhi, `buyer HHI <=${rules.maxBuyerHhi}`, primary.buyerHhi === null ? 'missing_buyer_hhi' : undefined,
  ));

  components.push(component(
    'net_buy_transaction_flow', 1, txRatio !== null && txRatio >= rules.minBuySellTransactionRatio,
    txRatio, `buy/sell transaction ratio >=${rules.minBuySellTransactionRatio}`, txRatio === null ? 'missing_or_zero_sell_transactions' : undefined,
  ));

  components.push(component(
    'net_buy_value_flow', 1, valueRatio !== null && valueRatio >= rules.minBuySellValueRatio,
    valueRatio, `buy/sell value ratio (usd or token_amount basis) >=${rules.minBuySellValueRatio}`, valueRatio === null ? 'missing_or_zero_sell_value' : undefined,
  ));

  components.push(component(
    'wallet_activity_breadth_and_value', 1,
    primary.uniqueBuyers !== null && primary.uniqueBuyers > 0 && primary.buyValue !== null && primary.buyValue > 0,
    { uniqueBuyers: primary.uniqueBuyers, buyValue: primary.buyValue, valueBasis: primary.valueBasis },
    'at least one observed buyer and positive measured buy value',
    primary.uniqueBuyers === null || primary.buyValue === null ? 'missing_buyer_or_value_feature' : undefined,
  ));

  const activity60 = finite(platformTiming?.platformActivity60mCount);
  const rawPoints = components.reduce((sum, item) => sum + item.points, 0);
  const points = coverage.enforceComplete && !coverage.complete ? 0 : rawPoints;
  const pass = (coverage.complete || !coverage.enforceComplete) && points >= rules.threshold;
  const missingFeatures = [...new Set([
    ...coverage.missing,
    ...components.filter((item) => !item.passed && item.reason.startsWith('missing')).map((item) => item.key),
  ])];

  return {
    schemaVersion: TIER2_SCORE_VERSION,
    shadowOnly: true,
    affectsLiveDecision: false,
    threshold: rules.threshold,
    maxPoints: rules.maxPoints,
    points,
    rawPoints,
    pass,
    classification: pass ? 'tier2_priority_shadow_candidate' : points >= Math.max(1, rules.threshold - 2) ? 'tier2_watchlist_candidate' : 'tier2_insufficient_similarity',
    primaryWindow: primary.windowKey,
    coverage,
    missingFeatures: [...new Set([...missingFeatures, ...(coverage.contextMissing || [])])],
    contextOnly: {
      platformActivity60mCount: finite(platformTiming?.platformActivity60mCount),
      discoveryHourUtc: finite(platformTiming?.discoveryHourUtc),
      minutesPairToDiscovery: finite(platformTiming?.minutesPairToDiscovery),
      excludedFromPoints: true,
    },
    components,
    context: {
      platform: platformTiming?.platform || null,
      discoverySource: platformTiming?.discoverySource || null,
      discoveryHourUtc: finite(platformTiming?.discoveryHourUtc),
      discoveryDayOfWeekUtc: finite(platformTiming?.discoveryDayOfWeekUtc),
      platformActivity15mCount: finite(platformTiming?.platformActivity15mCount),
      platformActivity30mCount: finite(platformTiming?.platformActivity30mCount),
      platformActivity60mCount: activity60,
    },
  };
}

module.exports = {
  TIER2_SCORE_VERSION,
  DEFAULT_TIER2_RULES,
  normalizeWindow,
  evaluateCoverage,
  scoreTier2FixedWindowFeatures,
};
