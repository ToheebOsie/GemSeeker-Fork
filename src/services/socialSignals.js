const { socialSignals: config } = require('../config');
const redditService = require('./redditService');
const twitterScraperService = require('./twitterScraperService');
const telegramScraperService = require('./telegramScraperService');
const googleTrendsService = require('./googleTrendsService');

/**
 * "Social Score" — a weighted composite of social-attention signals,
 * SEPARATE from and NEVER read by scoring.js's classifyRisk/
 * computeHypeScore or filters.js's qualification gates. Nothing in this
 * file is consumed by tokenScanner.js's filtering/tracking decisions —
 * only attached to the enriched token for display. Purely additive,
 * optional context for subscribers; OFF entirely by default
 * (config.socialSignals.enabled).
 *
 * Five sources, all real:
 *   - Reddit: real, via redditService.js (Reddit's public JSON endpoints,
 *     no API key needed).
 *   - Volume velocity: real, computed from data the scanner already has
 *     at first detection (volume1h ÷ age-in-minutes, capped at a
 *     60-minute window — see scoreVolumeVelocity's own comment for why
 *     the cap matters).
 *   - Twitter/X: real, via twitterScraperService.js
 *     (@the-convocation/twitter-scraper — logs in as a real X account,
 *     see that file's header comment for the ban-risk tradeoffs).
 *   - Telegram: real, via telegramScraperService.js (teleproto's MTProto
 *     user-account API — needs its own one-time session setup, see that
 *     file's header comment).
 *   - Google Trends: real, via googleTrendsService.js (google-trends-api,
 *     no account needed — but see that file's header comment for why it
 *     rarely has anything to say about a token that just launched).
 *
 * NEVER a fabricated number standing in for real data across any of
 * these — this bot shows these figures directly to paying subscribers
 * making trading decisions, and a fake "Twitter mentions: 91 ▲ +410%"
 * would be actively misleading, not just an approximation. Every source
 * fails closed (available: false) on any error, rate limit, or missing
 * credential rather than ever guessing.
 */

// Volume-per-minute thresholds for the velocity proxy, in USD/minute.
// Chosen to roughly track this project's existing scanner tiers (see
// filters.js's age-tiered volume thresholds) rather than an arbitrary
// scale — a token clearing $500/min sustained is already comfortably past
// the newest/loosest tier's bar.
//
// `volume1h` is always a FIXED 60-minute trailing window (that's what
// DexScreener reports it as), but `ageMinutes` keeps growing for the
// token's entire lifetime — so for anything older than ~60 minutes, the
// ratio must be (last 60 min of volume) / 60, not / the ever-growing
// ageMinutes, or a token with a perfectly constant real trading rate would
// score progressively lower purely as it got older, with no real change
// in activity. Capping the denominator at 60 keeps the ratio dividing by
// the same window the numerator actually represents once the token has
// been alive that long; for anything younger than 60 minutes, volume1h
// only reflects the elapsed time since launch anyway, so dividing by the
// real ageMinutes (unchanged) is still correct there.
function scoreVolumeVelocity(token) {
  if (!token || typeof token.volume1h !== 'number' || typeof token.ageMinutes !== 'number' || token.ageMinutes <= 0) {
    return null;
  }
  const perMinute = token.volume1h / Math.min(token.ageMinutes, 60);
  if (perMinute >= 500) return 10;
  if (perMinute >= 200) return 8;
  if (perMinute >= 75) return 6;
  if (perMinute >= 25) return 4;
  if (perMinute >= 5) return 2;
  return 0;
}

// Simple, transparent mention-count -> 0-10 normalization. Diminishing
// returns on purpose (log-ish steps) — the jump from 0 to 5 mentions is a
// much bigger signal than 50 to 55. Shared by Reddit/Twitter/Telegram
// since all three report a raw mention count.
function scoreMentionCount(count) {
  if (count === null || count === undefined) return null;
  if (count >= 50) return 10;
  if (count >= 20) return 8;
  if (count >= 10) return 6;
  if (count >= 5) return 4;
  if (count >= 1) return 2;
  return 0;
}

// Google Trends' interestScore is already 0-100 on ITS OWN native scale
// (not a raw, unbounded count) — a straight /10 linear rescale, not
// scoreMentionCount's diminishing-returns curve, since a mention count has
// unbounded upside (where diminishing returns make sense) while Trends'
// score is already bounded 0-100 by definition.
function scoreTrendsInterest(interestScore) {
  if (interestScore === null || interestScore === undefined) return null;
  return Math.round((interestScore / 100) * 10 * 10) / 10;
}

/**
 * @param {{ volume1h: number, ageMinutes: number }} token
 * @param {{ symbol?: string, name?: string }} baseToken
 * @returns {Promise<{
 *   available: boolean,
 *   socialScore: number|null,
 *   components: {
 *     reddit: { available: boolean, mentionCount: number|null, score: number|null, topPosts: Array },
 *     volumeVelocity: { available: boolean, score: number|null },
 *     twitter: { available: boolean, mentionCount: number|null, score: number|null, topPosts: Array },
 *     telegram: { available: boolean, mentionCount: number|null, score: number|null, topPosts: Array },
 *     googleTrends: { available: boolean, interestScore: number|null, score: number|null },
 *   },
 * }>}
 */
async function getSocialSignals(token, baseToken) {
  const components = {
    reddit: { available: false, mentionCount: null, score: null, topPosts: [] },
    volumeVelocity: { available: false, score: null },
    twitter: { available: false, mentionCount: null, score: null, topPosts: [] },
    telegram: { available: false, mentionCount: null, score: null, topPosts: [] },
    googleTrends: { available: false, interestScore: null, score: null },
  };

  if (!config.enabled) {
    return { available: false, socialScore: null, components };
  }

  const velocityScore = scoreVolumeVelocity(token);
  if (velocityScore !== null) {
    components.volumeVelocity = { available: true, score: velocityScore };
  }

  if (config.reddit.enabled) {
    const reddit = await redditService.getRedditSignal(baseToken);
    if (reddit.available) {
      components.reddit = {
        available: true,
        mentionCount: reddit.mentionCount,
        score: scoreMentionCount(reddit.mentionCount),
        topPosts: reddit.topPosts,
      };
    }
  }

  // Twitter / Telegram / Google Trends — all real implementations now.
  // The original scaffold called these here even while they were still
  // no-ops, deliberately: it's exactly what made flipping
  // SOCIAL_TWITTER_ENABLED=true (etc.) safe before any adapter existed,
  // and unchanged now that they're real — a source failing this cycle
  // (bad credential, rate limit, network error) flows through this
  // aggregator exactly like a placeholder always did: never breaking
  // anything, never fabricating a number.
  if (config.twitter.enabled) {
    const twitter = await twitterScraperService.getTwitterSignal(baseToken);
    if (twitter.available) {
      components.twitter = {
        available: true,
        mentionCount: twitter.mentionCount,
        score: scoreMentionCount(twitter.mentionCount),
        topPosts: twitter.topPosts,
      };
    }
  }

  if (config.telegram.enabled) {
    const telegram = await telegramScraperService.getTelegramSignal(baseToken, config.telegram.channels);
    if (telegram.available) {
      components.telegram = {
        available: true,
        mentionCount: telegram.mentionCount,
        score: scoreMentionCount(telegram.mentionCount),
        topPosts: telegram.topPosts,
      };
    }
  }

  if (config.googleTrends.enabled) {
    const trends = await googleTrendsService.getGoogleTrendsSignal(baseToken);
    if (trends.available) {
      components.googleTrends = {
        available: true,
        interestScore: trends.interestScore,
        score: scoreTrendsInterest(trends.interestScore),
      };
    }
  }

  // Renormalize weights across only the sources that actually produced a
  // reading this cycle, so one unavailable/disabled/not-yet-implemented
  // source doesn't silently drag the combined score toward 0 (a token
  // isn't "less social" just because Reddit rate-limited us this cycle,
  // or because Twitter isn't implemented yet).
  const weighted = [
    { available: components.reddit.available, score: components.reddit.score, weight: config.weights.reddit },
    { available: components.volumeVelocity.available, score: components.volumeVelocity.score, weight: config.weights.volumeGrowth },
    { available: components.twitter.available, score: components.twitter.score, weight: config.weights.twitter },
    { available: components.telegram.available, score: components.telegram.score, weight: config.weights.telegram },
    { available: components.googleTrends.available, score: components.googleTrends.score, weight: config.weights.googleTrends },
  ].filter((c) => c.available);

  if (weighted.length === 0) {
    return { available: false, socialScore: null, components };
  }

  const totalWeight = weighted.reduce((sum, c) => sum + c.weight, 0);
  const socialScore = totalWeight > 0
    ? Math.round((weighted.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight) * 10) / 10
    : null;

  return { available: socialScore !== null, socialScore, components };
}

module.exports = { getSocialSignals, scoreVolumeVelocity, scoreMentionCount, scoreTrendsInterest };
