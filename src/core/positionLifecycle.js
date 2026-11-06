'use strict';

/**
 * Position-lifecycle reconstruction (Layer 1 of 3 — see this file's
 * header and walletOutcomeProfile.js's for the full three-layer split,
 * which mirrors the spec's explicit "keep raw activity, position
 * reconstruction, and outcome profiling as separate, recomputable
 * layers" instruction, section 23):
 *
 *   1. THIS FILE — raw trades in, positions out. Pure trade accounting
 *      only (token quantities, SOL amounts, timestamps). No market-cap
 *      data touches this layer at all, which is deliberate: it means
 *      position boundaries (where one position ends and a buyback
 *      begins) are a fact about the wallet's own trading, fully
 *      recomputable from early_wallet_activity alone, never dependent on
 *      whether a snapshot/outcome happens to be available for the pair.
 *   2. walletOutcomeProfile.js's economics layer — attaches entry/exit/
 *      peak market cap to an already-built position, using the SAME
 *      SOL-ratio reconstruction trick edpiLive.js's
 *      reconstructEntryMarketCap already established (see that file's
 *      "UNIT NOTE"), generalized here to work on a single BUY OR SELL
 *      transaction rather than an aggregated campaign.
 *   3. walletOutcomeProfile.js's aggregation layer — wallet-level
 *      distributions (section 17) across many positions.
 *
 * A wallet may buy the same token repeatedly, partially sell, buy more,
 * and eventually exit — this must reconstruct to ONE position/
 * accumulation cycle, not one position per transaction (spec section 8).
 * "Exit" is defined at the TOKEN-QUANTITY level (spec section 9): a
 * position closes the moment cumulative tokens sold reaches
 * `majorExitFraction` (default 0.4) of cumulative tokens EVER BOUGHT
 * into that position — recomputed after every transaction, so a buy that
 * arrives between two partial sells legitimately grows the denominator
 * and can keep a position open longer than it would look from the sells
 * alone (this is what makes the running-ratio design match BOTH of the
 * spec's own worked examples — see reconstructPositions's inline
 * comments at the ratio check).
 *
 * A later buy AFTER a position's major exit starts a NEW position
 * (`isBuyback: true`) on the same pair — never merged into the position
 * that just closed (spec section 13).
 */

const DEFAULT_MAJOR_EXIT_FRACTION = 0.4;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizedSolValue(trade) {
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

/**
 * Splits ALL of a wallet's raw trades (potentially across several pairs
 * — grouped internally by pairAddress, same convention as edpiLive.js's
 * groupTradesIntoCampaigns) into position-lifecycle objects.
 *
 * @param {Array<{walletAddress:string, pairAddress:string, solAmount:number, tokenDelta:number, blockTime:number}>} trades
 *   - RAW trades, buys AND sells, from tokenPatternStore.js's
 *     getEarlyWalletTradesForPositionsAmong (NOT the buy-only,
 *     is_meaningful-filtered getEarlyWalletTradesWithOutcomesAmong —
 *     position math needs every sell, however small, to get the
 *     cumulative-reduction fraction right; see that store function's
 *     header for why it's a deliberately separate query). tokenDelta
 *     sign is the source of truth for buy (positive) vs sell (negative)
 *     — see scripts/backfill-early-wallets.js's classifyTransaction,
 *     which is what writes these rows.
 * @param {{majorExitFraction?: number}} [options]
 * @returns {Array<Position>}
 *
 * Position shape:
 * {
 *   walletAddress, pairAddress, positionIndex (0 = original, 1+ = buyback),
 *   isBuyback: boolean,
 *   status: 'completed' | 'open',   // NOT yet meaningful-floor-filtered —
 *                                    // see classifyPositionMeaningfulness
 *   buys: [{blockTime, solAmount, tokenDelta}],
 *   sells: [{blockTime, solAmount, tokenDelta}],   // tokenDelta negative
 *   totalTokensBought, totalTokensSold, totalSolBought, totalSolReceived,
 *   cumulativeSellFraction: number|null,   // as of the LAST processed txn
 *   openedAtMs, lastActivityAtMs, majorExitAtMs (null if still open),
 *   holdingDurationMs: number|null,   // majorExitAtMs - openedAtMs, completed only
 *   dataQualityNotes: string[],
 * }
 */
function reconstructPositions(trades, options = {}) {
  const majorExitFraction = Number.isFinite(options.majorExitFraction) && options.majorExitFraction > 0
    ? options.majorExitFraction
    : DEFAULT_MAJOR_EXIT_FRACTION;

  const byWalletPair = new Map();
  for (const t of trades || []) {
    if (!t || !Number.isFinite(t.blockTime) || !t.walletAddress || !t.pairAddress) continue;
    const key = `${t.walletAddress}::${t.pairAddress}`;
    if (!byWalletPair.has(key)) byWalletPair.set(key, []);
    byWalletPair.get(key).push(t);
  }

  const positions = [];
  for (const [, walletPairTrades] of byWalletPair) {
    const sorted = [...walletPairTrades].sort((a, b) => a.blockTime - b.blockTime);
    const { walletAddress, pairAddress } = sorted[0];

    let current = null;
    let positionIndex = 0;
    const orphanSells = [];

    const openNewPosition = (firstBuy) => {
      current = {
        walletAddress,
        pairAddress,
        positionIndex,
        isBuyback: positionIndex > 0,
        status: 'open',
        buys: [],
        sells: [],
        totalTokensBought: 0,
        totalTokensSold: 0,
        totalSolBought: null,
        totalSolReceived: null,
        cumulativeSellFraction: null,
        openedAtMs: firstBuy.blockTime,
        lastActivityAtMs: firstBuy.blockTime,
        majorExitAtMs: null,
        holdingDurationMs: null,
        dataQualityNotes: [],
      };
      positionIndex += 1;
    };

    for (const t of sorted) {
      const tokenDelta = Number(t.tokenDelta);
      const solAmount = normalizedSolValue(t);
      if (!Number.isFinite(tokenDelta) || tokenDelta === 0) continue;

      if (tokenDelta > 0) {
        // BUY. Opens a new position if none is currently open (either
        // the very first buy on this pair, or a buyback after a prior
        // major exit).
        if (!current) openNewPosition(t);
        current.buys.push({ blockTime: t.blockTime, solAmount, valueSol: solAmount, tokenDelta, inputAsset: t.inputAsset || null, outputAsset: t.outputAsset || null, valueUsd: t.valueUsd ?? null, valueSource: t.valueSource ?? null, confidence: t.confidence ?? null });
        current.totalTokensBought += tokenDelta;
        // AUDIT FIX (2026-09-25): previously `current.totalSolBought === null
        // || solAmount === null ? null : ...` -- ANY single non-SOL-priced
        // buy (e.g. a USDC buy, now correctly resolved rather than dropped
        // as UNKNOWN -- see transactionEconomicsResolver.js's 2026-09-25
        // fixes) permanently poisoned the WHOLE position's total to null,
        // even when every other buy in the same position had a perfectly
        // well-known SOL amount. That null then failed
        // applyTradeOnlyQualification's meaningfulFloorMet check
        // unconditionally (`null >= 0.5` is false), which both EDPI-L and
        // CTO gate essentially everything on -- so a wallet that funded a
        // real, substantial position through a mix of SOL and USDC buys had
        // that ENTIRE position invisible to both, not just its one USDC
        // leg. Sum only the known amounts instead, exactly like
        // computeCapitalWeightedEntryMc (walletOutcomeProfile.js) already
        // does for the equivalent per-buy case -- an unknown-valued trade
        // is excluded from the total, never allowed to blank it out.
        current.totalSolBought = solAmount === null ? current.totalSolBought : current.totalSolBought + solAmount;
        current.lastActivityAtMs = t.blockTime;
      } else {
        // SELL.
        const soldAmount = Math.abs(tokenDelta);
        if (!current) {
          // A sell with no open position — early_wallet_activity's
          // capture window is a narrow launch-window slice (see
          // schema.sql's header on that table), so a wallet can easily
          // have acquired tokens from a source outside what we
          // captured (a transfer, an earlier untracked buy before the
          // window started). Recorded, never silently dropped or
          // allowed to open a phantom negative position.
          orphanSells.push({ blockTime: t.blockTime, solAmount, tokenDelta });
          continue;
        }
        current.sells.push({ blockTime: t.blockTime, solAmount, valueSol: solAmount, tokenDelta, inputAsset: t.inputAsset || null, outputAsset: t.outputAsset || null, valueUsd: t.valueUsd ?? null, valueSource: t.valueSource ?? null, confidence: t.confidence ?? null });
        current.totalTokensSold += soldAmount;
        // Same fix as totalSolBought above, applied symmetrically.
        current.totalSolReceived = solAmount === null ? current.totalSolReceived : current.totalSolReceived + solAmount;
        current.lastActivityAtMs = t.blockTime;

        if (current.totalTokensSold > current.totalTokensBought) {
          // Sold more than this position's own tracked buys — same
          // "acquired from an untracked source" caveat as an orphan
          // sell above, just discovered mid-position instead of at the
          // very first transaction. The cumulative fraction below is
          // still computed (and trivially exceeds majorExitFraction),
          // so this still correctly triggers a major exit; the note is
          // purely a transparency flag for anyone reading the
          // reconstructed position later.
          current.dataQualityNotes.push('sold_more_than_tracked_buys');
        }

        // Recomputed after EVERY sell against the RUNNING totalTokensBought
        // (which a later buy can still grow) — this is what makes the
        // running-ratio design match both of the spec's own worked
        // examples: a flat "100,000 token position, three sells summing
        // to 45%" case (no interleaved buys, denominator never moves)
        // AND a "buy, buy, buy, minor sell, buy, buy, major exit" case
        // (denominator keeps growing via the later buys, so an early
        // minor sell doesn't get evaluated against a stale total).
        current.cumulativeSellFraction = current.totalTokensBought > 0
          ? current.totalTokensSold / current.totalTokensBought
          : null;

        if (current.cumulativeSellFraction !== null && current.cumulativeSellFraction >= majorExitFraction) {
          current.status = 'completed';
          current.majorExitAtMs = t.blockTime;
          current.holdingDurationMs = current.majorExitAtMs - current.openedAtMs;
          positions.push(current);
          current = null; // any FURTHER buy on this pair starts a buyback
        }
      }
    }
    if (current) positions.push(current); // still open at the end of the trade history

    if (orphanSells.length > 0 && positions.length > 0) {
      // Attach the orphan-sell count to the position each one most
      // plausibly relates to (the position open at that timestamp, if
      // any) purely as a diagnostic note — never used in any
      // qualification math above.
      for (const sell of orphanSells) {
        const containingPosition = positions.find(
          (p) => p.pairAddress === pairAddress && sell.blockTime >= p.openedAtMs && (p.majorExitAtMs === null || sell.blockTime <= p.majorExitAtMs),
        );
        const note = 'orphan_sell_no_open_position_at_time_of_sale';
        if (containingPosition) {
          if (!containingPosition.dataQualityNotes.includes(note)) containingPosition.dataQualityNotes.push(note);
        }
      }
    }
  }

  return positions;
}

/**
 * Applies the anti-farming meaningful-floor gate (spec section 16 — e.g.
 * a repeated buy-$20/sell-$20 wash pattern must never inflate completed-
 * position counts) and, for buybacks only, the 3-hour holding-period
 * condition (spec section 14, condition 1 — the entry<exit MC condition,
 * condition 3, needs market data and lives in walletOutcomeProfile.js's
 * economics layer, applied AFTER this).
 *
 * Deliberately does NOT decide final categorization by itself — a
 * position can pass every check here and still end up 'insufficient'
 * once economics are applied (e.g. a buyback whose exit MC couldn't be
 * reconstructed at all). This only narrows `status` for what THIS layer
 * can actually determine from trade data alone.
 *
 * @param {Position} position
 * @param {{minPositionSolAmount:number, buybackMinHoldingMs:number}} config
 * @returns {Position & {meaningfulFloorMet:boolean, buybackHoldingPeriodMet:boolean|null}}
 */
function applyTradeOnlyQualification(position, config) {
  const meaningfulFloorMet = position.totalSolBought >= config.minPositionSolAmount;
  let buybackHoldingPeriodMet = null;
  if (position.isBuyback) {
    buybackHoldingPeriodMet = position.status === 'completed'
      ? position.holdingDurationMs >= config.buybackMinHoldingMs
      : null; // an OPEN buyback's eventual holding period isn't known yet — not a failure, just not decidable
  }
  return { ...position, meaningfulFloorMet, buybackHoldingPeriodMet };
}

module.exports = {
  DEFAULT_MAJOR_EXIT_FRACTION,
  reconstructPositions,
  applyTradeOnlyQualification,
};