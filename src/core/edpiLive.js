'use strict';

/**
 * EDPI-L (Live Empirical Data Pattern Inference) — a live, per-
 * qualification intelligence layer, analogous in spirit to Hype Score
 * and Risk Score but built from a different question: not "does this
 * token pass our numeric gates" but "what does the available wallet/
 * holder/capital/outcome evidence say about this token right now, and
 * how much of that evidence do we actually have."
 *
 * DESIGN CONSTRAINT (unchanged since v1): EDPI-L must be computable for
 * a token that has NEVER been seen before — no pattern_archive,
 * early_wallet_activity, or other historical row required to exist.
 * Every piece of evidence this module consumes is either (a) already
 * fetched/computed earlier in THIS SAME qualification cycle by
 * tokenScanner.js, or (b) an OPTIONAL enrichment lookup against
 * early_wallet_activity/alert_decisions/pattern_archive that is allowed
 * to come back empty, partial, or not be attempted at all.
 *
 * This module does NO I/O — every function here is pure, over whatever
 * the caller already fetched. tokenScanner.js does the fetching
 * (tokenPatternStore.js's getEarlyWalletTradesWithOutcomesAmong), this
 * module does the synthesis. Same split as everywhere else in this
 * project, same reason: trivially unit-testable against plain object
 * fixtures (test/edpi_live.test.js), no database required.
 *
 * SHADOW-ONLY, BY CONSTRUCTION: this module has no access to, and
 * therefore cannot mutate, qualification/marketCheck/safetyCheck/
 * riskLevel/signalLabel/broadcast-filter state — none of that is passed
 * in. attachEdpiLiveResult only ever adds ONE new key to the
 * live_evidence object tokenScanner.js is already building. Gemini
 * visibility is a SEPARATE, independent, more-conservative-by-default
 * gate (config.edpiLive.geminiContextEnabled) — see
 * gemini_signal_generator.js's buildEdpiLiveContextLine.
 *
 * ============================================================
 * v2 CHANGE (per the follow-up spec): wallet-relative anomaly (Evidence
 * Family 5) is NO LONGER a deferred placeholder. It is implemented for
 * real below, alongside two new families the spec introduced:
 * walletHistoricalOutcomeProfile ("what happens to the tokens this
 * wallet historically enters") and its comparable-entry-conditioned
 * variant. What remains deferred, per the spec's own explicit framing,
 * is ONLY the arbitrary interpretation of these numbers (bullish/
 * bearish thresholds, a composite score) — never the underlying
 * measurements themselves. `score` stays `null` throughout this file.
 * ============================================================
 *
 * UNIT NOTE, READ BEFORE TOUCHING THE MC/BUY-SIZE MATH BELOW: this file
 * has to reconcile two currencies without ever assuming a historical
 * SOL/USD exchange rate exists anywhere (it doesn't — nothing in this
 * codebase captures one). Two different tricks are used, deliberately
 * NOT the same trick, because the two reconstructions have different
 * "already in USD" starting points:
 *   - Entry MC (a wallet's historical trade, only ever recorded in SOL —
 *     `early_wallet_activity.sol_amount`): reconstructed via a RATIO of
 *     two SOL-denominated prices — the trade's own implied execution
 *     price in SOL, divided by that SAME PAIR's own `priceNative` (SOL
 *     price) at its qualification snapshot — then that ratio is applied
 *     to the snapshot's own USD market cap. See reconstructEntryMarketCap.
 *     This works because both halves of the ratio are SOL-denominated
 *     and from the same pair within the same early launch window, so no
 *     SOL/USD rate ever has to be known for it to cancel out correctly.
 *   - Peak MC (an outcome field, `pattern_archive.ath_price_usd` — ALREADY
 *     USD): no ratio trick needed at all, just supply (backed out of
 *     that pair's own snapshot marketCap/priceUsd) × athPriceUsd
 *     directly. See reconstructPeakMarketCap. This is why peak-MC
 *     coverage is expected to be meaningfully BETTER than entry-MC
 *     coverage even though both need a snapshot to exist.
 *   - Current buy-size (this wallet's CURRENT estimated held value,
 *     `holderPct/100 * token.marketCap`, in USD) has to be converted TO
 *     SOL to compare against the SOL-denominated historical buy-size
 *     baseline — done via THIS token's own live `priceNative`/`priceUsd`
 *     ratio (the SOL-per-USD rate this exact pair implies right now).
 *     See estimateCurrentBuySizeSol. Self-consistent for the same
 *     reason: both numbers come from the same pair at the same instant.
 *
 * All three reconstructions share one precondition beyond the pair-
 * specific ones above: `mintAuthorityHeld === false` at the snapshot —
 * supply is only assumed fixed (and therefore reusable across time) for
 * a mint that has renounced further minting. A live mint authority means
 * "unknown, possibly time-varying supply," which this file refuses to
 * guess at rather than silently treating as fixed.
 *
 * COVERAGE CAVEAT, STATED PLAINLY: `priceNative` was not historically
 * captured in `alert_decisions.feature_snapshot.market` before this
 * change (see tokenScanner.js's normalizePair / alertDecision.js's
 * buildFeatureSnapshot) — meaning entry-MC reconstruction has ZERO
 * coverage against the archive that exists today and will only start
 * working as new archive rows accumulate with it populated. Peak-MC
 * reconstruction has no such gap (it never needed priceNative), so it
 * should show real coverage immediately wherever pattern_archive rows
 * already exist. This asymmetry is expected, not a bug — see
 * docs/edpi-live.md.
 */

const EDPI_LIVE_VERSION = 'edpi-live-v2';

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finitePositiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizedTradeSolValue(trade) {
  if (Object.prototype.hasOwnProperty.call(trade || {}, 'valueSol')) {
    const n = Number(trade.valueSol);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (Object.prototype.hasOwnProperty.call(trade || {}, 'solAmount')) {
    const n = Number(trade.solAmount);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function mergeEconomicSolValues(a, b) {
  return a === null || b === null ? null : a + b;
}


// ---------------------------------------------------------------------
// Generic statistics — one implementation, reused for buy size, entry
// MC, peak MC, and ROI, so a fix or a methodology change (e.g. switching
// interpolation methods) happens in exactly one place.
// ---------------------------------------------------------------------

/**
 * Linear-interpolation percentile (the same method R's default `type=7`
 * and numpy's default use) over an ALREADY-NUMERIC, ALREADY-FILTERED
 * array. Deliberately simple/standard rather than picking something
 * exotic — this is a measurement primitive, not a place to introduce a
 * novel research choice.
 */
function percentile(sortedAscending, p) {
  const n = sortedAscending.length;
  if (n === 0) return null;
  if (n === 1) return sortedAscending[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAscending[lo];
  const weight = rank - lo;
  return sortedAscending[lo] * (1 - weight) + sortedAscending[hi] * weight;
}

/**
 * @param {number[]} values - already filtered to only the values that
 *   should count (e.g. only campaigns where entry MC was reconstructable)
 * @returns {{sampleSize:number, median:number|null, p25:number|null, p75:number|null, p90:number|null}}
 */
function computeDistributionStats(values) {
  const clean = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v));
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    sampleSize: sorted.length,
    median: sorted.length > 0 ? percentile(sorted, 0.5) : null,
    p25: sorted.length > 0 ? percentile(sorted, 0.25) : null,
    p75: sorted.length > 0 ? percentile(sorted, 0.75) : null,
    p90: sorted.length > 0 ? percentile(sorted, 0.9) : null,
  };
}

// ---------------------------------------------------------------------
// Fragmented-buy grouping ("entry campaigns")
// ---------------------------------------------------------------------

/**
 * Groups a WALLET's raw trades on a SINGLE pair into "entry campaigns":
 * consecutive trades (sorted by block_time) less than `windowMs` apart
 * are summed into one campaign, so a liquidity-driven $170+$140+$110+$95
 * spread across a few minutes is treated as one $515 entry, not four
 * independent $100-ish ones — see the spec's explicit "fragmented buys"
 * concern. The grouping key is (walletAddress, pairAddress): trades on
 * DIFFERENT pairs are never merged into the same campaign, however close
 * in time — a campaign is inherently pair-specific.
 *
 * Deterministic and recomputable from raw data alone: no state beyond
 * `trades` and `windowMs`, both of which the caller controls — the SAME
 * raw `early_wallet_activity` rows always produce the SAME campaigns for
 * a given `windowMs`, so changing the window later (a config value, see
 * config.js's edpiLive.campaignWindowMs) never requires re-fetching or
 * mutating anything.
 *
 * `windowMs` is an explicit, configurable RESEARCH PARAMETER, not a
 * validated constant — this environment has no real gap-time
 * distribution to derive one from (see config.js's comment on
 * campaignWindowMs). Raw trades themselves are never mutated or
 * discarded — the caller still has the original `trades` array; this
 * only produces a derived, recomputable view of them.
 *
 * @param {Array<{walletAddress, pairAddress, solAmount, tokenDelta, blockTime}>} trades
 * @param {number} windowMs
 * @returns {Array<{walletAddress, pairAddress, solAmount, tokenDelta, startBlockTime, endBlockTime, txnCount}>}
 */
function groupTradesIntoCampaigns(trades, windowMs) {
  const list = Array.isArray(trades) ? trades : [];
  const byWalletPair = new Map();
  for (const t of list) {
    if (!t || !Number.isFinite(t.blockTime)) continue;
    const key = `${t.walletAddress}::${t.pairAddress}`;
    if (!byWalletPair.has(key)) byWalletPair.set(key, []);
    byWalletPair.get(key).push(t);
  }
  const campaigns = [];
  for (const [, walletPairTrades] of byWalletPair) {
    const sorted = [...walletPairTrades].sort((a, b) => a.blockTime - b.blockTime);
    let current = null;
    for (const t of sorted) {
      if (current && (t.blockTime - current.endBlockTime) <= windowMs) {
        current.solAmount = mergeEconomicSolValues(current.solAmount, normalizedTradeSolValue(t));
        current.tokenDelta += Number(t.tokenDelta) || 0;
        current.endBlockTime = t.blockTime;
        current.txnCount += 1;
      } else {
        if (current) campaigns.push(current);
        current = {
          walletAddress: t.walletAddress,
          pairAddress: t.pairAddress,
          solAmount: normalizedTradeSolValue(t),
          tokenDelta: Number(t.tokenDelta) || 0,
          startBlockTime: t.blockTime,
          endBlockTime: t.blockTime,
          txnCount: 1,
        };
      }
    }
    if (current) campaigns.push(current);
  }
  return campaigns;
}

// ---------------------------------------------------------------------
// Entry MC / Peak MC reconstruction — see the module header's "UNIT
// NOTE" for why these two use different methods.
// ---------------------------------------------------------------------

/**
 * @param {{solAmount:number, tokenDelta:number}} campaign
 * @param {{marketCapUsd:number|null, priceUsd:number|null, priceNative:number|null, mintAuthorityHeld:boolean|null}|undefined} snapshot
 * @returns {{available:boolean, entryMcUsd:number|null, reason:string|null}}
 */
function reconstructEntryMarketCap(campaign, snapshot) {
  if (!snapshot) return { available: false, entryMcUsd: null, reason: 'missing_snapshot' };
  if (snapshot.mintAuthorityHeld !== false) return { available: false, entryMcUsd: null, reason: 'mint_authority_not_confirmed_renounced' };
  const marketCapUsd = finitePositiveOrNull(snapshot.marketCapUsd);
  const priceNative = finitePositiveOrNull(snapshot.priceNative);
  if (marketCapUsd === null || priceNative === null) return { available: false, entryMcUsd: null, reason: 'snapshot_missing_price_native_or_market_cap' };
  const solAmount = normalizedTradeSolValue(campaign);
  const tokenDelta = Number(campaign.tokenDelta);
  if (!(solAmount > 0) || !(tokenDelta > 0)) return { available: false, entryMcUsd: null, reason: 'not_a_net_buy' };
  const executionPriceSolPerToken = solAmount / tokenDelta;
  const ratio = executionPriceSolPerToken / priceNative;
  const entryMcUsd = ratio * marketCapUsd;
  if (!Number.isFinite(entryMcUsd) || entryMcUsd <= 0) return { available: false, entryMcUsd: null, reason: 'non_finite_result' };
  return { available: true, entryMcUsd, reason: null };
}

/**
 * @param {{athPriceUsd:number|null}|undefined} outcome
 * @param {{marketCapUsd:number|null, priceUsd:number|null, mintAuthorityHeld:boolean|null}|undefined} snapshot
 * @returns {{available:boolean, peakMcUsd:number|null, reason:string|null}}
 */
function reconstructPeakMarketCap(outcome, snapshot) {
  if (!outcome || !snapshot) return { available: false, peakMcUsd: null, reason: 'missing_outcome_or_snapshot' };
  if (snapshot.mintAuthorityHeld !== false) return { available: false, peakMcUsd: null, reason: 'mint_authority_not_confirmed_renounced' };
  const marketCapUsd = finitePositiveOrNull(snapshot.marketCapUsd);
  const priceUsd = finitePositiveOrNull(snapshot.priceUsd);
  const athPriceUsd = finitePositiveOrNull(outcome.athPriceUsd);
  if (marketCapUsd === null || priceUsd === null || athPriceUsd === null) return { available: false, peakMcUsd: null, reason: 'missing_price_fields' };
  const supplyTokens = marketCapUsd / priceUsd;
  const peakMcUsd = athPriceUsd * supplyTokens;
  if (!Number.isFinite(peakMcUsd) || peakMcUsd <= 0) return { available: false, peakMcUsd: null, reason: 'non_finite_result' };
  return { available: true, peakMcUsd, reason: null };
}

// ---------------------------------------------------------------------
// Live-side estimates for the CURRENT token (no historical data
// involved — these are what a brand-new qualification always has).
// ---------------------------------------------------------------------

/** Current "entry MC" for anomaly comparison purposes is simply the
 * token's own live market cap — already USD, no reconstruction needed
 * (that machinery above is only for a wallet's PAST trades on OTHER
 * pairs, which never had a live marketCap recorded for us to just read).
 */
function estimateCurrentEntryMcUsd(token) {
  return finitePositiveOrNull(token?.marketCap);
}

/**
 * Converts this wallet's current ESTIMATED held value (holderPct/100 ×
 * live USD market cap — the same estimate Family 3/currentHolderValue
 * already computes) into SOL, using this SAME pair's own live
 * priceNative/priceUsd ratio, so it can be compared against the
 * SOL-denominated historical buy-size baseline without ever needing an
 * external SOL/USD rate. See the module header's "UNIT NOTE."
 */
function estimateCurrentBuySizeSol(token, holderPct) {
  const marketCapUsd = finitePositiveOrNull(token?.marketCap);
  const priceUsd = finitePositiveOrNull(token?.priceUsd);
  const priceNative = finitePositiveOrNull(token?.priceNative);
  const pct = finitePositiveOrNull(holderPct);
  if (marketCapUsd === null || priceUsd === null || priceNative === null || pct === null) return null;
  const heldValueUsd = (pct / 100) * marketCapUsd;
  const solPerUsd = priceNative / priceUsd;
  const heldValueSol = heldValueUsd * solPerUsd;
  return Number.isFinite(heldValueSol) && heldValueSol > 0 ? heldValueSol : null;
}

// ---------------------------------------------------------------------
// Per-wallet behavior baseline (Layer A: "what does this wallet
// normally do")
// ---------------------------------------------------------------------

/**
 * @param {Array} campaigns - ONE wallet's campaigns only (already grouped)
 * @param {Record<string, object>} snapshotsByPair
 * @param {number} minSampleSize
 */
function buildWalletBehaviorBaseline(campaigns, snapshotsByPair, minSampleSize) {
  const buySizeSolValues = campaigns.map((c) => c.solAmount).filter((v) => Number.isFinite(v) && v > 0);
  const buySizeStats = computeDistributionStats(buySizeSolValues);

  const entryMcResults = campaigns.map((c) => reconstructEntryMarketCap(c, snapshotsByPair[c.pairAddress]));
  const entryMcValues = entryMcResults.filter((r) => r.available).map((r) => r.entryMcUsd);
  const entryMcStats = computeDistributionStats(entryMcValues);

  return {
    campaignCount: campaigns.length,
    eligibleForBaseline: campaigns.length >= minSampleSize,
    buySizeSol: {
      available: buySizeStats.sampleSize >= minSampleSize,
      ...buySizeStats,
    },
    entryMcUsd: {
      available: entryMcStats.sampleSize >= minSampleSize,
      status: entryMcStats.sampleSize >= minSampleSize ? 'available' : (entryMcStats.sampleSize > 0 ? 'insufficient_history' : 'entry_mc_unavailable'),
      reconstructionAttempted: campaigns.length,
      reconstructionCoverage: campaigns.length > 0 ? Number((entryMcStats.sampleSize / campaigns.length).toFixed(3)) : null,
      ...entryMcStats,
    },
  };
}

// ---------------------------------------------------------------------
// Anomaly (Layer C part 1: "how does the CURRENT trade compare with
// this wallet's OWN baseline") — entry-MC and buy-size are kept
// STRUCTURALLY INDEPENDENT throughout, per the spec: a wallet can be
// anomalous on one dimension, both, or neither, and missing one must
// never disable the other.
// ---------------------------------------------------------------------

function computeAnomalyRatio(currentValue, baselineStats, minSampleSize) {
  if (!baselineStats.available || !(baselineStats.sampleSize >= minSampleSize) || baselineStats.median === null) {
    return { available: false, status: baselineStats.sampleSize > 0 ? 'insufficient_history' : 'no_history' };
  }
  if (currentValue === null) {
    return { available: false, status: 'current_value_unavailable' };
  }
  return {
    available: true,
    status: 'available',
    currentValue,
    historicalMedian: baselineStats.median,
    historicalP25: baselineStats.p25,
    historicalP75: baselineStats.p75,
    historicalSampleSize: baselineStats.sampleSize,
    ratioToMedian: Number((currentValue / baselineStats.median).toFixed(4)),
  };
}

// ---------------------------------------------------------------------
// Wallet historical OUTCOME profile (Layer B: "what happens to the
// tokens this wallet historically enters") — a DISTINCT component from
// anomaly, never buried inside it, per the spec.
// ---------------------------------------------------------------------

/**
 * One outcome observation per campaign that has BOTH a resolved
 * (point-in-time-safe — see the store function's header) pattern_archive
 * outcome AND enough snapshot data to place it on a peak-MC scale. ROI
 * and time-to-peak are read directly from pattern_archive's own
 * `peak_roi_multiple`/`time_to_ath_from_qualification_hours` — never
 * recomputed from scratch — per the spec's explicit "don't create a
 * competing definition" instruction; only peak MC (a field that doesn't
 * exist anywhere yet) is reconstructed here.
 */
function buildOutcomeObservations(campaigns, outcomesByPair, snapshotsByPair) {
  const observations = [];
  for (const c of campaigns) {
    const outcome = outcomesByPair[c.pairAddress];
    if (!outcome) continue; // no resolved, point-in-time-safe outcome for this pair — skip, don't fabricate
    const peak = reconstructPeakMarketCap(outcome, snapshotsByPair[c.pairAddress]);
    observations.push({
      pairAddress: c.pairAddress,
      campaignSolAmount: c.solAmount,
      peakMcAvailable: peak.available,
      peakMcUsd: peak.available ? peak.peakMcUsd : null,
      roiMultiple: outcome.peakRoiMultiple,
      timeToPeakHours: outcome.timeToAthFromQualificationHours,
      outcome: outcome.outcome,
    });
  }
  return observations;
}

function summarizeOutcomeObservations(observations, minSampleSize) {
  const peakMcValues = observations.filter((o) => o.peakMcAvailable).map((o) => o.peakMcUsd);
  const roiValues = observations.map((o) => o.roiMultiple).filter((v) => Number.isFinite(v));
  const timeToPeakValues = observations.map((o) => o.timeToPeakHours).filter((v) => Number.isFinite(v));
  const peakMcStats = computeDistributionStats(peakMcValues);
  const roiStats = computeDistributionStats(roiValues);
  const timeStats = computeDistributionStats(timeToPeakValues);
  const hitRate = (bar) => (roiValues.length > 0 ? Number((roiValues.filter((v) => v >= bar).length / roiValues.length).toFixed(3)) : null);
  return {
    available: observations.length >= minSampleSize,
    status: observations.length >= minSampleSize ? 'available' : (observations.length > 0 ? 'insufficient_history' : 'no_resolved_outcomes'),
    outcomeSampleSize: observations.length,
    peakMcUsd: { available: peakMcStats.sampleSize > 0, ...peakMcStats },
    roiMultiple: { available: roiStats.sampleSize > 0, ...roiStats },
    hitRate2x: hitRate(2),
    hitRate5x: hitRate(5),
    hitRate10x: hitRate(10),
    timeToPeakHours: { available: timeStats.sampleSize > 0, ...timeStats },
  };
}

/**
 * Comparable-entry-conditioned variant of the outcome profile — only
 * counts a wallet's past campaigns whose OWN entry MC and buy size were
 * both within `bandMultiplier`x of the CURRENT token's entry MC / buy
 * size (either direction), per the spec's explicit example (a wallet's
 * one $900k/$5,000 trade shouldn't carry the same weight as several
 * $75k-$110k/$350-$500 ones when the current entry is ~$90k/$400).
 *
 * `bandMultiplier` is an explicit, configurable RESEARCH PARAMETER
 * (config.edpiLive.comparableEntryBandMultiplier) — NOT a validated
 * similarity threshold. Requires BOTH the campaign's entry MC AND the
 * current token's entry MC/buy-size estimates to be available; a
 * campaign whose own entry MC couldn't be reconstructed is excluded from
 * this conditioned view (it can still count in the UNCONDITIONAL outcome
 * profile above, which only needs an outcome, not an entry MC).
 */
function buildComparableEntryOutcomeProfile(campaigns, outcomesByPair, snapshotsByPair, currentEntryMcUsd, currentBuySizeSol, bandMultiplier, minSampleSize) {
  if (currentEntryMcUsd === null || currentBuySizeSol === null) {
    return { available: false, status: 'current_entry_data_unavailable', outcomeSampleSize: 0 };
  }
  const mcLow = currentEntryMcUsd / bandMultiplier;
  const mcHigh = currentEntryMcUsd * bandMultiplier;
  const buyLow = currentBuySizeSol / bandMultiplier;
  const buyHigh = currentBuySizeSol * bandMultiplier;
  const comparableCampaigns = campaigns.filter((c) => {
    const entryMc = reconstructEntryMarketCap(c, snapshotsByPair[c.pairAddress]);
    if (!entryMc.available) return false;
    if (entryMc.entryMcUsd < mcLow || entryMc.entryMcUsd > mcHigh) return false;
    if (c.solAmount < buyLow || c.solAmount > buyHigh) return false;
    return true;
  });
  const observations = buildOutcomeObservations(comparableCampaigns, outcomesByPair, snapshotsByPair);
  return { bandMultiplier, comparableCampaignCount: comparableCampaigns.length, ...summarizeOutcomeObservations(observations, minSampleSize) };
}

// ---------------------------------------------------------------------
// Per-wallet orchestration — one pass builds the baseline, the
// unconditional outcome profile, the comparable-entry outcome profile,
// and the anomaly ratios for a single wallet, since all four need the
// SAME grouped campaigns as their starting point.
// ---------------------------------------------------------------------

function computeWalletEdpiProfile(walletAddress, campaigns, outcomesByPair, snapshotsByPair, currentEntryMcUsd, currentBuySizeSol, config) {
  const { walletBaselineMinSampleSize, comparableEntryBandMultiplier } = config;
  const baseline = buildWalletBehaviorBaseline(campaigns, snapshotsByPair, walletBaselineMinSampleSize);
  const allObservations = buildOutcomeObservations(campaigns, outcomesByPair, snapshotsByPair);
  const outcomeProfile = summarizeOutcomeObservations(allObservations, walletBaselineMinSampleSize);
  const comparableOutcomeProfile = buildComparableEntryOutcomeProfile(
    campaigns, outcomesByPair, snapshotsByPair, currentEntryMcUsd, currentBuySizeSol, comparableEntryBandMultiplier, walletBaselineMinSampleSize,
  );
  const anomaly = {
    entryMc: computeAnomalyRatio(currentEntryMcUsd, baseline.entryMcUsd, walletBaselineMinSampleSize),
    buySizeSol: computeAnomalyRatio(currentBuySizeSol, baseline.buySizeSol, walletBaselineMinSampleSize),
  };
  return { walletAddress, baseline, anomaly, outcomeProfile, comparableOutcomeProfile };
}

// ---------------------------------------------------------------------
// Token-level aggregation across all evaluated wallets (Layer, per spec
// section 14 — "multiple wallets"). Only wallets with an ELIGIBLE
// baseline/outcome profile contribute to a given aggregate; a wallet
// with no/insufficient history is counted in `walletsEvaluated` but
// deliberately excluded from every median/rate below it — never
// silently treated as "normal" or as a zero.
// ---------------------------------------------------------------------

function aggregateAcrossWallets(perWalletProfiles) {
  const withEligibleAnomalyEntryMc = perWalletProfiles.filter((w) => w.anomaly.entryMc.available);
  const withEligibleAnomalyBuySize = perWalletProfiles.filter((w) => w.anomaly.buySizeSol.available);
  const withEligibleOutcome = perWalletProfiles.filter((w) => w.outcomeProfile.available);
  const withEligibleComparable = perWalletProfiles.filter((w) => w.comparableOutcomeProfile.available);

  const entryMcRatioStats = computeDistributionStats(withEligibleAnomalyEntryMc.map((w) => w.anomaly.entryMc.ratioToMedian));
  const buySizeRatioStats = computeDistributionStats(withEligibleAnomalyBuySize.map((w) => w.anomaly.buySizeSol.ratioToMedian));
  const outcomeRoiStats = computeDistributionStats(withEligibleOutcome.map((w) => w.outcomeProfile.roiMultiple.median).filter((v) => v !== null));
  const outcomePeakMcStats = computeDistributionStats(withEligibleOutcome.map((w) => w.outcomeProfile.peakMcUsd.median).filter((v) => v !== null));

  return {
    walletsEvaluated: perWalletProfiles.length,
    walletRelativeAnomaly: {
      walletsWithEntryMcAnomaly: withEligibleAnomalyEntryMc.length,
      walletsWithBuySizeAnomaly: withEligibleAnomalyBuySize.length,
      medianEntryMcRatio: entryMcRatioStats.median,
      // Dispersion (IQR = p75-p25) across WALLETS' own ratios — a purely
      // descriptive spread measure, not a "how many are anomalous" count
      // (that would require picking a deviation threshold, which the
      // spec explicitly says not to invent yet). Null, not 0, when fewer
      // than 2 wallets are eligible (an IQR of one point is meaningless).
      entryMcRatioDispersionIqr: entryMcRatioStats.sampleSize >= 2 ? Number((entryMcRatioStats.p75 - entryMcRatioStats.p25).toFixed(4)) : null,
      medianBuySizeRatio: buySizeRatioStats.median,
      buySizeRatioDispersionIqr: buySizeRatioStats.sampleSize >= 2 ? Number((buySizeRatioStats.p75 - buySizeRatioStats.p25).toFixed(4)) : null,
    },
    walletHistoricalOutcomeProfile: {
      walletsWithOutcomeProfile: withEligibleOutcome.length,
      medianOfWalletMedianRoiMultiple: outcomeRoiStats.median,
      roiMultipleDispersionIqr: outcomeRoiStats.sampleSize >= 2 ? Number((outcomeRoiStats.p75 - outcomeRoiStats.p25).toFixed(4)) : null,
      medianOfWalletMedianPeakMcUsd: outcomePeakMcStats.median,
    },
    comparableEntryOutcomeProfile: {
      walletsWithComparableOutcomeProfile: withEligibleComparable.length,
      medianOfWalletMedianRoiMultiple: computeDistributionStats(withEligibleComparable.map((w) => w.comparableOutcomeProfile.roiMultiple.median).filter((v) => v !== null)).median,
      medianOfWalletMedianPeakMcUsd: computeDistributionStats(withEligibleComparable.map((w) => w.comparableOutcomeProfile.peakMcUsd.median).filter((v) => v !== null)).median,
    },
  };
}

// ---------------------------------------------------------------------
// Evidence Families 1-3 (unchanged from v1 — see the v1 comments that
// used to live here, now condensed; behavior is identical)
// ---------------------------------------------------------------------

function computeHolderStructure(safety, holders) {
  if (!safety || safety.available !== true) return { available: false };
  const list = Array.isArray(holders) ? holders : [];
  const sorted = [...list].sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0));
  const sumTop = (n) => sorted.slice(0, n).reduce((acc, h) => acc + (Number(h.pct) || 0), 0);
  const insiderHolderCount = list.filter((h) => h.insider === true).length;
  return {
    available: true,
    holderCount: list.length,
    topHolderPct: finiteOrNull(safety.topHolderPct),
    top5Pct: list.length > 0 ? sumTop(5) : null,
    top10Pct: list.length > 0 ? sumTop(10) : null,
    insiderHolderCount,
    riskScore: finiteOrNull(safety.riskScore),
    liquidityLocked: safety.liquidityLocked ?? null,
    mintAuthorityHeld: safety.mintAuthorityHeld ?? null,
    freezeAuthorityHeld: safety.freezeAuthorityHeld ?? null,
    rugged: Boolean(safety.rugged),
  };
}

function computeCurrentWalletActivity(token, walletClusteringEnabled, recurringWallets, walletExposure) {
  const buys1h = finiteOrNull(token?.buys1h);
  const sells1h = finiteOrNull(token?.sells1h);
  const marketActivity = (buys1h !== null || sells1h !== null) ? {
    buys1h,
    sells1h,
    buySellRatio: buys1h !== null && sells1h !== null && sells1h > 0 ? Number((buys1h / sells1h).toFixed(3)) : null,
  } : null;
  if (!walletClusteringEnabled) {
    return { available: marketActivity !== null, marketActivity, recurringWalletCount: 0, recurringWallets: [], priorRuggedExposureCount: 0 };
  }
  const recurring = Array.isArray(recurringWallets) ? recurringWallets : [];
  return {
    available: true,
    marketActivity,
    recurringWalletCount: recurring.length,
    recurringWallets: recurring.slice(0, 25).map((w) => ({ walletOwner: w.walletOwner, tokenCount: w.tokenCount })),
    priorRuggedExposureCount: Number.isFinite(walletExposure?.exposureCount) ? walletExposure.exposureCount : 0,
  };
}

/**
 * Evidence Family 3 — CURRENT HOLDER VALUE/EXPOSURE (renamed from
 * v1's "capital commitment" per the follow-up spec: `holderPct/100 ×
 * live marketCap` estimates what a holder's position is worth RIGHT
 * NOW, not what they originally paid to acquire it — "capital
 * commitment" implied the latter and was corrected to avoid that
 * confusion. The underlying computation and field name
 * (`estimatedTop10HeldValueUsd`) are unchanged; only the surrounding
 * terminology/wording is.
 */
function computeCurrentHolderExposure(token, holders) {
  const marketCap = finiteOrNull(token?.marketCap);
  const list = Array.isArray(holders) ? holders : [];
  if (marketCap === null || list.length === 0) return { available: false };
  const sorted = [...list].sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0));
  const top10PctSum = sorted.slice(0, 10).reduce((acc, h) => acc + (Number(h.pct) || 0), 0);
  return {
    available: true,
    basis: 'holder_pct_of_supply_times_live_market_cap',
    estimatedTop10HeldValueUsd: Number(((top10PctSum / 100) * marketCap).toFixed(2)),
    marketCapUsd: marketCap,
  };
}

function computeWalletPreviousActivity(walletClusteringEnabled, walletExperience, walletHistory, holderCount) {
  if (!walletClusteringEnabled) return { available: false };
  const base = {
    available: true,
    experiencedWalletCount5Plus: Number.isFinite(walletExperience?.experiencedWalletCount5Plus) ? walletExperience.experiencedWalletCount5Plus : 0,
    experiencedWalletCount10Plus: Number.isFinite(walletExperience?.experiencedWalletCount10Plus) ? walletExperience.experiencedWalletCount10Plus : 0,
    maxWalletExperience: Number.isFinite(walletExperience?.maxWalletExperience) ? walletExperience.maxWalletExperience : 0,
  };
  if (!walletHistory) return { ...base, historicalEnrichment: { attempted: false } };
  const walletsWithAnyHistory = Number.isFinite(walletHistory.walletsWithAnyHistory) ? walletHistory.walletsWithAnyHistory : 0;
  const walletsWithMeaningfulHistory = Number.isFinite(walletHistory.walletsWithMeaningfulHistory) ? walletHistory.walletsWithMeaningfulHistory : 0;
  return {
    ...base,
    historicalEnrichment: {
      attempted: true,
      walletsEvaluated: Number.isFinite(holderCount) ? holderCount : null,
      walletsWithAnyHistory,
      walletsWithMeaningfulHistory,
      coverageRatio: Number.isFinite(holderCount) && holderCount > 0 ? Number((walletsWithAnyHistory / holderCount).toFixed(3)) : null,
      recurringHistoricalWallets: Array.isArray(walletHistory.recurringHistoricalWallets) ? walletHistory.recurringHistoricalWallets.slice(0, 25) : [],
    },
  };
}

// ---------------------------------------------------------------------
// Family 5 — wallet-relative anomaly, now real. Assembles the per-wallet
// orchestration above across every top holder that has trades to build a
// baseline from, then aggregates. A wallet with zero prior campaigns
// simply contributes nothing to any median below — it is never treated
// as "normal."
// ---------------------------------------------------------------------

function computeWalletRelativeAnomalyFamily(perWalletProfiles, aggregate) {
  if (perWalletProfiles === null) {
    // Structurally different from "zero eligible wallets": this means
    // the historical trade lookup was never attempted at all this run
    // (edpiLive.enabled false, or wallet clustering off) — see
    // computeEdpiLive's caller-facing contract.
    return { available: false, status: 'not_attempted' };
  }
  return {
    available: true,
    status: 'computed',
    perWallet: perWalletProfiles.slice(0, 25).map((w) => ({ walletAddress: w.walletAddress, entryMc: w.anomaly.entryMc, buySizeSol: w.anomaly.buySizeSol, historicalCampaignCount: w.baseline.campaignCount })),
    aggregate: aggregate.walletRelativeAnomaly,
  };
}

function computeWalletHistoricalOutcomeProfileFamily(perWalletProfiles, aggregate) {
  if (perWalletProfiles === null) return { available: false, status: 'not_attempted' };
  return {
    available: true,
    status: 'computed',
    perWallet: perWalletProfiles.slice(0, 25).map((w) => ({ walletAddress: w.walletAddress, ...w.outcomeProfile })),
    aggregate: aggregate.walletHistoricalOutcomeProfile,
  };
}

function computeComparableEntryOutcomeProfileFamily(perWalletProfiles, aggregate) {
  if (perWalletProfiles === null) return { available: false, status: 'not_attempted' };
  return {
    available: true,
    status: 'computed',
    perWallet: perWalletProfiles.slice(0, 25).map((w) => ({ walletAddress: w.walletAddress, ...w.comparableOutcomeProfile })),
    aggregate: aggregate.comparableEntryOutcomeProfile,
  };
}

function buildEvidence({ holderStructure, currentWalletActivity, currentHolderExposure, walletPreviousActivity, walletRelativeAnomaly, walletHistoricalOutcomeProfile, coverage }) {
  const lines = [];
  if (holderStructure.available) {
    lines.push(`Top holder concentration ${holderStructure.topHolderPct ?? 'unknown'}% (top10 ${holderStructure.top10Pct !== null ? holderStructure.top10Pct.toFixed(1) : 'unknown'}%), Rugcheck riskScore ${holderStructure.riskScore ?? 'unknown'}/100, ${holderStructure.insiderHolderCount} flagged insider holder(s).`);
  } else {
    lines.push('Holder structure unavailable (no Rugcheck report data).');
  }
  if (currentWalletActivity.available && currentWalletActivity.marketActivity) {
    lines.push(`Current activity: ${currentWalletActivity.marketActivity.buys1h ?? '?'} buys / ${currentWalletActivity.marketActivity.sells1h ?? '?'} sells (1h)${currentWalletActivity.recurringWalletCount ? `, ${currentWalletActivity.recurringWalletCount} top holder(s) recurring across other tokens` : ''}.`);
  }
  if (currentHolderExposure.available) {
    lines.push(`Estimated current value held by top-10 holders: ~$${currentHolderExposure.estimatedTop10HeldValueUsd.toLocaleString()} of $${currentHolderExposure.marketCapUsd.toLocaleString()} market cap (current exposure, not acquisition cost).`);
  }
  if (walletPreviousActivity.available) {
    const enrich = walletPreviousActivity.historicalEnrichment;
    if (enrich?.attempted) {
      lines.push(`Historical wallet context: ${enrich.walletsWithAnyHistory}/${enrich.walletsEvaluated ?? '?'} top holder(s) have early-wallet history on other launches (${enrich.walletsWithMeaningfulHistory} with a prior meaningful buy).`);
    } else {
      lines.push(`Wallet experience (current qualification only): ${walletPreviousActivity.experiencedWalletCount5Plus} holder(s) with 5+ prior pairs, ${walletPreviousActivity.experiencedWalletCount10Plus} with 10+.`);
    }
  } else {
    lines.push('Wallet previous activity unavailable (wallet clustering disabled).');
  }
  if (walletRelativeAnomaly.available) {
    const agg = walletRelativeAnomaly.aggregate;
    lines.push(`Wallet-relative anomaly: ${agg.walletsWithEntryMcAnomaly} wallet(s) with a usable entry-MC baseline (median ratio to own normal: ${agg.medianEntryMcRatio ?? 'n/a'}), ${agg.walletsWithBuySizeAnomaly} with a usable buy-size baseline (median ratio: ${agg.medianBuySizeRatio ?? 'n/a'}).`);
  } else {
    lines.push('Wallet-relative anomaly not computed this run.');
  }
  if (walletHistoricalOutcomeProfile.available) {
    const agg = walletHistoricalOutcomeProfile.aggregate;
    lines.push(`Wallet historical outcomes: ${agg.walletsWithOutcomeProfile} wallet(s) with a resolved-outcome track record (median of their median ROI: ${agg.medianOfWalletMedianRoiMultiple !== null ? `${agg.medianOfWalletMedianRoiMultiple.toFixed(2)}x` : 'n/a'}).`);
  }
  lines.push(`Data completeness: ${coverage.dataCompletenessScore}/${coverage.dataCompletenessOf} evidence families available. Interpretation/scoring intentionally deferred — see docs/edpi-live.md.`);
  return lines;
}

/**
 * The one public entry point. Pure, synchronous, never throws.
 *
 * @param {object} input
 * @param {object} input.token
 * @param {object} input.safety
 * @param {Array} input.holders
 * @param {boolean} input.walletClusteringEnabled
 * @param {Array} [input.recurringWallets]
 * @param {object} [input.walletExposure]
 * @param {object} [input.walletExperience]
 * @param {object|null} [input.walletHistory] - getEarlyWalletHistoryAmong result
 * @param {{trades:Array, snapshotsByPair:object, outcomesByPair:object}|null} [input.walletTradesData] - getEarlyWalletTradesWithOutcomesAmong result, or null/undefined if not attempted
 * @param {object} [input.edpiLiveConfig] - {walletBaselineMinSampleSize, campaignWindowMs, comparableEntryBandMultiplier}
 * @param {number} [input.computedAtMs]
 */
function computeEdpiLive(input = {}) {
  const {
    token, safety, holders, walletClusteringEnabled = false,
    recurringWallets, walletExposure, walletExperience, walletHistory, walletTradesData,
    edpiLiveConfig = {}, computedAtMs = Date.now(),
  } = input;

  const config = {
    walletBaselineMinSampleSize: Number.isFinite(edpiLiveConfig.walletBaselineMinSampleSize) ? edpiLiveConfig.walletBaselineMinSampleSize : 3,
    campaignWindowMs: Number.isFinite(edpiLiveConfig.campaignWindowMs) ? edpiLiveConfig.campaignWindowMs : 30 * 60 * 1000,
    comparableEntryBandMultiplier: Number.isFinite(edpiLiveConfig.comparableEntryBandMultiplier) ? edpiLiveConfig.comparableEntryBandMultiplier : 3,
  };

  const holderList = Array.isArray(holders) ? holders : [];
  const holderStructure = computeHolderStructure(safety, holderList);
  const currentWalletActivity = computeCurrentWalletActivity(token, walletClusteringEnabled, recurringWallets, walletExposure);
  const currentHolderExposure = computeCurrentHolderExposure(token, holderList);
  const walletPreviousActivity = computeWalletPreviousActivity(walletClusteringEnabled, walletExperience, walletHistory, holderList.length);

  const currentEntryMcUsd = estimateCurrentEntryMcUsd(token);

  let perWalletProfiles = null;
  let aggregate = null;
  if (walletTradesData && Array.isArray(walletTradesData.trades)) {
    const campaigns = groupTradesIntoCampaigns(walletTradesData.trades, config.campaignWindowMs);
    const campaignsByWallet = new Map();
    for (const c of campaigns) {
      if (!campaignsByWallet.has(c.walletAddress)) campaignsByWallet.set(c.walletAddress, []);
      campaignsByWallet.get(c.walletAddress).push(c);
    }
    perWalletProfiles = holderList
      .filter((h) => campaignsByWallet.has(h.owner))
      .map((h) => computeWalletEdpiProfile(
        h.owner,
        campaignsByWallet.get(h.owner),
        walletTradesData.outcomesByPair,
        walletTradesData.snapshotsByPair,
        currentEntryMcUsd,
        estimateCurrentBuySizeSol(token, h.pct),
        config,
      ));
    aggregate = aggregateAcrossWallets(perWalletProfiles);
  }

  const walletRelativeAnomaly = computeWalletRelativeAnomalyFamily(perWalletProfiles, aggregate);
  const walletHistoricalOutcomeProfile = computeWalletHistoricalOutcomeProfileFamily(perWalletProfiles, aggregate);
  const comparableEntryOutcomeProfile = computeComparableEntryOutcomeProfileFamily(perWalletProfiles, aggregate);

  const availabilityFlags = [holderStructure.available, currentWalletActivity.available, currentHolderExposure.available, walletPreviousActivity.available, walletRelativeAnomaly.available];
  const dataCompletenessScore = availabilityFlags.filter(Boolean).length;

  const coverage = {
    holderStructureAvailable: holderStructure.available,
    currentWalletActivityAvailable: currentWalletActivity.available,
    currentHolderExposureAvailable: currentHolderExposure.available,
    walletPreviousActivityAvailable: walletPreviousActivity.available,
    walletRelativeAnomalyAvailable: walletRelativeAnomaly.available,
    walletClusteringEnabled: Boolean(walletClusteringEnabled),
    holdersEvaluated: holderList.length,
    historicalLookupAttempted: walletHistory != null,
    walletTradesLookupAttempted: walletTradesData != null,
    walletsWithEligibleHistoricalBaseline: perWalletProfiles ? perWalletProfiles.filter((w) => w.baseline.eligibleForBaseline).length : 0,
    dataCompletenessScore,
    dataCompletenessOf: 5,
  };

  const components = {
    holderStructure,
    currentWalletActivity,
    currentHolderExposure,
    walletPreviousActivity,
    walletRelativeAnomaly,
    walletHistoricalOutcomeProfile,
    comparableEntryOutcomeProfile,
  };

  return {
    version: EDPI_LIVE_VERSION,
    computedAt: new Date(computedAtMs).toISOString(),
    // Deliberately null — see the module header. The FEATURES above are
    // real; the interpretation/weighting of them is what stays deferred.
    score: null,
    scoreStatus: 'not_calibrated',
    coverage,
    components,
    evidence: buildEvidence({ holderStructure, currentWalletActivity, currentHolderExposure, walletPreviousActivity, walletRelativeAnomaly, walletHistoricalOutcomeProfile, coverage }),
    deferredInterpretation: ['walletRelativeAnomalyThresholds', 'compositeScore'],
    shadowOnly: true,
  };
}

/**
 * Live hot-path integration point — see tokenScanner.js. Takes an
 * ALREADY-COMPUTED edpiLiveResult so the exact same result shown (or not
 * shown) to Gemini is what gets persisted. `null` is a clean no-op.
 */
function attachEdpiLiveResult(evidence, edpiLiveResult) {
  try {
    if (edpiLiveResult) evidence.edpiLive = edpiLiveResult;
  } catch (error) {
    console.error(`[edpiLive] attachEdpiLiveResult failed, continuing without it: ${error.message}`);
  }
  return evidence;
}

module.exports = {
  EDPI_LIVE_VERSION,
  computeEdpiLive,
  attachEdpiLiveResult,
  // Exported individually for direct unit testing (test/edpi_live.test.js)
  // of the pure math, independent of the full computeEdpiLive assembly.
  percentile,
  computeDistributionStats,
  groupTradesIntoCampaigns,
  reconstructEntryMarketCap,
  reconstructPeakMarketCap,
  estimateCurrentEntryMcUsd,
  estimateCurrentBuySizeSol,
  buildWalletBehaviorBaseline,
  buildComparableEntryOutcomeProfile,
  computeWalletEdpiProfile,
  // Added for edpiBehavioralPatterns.js's reuse — see that module's
  // header for why it calls this directly rather than re-deriving the
  // same ratio-to-median math a second time.
  computeAnomalyRatio,
};
