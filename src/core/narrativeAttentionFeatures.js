'use strict';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestamp(row) {
  const numeric = finite(row?.observedAtMs ?? row?.observed_at_ms);
  if (numeric !== null) return numeric;
  const value = row?.observedAt ?? row?.observed_at ?? row?.observed_at_ms;
  if (value === null || value === undefined) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function unpack(row) {
  const observation = row?.observation && typeof row.observation === 'object' ? row.observation : row;
  const attention = observation?.attention || {};
  const queriedTerms = Array.isArray(observation?.queriedTerms)
    ? observation.queriedTerms.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
    : (Array.isArray(observation?.termObservations) ? observation.termObservations.map((x) => String(x?.term || '').trim().toLowerCase()).filter(Boolean) : []);
  return {
    row,
    observation,
    narrativeTag: row?.narrativeTag ?? row?.narrative_tag ?? observation?.narrativeTag ?? null,
    at: timestamp(row) ?? timestamp(observation),
    mentions: finite(attention.mentions ?? observation?.summary?.redditMentions),
    uniqueAuthors: finite(attention.uniqueAuthors ?? observation?.summary?.uniqueAuthors),
    sourceCount: finite(attention.sourceCount),
    sources: Array.isArray(attention.sources) ? attention.sources : [],
    subredditCount: finite(attention.subredditCount ?? observation?.summary?.subredditCount),
    queriedTerms,
  };
}

function elapsedHours(a, b) {
  if (a === null || b === null || b <= a) return null;
  return (b - a) / 3_600_000;
}

function deriveNarrativeAttentionFeatures({ current, history = [], peers = [], previousPeerShare = null, maxPeerSkewMs = 6 * 60 * 60 * 1000, noveltyLookbackMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const now = unpack(current);
  const priorRows = (Array.isArray(history) ? history : [])
    .map(unpack)
    .filter((x) => x.narrativeTag === now.narrativeTag && x.at !== null && now.at !== null && x.at < now.at)
    .sort((a, b) => a.at - b.at);
  const previous = priorRows.at(-1) || null;
  const beforePrevious = priorRows.at(-2) || null;
  const elapsed = previous ? elapsedHours(previous.at, now.at) : null;
  const mentionVelocity = elapsed && now.mentions !== null && previous.mentions !== null
    ? (now.mentions - previous.mentions) / elapsed : null;
  const priorElapsed = beforePrevious && previous ? elapsedHours(beforePrevious.at, previous.at) : null;
  const priorVelocity = priorElapsed && previous.mentions !== null && beforePrevious.mentions !== null
    ? (previous.mentions - beforePrevious.mentions) / priorElapsed : null;
  const acceleration = mentionVelocity !== null && priorVelocity !== null && elapsed
    ? (mentionVelocity - priorVelocity) / elapsed : null;

  const termsKnown = now.queriedTerms.length > 0;
  const cutoff = now.at === null ? null : now.at - noveltyLookbackMs;
  const noveltyHistory = priorRows.filter((x) => cutoff === null || x.at >= cutoff);
  const priorTerms = new Set(noveltyHistory.flatMap((x) => x.queriedTerms));
  const newTerms = termsKnown && noveltyHistory.length > 0
    ? now.queriedTerms.filter((term) => !priorTerms.has(term)) : null;
  const termNoveltyRate = Array.isArray(newTerms) && now.queriedTerms.length
    ? newTerms.length / now.queriedTerms.length : null;

  const authorBreadthRate = now.uniqueAuthors !== null && now.mentions !== null && now.mentions > 0
    ? now.uniqueAuthors / now.mentions : null;
  const currentPeers = (Array.isArray(peers) ? peers : []).map(unpack).filter((x) =>
    x.narrativeTag && x.narrativeTag !== now.narrativeTag && x.at !== null && now.at !== null
      && Math.abs(x.at - now.at) <= maxPeerSkewMs && x.mentions !== null && x.mentions >= 0);
  const ownComparable = now.mentions !== null && now.mentions >= 0 && now.at !== null;
  const competitionRows = ownComparable ? [{ ...now }, ...currentPeers] : [];
  const totalComparableMentions = competitionRows.length
    ? competitionRows.reduce((sum, row) => sum + row.mentions, 0) : null;
  const attentionShare = competitionRows.length >= 2 && totalComparableMentions > 0
    ? now.mentions / totalComparableMentions : null;
  const shareChange = attentionShare !== null && finite(previousPeerShare) !== null
    ? attentionShare - finite(previousPeerShare) : null;

  return {
    narrativeTag: now.narrativeTag,
    observedAt: now.at === null ? null : new Date(now.at).toISOString(),
    mentionVelocityPerHour: mentionVelocity,
    mentionAccelerationPerHourSquared: acceleration,
    termNovelty: {
      status: !termsKnown ? 'unavailable' : noveltyHistory.length === 0 ? 'cold_start' : 'measured',
      queriedTermCount: termsKnown ? now.queriedTerms.length : null,
      newlyObservedTerms: newTerms,
      newlyObservedTermCount: Array.isArray(newTerms) ? newTerms.length : null,
      rate: termNoveltyRate,
      lookbackMs: noveltyLookbackMs,
    },
    breadth: {
      uniqueAuthors: now.uniqueAuthors,
      authorPerMentionRate: authorBreadthRate,
      sourceCount: now.sourceCount,
      sources: [...new Set(now.sources.map(String))],
      subredditCount: now.subredditCount,
      note: 'Authors, sources, and subreddits remain separate dimensions; missing values are not zero-filled.',
    },
    competition: {
      comparableNarrativeCount: competitionRows.length,
      comparableMentionTotal: totalComparableMentions,
      attentionShare,
      attentionShareChange: shareChange,
      status: attentionShare === null ? 'insufficient_comparable_observations' : 'descriptive_share_only',
      maxPeerSkewMs,
    },
    lifecycleEvidence: {
      suggestedState: mentionVelocity === null ? 'UNKNOWN' : mentionVelocity > 0 ? 'EXPANDING' : mentionVelocity < 0 ? 'DECLINING' : 'FLAT',
      decisionUse: 'research_only_not_a_validated_lifecycle_or_trading_signal',
    },
  };
}

function deriveLatestNarrativeAttentionFeatures(rows, options = {}) {
  const byNarrative = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const item = unpack(row);
    if (!item.narrativeTag || item.at === null) continue;
    if (!byNarrative.has(item.narrativeTag)) byNarrative.set(item.narrativeTag, []);
    byNarrative.get(item.narrativeTag).push(row);
  }
  const latest = [];
  for (const [narrativeTag, narrativeRows] of byNarrative.entries()) {
    narrativeRows.sort((a, b) => (timestamp(a) ?? 0) - (timestamp(b) ?? 0));
    const current = narrativeRows.at(-1);
    const history = narrativeRows.slice(0, -1);
    latest.push({ current, history, narrativeTag, at: timestamp(current) });
  }
  return latest.map((item) => deriveNarrativeAttentionFeatures({
    current: item.current,
    history: item.history,
    peers: latest.filter((peer) => peer.narrativeTag !== item.narrativeTag).map((peer) => peer.current),
    ...options,
  })).sort((a, b) => String(a.narrativeTag).localeCompare(String(b.narrativeTag)));
}

module.exports = { deriveNarrativeAttentionFeatures, deriveLatestNarrativeAttentionFeatures };
