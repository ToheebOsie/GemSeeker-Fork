'use strict';

const SCORING_VERSION = 'hype-v1';
const FEATURE_SCHEMA_VERSION = 'alert-features-v1';
const PROMPT_VERSION = 'gemini-current-v1';
const CONFIG_VERSION = 'runtime-config-v1';

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * Extracted from buildAlertDecisionInput below, unchanged, so a second
 * caller (tokenScanner.js's flip-tier feature-model shadow prediction,
 * added later) gets byte-identical featureSnapshot shape to what actually
 * gets persisted to alert_decisions and later read back by
 * build-flip-dataset.js for training. One definition of "what a
 * featureSnapshot looks like" — the same principle this project has
 * applied everywhere else a shape is shared across a live call site and an
 * offline pipeline (computeObservedPeak, chronologicalGroupedSplit,
 * flipTier()) — rather than a second, parallel construction that could
 * quietly drift from this one and silently feed the live model different
 * features than the ones it was trained on.
 */
function buildFeatureSnapshot({ token, safety, hypeScore, riskLevel, narrativeTag, subNarrativeTag, categoryKey, prediction, socialSignals, socialMetadata, liveEvidence, historicalMatches, recurringWallets, walletExposure, walletExperience }) {
  const market = {
    priceUsd: finiteOrNull(token.priceUsd),
    // See tokenScanner.js's normalizePair for why this is captured —
    // EDPI-L's entry-market-cap reconstruction (edpiLive.js) needs a
    // pair's own native-currency price at qualification time to convert
    // a wallet's historical SOL-denominated trade into a USD estimate.
    // Absent (null) for every row persisted before this field existed —
    // that's expected and handled explicitly (see
    // reconstructEntryMarketCap), not a bug to fix retroactively.
    priceNative: finiteOrNull(token.priceNative),
    marketCap: finiteOrNull(token.marketCap),
    liquidityUsd: finiteOrNull(token.liquidity),
    volume1h: finiteOrNull(token.volume1h),
    buys1h: finiteOrNull(token.buys1h),
    sells1h: finiteOrNull(token.sells1h),
    priceChange1h: finiteOrNull(token.priceChange1h),
    ageMinutes: finiteOrNull(token.ageMinutes),
    pairCreatedAt: token.pairCreatedAt || null,
  };

  const safetySnapshot = safety ? {
    riskLevel: safety.riskLevel ?? riskLevel ?? null,
    // BUG FIX: this read `safety.score`, but rugcheckService.js deliberately
    // exposes the field as `riskScore` (see its own header comment), never
    // `score` — so this was always undefined -> always null, for every row,
    // since this function existed. That's why `safety.score` showed up as
    // "0% populated across the real dataset" in flipFeatureModel.js's
    // header comment, and why alertFormatter.js's "Rugcheck risk: X/100"
    // line has never once rendered in a live alert (rugcheck.riskScore was
    // always null downstream, via alertDecisionStore.js). Fixing the source
    // here does NOT backfill historical rows already written with score:
    // null; it only fixes it for alerts created from now on.
    score: finiteOrNull(safety.riskScore),
    topHolderPct: finiteOrNull(safety.topHolderPct),
    lpLockedPct: finiteOrNull(safety.lpLockedPct),
    mintAuthorityHeld: safety.mintAuthorityHeld ?? null,
    freezeAuthorityHeld: safety.freezeAuthorityHeld ?? null,
    risks: Array.isArray(safety.risks) ? safety.risks : [],
  } : null;

  return {
    token: {
      address: token.baseToken?.address || null,
      symbol: token.baseToken?.symbol || null,
      name: token.baseToken?.name || null,
      description: token.description || null,
      pairAddress: token.pairAddress || null,
    },
    market,
    safety: safetySnapshot,
    scores: { hypeScore: finiteOrNull(hypeScore), riskLevel: riskLevel || null },
    url: token.url || null,
    context: {
      narrativeTag: narrativeTag || null,
      subNarrativeTag: subNarrativeTag || null,
      categoryKey: categoryKey || null,
      prediction: prediction || null,
      historicalMatches: Array.isArray(historicalMatches) ? historicalMatches.slice(0, 10) : [],
      recurringWallets: Array.isArray(recurringWallets) ? recurringWallets.slice(0, 25) : [],
      // Defaults to count 0 / empty list when walletExposure isn't passed
      // at all (e.g. an older call site, or the try/catch around
      // listPriorRuggedWalletExposureFor in tokenScanner.js caught a
      // failure) — this must read the same as "checked, found none" to
      // any downstream consumer, not as "never checked." The two really
      // are indistinguishable once this snapshot is the only record left,
      // which is an accepted, documented limitation, not something this
      // function can fix on its own.
      walletExposedWalletCount: Number.isFinite(walletExposure?.exposureCount) ? walletExposure.exposureCount : 0,
      walletExposedWallets: Array.isArray(walletExposure?.exposedWallets) ? walletExposure.exposedWallets.slice(0, 25) : [],
      // Wallet-enhanced flip shadow model features (hit_5x target, see
      // src/core/flipWalletShadowModel.js) — same "defaults to 0 when not
      // passed / lookup failed must read identically to checked-and-found-
      // none" convention as walletExposedWalletCount just above, and the
      // same reasoning: this must be a safe, deterministic value a
      // downstream model can always consume, never undefined/NaN.
      experiencedWalletCount5Plus: Number.isFinite(walletExperience?.experiencedWalletCount5Plus) ? walletExperience.experiencedWalletCount5Plus : 0,
      experiencedWalletCount10Plus: Number.isFinite(walletExperience?.experiencedWalletCount10Plus) ? walletExperience.experiencedWalletCount10Plus : 0,
      maxWalletExperience: Number.isFinite(walletExperience?.maxWalletExperience) ? walletExperience.maxWalletExperience : 0,
      socialSignals: socialSignals || null,
      socialMetadata: socialMetadata || null,
      discovery: token.discovery || null,
      liveEvidence: liveEvidence || null,
      // Research/LLM evidence contract: CTO remains outside the production
      // decision features, but is explicitly preserved in the structured
      // AI/research context alongside liveEvidence so downstream research
      // consumers do not have to scrape a JSONB blob or reconstruct CTO.
      researchContext: {
        discovery: token.discovery || null,
        edpiCTO: liveEvidence?.edpiCTO || null,
      },
    },
  };
}

function buildAlertDecisionInput({ token, safety, hypeScore, riskLevel, narrativeTag, subNarrativeTag, categoryKey, prediction, socialSignals, socialMetadata, liveEvidence, assessmentPacket, historicalMatches, recurringWallets, walletExposure, walletExperience, signal, signalLabel, signalStatus, qualifiedAt, edpiL }) {
  const featureSnapshot = buildFeatureSnapshot({ token, safety, hypeScore, riskLevel, narrativeTag, subNarrativeTag, categoryKey, prediction, socialSignals, socialMetadata, liveEvidence, historicalMatches, recurringWallets, walletExposure, walletExperience });

  return {
    chainId: 'solana',
    pairAddress: token.pairAddress,
    mintAddress: token.baseToken?.address,
    dexId: token.dexId || null,
    quoteTokenAddress: token.quoteToken?.address || null,
    qualifiedAt,
    hypeScore,
    riskLevel,
    signal,
    signalLabel,
    signalStatus,
    featureSnapshot,
    sourceSnapshot: {
      dexscreener: token.discovery?.sources?.includes('dexscreener') || token.discovery?.source === 'dexscreener'
        ? { observedAt: qualifiedAt, pairUrl: token.url || null }
        : null,
      geckoterminal: token.discovery?.sources?.includes('geckoterminal') || token.discovery?.source === 'geckoterminal'
        ? { observedAt: qualifiedAt }
        : null,
      rugcheck: { observedAt: qualifiedAt, available: Boolean(safety) },
      social: { observedAt: qualifiedAt, available: Boolean(socialSignals) },
    },
    socialSnapshot: socialSignals || null,
    liveEvidence: liveEvidence || null,
    // EDPI-L is an explicit contract field so analytical persistence cannot
    // accidentally depend on a generic object spread or liveEvidence parsing.
    edpiL: edpiL || null,
    // This is a stable structured representation of the current Gemini
    // evidence. The raw provider prompt/output remain separately versioned.
    aiInputSanitized: featureSnapshot,
    aiOutputRaw: signal || null,
    aiDecisionJson: assessmentPacket
      ? { ...assessmentPacket, signalLabel: assessmentPacket.signalLabel || signalLabel || null, signalStatus }
      : (signalLabel ? { signalLabel, signalStatus } : null),
    aiModel: null,
    promptVersion: PROMPT_VERSION,
    scoringVersion: SCORING_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    configVersion: CONFIG_VERSION,
    broadcastPolicy: 'PENDING',
  };
}

module.exports = {
  SCORING_VERSION,
  FEATURE_SCHEMA_VERSION,
  PROMPT_VERSION,
  CONFIG_VERSION,
  buildFeatureSnapshot,
  buildAlertDecisionInput,
};
