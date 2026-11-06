/**
 * Tier 2, Phase 5 — Feature Extraction.
 *
 * Turns a tracked token's snapshot history (tokenPatternStore.getSnapshots,
 * oldest-first) into a small set of derived, first-vs-latest metrics:
 * price momentum, top-holder-concentration trend, LP-lock trend, and
 * buy/volume acceleration. No I/O here, same reasoning as
 * patternAnalyzer.js: pure functions are trivial to unit test and reason
 * about independently of storage/network/scheduling concerns.
 *
 * Deliberately simple and transparent rather than a black box — plain
 * deltas and ratios between the first and latest snapshot, not a fitted
 * trend line or a weighted score. See scoring.js's own doc comment for
 * why that's the house style here: "tune the weights freely, they're
 * intentionally simple... rather than a black box."
 *
 * NOT wired into scoring/alerting/decisions. This only derives the
 * numbers — Phase 14 (Decision Engine) is explicitly the later, separate
 * step that would fold any of this into what the bot actually alerts on
 * or how it scores. Today's consumer is marketStateEngine.js (Phase 13),
 * which aggregates these per-token features into daily narrative-level
 * trends.
 */

// "Noticeable move" thresholds for the categorical trend labels below —
// small enough to catch a real move, large enough to not flip on noise
// between two checkpoints of an inherently volatile memecoin. Adjust
// freely; these aren't derived from any backtest, just a starting point.
const TOP_HOLDER_PCT_TREND_EPSILON = 1; // percentage points
const LP_LOCKED_PCT_TREND_EPSILON = 1; // percentage points
const BUY_SELL_RATIO_TREND_EPSILON = 0.3; // ratio units

function buySellRatio(buys, sells) {
  if (buys === null || sells === null) return null;
  return sells > 0 ? buys / sells : buys;
}

function delta(latestVal, firstVal) {
  if (latestVal === null || firstVal === null) return null;
  return latestVal - firstVal;
}

function trendLabel(deltaVal, epsilon, risingLabel, fallingLabel) {
  if (deltaVal === null) return null;
  if (deltaVal > epsilon) return risingLabel;
  if (deltaVal < -epsilon) return fallingLabel;
  return 'flat';
}

/**
 * @param {Array} snapshots - tokenPatternStore.getSnapshots(pairAddress) output, oldest-first
 * @returns {object} derived features — every numeric/label field is `null`
 *   when there isn't enough history (or the underlying data itself is
 *   null, e.g. volume/buys/sells on a snapshot row written before Tier 2
 *   added those columns) to compute it. Never throws, never fabricates a
 *   number it doesn't have real data for.
 */
function extractFeatures(snapshots) {
  const checkpointCount = Array.isArray(snapshots) ? snapshots.length : 0;
  const hasEnoughHistory = checkpointCount >= 2;

  if (checkpointCount === 0) {
    return {
      checkpointCount: 0,
      hasEnoughHistory: false,
      observedHours: null,
      priceMomentumMultiple: null,
      topHolderPctAtFirst: null,
      topHolderPctAtLatest: null,
      topHolderPctDelta: null,
      topHolderTrend: null,
      lpLockedPctAtFirst: null,
      lpLockedPctAtLatest: null,
      lpLockedPctDelta: null,
      lpLockTrend: null,
      volume1hAtFirst: null,
      volume1hAtLatest: null,
      volume1hMultiple: null,
      buys1hAtFirst: null,
      buys1hAtLatest: null,
      buys1hDelta: null,
      sells1hAtFirst: null,
      sells1hAtLatest: null,
      sells1hDelta: null,
      buySellRatioAtFirst: null,
      buySellRatioAtLatest: null,
      buyAccelerationTrend: null,
    };
  }

  const first = snapshots[0];
  const latest = snapshots[snapshots.length - 1];

  // Below this point, several fields only make sense with a genuine
  // before/after pair — a single checkpoint's "trend" against itself
  // would trivially be "flat"/1x, which is a fabricated signal, not a
  // real one. Gate on hasEnoughHistory rather than let that slip through.
  if (!hasEnoughHistory) {
    return {
      checkpointCount,
      hasEnoughHistory,
      observedHours: null,
      priceMomentumMultiple: null,
      topHolderPctAtFirst: first.topHolderPct,
      topHolderPctAtLatest: latest.topHolderPct,
      topHolderPctDelta: null,
      topHolderTrend: null,
      lpLockedPctAtFirst: first.lpLockedPct,
      lpLockedPctAtLatest: latest.lpLockedPct,
      lpLockedPctDelta: null,
      lpLockTrend: null,
      volume1hAtFirst: first.volume1h,
      volume1hAtLatest: latest.volume1h,
      volume1hMultiple: null,
      buys1hAtFirst: first.buys1h,
      buys1hAtLatest: latest.buys1h,
      buys1hDelta: null,
      sells1hAtFirst: first.sells1h,
      sells1hAtLatest: latest.sells1h,
      sells1hDelta: null,
      buySellRatioAtFirst: buySellRatio(first.buys1h, first.sells1h),
      buySellRatioAtLatest: buySellRatio(latest.buys1h, latest.sells1h),
      buyAccelerationTrend: null,
    };
  }

  // Volume/buys/sells only exist on snapshot rows written after Tier 2
  // added those columns (see schema.sql) — a token tracked across that
  // upgrade can have early rows with nulls there even though its later
  // rows have real data. Use the first and latest rows that actually HAVE
  // this data, not just snapshots[0]/snapshots[last], so a token doesn't
  // lose buy-acceleration coverage just because it happened to start
  // tracking a few checkpoints before the upgrade.
  const withVolumeData = snapshots.filter((s) => s.volume1h !== null && s.buys1h !== null && s.sells1h !== null);
  const firstVol = withVolumeData[0] ?? null;
  const latestVol = withVolumeData[withVolumeData.length - 1] ?? null;
  const hasVolumeTrend = withVolumeData.length >= 2;

  const priceMomentumMultiple = (first.priceUsd !== null && first.priceUsd > 0 && latest.priceUsd !== null)
    ? latest.priceUsd / first.priceUsd
    : null;

  const topHolderPctDelta = delta(latest.topHolderPct, first.topHolderPct);
  const lpLockedPctDelta = delta(latest.lpLockedPct, first.lpLockedPct);

  const volume1hMultiple = hasVolumeTrend && firstVol.volume1h > 0
    ? latestVol.volume1h / firstVol.volume1h
    : null;
  const buys1hDelta = hasVolumeTrend ? delta(latestVol.buys1h, firstVol.buys1h) : null;
  const sells1hDelta = hasVolumeTrend ? delta(latestVol.sells1h, firstVol.sells1h) : null;
  const buySellRatioAtFirst = hasVolumeTrend ? buySellRatio(firstVol.buys1h, firstVol.sells1h) : null;
  const buySellRatioAtLatest = hasVolumeTrend ? buySellRatio(latestVol.buys1h, latestVol.sells1h) : null;
  const buySellRatioDelta = delta(buySellRatioAtLatest, buySellRatioAtFirst);

  return {
    checkpointCount,
    hasEnoughHistory,
    observedHours: (latest.t - first.t) / 3_600_000,

    priceMomentumMultiple,

    topHolderPctAtFirst: first.topHolderPct,
    topHolderPctAtLatest: latest.topHolderPct,
    topHolderPctDelta,
    // Rising top-holder % = the largest holder is accumulating a bigger
    // share (bearish/rug-risk signal); falling = distributing (mildly
    // reassuring, though far from a safety guarantee on its own).
    topHolderTrend: trendLabel(topHolderPctDelta, TOP_HOLDER_PCT_TREND_EPSILON, 'accumulating', 'distributing'),

    lpLockedPctAtFirst: first.lpLockedPct,
    lpLockedPctAtLatest: latest.lpLockedPct,
    lpLockedPctDelta,
    // Falling LP-lock % (creator unlocking previously-locked liquidity) is
    // a genuine red flag, not just noise — flagged distinctly from a
    // rising/flat lock so this can't get lost inside a neutral "flat".
    lpLockTrend: trendLabel(lpLockedPctDelta, LP_LOCKED_PCT_TREND_EPSILON, 'locking_more', 'unlocking'),

    volume1hAtFirst: firstVol ? firstVol.volume1h : null,
    volume1hAtLatest: latestVol ? latestVol.volume1h : null,
    volume1hMultiple,

    buys1hAtFirst: firstVol ? firstVol.buys1h : null,
    buys1hAtLatest: latestVol ? latestVol.buys1h : null,
    buys1hDelta,
    sells1hAtFirst: firstVol ? firstVol.sells1h : null,
    sells1hAtLatest: latestVol ? latestVol.sells1h : null,
    sells1hDelta,

    buySellRatioAtFirst,
    buySellRatioAtLatest,
    // "Buy acceleration" as named in the roadmap: is the buy/sell ratio
    // between checkpoints rising (more buy-dominant now than earlier) or
    // falling? Uses the ratio rather than raw buys1hDelta alone, since a
    // token that's just growing overall (more buys AND more sells) isn't
    // necessarily becoming more buy-dominant — the ratio captures that
    // distinction, raw counts don't.
    buyAccelerationTrend: trendLabel(buySellRatioDelta, BUY_SELL_RATIO_TREND_EPSILON, 'accelerating', 'decelerating'),
  };
}

module.exports = {
  extractFeatures,
  // Exported so other pure-logic modules (patternAnalyzer.js's
  // classifyRugMechanism) can derive the same "meaningfully rising/
  // falling/flat" categorical trend from a first/latest pair without
  // redefining their own epsilon or comparison logic — one definition of
  // "what counts as a real move" for topHolderPct/lpLockedPct, shared by
  // both the live daily narrative stats (marketStateEngine.js, via
  // extractFeatures above) and the archived-outcome labeling.
  delta,
  trendLabel,
  TOP_HOLDER_PCT_TREND_EPSILON,
  LP_LOCKED_PCT_TREND_EPSILON,
};
