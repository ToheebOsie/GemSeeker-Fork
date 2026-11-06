const { scanner, patternTracking, walletClustering, discoveryLearning, highRoiPatternShadow, modelFocus, fixedWindowWallet, edpiLive: edpiLiveConfig, edpiPositionLifecycle: edpiPositionLifecycleConfig, edpiCTO: edpiCTOConfig, edpiBehavioralPatterns: edpiBehavioralConfig, edpiL: edpiLConfig } = require('../config');
const discoveryService = require('../services/discoveryService');
const rugcheckService = require('../services/rugcheckService');
const geminiService = require('../services/gemini_signal_generator');
const { passesCommonMarketFilters, passesDiscoverySourceFilters, passesSafetyGates } = require('./filters');
const { computeHypeScore, classifyRisk } = require('./scoring');
const { classifyNarrative, classifySubNarrative, FALLBACK_TAG } = require('./narrativeClassifier');
const { classifyByDescription } = require('./descriptionClassifier');
const { buildCategoryKey, predictForCategory } = require('./patternAnalyzer');
const { findSimilarHistoricalTokens } = require('./narrativeIntelligence');
const patternStore = require('../storage/tokenPatternStore');
const discoveryStore = require('../storage/discoveryStore');
const discoveryOutcomeStore = require('../storage/discoveryOutcomeStore');
const discoveryObservationStore = require('../storage/discoveryObservationStore');
const socialSignalsService = require('../services/socialSignals');
const observationEngine = require('./observationEngine');
const { buildFeatureSnapshot, buildAlertDecisionInput } = require('./alertDecision');
const { normalizeSocialMetadata, normalizeGeckoTokenSocialMetadata, mergeSocialMetadata } = require('../services/socialMetadata');
const geckoTerminalService = require('../services/geckoTerminalService');
const { packetFromSignal, extractJsonCandidate, renderAssessment } = require('./geminiAssessment');
const { persistAlertDecision } = require('../storage/alertDecisionStore');
const { buildLiveTokenEvidence } = require('./liveTokenEvidence');
const { classifyMultiSource } = require('./independentNarrativeClassifier');
const { attachFlipShadowPrediction, attachFeatureModelShadowPrediction } = require('./flipShadowScoring');
const { attachWalletShadowPrediction } = require('./flipWalletShadowModel');
const { computeEdpiLive, attachEdpiLiveResult } = require('./edpiLive');
const { selectEdpiCandidateWallets, attachEdpiWalletSelectionResult } = require('./edpiWalletSelection');
const { buildWalletProcessedPositions } = require('./walletOutcomeProfile');
const { buildCtoEvidence, attachEdpiCTOResult } = require('./edpiCTOConvergence');
const { evaluateWalletBehavioralProfile } = require('./edpiBehavioralPatterns');
const { buildWalletHistoricalOutcomeProfile } = require('./walletOutcomeProfile');
const { calculateEdpiL, attachEdpiLResult } = require('./edpiLScoring');
const { withAdvisoryLock, LOCK_IDS } = require('../db/advisoryLock');
const { runtimeTag } = require('../observability/runtimeIdentity');
const { requestMissingWalletActivity } = require('../services/canonicalWalletActivityCapture');
const { attachHighRoiPatternShadow, evaluatePreEnrichmentGate, DEFAULT_RULES: HIGH_ROI_RULES } = require('./highRoiPatternRule');
const { captureFixedWindowWalletFeatures } = require('../services/fixedWindowWalletCollector');

const QUALIFICATION_FILTER_VERSION = discoveryLearning.qualificationFilterVersion;

// In-memory set of pair addresses we've already alerted on this process
// lifetime — the fast path for same-cycle/same-process duplicates, no DB
// round-trip needed. Resets on restart, same as before, but that's no
// longer a real gap: runScanCycle also checks a persistent backstop
// (tokenPatternStore's alerted_pairs table) that survives restarts. Kept
// as a separate Set rather than dropped in favor of the DB check alone
// for two reasons: it catches the same pairAddress appearing twice
// within one rawPairs response (the DB check is one batched query at the
// START of the cycle, so it wouldn't see a pair this cycle just alerted
// on moments earlier), and it keeps working even if the DB-backed check
// fails open on a query error (see below) — never worse than the
// pre-fix behavior.
const alertedPairs = new Set();

function normalizePair(pair) {
  const createdAt = pair.pairCreatedAt || Date.now();
  const ageMinutes = (Date.now() - createdAt) / 60000;
  const txns1h = (pair.txns && pair.txns.h1) || { buys: 0, sells: 0 };

  const discovery = pair.discovery || { source: 'dexscreener', sources: ['dexscreener'] };
  const { sourceCandidates, ...persistedDiscovery } = discovery;

  return {
    pairAddress: pair.pairAddress,
    baseToken: pair.baseToken,
    priceUsd: Number(pair.priceUsd) || 0,
    // Native-currency (SOL, for every pair this bot tracks) price —
    // DexScreener already returns this on every pair, just never read
    // before. Needed for EDPI-L's entry-market-cap reconstruction (see
    // edpiLive.js's reconstructEntryMarketCap): converting a wallet's
    // historical SOL-denominated trade into a USD entry-MC estimate
    // without a historical SOL/USD price series requires comparing it
    // against this SAME pair's own priceNative at a nearby point in
    // time, not against priceUsd directly (see that function's header for
    // the full reasoning). `null`, not `0`, when DexScreener omits it —
    // same "missing must never look like a real zero" rule pairCreatedAt/
    // description already follow just below.
    priceNative: pair.priceNative !== undefined && pair.priceNative !== null ? Number(pair.priceNative) || null : null,
    marketCap: pair.marketCap ?? pair.fdv ?? null,
    liquidity: pair.liquidity ? Number(pair.liquidity.usd) || 0 : 0,
    volume1h: pair.volume ? Number(pair.volume.h1) || 0 : 0,
    buys1h: Number(txns1h.buys) || 0,
    sells1h: Number(txns1h.sells) || 0,
    priceChange1h: pair.priceChange ? Number(pair.priceChange.h1) || 0 : 0,
    ageMinutes,
    url: pair.url,
    // Raw pairCreatedAt as DexScreener reported it — deliberately NOT the
    // `createdAt` local above (which falls back to Date.now() so the
    // ageMinutes filter above still works when DexScreener omits it).
    // undefined here, not a fabricated "now," when DexScreener didn't
    // supply it — see schema.sql's tracked_tokens.pair_created_at comment
    // for why that distinction matters.
    pairCreatedAt: pair.pairCreatedAt || null,
    // Only populated for pairs resolved via the token-profiles endpoint —
    // see dexscreenerService.js's getCandidatePairs doc comment. Absent
    // (undefined) for search-sourced pairs, which descriptionClassifier.js
    // handles via its no-description name-similarity fallback rather than
    // treating as an error.
    description: pair.description,
    socialMetadata: pair.socialMetadata || (() => { const metadata = normalizeSocialMetadata({ pair }); return metadata.available ? metadata : null; })(),
    dexId: pair.dexId || null,
    quoteToken: pair.quoteToken || null,
    discovery: persistedDiscovery,
  };
}

async function enrichGeckoSocialMetadata(token, stats = null) {
  if (!token || !token.baseToken?.address) return { enriched: false, skipped: true };
  if (token.socialMetadata?.available) return { enriched: false, skipped: true };
  if (stats) stats.socialEnrichmentAttempted += 1;
  try {
    const tokenInfoResult = await geckoTerminalService.getTokenInfo(token.baseToken.address);
    const geckoMetadata = normalizeGeckoTokenSocialMetadata(tokenInfoResult.data);
    if (!geckoMetadata.available) return { enriched: false, skipped: false, metadata: geckoMetadata };
    token.socialMetadata = mergeSocialMetadata(token.socialMetadata, geckoMetadata);
    if (!token.description && geckoMetadata.description) token.description = geckoMetadata.description;
    if (stats) stats.socialEnrichmentSucceeded += 1;
    return { enriched: true, skipped: false, metadata: geckoMetadata };
  } catch (err) {
    if (stats) stats.socialEnrichmentFailed += 1;
    console.error(`[scanner] GeckoTerminal social enrichment failed for ${token.baseToken?.symbol || token.baseToken?.address}: ${err.message}`);
    return { enriched: false, skipped: false, error: err };
  }
}

/**
 * Runs a single scan cycle: fetch candidates, filter, score, and return the
 * list of tokens that qualify for an alert (with their AI signal attached).
 */
async function runScanCycle() {
  // No-op when observation.enabled is false — see observationEngine.js.
  observationEngine.pruneStale();

  const rawPairs = await discoveryService.getCandidatePairs();
  let discoveryEventIds = new Map();
  try {
    await discoveryStore.recordDiscoveries(rawPairs, new Date());
  } catch (err) {
    // Legacy/current provenance summary is observability data; it must never
    // suppress the append-only learning event path or analytical pipeline.
    console.error(`[scanner] discovery provenance summary write failed: ${err.message}`);
  }
  try {
    const discoveryEvents = await discoveryOutcomeStore.recordDiscoveryEvents(rawPairs);
    discoveryEventIds = discoveryEvents.eventIds || new Map();
    if (discoveryEvents.newEvents?.length) {
      try {
        await discoveryObservationStore.enqueueDiscoveryOutcomeJobs(discoveryEvents.newEvents);
      } catch (observationErr) {
        console.error(`[scanner] discovery outcome job enqueue failed: ${observationErr.message}`);
      }
    }
  } catch (err) {
    console.error(`[scanner] discovery learning event write failed: ${err.message}`);
  }
  const qualified = [];
  const discoveryEvaluations = [];
  const discoveryStats = {
    discovered: { dexscreener: 0, geckoterminal: 0, both: 0 },
    rejectedDiscovery: 0,
    rejectedCommonQualification: 0,
    rejectedSafety: 0,
    rejectedTier1: 0,
    tier1Admitted: 0,
    tier2Skipped: 0,
    fixedWindowCaptures: 0,
    fixedWindowCaptureFailures: 0,
    walletAnalysis: 0,
    edpiL: 0,
    signals: 0,
    gecko: { discovered: 0, rejectedDiscovery: 0, rejectedCommonQualification: 0, rejectedSafety: 0, rejectedTier1: 0, tier1Admitted: 0, tier2Skipped: 0, fixedWindowCaptures: 0, fixedWindowCaptureFailures: 0, walletAnalysis: 0, socialEnrichmentAttempted: 0, socialEnrichmentSucceeded: 0, socialEnrichmentFailed: 0, edpiL: 0, signals: 0 },
    rejectionReasons: {},
  };
  for (const candidate of rawPairs) {
    const sources = candidate?.discovery?.sources || [candidate?.discovery?.source].filter(Boolean);
    if (sources.includes('dexscreener')) discoveryStats.discovered.dexscreener += 1;
    if (sources.includes('geckoterminal')) {
      discoveryStats.discovered.geckoterminal += 1;
      discoveryStats.gecko.discovered += 1;
    }
    if (sources.includes('dexscreener') && sources.includes('geckoterminal')) discoveryStats.discovered.both += 1;
  }
  const recordRejection = (stage, reason) => {
    const key = `${stage}:${reason || 'unknown'}`;
    discoveryStats.rejectionReasons[key] = (discoveryStats.rejectionReasons[key] || 0) + 1;
  };

  // Persistent cross-restart backstop for the in-memory alertedPairs Set
  // below — see schema.sql's comment on `alerted_pairs` for the restart
  // problem this closes. One batched query for this cycle's whole
  // candidate list (bounded by rawPairs.length, not by how large
  // alerted_pairs has grown historically), not a query per pair. Fails
  // open to an empty Set on error — worst case on a DB hiccup is falling
  // back to today's in-memory-only behavior for this one cycle, not
  // blocking the scan loop entirely.
  let dbAlertedPairs = new Set();
  try {
    dbAlertedPairs = await patternStore.getAlertedPairs(rawPairs.map((p) => p.pairAddress).filter(Boolean));
  } catch (err) {
    console.error(`[scanner] failed to load persisted alerted-pairs dedup list: ${err.message}`);
  }

  for (const rawPair of rawPairs) {
    if (!rawPair.pairAddress || alertedPairs.has(rawPair.pairAddress) || dbAlertedPairs.has(rawPair.pairAddress)) continue;

    // Each token is isolated in its own try/catch. Previously an unexpected
    // shape (e.g. a pair missing baseToken) would throw out of the whole
    // loop, silently discarding every token already qualified earlier in
    // this same cycle — one bad entry from DexScreener could zero out an
    // entire scan's alerts.
    try {
      const mergedToken = normalizePair(rawPair);
      const sources = mergedToken.discovery?.sources || [mergedToken.discovery?.source || 'dexscreener'];
      const hasGeckoSource = sources.includes('geckoterminal');
      // A candidate discovered by both providers is already deduplicated by
      // pair identity. Each source's own normalized market observation gets
      // its own discovery gate; once one source passes, that source's market
      // snapshot becomes the canonical input to shared qualification. This
      // avoids accidentally applying DexScreener market values to a Gecko-
      // only qualification path when the providers disagree slightly.
      const sourceCandidates = rawPair.sourceCandidates || {};
      const discoveryChecks = sources.map((source) => {
        const sourceRaw = sourceCandidates[source] || rawPair;
        const sourceToken = normalizePair({ ...sourceRaw, discovery: mergedToken.discovery });
        return { source, token: sourceToken, result: passesDiscoverySourceFilters(sourceToken, source) };
      });
      for (const check of discoveryChecks) {
        const d = sourceCandidates[check.source]?.discovery;
        const eventKey = d ? `${check.source}:${rawPair.pairAddress}:${new Date(d.discoveredAt).toISOString()}` : null;
        discoveryEvaluations.push({
          discoveryEventId: eventKey ? discoveryEventIds.get(eventKey) || null : null,
          pairAddress: rawPair.pairAddress,
          mintAddress: check.token.baseToken?.address,
          evaluatedAt: d?.discoveredAt || Date.now(),
          source: check.source,
          stage: 'discovery',
          passed: check.result.pass,
          reason: check.result.reason || null,
          qualificationFilterVersion: QUALIFICATION_FILTER_VERSION,
        });
      }
      const discoveryCheck = discoveryChecks.find((entry) => entry.result.pass);
      if (!discoveryCheck) {
        discoveryStats.rejectedDiscovery += 1;
        if (hasGeckoSource) discoveryStats.gecko.rejectedDiscovery += 1;
        const discoveryReasons = discoveryChecks.map((entry) => `${entry.source}:${entry.result.reason || 'unknown'}`).join('|');
        recordRejection('discovery', discoveryReasons);
        // If this pairAddress was mid-observation, a fresh failure here
        // rejects it immediately rather than waiting out the rest of the
        // window — see observationEngine.js's doc comment on why a
        // failed fresh check is the actual protective value of this
        // feature. Harmless no-op if it was never being observed.
        // POST-AUDIT FIX: this used to read `token.pairAddress`, but `token` is
        // only declared (const) a few lines below — a temporal-dead-zone
        // ReferenceError that the per-pair catch swallowed, so every
        // discovery-rejected candidate logged an error and this early-stop
        // never ran. `rawPair.pairAddress` is always in scope (guarded at the
        // top of the loop) and matches the graduation path's own call below.
        observationEngine.stopObserving(rawPair.pairAddress);
        continue;
      }

      const token = discoveryCheck.token;
      const commonMarketCheck = passesCommonMarketFilters(token);
      discoveryEvaluations.push({ pairAddress: token.pairAddress, mintAddress: token.baseToken?.address, evaluatedAt: Date.now(), source: sources.join(','), stage: 'common_qualification', passed: commonMarketCheck.pass, reason: commonMarketCheck.reason || null, qualificationFilterVersion: QUALIFICATION_FILTER_VERSION });
      if (!commonMarketCheck.pass) {
        discoveryStats.rejectedCommonQualification += 1;
        if (hasGeckoSource) discoveryStats.gecko.rejectedCommonQualification += 1;
        recordRejection('common_qualification', commonMarketCheck.reason);
        observationEngine.stopObserving(token.pairAddress);
        continue;
      }

      const report = await rugcheckService.getTokenReport(token.baseToken.address);
      // AUDIT FIX: pairAddress needed to pick the right pool out of
      // report.markets[] — see rugcheckService.js's extractSafetySignals
      // doc comment for the full "why."
      const safety = rugcheckService.extractSafetySignals(report, token.pairAddress);
      const safetyCheck = passesSafetyGates(safety);
      discoveryEvaluations.push({ pairAddress: token.pairAddress, mintAddress: token.baseToken?.address, evaluatedAt: Date.now(), source: sources.join(','), stage: 'safety', passed: safetyCheck.pass, reason: safetyCheck.reason || null, qualificationFilterVersion: QUALIFICATION_FILTER_VERSION, safetyResult: safety });
      if (!safetyCheck.pass) {
        discoveryStats.rejectedSafety += 1;
        if (hasGeckoSource) discoveryStats.gecko.rejectedSafety += 1;
        recordRejection('safety', safetyCheck.reason);
        observationEngine.stopObserving(token.pairAddress);
        continue;
      }

      // Immutable EDPI-L evaluation cutoff. Safety qualification is the
      // authoritative boundary: everything below this point is enrichment
      // and must not move the evidence cutoff forward. All EDPI-L historical
      // and qualification-time current-capital queries receive this exact
      // value.
      const qualifiedAtMs = Date.now();

      // Model-focused fork boundary: compute only from discovery and the
      // already-fetched safety report. No Gemini signal, wallet history,
      // transaction parsing, CTO, EDPI, social, or later snapshot data may
      // influence admission to Tier 2.
      const hypeScore = computeHypeScore(token, safety);
      const riskLevel = classifyRisk(hypeScore, safety);
      const tier1Gate = evaluatePreEnrichmentGate({
        token,
        safety,
        hypeScore,
        rules: { ...HIGH_ROI_RULES, preEnrichmentMinimumPoints: modelFocus.tier1MinimumPoints },
      });
      discoveryEvaluations.push({
        pairAddress: token.pairAddress,
        mintAddress: token.baseToken?.address,
        evaluatedAt: qualifiedAtMs,
        source: sources.join(','),
        stage: 'tier1_pre_enrichment',
        passed: tier1Gate.pass,
        reason: tier1Gate.pass ? null : `tier1_points_${tier1Gate.discovery.points}_below_${tier1Gate.threshold}`,
        qualificationFilterVersion: QUALIFICATION_FILTER_VERSION,
        ruleVersion: tier1Gate.schemaVersion,
        rulePoints: tier1Gate.discovery.points,
        ruleThreshold: tier1Gate.threshold,
        missingFeatures: tier1Gate.discovery.missingFeatures,
      });
      if (modelFocus.enabled && modelFocus.enforceTier1Gate && !tier1Gate.pass) {
        discoveryStats.rejectedTier1 += 1;
        discoveryStats.tier2Skipped += 1;
        if (hasGeckoSource) {
          discoveryStats.gecko.rejectedTier1 += 1;
          discoveryStats.gecko.tier2Skipped += 1;
        }
        recordRejection('tier1_pre_enrichment', `points_${tier1Gate.discovery.points}_below_${tier1Gate.threshold}`);
        // In the standalone model fork, non-admitted tokens stop here. Their
        // cheap discovery/safety/evaluation evidence is retained, but no
        // Tier-2 collection or Gemini/social/alert work is spent on them.
        if (modelFocus.shortCircuitNonTier1) continue;
      } else if (tier1Gate.pass) {
        discoveryStats.tier1Admitted += 1;
        if (hasGeckoSource) discoveryStats.gecko.tier1Admitted += 1;
      }

      if (fixedWindowWallet.enabled && fixedWindowWallet.captureAtDiscovery) {
        try {
          const fixedWindowResult = await captureFixedWindowWalletFeatures({
            token: { ...token, safety, hypeScore, riskLevel },
            tier1Admission: tier1Gate,
            cutoffMs: qualifiedAtMs,
          });
          if (fixedWindowResult.attempted) {
            discoveryStats.fixedWindowCaptures += 1;
            if (hasGeckoSource) discoveryStats.gecko.fixedWindowCaptures += 1;
          }
          if (fixedWindowResult.status === 'failed') {
            discoveryStats.fixedWindowCaptureFailures += 1;
            if (hasGeckoSource) discoveryStats.gecko.fixedWindowCaptureFailures += 1;
          }
        } catch (error) {
          discoveryStats.fixedWindowCaptureFailures += 1;
          if (hasGeckoSource) discoveryStats.gecko.fixedWindowCaptureFailures += 1;
          console.error(`[scanner] fixed-window wallet capture failed for ${token.baseToken?.symbol || token.baseToken?.address}: ${error.message}`);
        }
      }

      // GeckoTerminal's new_pools response does not contain full token lore/social
      // metadata. Enrich only after the safety gate so filtered candidates do not
      // consume token-info API budget.
      if (hasGeckoSource) {
        await enrichGeckoSocialMetadata(token, discoveryStats.gecko);
      }

      discoveryStats.walletAnalysis += 1;
      if (hasGeckoSource) discoveryStats.gecko.walletAnalysis += 1;
      discoveryEvaluations.push({ pairAddress: token.pairAddress, mintAddress: token.baseToken?.address, evaluatedAt: Date.now(), source: sources.join(','), stage: 'wallet_analysis', passed: true, qualificationFilterVersion: QUALIFICATION_FILTER_VERSION });
      // --- Tier 1 wallet clustering — own isolated try/catch, same
      // reasoning as the prediction/historical-match/social-signal blocks
      // below: never blocks or fails the alert. Uses `report` fetched for
      // the safety gate immediately above, so this costs no extra
      // Rugcheck call. See rugcheckService.js's extractTopHolderWallets
      // and tokenPatternStore.js's recordTokenHolders/
      // getRecurringWalletsAmong for the mechanism. ---
      let recurringWallets = [];
      let walletExposure = { exposedWallets: [], exposureCount: 0 };
      let walletExperience = { experiencedWalletCount5Plus: 0, experiencedWalletCount10Plus: 0, maxWalletExperience: 0 };
      // EDPI-L (see src/core/edpiLive.js) additions to this existing block:
      // `edpiLiveHolders` lifts the `holders` list (otherwise scoped only
      // to the try block below) out to where computeEdpiLive can reach it
      // after this block ends — holder structure/capital-commitment need
      // the full per-wallet pct/insider list, not just the three
      // aggregates above. `walletHistory` is the OPTIONAL
      // early_wallet_activity enrichment (Evidence Family 4's enriched
      // tier); stays `null` (not `{}`) when never attempted, so
      // computeEdpiLive can tell "not attempted" apart from "attempted,
      // found nothing" — see that function's own header.
      let edpiLiveHolders = [];
      let walletHistory = null;
      let edpiLResult = null;
      // EDPI wallet POPULATION selection (see src/core/edpiWalletSelection.js)
      // — the spec's "which wallets should EDPI actually analyze" answer,
      // live as of this change: Top-`topHolderCount` holders BY RAW RANK
      // (rugcheckService.extractRawTopHolders — includes LP/pool entries
      // in the ranking), THEN infrastructure-excluded. Computed from the
      // SAME already-fetched `report` as edpiLiveHolders just below, so
      // this costs no extra Rugcheck call and no extra DB round-trip —
      // it's a pure function over data already in scope. Deliberately
      // NOT yet used to restrict computeEdpiLive's own `holders` input
      // below (that stays on the broader, non-ranked edpiLiveHolders
      // list, unchanged) — this is recorded into live_evidence
      // ADDITIVELY (see attachEdpiWalletSelectionResult below) so the
      // Top-20 population is visible and comparable before anything
      // downstream is switched to depend on it. See
      // docs/edpi-position-lifecycle.md's "Deliberately not built" list
      // for the position-lifecycle-based outcome profile, which is NOT
      // wired into this hot path yet for the same "prove it against real
      // data first" reason.
      let edpiWalletSelectionResult = null;
      let edpiCtoResult = null;
      // Wallet-relative anomaly / historical outcome profile's data
      // source (see src/core/edpiLive.js's v2 header) — raw trades plus
      // their pairs' market snapshots and resolved outcomes, from
      // tokenPatternStore.js's getEarlyWalletTradesWithOutcomesAmong.
      // Kept as a SEPARATE fetch from `walletHistory` above (not
      // consolidated into one call) deliberately: that one only needs
      // aggregate counts for Family 4's coverage stats, this one needs
      // full per-trade sol_amount/token_delta plus two extra table joins
      // Family 4 has no use for — same "own try/catch, independent of
      // its siblings" isolation as everything else in this block.
      let walletTradesData = null;
      if (walletClustering.enabled) {
        try {
          const holders = rugcheckService.extractTopHolderWallets(report);
          edpiLiveHolders = holders;
          // Own try/catch, independent of everything else in this block
          // (same isolation reasoning as walletExposure/walletExperience
          // below) — a selection failure must never suppress the
          // existing wallet-clustering signals, and vice versa. Computed
          // unconditionally (not gated on edpiLiveConfig.enabled) since
          // it costs nothing beyond what walletClustering.enabled already
          // paid for by fetching `report`.
          try {
            const rawHolders = rugcheckService.extractRawTopHolders(report);
            edpiWalletSelectionResult = selectEdpiCandidateWallets(rawHolders, { topN: edpiPositionLifecycleConfig.topHolderCount });
          } catch (selectionErr) {
            console.error(`[scanner] EDPI wallet selection failed for ${token.baseToken.symbol}: ${selectionErr.message}`);
          }

          if (holders.length > 0) {
            // Captured once, reused for both recordTokenHolders and the
            // new getWalletExperienceAmong call just below — not a
            // stylistic tidy: getWalletExperienceAmong's own leakage-
            // safety cutoff (token_holders.captured_at < this instant,
            // for pairs other than this one) is only correct if this is
            // the EXACT same instant this pair's own rows get written
            // with, not a separately-sampled Date.now() a moment later
            // that could let an unrelated pair qualifying in that gap
            // count as "prior" when it wasn't actually prior to this
            // capture. See tokenPatternStore.js's
            // getWalletOwnersAtQualification/getWalletExperienceAmong
            // header comments for the full reasoning.
            const walletCaptureAtMs = Date.now();
            await patternStore.recordTokenHolders(token.pairAddress, token.baseToken.address, holders, walletCaptureAtMs);
            recurringWallets = await patternStore.getRecurringWalletsAmong(
              holders.map((h) => h.owner),
              walletClustering.minTokenCountForAlert,
            );
            // Own try/catch nested inside the outer one on purpose: a
            // failure here must never suppress recurringWallets above (or
            // vice versa) — these are two independent signals computed
            // from the same holders list, not one feature with two parts.
            try {
              walletExposure = await patternStore.listPriorRuggedWalletExposureFor(holders.map((h) => h.owner), Date.now());
            } catch (exposureErr) {
              console.error(`[scanner] wallet exposure check failed for ${token.baseToken.symbol}: ${exposureErr.message}`);
            }
            // Same independent-try/catch reasoning as walletExposure just
            // above — this is the wallet-enhanced flip shadow model's
            // three experienced-wallet features (shadow-only; see
            // src/core/flipWalletShadowModel.js), a third independent
            // signal off this same holders list, not something that
            // should be able to suppress or be suppressed by either of
            // the other two.
            try {
              walletExperience = await patternStore.getWalletExperienceAmong(holders.map((h) => h.owner), token.pairAddress, walletCaptureAtMs);
            } catch (experienceErr) {
              console.error(`[scanner] wallet experience check failed for ${token.baseToken.symbol}: ${experienceErr.message}`);
            }
            // EDPI-L's OPTIONAL historical enrichment (Evidence Family 4,
            // early_wallet_activity) — own independent try/catch, same
            // reasoning as the two just above: this is allowed to be
            // sparse or fail entirely (the whole point of this being
            // "optional/enriching," per the spec) without touching
            // recurringWallets/walletExposure/walletExperience or vice
            // versa. Gated on edpiLiveConfig.enabled so a token with
            // EDPI-L turned off doesn't pay for a lookup nothing will
            // read. Capped at maxWalletsForHistoricalLookup wallets so an
            // unusually large Rugcheck holder list can't turn this into
            // an unbounded shard fan-out.
            if (edpiLiveConfig.enabled) {
              try {
                const walletsForHistory = holders.map((h) => h.owner).slice(0, edpiLiveConfig.maxWalletsForHistoricalLookup);
                walletHistory = await patternStore.getEarlyWalletHistoryAmong(walletsForHistory, token.pairAddress, walletCaptureAtMs);
              } catch (historyErr) {
                console.error(`[scanner] EDPI-L historical wallet lookup failed for ${token.baseToken.symbol}: ${historyErr.message}`);
              }
              // Own independent try/catch, same reasoning as every other
              // lookup in this block — a failure here must not suppress
              // walletHistory above (Family 4's coverage stats are still
              // useful even if Family 5's richer trade-level data fails).
              try {
                const walletsForTrades = holders.map((h) => h.owner).slice(0, edpiLiveConfig.maxWalletsForHistoricalLookup);
                walletTradesData = await patternStore.getEarlyWalletTradesWithOutcomesAmong(walletsForTrades, token.pairAddress, walletCaptureAtMs);
              } catch (tradesErr) {
                console.error(`[scanner] EDPI-L wallet trades/outcomes lookup failed for ${token.baseToken.symbol}: ${tradesErr.message}`);
              }
            }
          }
        } catch (err) {
          console.error(`[scanner] wallet clustering failed for ${token.baseToken.symbol}: ${err.message}`);
        }
      }

      // CTO convergence is intentionally outside the wallet-clustering
      // feature gate. It reuses the already-fetched Rugcheck report and the
      // existing Top-20 rank-then-exclude selection, but has its own explicit
      // research/shadow config gate and never writes token_holders itself.
      if (edpiCTOConfig.enabled) {
        try {
          if (!edpiWalletSelectionResult) {
            const rawHolders = rugcheckService.extractRawTopHolders(report);
            edpiWalletSelectionResult = selectEdpiCandidateWallets(rawHolders, { topN: edpiPositionLifecycleConfig.topHolderCount });
          }
          const { getEarlyWalletCTOTradesAmong, getPriorDeadRuggedArchivesForMint } = patternStore;
          const top5Wallets = edpiWalletSelectionResult.candidates.slice(0, edpiCTOConfig.topHolderCount);
          const owners = top5Wallets.map((w) => w.owner);
          const qualificationTimeMs = Number.isFinite(Number(qualifiedAtMs)) ? Number(qualifiedAtMs) : null;

          if (qualificationTimeMs !== null && owners.length > 0) {
            const ctoData = await getEarlyWalletCTOTradesAmong(owners, token.pairAddress, qualificationTimeMs);
            const tradesByWallet = new Map();
            for (const trade of ctoData.trades) {
              if (!tradesByWallet.has(trade.walletAddress)) tradesByWallet.set(trade.walletAddress, []);
              tradesByWallet.get(trade.walletAddress).push(trade);
            }
            const processedPositionsByWallet = new Map();
            for (const holder of top5Wallets) {
              const walletTrades = tradesByWallet.get(holder.owner) || [];
              const processedPositions = walletTrades.length > 0
                ? buildWalletProcessedPositions(walletTrades, ctoData.snapshotsByPair, ctoData.outcomesByPair, edpiPositionLifecycleConfig, qualificationTimeMs)
                : [];
              processedPositionsByWallet.set(holder.owner, processedPositions);
            }

            const currentTokenPriorDeathEvidence = await getPriorDeadRuggedArchivesForMint(
              token.baseToken.address,
              qualificationTimeMs,
            );

            edpiCtoResult = buildCtoEvidence({
              currentTokenMint: token.baseToken.address,
              currentPairAddress: token.pairAddress,
              qualificationTimeMs,
              candidateWallets: top5Wallets,
              candidateWalletCount: edpiWalletSelectionResult.candidates.length,
              processedPositionsByWallet,
              trades: ctoData.trades,
              outcomesByPair: ctoData.outcomesByPair,
              eventualOutcomesByPair: ctoData.eventualOutcomesByPair,
              snapshotsByPair: ctoData.snapshotsByPair,
              currentTokenPriorDeathEvidence,
              includeRetrospectiveOutcomes: false,
            });
          } else {
            edpiCtoResult = buildCtoEvidence({
              currentTokenMint: token.baseToken.address,
              currentPairAddress: token.pairAddress,
              qualificationTimeMs,
              candidateWallets: top5Wallets,
              candidateWalletCount: edpiWalletSelectionResult.candidates.length,
              includeRetrospectiveOutcomes: false,
            });
          }
        } catch (ctoErr) {
          console.error(`[scanner] EDPI CTO convergence failed for ${token.baseToken.symbol}: ${ctoErr.message}`);
        }
      }

      // EDPI-L and CTO have their own population contract. If the legacy
      // wallet-clustering feature is disabled, still derive the EDPI holder
      // population from the already-fetched Rugcheck report so disabling an
      // unrelated enrichment cannot silently disable production EDPI-L.
      if ((edpiLConfig.enabled || edpiCTOConfig.enabled) && !edpiWalletSelectionResult) {
        try {
          const rawHolders = rugcheckService.extractRawTopHolders(report);
          edpiWalletSelectionResult = selectEdpiCandidateWallets(rawHolders, { topN: edpiPositionLifecycleConfig.topHolderCount });
        } catch (selectionErr) {
          console.error(`[scanner] EDPI-L wallet selection failed for ${token.baseToken.symbol}: ${selectionErr.message}`);
          edpiWalletSelectionResult = null;
        }
      }

      // Canonical historical activity capture is driven by the production EDPI
      // population itself: the current token's raw Top-20 holders after the
      // configured infrastructure/type exclusion. Do NOT pass the broader
      // Rugcheck holder list here; that would change the historical population
      // being measured. Capture is asynchronous and subsequent scans consume
      // the persisted activity.
      if ((edpiLConfig.enabled || edpiCTOConfig.enabled) && edpiWalletSelectionResult) {
        try {
          const owners = edpiWalletSelectionResult.candidates.map((wallet) => wallet.owner).filter(Boolean);
          if (owners.length > 0 && Number.isFinite(Number(qualifiedAtMs))) {
            await requestMissingWalletActivity({
              walletAddresses: owners,
              currentPairAddress: token.pairAddress,
              beforeMs: Number(qualifiedAtMs),
              maxWallets: owners.length,
            });
          }
        } catch (captureErr) {
          console.error(`[scanner] EDPI canonical activity capture request failed for ${token.baseToken.symbol}: ${captureErr.message}`);
        }
      }

      if (edpiLConfig.enabled && !edpiWalletSelectionResult) {
        console.error(`[scanner] EDPI-L wallet selection unavailable for ${token.baseToken.symbol}; continuing without EDPI-L`);
      }

      // --- Production EDPI-L scoring -----------------------------------
      // The scoring layer consumes the same Top-20 -> infrastructure-excluded
      // wallet population used by the existing EDPI behavioral architecture.
      // It is deliberately isolated from discovery/qualification/safety/signal
      // decisions and uses only evidence available at this qualification time.
      if (edpiLConfig.enabled && edpiWalletSelectionResult) {
        try {
          const scoringWallets = edpiWalletSelectionResult.candidates;
          const owners = scoringWallets.map((w) => w.owner);
          const scoringTradesData = await patternStore.getEarlyWalletTradesForPositionsAmong(
            owners,
            token.pairAddress,
            qualifiedAtMs,
          );
          const currentCapitalByWallet = await patternStore.getCurrentWalletCapitalSol(
            token.pairAddress,
            owners,
            qualifiedAtMs,
          );
          const tradesByWallet = new Map();
          for (const trade of scoringTradesData.trades || []) {
            if (!tradesByWallet.has(trade.walletAddress)) tradesByWallet.set(trade.walletAddress, []);
            tradesByWallet.get(trade.walletAddress).push(trade);
          }

          const walletProfiles = scoringWallets.map((holder) => {
            const walletTrades = tradesByWallet.get(holder.owner) || [];
            const processedPositions = walletTrades.length > 0
              ? buildWalletProcessedPositions(
                walletTrades,
                scoringTradesData.snapshotsByPair,
                scoringTradesData.outcomesByPair,
                edpiPositionLifecycleConfig,
                qualifiedAtMs,
              )
              : [];
            return {
              walletAddress: holder.owner,
              holderPct: holder.pct,
              processedPositions,
              profile: buildWalletHistoricalOutcomeProfile(processedPositions),
            };
          });

          const behavioralProfiles = walletProfiles.map((wallet) => evaluateWalletBehavioralProfile(
            wallet.walletAddress,
            wallet.processedPositions,
            scoringTradesData.outcomesByPair,
            token.marketCap,
            currentCapitalByWallet[wallet.walletAddress] ?? null,
            edpiBehavioralConfig,
          ));

          edpiLResult = calculateEdpiL({
            candidateWallets: scoringWallets,
            rawCandidateWalletCount: edpiWalletSelectionResult.rawTop.length,
            walletProfiles,
            behavioralProfiles,
            currentEntryMcUsd: token.marketCap,
            currentCapitalByWallet,
            ctoEvidence: edpiCtoResult,
            config: {
              ...edpiBehavioralConfig,
              excludedWalletCount: edpiWalletSelectionResult.excludedInfrastructure.length,
              excludedWallets: edpiWalletSelectionResult.excludedInfrastructure,
            },
            scoringVersion: edpiLConfig.scoringVersion,
            strengthVersion: edpiLConfig.strengthVersion,
            evaluationAtMs: qualifiedAtMs,
          });
        } catch (edpiScoringErr) {
          console.error(`[scanner] EDPI-L scoring failed for ${token.baseToken.symbol}: ${edpiScoringErr.message}`);
          edpiLResult = null;
        }
      }

      // --- EDPI-L (Live Empirical Data Pattern Inference) — see
      // src/core/edpiLive.js's header for the full design. Computed here,
      // before hypeScore/riskLevel/Gemini, entirely from evidence already
      // in scope above (safety/edpiLiveHolders/walletExposure/
      // walletExperience/walletHistory) plus the token itself — no new
      // I/O of its own. Own try/catch even though computeEdpiLive is
      // internally defensive and documented to never throw: same
      // belt-and-suspenders posture as every other optional signal in
      // this function. Gated on edpiLiveConfig.enabled (default true,
      // purely additive — see config.js) so this can be turned off
      // without a code change, same posture as walletClustering. ---
      let edpiLiveResult = null;
      if (edpiLiveConfig.enabled) {
        discoveryStats.edpiL += 1;
        if (hasGeckoSource) discoveryStats.gecko.edpiL += 1;
        discoveryEvaluations.push({ pairAddress: token.pairAddress, mintAddress: token.baseToken?.address, evaluatedAt: Date.now(), source: sources.join(','), stage: 'edpi_l', passed: true, qualificationFilterVersion: QUALIFICATION_FILTER_VERSION });
        try {
          edpiLiveResult = computeEdpiLive({
            token,
            safety,
            holders: edpiLiveHolders,
            walletClusteringEnabled: walletClustering.enabled,
            recurringWallets,
            walletExposure,
            walletExperience,
            walletHistory,
            walletTradesData,
            edpiLiveConfig: {
              walletBaselineMinSampleSize: edpiLiveConfig.walletBaselineMinSampleSize,
              campaignWindowMs: edpiLiveConfig.campaignWindowMs,
              comparableEntryBandMultiplier: edpiLiveConfig.comparableEntryBandMultiplier,
            },
          });
        } catch (err) {
          console.error(`[scanner] EDPI-L computation failed for ${token.baseToken.symbol}: ${err.message}`);
        }
      }

      // --- Observation Engine (Tier 2, Phase 4) — on by default, see
      // observationEngine.js. When enabled, a Medium/High-risk token
      // doesn't alert the moment it first qualifies; it must keep passing
      // the fresh checks above across observation.windowMs before the
      // heavier work below (narrative/prediction/social/Gemini) even
      // runs. shouldObserve() itself already returns false when the
      // feature is off, so this is a true no-op in that case. ---
      if (observationEngine.shouldObserve(riskLevel)) {
        const status = observationEngine.checkObservation(token.pairAddress);
        if (status !== 'graduate') continue; // 'started' or 'observing' — not ready to alert yet
      }

      // --- Pattern tracking: classify + look up historical prediction ---
      // This never blocks or fails the alert — a lookup/enrollment problem
      // here is logged and the pipeline continues exactly as it would
      // without this feature at all.
      let narrativeTag = classifyNarrative(token.baseToken);
      // Plan B (narrative confidence): a rule-based hit is binary — a
      // keyword either matched or it didn't, no score to report — so this
      // is always exactly 1.0/'rule' when narrativeTag is real (not
      // FALLBACK_TAG). Set here, before the description-based fallback
      // below can replace narrativeTag, so 'rule' unambiguously means
      // "the ORIGINAL classifyNarrative call succeeded," matching
      // subNarrativeTag's own reasoning just below for the same ordering
      // choice. Defaults to null/null (not narrativeMatchMethod: 'none' or
      // similar) for the case neither classifier finds anything — there's
      // no confidence to report IN when nothing was classified at all;
      // see the description-fallback block below for where these two
      // would be overwritten if that block finds a match instead.
      let narrativeConfidence = null;
      let narrativeMatchMethod = null;
      if (narrativeTag !== FALLBACK_TAG) {
        narrativeConfidence = 1.0;
        narrativeMatchMethod = 'rule';
      }
      // Display/context only (see narrativeClassifier.js's doc comment) —
      // never fed into categoryKey, prediction lookups, or the archive
      // record, only into the alert's header line via alertFormatter.js.
      // Computed from the ORIGINAL rule-based tag, before the
      // description-based fallback below can replace it — there are no
      // SUB_NARRATIVE_RULES entries for a 'desc:*' tag anyway (or for
      // 'uncategorized'), so this ordering doesn't lose anything, it just
      // avoids a pointless lookup against a tag that will never match.
      const subNarrativeTag = classifySubNarrative(narrativeTag, token.baseToken);

      // --- Description-based narrative fallback (see
      // descriptionClassifier.js) — only runs when the rule-based
      // classifier above found nothing. Own isolated try/catch, same
      // reasoning as the prediction/historical-match/social-signal blocks
      // below: a lookup/registry problem here must never block the alert,
      // worst case this token just stays 'uncategorized' the way it
      // always would have before this feature existed. ---
      if (narrativeTag === FALLBACK_TAG) {
        try {
          const existingCategories = await patternStore.getDescriptionCategories();
          const match = classifyByDescription(
            { description: token.description, name: token.baseToken.name, symbol: token.baseToken.symbol },
            existingCategories,
          );
          if (match) {
            narrativeTag = match.categoryKey;
            // Plan B: match.confidence is the Jaccard/trigram similarity
            // score that decided this match, or explicitly null for a
            // newly-minted category (see classifyByDescription's doc
            // comment on why that case gets null rather than a score —
            // there's no existing bucket to report a similarity TO).
            // matchedVia is always set whenever match is truthy, so no
            // separate null-check is needed for it here.
            narrativeConfidence = match.confidence;
            narrativeMatchMethod = match.matchedVia;
            if (match.isNew) {
              const sampleTokenName = `${token.baseToken.symbol || ''} ${token.baseToken.name || ''}`.trim();
              await patternStore.createDescriptionCategory(match.categoryKey, match.keywords, token.description || null, sampleTokenName, Date.now());
            } else {
              await patternStore.incrementDescriptionCategoryCount(match.categoryKey);
            }
          }
        } catch (err) {
          console.error(`[scanner] description-based narrative fallback failed for ${token.baseToken.symbol}: ${err.message}`);
        }
      }

      const categoryKey = buildCategoryKey(narrativeTag, hypeScore);
      let prediction = null;
      try {
        // AUDIT FIX (performance): was patternStore.getArchive() — pulled
        // the entire, unbounded pattern_archive table into memory on every
        // qualifying token, every scan cycle, just to filter it down to one
        // category in JS. getArchiveForCategory does that filtering in the
        // query instead, using the existing category_key index — same
        // result, no full-table read. See tokenPatternStore.js's docstring.
        const archiveForCategory = await patternStore.getArchiveForCategory(categoryKey);
        prediction = predictForCategory(categoryKey, archiveForCategory);
      } catch (err) {
        console.error(`[scanner] pattern prediction lookup failed for ${token.baseToken.symbol}: ${err.message}`);
      }

      // --- Historical Matches: closest past archived tokens in the same
      // narrative, for the alert's "📚 HISTORICAL MATCHES" section. Own
      // isolated try/catch, same reasoning as the prediction lookup above —
      // never blocks or fails the alert. Uses getArchiveForNarrative (not
      // getArchiveForCategory) since findSimilarHistoricalTokens scores
      // closeness across every hype score in the narrative, not just one
      // hype bucket. ---
      let historicalMatches = [];
      try {
        const archiveForNarrative = await patternStore.getArchiveForNarrative(narrativeTag);
        historicalMatches = findSimilarHistoricalTokens(
          { narrativeTag, hypeScoreAtQualification: hypeScore, riskLevelAtQualification: riskLevel },
          archiveForNarrative,
          { limit: patternTracking.historicalMatchLimit },
        );
      } catch (err) {
        console.error(`[scanner] historical match lookup failed for ${token.baseToken.symbol}: ${err.message}`);
      }

      // --- Social signals (opt-in, off by default — see
      // config.socialSignals). Own isolated try/catch, separate from
      // qualification/scoring/tracking above: this makes a real external
      // call (Reddit, and later maybe Twitter/Telegram/Google Trends once
      // implemented — see SCRAPERS.md) that can be slow or rate-limited,
      // and must never affect anything else in the pipeline if it fails
      // or the feature is simply turned off. ---
      let socialSignals = { available: false, socialScore: null, components: {} };
      try {
        socialSignals = await socialSignalsService.getSocialSignals(token, token.baseToken);
      } catch (err) {
        console.error(`[scanner] social signal lookup failed for ${token.baseToken.symbol}: ${err.message}`);
      }

      const enriched = {
        ...token, rugcheck: safety, hypeScore, riskLevel, narrativeTag, subNarrativeTag, categoryKey, prediction, socialSignals, historicalMatches, recurringWallets,
        // EDPI-L is only attached here — meaning only visible to
        // gemini_signal_generator.js's buildPrompt, and therefore only
        // able to influence Gemini's own signalLabel/BUY-WAIT-SKIP output
        // — when geminiContextEnabled is explicitly turned on (default
        // OFF). When off, this key is simply absent and buildPrompt's
        // output is byte-identical to before EDPI-L existed — see
        // edpiLive.js's header and gemini_signal_generator.js's
        // buildEdpiLiveContextLine for the full reasoning. The SEPARATE
        // attach to liveEvidence.edpiLive below (always, once
        // edpiLive.enabled) is unaffected by this flag: EDPI-L is always
        // computed and recorded for later analysis regardless of whether
        // Gemini ever sees it.
        ...(edpiLiveConfig.geminiContextEnabled && edpiLiveResult ? { edpiLive: edpiLiveResult } : {}),
        ...(edpiLConfig.geminiContextEnabled && edpiLResult ? { edpiL: edpiLResult } : {}),
      };
      const rawSignal = await geminiService.generateSignal(enriched);
      discoveryStats.signals += 1;
      if (hasGeckoSource) discoveryStats.gecko.signals += 1;
      const assessmentPacket = packetFromSignal(rawSignal);
      const signal = assessmentPacket.signalLabel && extractJsonCandidate(rawSignal) ? renderAssessment(assessmentPacket) : rawSignal;
      // Structured BUY/WAIT/SKIP label pulled out of the rendered signal,
      // captured at qualification time so patternReviewer.js can carry it
      // through to the archive record once this token's outcome is known —
      // that's what src/core/selfAssessment.js aggregates into the
      // daily/weekly admin reports (average ROI per label).
      const signalLabel = geminiService.extractSignalLabel(signal);
      // `qualifiedAtMs` was captured once before the optional research
      // enrichments above and is reused here; do not resample qualification
      // time after Gemini/CTO work has already occurred.
      // Plan A: disambiguates a null signalLabel — the AI call itself
      // never returned real output (isFallbackText, see
      // gemini_signal_generator.js) vs. it DID return real model output
      // but extractSignalLabel found nothing parseable in it. An infra
      // problem vs. a prompt/formatting problem, which have different
      // implications for what (if anything) to actually do about them —
      // "signal_label IS NULL" alone can't tell these apart.
      const signalStatus = signalLabel ? 'SIGNALLED' : geminiService.isFallbackText(signal) ? 'AI_UNAVAILABLE' : 'AI_NO_VERDICT';
      // POST-AUDIT FIX: this push used to sit ABOVE the declarations of
      // signalLabel/signalStatus, so reading them threw a temporal-dead-zone
      // ReferenceError for every candidate that reached this point; the
      // per-pair catch swallowed it and dropped the candidate before it could
      // ever be returned as qualified, i.e. no alert was ever sent.
      // It must stay below both `const`s.
      discoveryEvaluations.push({ pairAddress: token.pairAddress, mintAddress: token.baseToken?.address, evaluatedAt: qualifiedAtMs, source: sources.join(','), stage: 'signal', passed: Boolean(signalLabel), reason: signalLabel ? null : signalStatus, qualificationFilterVersion: QUALIFICATION_FILTER_VERSION });
      // Persist the exact decision context before the existing tracking and
      // Telegram callback paths continue. A failure is non-fatal for this
      // first migration slice so the established alert behavior is preserved;
      // the error remains visible for operational follow-up.
      let alertId = null;
      try {
        const liveEvidence = buildLiveTokenEvidence({
          independentNarrative: classifyMultiSource({ token: enriched, socialMetadata: enriched.socialMetadata }),
          token: enriched,
          safety,
          narrativeTag,
          subNarrativeTag,
          narrativeConfidence,
          narrativeMatchMethod,
          socialMetadata: enriched.socialMetadata,
          capturedAt: new Date(qualifiedAtMs).toISOString(),
        });
        // Additive research feature (flip-tier live shadow prediction, see
        // src/core/flipShadowScoring.js) — attachFlipShadowPrediction never
        // throws and degrades to "no prediction attached" on any failure
        // (missing model file, etc.), so it can't affect the alert decision
        // this try/catch actually exists to protect.
        attachFlipShadowPrediction(liveEvidence, { signalLabel, riskLevel });
        // Second, independent shadow model (flip_tier_logistic_regression_v1)
        // — see flipShadowScoring.js's header for why this replaced the
        // group-rate baseline's zero-live-edge result rather than being
        // added on top blindly. buildFeatureSnapshot is the SAME function
        // buildAlertDecisionInput calls below (extracted from it for exactly
        // this reuse), so this model sees byte-identical feature shape to
        // what actually gets persisted and later used to train it — not a
        // second, parallel construction that could quietly drift. Own
        // try/catch inside attachFeatureModelShadowPrediction, independent
        // of the baseline attach above: neither can affect the other.
        const featureSnapshotForShadow = buildFeatureSnapshot({
          token: enriched, safety, hypeScore, riskLevel, narrativeTag, subNarrativeTag, categoryKey, prediction, socialSignals, socialMetadata: enriched.socialMetadata, liveEvidence, historicalMatches, recurringWallets, walletExposure, walletExperience,
        });
        attachFeatureModelShadowPrediction(liveEvidence, { featureSnapshot: featureSnapshotForShadow, hasFeatureSnapshot: true });
        // Third, independent shadow model — wallet-enhanced hit_5x
        // experiment (see src/core/flipWalletShadowModel.js). Reuses the
        // SAME featureSnapshotForShadow as attachFeatureModelShadowPrediction
        // just above (now carrying the three wallet-experience fields via
        // walletExperience), so baseline and wallet-enhanced here are
        // compared on byte-identical features to what gets persisted and
        // later trained on — not a fourth, parallel construction. Own
        // try/catch inside attachWalletShadowPrediction, independent of
        // both attach calls above: none of the three can affect the
        // others, and none of the three can affect qualification, signal,
        // BUY/WAIT/SKIP, risk level, or alert broadcasting below — this is
        // strictly observational, same as the other two.
        attachWalletShadowPrediction(liveEvidence, { featureSnapshot: featureSnapshotForShadow, hasFeatureSnapshot: true });
        // Fourth independent shadow-style attach — EDPI-L (see
        // src/core/edpiLive.js). `edpiLiveResult` was already computed
        // earlier in this function (before Gemini ran, so it could
        // optionally be shown to it — see the `enriched` object above);
        // this just records that SAME result to live_evidence for later
        // analysis, a no-op when edpiLiveConfig.enabled is false
        // (edpiLiveResult stays null). Own try/catch inside
        // attachEdpiLiveResult, independent of the three attach calls
        // above: none of the four can affect the others, and none can
        // affect qualification, signal, riskLevel, or broadcasting below.
        attachEdpiLiveResult(liveEvidence, edpiLiveResult);
        // Production EDPI-L score/evidence. Arithmetic was completed before
        // Gemini and is authoritative; Gemini only receives/interprets the
        // structured package when its existing EDPI context gate is enabled.
        attachEdpiLResult(liveEvidence, edpiLResult);
        // Fifth independent shadow-style attach — EDPI wallet-population
        // selection (see src/core/edpiWalletSelection.js). Computed much
        // earlier in this function (inside the wallet-clustering block,
        // alongside edpiLiveHolders), attached here for the same
        // "evidence object gets built in one place, near the end"
        // reason as the other four. Own try/catch inside
        // attachEdpiWalletSelectionResult; cannot affect or be affected
        // by any of the other four, and cannot affect qualification,
        // signal, riskLevel, or broadcasting below.
        attachEdpiWalletSelectionResult(liveEvidence, edpiWalletSelectionResult);
        attachEdpiCTOResult(liveEvidence, edpiCtoResult);
        // High-ROI winner-pattern rule. This is deliberately attached only to
        // immutable live evidence: it must remain observational until a
        // prospective shadow evaluation proves its precision and coverage.
        if (highRoiPatternShadow.enabled) {
          attachHighRoiPatternShadow(liveEvidence, {
            token: enriched,
            safety,
            hypeScore,
            signalLabel,
            observedAt: new Date(qualifiedAtMs).toISOString(),
          });
        }
        liveEvidence.tier1Admission = tier1Gate;
        const decisionInput = buildAlertDecisionInput({
          token: enriched,
          safety,
          hypeScore,
          riskLevel,
          narrativeTag,
          subNarrativeTag,
          categoryKey,
          prediction,
          socialSignals,
          socialMetadata: enriched.socialMetadata,
          liveEvidence,
          assessmentPacket,
          historicalMatches,
          recurringWallets,
          walletExposure,
          walletExperience,
          signal: rawSignal,
          signalLabel,
          signalStatus,
          qualifiedAt: new Date(qualifiedAtMs).toISOString(),
          edpiL: edpiLResult,
        });
        const persistedDecision = await persistAlertDecision(decisionInput);
        alertId = persistedDecision.alertId;
      } catch (err) {
        console.error(`[scanner] failed to persist immutable alert decision for ${token.baseToken.symbol}: ${err.message}`);
      }

      // Enrolled into tracking if either: (a) its riskLevel is one we track
      // by default (patternTracking.trackRiskLevels, e.g. Low), or (b) its
      // AI signal came back WAIT or BUY — those are the two labels meaning
      // "this is worth watching/acting on," so tracking isn't limited to
      // Low-risk only; a Medium/High-risk token that gets a WAIT or BUY
      // still has its outcome recorded. Only a SKIP on a non-Low-risk
      // token is excluded — that's the bot saying "not worth watching,"
      // so it's not worth tracking either.
      const shouldTrack = patternTracking.trackRiskLevels.includes(riskLevel) || signalLabel === 'WAIT' || signalLabel === 'BUY';
      if (patternTracking.enabled && shouldTrack) {
        try {
          await patternStore.enrollToken({
            pairAddress: token.pairAddress,
            mintAddress: token.baseToken.address,
            baseToken: token.baseToken,
            narrativeTag,
            narrativeConfidence,
            narrativeMatchMethod,
            hypeScoreAtQualification: hypeScore,
            riskLevelAtQualification: riskLevel,
            signalLabel,
            signalStatus,
            qualifiedAt: qualifiedAtMs,
            pairCreatedAt: token.pairCreatedAt,
            firstPriceUsd: token.priceUsd,
            athPriceUsd: token.priceUsd,
            athAt: Date.now(),
            lastPriceUsd: token.priceUsd,
            lastCheckedAt: Date.now(),
            // Captured once, here, and never overwritten afterward — see
            // patternReviewer.js's buildArchiveRecord for why this
            // shouldn't be derived from the snapshots table later on.
            // `safety` is already available from the rugcheck call made
            // for the safety gate above, so this costs no extra API call.
            firstTopHolderPct: safety.topHolderPct,
            firstLpLockedPct: safety.lpLockedPct,
            // Item 5 (AI-training-pipeline proposal audit) — same
            // reasoning as firstTopHolderPct/firstLpLockedPct just
            // above, same already-fetched `safety` object, no extra call.
            firstMintAuthorityHeld: safety.mintAuthorityHeld ?? null,
            firstFreezeAuthorityHeld: safety.freezeAuthorityHeld ?? null,
          });
        } catch (err) {
          console.error(`[scanner] failed to enroll ${token.baseToken.symbol} into pattern tracking: ${err.message}`);
        }
      }

      alertedPairs.add(rawPair.pairAddress);
      try {
        await patternStore.recordAlertedPair(rawPair.pairAddress, Date.now());
      } catch (err) {
        // Non-fatal: worst case on a write failure is the same behavior
        // as before this fix existed (in-memory-only dedup for this
        // process's lifetime), not worse — never blocks the alert itself.
        console.error(`[scanner] failed to persist alerted-pair record for ${token.baseToken.symbol}: ${err.message}`);
      }
      observationEngine.stopObserving(rawPair.pairAddress); // no-op if it wasn't being observed (Low-risk immediate path)
      qualified.push({ ...enriched, signal, signalLabel, alertId });
    } catch (err) {
      console.error(`[scanner] skipping pair ${rawPair.pairAddress} due to error: ${err.message}`);
    }
  }

  try {
    await discoveryOutcomeStore.recordDiscoveryEvaluations(discoveryEvaluations);
  } catch (err) {
    console.error(`[scanner] discovery outcome-evaluation write failed: ${err.message}`);
  }
  console.log(JSON.stringify({ event: 'discovery_cycle_summary', ...discoveryStats }));
  return qualified;
}

/**
 * Starts the continuous scan loop. `onQualifiedTokens` is called with an
 * array (possibly empty) of qualified tokens after each cycle.
 */
function startScanLoop(onQualifiedTokens) {
  let running = false;

  const tick = async () => {
    if (running) return; // fast in-process guard against overlapping cycles if one runs long
    running = true;
    try {
      // Cross-process guard: alertedPairs/dbAlertedPairs above is a
      // read-a-snapshot-then-write-later check, which is safe within
      // one process but not atomic across two — a second process (an
      // accidental duplicate Railway service, or an overlap during
      // deploy) could pass the same dbAlertedPairs check before either
      // has written, then both qualify and persistAlertDecision the
      // same brand-new token, since persistAlertDecision's ON CONFLICT
      // is keyed on a freshly-random alertId, not pairAddress — it
      // can't catch that. Holding this lock for the whole cycle (not
      // just the dedup check) closes that gap: only one process is ever
      // inside runScanCycle at a time. See advisoryLock.js for why this
      // doesn't block on contention and why a skipped cycle is fine.
      const { skipped, result } = await withAdvisoryLock(LOCK_IDS.SCAN_LOOP, () => runScanCycle());
      if (skipped) {
        console.log(`[scanner] another process holds the scan-loop lock — skipping this cycle. (${runtimeTag()})`);
        return;
      }
      const qualified = result;
      if (qualified.length > 0) {
        await onQualifiedTokens(qualified);
      }
    } catch (err) {
      console.error(`[scanner] cycle failed: ${err.message} (${runtimeTag()})`);
    } finally {
      running = false;
    }
  };

  tick(); // run immediately on startup, then on the interval
  const handle = setInterval(tick, scanner.intervalMs);
  return () => clearInterval(handle);
}

module.exports = {
  runScanCycle,
  startScanLoop,
  normalizePair,
  enrichGeckoSocialMetadata,
};
