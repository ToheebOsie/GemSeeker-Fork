'use strict';

const DEFAULT_MAX_TERMS = 8;

function normalizeReading(result, valueKey) {
  if (!result || result.available !== true) return { available: false, value: null, source: result?.source || null, posts: [] };
  const value = result[valueKey] ?? result.value ?? null;
  return {
    available: typeof value === 'number' && Number.isFinite(value),
    value: typeof value === 'number' && Number.isFinite(value) ? value : null,
    source: result.source || null,
    posts: Array.isArray(result.posts) ? result.posts : [],
    postListAvailable: Array.isArray(result.posts),
    coverage: result.coverage || null,
  };
}

function chooseTerms(vocabulary, maxTerms = DEFAULT_MAX_TERMS) {
  const cap = Math.max(0, Math.floor(Number(maxTerms) || 0));
  const curated = Array.isArray(vocabulary?.curatedTerms) ? vocabulary.curatedTerms : [];
  const recurring = Array.isArray(vocabulary?.recurringTerms) ? vocabulary.recurringTerms : [];
  const ranked = recurring
    .filter((item) => item && typeof item.term === 'string' && item.term.trim())
    .sort((a, b) => (Number(b.tokenCount) || 0) - (Number(a.tokenCount) || 0) || a.term.localeCompare(b.term))
    .map((item) => item.term);
  const seen = new Set();
  return [...curated, ...ranked].map((term) => String(term).trim().toLowerCase())
    .filter((term) => term && !seen.has(term) && seen.add(term))
    .slice(0, cap);
}

/**
 * Collect bounded, term-level attention readings. No network or persistence is
 * performed here: adapters are injected so collection can be tested offline.
 * Reddit counts and Trends' normalized index remain separate; they are never
 * summed into a misleading cross-source total.
 */
async function collectNarrativeAttention({
  narrativeTag,
  vocabulary,
  observedAt = Date.now(),
  maxTerms = DEFAULT_MAX_TERMS,
  redditAdapter = null,
  trendsAdapter = null,
  pause = async () => {},
  pauseMs = 0,
} = {}) {
  const terms = chooseTerms(vocabulary, maxTerms);
  const termObservations = [];
  for (const term of terms) {
    let redditResult = null;
    let trendsResult = null;
    if (typeof redditAdapter === 'function') {
      try { redditResult = await redditAdapter(term, narrativeTag); } catch (_) { redditResult = null; }
    }
    if (typeof trendsAdapter === 'function') {
      try { trendsResult = await trendsAdapter(term, narrativeTag); } catch (_) { trendsResult = null; }
    }
    termObservations.push({
      term,
      reddit: normalizeReading(redditResult, 'mentionCount'),
      googleTrends: normalizeReading(trendsResult, 'interestScore'),
    });
    if (pauseMs > 0 && term !== terms[terms.length - 1]) await pause(pauseMs);
  }
  const redditReadings = termObservations.filter((x) => x.reddit.available);
  const trendsReadings = termObservations.filter((x) => x.googleTrends.available);
  const redditAvailable = redditReadings.length > 0;
  const uniquePosts = new Map();
  for (const reading of redditReadings) {
    for (const post of reading.reddit.posts || []) {
      const key = post.id ? `id:${post.id}` : `${post.subreddit || ''}:${post.createdAt || ''}:${post.title || ''}`;
      if (!uniquePosts.has(key)) uniquePosts.set(key, post);
    }
  }
  const deduplicationComplete = redditAvailable && redditReadings.every((reading) => reading.reddit.postListAvailable);
  const redditMentions = deduplicationComplete ? uniquePosts.size : null;
  const postRows = [...uniquePosts.values()];
  const authorMetadataPresent = deduplicationComplete && postRows.some((post) => Object.prototype.hasOwnProperty.call(post, 'author'));
  const authors = authorMetadataPresent ? new Set(postRows.map((post) => post.author).filter((author) => typeof author === 'string' && author.trim() && author !== '[deleted]')) : null;
  const uniqueAuthors = authors === null ? null : authors.size;
  const knownAuthorPostCount = authorMetadataPresent ? postRows.filter((post) => typeof post.author === 'string' && post.author.trim() && post.author !== '[deleted]').length : null;
  const subredditMetadataPresent = deduplicationComplete && postRows.some((post) => Object.prototype.hasOwnProperty.call(post, 'subreddit'));
  const uniqueSubreddits = subredditMetadataPresent ? new Set(postRows.map((post) => post.subreddit).filter(Boolean)) : null;
  const scoreMetadataPresent = deduplicationComplete && postRows.length > 0 && postRows.every((post) => post.score !== null && post.score !== undefined && post.score !== '' && Number.isFinite(Number(post.score)));
  const commentsMetadataPresent = deduplicationComplete && postRows.length > 0 && postRows.every((post) => post.comments !== null && post.comments !== undefined && post.comments !== '' && Number.isFinite(Number(post.comments)));
  const totalScore = scoreMetadataPresent ? postRows.reduce((sum, post) => sum + Number(post.score), 0) : null;
  const totalComments = commentsMetadataPresent ? postRows.reduce((sum, post) => sum + Number(post.comments), 0) : null;
  return {
    narrativeTag: narrativeTag || 'uncategorized',
    observedAt,
    queriedTerms: terms,
    termObservations,
    summary: {
      termsAttempted: terms.length,
      redditTermsAvailable: redditReadings.length,
      trendsTermsAvailable: trendsReadings.length,
      // Narrative-level count is a union of posts across queried terms. A post
      // is counted once even if it matches several terms/subreddits.
      redditMentions,
      googleTrendsInterest: null,
      uniqueAuthors,
      knownAuthorPostCount,
      subredditCount: uniqueSubreddits === null ? null : uniqueSubreddits.size,
      totalScore,
      totalComments,
      status: terms.length === 0 ? 'no_terms' : (redditReadings.length || trendsReadings.length) ? 'partial_or_available' : 'unavailable',
    },
    attention: {
      mentions: redditMentions,
      uniqueAuthors,
      engagement: totalScore,
      comments: totalComments,
      subredditCount: uniqueSubreddits === null ? null : uniqueSubreddits.size,
      trendInterest: null,
      sourceCount: [redditAvailable, trendsReadings.length > 0].filter(Boolean).length,
      sources: [redditAvailable ? 'reddit' : null, trendsReadings.length ? 'google_trends' : null].filter(Boolean),
      sourceObservations: { reddit: { available: redditAvailable, uniquePostCount: redditMentions }, googleTrends: { available: trendsReadings.length > 0, availableTermCount: trendsReadings.length } },
    },
    provenance: {
      collector: 'narrative_attention_collector_v3_deduplicated_reddit_metadata',
      redditAvailable: redditReadings.length > 0,
      redditDeduplicationComplete: deduplicationComplete,
      authorCoverageAvailable: uniqueAuthors !== null,
      knownAuthorPostCount,
      authorCoverageRate: redditMentions > 0 && knownAuthorPostCount !== null ? knownAuthorPostCount / redditMentions : null,
      subredditBreadthAvailable: uniqueSubreddits !== null,
      googleTrendsAvailable: trendsReadings.length > 0,
      crossSourceAggregation: 'disabled_incomparable_scales',
    },
  };
}

module.exports = { collectNarrativeAttention, chooseTerms, DEFAULT_MAX_TERMS };
