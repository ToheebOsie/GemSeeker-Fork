/**
 * Turns raw per-source discovery data (a GeckoTerminal `{ pool, baseToken }`
 * pair from geckoTerminalService.js, or a raw DexScreener pair object from
 * dexscreenerService.js) into ONE common candidate shape that
 * earlyDiscoveryStore.js can persist regardless of which source produced
 * it. Pure functions only — no I/O, no DB, no config reads — so every
 * edge case here (missing relationship, non-numeric price string, absent
 * market cap) is testable without mocking anything.
 *
 * Deliberately a separate module from geckoTerminalService.js /
 * dexscreenerService.js: those own "how do I ask the API," this owns
 * "how do I turn what came back into the shape the experiment stores."
 *
 * Common candidate shape:
 * {
 *   mintAddress: string,        // cross-source join key (spec section 4)
 *   poolAddress: string | null,
 *   chain: string,
 *   symbol: string | null,
 *   name: string | null,
 *   priceUsd: number | null,
 *   marketCapUsd: number | null,
 *   liquidityUsd: number | null,
 *   sourceCreatedAt: Date | null,
 *   raw: object,                 // full source snapshot, stored as-is in raw_observation
 * }
 */

/**
 * Parses a value that may be a numeric string, a real number, null, or
 * undefined into a finite number or null. GeckoTerminal returns every
 * numeric attribute as a STRING (`"fdv_usd": "46060.39188"`) — Number()
 * on a genuinely missing value (null/undefined) would silently become 0,
 * which is indistinguishable from a real zero market cap; this keeps
 * "missing" as null all the way through, same discipline tokenScanner.js's
 * normalizePair already applies to pairCreatedAt/description.
 */
function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Normalizes one GeckoTerminal `{ pool, baseToken }` pair (as returned by
 * geckoTerminalService.js's extractPoolsFromResponse) into the common
 * candidate shape. Returns null (never throws) when the pool has no
 * resolvable base-token mint address — that's the one field every
 * downstream consumer requires (it's the DB's join/dedup key), so a pool
 * missing it is not a usable candidate at all, not a partially-usable one.
 */
function normalizeGeckoTerminalCandidate({ pool, baseToken }) {
  const attrs = pool?.attributes || {};
  const mintAddress = baseToken?.attributes?.address || null;
  if (!mintAddress) return null;

  const poolAddress = attrs.address || (typeof pool?.id === 'string' ? pool.id.split('_').slice(1).join('_') || null : null);

  return {
    mintAddress,
    poolAddress: poolAddress || null,
    chain: 'solana',
    symbol: baseToken?.attributes?.symbol || null,
    name: baseToken?.attributes?.name || attrs.name || null,
    // base_token_price_usd, not quote_token_price_usd — the new/target
    // token is conventionally the base side of a fresh memecoin/SOL or
    // memecoin/USDC pool (confirmed against GeckoTerminal's own
    // published examples — see geckoTerminalService.js's header).
    priceUsd: toFiniteOrNull(attrs.base_token_price_usd),
    // market_cap_usd is null for any unverified token per GeckoTerminal's
    // own docs (most brand-new memecoins); fdv_usd is the documented
    // stand-in for that case — same marketCap-then-fdv fallback order
    // tokenScanner.js's normalizePair already uses for DexScreener data.
    marketCapUsd: toFiniteOrNull(attrs.market_cap_usd) ?? toFiniteOrNull(attrs.fdv_usd),
    liquidityUsd: toFiniteOrNull(attrs.reserve_in_usd),
    sourceCreatedAt: toDateOrNull(attrs.pool_created_at),
    raw: { pool: attrs, baseToken: baseToken?.attributes || null },
  };
}

/**
 * Normalizes one raw DexScreener pair (the shape dexscreenerService.js's
 * getCandidatePairs() resolves, i.e. the SAME raw shape tokenScanner.js's
 * normalizePair consumes) into the common candidate shape. This is a
 * side-observation only — see docs/early-discovery-experiment.md for why
 * the experiment re-derives DexScreener's OWN first-seen timestamps
 * itself rather than reading them back out of tracked_tokens/alerted_pairs
 * (those only cover the subset of candidates that later qualified/
 * alerted, not every raw candidate DexScreener's discovery surfaced).
 * Returns null when the pair has no resolvable mint address, same
 * contract as normalizeGeckoTerminalCandidate above.
 */
function normalizeDexscreenerCandidate(rawPair) {
  const mintAddress = rawPair?.baseToken?.address || null;
  if (!mintAddress) return null;

  return {
    mintAddress,
    poolAddress: rawPair.pairAddress || null,
    chain: 'solana',
    symbol: rawPair.baseToken?.symbol || null,
    name: rawPair.baseToken?.name || null,
    priceUsd: toFiniteOrNull(rawPair.priceUsd),
    marketCapUsd: toFiniteOrNull(rawPair.marketCap) ?? toFiniteOrNull(rawPair.fdv),
    liquidityUsd: rawPair.liquidity ? toFiniteOrNull(rawPair.liquidity.usd) : null,
    // DexScreener reports this as epoch-ms (see tokenScanner.js's
    // normalizePair — `pair.pairCreatedAt`), not an ISO string.
    sourceCreatedAt: toDateOrNull(rawPair.pairCreatedAt),
    raw: {
      pairAddress: rawPair.pairAddress,
      baseToken: rawPair.baseToken,
      priceUsd: rawPair.priceUsd,
      marketCap: rawPair.marketCap,
      fdv: rawPair.fdv,
      liquidity: rawPair.liquidity,
      pairCreatedAt: rawPair.pairCreatedAt,
      volume: rawPair.volume,
      txns: rawPair.txns,
    },
  };
}

module.exports = {
  toFiniteOrNull,
  toDateOrNull,
  normalizeGeckoTerminalCandidate,
  normalizeDexscreenerCandidate,
};
