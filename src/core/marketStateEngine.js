const patternStore = require('../storage/tokenPatternStore');
const marketStateStore = require('../storage/marketStateStore');
const { extractFeatures } = require('./featureExtraction');
const { average } = require('./patternAnalyzer');
const { FALLBACK_TAG } = require('./narrativeClassifier');

/**
 * Tier 2, Phase 13 — Market State Engine.
 *
 * Aggregates per-token data into daily, per-narrative summaries, read by
 * the /insights command (marketStateFormatter.js). Two independent slices per narrative (see
 * schema.sql's comment on market_state_daily for the full reasoning):
 *
 *   - "Currently tracked" — a snapshot-in-time read of tracked_tokens
 *     right now, run through featureExtraction.js per token and rolled up
 *     into % accumulating/distributing/accelerating/decelerating.
 *   - "Archived today" — pattern_archive rows whose archived_at falls in
 *     today's UTC calendar day: rugged/survived counts, average peak ROI,
 *     BUY/WAIT/SKIP breakdown.
 *
 * SCOPE NOTE (same one selfAssessment.js/reportFormatter.js state): both
 * slices only ever cover the tracked subset (Low-risk, or any WAIT/BUY-
 * labeled token — see tokenScanner.js's shouldTrack), never every alert
 * ever sent — this project doesn't persist anything for a token that
 * qualifies for an alert but isn't enrolled into tracking.
 */

function utcDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function pct(count, total) {
  return total > 0 ? (count / total) * 100 : null;
}

/**
 * Pure aggregation for one narrative. No I/O — the caller is responsible
 * for loading and grouping tracked-token features and archive records.
 *
 * @param {Array} trackedFeatures - featureExtraction.js output, one per
 *   currently-tracked token in this narrative
 * @param {Array} archivedRecordsToday - pattern_archive records for this
 *   narrative, already filtered to today's UTC date
 */
function aggregateNarrativeState(trackedFeatures, archivedRecordsToday) {
  const withEnoughHistory = trackedFeatures.filter((f) => f.hasEnoughHistory);
  const withBuyTrend = trackedFeatures.filter((f) => f.buyAccelerationTrend !== null);

  const ruggedCount = archivedRecordsToday.filter((r) => r.outcome === 'rugged').length;
  const survivedCount = archivedRecordsToday.filter((r) => r.outcome === 'survived').length;
  const peakRois = archivedRecordsToday
    .map((r) => r.peakRoiMultiple)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));

  return {
    trackedCount: trackedFeatures.length,
    accumulatingPct: pct(withEnoughHistory.filter((f) => f.topHolderTrend === 'accumulating').length, withEnoughHistory.length),
    distributingPct: pct(withEnoughHistory.filter((f) => f.topHolderTrend === 'distributing').length, withEnoughHistory.length),
    buyAcceleratingPct: pct(withBuyTrend.filter((f) => f.buyAccelerationTrend === 'accelerating').length, withBuyTrend.length),
    buyDeceleratingPct: pct(withBuyTrend.filter((f) => f.buyAccelerationTrend === 'decelerating').length, withBuyTrend.length),

    archivedCount: archivedRecordsToday.length,
    ruggedCount,
    survivedCount,
    avgPeakRoiMultiple: average(peakRois),
    buyCount: archivedRecordsToday.filter((r) => r.signalLabel === 'BUY').length,
    waitCount: archivedRecordsToday.filter((r) => r.signalLabel === 'WAIT').length,
    skipCount: archivedRecordsToday.filter((r) => r.signalLabel === 'SKIP').length,
  };
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/**
 * Orchestrates the actual computation: pulls tracked tokens + their
 * snapshot-derived features, pulls today's archived records, groups both
 * by narrative, and upserts one market_state_daily row per narrative
 * present in either group. Returns the computed rows (for logging/tests).
 */
async function computeAndStoreMarketState(now = Date.now()) {
  const date = utcDateString(now);

  const tracked = await patternStore.getTrackedTokens();
  const trackedFeaturesByNarrative = new Map();
  for (const token of tracked) {
    const snapshots = await patternStore.getSnapshots(token.pairAddress);
    const features = extractFeatures(snapshots);
    // classifyNarrative() always returns a string in real usage (falls
    // back to FALLBACK_TAG, never null) — this coalesce is defensive
    // insurance against stray null/undefined narrative_tag rows (both
    // columns are nullable in schema.sql), not something the live
    // pipeline should ever actually hit.
    const key = token.narrativeTag || FALLBACK_TAG;
    if (!trackedFeaturesByNarrative.has(key)) trackedFeaturesByNarrative.set(key, []);
    trackedFeaturesByNarrative.get(key).push(features);
  }

  const archive = await patternStore.getArchive();
  const archivedToday = archive.filter((r) => typeof r.archivedAt === 'number' && utcDateString(r.archivedAt) === date);
  const archivedByNarrative = groupBy(archivedToday, (r) => r.narrativeTag || FALLBACK_TAG);

  const narrativeTags = new Set([...trackedFeaturesByNarrative.keys(), ...archivedByNarrative.keys()]);

  const results = [];
  for (const narrativeTag of narrativeTags) {
    const state = aggregateNarrativeState(
      trackedFeaturesByNarrative.get(narrativeTag) || [],
      archivedByNarrative.get(narrativeTag) || [],
    );
    const row = { date, narrativeTag, computedAt: now, ...state };
    await marketStateStore.upsertDailyState(row);
    results.push(row);
  }
  return results;
}

/**
 * Interval-based scheduler, same shape as startPatternReviewLoop /
 * startReportScheduler — but unlike startReportScheduler, not gated on
 * ADMIN_CHAT_IDS: this doesn't send anything to anyone, it only computes
 * and stores, so there's nobody it needs a recipient for.
 */
function startMarketStateScheduler(intervalMs, enabled = true) {
  if (!enabled) {
    console.log('[marketStateEngine] marketState.enabled is false — scheduler not started.');
    return () => {};
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await computeAndStoreMarketState();
      console.log(`[marketStateEngine] computed state for ${results.length} narrative(s).`);
    } catch (err) {
      console.error(`[marketStateEngine] compute cycle failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

module.exports = {
  aggregateNarrativeState,
  computeAndStoreMarketState,
  startMarketStateScheduler,
  utcDateString,
};
