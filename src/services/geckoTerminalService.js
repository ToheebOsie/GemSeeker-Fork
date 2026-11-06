const axios = require('axios');
const { geckoTerminal } = require('../config');

// --- Rate-limit handling ------------------------------------------------
//
// Same three-mechanism shape as rugcheckService.js's fix for its own 429
// storm (see that file's header for the full incident writeup this
// mirrors), scaled down to what this module actually needs: there is only
// ONE endpoint this module ever calls per poll cycle (new_pools), not one
// call per candidate token, so the "per-mint failure cache" piece of that
// design doesn't apply here — there's no per-mint request to cache
// against. What's kept:
//
// 1. MIN SPACING (geckoTerminal.minRequestIntervalMs) — a floor between
//    consecutive requests to the SAME host (primary or fallback have
//    their own independent spacing, since they're different rate-limit
//    pools on different hosts).
// 2. CIRCUIT BREAKER (rateLimitedUntil, per host) — one 429 means the
//    next scheduled poll tick for that host should not even try until
//    the breaker clears, rather than re-discovering the same 429 on the
//    very next tick.
let primaryNextAvailableAt = 0;
let primaryRateLimitedUntil = 0;
let fallbackNextAvailableAt = 0;
let fallbackRateLimitedUntil = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a standard HTTP `Retry-After` header (integer seconds or an
 * HTTP-date, per RFC 7231) into a millisecond delay. Pure/exported for
 * the same reason as rugcheckService.js's identical-in-spirit helper:
 * independently unit-testable without mocking axios.
 */
function parseRetryAfterMs(headerValue) {
  if (headerValue === undefined || headerValue === null) return null;
  const trimmed = String(headerValue).trim();
  if (trimmed === '') return null;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds)) {
    return asSeconds >= 0 ? asSeconds * 1000 : null;
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const deltaMs = asDate - Date.now();
    return deltaMs > 0 ? deltaMs : 0;
  }
  return null;
}

/**
 * How long to hold a host's circuit breaker open after a 429 — prefers
 * the server's own Retry-After when usable, bounded by maxBackoffMs.
 */
function computeBackoffMs(retryAfterHeaderValue) {
  const fromHeader = parseRetryAfterMs(retryAfterHeaderValue);
  const delay = fromHeader !== null ? fromHeader : geckoTerminal.fallbackBackoffMs;
  return Math.min(delay, geckoTerminal.maxBackoffMs);
}

/**
 * Extracts the JSON:API `included` resources into a `"type:id" -> resource`
 * lookup map, so a pool's `relationships.base_token.data` can be resolved
 * to the actual token attributes (name/symbol/address) in one step.
 * Pure, exported for testing. Never throws on a malformed/missing
 * `included` array — returns an empty map instead, matching this
 * module's general "a bad candidate must never block the rest of the
 * page" posture (see normalizeNewPoolsResponse below).
 */
function buildIncludedIndex(includedList) {
  const index = new Map();
  if (!Array.isArray(includedList)) return index;
  for (const resource of includedList) {
    if (!resource || !resource.type || !resource.id) continue;
    index.set(`${resource.type}:${resource.id}`, resource);
  }
  return index;
}

/**
 * Resolves one JSON:API pool resource's `base_token` relationship against
 * the `included` index built above. Returns null (never throws) when the
 * relationship or its target resource is missing — GeckoTerminal's own
 * docs note an unverified token's market cap can be null, and the same
 * defensive posture applies to any other field here: a page with one
 * malformed pool must not lose the other 19.
 */
function resolveRelationshipToken(poolResource, relationshipName, includedIndex) {
  const relId = poolResource?.relationships?.[relationshipName]?.data?.id;
  const relType = poolResource?.relationships?.[relationshipName]?.data?.type || 'token';
  if (!relId) return null;
  return includedIndex.get(`${relType}:${relId}`) || null;
}

function resolveBaseToken(poolResource, includedIndex) {
  return resolveRelationshipToken(poolResource, 'base_token', includedIndex);
}

function resolveQuoteToken(poolResource, includedIndex) {
  return resolveRelationshipToken(poolResource, 'quote_token', includedIndex);
}

/**
 * Flattens one `/networks/{network}/new_pools` (or the CoinGecko demo-key
 * mirror of the same endpoint) JSON:API response into an array of
 * `{ pool, baseToken, quoteToken }` pairs — the raw shape consumed by the
 * discovery adapter and earlyDiscoveryNormalizer.js
 * expects. Never throws: a response missing `data` entirely yields `[]`,
 * matching dexscreenerService.js's own "always return an array" contract
 * for the same reason (callers loop over the result unconditionally).
 */
function extractPoolsFromResponse(responseData) {
  const pools = Array.isArray(responseData?.data) ? responseData.data : [];
  const includedIndex = buildIncludedIndex(responseData?.included);
  return pools.map((pool) => ({
    pool,
    baseToken: resolveBaseToken(pool, includedIndex),
    quoteToken: resolveQuoteToken(pool, includedIndex),
  }));
}

async function throttledGet(url, { params, headers, timeout, hostKey }) {
  const now = Date.now();
  const rateLimitedUntil = hostKey === 'primary' ? primaryRateLimitedUntil : fallbackRateLimitedUntil;
  if (now < rateLimitedUntil) {
    const err = new Error(`${hostKey} host still in backoff window (${rateLimitedUntil - now}ms remaining)`);
    err.code = 'GECKOTERMINAL_CIRCUIT_OPEN';
    throw err;
  }

  const nextAvailableAt = hostKey === 'primary' ? primaryNextAvailableAt : fallbackNextAvailableAt;
  const sendAt = Math.max(now, nextAvailableAt);
  const reservedNextAvailableAt = sendAt + geckoTerminal.minRequestIntervalMs;
  if (hostKey === 'primary') primaryNextAvailableAt = reservedNextAvailableAt;
  else fallbackNextAvailableAt = reservedNextAvailableAt;

  if (sendAt > now) await sleep(sendAt - now);

  // Another queued request may have tripped the breaker while this call was
  // waiting for its reserved slot. Do not send into an active 429 backoff.
  const breakerUntil = hostKey === 'primary' ? primaryRateLimitedUntil : fallbackRateLimitedUntil;
  if (Date.now() < breakerUntil) {
    const err = new Error(`${hostKey} host entered backoff while request was queued (${breakerUntil - Date.now()}ms remaining)`);
    err.code = 'GECKOTERMINAL_CIRCUIT_OPEN';
    throw err;
  }

  try {
    return await axios.get(url, { params, headers, timeout });
  } catch (err) {
    if (err.response && err.response.status === 429) {
      const backoff = computeBackoffMs(err.response.headers?.['retry-after']);
      if (hostKey === 'primary') primaryRateLimitedUntil = Date.now() + backoff;
      else fallbackRateLimitedUntil = Date.now() + backoff;
    }
    throw err;
  }
}

/**
 * Primary path: keyless `api.geckoterminal.com/api/v2/networks/{network}/new_pools`.
 * Page 1 only (the freshest ~20 pools) — see docs/early-discovery-experiment.md
 * for why paging deeper doesn't serve this experiment's "genuinely early"
 * goal and would just spend budget re-fetching pools already captured by
 * an earlier poll.
 */
async function getNewPoolsPrimary(network = geckoTerminal.network) {
  const url = `${geckoTerminal.baseUrl}/networks/${network}/new_pools`;
  const { data } = await throttledGet(url, {
    params: { include: 'base_token,quote_token,dex', page: 1 },
    headers: { accept: 'application/json' },
    timeout: geckoTerminal.timeoutMs,
    hostKey: 'primary',
  });
  return extractPoolsFromResponse(data);
}

/**
 * Fallback path: CoinGecko's free Demo API key mirror of the same
 * endpoint (see config.js's geckoTerminal.fallbackApiKey comment for why
 * this is a separate host/rate pool rather than a genuinely independent
 * data source). Skipped entirely (throws a recognizable error, caught by
 * the caller) when no key is configured.
 */
async function getNewPoolsFallback(network = geckoTerminal.network) {
  if (!geckoTerminal.fallbackApiKey) {
    const err = new Error('GeckoTerminal fallback skipped: COINGECKO_DEMO_API_KEY is not configured');
    err.code = 'GECKOTERMINAL_FALLBACK_UNCONFIGURED';
    throw err;
  }
  const url = `${geckoTerminal.fallbackBaseUrl}/networks/${network}/new_pools`;
  const { data } = await throttledGet(url, {
    params: { include: 'base_token,quote_token,dex', page: 1 },
    headers: { accept: 'application/json', 'x-cg-demo-api-key': geckoTerminal.fallbackApiKey },
    timeout: geckoTerminal.timeoutMs,
    hostKey: 'fallback',
  });
  return extractPoolsFromResponse(data);
}

/**
 * Orchestrates primary-then-fallback for one poll cycle and reports
 * exactly how many HTTP requests it made and whether the fallback fired —
 * scripts/early-discovery-experiment.js persists both directly into
 * early_discovery_poll_log (spec section 11 item 9/10) rather than
 * inferring them from logs.
 *
 * Throws only when BOTH paths fail (or the fallback isn't configured and
 * the primary fails) — a caller-visible failure means this poll cycle
 * genuinely produced zero GeckoTerminal candidates, not that one of two
 * redundant paths had a bad moment.
 */
/**
 * Fetches metadata for one GeckoTerminal token. This is deliberately kept
 * separate from new-pool discovery: the discovery endpoint does not carry
 * the token's full social/description metadata, while the token-info endpoint
 * does. Primary and fallback share the same throttle/circuit-breaker policy
 * as pool discovery, but maintain independent host state.
 */
async function getTokenInfoPrimary(address, network = geckoTerminal.network) {
  if (!address) throw new Error('GeckoTerminal token info requires a token address');
  const url = `${geckoTerminal.baseUrl}/networks/${network}/tokens/${encodeURIComponent(address)}/info`;
  const { data } = await throttledGet(url, {
    headers: { accept: 'application/json' },
    timeout: geckoTerminal.timeoutMs,
    hostKey: 'primary',
  });
  return data;
}

async function getTokenInfoFallback(address, network = geckoTerminal.network) {
  if (!address) throw new Error('GeckoTerminal token info requires a token address');
  if (!geckoTerminal.fallbackApiKey) {
    const err = new Error('GeckoTerminal token info fallback skipped: COINGECKO_DEMO_API_KEY is not configured');
    err.code = 'GECKOTERMINAL_FALLBACK_UNCONFIGURED';
    throw err;
  }
  const url = `${geckoTerminal.fallbackBaseUrl}/networks/${network}/tokens/${encodeURIComponent(address)}/info`;
  const { data } = await throttledGet(url, {
    headers: { accept: 'application/json', 'x-cg-demo-api-key': geckoTerminal.fallbackApiKey },
    timeout: geckoTerminal.timeoutMs,
    hostKey: 'fallback',
  });
  return data;
}

async function getTokenInfo(address, network = geckoTerminal.network) {
  try {
    return { data: await getTokenInfoPrimary(address, network), usedFallback: false, source: 'geckoterminal' };
  } catch (primaryErr) {
    try {
      return { data: await getTokenInfoFallback(address, network), usedFallback: true, source: 'geckoterminal_fallback', primaryError: primaryErr.message };
    } catch (fallbackErr) {
      const err = new Error(`GeckoTerminal token info primary failed (${primaryErr.message}); fallback failed too (${fallbackErr.message})`);
      err.primaryError = primaryErr;
      err.fallbackError = fallbackErr;
      throw err;
    }
  }
}

async function getNewSolanaPools(network = geckoTerminal.network) {
  let requestCount = 0;
  try {
    requestCount += 1;
    const pairs = await getNewPoolsPrimary(network);
    return { pairs, requestCount, usedFallback: false, source: 'geckoterminal' };
  } catch (primaryErr) {
    try {
      requestCount += 1;
      const pairs = await getNewPoolsFallback(network);
      return { pairs, requestCount, usedFallback: true, source: 'geckoterminal_fallback', primaryError: primaryErr.message };
    } catch (fallbackErr) {
      const err = new Error(`GeckoTerminal primary failed (${primaryErr.message}); fallback failed too (${fallbackErr.message})`);
      err.requestCount = requestCount;
      err.primaryError = primaryErr;
      err.fallbackError = fallbackErr;
      throw err;
    }
  }
}

module.exports = {
  getNewPoolsPrimary,
  getNewPoolsFallback,
  getNewSolanaPools,
  getTokenInfoPrimary,
  getTokenInfoFallback,
  getTokenInfo,
  extractPoolsFromResponse,
  buildIncludedIndex,
  resolveBaseToken,
  resolveQuoteToken,
  parseRetryAfterMs,
  computeBackoffMs,
};
