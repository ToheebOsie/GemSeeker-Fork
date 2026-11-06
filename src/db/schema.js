const fs = require('fs');
const path = require('path');
const { query } = require('./pool');

/**
 * Applies schema.sql — idempotent (every statement in it is CREATE
 * TABLE/INDEX IF NOT EXISTS), so this is safe to call on every process
 * start, not just once.
 *
 * This used to only run from scripts/migrate.js, which README.md's Setup
 * section never actually told a *fresh* install (no prior JSON data) to
 * run — so "npm install; cp .env.example .env; npm start" against a brand
 * new database would crash on the very first query, despite the README's
 * "the schema is created automatically on first run" claim just below
 * that. This is what makes that claim actually true: index.js calls this
 * before anything else touches the database.
 */
const REQUIRED_TABLES = [
  'subscribers',
  'alert_decisions',
  'outbox_events',
  'event_consumptions',
  'alert_deliveries',
  'research_jobs',
  'wallet_activity_capture_coverage',
  'wallet_activity_evidence_state',
  'notification_jobs',
  'alert_observations',
  'alert_evaluations',
  'edpi_l_evaluations',
  'edpi_l_wallet_evidence',
  'token_feature_captures',
  'wallet_feature_provider_attempts',
  'wallet_window_features',
  'wallet_window_participants',
];

async function verifyRequiredTables() {
  const { rows } = await query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES],
  );
  const found = new Set(rows.map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
  if (missing.length > 0) {
    throw new Error(`Postgres schema verification failed; missing tables: ${missing.join(', ')}`);
  }
  return { ok: true, tables: REQUIRED_TABLES.slice() };
}

async function ensureSchema() {
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  const fixedWindowSql = fs.readFileSync(path.join(__dirname, 'fixed_window_feature_schema.sql'), 'utf-8');
  await query(`${schemaSql}\n${fixedWindowSql}`);
  return verifyRequiredTables();
}

module.exports = { ensureSchema, verifyRequiredTables, REQUIRED_TABLES };
