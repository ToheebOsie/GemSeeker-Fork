const { query } = require('../db/pool');

/**
 * Postgres-backed store for the two self-assessment report timestamps.
 * Same exported API as the JSON-file version this replaces (Phase 1 of
 * the V2 roadmap). Kept in its own module, same reasoning as before — a
 * bug in report scheduling can't touch subscriber or pattern-tracking
 * data, and vice versa.
 *
 * `report_state` is a single-row table (id fixed to 1 via CHECK
 * constraint — see schema.sql). getState() already returned a plain
 * object rather than a Promise before Phase 1... except every call site
 * already `await`s it (see reportScheduler.js, telegramBot.js), so
 * genuinely making it async here is not a behavior change for any
 * existing caller.
 */

async function ensureRow() {
  await query(
    `INSERT INTO report_state (id, last_daily_report_at, last_weekly_report_at)
     VALUES (1, NULL, NULL)
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function getState() {
  await ensureRow();
  const { rows } = await query('SELECT * FROM report_state WHERE id = 1');
  const row = rows[0];
  return {
    lastDailyReportAt: row.last_daily_report_at,
    lastWeeklyReportAt: row.last_weekly_report_at,
  };
}

async function setState(patch) {
  await ensureRow();
  const { rows } = await query(
    `UPDATE report_state SET
       last_daily_report_at = COALESCE($1, last_daily_report_at),
       last_weekly_report_at = COALESCE($2, last_weekly_report_at)
     WHERE id = 1
     RETURNING *`,
    [patch.lastDailyReportAt ?? null, patch.lastWeeklyReportAt ?? null],
  );
  const row = rows[0];
  return {
    lastDailyReportAt: row.last_daily_report_at,
    lastWeeklyReportAt: row.last_weekly_report_at,
  };
}

module.exports = { getState, setState };
