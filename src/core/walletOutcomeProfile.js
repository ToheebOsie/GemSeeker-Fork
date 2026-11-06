'use strict';

/**
 * Layers 2-3 of the position-lifecycle pipeline (see positionLifecycle.js's
 * header for the full three-layer split):
 *
 *   2. ECONOMICS — attaches entry MC (capital-weighted across every buy
 *      in the position), exit MC (the major-exit sell), and peak MC
 *      (gated to whether the token's ATH actually fell inside the
 *      position's holding window) to an already-reconstructed position.
 *      Reuses edpiLive.js's reconstructEntryMarketCap/
 *      reconstructPeakMarketCap directly — same SOL-ratio methodology,
 *      one definition, not re-derived here (see reconstructTransactionMarketCap's
 *      own comment for how a SELL reuses the "entry" math unmodified).
 *   3. CATEGORIZATION + AGGREGATION — classifies each position into the
 *      spec's three categories (completed meaningful / open / insufficient,
 *      section 15) and rolls up a wallet's completed_meaningful positions
 *      into the entry-behavior/historical-outcome distributions from
 *      section 17.
 *
 * Deliberately separate from positionLifecycle.js: THIS file is the one
 * that needs snapshotsByPair/outcomesByPair (market data), so it's the
 * one whose output changes as more pattern_archive rows accumulate —
 * position boundaries themselves (positionLifecycle.js) never do.
 *
 * SCORE-FREE, BY CONSTRUCTION: every function here returns MEASUREMENTS —
 * distributions, counts, ratios, and categorized position evidence — never a
 * bullish/bearish verdict or a composite score. The module is a production
 * input to edpiLScoring.js and a research/shadow input to CTO; it does not
 * itself decide qualification, risk, signal, broadcasting, or BUY/WAIT/SKIP.
 */

const { reconstructEntryMarketCap, reconstructPeakMarketCap, computeDistributionStats } = require('./edpiLive');
const { reconstructPositions, applyTradeOnlyQualification } = require('./positionLifecycle');

function finitePositiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------
// Layer 2 — economics
// ---------------------------------------------------------------------

/**
 * Reconstructs the market cap implied by ONE transaction (buy OR sell),
 * by reusing edpiLive.js's reconstructEntryMarketCap unmodified: that
 * function's SOL-ratio trick (execution price in SOL ÷ the pair's own
 * priceNative, applied to the pair's own USD market cap — see
 * edpiLive.js's "UNIT NOTE") only ever depends on solAmount and
 * |tokenDelta| being positive, never on the transaction actually being a
 * buy. A sell's `tokenDelta` is negative (see positionLifecycle.js's
 * header) and its own `reason: 'not_a_net_buy'` check would reject it
 * unmodified — Math.abs() here is the only adaptation needed, not a
 * parallel implementation of the ratio math itself.
 *
 * @param {{solAmount:number, tokenDelta:number}} trade
 * @param {object|undefined} snapshot
 * @returns {{available:boolean, marketCapUsd:number|null, reason:string|null}}
 */
function reconstructTransactionMarketCap(trade, snapshot) {
  const valueSol = Object.prototype.hasOwnProperty.call(trade || {}, 'valueSol') ? trade.valueSol : trade.solAmount;
  const result = reconstructEntryMarketCap({ solAmount: valueSol, valueSol, tokenDelta: Math.abs(trade.tokenDelta) }, snapshot);
  return { available: result.available, marketCapUsd: result.entryMcUsd, reason: result.reason };
}

/**
 * Capital-weighted average entry MC across every buy in a position (spec
 * section 11's explicit formula — Σ(buy_value × buy_MC) / Σ(buy_value)).
 * SOL amount stands in for "buy_value" throughout this codebase (no
 * historical SOL/USD rate is ever captured — see edpiLive.js's UNIT
 * NOTE); this is the same substitution edpiLive.js's own buy-size
 * baseline already makes, not a new approximation introduced here.
 *
 * A buy whose OWN market cap can't be reconstructed (missing snapshot
 * field, unconfirmed mint authority) is simply excluded from the
 * weighted average — never fabricated — and `coverage` reports exactly
 * how many of the position's buys that was, per spec section 11's
 * explicit "do not fabricate market cap if it cannot be reliably
 * reconstructed."
 *
 * @param {Array<{solAmount:number, tokenDelta:number}>} buys
 * @param {object|undefined} snapshot
 * @returns {{available:boolean, entryMcUsd:number|null, coverage:{attempted:number, resolved:number}, reason:string|null}}
 */
function computeCapitalWeightedEntryMc(buys, snapshot) {
  const list = Array.isArray(buys) ? buys : [];
  if (list.length === 0) return { available: false, entryMcUsd: null, coverage: { attempted: 0, resolved: 0 }, reason: 'no_buys' };

  let weightedSum = 0;
  let weightTotal = 0;
  let resolved = 0;
  for (const buy of list) {
    const result = reconstructTransactionMarketCap(buy, snapshot);
    if (result.available) {
      const valueSol = Object.prototype.hasOwnProperty.call(buy || {}, 'valueSol') ? buy.valueSol : buy.solAmount;
      if (!(Number(valueSol) > 0)) continue;
      weightedSum += Number(valueSol) * result.marketCapUsd;
      weightTotal += Number(valueSol);
      resolved += 1;
    }
  }
  if (resolved === 0 || weightTotal <= 0) {
    return { available: false, entryMcUsd: null, coverage: { attempted: list.length, resolved: 0 }, reason: 'no_buy_resolved_a_market_cap' };
  }
  return {
    available: true,
    entryMcUsd: weightedSum / weightTotal,
    coverage: { attempted: list.length, resolved },
    reason: null,
  };
}

/**
 * Exit MC — reconstructed from the single sell transaction that actually
 * crossed the major-exit threshold (positionLifecycle.js guarantees this
 * is the LAST entry in `position.sells` for a completed position: the
 * position is pushed to the output array in the same step that detects
 * the threshold crossing).
 */
function computeExitMc(position, snapshot) {
  if (position.status !== 'completed' || position.sells.length === 0) {
    return { available: false, marketCapUsd: null, reason: 'position_not_completed' };
  }
  const exitTrade = position.sells[position.sells.length - 1];
  return reconstructTransactionMarketCap(exitTrade, snapshot);
}

/**
 * Peak MC "while held" — reuses edpiLive.js's reconstructPeakMarketCap
 * for the raw number (the token's OVERALL historical ATH — this
 * codebase has no intra-position price series, only that one point), but
 * only reports it as available when the ATH actually falls inside this
 * position's own holding window. An ATH that happened AFTER this
 * wallet's major exit is real, but it isn't something this wallet's
 * position could have captured — reporting it anyway would overstate
 * what this specific position "peaked at while held" (spec section 17's
 * own framing). An OPEN position's window is still ongoing, so its far
 * end is `nowMs` rather than a majorExitAtMs that doesn't exist yet.
 */
function computePeakMcWhileHeld(position, outcome, snapshot, nowMs = Date.now()) {
  const raw = reconstructPeakMarketCap(outcome, snapshot);
  if (!raw.available) return { available: false, peakMcUsd: null, reason: raw.reason };
  const athAtMs = finitePositiveOrNull(outcome?.athAtMs);
  if (athAtMs === null) return { available: false, peakMcUsd: null, reason: 'missing_ath_timestamp' };
  const windowEndMs = position.status === 'completed' ? position.majorExitAtMs : nowMs;
  if (athAtMs < position.openedAtMs || athAtMs > windowEndMs) {
    return { available: false, peakMcUsd: null, reason: 'ath_occurred_outside_holding_window' };
  }
  return { available: true, peakMcUsd: raw.peakMcUsd, athAtMs, reason: null };
}

/**
 * Assembles every economics figure for one position and, for buybacks
 * ONLY, evaluates spec section 14's condition 3 (buyback entry MC must
 * be lower than its own exit MC) — conditions 1 (3-hour hold) and 2
 * (major exit reached) are already trade-data-only and were evaluated in
 * positionLifecycle.js's applyTradeOnlyQualification.
 *
 * @param {Position} position - already run through applyTradeOnlyQualification
 * @param {object|undefined} snapshot - this pair's point-in-time-safe snapshot
 * @param {object|undefined} outcome - this pair's point-in-time-safe outcome
 * @param {number} [nowMs]
 */
function evaluatePositionEconomics(position, snapshot, outcome, nowMs = Date.now()) {
  const entryMc = computeCapitalWeightedEntryMc(position.buys, snapshot);
  const exitMc = position.status === 'completed' ? computeExitMc(position, snapshot) : { available: false, marketCapUsd: null, reason: 'position_open' };
  const peakMc = computePeakMcWhileHeld(position, outcome, snapshot, nowMs);

  let buybackExitAboveEntry = null;
  if (position.isBuyback && position.status === 'completed') {
    buybackExitAboveEntry = (entryMc.available && exitMc.available)
      ? exitMc.marketCapUsd > entryMc.entryMcUsd
      : null; // not decidable — data unavailable, not "failed"
  }

  return { entryMc, exitMc, peakMc, buybackExitAboveEntry };
}

// ---------------------------------------------------------------------
// Layer 3 — categorization (spec section 15) + wallet-level aggregation
// (spec section 17)
// ---------------------------------------------------------------------

/**
 * @param {Position & {meaningfulFloorMet:boolean, buybackHoldingPeriodMet:boolean|null}} position
 * @param {{entryMc, exitMc, peakMc, buybackExitAboveEntry}} economics
 * @returns {{category:'completed_meaningful'|'open'|'insufficient', reason:string|null}}
 */
function classifyPosition(position, economics) {
  if (!position.meaningfulFloorMet) {
    return { category: 'insufficient', reason: 'below_meaningful_floor' };
  }
  if (position.status === 'open') {
    return { category: 'open', reason: null };
  }
  // status === 'completed' from here on.
  if (position.isBuyback) {
    if (position.buybackHoldingPeriodMet !== true) {
      return { category: 'insufficient', reason: 'buyback_holding_period_not_met' };
    }
    if (economics.buybackExitAboveEntry === null) {
      return { category: 'insufficient', reason: 'buyback_entry_or_exit_mc_unavailable' };
    }
    if (economics.buybackExitAboveEntry === false) {
      return { category: 'insufficient', reason: 'buyback_exit_mc_not_above_entry_mc' };
    }
    return { category: 'completed_meaningful', reason: null };
  }
  return { category: 'completed_meaningful', reason: null };
}

/**
 * One-position, end-to-end: reconstruct-qualify-evaluate-classify. The
 * building block buildPositionHistoricalOutcomeProfile and the demo/
 * report script both call this per position rather than duplicating the
 * four-step sequence.
 */
function processPosition(position, snapshot, outcome, config, nowMs = Date.now()) {
  const qualified = applyTradeOnlyQualification(position, config);
  const economics = evaluatePositionEconomics(qualified, snapshot, outcome, nowMs);
  const { category, reason } = classifyPosition(qualified, economics);
  return { position: qualified, economics, category, categoryReason: reason };
}

/**
 * Reconstructs every position for ONE wallet's trades (already filtered
 * to that wallet by the caller — see buildMultiWalletOutcomeProfiles) and
 * processes each one through economics + categorization.
 *
 * @param {Array} walletTrades
 * @param {Record<string,object>} snapshotsByPair
 * @param {Record<string,object>} outcomesByPair
 * @param {{majorExitFraction:number, minPositionSolAmount:number, buybackMinHoldingMs:number}} config
 */
function buildWalletProcessedPositions(walletTrades, snapshotsByPair, outcomesByPair, config, nowMs = Date.now()) {
  const positions = reconstructPositions(walletTrades, { majorExitFraction: config.majorExitFraction });
  return positions.map((p) => processPosition(p, snapshotsByPair[p.pairAddress], outcomesByPair[p.pairAddress], config, nowMs));
}

/**
 * Spec section 17 — wallet-level entry-behavior + historical-outcome
 * distributions, built ONLY from `completed_meaningful` positions (open
 * and insufficient positions never contribute a data point here, per
 * section 15B/C's explicit instruction). Reuses edpiLive.js's
 * computeDistributionStats (median/p25/p75/p90) rather than a second
 * implementation.
 *
 * @param {Array<{position, economics, category}>} processedPositions - ONE wallet's, from buildWalletProcessedPositions
 */
function buildWalletHistoricalOutcomeProfile(processedPositions) {
  const completed = (processedPositions || []).filter((p) => p.category === 'completed_meaningful');

  const entryMcValues = completed.filter((p) => p.economics.entryMc.available).map((p) => p.economics.entryMc.entryMcUsd);
  const committedCapitalValues = completed.map((p) => p.position.totalSolBought);
  const peakMcValues = completed.filter((p) => p.economics.peakMc.available).map((p) => p.economics.peakMc.peakMcUsd);
  const holdingDurationValues = completed.map((p) => p.position.holdingDurationMs).filter((v) => Number.isFinite(v));

  const multiples = completed
    .filter((p) => p.economics.entryMc.available && p.economics.peakMc.available && p.economics.entryMc.entryMcUsd > 0)
    .map((p) => p.economics.peakMc.peakMcUsd / p.economics.entryMc.entryMcUsd);

  const hitRate = (bar) => (multiples.length > 0 ? Number((multiples.filter((m) => m >= bar).length / multiples.length).toFixed(3)) : null);

  return {
    available: completed.length > 0,
    completedPositionCount: completed.length,
    totalPositionCount: (processedPositions || []).length,
    openPositionCount: (processedPositions || []).filter((p) => p.category === 'open').length,
    insufficientPositionCount: (processedPositions || []).filter((p) => p.category === 'insufficient').length,
    entryBehavior: {
      entryMcUsd: { available: entryMcValues.length > 0, coverage: `${entryMcValues.length}/${completed.length}`, ...computeDistributionStats(entryMcValues) },
      committedCapitalSol: { available: committedCapitalValues.length > 0, ...computeDistributionStats(committedCapitalValues) },
    },
    historicalOutcomes: {
      peakMcUsd: { available: peakMcValues.length > 0, coverage: `${peakMcValues.length}/${completed.length}`, ...computeDistributionStats(peakMcValues) },
      peakMcMultiple: { available: multiples.length > 0, coverage: `${multiples.length}/${completed.length}`, ...computeDistributionStats(multiples) },
      hitRate2x: hitRate(2),
      hitRate5x: hitRate(5),
      hitRate10x: hitRate(10),
      holdingDurationMs: { available: holdingDurationValues.length > 0, ...computeDistributionStats(holdingDurationValues) },
    },
  };
}

/**
 * Spec section 20 — multi-wallet EDPI, still score-free: builds one
 * historical-outcome profile per candidate wallet (typically the Top-20,
 * post-infrastructure-exclusion population from edpiWalletSelection.js)
 * and reports coverage across the group. Deliberately returns
 * MEASUREMENTS only — "how many wallets have X," never a verdict.
 *
 * @param {Array<{owner:string}>} candidateWallets - edpiWalletSelection.js's .candidates
 * @param {{trades, snapshotsByPair, outcomesByPair}} tradesData - tokenPatternStore.js's getEarlyWalletTradesForPositionsAmong output
 * @param {{majorExitFraction:number, minPositionSolAmount:number, buybackMinHoldingMs:number}} config
 */
function buildMultiWalletOutcomeProfiles(candidateWallets, tradesData, config, nowMs = Date.now()) {
  const tradesByWallet = new Map();
  for (const t of tradesData?.trades || []) {
    if (!tradesByWallet.has(t.walletAddress)) tradesByWallet.set(t.walletAddress, []);
    tradesByWallet.get(t.walletAddress).push(t);
  }

  const perWallet = (candidateWallets || []).map((w) => {
    const walletTrades = tradesByWallet.get(w.owner) || [];
    const processedPositions = walletTrades.length > 0
      ? buildWalletProcessedPositions(walletTrades, tradesData.snapshotsByPair, tradesData.outcomesByPair, config, nowMs)
      : [];
    const profile = buildWalletHistoricalOutcomeProfile(processedPositions);
    return { walletAddress: w.owner, holderPct: w.pct, processedPositions, profile };
  });

  const withProfile = perWallet.filter((w) => w.profile.available);
  return {
    walletsEvaluated: perWallet.length,
    walletsWithCompletedMeaningfulPositions: withProfile.length,
    perWallet,
  };
}

module.exports = {
  reconstructTransactionMarketCap,
  computeCapitalWeightedEntryMc,
  computeExitMc,
  computePeakMcWhileHeld,
  evaluatePositionEconomics,
  classifyPosition,
  processPosition,
  buildWalletProcessedPositions,
  buildWalletHistoricalOutcomeProfile,
  buildMultiWalletOutcomeProfiles,
};
