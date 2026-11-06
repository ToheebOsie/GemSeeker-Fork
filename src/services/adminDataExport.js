'use strict';

const { query } = require('../db/pool');

const EXPORTS = [
  ['alert_decisions', 'created_at', 'created_at'],
  ['alert_observations', 'created_at', 'created_at'],
  ['alert_evaluations', 'computed_at', 'computed_at'],
  ['alert_deliveries', 'broadcast_requested_at', 'broadcast_requested_at'],
  ['notification_jobs', 'created_at', 'created_at'],
  ['research_jobs', 'available_at', 'available_at'],
  ['outbox_events', 'occurred_at', 'occurred_at'],
  ['tracked_tokens', 'qualified_at', 'to_timestamp(qualified_at / 1000.0)'],
  ['pattern_archive', 'archived_at', 'to_timestamp(archived_at / 1000.0)'],
  ['snapshots', 't', 'to_timestamp(t / 1000.0)'],
];

function windowFor(period, now = new Date()) {
  const end = new Date(now);
  const start = new Date(end.getTime() - (period === 'weekly' ? 7 : 1) * 86_400_000);
  return { period, start, end };
}

async function buildAdminExport(period, now = new Date()) {
  if (!['daily', 'weekly'].includes(period)) throw new Error(`Unsupported export period: ${period}`);
  const window = windowFor(period, now);
  const lines = [{ type: 'manifest', schema: 'gemseeker-admin-export-v1', period, generated_at: now.toISOString(), start: window.start.toISOString(), end: window.end.toISOString() }];
  for (const [table, timestampColumn, timestampExpression] of EXPORTS) {
    // Table and column names are fixed constants above; values remain parameters.
    const result = await query(
      `SELECT row_to_json(export_row) AS row FROM (SELECT * FROM ${table} WHERE ${timestampExpression} >= $1 AND ${timestampExpression} < $2 ORDER BY ${timestampExpression} ASC) export_row`,
      [window.start.toISOString(), window.end.toISOString()],
    );
    for (const record of result.rows) lines.push({ type: table, row: record.row });
  }
  return { ...window, filename: `gemseeker-${period}-${window.start.toISOString().slice(0, 10)}-to-${window.end.toISOString().slice(0, 10)}.ndjson`, content: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, counts: lines.slice(1).reduce((acc, line) => { acc[line.type] = (acc[line.type] || 0) + 1; return acc; }, {}) };
}

module.exports = { buildAdminExport, windowFor };
