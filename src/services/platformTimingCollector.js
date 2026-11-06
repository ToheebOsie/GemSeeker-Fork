'use strict';

const { query } = require('../db/pool');

const PLATFORM_TIMING_VERSION = 'platform-timing-v1';
const ACTIVITY_WINDOWS_MINUTES = Object.freeze([15, 30, 60]);

function finiteMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalPlatform(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!normalized) return null;
  const aliases = {
    raydiumv4: 'raydium',
    raydium: 'raydium',
    raydiumclmm: 'raydium_clmm',
    pumpfun: 'pump_fun',
    'pump.fun': 'pump_fun',
    pump: 'pump_fun',
    pumpswap: 'pump_swap',
    meteora: 'meteora',
    orca: 'orca',
    moonshot: 'moonshot',
    bonk: 'bonk',
  };
  return aliases[normalized] || normalized;
}

function sourcePath(token) {
  const discovery = token?.discovery || {};
  const sources = Array.isArray(discovery.sources)
    ? discovery.sources.filter(Boolean).map(String)
    : [discovery.source].filter(Boolean).map(String);
  return [...new Set(sources)].sort();
}

function derivePlatformTimingFeatures(token, cutoffMs = Date.now()) {
  const discovery = token?.discovery || {};
  const discoveredAtMs = finiteMs(discovery.discoveredAt ?? token?.discoveredAt);
  const pairCreatedAtMs = finiteMs(token?.pairCreatedAt);
  const qualifiedAtMs = finiteMs(cutoffMs);
  const platform = canonicalPlatform(token?.platform || token?.launchPlatform || token?.dexId);
  const sources = sourcePath(token);
  const safeDelta = (a, b) => a !== null && b !== null && a >= b ? (a - b) / 60000 : null;
  return {
    version: PLATFORM_TIMING_VERSION,
    platform,
    dexId: token?.dexId ? String(token.dexId) : null,
    discoverySource: sources[0] || null,
    discoverySources: sources,
    providerPath: token?.discovery?.providerPath || null,
    discoveredAtMs,
    pairCreatedAtMs,
    qualifiedAtMs,
    featureCutoffAtMs: qualifiedAtMs,
    discoveryHourUtc: discoveredAtMs === null ? null : new Date(discoveredAtMs).getUTCHours(),
    discoveryDayOfWeekUtc: discoveredAtMs === null ? null : new Date(discoveredAtMs).getUTCDay(),
    qualificationHourUtc: qualifiedAtMs === null ? null : new Date(qualifiedAtMs).getUTCHours(),
    qualificationDayOfWeekUtc: qualifiedAtMs === null ? null : new Date(qualifiedAtMs).getUTCDay(),
    discoveryIsWeekendUtc: discoveredAtMs === null ? null : [0, 6].includes(new Date(discoveredAtMs).getUTCDay()),
    minutesPairToDiscovery: safeDelta(discoveredAtMs, pairCreatedAtMs),
    minutesDiscoveryToQualification: safeDelta(qualifiedAtMs, discoveredAtMs),
    timingMissingFields: [
      ['discovered_at_ms', discoveredAtMs],
      ['pair_created_at_ms', pairCreatedAtMs],
      ['platform', platform],
    ].filter(([, value]) => value === null).map(([key]) => key),
    platformActivity15mCount: null,
    platformActivity30mCount: null,
    platformActivity60mCount: null,
    activityCoverageStatus: 'not_attempted',
  };
}

async function loadPlatformActivityCounts({ db = null, platform, discoverySource, cutoffMs, pairAddress }) {
  if (!platform || !Number.isFinite(cutoffMs)) {
    return { counts: { 15: null, 30: null, 60: null }, status: 'unavailable', missingFields: ['platform_activity'] };
  }
  const runner = db || { query };
  try {
    const { rows } = await runner.query(
      `SELECT
         COUNT(DISTINCT pair_address) FILTER (WHERE discovered_at >= $2::timestamptz - INTERVAL '15 minutes')::int AS activity_15m,
         COUNT(DISTINCT pair_address) FILTER (WHERE discovered_at >= $2::timestamptz - INTERVAL '30 minutes')::int AS activity_30m,
         COUNT(DISTINCT pair_address) FILTER (WHERE discovered_at >= $2::timestamptz - INTERVAL '60 minutes')::int AS activity_60m
       FROM discovery_events
       WHERE (
           dex_id = $1
           OR regexp_replace(replace(lower(COALESCE(dex_id, '')), '.', ''), '[ _-]+', '', 'g')
              = regexp_replace(lower($1), '[_-]+', '', 'g')
         )
         AND discovered_at >= $2::timestamptz - INTERVAL '60 minutes'
         AND discovered_at < $2::timestamptz
         AND pair_address <> $3
         AND ($4::text IS NULL OR source = $4)`,
      [platform, new Date(cutoffMs), pairAddress || '∅', discoverySource || null],
    );
    const row = rows[0] || {};
    return {
      counts: { 15: Number(row.activity_15m) || 0, 30: Number(row.activity_30m) || 0, 60: Number(row.activity_60m) || 0 },
      status: 'complete',
      missingFields: [],
    };
  } catch (error) {
    return { counts: { 15: null, 30: null, 60: null }, status: 'error', missingFields: ['platform_activity'], error };
  }
}

async function collectPlatformTimingFeatures({ token, cutoffMs = Date.now(), db = null } = {}) {
  const derived = derivePlatformTimingFeatures(token, cutoffMs);
  const activity = await loadPlatformActivityCounts({
    db,
    platform: derived.platform,
    discoverySource: derived.discoverySource,
    cutoffMs: derived.discoveredAtMs ?? cutoffMs,
    pairAddress: token?.pairAddress,
  });
  return {
    ...derived,
    platformActivity15mCount: activity.counts[15],
    platformActivity30mCount: activity.counts[30],
    platformActivity60mCount: activity.counts[60],
    activityCoverageStatus: activity.status,
    timingMissingFields: [...new Set([...derived.timingMissingFields, ...activity.missingFields])],
    activityError: activity.error || null,
  };
}

module.exports = {
  PLATFORM_TIMING_VERSION,
  ACTIVITY_WINDOWS_MINUTES,
  finiteMs,
  canonicalPlatform,
  derivePlatformTimingFeatures,
  loadPlatformActivityCounts,
  collectPlatformTimingFeatures,
};
