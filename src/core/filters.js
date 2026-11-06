const { scanner, rugcheck, geckoTerminal } = require('../config');

/**
 * Source-independent market-quality filters. These are deliberately limited
 * to checks whose semantics do not depend on the discovery provider.
 */
function passesCommonMarketFilters(token) {
  const tier = token.ageMinutes < scanner.newTokenAgeMinutes
    ? scanner.thresholds.new
    : scanner.thresholds.established;

  const liquidity = token.liquidity || 0;
  if (liquidity > 0) {
    if (liquidity < tier.minLiquidity) {
      return { pass: false, reason: `liquidity $${liquidity} < $${tier.minLiquidity}` };
    }
  } else {
    const marketCap = token.marketCap || 0;
    if (marketCap < tier.minMarketCapIfNoLiquidity) {
      return { pass: false, reason: `zero liquidity and marketCap $${marketCap} < $${tier.minMarketCapIfNoLiquidity}` };
    }
  }

  return passesVolumeMcapSanityCheck(token);
}

/**
 * Applies the discovery-provider-specific market gates. DexScreener keeps
 * its existing age-tiered volume/buy requirements. GeckoTerminal has its own
 * deliberately lower 1h threshold plus a cumulative-volume gate and does
 * NOT inherit DexScreener's buy-count or 1h-volume thresholds.
 */
function passesDiscoverySourceFilters(token, source) {
  if (source === 'geckoterminal') {
    const observation = token.discovery?.observations?.find((entry) => entry?.source === 'geckoterminal') || token.discovery;
    const volume1h = Number(observation?.discoveryVolume1hUsd ?? token.volume1h);
    if (!Number.isFinite(volume1h) || volume1h < geckoTerminal.discovery.minVolume1hUsd) {
      return { pass: false, reason: `gecko_volume_1h_below_threshold: $${Number.isFinite(volume1h) ? volume1h : 'unknown'} < $${geckoTerminal.discovery.minVolume1hUsd}` };
    }

    const rawTotalVolume = observation?.discoveryTotalVolumeUsd;
    if (rawTotalVolume === null || rawTotalVolume === undefined || rawTotalVolume === '') {
      return { pass: false, reason: 'gecko_total_volume_unavailable' };
    }
    const totalVolume = Number(rawTotalVolume);
    if (!Number.isFinite(totalVolume)) {
      return { pass: false, reason: 'gecko_total_volume_unavailable' };
    }
    if (totalVolume < geckoTerminal.discovery.minTotalVolumeUsd) {
      return { pass: false, reason: `gecko_total_volume_below_threshold: $${totalVolume} < $${geckoTerminal.discovery.minTotalVolumeUsd}` };
    }
    return { pass: true };
  }

  const tier = token.ageMinutes < scanner.newTokenAgeMinutes
    ? scanner.thresholds.new
    : scanner.thresholds.established;
  const volume1h = Number(token.volume1h);
  const buys1h = Number(token.buys1h);
  if (!Number.isFinite(volume1h) || volume1h < tier.minVolume1h) {
    return { pass: false, reason: `volume1h $${Number.isFinite(volume1h) ? volume1h : 'unknown'} < $${tier.minVolume1h}` };
  }
  if (!Number.isFinite(buys1h) || buys1h < tier.minBuys1h) {
    return { pass: false, reason: `buys1h ${Number.isFinite(buys1h) ? buys1h : 'unknown'} < ${tier.minBuys1h}` };
  }
  return { pass: true };
}

/**
 * Backward-compatible DexScreener market-filter entry point. Existing callers
 * and tests retain exactly the old behavior; the scanner now composes this
 * source gate with passesCommonMarketFilters for multi-source discovery.
 */
function passesMarketFilters(token) {
  const sourceCheck = passesDiscoverySourceFilters(token, 'dexscreener');
  if (!sourceCheck.pass) return sourceCheck;
  return passesCommonMarketFilters(token);
}

function passesVolumeMcapSanityCheck(token) {
  const maxRatio = scanner.thresholds.maxMcapToVolumeRatio;
  if (!maxRatio) return { pass: true };

  const marketCap = token.marketCap || 0;
  const volume1h = token.volume1h || 0;
  if (marketCap <= 0 || volume1h <= 0) return { pass: true };

  const mcToVolume = marketCap / volume1h;
  if (mcToVolume > maxRatio) {
    return { pass: false, reason: `marketCap $${marketCap} is ${mcToVolume.toFixed(1)}x volume1h $${volume1h} (> ${maxRatio}x limit)` };
  }

  const volumeToMc = volume1h / marketCap;
  if (volumeToMc > maxRatio) {
    return { pass: false, reason: `volume1h $${volume1h} is ${volumeToMc.toFixed(1)}x marketCap $${marketCap} (> ${maxRatio}x limit)` };
  }

  return { pass: true };
}

function passesSafetyGates(safety) {
  if (!safety.available) {
    return { pass: false, reason: 'no rugcheck report available yet' };
  }
  if (safety.rugged) {
    return { pass: false, reason: 'rugcheck flags this token as already rugged' };
  }
  if (safety.riskScore === null) {
    return { pass: false, reason: 'rugcheck risk score unavailable (field missing/renamed) — failing closed' };
  }
  if (safety.riskScore > rugcheck.maxRiskScore) {
    return { pass: false, reason: `rugcheck risk score ${safety.riskScore} > ${rugcheck.maxRiskScore} (higher = riskier)` };
  }
  if (safety.topHolderPct === null) {
    return { pass: false, reason: 'rugcheck top holder % unavailable (field missing/renamed) — failing closed' };
  }
  if (safety.topHolderPct > rugcheck.maxTopHolderPct) {
    return { pass: false, reason: `top holder ${safety.topHolderPct}% > ${rugcheck.maxTopHolderPct}%` };
  }
  return { pass: true };
}

module.exports = {
  passesMarketFilters,
  passesCommonMarketFilters,
  passesDiscoverySourceFilters,
  passesVolumeMcapSanityCheck,
  passesSafetyGates,
};
