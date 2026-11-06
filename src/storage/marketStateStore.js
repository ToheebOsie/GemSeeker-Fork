const { query } = require('../db/pool');

/**
 * Postgres-backed store for market_state_daily (Tier 2, Phase 13 — see
 * schema.sql's comment on that table for the full shape/scope). Kept in
 * its own module, same reasoning as every other storage/*.js file here: a
 * bug in this store can't touch subscriber or pattern-tracking data, and
 * vice versa.
 */

function rowToState(r) {
  return {
    date: r.date,
    narrativeTag: r.narrative_tag,
    computedAt: r.computed_at,
    trackedCount: r.tracked_count,
    accumulatingPct: r.accumulating_pct,
    distributingPct: r.distributing_pct,
    buyAcceleratingPct: r.buy_accelerating_pct,
    buyDeceleratingPct: r.buy_decelerating_pct,
    archivedCount: r.archived_count,
    ruggedCount: r.rugged_count,
    survivedCount: r.survived_count,
    avgPeakRoiMultiple: r.avg_peak_roi_multiple,
    buyCount: r.buy_count,
    waitCount: r.wait_count,
    skipCount: r.skip_count,
  };
}

/**
 * Upserts one (date, narrativeTag) row — always a full overwrite of that
 * row's non-key fields, matching the "always a fresh today-so-far
 * snapshot" design (see schema.sql), not an accumulating counter.
 */
async function upsertDailyState(state) {
  await query(
    `INSERT INTO market_state_daily (
       date, narrative_tag, computed_at,
       tracked_count, accumulating_pct, distributing_pct, buy_accelerating_pct, buy_decelerating_pct,
       archived_count, rugged_count, survived_count, avg_peak_roi_multiple, buy_count, wait_count, skip_count
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (date, narrative_tag) DO UPDATE SET
       computed_at = EXCLUDED.computed_at,
       tracked_count = EXCLUDED.tracked_count,
       accumulating_pct = EXCLUDED.accumulating_pct,
       distributing_pct = EXCLUDED.distributing_pct,
       buy_accelerating_pct = EXCLUDED.buy_accelerating_pct,
       buy_decelerating_pct = EXCLUDED.buy_decelerating_pct,
       archived_count = EXCLUDED.archived_count,
       rugged_count = EXCLUDED.rugged_count,
       survived_count = EXCLUDED.survived_count,
       avg_peak_roi_multiple = EXCLUDED.avg_peak_roi_multiple,
       buy_count = EXCLUDED.buy_count,
       wait_count = EXCLUDED.wait_count,
       skip_count = EXCLUDED.skip_count`,
    [
      state.date, state.narrativeTag, state.computedAt,
      state.trackedCount, state.accumulatingPct, state.distributingPct, state.buyAcceleratingPct, state.buyDeceleratingPct,
      state.archivedCount, state.ruggedCount, state.survivedCount, state.avgPeakRoiMultiple, state.buyCount, state.waitCount, state.skipCount,
    ],
  );
}

/** All narrative rows for one UTC date ('YYYY-MM-DD') — what /insights reads. */
async function getStateForDate(date) {
  const { rows } = await query('SELECT * FROM market_state_daily WHERE date = $1 ORDER BY narrative_tag', [date]);
  return rows.map(rowToState);
}

/** Full history for one narrative, oldest first — not used by /insights yet, a future trend view. */
async function getStateForNarrative(narrativeTag) {
  const { rows } = await query('SELECT * FROM market_state_daily WHERE narrative_tag = $1 ORDER BY date ASC', [narrativeTag]);
  return rows.map(rowToState);
}

module.exports = {
  upsertDailyState,
  getStateForDate,
  getStateForNarrative,
};
