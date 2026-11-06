const googleTrends = require('google-trends-api');
const { socialSignals } = require('../config');
const { withTimeout } = require('./asyncUtils');

/**
 * Real (not stubbed) Google Trends lookup, via the `google-trends-api`
 * npm package — an unofficial wrapper around the same two-step public
 * endpoint the trends.google.com website itself calls (an `/explore`
 * request to get a widget token, then a `/widgetdata/multiline` request
 * using that token). That handshake is genuinely fragile to hand-roll
 * (undocumented response-prefix stripping, token/request-object shapes that
 * change without notice) — this package already does it, so this file
 * stays a thin, testable wrapper around it rather than reimplementing
 * request/response parsing that's easy to get subtly wrong.
 *
 * STILL WORTH READING BEFORE YOU RELY ON THIS: Google Trends is a
 * genuinely poor fit for this bot's actual usage pattern, same caution
 * as this file's previous placeholder version gave. This bot alerts on
 * tokens *minutes* after launch — Trends needs real, accumulated search
 * volume to register anything at all, and a memecoin that's 10-30
 * minutes old essentially never has any yet. Implementing this correctly
 * doesn't change that; expect `available: false` far more often than the
 * other sources, even once everything below is configured and working.
 * More useful for patternReviewer.js's later re-checks on tokens still
 * being tracked hours/days on, where real search volume has had time to
 * accumulate, than for the alert-time signal itself.
 *
 * RETURN SHAPE, NOTE AGAIN: a single 0-100 "interest over time" score,
 * not a mention count or post list — socialSignals.js's
 * scoreTrendsInterest already expects exactly this shape (a straight
 * /10 rescale, since interestScore is already bounded 0-100 by
 * definition).
 *
 * NO ACCOUNT/SESSION NEEDED — unlike Twitter/X and Telegram, this hits
 * an unauthenticated public endpoint, so there's no login lifecycle to
 * manage here; every call is independent. The tradeoff: Google can (and
 * does, per this library's own README/issues) rate-limit or serve an
 * unexpected response shape without warning, same "not officially
 * supported" risk as any endpoint reverse-engineered from a website's own
 * frontend rather than a published API.
 *
 * THE CONTRACT — unchanged from the placeholder this replaces:
 *  - Never throw out to the caller. Catch everything internally (network
 *    errors, rate limits, a changed/unparseable response shape).
 *  - `available: false` means "no reading this cycle." `interestScore`
 *    stays `null` whenever `available` is false; never coerced to 0.
 *  - Never return a fabricated interestScore.
 *
 * @param {{ symbol?: string, name?: string }} baseToken
 * @returns {Promise<{ available: boolean, interestScore: number|null }>}
 */

const REQUEST_TIMEOUT_MS = 10000; // matches redditService.js/twitterScraperService.js's order of magnitude

/**
 * The raw promise from googleTrends.interestOverTime() resolves to a
 * JSON *string* (the library re-stringifies after stripping Google's
 * anti-hijacking response prefix — verified directly against the
 * installed package's src/utilities.js, not assumed), shaped like:
 *   { default: { timelineData: [{ time, value: [N], ... }, ...] } }
 * — verified against this package's own README examples, not guessed.
 * Takes the LAST (most recent) timeline point's value, since this bot
 * cares about current interest, not a historical average across
 * whatever window was queried.
 */
function extractLatestInterestScore(rawResponse) {
  const parsed = JSON.parse(rawResponse);
  const timeline = parsed?.default?.timelineData;
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return null; // a real, valid response — genuinely no data for this keyword/window yet
  }
  const latest = timeline[timeline.length - 1];
  const score = Array.isArray(latest?.value) ? latest.value[0] : null;
  return typeof score === 'number' ? score : null;
}

async function getGoogleTrendsSignal(baseToken) {
  if (!socialSignals.googleTrends.enabled) {
    return { available: false, interestScore: null };
  }

  const keyword = baseToken?.symbol || baseToken?.name;
  if (!keyword) {
    return { available: false, interestScore: null };
  }

  try {
    const rawResponse = await withTimeout(
      googleTrends.interestOverTime({
        keyword,
        startTime: new Date(Date.now() - socialSignals.googleTrends.windowMinutes * 60 * 1000),
        granularTimeResolution: true, // finer time buckets — the default (daily) is useless for a window this short
      }),
      REQUEST_TIMEOUT_MS,
      '[googleTrends] interestOverTime',
    );
    const interestScore = extractLatestInterestScore(rawResponse);
    if (interestScore === null) {
      return { available: false, interestScore: null };
    }
    return { available: true, interestScore };
  } catch (err) {
    console.error(`[googleTrends] lookup failed for ${keyword}: ${err.message}`);
    return { available: false, interestScore: null };
  }
}

module.exports = { getGoogleTrendsSignal };
