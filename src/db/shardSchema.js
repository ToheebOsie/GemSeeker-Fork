const shardPool = require('./shardPool');

/**
 * Same early_wallet_activity DDL as src/db/schema.sql's — deliberately
 * duplicated rather than shared, because shard 0 gets its copy from
 * schema.sql's own ensureSchema() (it's the same primary DB every other
 * table lives on), and extra shards 1..N-1 are physically separate
 * databases that need their own copy of just this one table, not the
 * whole schema. If this table's shape ever changes, update BOTH this
 * file and schema.sql's CREATE TABLE — see ensureShardSchema's own
 * comment below for why a shared-constant approach was rejected.
 *
 * Keeping this as a literal copy (not e.g. reading schema.sql and
 * regex-extracting the CREATE TABLE block) is deliberate: a
 * string-surgery approach would silently break the moment schema.sql's
 * formatting changes, and this table's DDL is small and stable enough
 * that "kept in sync by hand, checked by the smoketest" is the more
 * honest tradeoff than "kept in sync by a regex neither file's author
 * is looking at."
 */
const EARLY_WALLET_ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS early_wallet_activity (
    id                BIGSERIAL PRIMARY KEY,
    pair_address      TEXT NOT NULL,
    mint_address      TEXT NOT NULL,
    wallet_address    TEXT NOT NULL,
    role              TEXT NOT NULL,
    token_delta       NUMERIC NOT NULL,
    sol_amount        NUMERIC,
    target_amount     NUMERIC,
    target_decimals   INTEGER,
    input_mint        TEXT,
    input_amount_raw  NUMERIC,
    input_amount      NUMERIC,
    input_decimals    INTEGER,
    output_mint       TEXT,
    output_amount_raw NUMERIC,
    output_amount     NUMERIC,
    output_decimals   INTEGER,
    value_usd         NUMERIC,
    value_sol         NUMERIC,
    value_source      TEXT,
    economic_confidence TEXT,
    route             JSONB,
    evidence          JSONB,
    is_meaningful     BOOLEAN NOT NULL DEFAULT FALSE,
    signature         TEXT NOT NULL,
    block_time        BIGINT,
    captured_at       BIGINT NOT NULL,
    UNIQUE (pair_address, wallet_address, signature, role)
  );
  CREATE INDEX IF NOT EXISTS idx_early_wallet_activity_pair_address ON early_wallet_activity (pair_address);
  CREATE INDEX IF NOT EXISTS idx_early_wallet_activity_wallet_address ON early_wallet_activity (wallet_address);
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS sol_amount_unit_corrected_at BIGINT;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS sol_amount_raw_lamports_backup NUMERIC;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS target_amount NUMERIC;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS target_decimals INTEGER;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS input_mint TEXT;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS input_amount_raw NUMERIC;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS input_amount NUMERIC;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS input_decimals INTEGER;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS output_mint TEXT;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS output_amount_raw NUMERIC;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS output_amount NUMERIC;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS output_decimals INTEGER;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS value_usd NUMERIC;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS value_sol NUMERIC;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS value_source TEXT;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS economic_confidence TEXT;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS route JSONB;
  ALTER TABLE early_wallet_activity ADD COLUMN IF NOT EXISTS evidence JSONB;
`;

/**
 * Creates early_wallet_activity (+ its two indexes) on every EXTRA shard
 * (index 1..N-1) — shard 0 is the primary DB and already gets this table
 * from schema.sql's ensureSchema(), so this deliberately does NOT touch
 * shard 0, to avoid two different code paths racing to create the same
 * table on the same database. Idempotent (CREATE TABLE/INDEX IF NOT
 * EXISTS), same as every other migration in this project — safe to call
 * on every startup, safe to call against a shard that already has the
 * table.
 *
 * No-op (0 shards touched) when EARLY_WALLET_SHARD_URLS is unset, same
 * as the rest of the sharding code's "unconfigured = today's behavior"
 * posture.
 */
async function ensureShardSchema() {
  const n = shardPool.shardCount();
  for (let i = 1; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose;
    // this runs once at startup, not on a hot path, and sequential
    // errors are much easier to attribute to a specific shard than
    // Promise.all's combined rejection would be.
    await shardPool.queryShard(i, EARLY_WALLET_ACTIVITY_DDL);
  }
}

module.exports = { ensureShardSchema, EARLY_WALLET_ACTIVITY_DDL };
