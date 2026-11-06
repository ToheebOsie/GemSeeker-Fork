'use strict';


/**
 * Build bounded, source-specific adapters for narrative query terms.
 *
 * Reddit uses the existing public-new-listing reader and configured subreddit
 * set. It counts matching posts in the configured trailing window; it does
 * not claim to be a global Reddit search or unique-author measure. Trends is
 * retained as a separate per-term normalized index. Neither source is
 * aggregated across terms here because overlapping Reddit posts can be
 * counted repeatedly and separate Trends query indices are not comparable.
 */
function createNarrativeAttentionAdapters(options = {}) {
  // Lazy-load production dependencies so this adapter contract can be tested
  // with injected fakes without loading network clients or environment config.
  const reddit = options.reddit || require('./redditService');
  const trends = options.trends || require('./googleTrendsService');
  const socialConfig = options.socialConfig || require('../config').socialSignals;
  const redditWindowMinutes = options.redditWindowMinutes ?? 60;
  async function redditAdapter(term) {
    if (!socialConfig?.reddit?.enabled || !Array.isArray(socialConfig.reddit.subreddits) || socialConfig.reddit.subreddits.length === 0) {
      return { available: false, mentionCount: null, source: 'reddit' };
    }
    const patterns = reddit.buildNeedlePatterns({ symbol: term, name: term });
    let mentionCount = 0;
    let successfulSubreddits = 0;
    const posts = [];
    let postListsAvailable = true;
    let truncatedSubreddits = 0;
    for (const subreddit of socialConfig.reddit.subreddits) {
      // Sequential requests are intentional: Reddit rate-limits by IP.
      // eslint-disable-next-line no-await-in-loop
      let result = null;
      try {
        result = await reddit.getSubredditMentions(subreddit, patterns, redditWindowMinutes);
      } catch (_) {
        result = null;
      }
      if (result && Number.isFinite(Number(result.mentionCount))) {
        successfulSubreddits += 1;
        mentionCount += Number(result.mentionCount);
        if (Array.isArray(result.posts)) posts.push(...result.posts);
        else postListsAvailable = false;
        if (result.listingMayBeTruncated === true) truncatedSubreddits += 1;
      }
    }
    if (successfulSubreddits === 0) return { available: false, mentionCount: null, source: 'reddit' };
    return {
      available: true,
      mentionCount,
      ...(postListsAvailable ? { posts } : {}),
      source: 'reddit',
      coverage: { successfulSubreddits, configuredSubreddits: socialConfig.reddit.subreddits.length, truncatedSubreddits },
    };
  }

  async function trendsAdapter(term) {
    if (!socialConfig?.googleTrends?.enabled) {
      return { available: false, interestScore: null, source: 'google_trends' };
    }
    const result = await trends.getGoogleTrendsSignal({ symbol: term, name: term });
    return {
      available: result?.available === true && Number.isFinite(result.interestScore),
      interestScore: result?.available === true && Number.isFinite(result.interestScore) ? result.interestScore : null,
      source: 'google_trends',
    };
  }

  return { redditAdapter, trendsAdapter };
}

module.exports = { createNarrativeAttentionAdapters };
