const axios = require('axios');
const { dexscreener } = require('../config');
const { normalizeSocialMetadata } = require('./socialMetadata');

const http = axios.create({ baseURL: dexscreener.baseUrl, timeout: 10000 });

/**
 * Fetches the latest token profiles DexScreener has indexed.
 * Rate limit per DexScreener docs: 60 requests/minute on this endpoint.
 * https://api.dexscreener.com/token-profiles/latest/v1
 */
async function getLatestTokenProfiles() {
  const { data } = await http.get('/token-profiles/latest/v1');
  return Array.isArray(data) ? data : [];
}

/**
 * Searches pairs matching a free-text query (used here for "pump" / "raydium").
 * Rate limit: 300 requests/minute on DEX/pairs endpoints.
 * https://api.dexscreener.com/latest/dex/search?q=...
 */
async function searchPairs(query) {
  const { data } = await http.get('/latest/dex/search', { params: { q: query } });
  return data && Array.isArray(data.pairs) ? data.pairs : [];
}

/**
 * Fetches all known trading pairs for a given token mint on a given chain.
 * https://api.dexscreener.com/tokens/v1/{chainId}/{tokenAddresses}
 *
 * For a SINGLE address. Prefer getPairsForTokens (plural) when resolving
 * more than one mint — see that function's doc comment for why.
 */
async function getPairsForToken(tokenAddress) {
  const { data } = await http.get(`/tokens/v1/${dexscreener.chainId}/${tokenAddress}`);
  return Array.isArray(data) ? data : [];
}

/**
 * Same endpoint as getPairsForToken, but resolves up to 30 token mints in
 * ONE request — this endpoint explicitly supports comma-separated
 * addresses per DexScreener's own docs
 * (https://docs.dexscreener.com/api/reference: "One or multiple,
 * comma-separated token addresses (up to 30 addresses)").
 *
 * BUG THIS FIXES: getCandidatePairs() and patternReviewer.js's review
 * loop used to call getPairsForToken (singular) once per token — up to
 * 30 separate sequential HTTP calls every scan cycle / review cycle,
 * against the documented 300 req/min "DEX/pairs" limit, adding avoidable
 * latency to a bot whose entire value proposition is speed. This is the
 * same data, one request instead of up to 30.
 *
 * Silently caps at 30 and drops anything beyond that (matching the API's
 * own hard limit) rather than throwing — callers batching their own
 * larger lists (see patternReviewer.js) are expected to chunk into
 * groups of <=30 themselves; this is the low-level primitive, not the
 * chunking policy.
 */
async function getPairsForTokens(tokenAddresses) {
  if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) return [];
  const batch = tokenAddresses.slice(0, 30).join(',');
  const { data } = await http.get(`/tokens/v1/${dexscreener.chainId}/${batch}`);
  return Array.isArray(data) ? data : [];
}

/**
 * Splits an array into chunks of at most `size` — used to batch a
 * larger-than-30 list of token addresses into DexScreener's per-request
 * cap. Exported for reuse (patternReviewer.js's review loop needs the
 * same chunking).
 */
function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Pulls one combined list of candidate pairs for this scan cycle:
 * latest profiles + search results for each configured keyword.
 * Results are deduplicated by pair address.
 *
 * Descriptions: the token-profiles endpoint is the ONLY source that
 * carries a free-text description (the /tokens/v1 pairs endpoint it gets
 * resolved through does not echo it back) — pairs sourced from
 * searchPairs() below never get a description populated, only ones
 * resolved via getLatestTokenProfiles() do. See
 * descriptionClassifier.js's no-description fallback path for how that
 * gap is handled downstream rather than silently losing those tokens.
 */
async function getCandidatePairs() {
  const seen = new Map();

  const addPair = (pair) => {
    if (pair && pair.pairAddress && !seen.has(pair.pairAddress)) {
      seen.set(pair.pairAddress, pair);
    }
  };

  // Called through module.exports (not the bare local function names)
  // specifically so this function's batching behavior is directly
  // testable the same way every other service in this codebase is
  // tested — by reassigning a property on the exported object — rather
  // than requiring an HTTP-level mock just for this one function.
  //
  // Token profiles endpoint doesn't return full pair/market data, just
  // metadata — resolve them into pairs in one batched request (up to 30
  // addresses per DexScreener's own cap on this endpoint) instead of one
  // request per profile. See getPairsForTokens's doc comment.
  try {
    const profiles = await module.exports.getLatestTokenProfiles();
    const solanaProfiles = profiles.filter((p) => p.chainId === dexscreener.chainId).slice(0, 30);
    const tokenAddresses = solanaProfiles.map((p) => p.tokenAddress).filter(Boolean);
    if (tokenAddresses.length > 0) {
      // Keyed by tokenAddress so the resolved pair below can be matched
      // back to the profile it came from and inherit its description —
      // the pairs response itself has no description field of its own.
      const profileByAddress = new Map(solanaProfiles.map((p) => [p.tokenAddress, p]));
      const pairs = await module.exports.getPairsForTokens(tokenAddresses);
      pairs.forEach((pair) => {
        const profile = profileByAddress.get(pair?.baseToken?.address);
        const socialMetadata = normalizeSocialMetadata({ profile, pair });
        addPair({
          ...pair,
          ...(profile && profile.description ? { description: profile.description } : {}),
          socialMetadata: socialMetadata.available ? socialMetadata : null,
        });
      });
    }
  } catch (err) {
    console.error(`[dexscreener] failed to fetch/resolve latest token profiles: ${err.message}`);
  }

  for (const term of dexscreener.searchTerms) {
    try {
      const pairs = await module.exports.searchPairs(term);
      pairs
        .filter((p) => p.chainId === dexscreener.chainId)
        .forEach(addPair);
    } catch (err) {
      console.error(`[dexscreener] search "${term}" failed: ${err.message}`);
    }
  }

  return Array.from(seen.values());
}

module.exports = {
  getLatestTokenProfiles,
  searchPairs,
  getPairsForToken,
  getPairsForTokens,
  getCandidatePairs,
  chunk,
};
