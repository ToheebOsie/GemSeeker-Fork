-- Active additive schema: fixed-window wallet/platform/timing feature contract.
--
-- It is applied by src/db/schema.js after the base schema. The collector and
-- provider adapters implement the write contract in the linked documentation.
--
-- Design principles:
--   * discovery-safe features are immutable and cutoff-bounded;
--   * follow-up features are stored separately and never silently used as
--     discovery features;
--   * Helius is the primary provider, Birdeye the first fallback, Hellomoon
--     the secondary fallback;
--   * provider failure is recorded, not converted to zero or success;
--   * raw provider payloads remain outside Postgres, referenced by hash/URI.

CREATE TABLE IF NOT EXISTS token_feature_captures (
  capture_id                         BIGSERIAL PRIMARY KEY,
  chain_id                           TEXT NOT NULL DEFAULT 'solana',
  pair_address                       TEXT NOT NULL,
  mint_address                       TEXT NOT NULL,
  alert_id                           UUID REFERENCES alert_decisions(alert_id),
  discovery_event_id                 UUID REFERENCES discovery_events(discovery_event_id),
  discovered_at_ms                   BIGINT,
  qualified_at_ms                    BIGINT,
  pair_created_at_ms                BIGINT,
  feature_cutoff_at_ms              BIGINT NOT NULL,
  capture_anchor                    TEXT NOT NULL
    CHECK (capture_anchor IN ('discovery', 'qualification')),
  discovery_source                  TEXT,
  provider_path                     TEXT,
  platform                          TEXT,
  dex_id                            TEXT,
  discovery_hour_utc                SMALLINT CHECK (discovery_hour_utc BETWEEN 0 AND 23),
  qualification_hour_utc            SMALLINT CHECK (qualification_hour_utc BETWEEN 0 AND 23),
  discovery_day_of_week_utc         SMALLINT CHECK (discovery_day_of_week_utc BETWEEN 0 AND 6),
  minutes_pair_to_discovery         NUMERIC,
  minutes_discovery_to_qualification NUMERIC,
  platform_activity_15m_count       INTEGER,
  platform_activity_30m_count       INTEGER,
  platform_activity_60m_count       INTEGER,
  platform_activity_coverage_status TEXT NOT NULL DEFAULT 'not_attempted'
    CHECK (platform_activity_coverage_status IN ('complete', 'unavailable', 'error', 'not_attempted')),
  timing_missing_fields              JSONB NOT NULL DEFAULT '[]'::jsonb,
  platform_timing_version             TEXT NOT NULL DEFAULT 'platform-timing-v1',
  tier2_score                         NUMERIC,
  tier2_raw_score                     NUMERIC,
  tier2_threshold                     NUMERIC,
  tier2_pass                          BOOLEAN,
  tier2_classification                TEXT,
  tier2_score_version                 TEXT,
  tier2_missing_fields                JSONB NOT NULL DEFAULT '[]'::jsonb,
  market_cap_usd                    NUMERIC,
  volume_1h_usd                     NUMERIC,
  liquidity_usd                     NUMERIC,
  buys_1h                           INTEGER,
  sells_1h                          INTEGER,
  price_usd                         NUMERIC,
  price_change_1h_pct               NUMERIC,
  first_top_holder_pct              NUMERIC,
  first_lp_locked_pct               NUMERIC,
  signal_label                      TEXT,
  hype_score                        NUMERIC,
  risk_level                        TEXT,
  feature_schema_version            TEXT NOT NULL DEFAULT 'fixed-window-features-v1',
  capture_status                    TEXT NOT NULL DEFAULT 'captured'
    CHECK (capture_status IN ('captured', 'partial', 'failed')),
  capture_error_code                TEXT,
  capture_error_message             TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pair_address, mint_address, feature_cutoff_at_ms, feature_schema_version),
  CHECK (feature_cutoff_at_ms > 0),
  CHECK (discovered_at_ms IS NULL OR discovered_at_ms <= feature_cutoff_at_ms),
  CHECK (qualified_at_ms IS NULL OR qualified_at_ms <= feature_cutoff_at_ms),
  CHECK (pair_created_at_ms IS NULL OR pair_created_at_ms <= feature_cutoff_at_ms),
  CHECK (minutes_pair_to_discovery IS NULL OR minutes_pair_to_discovery >= 0),
  CHECK (minutes_discovery_to_qualification IS NULL OR minutes_discovery_to_qualification >= 0)
);

CREATE INDEX IF NOT EXISTS token_feature_captures_mint_idx
  ON token_feature_captures (mint_address, feature_cutoff_at_ms DESC);
CREATE INDEX IF NOT EXISTS token_feature_captures_platform_time_idx
  ON token_feature_captures (platform, discovery_hour_utc, feature_cutoff_at_ms DESC);
CREATE INDEX IF NOT EXISTS token_feature_captures_discovery_source_idx
  ON token_feature_captures (discovery_source, provider_path, feature_cutoff_at_ms DESC);

CREATE TABLE IF NOT EXISTS wallet_feature_provider_attempts (
  attempt_id                        BIGSERIAL PRIMARY KEY,
  capture_id                        BIGINT NOT NULL REFERENCES token_feature_captures(capture_id),
  window_key                        TEXT NOT NULL,
  provider                          TEXT NOT NULL
    CHECK (provider IN ('helius', 'birdeye', 'hellomoon')),
  fallback_rank                     SMALLINT NOT NULL CHECK (fallback_rank >= 1),
  requested_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at                      TIMESTAMPTZ,
  status                            TEXT NOT NULL
    CHECK (status IN ('success', 'partial', 'rate_limited', 'timeout', 'unsupported', 'error')),
  http_status                       INTEGER,
  pages_requested                  INTEGER,
  pages_completed                  INTEGER,
  signatures_scanned               BIGINT,
  provider_cursor                  TEXT,
  coverage_start_ms                BIGINT,
  coverage_end_ms                  BIGINT,
  raw_evidence_uri                 TEXT,
  raw_evidence_sha256              TEXT,
  raw_evidence_bytes               BIGINT,
  error_code                       TEXT,
  error_message                    TEXT,
  adapter_version                  TEXT NOT NULL,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (capture_id, window_key, provider, fallback_rank),
  CHECK (completed_at IS NULL OR completed_at >= requested_at),
  CHECK (coverage_start_ms IS NULL OR coverage_end_ms IS NULL OR coverage_start_ms <= coverage_end_ms),
  CHECK (status = 'success' OR error_code IS NOT NULL OR status = 'partial')
);

CREATE INDEX IF NOT EXISTS wallet_feature_provider_attempts_lookup_idx
  ON wallet_feature_provider_attempts (capture_id, window_key, fallback_rank);
CREATE INDEX IF NOT EXISTS wallet_feature_provider_attempts_status_idx
  ON wallet_feature_provider_attempts (provider, status, completed_at DESC);

CREATE TABLE IF NOT EXISTS wallet_window_features (
  window_feature_id                  BIGSERIAL PRIMARY KEY,
  capture_id                         BIGINT NOT NULL REFERENCES token_feature_captures(capture_id),
  window_key                         TEXT NOT NULL
    CHECK (window_key IN ('pre_discovery_30m', 'pre_discovery_60m', '0_5m', '5_15m', '15_30m')),
  feature_phase                      TEXT NOT NULL
    CHECK (feature_phase IN ('discovery', 'followup')),
  anchor_at_ms                       BIGINT NOT NULL,
  window_start_ms                    BIGINT NOT NULL,
  window_end_ms                      BIGINT NOT NULL,
  feature_cutoff_at_ms               BIGINT NOT NULL,
  selected_attempt_id                BIGINT REFERENCES wallet_feature_provider_attempts(attempt_id),
  selected_provider                  TEXT
    CHECK (selected_provider IS NULL OR selected_provider IN ('helius', 'birdeye', 'hellomoon')),
  coverage_status                    TEXT NOT NULL
    CHECK (coverage_status IN ('complete', 'partial', 'unavailable', 'not_attempted', 'error')),
  eligible_for_discovery_model       BOOLEAN NOT NULL DEFAULT FALSE,
  coverage_reason                    TEXT,
  unique_buyers                      INTEGER,
  unique_sellers                     INTEGER,
  buy_transaction_count              INTEGER,
  sell_transaction_count             INTEGER,
  buy_volume_sol                     NUMERIC,
  sell_volume_sol                    NUMERIC,
  buy_volume_usd                     NUMERIC,
  sell_volume_usd                    NUMERIC,
  top1_buyer_share_pct               NUMERIC,
  top5_buyer_share_pct               NUMERIC,
  top10_buyer_share_pct              NUMERIC,
  buyer_hhi                          NUMERIC,
  median_buy_size_sol                NUMERIC,
  p90_buy_size_sol                   NUMERIC,
  holder_retention_5m_pct            NUMERIC,
  holder_retention_15m_pct           NUMERIC,
  holder_retention_30m_pct           NUMERIC,
  independent_funding_source_count   INTEGER,
  synchronized_entry_cluster_count  INTEGER,
  rapid_sellback_wallet_count        INTEGER,
  experienced_wallet_count_5x        INTEGER,
  experienced_wallet_count_10x       INTEGER,
  prior_rug_exposure_wallet_count    INTEGER,
  wallet_data_completeness_pct       NUMERIC,
  feature_values                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_fields                     JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  feature_schema_version             TEXT NOT NULL DEFAULT 'fixed-window-wallet-v1',
  UNIQUE (capture_id, window_key, feature_schema_version),
  CHECK (window_start_ms <= window_end_ms),
  CHECK (window_end_ms <= feature_cutoff_at_ms OR feature_phase = 'followup'),
  CHECK (eligible_for_discovery_model = FALSE OR feature_phase = 'discovery'),
  CHECK (eligible_for_discovery_model = FALSE OR window_end_ms <= feature_cutoff_at_ms),
  CHECK (coverage_status = 'complete' OR coverage_reason IS NOT NULL),
  CHECK (wallet_data_completeness_pct IS NULL OR wallet_data_completeness_pct BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS wallet_window_features_capture_idx
  ON wallet_window_features (capture_id, feature_phase, window_key);
CREATE INDEX IF NOT EXISTS wallet_window_features_discovery_model_idx
  ON wallet_window_features (eligible_for_discovery_model, computed_at DESC);

CREATE TABLE IF NOT EXISTS wallet_window_participants (
  participant_id                     BIGSERIAL PRIMARY KEY,
  window_feature_id                  BIGINT NOT NULL REFERENCES wallet_window_features(window_feature_id),
  wallet_address                     TEXT NOT NULL,
  wallet_hash_sha256                 TEXT NOT NULL,
  role                               TEXT NOT NULL
    CHECK (role IN ('buyer', 'seller', 'holder', 'buyer_and_seller')),
  first_seen_at_ms                   BIGINT,
  first_buy_at_ms                    BIGINT,
  first_sell_at_ms                   BIGINT,
  buy_count                          INTEGER,
  sell_count                         INTEGER,
  buy_volume_sol                     NUMERIC,
  sell_volume_sol                    NUMERIC,
  buy_volume_usd                     NUMERIC,
  sell_volume_usd                    NUMERIC,
  holder_at_window_end               BOOLEAN,
  prior_5x_token_count               INTEGER,
  prior_10x_token_count              INTEGER,
  prior_rugged_token_count           INTEGER,
  funding_source_count               INTEGER,
  funding_cluster_id                 TEXT,
  synchronized_entry_cluster_id     TEXT,
  weak_hand_flag                     BOOLEAN,
  insider_risk_flag                  BOOLEAN,
  participant_features               JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_attempt_id                  BIGINT REFERENCES wallet_feature_provider_attempts(attempt_id),
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (window_feature_id, wallet_address, role),
  CHECK (wallet_hash_sha256 <> '')
);

CREATE INDEX IF NOT EXISTS wallet_window_participants_wallet_idx
  ON wallet_window_participants (wallet_hash_sha256, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_window_participants_window_idx
  ON wallet_window_participants (window_feature_id, role);

-- Additive compatibility for databases that created the first contract revision.
ALTER TABLE wallet_window_participants
  ADD COLUMN IF NOT EXISTS buy_volume_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS sell_volume_usd NUMERIC;

ALTER TABLE token_feature_captures
  ADD COLUMN IF NOT EXISTS platform_activity_coverage_status TEXT NOT NULL DEFAULT 'not_attempted',
  ADD COLUMN IF NOT EXISTS timing_missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS platform_timing_version TEXT NOT NULL DEFAULT 'platform-timing-v1',
  ADD COLUMN IF NOT EXISTS tier2_score NUMERIC,
  ADD COLUMN IF NOT EXISTS tier2_raw_score NUMERIC,
  ADD COLUMN IF NOT EXISTS tier2_threshold NUMERIC,
  ADD COLUMN IF NOT EXISTS tier2_pass BOOLEAN,
  ADD COLUMN IF NOT EXISTS tier2_classification TEXT,
  ADD COLUMN IF NOT EXISTS tier2_score_version TEXT,
  ADD COLUMN IF NOT EXISTS tier2_missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Existing DBs: a wallet can sell before it buys inside a fixed window.
ALTER TABLE wallet_window_participants DROP CONSTRAINT IF EXISTS wallet_window_participants_check;

-- Value basis: shares/ratios use USD only when every row had USD, else token amounts (unit-free).
ALTER TABLE wallet_window_features
  ADD COLUMN IF NOT EXISTS value_basis TEXT CHECK (value_basis IS NULL OR value_basis IN ('usd', 'token_amount')),
  ADD COLUMN IF NOT EXISTS buy_token_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS sell_token_amount NUMERIC;
ALTER TABLE wallet_window_participants
  ADD COLUMN IF NOT EXISTS buy_token_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS sell_token_amount NUMERIC;

ALTER TABLE wallet_window_features
  ADD COLUMN IF NOT EXISTS usd_source TEXT,
  ADD COLUMN IF NOT EXISTS usd_price_used NUMERIC;

ALTER TABLE wallet_window_features DROP CONSTRAINT IF EXISTS wallet_window_features_usd_source_check;
