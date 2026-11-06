const axios = require('axios');
const { socialSignals } = require('../config');

/**
 * Real (not stubbed) Reddit mention-counting, via Reddit's public,
 * unauthenticated JSON endpoints — appending `.json` to any subreddit
 * search URL returns the same data the web UI shows, no API key/OAuth
 * app registration needed. This was originally the one piece of the
 * "Social Score" feature's five sources that was feasible to wire up
 * with no extra infrastructure; Twitter/Telegram/Google Trends have
 * since been implemented too (see twitterScraperService.js,
 * telegramScraperService.js, googleTrendsService.js — SCRAPERS.md has
 * the original walkthrough all of them were built from).
 *
 * Reddit does rate-limit unauthenticated requests fairly aggressively and
 * will serve a CAPTCHA/HTML page instead of JSON if it thinks you're a
 * bot, so failures here are treated as "signal unavailable this cycle,"
 * never as something to retry aggressively or let crash a scan cycle.
 */

const http = axios.create({
  timeout: socialSignals.reddit.timeoutMs,
  headers: {
    // Reddit's public JSON endpoints are considerably more reliable with a
    // descriptive User-Agent that isn't a default HTTP client string —
    // their own API docs recommend this even for unauthenticated access.
    'User-Agent': 'gem-seeker-social-signal/1.0 (contact: set via .env if this changes)',
  },
});

/**
 * Searches one subreddit's `new` listing for posts whose title mentions
 * the given symbol/name, over the last `windowMinutes`. Deliberately reads
 * `new` (not Reddit's own search endpoint, which is heavily cached and
 * indexes slowly) so a token that started trending in the last hour is
 * actually visible.
 *
 * Matching uses the same word-boundary approach as narrativeClassifier.js
 * (`(?<![a-z])needle(?![a-z])`, allowing a digit/punctuation/string-edge
 * boundary but not another letter) rather than plain substring matching —
 * ticker symbols are very often short, ordinary words ("AI", "GO", "IT",
 * "SEND"), and a plain `.includes()` would match those inside unrelated
 * words in real post titles ("wait", "going", "kit", "sending"), inflating
 * the mention count the same way narrativeClassifier.js's old
 * 'ai'/'cat' substring-matching bug did.
 *
 * @returns {Promise<{ mentionCount: number, posts: Array<{title:string,score:number,createdAt:number}> } | null>}
 *   null means "couldn't get a reading this cycle" (network/rate-limit/
 *   parse failure) — NEVER coerced to 0, since 0 is a real, meaningful
 *   value (genuinely no mentions) and must stay distinguishable from
 *   "we don't know."
 */
async function getSubredditMentions(subreddit, needlePatterns, windowMinutes = 60) {
  try {
    const { data } = await http.get(`https://www.reddit.com/r/${subreddit}/new.json`, {
      params: { limit: 100 },
    });
    const children = data && data.data && Array.isArray(data.data.children) ? data.data.children : [];
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    if (needlePatterns.length === 0) return { mentionCount: 0, posts: [] };

    const posts = children
      .map((c) => c.data)
      .filter((p) => p && typeof p.title === 'string')
      .filter((p) => p.created_utc * 1000 >= cutoff)
      .filter((p) => needlePatterns.some((pattern) => pattern.test(p.title)))
      .map((p) => ({ title: p.title, score: p.score || 0, createdAt: p.created_utc * 1000 }));

    return { mentionCount: posts.length, posts };
  } catch (err) {
    console.error(`[reddit] mention lookup failed for r/${subreddit}: ${err.message}`);
    return null;
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds one word-boundary-matching regex per needle (symbol, `$symbol`,
 * name) — see getSubredditMentions's doc comment. `$symbol` is only
 * included when a real symbol is present: `` `$${symbol || ''}` `` would
 * otherwise produce a bare `"$"` needle whenever symbol is missing, which
 * (as plain substring OR even as a naive word-boundary match immediately
 * followed by a letter/digit) would match almost any post mentioning a
 * dollar amount at all — the exact kind of massive false-positive this
 * function exists to avoid.
 */
function buildNeedlePatterns(baseToken) {
  const rawNeedles = [];
  if (baseToken?.symbol) {
    rawNeedles.push(baseToken.symbol, `\\$${escapeRegExp(baseToken.symbol)}`);
  }
  if (baseToken?.name) {
    rawNeedles.push(baseToken.name);
  }
  return rawNeedles
    .filter(Boolean)
    .map((needle) => new RegExp(`(?<![a-z0-9])${needle.startsWith('\\$') ? needle : escapeRegExp(needle)}(?![a-z0-9])`, 'i'));
}

/**
 * Aggregates mentions for a token across every configured subreddit.
 * Runs sequentially (not Promise.all) on purpose — Reddit's rate limiting
 * is IP-wide, not per-request, so spraying concurrent requests at several
 * subreddits at once just makes ALL of them more likely to get rate-
 * limited instead of finishing faster.
 *
 * @param {{ symbol?: string, name?: string }} baseToken
 * @returns {Promise<{ available: boolean, mentionCount: number|null, topPosts: Array }>}
 */
async function getRedditSignal(baseToken) {
  if (!socialSignals.reddit.enabled) {
    return { available: false, mentionCount: null, topPosts: [] };
  }

  const needlePatterns = buildNeedlePatterns(baseToken);
  let total = 0;
  let anySucceeded = false;
  const topPosts = [];

  for (const subreddit of socialSignals.reddit.subreddits) {
    // eslint-disable-next-line no-await-in-loop
    const result = await getSubredditMentions(subreddit, needlePatterns);
    if (result) {
      anySucceeded = true;
      total += result.mentionCount;
      topPosts.push(...result.posts);
    }
  }

  if (!anySucceeded) return { available: false, mentionCount: null, topPosts: [] };

  topPosts.sort((a, b) => b.score - a.score);
  return { available: true, mentionCount: total, topPosts: topPosts.slice(0, 5) };
}

module.exports = {
  getSubredditMentions, getRedditSignal, buildNeedlePatterns, // buildNeedlePatterns exported for tests
};
