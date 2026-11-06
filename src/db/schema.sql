-- Gem Seeker — Postgres schema (single source of truth)
--
-- Phase 1 (subscribers, tracked_tokens, pattern_archive, report_state,
-- migration_state) was a behavior-preserving swap from JSON files to
-- Postgres, deliberately mirroring the old JSON shapes rather than a
-- normalized end-state. Phase 2 (this revision) normalizes one piece of
-- that: `tracked_tokens.checkpoints`, which used to be a JSONB blob
-- rewritten wholesale on every 3-hourly review, is now the append-only
-- `snapshots` table below — see its own comment for why. Everything else
-- from Phase 1 is unchanged.
--
-- Idempotent: safe to run against an already-migrated database.

CREATE TABLE IF NOT EXISTS subscribers (
  chat_id                  BIGINT PRIMARY KEY,
  username                 TEXT,
  alerts_sent              INTEGER NOT NULL DEFAULT 0,
  subscription_expires_at  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The Solana wallet address that this chat's first verified payment came
  -- from. Once set, every subsequent /verify for this chat must come from
  -- the same wallet (see solanaService.js / telegramBot.js) — this is what
  -- closes the "anyone who sees a valid payment signature can paste it into
  -- /verify and claim someone else's subscription" gap: an attacker would
  -- need to also know (or correctly guess) the paying wallet's address, and
  -- for any chat that's already paid once, they'd need to match a wallet
  -- they don't control. NULL until a chat's first successful verification.
  verified_sender_wallet   TEXT
);

-- Upgrading an existing database: CREATE TABLE IF NOT EXISTS above is a
-- no-op if subscribers already exists. Idempotent either way.
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS verified_sender_wallet TEXT;

CREATE TABLE IF NOT EXISTS used_tx_signatures (
  signature     TEXT PRIMARY KEY,
  reserved_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Persistent backstop for tokenScanner.js's in-memory `alertedPairs` Set.
-- The in-memory Set alone resets on every process restart (deploy, crash,
-- PM2 restart) — a token already alerted right before a restart could get
-- re-evaluated and re-alerted on the next cycle if it still passes every
-- filter. This table is consulted alongside the in-memory Set, not
-- instead of it (see tokenScanner.js's runScanCycle) — the in-memory Set
-- stays the fast path for same-cycle/same-process duplicates, this is
-- what survives a restart. One row per pair, ever — see
-- tokenPatternStore.js's getAlertedPairs/recordAlertedPair.
CREATE TABLE IF NOT EXISTS alerted_pairs (
  pair_address   TEXT PRIMARY KEY,
  alerted_at     BIGINT NOT NULL  -- epoch ms
);

-- Active pattern-tracking (mirrors tracked_tokens.json, minus checkpoints —
-- see `snapshots` below).
CREATE TABLE IF NOT EXISTS tracked_tokens (
  pair_address                  TEXT PRIMARY KEY,
  mint_address                  TEXT NOT NULL,
  base_token                    JSONB NOT NULL,      -- { address, name, symbol }
  narrative_tag                 TEXT,
  hype_score_at_qualification   NUMERIC,
  risk_level_at_qualification   TEXT,
  signal_label                  TEXT,
  qualified_at                  BIGINT NOT NULL,      -- epoch ms, matches Date.now() used throughout
  -- The pool's REAL on-chain creation time (DexScreener's pairCreatedAt),
  -- as opposed to qualified_at above (when GEM SEEKER itself discovered
  -- and qualified the token — always later, sometimes by a lot). Needed
  -- for anything that reconstructs "early buyer" behavior: measured
  -- directly against production data (_diagnostic_early_wallet_reconstruction.js),
  -- qualified_at can trail true pool creation by tens of thousands of
  -- minutes on a token that's still actively trading well after
  -- qualification. NULL for rows enrolled before this column existed, and
  -- also NULL on the rare pair DexScreener didn't supply pairCreatedAt
  -- for. Deliberately NOT the same as the local `createdAt` variable
  -- tokenScanner.js's normalizePair uses for its own ageMinutes filter
  -- (that one falls back to Date.now() when pairCreatedAt is missing, so
  -- the live age-gate keeps working) — this column stores the raw value
  -- or nothing, never a Date.now() stand-in wearing a "real" timestamp's
  -- column name.
  pair_created_at                BIGINT,
  -- Bookkeeping for backfill-pair-created-at.js ONLY — never read or
  -- written by the live application, so deliberately not wired into
  -- rowToTrackedToken/enrollToken/updateTrackedToken like the domain
  -- fields around it. NULL means "never attempted." Non-NULL means the
  -- backfill tried (via DexScreener and, unless --skip-onchain, the
  -- on-chain fallback) and either resolved pair_created_at above or
  -- couldn't. Exists because pair_created_at staying NULL is ambiguous
  -- on its own between "haven't tried yet" and "tried and failed" — the
  -- backfill's default eligibility query needs to tell those apart, or a
  -- failed row (or a whole failed batch, e.g. from a misconfigured
  -- DexScreener call) gets pulled back into every subsequent run's
  -- --limit forever instead of the run making forward progress into
  -- never-attempted rows.
  pair_created_at_checked_at     BIGINT,
  first_price_usd                NUMERIC,
  ath_price_usd                  NUMERIC,
  ath_at                          BIGINT,
  last_price_usd                  NUMERIC,
  last_checked_at                  BIGINT,
  first_top_holder_pct              NUMERIC,
  first_lp_locked_pct                NUMERIC,
  -- Item 5 (AI-training-pipeline proposal audit, HANDOFF.md): captured
  -- once at enrollment (tokenScanner.js), same pattern as
  -- first_top_holder_pct/first_lp_locked_pct just above — never
  -- overwritten. NULL means genuinely unknown (Rugcheck was unavailable
  -- at enrollment), not "revoked" — see rugcheckService.js's
  -- extractSafetySignals for why this is a real 3rd state here even
  -- though the underlying boolean itself never needs an "unknown" value
  -- when the report IS available.
  first_mint_authority_held          BOOLEAN,
  first_freeze_authority_held        BOOLEAN,
  -- The most recent time price/athPriceUsd dropped below
  -- patternTracking.survivedThreshold.minPctOfAth, updated every review
  -- cycle. NULL means "never observed below threshold" — either a genuinely
  -- unbroken run since qualified_at, or (for a token enrolled before this
  -- column existed) an unknown pre-backfill history; see
  -- scripts/backfill-survival-watermark.js, which seeds this from
  -- available snapshot history for tokens tracked before this shipped.
  last_below_survival_threshold_at   BIGINT
);

-- Upgrading from Phase 1: CREATE TABLE IF NOT EXISTS above is a no-op on
-- an already-existing tracked_tokens table, so it won't remove the old
-- checkpoints JSONB column on its own. DROP COLUMN IF EXISTS is
-- idempotent — a no-op on a fresh install where the column was never
-- created in the first place.
ALTER TABLE tracked_tokens DROP COLUMN IF EXISTS checkpoints;

-- Upgrading an existing tracked_tokens table for the sustained-ATH
-- "survived" path: CREATE TABLE IF NOT EXISTS above is a no-op if the table
-- already exists, so this column needs adding explicitly. NULL default is
-- correct for brand-new rows going forward (nothing observed below
-- threshold yet); rows that already existed before this shipped should be
-- seeded via scripts/backfill-survival-watermark.js rather than left at the
-- default, since a blind NULL there would over-credit them with a run all
-- the way back to qualified_at they may not actually have earned.
ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS last_below_survival_threshold_at BIGINT;

-- Item 5 (AI-training-pipeline proposal audit): CREATE TABLE IF NOT
-- EXISTS above is a no-op on an already-existing tracked_tokens table,
-- so these need adding explicitly for an upgrade. See the CREATE TABLE
-- block above for the full "why."
ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS first_mint_authority_held BOOLEAN;
ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS first_freeze_authority_held BOOLEAN;

-- Early-life review cadence: reviewAllTrackedTokens() needs to know, per
-- token, when it was last actually reviewed (not just how many times —
-- checkpoint_count on the eventual archive row is a count, not a
-- timestamp) so it can review young tokens on a faster cadence
-- (patternTracking.earlyLifeReviewIntervalMs) without also re-reviewing
-- every older token on that same faster tick, which would defeat the
-- point (same total Rugcheck/DexScreener load on the old-token
-- population as the un-tiered cadence had). NULL means "never reviewed
-- yet" — a token in that state is always due, on its very next tick,
-- regardless of age; see reviewAllTrackedTokens' dueForReview filter.
ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS last_reviewed_at BIGINT;

-- Plan A (signal_status) — disambiguates a NULL signal_label. Only two
-- code paths ever produce one (gemini_signal_generator.js): the AI call
-- itself never returned real output (network/API error, or an empty
-- response) vs. it DID return real model output, but extractSignalLabel
-- found no parseable BUY/WAIT/SKIP anywhere in it. Those have different
-- implications — an infra problem vs. a prompt/formatting problem — that
-- collapsing them both into "signal_label IS NULL" couldn't distinguish.
-- Values: 'SIGNALLED' | 'AI_UNAVAILABLE' | 'AI_NO_VERDICT'. NULL for rows
-- from before this shipped — see scripts/backfill-signal-status.js,
-- which can only tell 'SIGNALLED' apart from "one of the other two, we
-- don't know which" (the raw AI response text that would disambiguate
-- AI_UNAVAILABLE from AI_NO_VERDICT was never persisted for these rows).
ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS signal_status TEXT;

-- Plan B (narrative confidence): narrativeClassifier.js's rule-based
-- match is binary (a keyword either hits or it doesn't), so it's always
-- confidence 1.0 / matchedVia 'rule' when it succeeds — set at the
-- tokenScanner.js call site, not computed here. descriptionClassifier.js's
-- fallback DOES have a real similarity score (Jaccard for a description
-- match, trigram for the no-description name-similarity path) that used
-- to be computed and discarded; now surfaced via classifyByDescription's
-- own `confidence` field and threaded through unchanged.
-- narrative_match_method: 'rule' | 'description' | 'name-similarity'.
-- Both NULL for a token that stayed genuinely 'uncategorized' — neither
-- classifier found anything, so there's nothing to report a confidence
-- IN; leaving both null here is a deliberate choice, not an oversight
-- (see tokenScanner.js's comment at the call site for the full "why").
-- Both also NULL for rows from before this shipped — see
-- scripts/backfill-narrative-confidence.js, which can retroactively
-- recover the 'rule' case exactly (the tag itself proves which
-- classifier produced it) but not which of Jaccard-vs-trigram produced
-- an existing 'desc:*' tag, or at what score.
ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS narrative_confidence NUMERIC;
ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS narrative_match_method TEXT;

-- See the CREATE TABLE column comment above for what this is and why it's
-- separate from qualified_at. Upgrading-from-before-this-existed case,
-- same idempotent-ALTER reasoning as every other column added this way
-- above.
ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS pair_created_at BIGINT;
ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS pair_created_at_checked_at BIGINT;

-- Phase 2: every patternReviewer.js review cycle appends a row here rather
-- than overwriting an in-place JSONB array (which is what this project did
-- through Phase 1 — checkpoints lived as a blob column on tracked_tokens,
-- read/trimmed/rewritten wholesale on every review).
--
-- FORENSIC PRESERVATION FIX: this table used to cascade-delete a token's
-- entire snapshot history the instant it archived (ON DELETE CASCADE
-- against tracked_tokens), on the theory that pattern_archive's summary
-- fields (checkpointCount, first/last topHolderPct/lpLockedPct) were all
-- a completed token needed. In practice that summary collapses an entire
-- lifecycle down to two endpoints — it can say LP lock went from 80% to
-- 20% but not when, how fast, or in how many steps, which is exactly the
-- shape of evidence real rug-mechanism forensics needs (see the
-- historical-recovery proposal this fix responds to). Every rug this bot
-- has ever archived destroyed that detail on the way in; this stops that
-- from happening to every FUTURE one. Past archived tokens are not
-- recoverable — see backfill-survival-watermark.js's own comment on that.
--
-- No longer FK'd to tracked_tokens at all (dropped below for upgrading
-- databases) — same reasoning schema.sql already documents for
-- token_holders: this needs to deliberately outlive the tracked_tokens
-- row it started under, so a hard FK to a table that row gets DELETEd
-- from is the wrong relationship. pair_address alone still joins it back
-- to its pattern_archive row for any archived token, no join table
-- needed. The maxCheckpointsPerToken cap (src/config.js) still bounds
-- each token's row count exactly as before — that cap is what makes
-- keeping this data forever cheap (currently 80 rows/token, worst case),
-- not a reason to keep deleting it.
CREATE TABLE IF NOT EXISTS snapshots (
  id               BIGSERIAL PRIMARY KEY,
  pair_address     TEXT NOT NULL,
  t                BIGINT NOT NULL,     -- epoch ms
  price_usd        NUMERIC,
  top_holder_pct   NUMERIC,
  lp_locked_pct    NUMERIC,
  -- Tier 2 (Feature Extraction): volume/buys/sells at this checkpoint —
  -- DexScreener already returns these on every patternReviewer.js review
  -- call (same shape tokenScanner.js's normalizePair reads), they just
  -- weren't being persisted. Without them, "buy acceleration" between
  -- checkpoints isn't derivable at all — price/holder/LP trend alone was
  -- enough for rug-detection (Tier 1's actual job), but not for this.
  -- NULL for any snapshot row written before this column existed.
  volume_1h        NUMERIC,
  buys_1h          INTEGER,
  sells_1h         INTEGER,
  -- Item 5 (AI-training-pipeline proposal audit, HANDOFF.md): captured
  -- every review cycle from the SAME Rugcheck call patternReviewer.js
  -- already makes for top_holder_pct/lp_locked_pct above — costs zero
  -- extra API calls. Unlike those two, this is expected to be highly
  -- redundant checkpoint-to-checkpoint in practice (SPL authority
  -- revocation is a one-way, permanent on-chain action — held can become
  -- revoked, revoked can never become held again), but tracked per-
  -- checkpoint anyway rather than only at enrollment, so a token whose
  -- FIRST reading failed (Rugcheck unavailable right at qualification)
  -- can still pick up a real value from a later cycle — see
  -- getLastKnownSafetyReading's use of this, same "each field's own last
  -- non-null value independently" approach it already uses for
  -- top_holder_pct/lp_locked_pct.
  mint_authority_held    BOOLEAN,
  freeze_authority_held  BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pair_address ON snapshots (pair_address, t);

-- Upgrading an existing database: CREATE TABLE IF NOT EXISTS above doesn't
-- touch a constraint on an already-existing table, so the old
-- ON DELETE CASCADE FK to tracked_tokens needs dropping explicitly. Postgres
-- auto-named this constraint snapshots_pair_address_fkey (no CREATE TABLE
-- constraint name was ever given, so it can't have drifted). Idempotent —
-- a no-op once already dropped.
ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS snapshots_pair_address_fkey;

-- Upgrading from before Tier 2's Feature Extraction: CREATE TABLE IF NOT
-- EXISTS above is a no-op on an already-existing snapshots table, so these
-- three columns need adding explicitly. Idempotent either way — see the
-- identical pattern for pattern_archive's Phase 8 columns below.
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS volume_1h NUMERIC;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS buys_1h INTEGER;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS sells_1h INTEGER;

-- Item 5 (AI-training-pipeline proposal audit): see the CREATE TABLE
-- block above for the full "why."
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS mint_authority_held BOOLEAN;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS freeze_authority_held BOOLEAN;

-- Permanent historical archive (mirrors pattern_archive.json). Append-only
-- by design already — nothing ever deletes from it.
CREATE TABLE IF NOT EXISTS pattern_archive (
  id                                      BIGSERIAL PRIMARY KEY,
  pair_address                            TEXT NOT NULL,
  mint_address                            TEXT,
  symbol                                  TEXT,
  name                                    TEXT,
  narrative_tag                           TEXT,
  hype_score_at_qualification             NUMERIC,
  risk_level_at_qualification             TEXT,
  signal_label                            TEXT,
  category_key                            TEXT,
  qualified_at                            BIGINT,
  -- Carried through unchanged from tracked_tokens at archiving time
  -- (patternReviewer.js's buildArchiveRecord) — see that column's comment
  -- on tracked_tokens above for what it is. NULL for every row archived
  -- before this existed, and for rows enrolled when DexScreener didn't
  -- supply a pairCreatedAt.
  pair_created_at                         BIGINT,
  -- NOT carried through from tracked_tokens (unlike pair_created_at
  -- itself) — deliberately decoupled from buildArchiveRecord, see the
  -- tracked_tokens column comment above for what this is. A tracked
  -- token that was checked-but-unresolved and later archives will get
  -- one bounded extra backfill attempt as an archive row before this
  -- gets set again; not worth the coupling to avoid that.
  pair_created_at_checked_at              BIGINT,
  first_price_usd                         NUMERIC,
  ath_price_usd                           NUMERIC,
  ath_at                                  BIGINT,
  final_price_usd                         NUMERIC,
  peak_roi_multiple                       NUMERIC,
  outcome                                 TEXT NOT NULL,   -- 'rugged' | 'survived' today; Phase 8 widens this
  archived_at                             BIGINT NOT NULL,
  time_to_rug_from_qualification_hours    NUMERIC,
  time_to_rug_from_ath_hours              NUMERIC,
  checkpoint_count                        INTEGER,
  first_top_holder_pct                    NUMERIC,
  last_top_holder_pct                     NUMERIC,
  first_lp_locked_pct                     NUMERIC,
  last_lp_locked_pct                      NUMERIC,
  -- Item 5 (AI-training-pipeline proposal audit): same first/last
  -- pattern as the top-holder/LP columns just above, captured the same
  -- way (first at enrollment, last from getLastKnownSafetyReading's
  -- own-last-non-null-value-per-field approach). See tracked_tokens'
  -- and snapshots' own comments on these same two concepts above for the
  -- full "why."
  first_mint_authority_held               BOOLEAN,
  last_mint_authority_held                BOOLEAN,
  first_freeze_authority_held             BOOLEAN,
  last_freeze_authority_held              BOOLEAN,
  -- Phase 8: derived once at archive time from the fields above — see
  -- patternAnalyzer.js's deriveOutcomeEnrichment. Additive alongside
  -- `outcome`, not a replacement for it.
  outcome_detail                          TEXT,
  peak_roi_bucket                         TEXT,
  time_to_ath_from_qualification_hours    NUMERIC,
  -- Phase 9: WHY a 'rugged' token rugged (LP unlocked, top holder
  -- distributed, neither, or no safety data to tell) — also derived once
  -- at archive time by deriveOutcomeEnrichment. NULL for 'survived'
  -- records; additive alongside outcome_detail, not a replacement.
  rug_mechanism                           TEXT,
  -- Item 29 (early-wallet backfill, Stage 1) — same checked_at/status
  -- pattern as pair_created_at_checked_at above, deliberately duplicated
  -- rather than reused: this is a DIFFERENT attempt (on-chain buyer/seller
  -- reconstruction within the launch window, not just the pool's birth
  -- time) with its own independent eligibility. NULL means Stage 1 hasn't
  -- attempted this row yet. early_wallet_status distinguishes what
  -- happened when it did: 'complete' (the launch window's signature walk
  -- reached pair_created_at AND every in-window tx was parsed),
  -- 'complete-tx-capped' (window fully covered by the walk, but more
  -- in-window transactions existed than --max-tx-parse, so only the
  -- earliest N were actually parsed for buyer/seller data — the window
  -- boundary is trustworthy, the buyer LIST is a lower bound), 'truncated'
  -- (the walk hit --sig-cap before reaching pair_created_at — see
  -- backfill-pair-created-at.js's identical "don't guess a truncated
  -- earliest" reasoning; whatever rows exist in early_wallet_activity for
  -- this pair are a lower bound, never treat as exhaustive), 'no-
  -- signatures' (pair_address has no on-chain signature history at all),
  -- or 'error' (an unexpected RPC failure — checked anyway so a single
  -- flaky call doesn't retry-storm every future run; see
  -- scripts/backfill-early-wallets.js's --retry-unresolved flag to
  -- deliberately revisit 'truncated'/'error' rows).
  early_wallet_checked_at                 BIGINT,
  early_wallet_status                     TEXT,
  -- Stage 1's own stated deliverable is "production Stage 1 data + a
  -- cost/quality report" (see the wallet-intelligence roadmap in
  -- HANDOFF.md) — "measure actual RPC/signature consumption" can't be
  -- reconstructed after the fact from a separate reporting run unless
  -- the walk's own page count is persisted here at write time. NULL
  -- alongside early_wallet_checked_at IS NULL (never attempted); 0 is a
  -- legitimate value (e.g. a 'no-signatures' row never had to walk a
  -- page). See scripts/review-early-wallet-backfill.js, the read-only
  -- report that consumes this.
  early_wallet_sig_pages_walked           INTEGER
);

-- patternAnalyzer.js's predictForCategory groups the archive by
-- categoryKey on every scan-loop qualification (every ~30s) — index it.
CREATE INDEX IF NOT EXISTS idx_pattern_archive_category_key ON pattern_archive (category_key);
CREATE INDEX IF NOT EXISTS idx_pattern_archive_archived_at ON pattern_archive (archived_at);

-- Durable historical backfill execution and page-level checkpoints. A
-- checkpoint is scoped by run and policy version so a changed extraction
-- policy never resumes from an incompatible cursor.
CREATE TABLE IF NOT EXISTS backfill_runs (
  run_id UUID PRIMARY KEY,
  operation TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'stopped', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_completed INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  pages_fetched BIGINT NOT NULL DEFAULT 0,
  requests_used BIGINT NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS backfill_checkpoints (
  run_id UUID NOT NULL REFERENCES backfill_runs(run_id),
  archive_id BIGINT NOT NULL REFERENCES pattern_archive(id),
  policy_version TEXT NOT NULL,
  cursor_signature TEXT,
  pages_walked INTEGER NOT NULL DEFAULT 0,
  signatures_scanned INTEGER NOT NULL DEFAULT 0,
  entries_written INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'truncated', 'retryable_error', 'permanent_error')),
  last_page_observed_at TIMESTAMPTZ,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, archive_id)
);

CREATE INDEX IF NOT EXISTS backfill_checkpoints_retry_idx
  ON backfill_checkpoints (status, updated_at);

CREATE TABLE IF NOT EXISTS backfill_signature_pages (
  run_id UUID NOT NULL REFERENCES backfill_runs(run_id),
  archive_id BIGINT NOT NULL REFERENCES pattern_archive(id),
  policy_version TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  before_signature TEXT,
  after_signature TEXT,
  signatures JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, archive_id, page_number)
);

CREATE INDEX IF NOT EXISTS backfill_signature_pages_archive_idx
  ON backfill_signature_pages (run_id, archive_id, page_number);

-- narrativeIntelligence.js's findSimilarHistoricalTokens groups the archive
-- by narrativeTag alone (broader than categoryKey's narrative+hype-bucket
-- pairing — it needs every historical hype score in the narrative to score
-- closeness against), also on every scan-loop qualification — index it too,
-- same reasoning as idx_pattern_archive_category_key above.
CREATE INDEX IF NOT EXISTS idx_pattern_archive_narrative_tag ON pattern_archive (narrative_tag);

-- Upgrading from before Phase 8: CREATE TABLE IF NOT EXISTS above is a
-- no-op on an already-existing pattern_archive table, so these three
-- columns need adding explicitly. Idempotent either way.
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS outcome_detail TEXT;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS peak_roi_bucket TEXT;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS time_to_ath_from_qualification_hours NUMERIC;

-- Upgrading from before Phase 9: same reasoning as the Phase 8 columns
-- above — CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so
-- this needs adding explicitly. Idempotent either way.
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS rug_mechanism TEXT;

-- Plan A (signal_status) — same column, same values, same reasoning as
-- tracked_tokens.signal_status above; carried through to the archive
-- record unchanged at archiving time (patternReviewer.js's
-- buildArchiveRecord), not recomputed.
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS signal_status TEXT;

-- Plan B (rug mechanism confidence + evidence) — surfaces
-- patternAnalyzer.js's classifyRugMechanismDetail alongside the
-- unchanged rug_mechanism column: rug_mechanism_confidence is 'HIGH' |
-- 'MEDIUM' | 'NONE' | NULL (see classifyRugMechanismDetail's own doc
-- comment for exactly what each tier means), rug_mechanism_evidence is
-- the raw {lpLockedPctDelta, topHolderPctDelta, checkpointCount} that
-- decided the label, as JSONB. Both NULL for a 'survived' record (the
-- question doesn't apply) and for rows from before this shipped — see
-- scripts/backfill-rug-mechanism-confidence.js, which can fully
-- recompute both for every existing 'rugged' row from data already
-- stored (no new data needed, unlike the narrative columns below).
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS rug_mechanism_confidence TEXT;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS rug_mechanism_evidence JSONB;

-- See the CREATE TABLE column comment above — same idempotent-ALTER
-- reasoning as every other column added this way above.
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS pair_created_at BIGINT;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS pair_created_at_checked_at BIGINT;

-- Plan B (narrative confidence) — same column pair, same values, same
-- reasoning as tracked_tokens.narrative_confidence/narrative_match_method
-- above; carried through unchanged at archiving time
-- (patternReviewer.js's buildArchiveRecord), not recomputed.
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS narrative_confidence NUMERIC;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS narrative_match_method TEXT;

-- Item 5 (AI-training-pipeline proposal audit) — same reasoning as every
-- other upgrade-path ALTER in this file: CREATE TABLE IF NOT EXISTS is a
-- no-op on an already-existing table. NULL for every row archived before
-- this shipped, same as rug_mechanism_confidence/evidence above — no
-- backfill is possible for these specifically (unlike
-- rug_mechanism_confidence, which could be recomputed from data already
-- stored, mint/freeze authority was simply never fetched at all for a
-- historical row, so there's nothing on disk to recompute it FROM).
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS first_mint_authority_held BOOLEAN;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS last_mint_authority_held BOOLEAN;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS first_freeze_authority_held BOOLEAN;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS last_freeze_authority_held BOOLEAN;

-- Historical narrative recovery (scripts/backfill-recover-description.js +
-- backfill-narrative-gemini.js). Two-stage, deliberately separated because
-- one stage is free and one costs real money:
--
--   Stage 1 recovers on-chain description text via Helius DAS for rows
--   whose original description was never captured (see
--   backfill-description-narrative.js's own header for why it wasn't —
--   this is the same historical gap, a different recovery path).
--   recovered_description distinguishes NULL (Stage 1 hasn't attempted
--   this row yet) from '' (attempted, genuinely nothing came back —
--   Helius asset-not-found and empty-description both collapse to this,
--   since neither leaves anything to classify from; never re-attempted
--   once either value is set, so Stage 1 is naturally resumable).
--
--   Stage 2 classifies the recovered text against the existing
--   NARRATIVE_RULES taxonomy (narrativeClassifier.js) via Gemini, but
--   only spends a call on rows that pass a boilerplate filter first
--   (descriptionBoilerplateFilter.js) — a meaningful fraction of
--   recovered text turned out to be launchpad-tool credit lines
--   ("Deployed using X", "Launched on discord.gg/Y") with zero narrative
--   content, confirmed against a real production sample, not assumed.
--   narrative_match_method gains two values here: 'recovered-boilerplate'
--   (Stage 2 looked, filtered it out, never called Gemini — this row is
--   done, not pending) and 'gemini-semantic' (an actual model
--   classification). narrative_evidence is JSONB — the model's
--   subcategory/evidence-string/suggested-new-narrative output, same
--   "keep the evidence, not just the label" reasoning as
--   rug_mechanism_evidence above, plus the exact recovered_description
--   text that produced it (reproducibility: if the taxonomy or prompt
--   changes later, what was actually classified is still on hand,
--   not just the verdict).
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS recovered_description TEXT;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS narrative_evidence JSONB;

-- See the CREATE TABLE column comment above — same idempotent-ALTER
-- reasoning as every other column added this way above.
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS early_wallet_checked_at BIGINT;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS early_wallet_status TEXT;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS early_wallet_sig_pages_walked INTEGER;
ALTER TABLE pattern_archive ADD COLUMN IF NOT EXISTS rug_event_evidence JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS pool_flow_validation_runs (
  run_id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'dry-run')),
  tokens_scanned INTEGER NOT NULL DEFAULT 0,
  transactions_scanned INTEGER NOT NULL DEFAULT 0,
  events_detected INTEGER NOT NULL DEFAULT 0,
  rpc_requests INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS pool_flow_validation_events (
  event_id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES pool_flow_validation_runs(run_id),
  pair_address TEXT NOT NULL,
  mint_address TEXT NOT NULL,
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  slot BIGINT,
  block_time TIMESTAMPTZ,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (signature, event_index)
);
CREATE INDEX IF NOT EXISTS pool_flow_validation_events_mint_idx ON pool_flow_validation_events (mint_address, block_time);
CREATE INDEX IF NOT EXISTS pool_flow_validation_runs_started_idx ON pool_flow_validation_runs (started_at DESC);

-- Item 29 (early-wallet backfill, Stage 1) — one row per (token, wallet,
-- signature, role) discovered inside a token's narrow launch window
-- (pair_created_at through pair_created_at + --window-minutes; see
-- scripts/backfill-early-wallets.js). Deliberately NOT scoped to
-- pattern_archive with a foreign key or ON DELETE CASCADE — same
-- reasoning as token_holders just below: the whole point is answering
-- "does this wallet keep showing up as an early buyer/funder across
-- MULTIPLE launches" later (Stage 3), which a cascade-delete would
-- quietly undermine, and this table is meant to deliberately outlive
-- whatever happens to its parent archive row.
--
-- role is derivable from the sign of token_delta but stored explicitly
-- (same "don't make callers re-derive it" reasoning as elsewhere in this
-- schema) — 'buyer' | 'seller'. sol_amount is the compatibility SOL-value
-- representation of the row's economic trade value (authoritative value_sol
-- when available), not necessarily the wallet's native-SOL balance delta;
-- NULL means economic value could not be established, never 0-as-unknown. is_meaningful is sol_amount >=
-- --min-sol AT CAPTURE TIME (applies to BOTH roles as of the second
-- version of this rule — a >= --min-sol sell counts too, not just a
-- buy), stored rather than recomputed on every read since the SOL floor
-- is a Stage 1 pilot parameter, not a fixed on-chain fact — re-running
-- with a different --min-sol on the same rows would otherwise silently
-- change what "meaningful" means for already-archived history. THIS
-- ACTUALLY HAPPENED ONCE: the rule changed from "buyer only, >= 0.05
-- SOL" to "either role, >= 0.5 SOL" after Stage 1's first real
-- production data came back — see scripts/recompute-early-wallet-
-- meaningful.js, the one-time migration that recomputed is_meaningful
-- for every row already written under the old rule so the column means
-- the same thing across the whole table, not just going forward.
-- block_time is epoch ms, from the same signature metadata the
-- pair_created_at backfill already trusts.
CREATE TABLE IF NOT EXISTS early_wallet_activity (
  id                BIGSERIAL PRIMARY KEY,
  pair_address      TEXT NOT NULL,
  mint_address      TEXT NOT NULL,
  wallet_address    TEXT NOT NULL,
  role              TEXT NOT NULL,          -- 'buyer' | 'seller'
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
  captured_at       BIGINT NOT NULL,        -- epoch ms this backfill run wrote the row
  UNIQUE (pair_address, wallet_address, signature, role)
);

-- Reverse lookups this table exists to support: "who were this token's
-- early wallets" (pair_address) now, and "which launches has this wallet
-- shown up as an early buyer/seller on" (wallet_address) for Stage 2/3
-- clustering later — same two-index pattern as token_holders below.
CREATE INDEX IF NOT EXISTS idx_early_wallet_activity_pair_address ON early_wallet_activity (pair_address);
CREATE INDEX IF NOT EXISTS idx_early_wallet_activity_wallet_address ON early_wallet_activity (wallet_address);

-- Audit trail for scripts/correct-early-wallet-sol-amount-units.js: NULL
-- means this row's sol_amount has never been through that migration
-- (still whatever classifyTransaction originally wrote — raw lamports,
-- for every row written before the fix). Set to the epoch-ms time of
-- correction on the one and only row that migration ever divides by
-- 1e9 — this is the idempotency guard: the migration's WHERE clause
-- excludes any row where this is already non-NULL, so re-running it
-- (or running it against a shard it already touched) can never divide
-- a row twice, regardless of what magnitude the value has since taken
-- on. sol_amount_raw_lamports_backup holds the exact pre-correction
-- value (dividing a NUMERIC by 1e9 is an exact decimal-point shift, no
-- precision loss either direction, so this is fully reversible) —
-- belt-and-suspenders alongside the timestamp so "what was this row
-- before" never depends on redoing the arithmetic by hand. See
-- spl-economic-reconstruction project notes for the full lamports-vs-SOL
-- writer-path audit these columns exist to support.
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


-- AUDIT ADD (Tier 1 wallet clustering) — one row per (qualifying token,
-- top-holder wallet) captured from the same Rugcheck /report response
-- getTokenReport already fetches for the safety gate at qualification
-- time (see tokenScanner.js), so this costs zero additional API calls.
-- Deliberately NOT scoped to pattern-tracked tokens only (no FK to
-- tracked_tokens/pattern_archive, no ON DELETE CASCADE) — this persists
-- for every token that passes the market/safety filters, tracked or not,
-- and deliberately outlives archiving, since the whole point is spotting
-- a wallet_owner that shows up as a top holder across MULTIPLE tokens
-- over time, which a cascade-delete on archive would quietly undermine.
-- wallet_owner is the actual owning wallet (Rugcheck's `owner` field on
-- each topHolders entry), not the SPL associated token account
-- (`address`) — see rugcheckService.js's extractSafetySignals for why
-- that distinction matters for clustering to find anything at all.
-- Pool/AMM entries are filtered out before this table is ever written to,
-- so every row here is a genuine wallet, not DEX-pool noise.
CREATE TABLE IF NOT EXISTS token_holders (
  id             BIGSERIAL PRIMARY KEY,
  pair_address   TEXT NOT NULL,
  mint_address   TEXT NOT NULL,
  wallet_owner   TEXT NOT NULL,
  pct            NUMERIC NOT NULL,
  insider        BOOLEAN,          -- Rugcheck's own per-holder insider flag, when present; NULL if the field wasn't in the response
  captured_at    BIGINT NOT NULL,  -- epoch ms of the MOST RECENT scan that observed this (pair, wallet) pair — overwritten on every rescan (see recordTokenHolders' ON CONFLICT), so this is a "last confirmed" timestamp, not a stable "first seen" one
  UNIQUE (pair_address, wallet_owner)
);

-- Added alongside captured_at, not replacing it: captured_at above answers
-- "was this wallet CURRENTLY (as of its last scan) a top holder of this
-- pair" — correct for reconstructing a token's OWN holder snapshot
-- (tokenPatternStore.js's getWalletOwnersAtQualification), which only
-- cares about the latest state. first_captured_at answers a DIFFERENT
-- question — "was this wallet EVER first observed holding this pair
-- before some cutoff" — needed for cross-pair prior-experience
-- comparisons (getWalletExperienceAmong's wallet-enhanced flip shadow
-- model features), where using the upserted, mutable captured_at instead
-- silently under-counts: a wallet's genuine early association with pair A
-- disappears from that comparison the moment pair A gets rescanned again
-- later, even though the wallet's actual first association with A never
-- moved. Confirmed by direct reproduction, not just reasoned about.
-- Set once at INSERT time and never touched again by the ON CONFLICT
-- clause (see recordTokenHolders) — backfilled from the existing
-- captured_at values below for any rows written before this column
-- existed, which is the best available approximation for that historical
-- data (their true first-seen instant, if earlier, was never recorded).
ALTER TABLE token_holders ADD COLUMN IF NOT EXISTS first_captured_at BIGINT;
UPDATE token_holders SET first_captured_at = captured_at WHERE first_captured_at IS NULL;

-- The whole point of this table is "which wallets keep showing up as a top
-- holder across different launches" — index the column the clustering
-- query groups by, plus pair_address for the reverse "who were this
-- token's top holders" lookup.
CREATE INDEX IF NOT EXISTS idx_token_holders_wallet_owner ON token_holders (wallet_owner);
CREATE INDEX IF NOT EXISTS idx_token_holders_pair_address ON token_holders (pair_address);

-- Single-row table: when the daily/weekly self-assessment reports last went out.
CREATE TABLE IF NOT EXISTS report_state (
  id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_daily_report_at    BIGINT,
  last_weekly_report_at   BIGINT
);

-- Tier 2, Phase 13 — Market State Engine. One row per (date, narrative)
-- pair, upserted repeatedly through the day as marketStateEngine.js's
-- scheduler ticks (idempotent by design — always a fresh "today so far"
-- snapshot, not an append-only log, so a missed tick just means a
-- slightly stale row until the next one runs). Read two ways: /insights
-- (today's row per narrative, via getStateForDate) and /insightshistory
-- (one narrative's full history over time, via getStateForNarrative).
--
-- Two independent slices per narrative, deliberately not merged into one
-- confidence score (see featureExtraction.js's doc comment on staying
-- transparent rather than a black box):
--   - "currently tracked" fields: a snapshot-in-time read of tracked_tokens
--     right now, aggregated via featureExtraction.js's per-token trends.
--   - "archived today" fields: pattern_archive rows whose archived_at
--     falls in this UTC calendar day — a completed-outcome slice.
-- Scope note (same one selfAssessment.js/reportFormatter.js state
-- explicitly): both slices only ever cover the tracked subset (Low-risk,
-- or any WAIT/BUY-labeled token — see tokenScanner.js's shouldTrack), not
-- every alert ever sent.
CREATE TABLE IF NOT EXISTS market_state_daily (
  id                      BIGSERIAL PRIMARY KEY,
  date                    DATE NOT NULL,
  narrative_tag           TEXT NOT NULL,
  computed_at             BIGINT NOT NULL,

  -- "Currently tracked" slice (snapshot-in-time, not date-scoped)
  tracked_count           INTEGER NOT NULL,
  accumulating_pct        NUMERIC,  -- % of tracked-with-enough-history whose top-holder % is rising
  distributing_pct        NUMERIC,
  buy_accelerating_pct    NUMERIC,  -- % whose buy/sell ratio is rising checkpoint-over-checkpoint
  buy_decelerating_pct    NUMERIC,

  -- "Archived today" slice (UTC calendar day named by the `date` column)
  archived_count          INTEGER NOT NULL,
  rugged_count            INTEGER NOT NULL,
  survived_count          INTEGER NOT NULL,
  avg_peak_roi_multiple   NUMERIC,
  buy_count               INTEGER NOT NULL,
  wait_count              INTEGER NOT NULL,
  skip_count              INTEGER NOT NULL,

  UNIQUE (date, narrative_tag)
);
CREATE INDEX IF NOT EXISTS idx_market_state_daily_date ON market_state_daily (date);

-- Registry of description-derived narrative categories — the fallback
-- classifier in src/core/descriptionClassifier.js for tokens that don't
-- match any hand-curated rule in narrativeClassifier.js's NARRATIVE_RULES.
-- One row per distinct cluster of similar token descriptions (or, absent a
-- description, similar token names) discovered so far. Grows slowly and
-- stays small in practice — realistically dozens to low hundreds of
-- distinct thematic clusters, not one row per token — since new tokens
-- join an EXISTING row (token_count += 1) whenever their keywords/name
-- clear the similarity threshold against one, rather than always minting
-- a new row. See descriptionClassifier.js's doc comment for the full
-- matching algorithm.
CREATE TABLE IF NOT EXISTS description_categories (
  category_key          TEXT PRIMARY KEY,       -- e.g. 'desc:ai-agent-companion'
  keywords               TEXT[] NOT NULL,        -- significant keywords this category represents
  sample_description     TEXT,                   -- the description that originated this category (audit/debug only)
  sample_token_name      TEXT NOT NULL,           -- representative name/symbol text, used for the no-description name-similarity fallback
  token_count             INTEGER NOT NULL DEFAULT 1,
  first_seen_at           BIGINT NOT NULL
);

-- Bookkeeping for the one-off JSON->Postgres migration (scripts/migrate.js).
-- Not read by the live app — purely a record of what ran and when, so a
-- second accidental run of the migration script is caught rather than
-- silently double-inserting.
CREATE TABLE IF NOT EXISTS migration_state (
  id                          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  migrated_at                 TIMESTAMPTZ,
  source                      TEXT,
  subscriber_count            INTEGER,
  used_tx_signature_count     INTEGER,
  tracked_token_count         INTEGER,
  archive_record_count        INTEGER
);


-- Phase 3: immutable alert lineage and PostgreSQL outbox.
-- These tables are append-oriented and intentionally separate analytical
-- decisions from Telegram delivery and later research outcomes.

CREATE TABLE IF NOT EXISTS alert_decisions (
  alert_id                    UUID PRIMARY KEY,
  chain_id                    TEXT NOT NULL DEFAULT 'solana',
  pair_address                TEXT NOT NULL,
  mint_address                TEXT NOT NULL,
  dex_id                      TEXT,
  quote_token_address         TEXT,
  candidate_seen_at           TIMESTAMPTZ,
  qualified_at                TIMESTAMPTZ NOT NULL,
  observation_started_at      TIMESTAMPTZ,
  observation_graduated_at    TIMESTAMPTZ,
  qualification_status        TEXT NOT NULL,
  signal_label                TEXT CHECK (signal_label IN ('BUY', 'WAIT', 'SKIP')),
  signal_status               TEXT NOT NULL,
  risk_level                  TEXT NOT NULL,
  hype_score                  NUMERIC,
  market_momentum_score       NUMERIC,
  identity_context_score      NUMERIC,
  feature_snapshot            JSONB NOT NULL,
  source_snapshot             JSONB NOT NULL,
  social_snapshot             JSONB,
  -- Versioned forward/live evidence captured at qualification. Raw provider
  -- output remains separate for audit; this field is the ML-facing evidence
  -- contract and is additive so existing alert behavior is unchanged.
  live_evidence               JSONB,
  ai_input_sanitized          JSONB,
  ai_output_raw               TEXT,
  ai_decision_json            JSONB,
  ai_model                    TEXT,
  prompt_version              TEXT,
  scoring_version             TEXT,
  feature_schema_version      TEXT,
  config_version              TEXT,
  broadcast_policy            TEXT NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (hype_score IS NULL OR (hype_score >= 0 AND hype_score <= 10)),
  UNIQUE (pair_address, qualified_at)
);

ALTER TABLE alert_decisions ADD COLUMN IF NOT EXISTS live_evidence JSONB;

CREATE INDEX IF NOT EXISTS alert_decisions_qualified_at_idx
  ON alert_decisions (qualified_at DESC);
CREATE INDEX IF NOT EXISTS alert_decisions_signal_idx
  ON alert_decisions (signal_label, risk_level, qualified_at DESC);
CREATE INDEX IF NOT EXISTS alert_decisions_mint_idx
  ON alert_decisions (mint_address, qualified_at DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id                    UUID PRIMARY KEY,
  event_type                  TEXT NOT NULL,
  schema_version              INTEGER NOT NULL DEFAULT 1,
  aggregate_type              TEXT NOT NULL,
  aggregate_id                UUID NOT NULL,
  payload                     JSONB NOT NULL,
  occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                      TEXT NOT NULL DEFAULT 'pending',
  available_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by                  TEXT,
  claimed_at                  TIMESTAMPTZ,
  attempts                    INTEGER NOT NULL DEFAULT 0,
  last_error                  TEXT,
  published_at                TIMESTAMPTZ,
  CHECK (status IN ('pending', 'processing', 'published', 'failed', 'dead_letter'))
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
  ON outbox_events (available_at, occurred_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS outbox_events_aggregate_idx
  ON outbox_events (aggregate_type, aggregate_id);

CREATE TABLE IF NOT EXISTS event_consumptions (
  event_id                    UUID NOT NULL REFERENCES outbox_events(event_id),
  consumer_name               TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'pending',
  available_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by                  TEXT,
  claimed_at                  TIMESTAMPTZ,
  attempts                    INTEGER NOT NULL DEFAULT 0,
  last_error                  TEXT,
  completed_at                TIMESTAMPTZ,
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  PRIMARY KEY (event_id, consumer_name)
);

CREATE INDEX IF NOT EXISTS event_consumptions_pending_idx
  ON event_consumptions (consumer_name, available_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS alert_deliveries (
  alert_id                    UUID NOT NULL REFERENCES alert_decisions(alert_id),
  subscriber_id               BIGINT NOT NULL REFERENCES subscribers(chat_id),
  entitlement_state           TEXT NOT NULL,
  disposition                 TEXT NOT NULL,
  broadcast_requested_at      TIMESTAMPTZ NOT NULL,
  send_started_at             TIMESTAMPTZ,
  delivered_at                TIMESTAMPTZ,
  telegram_message_id         BIGINT,
  failure_code                TEXT,
  send_lease_owner            TEXT,
  send_lease_expires_at       TIMESTAMPTZ,
  attempts                    INTEGER NOT NULL DEFAULT 0,
  trial_count_before          INTEGER,
  trial_count_after           INTEGER,
  PRIMARY KEY (alert_id, subscriber_id)
);

ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS send_lease_owner TEXT;
ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS send_lease_expires_at TIMESTAMPTZ;
ALTER TABLE alert_deliveries DROP CONSTRAINT IF EXISTS alert_deliveries_disposition_check;
ALTER TABLE alert_deliveries ADD CONSTRAINT alert_deliveries_disposition_check CHECK (disposition IN ('queued', 'sending', 'sent', 'suppressed', 'failed', 'expired'));

CREATE INDEX IF NOT EXISTS alert_deliveries_status_idx
  ON alert_deliveries (disposition, broadcast_requested_at DESC);

CREATE TABLE IF NOT EXISTS research_jobs (
  job_id                      UUID PRIMARY KEY,
  job_type                    TEXT NOT NULL,
  idempotency_key              TEXT NOT NULL UNIQUE,
  payload                     JSONB NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'pending',
  available_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by                  TEXT,
  claimed_at                  TIMESTAMPTZ,
  attempts                    INTEGER NOT NULL DEFAULT 0,
  last_error                  TEXT,
  completed_at                TIMESTAMPTZ,
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter'))
);

CREATE INDEX IF NOT EXISTS research_jobs_pending_idx
  ON research_jobs (job_type, available_at)
  WHERE status IN ('pending', 'failed');

-- Canonical wallet-activity capture coverage. This is deliberately metadata on
-- the primary DB rather than another copy of activity: early_wallet_activity is
-- sharded, while capture coverage answers whether a bounded pair/window/wallet
-- request was complete. It prevents a capped/truncated capture from being
-- mistaken for complete history merely because at least one activity row exists.
CREATE TABLE IF NOT EXISTS wallet_activity_capture_coverage (
  pair_address          TEXT NOT NULL,
  mint_address          TEXT NOT NULL,
  window_start_ms       BIGINT NOT NULL,
  window_end_ms         BIGINT NOT NULL,
  wallet_hash           TEXT NOT NULL,
  status                TEXT NOT NULL,
  signatures_in_window  INTEGER NOT NULL DEFAULT 0,
  parsed_entries        INTEGER NOT NULL DEFAULT 0,
  pages_walked          INTEGER NOT NULL DEFAULT 0,
  resume_signature      TEXT,
  last_error            TEXT,
  updated_at            BIGINT NOT NULL,
  PRIMARY KEY (pair_address, mint_address, window_start_ms, window_end_ms, wallet_hash),
  CHECK (status IN ('complete', 'complete-empty', 'complete-tx-capped', 'target-reached', 'truncated', 'parse-incomplete', 'error'))
);
CREATE INDEX IF NOT EXISTS wallet_activity_capture_coverage_lookup_idx
  ON wallet_activity_capture_coverage (pair_address, mint_address, window_start_ms, window_end_ms);
-- Keep the existing table's status constraint in sync when upgrading a live
-- database; CREATE TABLE IF NOT EXISTS does not alter an already-created
-- constraint.
ALTER TABLE wallet_activity_capture_coverage ADD COLUMN IF NOT EXISTS resume_signature TEXT;

ALTER TABLE wallet_activity_capture_coverage DROP CONSTRAINT IF EXISTS wallet_activity_capture_coverage_status_check;
ALTER TABLE wallet_activity_capture_coverage
  ADD CONSTRAINT wallet_activity_capture_coverage_status_check
  CHECK (status IN ('complete', 'complete-empty', 'complete-tx-capped', 'target-reached', 'truncated', 'parse-incomplete', 'error'));

-- Wallet-level canonical evidence-depth state. Unlike
-- wallet_activity_capture_coverage (which is deliberately pair/window scoped),
-- this row answers whether a wallet has accumulated enough reusable economic
-- evidence for EDPI-L/CTO/future consumers. It is intentionally on the primary
-- DB because it is coordination metadata; early_wallet_activity itself remains
-- wallet-sharded.
CREATE TABLE IF NOT EXISTS wallet_activity_evidence_state (
  wallet_address              TEXT PRIMARY KEY,
  target_relevant_transactions INTEGER NOT NULL DEFAULT 1000,
  relevant_transactions        INTEGER NOT NULL DEFAULT 0,
  raw_signatures_scanned      INTEGER NOT NULL DEFAULT 0,
  raw_signatures_scanned_total BIGINT NOT NULL DEFAULT 0,
  pages_scanned              INTEGER NOT NULL DEFAULT 0,
  pairs_scanned                INTEGER NOT NULL DEFAULT 0,
  coverage_before_ms           BIGINT,
  last_pair_address             TEXT,
  last_signature                TEXT,
  status                       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'target_reached', 'end_of_history', 'raw_safety_cap', 'pair_safety_cap', 'error')),
  last_error                   TEXT,
  updated_at                   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
);
ALTER TABLE wallet_activity_evidence_state ADD COLUMN IF NOT EXISTS pages_scanned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wallet_activity_evidence_state ADD COLUMN IF NOT EXISTS raw_signatures_scanned_total BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS wallet_activity_evidence_state_status_idx
  ON wallet_activity_evidence_state (status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_type_aggregate_uidx
  ON outbox_events (event_type, aggregate_id);


-- Durable notification dispatch queue. `alert_deliveries` is the audit record;
-- this table is the retryable work item consumed by the Telegram dispatcher.
-- Keeping the queue separate prevents a Telegram API outage from blocking
-- alert-event consumption or research observation scheduling.
CREATE TABLE IF NOT EXISTS notification_jobs (
  job_id                    UUID PRIMARY KEY,
  alert_id                  UUID NOT NULL REFERENCES alert_decisions(alert_id),
  subscriber_id             BIGINT NOT NULL REFERENCES subscribers(chat_id),
  idempotency_key           TEXT NOT NULL UNIQUE,
  status                    TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead_letter', 'suppressed')),
  available_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by                TEXT,
  claimed_at                TIMESTAMPTZ,
  attempts                  INTEGER NOT NULL DEFAULT 0,
  last_error                TEXT,
  telegram_message_id      BIGINT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at                   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notification_jobs_claim_idx
  ON notification_jobs (available_at, created_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS notification_jobs_alert_idx
  ON notification_jobs (alert_id, subscriber_id);


-- Alert-linked research observations. These are separate from the slower
-- lifecycle `snapshots` table so short-horizon analytical evaluation can be
-- performed without changing long-term tracking or archive behavior.
CREATE TABLE IF NOT EXISTS alert_observations (
  observation_id             UUID PRIMARY KEY,
  alert_id                  UUID NOT NULL REFERENCES alert_decisions(alert_id),
  horizon_key               TEXT NOT NULL,
  target_at                 TIMESTAMPTZ NOT NULL,
  observed_at               TIMESTAMPTZ,
  status                    TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'complete', 'partial', 'unavailable', 'failed')),
  data_quality_status       TEXT NOT NULL DEFAULT 'not_observed'
                            CHECK (data_quality_status IN ('complete', 'partial', 'stale', 'unavailable', 'not_observed')),
  source                    TEXT,
  evidence_class            TEXT NOT NULL DEFAULT 'forward',
  source_observed_at        TIMESTAMPTZ,
  backfill_run_id           UUID,
  pair_resolvable           BOOLEAN,
  price_usd                 NUMERIC,
  market_cap_usd            NUMERIC,
  liquidity_usd             NUMERIC,
  volume_1h                 NUMERIC,
  buys_1h                  INTEGER,
  sells_1h                 INTEGER,
  top_holder_pct            NUMERIC,
  lp_locked_pct             NUMERIC,
  mint_authority_held       BOOLEAN,
  freeze_authority_held     BOOLEAN,
  raw_observation           JSONB,
  error_code                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alert_id, horizon_key)
);

CREATE INDEX IF NOT EXISTS alert_observations_due_idx
  ON alert_observations (target_at, status);
CREATE INDEX IF NOT EXISTS alert_observations_alert_idx
  ON alert_observations (alert_id, target_at);

ALTER TABLE alert_observations ADD COLUMN IF NOT EXISTS market_cap_usd NUMERIC;
ALTER TABLE alert_observations ADD COLUMN IF NOT EXISTS evidence_class TEXT NOT NULL DEFAULT 'forward';
ALTER TABLE alert_observations ADD COLUMN IF NOT EXISTS backfill_run_id UUID;
ALTER TABLE alert_observations DROP CONSTRAINT IF EXISTS alert_observations_evidence_class_check;
ALTER TABLE alert_observations ADD CONSTRAINT alert_observations_evidence_class_check
  CHECK (evidence_class IN ('forward', 'legacy', 'reconstructed'));
ALTER TABLE alert_observations DROP CONSTRAINT IF EXISTS alert_observations_backfill_run_fk;
ALTER TABLE alert_observations ADD CONSTRAINT alert_observations_backfill_run_fk
  FOREIGN KEY (backfill_run_id) REFERENCES backfill_runs(run_id);
CREATE INDEX IF NOT EXISTS alert_observations_evidence_idx
  ON alert_observations (evidence_class, backfill_run_id);

-- Versioned analytical evaluation of a BUY/WAIT/SKIP decision. Results are
-- append-only by rules version so historical methodology can be recomputed
-- without overwriting previous conclusions.
CREATE TABLE IF NOT EXISTS alert_evaluations (
  evaluation_id             UUID PRIMARY KEY,
  alert_id                  UUID NOT NULL REFERENCES alert_decisions(alert_id),
  evaluation_rules_version  TEXT NOT NULL,
  evidence_class            TEXT NOT NULL
                            CHECK (evidence_class IN ('legacy', 'reconstructed', 'forward')),
  observation_coverage      NUMERIC,
  outcome_label             TEXT NOT NULL,
  analytical_score          NUMERIC,
  confidence                TEXT NOT NULL
                            CHECK (confidence IN ('high', 'medium', 'low', 'unresolved')),
  evidence                  JSONB NOT NULL,
  computed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alert_id, evaluation_rules_version)
);

CREATE INDEX IF NOT EXISTS alert_evaluations_label_idx
  ON alert_evaluations (outcome_label, computed_at);
CREATE INDEX IF NOT EXISTS alert_evaluations_alert_idx
  ON alert_evaluations (alert_id, computed_at);


-- Read-only analytical views consumed by admin reporting and a future
-- read-only site. Latest evaluation is selected per alert and rules version.
CREATE OR REPLACE VIEW v_alert_signal_performance AS
WITH latest_evaluation AS (
  SELECT DISTINCT ON (alert_id)
    alert_id, evaluation_rules_version, evidence_class, observation_coverage,
    outcome_label, analytical_score, confidence, computed_at
  FROM alert_evaluations
  ORDER BY alert_id, computed_at DESC
), delivery_counts AS (
  SELECT alert_id,
    COUNT(*)::int AS delivery_count,
    COUNT(*) FILTER (WHERE disposition = 'sent')::int AS delivered_count,
    COUNT(*) FILTER (WHERE disposition = 'failed')::int AS failed_delivery_count
  FROM alert_deliveries GROUP BY alert_id
), observation_counts AS (
  SELECT alert_id,
    COUNT(*)::int AS observation_count,
    COUNT(*) FILTER (WHERE status IN ('complete', 'partial'))::int AS observed_count,
    COUNT(*) FILTER (WHERE data_quality_status = 'unavailable')::int AS unavailable_count
  FROM alert_observations GROUP BY alert_id
)
SELECT
  d.alert_id, d.qualified_at, d.signal_label, d.signal_status, d.risk_level,
  d.hype_score, d.feature_snapshot #>> '{context,narrativeTag}' AS narrative_tag, d.scoring_version, d.prompt_version,
  e.evaluation_rules_version, e.evidence_class, e.observation_coverage,
  e.outcome_label, e.analytical_score, e.confidence,
  COALESCE(dc.delivery_count, 0) AS delivery_count,
  COALESCE(dc.delivered_count, 0) AS delivered_count,
  COALESCE(dc.failed_delivery_count, 0) AS failed_delivery_count,
  COALESCE(oc.observation_count, 0) AS observation_count,
  COALESCE(oc.observed_count, 0) AS observed_count,
  COALESCE(oc.unavailable_count, 0) AS unavailable_count
FROM alert_decisions d
LEFT JOIN latest_evaluation e ON e.alert_id = d.alert_id
LEFT JOIN delivery_counts dc ON dc.alert_id = d.alert_id
LEFT JOIN observation_counts oc ON oc.alert_id = d.alert_id;

CREATE OR REPLACE VIEW v_alert_data_quality AS
SELECT
  d.alert_id, d.qualified_at, d.signal_label, d.signal_status,
  CASE WHEN d.feature_snapshot IS NOT NULL THEN 1 ELSE 0 END AS has_feature_snapshot,
  CASE WHEN d.source_snapshot IS NOT NULL THEN 1 ELSE 0 END AS has_source_snapshot,
  CASE WHEN d.ai_input_sanitized IS NOT NULL THEN 1 ELSE 0 END AS has_ai_input,
  COUNT(o.observation_id)::int AS observation_count,
  COUNT(o.observation_id) FILTER (WHERE o.data_quality_status = 'complete')::int AS complete_observations,
  COUNT(o.observation_id) FILTER (WHERE o.data_quality_status = 'partial')::int AS partial_observations,
  COUNT(o.observation_id) FILTER (WHERE o.data_quality_status IN ('unavailable', 'not_observed'))::int AS unavailable_observations,
  COUNT(o.observation_id) FILTER (WHERE o.source_observed_at IS NOT NULL)::int AS timestamped_observations,
  MAX(o.observed_at) AS last_observed_at
FROM alert_decisions d
LEFT JOIN alert_observations o ON o.alert_id = d.alert_id
GROUP BY d.alert_id, d.qualified_at, d.signal_label, d.signal_status,
  d.feature_snapshot, d.source_snapshot, d.ai_input_sanitized;

CREATE OR REPLACE VIEW v_alert_delivery_performance AS
SELECT
  alert_id,
  COUNT(*)::int AS recipients,
  COUNT(*) FILTER (WHERE disposition = 'sent')::int AS sent,
  COUNT(*) FILTER (WHERE disposition = 'failed')::int AS failed,
  COUNT(*) FILTER (WHERE disposition = 'suppressed')::int AS suppressed,
  COUNT(*) FILTER (WHERE disposition = 'queued')::int AS queued,
  ROUND(AVG(EXTRACT(EPOCH FROM (delivered_at - broadcast_requested_at))) FILTER (WHERE delivered_at IS NOT NULL), 3) AS avg_delivery_seconds,
  MAX(EXTRACT(EPOCH FROM (delivered_at - broadcast_requested_at))) FILTER (WHERE delivered_at IS NOT NULL) AS max_delivery_seconds
FROM alert_deliveries
GROUP BY alert_id;

CREATE OR REPLACE VIEW v_alert_funnel AS
SELECT
  DATE_TRUNC('day', d.qualified_at) AS day,
  COUNT(*)::int AS qualified,
  COUNT(*) FILTER (WHERE d.broadcast_policy = 'ALLOW')::int AS broadcast_eligible,
  COUNT(DISTINCT del.alert_id)::int AS alerts_with_delivery_rows,
  COUNT(DISTINCT del.alert_id) FILTER (WHERE del.disposition = 'sent')::int AS alerts_delivered,
  COUNT(DISTINCT ev.alert_id)::int AS alerts_evaluated
FROM alert_decisions d
LEFT JOIN alert_deliveries del ON del.alert_id = d.alert_id
LEFT JOIN alert_evaluations ev ON ev.alert_id = d.alert_id
GROUP BY DATE_TRUNC('day', d.qualified_at);

CREATE OR REPLACE VIEW v_alert_audit AS
SELECT
  d.alert_id, d.pair_address, d.mint_address, d.qualified_at,
  d.signal_label, d.signal_status, d.risk_level, d.hype_score,
  d.feature_snapshot, d.source_snapshot, d.social_snapshot,
  d.ai_input_sanitized, d.ai_output_raw, d.ai_decision_json,
  d.ai_model, d.prompt_version, d.scoring_version, d.config_version,
  e.evaluation_rules_version, e.evidence_class, e.outcome_label,
  e.analytical_score, e.confidence, e.evidence
FROM alert_decisions d
LEFT JOIN LATERAL (
  SELECT * FROM alert_evaluations ae
  WHERE ae.alert_id = d.alert_id
  ORDER BY ae.computed_at DESC LIMIT 1
) e ON true;


-- -------------------------------------------------------------------------
-- ML training dataset foundation (Milestone 1)
-- -------------------------------------------------------------------------
-- A manifest identifies an immutable export recipe and its cutoff. Files are
-- external artifacts; this table stores the provenance needed to reproduce
-- and audit them.
CREATE TABLE IF NOT EXISTS ml_dataset_manifests (
  dataset_id                 UUID PRIMARY KEY,
  dataset_name               TEXT NOT NULL,
  dataset_version            TEXT NOT NULL,
  cutoff_at                  TIMESTAMPTZ NOT NULL,
  label_policy_version       TEXT NOT NULL,
  feature_schema_version     TEXT NOT NULL,
  evaluator_version          TEXT,
  query_version              TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'building'
                             CHECK (status IN ('building', 'ready', 'quarantined', 'superseded')),
  row_count                  INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  label_counts               JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_summary            JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_hashes                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at               TIMESTAMPTZ,
  UNIQUE (dataset_name, dataset_version)
);

-- One canonical, qualification-time example per immutable analytical alert.
-- Labels are deliberately stored as a revisioned JSON bundle for Milestone 1;
-- later milestones may normalize horizon labels once the policy stabilizes.
CREATE TABLE IF NOT EXISTS ml_training_examples (
  example_id                UUID PRIMARY KEY,
  dataset_id                UUID REFERENCES ml_dataset_manifests(dataset_id),
  alert_id                  UUID NOT NULL REFERENCES alert_decisions(alert_id),
  qualified_at              TIMESTAMPTZ NOT NULL,
  feature_observed_at       TIMESTAMPTZ NOT NULL,
  feature_schema_version    TEXT NOT NULL,
  source_decision_version   TEXT NOT NULL,
  feature_snapshot          JSONB NOT NULL,
  source_snapshot           JSONB NOT NULL,
  social_snapshot           JSONB,
  evidence_class            TEXT NOT NULL DEFAULT 'forward'
                             CHECK (evidence_class IN ('forward', 'legacy', 'reconstructed')),
  evidence_snapshot         JSONB,
  ai_input_sanitized        JSONB,
  label_bundle              JSONB NOT NULL DEFAULT '{}'::jsonb,
  label_policy_version      TEXT,
  label_status               TEXT NOT NULL DEFAULT 'unlabeled'
                             CHECK (label_status IN ('unlabeled', 'labeled', 'partial', 'unknown', 'quarantined')),
  quality_status             TEXT NOT NULL DEFAULT 'pending'
                             CHECK (quality_status IN ('pending', 'pass', 'warn', 'fail')),
  quality_flags              JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alert_id, feature_schema_version, source_decision_version)
);

CREATE INDEX IF NOT EXISTS ml_training_examples_dataset_idx
  ON ml_training_examples (dataset_id, qualified_at, example_id);
CREATE INDEX IF NOT EXISTS ml_training_examples_qualified_idx
  ON ml_training_examples (qualified_at, example_id);
CREATE INDEX IF NOT EXISTS ml_training_examples_quality_idx
  ON ml_training_examples (quality_status, label_status);
ALTER TABLE ml_training_examples ADD COLUMN IF NOT EXISTS evidence_class TEXT NOT NULL DEFAULT 'forward';
ALTER TABLE ml_training_examples DROP CONSTRAINT IF EXISTS ml_training_examples_evidence_class_check;
ALTER TABLE ml_training_examples ADD CONSTRAINT ml_training_examples_evidence_class_check
  CHECK (evidence_class IN ('forward', 'legacy', 'reconstructed'));
ALTER TABLE ml_training_examples ADD COLUMN IF NOT EXISTS evidence_snapshot JSONB;
CREATE INDEX IF NOT EXISTS ml_training_examples_evidence_idx
  ON ml_training_examples (evidence_class, qualified_at);

-- Immutable label revisions. A later labeling policy never overwrites an
-- earlier interpretation of the same alert.
CREATE TABLE IF NOT EXISTS ml_training_labels (
  label_id                  UUID PRIMARY KEY,
  example_id                UUID NOT NULL REFERENCES ml_training_examples(example_id),
  label_policy_version      TEXT NOT NULL,
  evaluator_version         TEXT,
  label_bundle              JSONB NOT NULL,
  evidence                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision_key              TEXT NOT NULL DEFAULT 'canonical',
  parent_label_id           UUID REFERENCES ml_training_labels(label_id),
  label_origin              TEXT NOT NULL DEFAULT 'deterministic',
  quality_status             TEXT NOT NULL DEFAULT 'pending'
                             CHECK (quality_status IN ('pass', 'warn', 'fail')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (example_id, label_policy_version, revision_key)
);

ALTER TABLE ml_training_labels ADD COLUMN IF NOT EXISTS revision_key TEXT NOT NULL DEFAULT 'canonical';
ALTER TABLE ml_training_labels ADD COLUMN IF NOT EXISTS parent_label_id UUID REFERENCES ml_training_labels(label_id);
ALTER TABLE ml_training_labels ADD COLUMN IF NOT EXISTS label_origin TEXT NOT NULL DEFAULT 'deterministic';
ALTER TABLE ml_training_labels DROP CONSTRAINT IF EXISTS ml_training_labels_label_origin_check;
ALTER TABLE ml_training_labels DROP CONSTRAINT IF EXISTS ml_training_labels_example_id_label_policy_version_key;
ALTER TABLE ml_training_labels ADD CONSTRAINT ml_training_labels_label_origin_check CHECK (label_origin IN ('deterministic', 'human_review'));
CREATE UNIQUE INDEX IF NOT EXISTS ml_training_labels_revision_uidx ON ml_training_labels (example_id, label_policy_version, revision_key);

CREATE INDEX IF NOT EXISTS ml_training_labels_example_idx
  ON ml_training_labels (example_id, created_at DESC);


-- -------------------------------------------------------------------------
-- ML human-review foundation (Milestone 6)
-- -------------------------------------------------------------------------
-- Reviews never mutate decisions, observations, or prior labels. Each review
-- is an append-only correction record tied to one example and, optionally,
-- one horizon.
CREATE TABLE IF NOT EXISTS ml_label_reviews (
  review_id                 UUID PRIMARY KEY,
  example_id                UUID NOT NULL REFERENCES ml_training_examples(example_id),
  horizon_key               TEXT,
  original_label             TEXT,
  revised_label              TEXT,
  reason_code                TEXT NOT NULL,
  reviewer                  TEXT NOT NULL,
  review_notes               TEXT,
  evidence                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_policy_version      TEXT NOT NULL,
  reviewed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (original_label IS NULL OR original_label IN ('positive', 'negative', 'neutral', 'unknown', 'censored')),
  CHECK (revised_label IS NULL OR revised_label IN ('positive', 'negative', 'neutral', 'unknown', 'censored')),
  CHECK (horizon_key IS NULL OR horizon_key IN ('5m', '15m', '1h', '6h', '24h', '72h')),
  CHECK (length(trim(reason_code)) > 0),
  CHECK (length(trim(reviewer)) > 0)
);

CREATE INDEX IF NOT EXISTS ml_label_reviews_example_idx
  ON ml_label_reviews (example_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS ml_label_reviews_horizon_idx
  ON ml_label_reviews (horizon_key, reviewed_at DESC);

CREATE OR REPLACE VIEW v_ml_review_candidates AS
SELECT
  e.example_id,
  e.alert_id,
  e.qualified_at,
  e.dataset_id,
  e.label_status,
  e.quality_status,
  e.quality_flags,
  e.label_bundle,
  e.feature_snapshot,
  e.source_snapshot,
  e.social_snapshot,
  e.ai_input_sanitized,
  e.created_at,
  CASE
    WHEN e.quality_status = 'fail' THEN 'quality_failure'
    WHEN e.label_status IN ('unknown', 'partial') THEN 'incomplete_label'
    WHEN e.label_bundle::text ~ '"severeAdverseObserved":true' THEN 'severe_adverse_outcome'
    WHEN e.label_bundle::text ~ '"maxRoiMultiple":([2-9]|[1-9][0-9])' THEN 'high_roi_outlier'
    ELSE 'manual_review'
  END AS candidate_reason
FROM ml_training_examples e
WHERE e.quality_status IN ('fail', 'warn')
   OR e.label_status IN ('unknown', 'partial')
   OR e.label_bundle::text ~ '"severeAdverseObserved":true'
   OR e.label_bundle::text ~ '"maxRoiMultiple":([2-9]|[1-9][0-9])';

-- -------------------------------------------------------------------------
-- GeckoTerminal/CoinGecko early-discovery experiment (research-only)
-- -------------------------------------------------------------------------
-- Independent discovery-timing measurement, NOT a second qualification
-- pipeline. Existing discovery (dexscreenerService.js -> tokenScanner.js)
-- is completely untouched by this section; scripts/early-discovery-
-- experiment.js is the only writer, runs standalone (never from
-- src/index.js), and never affects BUY/WAIT/SKIP or alert_decisions.
--
-- One row per (source, mint_address) EVER — see the unique index below.
-- first_seen_at is deliberately never overwritten once written: it is the
-- point-in-time observation the whole experiment measures (spec section
-- 6/10), and an UPDATE here would silently corrupt the very lead-time
-- comparison this table exists to support. Re-running the poller against
-- an already-seen mint is therefore always a no-op write (ON CONFLICT DO
-- NOTHING in earlyDiscoveryStore.js), which is also what makes the poller
-- restart-safe without a separate checkpoint table (spec section 10) —
-- the unique index IS the checkpoint.
--
-- mint_address (not pool_address) is the cross-source join key: the same
-- token can trade through different pools on different sources (e.g. a
-- pump.fun bonding-curve pool vs. its post-graduation Raydium pool), but
-- the mint is the one identity both sources agree on (spec section 4).
CREATE TABLE IF NOT EXISTS early_discovery_observations (
  observation_id     UUID PRIMARY KEY,
  source              TEXT NOT NULL,          -- 'geckoterminal' | 'geckoterminal_fallback' | 'dexscreener'
  chain               TEXT NOT NULL DEFAULT 'solana',
  mint_address         TEXT NOT NULL,
  pool_address         TEXT,
  symbol               TEXT,
  name                TEXT,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when OUR poller first observed it — never updated after insert
  source_created_at     TIMESTAMPTZ,           -- source-reported pool/token creation time, if available
  market_cap_usd       NUMERIC,
  liquidity_usd        NUMERIC,
  price_usd            NUMERIC,
  raw_observation       JSONB,                 -- full normalized candidate snapshot, for later inspection
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source IN ('geckoterminal', 'geckoterminal_fallback', 'dexscreener'))
);

-- The actual restart-safety/dedup backstop (see header comment above) —
-- one observation per source per token, ever.
CREATE UNIQUE INDEX IF NOT EXISTS early_discovery_observations_source_mint_uidx
  ON early_discovery_observations (source, mint_address);

-- Cross-source join for overlap/lead-time queries (spec section 7) — scans
-- every source's row for a given mint without a full-table sort.
CREATE INDEX IF NOT EXISTS early_discovery_observations_mint_idx
  ON early_discovery_observations (mint_address, first_seen_at);

-- Append-only accounting log, one row per source per poll cycle. This is
-- what section 11 item 9 ("API requests made") and item 10 ("rate-limit or
-- API-quality problems") are reported from — request counts are tracked
-- here rather than parsed back out of process logs.
CREATE TABLE IF NOT EXISTS early_discovery_poll_log (
  poll_id             UUID PRIMARY KEY,
  source              TEXT NOT NULL,
  polled_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  dry_run              BOOLEAN NOT NULL DEFAULT true,
  request_count         INTEGER NOT NULL DEFAULT 0,
  candidates_seen       INTEGER NOT NULL DEFAULT 0,
  new_observations      INTEGER NOT NULL DEFAULT 0,
  used_fallback         BOOLEAN NOT NULL DEFAULT false,
  error                TEXT,
  CHECK (source IN ('geckoterminal', 'dexscreener'))
);

CREATE INDEX IF NOT EXISTS early_discovery_poll_log_source_idx
  ON early_discovery_poll_log (source, polled_at DESC);

-- Production discovery provenance. Pair identity is deliberately distinct
-- from mint identity: the same mint can have multiple pools, while the same
-- pool can be surfaced by multiple discovery providers. This table retains
-- first/last observation plus source-specific discovery metrics and policy
-- version without changing qualification or alert semantics.
CREATE TABLE IF NOT EXISTS discovery_observations (
  discovery_id              UUID PRIMARY KEY,
  source                    TEXT NOT NULL,
  chain                     TEXT NOT NULL DEFAULT 'solana',
  mint_address              TEXT NOT NULL,
  pair_address              TEXT NOT NULL,
  symbol                    TEXT,
  name                      TEXT,
  first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  discovery_volume_1h_usd   NUMERIC,
  discovery_total_volume_usd NUMERIC,
  discovery_threshold       JSONB,
  filter_version            TEXT,
  provider_path             TEXT,
  CHECK (source IN ('dexscreener', 'geckoterminal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS discovery_observations_source_pair_uidx
  ON discovery_observations (source, pair_address);
CREATE INDEX IF NOT EXISTS discovery_observations_pair_idx
  ON discovery_observations (pair_address, first_seen_at);
CREATE INDEX IF NOT EXISTS discovery_observations_mint_idx
  ON discovery_observations (mint_address, first_seen_at);


-- Append-only discovery events used by the outcome-learning layer. Unlike
-- discovery_observations (a current provenance summary), these rows are
-- immutable snapshots of what a provider exposed at discovery time.
CREATE TABLE IF NOT EXISTS discovery_events (
  discovery_event_id         UUID PRIMARY KEY,
  source                     TEXT NOT NULL,
  chain                      TEXT NOT NULL DEFAULT 'solana',
  mint_address               TEXT NOT NULL,
  pair_address               TEXT NOT NULL,
  dex_id                     TEXT,
  symbol                     TEXT,
  name                       TEXT,
  discovered_at              TIMESTAMPTZ NOT NULL,
  discovery_volume_1h_usd    NUMERIC,
  discovery_total_volume_usd NUMERIC,
  discovery_liquidity_usd    NUMERIC,
  discovery_market_cap_usd   NUMERIC,
  discovery_price_usd        NUMERIC,
  discovery_age_minutes      NUMERIC,
  discovery_threshold        JSONB,
  filter_version             TEXT,
  discovery_version          TEXT,
  discovery_cohort_key       TEXT,
  provider_path              TEXT,
  raw_snapshot               JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source IN ('dexscreener', 'geckoterminal')),
  UNIQUE (source, pair_address)
);
CREATE INDEX IF NOT EXISTS discovery_events_pair_idx
  ON discovery_events (pair_address, discovered_at);
CREATE INDEX IF NOT EXISTS discovery_events_mint_idx
  ON discovery_events (mint_address, discovered_at);
CREATE INDEX IF NOT EXISTS discovery_events_cohort_idx
  ON discovery_events (discovery_cohort_key, discovered_at);

-- Per-evaluation stage evidence. This preserves discovery/common/safety
-- rejection information without changing qualification or signal logic.
CREATE TABLE IF NOT EXISTS discovery_evaluations (
  evaluation_id             UUID PRIMARY KEY,
  discovery_event_id        UUID REFERENCES discovery_events(discovery_event_id),
  pair_address              TEXT NOT NULL,
  mint_address              TEXT NOT NULL,
  evaluated_at              TIMESTAMPTZ NOT NULL,
  source                    TEXT,
  stage                     TEXT NOT NULL,
  passed                    BOOLEAN NOT NULL,
  reason                    TEXT,
  qualification_filter_version TEXT,
  safety_result             JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (stage IN ('discovery', 'common_qualification', 'safety', 'wallet_analysis', 'edpi_l', 'signal'))
);
CREATE INDEX IF NOT EXISTS discovery_evaluations_pair_idx
  ON discovery_evaluations (pair_address, evaluated_at);
CREATE INDEX IF NOT EXISTS discovery_evaluations_stage_idx
  ON discovery_evaluations (stage, evaluated_at);


-- Fixed-horizon market observations anchored to first discovery, independent
-- of qualification. This prevents discovery learning from silently using
-- qualification time as a proxy for discovery time.
CREATE TABLE IF NOT EXISTS discovery_outcome_observations (
  observation_id             UUID PRIMARY KEY,
  discovery_event_id         UUID NOT NULL REFERENCES discovery_events(discovery_event_id),
  horizon_key                TEXT NOT NULL,
  target_at                  TIMESTAMPTZ NOT NULL,
  observed_at                TIMESTAMPTZ,
  status                     TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','complete','partial','unavailable','failed')),
  data_quality_status        TEXT NOT NULL DEFAULT 'not_observed'
                              CHECK (data_quality_status IN ('complete','partial','stale','unavailable','not_observed')),
  source                     TEXT,
  source_observed_at         TIMESTAMPTZ,
  pair_resolvable            BOOLEAN,
  price_usd                  NUMERIC,
  market_cap_usd             NUMERIC,
  liquidity_usd              NUMERIC,
  volume_1h                  NUMERIC,
  raw_observation            JSONB,
  error_code                 TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (discovery_event_id, horizon_key)
);
CREATE INDEX IF NOT EXISTS discovery_outcome_observations_due_idx
  ON discovery_outcome_observations (target_at, status);
CREATE INDEX IF NOT EXISTS discovery_outcome_observations_event_idx
  ON discovery_outcome_observations (discovery_event_id, target_at);

-- A deterministic, reusable research view: one analytical row per pair,
-- preserving all discovery events and the first-discovery source while
-- joining later qualification/observation evidence where available.
CREATE OR REPLACE VIEW v_discovery_outcome_research AS
WITH firsts AS (
  SELECT DISTINCT ON (pair_address)
    discovery_event_id, pair_address, mint_address, source AS first_discovered_by,
    discovered_at AS first_discovery_at, discovery_cohort_key AS first_cohort_key,
    discovery_volume_1h_usd, discovery_total_volume_usd,
    discovery_liquidity_usd, discovery_market_cap_usd,
    discovery_price_usd, discovery_age_minutes, discovery_threshold,
    filter_version, discovery_version, provider_path
  FROM discovery_events
  ORDER BY pair_address, discovered_at, source
), sources AS (
  SELECT pair_address,
         array_agg(DISTINCT source ORDER BY source) AS discovery_sources,
         jsonb_object_agg(source, discovered_at) AS source_discovery_times,
         MIN(discovered_at) AS first_discovery_at,
         MAX(discovered_at) AS last_discovery_at
  FROM (
    SELECT DISTINCT ON (pair_address, source) pair_address, source, discovered_at
    FROM discovery_events
    ORDER BY pair_address, source, discovered_at
  ) first_source_events
  GROUP BY pair_address
), alerts AS (
  SELECT DISTINCT ON (ad.pair_address)
    ad.pair_address, ad.alert_id, ad.qualified_at, ad.qualification_status,
    ad.signal_label, ad.risk_level, ad.feature_snapshot, ad.live_evidence,
    pa.outcome, pa.outcome_detail, pa.archived_at,
    pa.time_to_rug_from_qualification_hours, pa.rug_mechanism
  FROM alert_decisions ad
  LEFT JOIN LATERAL (
    SELECT outcome, outcome_detail, archived_at, time_to_rug_from_qualification_hours, rug_mechanism
    FROM pattern_archive WHERE pair_address = ad.pair_address
    ORDER BY archived_at DESC LIMIT 1
  ) pa ON true
  ORDER BY ad.pair_address, ad.qualified_at
), evaluations AS (
  SELECT pair_address,
         jsonb_agg(jsonb_build_object(
           'stage', stage, 'passed', passed, 'reason', reason,
           'evaluatedAt', evaluated_at, 'source', source,
           'filterVersion', qualification_filter_version
         ) ORDER BY evaluated_at) AS evaluation_history
  FROM discovery_evaluations GROUP BY pair_address
), obs AS (
  SELECT discovery_event_id,
         COUNT(*)::int AS observation_count,
         COUNT(*) FILTER (WHERE status = 'complete')::int AS complete_observation_count,
         COUNT(*) FILTER (WHERE data_quality_status IN ('unavailable','not_observed'))::int AS unavailable_observation_count,
         jsonb_object_agg(horizon_key, jsonb_build_object(
           'targetAt', target_at, 'observedAt', observed_at, 'status', status,
           'dataQualityStatus', data_quality_status, 'priceUsd', price_usd,
           'marketCapUsd', market_cap_usd, 'liquidityUsd', liquidity_usd,
           'volume1h', volume_1h, 'sourceObservedAt', source_observed_at
         ) ORDER BY target_at) AS horizons,
         MAX(market_cap_usd) AS max_market_cap_usd,
         MAX(price_usd) AS max_price_usd,
         MAX(liquidity_usd) AS max_liquidity_usd
  FROM discovery_outcome_observations GROUP BY discovery_event_id
)
SELECT f.discovery_event_id, f.pair_address, f.mint_address, f.first_discovered_by,
       f.first_discovery_at, f.first_cohort_key,
       f.discovery_volume_1h_usd, f.discovery_total_volume_usd,
       f.discovery_liquidity_usd, f.discovery_market_cap_usd,
       f.discovery_price_usd, f.discovery_age_minutes, f.discovery_threshold,
       f.filter_version, f.discovery_version, f.provider_path,
       s.discovery_sources, s.source_discovery_times, s.last_discovery_at,
       a.alert_id, a.qualified_at, a.qualification_status, a.signal_label, a.risk_level,
       a.feature_snapshot, a.live_evidence, a.outcome, a.outcome_detail,
       a.archived_at, a.time_to_rug_from_qualification_hours, a.rug_mechanism,
       COALESCE(o.observation_count, 0) AS observation_count,
       COALESCE(o.complete_observation_count, 0) AS complete_observation_count,
       COALESCE(o.unavailable_observation_count, 0) AS unavailable_observation_count,
       o.horizons, o.max_market_cap_usd, o.max_price_usd, o.max_liquidity_usd,
       e.evaluation_history
FROM firsts f
JOIN sources s USING (pair_address)
LEFT JOIN alerts a USING (pair_address)
LEFT JOIN obs o USING (discovery_event_id)
LEFT JOIN evaluations e USING (pair_address);

-- Production EDPI-L scoring audit. One immutable evaluation is bound to the
-- qualified alert decision; wallet evidence is stored separately so the
-- token-level score never becomes the only surviving representation.
CREATE TABLE IF NOT EXISTS edpi_l_evaluations (
  evaluation_id              UUID PRIMARY KEY,
  alert_id                   UUID NOT NULL REFERENCES alert_decisions(alert_id) ON DELETE CASCADE,
  pair_address               TEXT NOT NULL,
  mint_address               TEXT NOT NULL,
  qualified_at               TIMESTAMPTZ NOT NULL,
  edpi_l_scoring_version     TEXT NOT NULL,
  edpi_l_strength_version    TEXT NOT NULL,
  class_1_score               NUMERIC NOT NULL DEFAULT 0,
  class_2_score               NUMERIC NOT NULL DEFAULT 0,
  class_4_score               NUMERIC NOT NULL DEFAULT 0,
  class_5_composite           NUMERIC,
  active_class_count          INTEGER NOT NULL DEFAULT 0,
  average_class_score         NUMERIC NOT NULL DEFAULT 0,
  edpi_l_score                NUMERIC NOT NULL DEFAULT 0,
  strength_label              TEXT NOT NULL,
  qualifying_wallet_counts    JSONB NOT NULL,
  scoring_wallet_counts       JSONB NOT NULL,
  wallet_sample_size          INTEGER NOT NULL DEFAULT 0,
  raw_candidate_wallet_count  INTEGER NOT NULL DEFAULT 0,
  unique_candidate_wallet_count INTEGER NOT NULL DEFAULT 0,
  eligible_wallet_count       INTEGER NOT NULL DEFAULT 0,
  insufficient_history_count  INTEGER NOT NULL DEFAULT 0,
  excluded_wallet_count       INTEGER NOT NULL DEFAULT 0,
  data_coverage               JSONB NOT NULL,
  scoring_configuration       JSONB NOT NULL,
  report_only_evidence        JSONB NOT NULL,
  no_lookahead                JSONB NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alert_id)
);

ALTER TABLE edpi_l_evaluations ADD COLUMN IF NOT EXISTS raw_candidate_wallet_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE edpi_l_evaluations ADD COLUMN IF NOT EXISTS unique_candidate_wallet_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS edpi_l_evaluations_pair_idx
  ON edpi_l_evaluations (pair_address, qualified_at DESC);
CREATE INDEX IF NOT EXISTS edpi_l_evaluations_version_idx
  ON edpi_l_evaluations (edpi_l_scoring_version, qualified_at DESC);

CREATE TABLE IF NOT EXISTS edpi_l_wallet_evidence (
  wallet_evidence_id          UUID PRIMARY KEY,
  evaluation_id               UUID NOT NULL REFERENCES edpi_l_evaluations(evaluation_id) ON DELETE CASCADE,
  wallet_address              TEXT NOT NULL,
  holder_pct                  NUMERIC,
  status                      TEXT NOT NULL,
  eligible                    BOOLEAN NOT NULL DEFAULT FALSE,
  excluded                    BOOLEAN NOT NULL DEFAULT FALSE,
  exclusion_reason            TEXT,
  history_depth               INTEGER,
  class_1_qualifying          BOOLEAN NOT NULL DEFAULT FALSE,
  class_1_points              NUMERIC NOT NULL DEFAULT 0,
  class_2_qualifying          BOOLEAN NOT NULL DEFAULT FALSE,
  class_2_points              NUMERIC NOT NULL DEFAULT 0,
  class_4_qualifying          BOOLEAN NOT NULL DEFAULT FALSE,
  class_4_points              NUMERIC NOT NULL DEFAULT 0,
  current_entry_mc_usd        NUMERIC,
  current_capital_sol         NUMERIC,
  class_1_evidence             JSONB NOT NULL,
  class_2_evidence             JSONB NOT NULL,
  class_4_evidence             JSONB NOT NULL,
  behavioral_evidence          JSONB,
  historical_profile           JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (evaluation_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS edpi_l_wallet_evidence_wallet_idx
  ON edpi_l_wallet_evidence (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS edpi_l_wallet_evidence_class_idx
  ON edpi_l_wallet_evidence (evaluation_id, class_1_qualifying, class_2_qualifying, class_4_qualifying);
