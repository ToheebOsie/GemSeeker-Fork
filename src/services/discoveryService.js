'use strict';

const { dexscreener, geckoTerminal, scanner } = require('../config');
const dexscreenerService = require('./dexscreenerService');
const geckoTerminalService = require('./geckoTerminalService');

const DISCOVERY_VERSION = process.env.DISCOVERY_FILTER_VERSION || 'discovery-v1';
const DEXSCREENER_DISCOVERY_VERSION = process.env.DEXSCREENER_DISCOVERY_VERSION || 'dexscreener-discovery-v1';
const GECKOTERMINAL_DISCOVERY_VERSION = process.env.GECKO_DISCOVERY_VERSION || 'gecko-discovery-v1';

function buildDiscoveryCohortKey(discovery = {}) {
  const threshold = discovery.discoveryThresholdUsd || null;
  return `${discovery.source || 'unknown'}:${discovery.filterVersion || DISCOVERY_VERSION}:${JSON.stringify(threshold)}`;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsePoolAgeMinutes(poolCreatedAt, nowMs = Date.now()) {
  if (!poolCreatedAt) return null;
  const createdMs = new Date(poolCreatedAt).getTime();
  if (!Number.isFinite(createdMs)) return null;
  return (nowMs - createdMs) / 60000;
}

/**
 * Converts a GeckoTerminal pool into the same raw pair contract consumed by
 * tokenScanner.normalizePair(). GeckoTerminal-specific response structure
 * stops here; the downstream scanner only sees the normalized Gem Seeker
 * token shape.
 */
function normalizeGeckoPool({ pool, baseToken, quoteToken, providerPath = 'primary' }, nowMs = Date.now()) {
  const attrs = pool?.attributes || {};
  const tokenAttrs = baseToken?.attributes || {};
  const pairAddress = attrs.address || (typeof pool?.id === 'string' ? pool.id.split('_').slice(1).join('_') : null);
  const poolCreatedAt = attrs.pool_created_at || null;
  const ageMinutes = parsePoolAgeMinutes(poolCreatedAt, nowMs);
  const volume = attrs.volume_usd || {};
  const transactions = attrs.transactions || {};
  const h1Txns = transactions.h1 || {};

  // GeckoTerminal exposes rolling h24 volume, not a lifetime/cumulative
  // volume field. For a pool younger than 24h, h24 covers the pool's entire
  // observed lifetime and is therefore a valid cumulative value. For older
  // pools we deliberately leave totalVolumeUsd null rather than relabeling
  // h24 as cumulative volume.
  const h24Volume = finiteOrNull(volume.h24);
  const totalVolumeUsd = ageMinutes !== null && ageMinutes >= 0 && ageMinutes <= 24 * 60
    ? h24Volume
    : null;
  const totalVolumeSource = totalVolumeUsd !== null ? 'volume_usd.h24_for_pool_age_le_24h' : null;

  return {
    pairAddress,
    baseToken: {
      address: tokenAttrs.address || null,
      symbol: tokenAttrs.symbol || null,
      name: tokenAttrs.name || attrs.name || null,
    },
    priceUsd: finiteOrNull(attrs.base_token_price_usd),
    priceNative: finiteOrNull(attrs.base_token_price_native_currency),
    marketCap: finiteOrNull(attrs.market_cap_usd) ?? finiteOrNull(attrs.fdv_usd),
    liquidity: { usd: finiteOrNull(attrs.reserve_in_usd) },
    volume: { h1: finiteOrNull(volume.h1), h24: h24Volume },
    totalVolumeUsd,
    totalVolumeSource,
    txns: { h1: { buys: finiteOrNull(h1Txns.buys), sells: finiteOrNull(h1Txns.sells) } },
    priceChange: { h1: finiteOrNull(attrs.price_change_percentage?.h1) },
    // tokenScanner.normalizePair uses the same epoch-ms representation as
    // DexScreener. Keep GeckoTerminal's ISO source timestamp in discovery
    // provenance rather than feeding a string into age arithmetic.
    pairCreatedAt: poolCreatedAt ? new Date(poolCreatedAt).getTime() : null,
    url: pairAddress ? `https://www.geckoterminal.com/${geckoTerminal.network}/pools/${pairAddress}` : null,
    // GeckoTerminal new_pools only supplies lightweight token attributes; full
    // description/social metadata is fetched from /tokens/{address}/info after
    // safety qualification in tokenScanner.js. Keep this field as a defensive
    // fallback for any future pool response that does include a description.
    description: tokenAttrs.description || null,
    dexId: pool?.relationships?.dex?.data?.id || null,
    quoteToken: quoteToken?.attributes?.address ? {
      address: quoteToken.attributes.address,
      symbol: quoteToken.attributes.symbol || null,
      name: quoteToken.attributes.name || null,
    } : null,
    discovery: {
      source: 'geckoterminal',
      providerPath,
      discoveredAt: new Date(nowMs).toISOString(),
      discoveryVolumeUsd: finiteOrNull(volume.h1),
      discoveryVolume1hUsd: finiteOrNull(volume.h1),
      discoveryTotalVolumeUsd: totalVolumeUsd,
      discoveryThresholdUsd: {
        volume1hUsd: geckoTerminal.discovery.minVolume1hUsd,
        totalVolumeUsd: geckoTerminal.discovery.minTotalVolumeUsd,
      },
      filterVersion: GECKOTERMINAL_DISCOVERY_VERSION,
      discoveryVersion: DISCOVERY_VERSION,
      totalVolumeSource,
      discoveryLiquidityUsd: finiteOrNull(attrs.reserve_in_usd),
      discoveryMarketCapUsd: finiteOrNull(attrs.market_cap_usd) ?? finiteOrNull(attrs.fdv_usd),
      discoveryPriceUsd: finiteOrNull(attrs.base_token_price_usd),
      discoveryAgeMinutes: ageMinutes,
      discoveryCohortKey: buildDiscoveryCohortKey({ source: 'geckoterminal', filterVersion: GECKOTERMINAL_DISCOVERY_VERSION, discoveryThresholdUsd: { volume1hUsd: geckoTerminal.discovery.minVolume1hUsd, totalVolumeUsd: geckoTerminal.discovery.minTotalVolumeUsd } }),
    },
  };
}

function normalizeDexScreenerPair(pair, nowMs = Date.now()) {
  if (!pair) return null;
  const createdAtMs = pair.pairCreatedAt || nowMs;
  const ageMinutes = (nowMs - createdAtMs) / 60000;
  const tier = ageMinutes < scanner.newTokenAgeMinutes ? scanner.thresholds.new : scanner.thresholds.established;
  return {
    ...pair,
    discovery: {
      ...(pair.discovery || {}),
      source: 'dexscreener',
      discoveredAt: new Date(nowMs).toISOString(),
      discoveryVolumeUsd: finiteOrNull(pair.volume?.h1),
      discoveryVolume1hUsd: finiteOrNull(pair.volume?.h1),
      discoveryTotalVolumeUsd: null,
      discoveryThresholdUsd: {
        volume1hUsd: tier.minVolume1h,
        buys1h: tier.minBuys1h,
        totalVolumeUsd: null,
      },
      filterVersion: DEXSCREENER_DISCOVERY_VERSION,
      discoveryVersion: DISCOVERY_VERSION,
      discoveryLiquidityUsd: finiteOrNull(pair.liquidity?.usd),
      discoveryMarketCapUsd: finiteOrNull(pair.marketCap) ?? finiteOrNull(pair.fdv),
      discoveryPriceUsd: finiteOrNull(pair.priceUsd),
      discoveryAgeMinutes: ageMinutes,
      discoveryCohortKey: buildDiscoveryCohortKey({ source: 'dexscreener', filterVersion: DEXSCREENER_DISCOVERY_VERSION, discoveryThresholdUsd: { volume1hUsd: tier.minVolume1h, buys1h: tier.minBuys1h, totalVolumeUsd: null } }),
    },
  };
}

function candidateIdentity(candidate) {
  return candidate?.pairAddress || null;
}

/**
 * Merge source observations of the same pool before expensive qualification.
 * Pair identity remains the analytical identity; mint identity alone is never
 * used here, so two different pools for the same mint remain separate.
 */
function mergeCandidates(candidates) {
  const byPair = new Map();
  for (const candidate of candidates || []) {
    const key = candidateIdentity(candidate);
    if (!key) continue;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, {
        ...candidate,
        sourceCandidates: candidate.discovery?.source ? { [candidate.discovery.source]: candidate } : {},
        discovery: {
          ...candidate.discovery,
          sources: [candidate.discovery?.source].filter(Boolean),
          observations: candidate.discovery ? [candidate.discovery] : [],
        },
      });
      continue;
    }

    const source = candidate.discovery?.source;
    const sources = existing.discovery.sources || [];
    if (source && !sources.includes(source)) sources.push(source);
    const observations = existing.discovery.observations || [];
    if (candidate.discovery) observations.push(candidate.discovery);
    if (source) existing.sourceCandidates[source] = candidate;
    existing.discovery = {
      ...existing.discovery,
      sources,
      observations,
      // Preserve the first source's discovery metrics as the canonical
      // observation, while retaining every source observation above.
      source: existing.discovery.source || source || null,
    };
  }
  return Array.from(byPair.values());
}

async function getCandidatePairs() {
  const nowMs = Date.now();
  const raw = [];

  try {
    const dexPairs = await dexscreenerService.getCandidatePairs();
    for (const pair of dexPairs) {
      const normalized = normalizeDexScreenerPair(pair, nowMs);
      if (normalized) raw.push(normalized);
    }
  } catch (err) {
    console.error(`[discovery] DexScreener discovery failed: ${err.message}`);
  }

  if (geckoTerminal.discovery.enabled) {
    try {
      const result = await geckoTerminalService.getNewSolanaPools(geckoTerminal.network);
      for (const item of result.pairs || []) {
        const normalized = normalizeGeckoPool({ ...item, providerPath: result.usedFallback ? 'fallback' : 'primary' }, nowMs);
        if (normalized) raw.push(normalized);
      }
    } catch (err) {
      console.error(`[discovery] GeckoTerminal discovery failed: ${err.message}`);
    }
  }

  return mergeCandidates(raw);
}

module.exports = {
  DISCOVERY_VERSION,
  DEXSCREENER_DISCOVERY_VERSION,
  GECKOTERMINAL_DISCOVERY_VERSION,
  buildDiscoveryCohortKey,
  normalizeGeckoPool,
  normalizeDexScreenerPair,
  mergeCandidates,
  getCandidatePairs,
};
