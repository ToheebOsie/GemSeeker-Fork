'use strict';

/**
 * EDPI CTO-convergence evidence layer.
 *
 * This module is deliberately separate from edpiBehavioralPatterns.js:
 * general behavioral prevalence is token-agnostic, while CTO evidence
 * requires exact historical-token identity (canonical mint address).
 *
 * It is evidence extraction only. It does not infer coordination/intent,
 * assign a score, or alter qualification / BUY / WAIT / SKIP decisions.
 */

const { classifyTokenStatus } = require('./edpiBehavioralPatterns');

const CTO_STATUS = Object.freeze({
  NO_EVIDENCE: 'no_evidence',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  SHARED_HISTORICAL_TOKEN: 'shared_historical_token',
  SHARED_DEAD_RUGGED_TOKEN: 'shared_dead_rugged_token',
  STRONGER_SHARED_TOKEN_EVIDENCE: 'stronger_shared_token_evidence',
});

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeMint(value) {
  return nonEmpty(value);
}

function normalizeOutcome(outcome) {
  if (!outcome) return null;
  return {
    ...outcome,
    outcome: nonEmpty(outcome.outcome),
    outcomeDetail: nonEmpty(outcome.outcomeDetail),
    mintAddress: normalizeMint(outcome.mintAddress),
    pairAddress: nonEmpty(outcome.pairAddress),
    symbol: nonEmpty(outcome.symbol),
    name: nonEmpty(outcome.name),
    archivedAtMs: finiteOrNull(outcome.archivedAtMs),
    qualifiedAtMs: finiteOrNull(outcome.qualifiedAtMs),
    athAtMs: finiteOrNull(outcome.athAtMs),
  };
}

function relationshipForPosition(processed) {
  const p = processed?.position;
  if (!p) return null;

  const meaningfulFloorMet = processed.meaningfulFloorMet === true || processed.category === 'completed_meaningful' || processed.category === 'open';
  if (!meaningfulFloorMet) return null;

  const bought = Array.isArray(p.buys) && p.buys.length > 0;
  if (!bought) return null;

  const held = p.status === 'open';
  const majorExited = p.status === 'completed';
  const positionType = p.isBuyback ? 'buyback' : 'original';

  const sellCount = Array.isArray(p.sells) ? p.sells.length : 0;
  let relationship = 'bought';
  if (held && majorExited) relationship = 'held_and_major_exited';
  else if (held && sellCount === 0) relationship = 'bought_only';
  else if (held) relationship = 'held';
  else if (majorExited) relationship = 'major_exited';

  return {
    relationship,
    positionType,
    held,
    majorExited,
    status: p.status,
    category: processed.category,
    categoryReason: processed.categoryReason ?? null,
    meaningfulFloorMet: true,
  };
}

function summarizePosition(processed) {
  const p = processed.position;
  const sellCount = Array.isArray(p?.sells) ? p.sells.length : 0;
  const rel = relationshipForPosition(processed);
  if (!p || !rel) return null;
  return {
    ...rel,
    entryAt: finiteOrNull(p.openedAtMs),
    exitAt: finiteOrNull(p.majorExitAtMs),
    holdDurationMs: finiteOrNull(p.holdingDurationMs),
    holdDurationHours: Number.isFinite(Number(p.holdingDurationMs)) ? Number((Number(p.holdingDurationMs) / 3600000).toFixed(4)) : null,
    entryMarketCap: processed.economics?.entryMc?.available ? finiteOrNull(processed.economics.entryMc.entryMcUsd) : null,
    exitMarketCap: processed.economics?.exitMc?.available ? finiteOrNull(processed.economics.exitMc.marketCapUsd) : null,
    peakMarketCap: processed.economics?.peakMc?.available ? finiteOrNull(processed.economics.peakMc.peakMcUsd) : null,
    capitalCommittedSol: finiteOrNull(p.totalSolBought),
    buyCount: Array.isArray(p.buys) ? p.buys.length : 0,
    sellCount,
    cumulativeSellFraction: finiteOrNull(p.cumulativeSellFraction),
    dataQualityNotes: Array.isArray(p.dataQualityNotes) ? [...p.dataQualityNotes] : [],
  };
}

function buildWalletTokenRelationship(wallet, positions) {
  const usable = (positions || [])
    .map(summarizePosition)
    .filter(Boolean);
  if (usable.length === 0) return null;

  // One wallet contributes once per historical token. Prefer the position
  // with the strongest observable lifecycle state, then the largest capital
  // commitment. This prevents multiple fragments/buybacks from inflating
  // cross-wallet counts while retaining useful lifecycle detail.
  const rank = (p) => (p.majorExited ? 3 : p.held ? 2 : 1);
  usable.sort((a, b) => rank(b) - rank(a) || (b.capitalCommittedSol || 0) - (a.capitalCommittedSol || 0));
  const primary = usable[0];

  return {
    walletAddress: wallet.walletAddress,
    holderRank: wallet.rawRank ?? null,
    holderPct: finiteOrNull(wallet.pct),
    relationship: primary.relationship,
    positionType: primary.positionType,
    held: usable.some((p) => p.held),
    majorExited: usable.some((p) => p.majorExited),
    entryAt: primary.entryAt,
    exitAt: primary.exitAt,
    holdDurationHours: primary.holdDurationHours,
    entryMarketCap: primary.entryMarketCap,
    exitMarketCap: primary.exitMarketCap,
    peakMarketCap: primary.peakMarketCap,
    capitalCommittedUsd: null,
    capitalCommittedSol: primary.capitalCommittedSol,
    positionCount: usable.length,
    positions: usable,
    dataStatus: 'available',
  };
}

function buildCtoEvidence({
  currentTokenMint,
  currentPairAddress,
  qualificationTimeMs,
  candidateWallets,
  candidateWalletCount = null,
  processedPositionsByWallet,
  trades = [],
  outcomesByPair = {},
  eventualOutcomesByPair = {},
  includeRetrospectiveOutcomes = true,
  snapshotsByPair = {},
  currentTokenPriorDeathEvidence = [],
} = {}) {
  const qualificationMs = finiteOrNull(qualificationTimeMs);
  const currentMint = normalizeMint(currentTokenMint);
  const currentPair = nonEmpty(currentPairAddress);
  const candidates = Array.isArray(candidateWallets) ? candidateWallets : [];
  const processed = qualificationMs === null
    ? new Map()
    : (processedPositionsByWallet instanceof Map
      ? processedPositionsByWallet
      : new Map(Object.entries(processedPositionsByWallet || {})));

  const retrospectiveOutcomes = includeRetrospectiveOutcomes ? (eventualOutcomesByPair || {}) : {};
  const temporalEvidenceStatus = qualificationMs === null
    ? 'insufficient_evidence'
    : 'cutoff_applied';

  const tradeByPair = new Map();
  for (const trade of trades || []) {
    if (!trade?.pairAddress) continue;
    if (!tradeByPair.has(trade.pairAddress)) tradeByPair.set(trade.pairAddress, []);
    tradeByPair.get(trade.pairAddress).push(trade);
  }

  const identityByPair = new Map();
  for (const [pairAddress, pairTrades] of tradeByPair) {
    const mint = pairTrades.map((t) => normalizeMint(t.mintAddress)).find(Boolean);
    if (mint) identityByPair.set(pairAddress, mint);
  }
  for (const [pairAddress, outcome] of Object.entries(retrospectiveOutcomes)) {
    if (!identityByPair.has(pairAddress) && outcome?.mintAddress) identityByPair.set(pairAddress, normalizeMint(outcome.mintAddress));
  }
  for (const [pairAddress, outcome] of Object.entries(outcomesByPair || {})) {
    if (!identityByPair.has(pairAddress) && outcome?.mintAddress) identityByPair.set(pairAddress, normalizeMint(outcome.mintAddress));
  }

  const walletByAddress = new Map(candidates.map((w) => [w.owner || w.walletAddress, {
    owner: w.owner || w.walletAddress,
    pct: w.pct,
    rawRank: w.rawRank ?? null,
  }]));

  // Build wallet -> mint -> reconstructed relationship from the existing
  // position objects. Positions are already cutoff-safe and current-pair
  // excluded by the storage layer; this layer never replays raw txns.
  const walletMintPositions = new Map();
  for (const [walletAddress, positions] of processed.entries()) {
    if (!walletByAddress.has(walletAddress)) continue;
    for (const processedPosition of positions || []) {
      const pair = processedPosition?.position?.pairAddress;
      const mint = normalizeMint(identityByPair.get(pair));
      if (!mint) continue;
      if (currentMint && mint === currentMint) continue; // ordinary CTO path excludes the current token itself
      const rel = relationshipForPosition(processedPosition);
      if (!rel) continue;
      if (!walletMintPositions.has(mint)) walletMintPositions.set(mint, new Map());
      const byWallet = walletMintPositions.get(mint);
      if (!byWallet.has(walletAddress)) byWallet.set(walletAddress, []);
      byWallet.get(walletAddress).push(processedPosition);
    }
  }

  const allSharedTokens = [];
  const sharedDeadRuggedTokens = [];
  let insufficientIdentityCount = 0;
  let insufficientOutcomeCount = 0;

  for (const [mintAddress, byWallet] of walletMintPositions.entries()) {
    if (byWallet.size < 2) continue;

    const pairAddresses = new Set();
    const wallets = [];
    for (const [walletAddress, positions] of byWallet.entries()) {
      for (const p of positions) if (p?.position?.pairAddress) pairAddresses.add(p.position.pairAddress);
      const holder = walletByAddress.get(walletAddress) || { owner: walletAddress };
      const relationship = buildWalletTokenRelationship({ walletAddress, ...holder }, positions);
      if (relationship) wallets.push(relationship);
    }
    if (wallets.length < 2) continue;

    const safeOutcomes = [...pairAddresses].map((p) => normalizeOutcome(outcomesByPair[p])).filter(Boolean);
    const eventualOutcomes = [...pairAddresses].map((p) => normalizeOutcome(retrospectiveOutcomes[p])).filter(Boolean);
    const safeDead = safeOutcomes.find((o) => classifyTokenStatus(o).status === 'dead_or_rugged') || null;
    const eventualDead = eventualOutcomes.find((o) => classifyTokenStatus(o).status === 'dead_or_rugged') || null;
    const eventualAny = eventualOutcomes[0] || safeOutcomes[0] || null;

    const qualificationKnown = Boolean(safeDead);
    const eventualDeadOrRugged = Boolean(eventualDead);
    const historicalOutcomeStatus = eventualAny ? classifyTokenStatus(eventualAny) : null;
    if (!eventualAny) insufficientOutcomeCount += 1;

    const shared = {
      mintAddress,
      pairAddress: eventualAny?.pairAddress || safeDead?.pairAddress || [...pairAddresses][0] || null,
      symbol: eventualAny?.symbol || safeDead?.symbol || null,
      name: eventualAny?.name || safeDead?.name || null,
      historicalOutcome: eventualAny?.outcome || null,
      outcomeDetail: eventualAny?.outcomeDetail || null,
      eventualOutcomeStatus: historicalOutcomeStatus?.status || 'unknown',
      eventualOutcomeArchivedAt: eventualAny?.archivedAtMs ?? null,
      outcomeKnownByQualification: qualificationKnown,
      qualificationOutcomeStatus: safeDead ? 'dead_or_rugged' : (safeOutcomes.length > 0 ? classifyTokenStatus(safeOutcomes[0]).status : 'unknown'),
      temporalStatus: qualificationKnown ? 'known_by_qualification' : eventualDeadOrRugged ? 'eventual_outcome_only' : 'unknown',
      sharedWalletCount: wallets.length,
      top5Share: `${wallets.length}/${candidates.length}`,
      top5ShareFraction: candidates.length > 0 ? Number((wallets.length / candidates.length).toFixed(4)) : null,
      wallets,
      dataStatus: eventualAny ? (qualificationKnown ? 'qualification_time_safe' : 'retrospective_only') : 'insufficient_outcome_evidence',
      historicalPairsObserved: [...pairAddresses],
    };

    allSharedTokens.push(shared);
    if (qualificationKnown || eventualDeadOrRugged) sharedDeadRuggedTokens.push(shared);
  }

  // Missing identity/outcome is surfaced rather than converted into a
  // false negative. A record with no canonical mint cannot safely be grouped.
  for (const trade of trades || []) {
    if (!normalizeMint(trade.mintAddress)) insufficientIdentityCount += 1;
  }

  // "Stronger" is deliberately a qualitative combination of already
  // captured lifecycle evidence, not a score or rarity threshold. A shared
  // dead/rugged mint becomes stronger only when the same historical token
  // has BOTH an open/held meaningful position and a completed major-exit
  // meaningful position across its participating wallets. A shared token
  // where everyone is merely held, or everyone has merely major-exited,
  // remains ordinary shared-token evidence.
  const strong = sharedDeadRuggedTokens.filter((t) => {
    const hasHeld = t.wallets.some((w) => w.held === true);
    const hasMajorExit = t.wallets.some((w) => w.majorExited === true);
    return hasHeld && hasMajorExit;
  });
  const status = qualificationMs === null
    ? CTO_STATUS.INSUFFICIENT_EVIDENCE
    : sharedDeadRuggedTokens.length > 0
      ? (strong.length > 0 ? CTO_STATUS.STRONGER_SHARED_TOKEN_EVIDENCE : CTO_STATUS.SHARED_DEAD_RUGGED_TOKEN)
      : allSharedTokens.length > 0
        ? CTO_STATUS.SHARED_HISTORICAL_TOKEN
        : (insufficientIdentityCount > 0 || insufficientOutcomeCount > 0 ? CTO_STATUS.INSUFFICIENT_EVIDENCE : CTO_STATUS.NO_EVIDENCE);

  // This is intentionally a structural evidence flag, not a claim that a
  // takeover happened. It is null when the evidence cannot establish that
  // the shared token was dead/rugged at qualification time; retrospective
  // evidence remains separately visible in sharedTokens.
  const qualificationSafeShared = sharedDeadRuggedTokens.filter((t) => t.outcomeKnownByQualification);
  const possibleCTO = qualificationSafeShared.some((t) => t.sharedWalletCount >= 2)
    ? true
    : sharedDeadRuggedTokens.some((t) => t.sharedWalletCount >= 2)
      ? null
      : (status === CTO_STATUS.INSUFFICIENT_EVIDENCE ? null : false);
  const retrospectivePossibleCTO = sharedDeadRuggedTokens.some((t) => t.sharedWalletCount >= 2) ? true : false;

  const currentPrior = (currentTokenPriorDeathEvidence || []).map((x) => ({
    ...x,
    qualificationTimeSafe: x.archivedAtMs != null && qualificationMs != null && Number(x.archivedAtMs) < qualificationMs,
  }));

  return {
    schemaVersion: 'edpi-cto-v1',
    status,
    possibleCTO,
    retrospectivePossibleCTO,
    candidateWalletCount: Number.isFinite(Number(candidateWalletCount)) ? Number(candidateWalletCount) : candidates.length,
    top5WalletCount: candidates.length,
    sharedHistoricalTokenCount: allSharedTokens.length,
    sharedDeadRuggedTokenCount: sharedDeadRuggedTokens.length,
    temporalEvidenceStatus,
    qualificationTimeMs: qualificationMs,
    currentToken: { mintAddress: currentMint, pairAddress: currentPair },
    sharedTokens: allSharedTokens,
    sharedDeadRuggedTokens,
    currentTokenPriorDeathEvidence: currentPrior,
    limitations: {
      missingCanonicalMintRecords: insufficientIdentityCount,
      missingHistoricalOutcomeRecords: insufficientOutcomeCount,
      eventualOutcomeIsNotQualificationTimeFact: true,
      currentTokenExcludedFromOrdinarySharedTokenGrouping: true,
      captureTimeNotUsedAsEventTime: true,
      marketCapIsNullWhenNotReconstructable: true,
      snapshotsAvailableForPairs: Object.keys(snapshotsByPair || {}).length,
    },
  };
}

function attachEdpiCTOResult(evidence, ctoResult) {
  try {
    if (ctoResult) evidence.edpiCTO = ctoResult;
  } catch (error) {
    console.error(`[edpiCTO] attachEdpiCTOResult failed, continuing without it: ${error.message}`);
  }
  return evidence;
}

module.exports = {
  CTO_STATUS,
  relationshipForPosition,
  summarizePosition,
  buildWalletTokenRelationship,
  buildCtoEvidence,
  attachEdpiCTOResult,
};
