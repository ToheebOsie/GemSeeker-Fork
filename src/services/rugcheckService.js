const axios = require('axios');
const { rugcheck } = require('../config');
const { runtimeTag } = require('../observability/runtimeIdentity');

const http = axios.create({
  baseURL: rugcheck.baseUrl,
  timeout: rugcheck.reportTimeoutMs,
  headers: rugcheck.apiKey ? { 'X-API-KEY': rugcheck.apiKey } : {},
});

// --- Rate-limit handling (2026-09 fix for the 429 storm) --------------
//
// Root cause this replaces: this file had ZERO throttling — every
// candidate token in every 30s scan cycle fired an immediate, unpaced
// request at Rugcheck's full /report endpoint, and a 429 was just logged
// and returned as null with no memory of it. The very next cycle (or the
// very next candidate in the SAME cycle) would retry the identical
// request into the identical rate-limited window, so once the limit
// tripped once, EVERY subsequent call — for every token, from every
// caller (tokenScanner's live scan AND patternReviewer's 3-hourly
// review, since both share this one `http` client) — kept getting
// 429'd indefinitely. See the repeated-mint-address pattern in the
// incident log this fixes.
//
// Three independent, module-level mechanisms, so they protect both
// callers without either needing to know this exists:
//
// 1. MIN SPACING (rugcheck.minRequestIntervalMs) — a floor on the gap
//    between any two consecutive requests, so a cycle with many
//    candidates can't burst them all out at once and trip the limit
//    itself in the first place.
// 2. CIRCUIT BREAKER (rateLimitedUntil) — the moment we get ONE 429, we
//    already know we're rate-limited RIGHT NOW; there's no value in
//    letting the next candidate (or the one after that) each
//    independently discover the same fact by making their own doomed
//    request. Every call attempted before rateLimitedUntil short-
//    circuits to null immediately, at zero cost, and real requests
//    resume once it passes. We don't have a verified current rate-limit
//    figure for Rugcheck's API (check your own dashboard for your key's
//    actual tier), so absent a usable Retry-After header this falls back
//    to rugcheck.fallbackBackoffMs — tune both that and maxBackoffMs
//    once you know your real limit.
// 3. PER-MINT FAILURE CACHE (failureCache) — once a SPECIFIC mint has
//    failed, don't ask about that mint again for rugcheck.failureCacheTtlMs,
//    even after the circuit breaker above has closed. This is what
//    actually stops the "same mint fails 5 times in a row" pattern from
//    the incident log — that mint keeps reappearing as a scan candidate
//    every SCAN_INTERVAL_MS regardless of the global breaker's state.
//
// Deliberately NOT implemented: in-line multi-attempt retry-with-sleep
// inside getTokenReport itself. That would block whichever loop called
// it (tokenScanner's scan cycle or patternReviewer's review cycle) for
// however long the retries took, potentially stalling the whole cycle
// behind one bad token. Failing fast to null and letting the NEXT
// scheduled cycle pick the token back up (once it's clear of both the
// circuit breaker and its own failure-cache entry) keeps every loop's
// own cadence intact instead of piling up latency inside one tick.

let nextAvailableAt = 0; // earliest time (ms) a request may be SENT — reserved atomically, not just "last sent at"
let rateLimitedUntil = 0;
const failureCache = new Map(); // mintAddress -> "don't retry before this timestamp (ms)"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a standard HTTP `Retry-After` header into a millisecond delay.
 * Per RFC 7231 this is either an integer number of seconds or an
 * HTTP-date; Rugcheck's actual format isn't documented anywhere we've
 * verified, so both are handled rather than assuming.
 * Returns null if the header is absent or unparseable, so the caller
 * falls back to its own default instead of trusting a bogus value.
 * Exported (pure, no I/O) purely so it's independently unit-testable
 * without needing to mock axios/http.
 */
function parseRetryAfterMs(headerValue) {
  if (headerValue === undefined || headerValue === null) return null;
  // Trim before the empty-string check, not just at the top: a
  // whitespace-only value (e.g. a header mangled by some proxy in
  // transit) must be treated the same as a genuinely absent one.
  // Number(' ') is 0 in JS (a real quirk, not a typo) — without this,
  // parseRetryAfterMs(' ') silently returned 0 ("retry immediately"),
  // the opposite of "unparseable, fall back to the conservative
  // default" this function's own docstring promises. Confirmed directly
  // before this fix: computeBackoffMs(' ') returned 0, not
  // rugcheck.fallbackBackoffMs.
  const trimmed = String(headerValue).trim();
  if (trimmed === '') return null;
  const asSeconds = Number(trimmed);
  // A negative (or otherwise non-finite) numeric value is malformed input,
  // not "not a number" — it must be rejected outright here, NOT fall
  // through to Date.parse below: JS's lenient date parser will happily
  // (mis)interpret a short numeric-looking string like "-5" as a real
  // date (e.g. Date.parse('-5') resolves to a date in 2001), which would
  // silently turn a bogus negative header into a bogus positive delay.
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
 * Decides how long to hold the circuit breaker open after a 429,
 * preferring the server's own Retry-After when it gives us one usable,
 * always bounded by rugcheck.maxBackoffMs so a huge/missing Retry-After
 * can never wedge every caller for an unreasonable stretch.
 * Exported (pure) for the same testability reason as parseRetryAfterMs.
 */
function computeBackoffMs(retryAfterHeaderValue) {
  const fromHeader = parseRetryAfterMs(retryAfterHeaderValue);
  const delay = fromHeader !== null ? fromHeader : rugcheck.fallbackBackoffMs;
  return Math.min(delay, rugcheck.maxBackoffMs);
}

function isMintOnCooldown(mintAddress) {
  const until = failureCache.get(mintAddress);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    failureCache.delete(mintAddress);
    return false;
  }
  return true;
}

function markMintFailed(mintAddress) {
  // Opportunistic sweep instead of a dedicated setInterval — keeps this
  // module free of a timer that would need wiring into index.js's
  // shutdown sequence. Cheap: a few thousand entries is nothing to
  // iterate, and it only runs once the map has actually grown.
  if (failureCache.size > 1000) {
    const now = Date.now();
    for (const [mint, until] of failureCache) {
      if (now >= until) failureCache.delete(mint);
    }
  }
  failureCache.set(mintAddress, Date.now() + rugcheck.failureCacheTtlMs);
}

/**
 * Fetches the FULL safety report for a token mint.
 * GET /tokens/{mint}/report
 *
 * NOTE: we deliberately use the full /report endpoint, not /report/summary.
 * The summary endpoint does NOT include topHolders, which the top-holder
 * concentration gate depends on — using it silently disabled that gate.
 * The full report is heavier, so keep an eye on Rugcheck rate limits if you
 * scale up scan frequency or subscriber count — see the rate-limit
 * handling block above this function for how that's enforced client-side.
 *
 * Returns null if the report isn't available — a brand-new/unindexed
 * token, a rate limit, or a skip via the circuit breaker / per-mint
 * failure cache above — rather than throwing, so callers can just skip it.
 */
async function getTokenReport(mintAddress) {
  if (isMintOnCooldown(mintAddress)) {
    return null;
  }
  if (Date.now() < rateLimitedUntil) {
    // Already known to be rate-limited — every call attempted here is a
    // guaranteed 429, so don't spend one making it. No per-call log:
    // logging once when the breaker TRIPS (below) gives enough context;
    // logging again for every skipped candidate is exactly the log spam
    // the original incident had.
    return null;
  }

  // Reserve the next send slot BEFORE any await — this whole block is
  // synchronous, so two concurrent callers (tokenScanner's scan cycle and
  // patternReviewer's review cycle, running in the same process) can never
  // interleave here: whichever one's synchronous code runs first claims a
  // distinct slot and pushes nextAvailableAt forward for the other. The
  // previous version read `elapsed` and only wrote the "last sent"
  // timestamp AFTER an `await sleep(...)` — when two callers both needed
  // to wait, both read the same stale timestamp before either wrote back,
  // computed the identical sleep duration, and woke up to fire their
  // requests at the exact same instant, silently defeating the spacing
  // guarantee for exactly the concurrent-burst case it exists to handle.
  // Confirmed directly: two concurrent calls landed 0ms apart instead of
  // minRequestIntervalMs apart before this fix.
  const now = Date.now();
  const sendAt = Math.max(now, nextAvailableAt);
  nextAvailableAt = sendAt + rugcheck.minRequestIntervalMs;
  if (sendAt > now) {
    await sleep(sendAt - now);
  }

  // A request may have been queued before another caller received a 429.
  // Re-check the breaker after the wait so queued requests do not immediately
  // hammer the service during the newly opened backoff window.
  if (Date.now() < rateLimitedUntil) {
    return null;
  }

  const startedAt = Date.now();

  try {
    const { data } = await http.get(`/tokens/${mintAddress}/report`);
    console.log(`[rugcheck] report fetched for ${mintAddress} in ${Date.now() - startedAt}ms (${runtimeTag()})`);
    return data;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    if (err.response && err.response.status === 429) {
      const backoffMs = computeBackoffMs(err.response.headers && err.response.headers['retry-after']);
      const newUntil = Date.now() + backoffMs;
      if (newUntil > rateLimitedUntil) {
        console.error(`[rugcheck] rate limited — backing off ${Math.round(backoffMs / 1000)}s (until ${new Date(newUntil).toISOString()}) (${runtimeTag()})`);
        rateLimitedUntil = newUntil;
      }
      markMintFailed(mintAddress);
      return null;
    }
    if (err.response && (err.response.status === 404 || err.response.status === 400)) {
      // Genuinely "not available" (brand-new/unindexed token), not a
      // rate limit — but still worth a short cooldown so a token that
      // keeps reappearing as a scan candidate doesn't burn a request on
      // the same "not indexed yet" answer every single cycle.
      markMintFailed(mintAddress);
      return null;
    }

    const isTransientNetworkError =
      err.code === 'ECONNABORTED' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNRESET' ||
      err.code === 'EAI_AGAIN' ||
      err.code === 'ENETUNREACH' ||
      err.code === 'EHOSTUNREACH';

    if (isTransientNetworkError) {
      // A timeout/reset/DNS/network failure is not evidence that the mint
      // itself is unavailable. Do NOT put it in the per-mint failure cache;
      // the next scheduled scan should be allowed to try again.
      console.warn(
        `[rugcheck] transient network failure for ${mintAddress} after ${elapsedMs}ms: ${err.message} (code=${err.code || 'unknown'}) (${runtimeTag()})`
      );
      return null;
    }

    console.error(
      `[rugcheck] report fetch failed for ${mintAddress} after ${elapsedMs}ms: ${err.message} ` +
      `(code=${err.code || 'unknown'}, status=${err.response?.status ?? 'none'}) (${runtimeTag()})`
    );
    markMintFailed(mintAddress);
    return null;
  }
}

// Kept as an alias so nothing else in the codebase breaks if it still
// references the old function name.
const getTokenReportSummary = getTokenReport;

/**
 * Normalizes a Rugcheck report into the fields the filter/scoring logic
 * cares about.
 *
 * IMPORTANT — score direction: Rugcheck's `score_normalised` (falls back to
 * `score` if that field is absent) is a RISK score from 0-100, where HIGHER
 * MEANS RISKIER — not a trust/safety score. Rugcheck's own bands:
 *   0-30  = Low risk (Good)
 *   30-60 = Medium risk (caution)
 *   60-100 = High risk (danger)
 * We expose this as `riskScore` (not `score`) throughout the codebase to
 * make the direction impossible to mix up by accident.
 *
 * Field names follow Rugcheck's documented /report response shape as of
 * writing — re-verify against https://api.rugcheck.xyz/swagger/index.html
 * if fields come back undefined, since this is a third-party API that can
 * change without notice.
 *
 * @param {object} report - raw Rugcheck /report response
 * @param {string} [pairAddress] - the specific pool this bot is tracking
 *   for this token (same value DexScreener calls pairAddress) — needed to
 *   pick the right entry out of report.markets[] when there's more than
 *   one. See the lpLockedPct derivation below for why this is required.
 */
function extractSafetySignals(report, pairAddress) {
  if (!report) {
    return { available: false };
  }

  const riskScore = typeof report.score_normalised === 'number'
    ? report.score_normalised
    : (typeof report.score === 'number' ? report.score : null);

  const topHolders = Array.isArray(report.topHolders) ? report.topHolders : [];
  const topHolderPct = topHolders.length > 0
    ? Math.max(...topHolders.map((h) => Number(h.pct) || 0))
    : null;

  const rugged = Boolean(report.rugged);

  // Keep the structured risk objects (name + level) rather than flattening
  // to strings, so scoring can weight "danger" flags heavier than "warn" ones.
  const risks = Array.isArray(report.risks)
    ? report.risks.map((r) => ({
      name: r.name || r.description || 'unknown risk',
      level: r.level === 'danger' ? 'danger' : 'warn',
    }))
    : [];

  // AUDIT FIX: report.lpLockedPct as a flat top-level field DOES NOT EXIST
  // in Rugcheck's real /report response — confirmed against a live
  // response (fetched directly: a WIF report showed `typeof
  // report.lpLockedPct === 'undefined'`), meaning this returned null on
  // EVERY real call since whichever session introduced this "direct
  // field" read (see the comment on the old regex-replacement below)
  // without verifying it against a live response — not an occasional
  // gap, a 100% miss rate, confirmed by pattern_archive showing every
  // single 'partial-unknown' rugged row (747 of 869, 86%) with BOTH
  // first_lp_locked_pct AND last_lp_locked_pct null, including tokens
  // reviewed many times over hours.
  //
  // The real data lives per-MARKET: report.markets[] is an array of
  // every pool for this mint (923 of them for WIF alone), each with its
  // own `lp` object containing lpLockedPct. A single mint can have many
  // pools with very different lock statuses, so pubkey-matching against
  // the SPECIFIC pool this bot is actually tracking (pairAddress — the
  // same value DexScreener uses, since both index the same on-chain pool
  // account) is the only correct way to pick one. Aggregating across
  // unrelated pools (min/max/first) would reintroduce exactly the kind
  // of "guess at a dangerous default" this function already explicitly
  // rejects below for liquidityLocked — a rugger could leave one decoy
  // pool locked while draining the real one, and picking the wrong
  // pool's number would misreport it as safe.
  //
  // The flat-field read is kept FIRST, not removed — every one of the
  // ~30 test fixtures across test/regression.test.js that mock
  // getTokenReport still use a simple `{ lpLockedPct: N }` shape, and
  // none of them needed rewriting for this fix (same reasoning as
  // gemini_signal_generator.js's generateSignal: don't force a rewrite
  // of dozens of call sites for no functional gain). It's also
  // genuinely correct defensive code regardless of that — if Rugcheck
  // ever adds this back as a flat field in some future API version,
  // it's picked up automatically, no code change needed. Real
  // production calls (report.lpLockedPct always undefined, confirmed
  // above) fall through to the market-matched extraction.
  //
  // No match found (pairAddress not provided, or genuinely absent from
  // report.markets — e.g. Rugcheck hasn't indexed this specific pool
  // yet even though it has data for other pools of the same mint) fails
  // closed to null, same as every other "we don't know" case in this
  // function — never a guessed aggregate.
  let lpLockedPct = typeof report.lpLockedPct === 'number' ? report.lpLockedPct : null;
  if (lpLockedPct === null && pairAddress && Array.isArray(report.markets)) {
    const market = report.markets.find((m) => m && m.pubkey === pairAddress);
    if (market && market.lp && typeof market.lp.lpLockedPct === 'number') {
      lpLockedPct = market.lp.lpLockedPct;
    }
  }
  const liquidityLocked = lpLockedPct === null ? null : lpLockedPct > 0;

  // Mint/freeze authority — item 5 from the AI-training-pipeline proposal
  // audit (HANDOFF.md), "expand rug-mechanism evidence beyond LP/top-
  // holder." Unlike lpLockedPct, these are direct top-level fields on the
  // report (confirmed present in Rugcheck's real response shape via
  // third-party wrapper libraries' own field lists — report.mintAuthority
  // / report.freezeAuthority — though not verified against a live call
  // from this environment, same "re-verify against
  // https://api.rugcheck.xyz/swagger/index.html if fields come back
  // undefined" caveat as lpLockedPct above applies here too).
  //
  // SPL token semantics make this simpler than lpLockedPct's per-pool
  // matching problem: a mint/freeze authority is either a real pubkey
  // (someone still holds it — a live risk, since they can mint unlimited
  // new supply or freeze any holder's balance at will) or it's been
  // permanently, irreversibly renounced (null/absent — once renounced,
  // it can never be re-acquired). There's no equivalent "which pool do I
  // even measure" ambiguity, so unlike liquidityLocked this never needs
  // a third "unknown" state when the report itself is available — only
  // whether a non-empty pubkey string is present.
  const mintAuthorityHeld = typeof report.mintAuthority === 'string' && report.mintAuthority.length > 0;
  const freezeAuthorityHeld = typeof report.freezeAuthority === 'string' && report.freezeAuthority.length > 0;

  return {
    available: true,
    riskScore,
    topHolderPct,
    rugged,
    risks,
    lpLockedPct,
    liquidityLocked, // true / false / null (unknown — treat cautiously, not as "locked")
    mintAuthorityHeld,
    freezeAuthorityHeld,
  };
}

/**
 * Tier 1 wallet clustering: pulls wallet-level top-holder data out of the
 * SAME /report response extractSafetySignals already reduces to a single
 * max topHolderPct number above — this doesn't cost an extra API call, it
 * just stops throwing away a field that was already being paid for.
 *
 * Filters out non-wallet holders. Rugcheck's topHolders array mixes real
 * wallets in with LP/AMM pool accounts (a pool address legitimately shows
 * up as a "top holder" of its own pair) — left in, a DEX pool address
 * would "recur across every token on that DEX" and swamp real cross-launch
 * wallet signal with noise. A pool/program holder entry carries a `type`
 * field (e.g. "AMM"); a plain wallet holder doesn't. This is inferred from
 * third-party example responses, not Rugcheck's own schema docs — if
 * real wallets start coming back filtered out (or pool addresses start
 * leaking through), re-verify the `type` field's actual shape against
 * https://api.rugcheck.xyz/swagger/index.html and adjust the filter below.
 *
 * Uses `owner`, never `address`: `address` is the SPL associated token
 * account for this one (wallet, mint) pair and will never repeat across
 * different launches even for the same wallet — `owner` is the actual
 * wallet, which is what cross-launch clustering needs.
 *
 * Returns [] (never null/undefined) whenever there's nothing usable —
 * no report, no topHolders array, or every entry filtered out — so
 * callers can loop over the result unconditionally without a null check.
 *
 * @param {object|null} report - raw getTokenReport() response
 * @returns {Array<{ owner: string, pct: number, insider: boolean|null }>}
 */
function extractTopHolderWallets(report) {
  if (!report || !Array.isArray(report.topHolders)) return [];

  return report.topHolders
    .filter((h) => h && typeof h.owner === 'string' && h.owner.length > 0 && !h.type)
    .map((h) => ({
      owner: h.owner,
      pct: Number(h.pct) || 0,
      insider: typeof h.insider === 'boolean' ? h.insider : null,
    }));
}

/**
 * Permissive sibling of extractTopHolderWallets: returns EVERY topHolders
 * entry with a usable owner, INCLUDING the `type`-tagged (LP/AMM/pool)
 * ones extractTopHolderWallets filters out. Exists for
 * edpiWalletSelection.js's Top-20 selection, which needs to rank
 * candidates by raw holder position BEFORE excluding infrastructure
 * addresses (a large LP entry can occupy one of the top 20 ranks even
 * though it's then excluded) — see that module's header for why
 * filter-then-rank and rank-then-filter give different populations, and
 * why the spec calls for the latter.
 *
 * Every other existing caller of Rugcheck top-holder data
 * (extractTopHolderWallets itself, and everything built on it — wallet
 * clustering, walletExposure, walletExperience) is UNCHANGED by this
 * addition; this is a new, additive read of the same already-fetched
 * `report.topHolders`, not a replacement for the filtered version.
 *
 * @param {object|null} report - raw getTokenReport() response
 * @returns {Array<{ owner: string, pct: number, type: string|null, insider: boolean|null }>}
 */
function extractRawTopHolders(report) {
  if (!report || !Array.isArray(report.topHolders)) return [];

  return report.topHolders
    .filter((h) => h && typeof h.owner === 'string' && h.owner.length > 0)
    .map((h) => ({
      owner: h.owner,
      pct: Number(h.pct) || 0,
      type: typeof h.type === 'string' && h.type.length > 0 ? h.type : null,
      insider: typeof h.insider === 'boolean' ? h.insider : null,
    }));
}

module.exports = {
  getTokenReport,
  getTokenReportSummary, // deprecated alias, kept for backwards compatibility
  extractSafetySignals,
  extractTopHolderWallets,
  extractRawTopHolders,
  // Pure helpers, exported only for unit testing the rate-limit math in
  // isolation (no axios/http mocking required) — not meant to be called
  // from elsewhere in the app.
  parseRetryAfterMs,
  computeBackoffMs,
};
