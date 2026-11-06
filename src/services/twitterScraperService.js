const { Scraper, SearchMode, ErrorRateLimitStrategy } = require('@the-convocation/twitter-scraper');
const { socialSignals } = require('../config');
const { buildNeedlePatterns } = require('./redditService');
const { withTimeout } = require('./asyncUtils');

/**
 * Real (not stubbed) Twitter/X mention-counting via `@the-convocation/twitter-scraper`
 * — an unofficial library that reverse-engineers X's own frontend API. No
 * official API key/tier needed, but it logs in as a real X account to do it,
 * which carries the same account-ban risk every unofficial scraper does (the
 * library's own README says this explicitly). Use a throwaway account, not
 * your main one.
 *
 * NOTE ON LIBRARY CHOICE: SCRAPERS.md's own walkthrough illustrates
 * `agent-twitter-client` — as of this writing that package is DEPRECATED on
 * npm (no longer supported). `@the-convocation/twitter-scraper` is a pure-JS,
 * actively maintained port of n0madic/twitter-scraper with the same shape of
 * capability (login, searchTweets), so it's a drop-in swap for the same
 * approach without needing a second runtime (contrast with Twikit/twscrape,
 * which are Python — those would need a standalone sidecar service called
 * over HTTP, the same architecture problem telegramScraperService.js
 * describes for Telegram's MTProto requirement; see the bottom of this file
 * for that pattern if you want Twikit specifically instead).
 *
 * RATE-LIMIT HANDLING — important, and easy to get wrong: this library's
 * DEFAULT behavior on a 429 is to silently `await` until the rate-limit
 * window clears, which its own README says can take **up to 13 minutes**.
 * That would hang this function's promise for 13 minutes, and per
 * SCRAPERS.md's own "isolated failure, always" rule, tokenScanner.js's
 * outer try/catch does NOT save you from that — it only catches
 * rejections/throws, not a promise that just never resolves. A single
 * rate-limited lookup would silently turn one scan cycle into a 13-minute
 * scan cycle, blocking every other qualifying token behind it. Fixed here
 * two ways: (1) `ErrorRateLimitStrategy` makes a rate-limit THROW instead of
 * wait, and (2) an explicit timeout race as defense in depth regardless of
 * which failure mode hits.
 */

const SEARCH_TIMEOUT_MS = 10000; // matches redditService.js's timeout order of magnitude
const MAX_TWEETS_TO_SCAN = 50;

let scraper = null;
let loginPromise = null;

/**
 * Logs in once, lazily, on first real use — not at module load (there's
 * nothing to log into until SOCIAL_TWITTER_ENABLED is actually on, and
 * config env vars may not be set in deployments that never enable this).
 * Cached afterward so every qualifying token does NOT trigger a fresh
 * login — repeated logins are exactly what SCRAPERS.md's Telegram section
 * warns will get an account rate-limited or banned fast, and that warning
 * applies here too, not just to Telegram's MTProto case.
 *
 * A failed login clears the cached promise so the NEXT call gets a clean
 * retry attempt instead of permanently caching a rejection.
 */
async function ensureLogin() {
  if (scraper) {
    const stillGood = await scraper.isLoggedIn().catch(() => false);
    if (stillGood) return scraper;
    scraper = null; // session expired/invalidated — fall through and log in again
  }
  if (!loginPromise) {
    loginPromise = (async () => {
      const s = new Scraper({ rateLimitStrategy: new ErrorRateLimitStrategy() });
      if (socialSignals.twitter.cookiesJson) {
        // Cookie-based auth: lower ban risk than repeated password logins
        // (no login challenge to trip), but cookies expire — falls through
        // to username/password below if this doesn't leave us logged in.
        try {
          await s.setCookies(JSON.parse(socialSignals.twitter.cookiesJson));
        } catch (err) {
          console.error(`[twitter] failed to apply configured cookies: ${err.message}`);
        }
      }
      if (!(await s.isLoggedIn().catch(() => false))) {
        if (!socialSignals.twitter.username || !socialSignals.twitter.password) {
          throw new Error('not logged in via cookies, and TWITTER_USERNAME/TWITTER_PASSWORD are not set');
        }
        await s.login(
          socialSignals.twitter.username,
          socialSignals.twitter.password,
          socialSignals.twitter.email || undefined,
          socialSignals.twitter.twoFactorSecret || undefined,
        );
      }
      scraper = s;
      return s;
    })().catch((err) => {
      loginPromise = null;
      throw err;
    });
  }
  return loginPromise;
}


/**
 * Consumes the AsyncGenerator searchTweets() returns, matching each tweet's
 * text against needlePatterns (word-boundary, from redditService.js — same
 * reasoning as there: "AI"/"GO"/"SEND"-style short tickers would false-
 * positive constantly on a plain substring match). Stops at
 * MAX_TWEETS_TO_SCAN regardless of match count, same bounded-work reasoning
 * as redditService's `limit: 100` param.
 */
async function collectMatches(tweetsIter, needlePatterns) {
  const matches = [];
  let scanned = 0;
  for await (const tweet of tweetsIter) {
    scanned += 1;
    const text = tweet.text || '';
    if (needlePatterns.some((p) => p.test(text))) {
      matches.push({
        title: text,
        score: (tweet.likes || 0) + (tweet.retweets || 0),
        // .timestamp is Unix SECONDS in this library, not ms — verified
        // against the installed package source, not assumed. .timeParsed
        // (a real Date) is used preferentially where present; multiplying
        // .timestamp by 1000 is the fallback.
        createdAt: tweet.timeParsed ? tweet.timeParsed.getTime() : (tweet.timestamp ? tweet.timestamp * 1000 : Date.now()),
      });
    }
    if (scanned >= MAX_TWEETS_TO_SCAN) break;
  }
  return matches;
}

/**
 * @param {{ symbol?: string, name?: string }} baseToken
 * @returns {Promise<{ available: boolean, mentionCount: number|null, topPosts: Array }>}
 */
async function getTwitterSignal(baseToken) {
  if (!socialSignals.twitter.enabled) {
    return { available: false, mentionCount: null, topPosts: [] };
  }

  const needlePatterns = buildNeedlePatterns(baseToken);
  if (needlePatterns.length === 0) {
    return { available: false, mentionCount: null, topPosts: [] };
  }

  try {
    const client = await withTimeout(ensureLogin(), SEARCH_TIMEOUT_MS, '[twitter] login');
    const query = baseToken?.symbol ? `$${baseToken.symbol} OR ${baseToken.symbol}` : baseToken?.name;
    if (!query) return { available: false, mentionCount: null, topPosts: [] };

    const tweetsIter = client.searchTweets(query, MAX_TWEETS_TO_SCAN, SearchMode.Latest);
    const matches = await withTimeout(collectMatches(tweetsIter, needlePatterns), SEARCH_TIMEOUT_MS, '[twitter] search');

    matches.sort((a, b) => b.score - a.score);
    return { available: true, mentionCount: matches.length, topPosts: matches.slice(0, 5) };
  } catch (err) {
    console.error(`[twitter] lookup failed for ${baseToken?.symbol}: ${err.message}`);
    return { available: false, mentionCount: null, topPosts: [] };
  }
}

module.exports = { getTwitterSignal };

/**
 * ─────────────────────────────────────────────────────────────────────────
 * IF YOU SPECIFICALLY WANT TWIKIT INSTEAD (Python-only library, higher
 * setup cost, but sometimes more resilient to X's anti-bot changes since
 * it mirrors X's own official-app traffic more closely than a frontend-API
 * reverse-engineering approach does):
 *
 * You cannot `require()` a Python library from this file. The pattern is
 * the same one telegramScraperService.js's header comment already
 * describes for Telegram's MTProto requirement:
 *
 * 1. Write a tiny always-on Python service (FastAPI/Flask) that imports
 *    twikit, logs in ONCE at startup (not per-request — same rate-limit/
 *    ban reasoning as ensureLogin() above), and exposes one endpoint, e.g.
 *    `GET /mentions?symbol=BONK&name=Bonk` returning
 *    `{ "mentionCount": N, "posts": [...] }`.
 * 2. This file becomes a thin HTTP client:
 *
 *      const axios = require('axios');
 *      const http = axios.create({ baseURL: process.env.TWIKIT_SERVICE_URL, timeout: SEARCH_TIMEOUT_MS });
 *      async function getTwitterSignal(baseToken) {
 *        if (!socialSignals.twitter.enabled) return { available: false, mentionCount: null, topPosts: [] };
 *        try {
 *          const { data } = await http.get('/mentions', { params: { symbol: baseToken?.symbol, name: baseToken?.name } });
 *          return { available: true, mentionCount: data.mentionCount, topPosts: data.posts };
 *        } catch (err) {
 *          console.error(`[twitter] twikit service call failed: ${err.message}`);
 *          return { available: false, mentionCount: null, topPosts: [] };
 *        }
 *      }
 *
 * 3. Do the word-boundary matching (buildNeedlePatterns' regex logic) on
 *    the Python side too — don't ship a plain `.includes()` there just
 *    because it's a different language; the false-positive problem is
 *    identical regardless of which side does the matching.
 * 4. Deploy the Python service as a separate process (systemd unit, Docker
 *    sidecar, whatever fits your infra) — it needs to stay running and
 *    logged in independently of this bot's own restarts.
 *
 * Ask if you want this fully built out — it's a bigger addition (new repo/
 * process/deployment target) than the Node-native version above, so I did
 * the lower-cost one first.
 * ─────────────────────────────────────────────────────────────────────────
 */
