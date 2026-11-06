const { query, withTransaction } = require('../db/pool');
const { patternTracking } = require('../config');
const shardPool = require('../db/shardPool');

/**
 * Postgres-backed store for the pattern-tracking feature. Same exported
 * function names/shapes as the JSON-file version this originally replaced
 * (Phase 1 of the V2 roadmap) for active tracking (`tracked_tokens`) and
 * the permanent archive (`pattern_archive`).
 *
 * `checkpoints` — a JSONB blob rewritten wholesale on every review in
 * Phase 1 — is normalized as of Phase 2 into the append-only `snapshots`
 * table below, with patternReviewer.js's logic updated to match (see its
 * own comments for what changed there).
 *
 * BEHAVIOR CHANGE, unavoidable: every function here now returns a
 * Promise, including the ones that used to be synchronous reads
 * (getTrackedTokens, getTrackedToken, getArchive). Every existing call
 * site has been updated alongside this file (tokenScanner.js,
 * patternReviewer.js, telegramBot.js, reportScheduler.js) — any new call
 * site must `await` these.
 */

function rowToTrackedToken(row) {
  if (!row) return null;
  return {
    pairAddress: row.pair_address,
    mintAddress: row.mint_address,
    baseToken: row.base_token,
    narrativeTag: row.narrative_tag,
    hypeScoreAtQualification: row.hype_score_at_qualification,
    riskLevelAtQualification: row.risk_level_at_qualification,
    signalLabel: row.signal_label,
    qualifiedAt: row.qualified_at,
    pairCreatedAt: row.pair_created_at,
    firstPriceUsd: row.first_price_usd,
    athPriceUsd: row.ath_price_usd,
    athAt: row.ath_at,
    lastPriceUsd: row.last_price_usd,
    lastCheckedAt: row.last_checked_at,
    firstTopHolderPct: row.first_top_holder_pct,
    firstLpLockedPct: row.first_lp_locked_pct,
    // Item 5 (AI-training-pipeline proposal audit) — same reasoning as
    // firstTopHolderPct/firstLpLockedPct just above.
    firstMintAuthorityHeld: row.first_mint_authority_held,
    firstFreezeAuthorityHeld: row.first_freeze_authority_held,
    lastBelowSurvivalThresholdAt: row.last_below_survival_threshold_at,
    // Age-based review cadence (AUDIT FOLLOW-UP): null means never
    // reviewed since enrollment — see reviewAllTrackedTokens' dueForReview
    // filter, which treats that as always due regardless of age.
    lastReviewedAt: row.last_reviewed_at,
    // Plan A: disambiguates a null signalLabel — see schema.sql's
    // comment on this column and gemini_signal_generator.js's
    // isFallbackText for the full "why."
    signalStatus: row.signal_status,
    // Plan B: see schema.sql's comment on these two columns for the full
    // "why." null/null means genuinely uncategorized (neither classifier
    // found anything), not a forgotten field.
    narrativeConfidence: row.narrative_confidence,
    narrativeMatchMethod: row.narrative_match_method,
  };
}

function rowToArchiveRecord(row) {
  if (!row) return null;
  return {
    pairAddress: row.pair_address,
    mintAddress: row.mint_address,
    symbol: row.symbol,
    name: row.name,
    narrativeTag: row.narrative_tag,
    hypeScoreAtQualification: row.hype_score_at_qualification,
    riskLevelAtQualification: row.risk_level_at_qualification,
    signalLabel: row.signal_label,
    categoryKey: row.category_key,
    qualifiedAt: row.qualified_at,
    pairCreatedAt: row.pair_created_at,
    firstPriceUsd: row.first_price_usd,
    athPriceUsd: row.ath_price_usd,
    athAt: row.ath_at,
    finalPriceUsd: row.final_price_usd,
    peakRoiMultiple: row.peak_roi_multiple,
    outcome: row.outcome,
    archivedAt: row.archived_at,
    timeToRugFromQualificationHours: row.time_to_rug_from_qualification_hours,
    timeToRugFromAthHours: row.time_to_rug_from_ath_hours,
    checkpointCount: row.checkpoint_count,
    firstTopHolderPct: row.first_top_holder_pct,
    lastTopHolderPct: row.last_top_holder_pct,
    firstLpLockedPct: row.first_lp_locked_pct,
    lastLpLockedPct: row.last_lp_locked_pct,
    // Item 5 (AI-training-pipeline proposal audit) — same first/last
    // pattern as the top-holder/LP fields just above.
    firstMintAuthorityHeld: row.first_mint_authority_held,
    lastMintAuthorityHeld: row.last_mint_authority_held,
    firstFreezeAuthorityHeld: row.first_freeze_authority_held,
    lastFreezeAuthorityHeld: row.last_freeze_authority_held,
    outcomeDetail: row.outcome_detail,
    rugMechanism: row.rug_mechanism,
    peakRoiBucket: row.peak_roi_bucket,
    timeToAthFromQualificationHours: row.time_to_ath_from_qualification_hours,
    // Plan A: carried through unchanged from the tracked-token record at
    // archiving time (patternReviewer.js's buildArchiveRecord) — same
    // column, same values, same reasoning as rowToTrackedToken above.
    signalStatus: row.signal_status,
    // Plan B: rugMechanismConfidence/Evidence computed fresh at archiving
    // time by classifyRugMechanismDetail (patternAnalyzer.js), alongside
    // (and from the exact same inputs as) rugMechanism itself just above.
    // rug_mechanism_evidence is stored as JSONB — node-postgres parses it
    // back into a plain JS object automatically, no JSON.parse needed here.
    rugMechanismConfidence: row.rug_mechanism_confidence,
    rugMechanismEvidence: row.rug_mechanism_evidence,
    // Plan B: carried through unchanged from the tracked-token record,
    // same reasoning as signalStatus just above.
    narrativeConfidence: row.narrative_confidence,
    narrativeMatchMethod: row.narrative_match_method,
  };
}

// ---------------------------------------------------------------------
// Active tracking
// ---------------------------------------------------------------------

async function getTrackedTokens() {
  const { rows } = await query('SELECT * FROM tracked_tokens ORDER BY qualified_at');
  return rows.map(rowToTrackedToken);
}

async function getTrackedToken(pairAddress) {
  const { rows } = await query('SELECT * FROM tracked_tokens WHERE pair_address = $1', [pairAddress]);
  return rowToTrackedToken(rows[0]);
}

/**
 * Enrolls a newly-qualified token into active tracking. No-op (returns
 * null) if it's already tracked, same as the original — safe to call every
 * time a token qualifies.
 */
async function enrollToken(record) {
  const { rows } = await query(
    `INSERT INTO tracked_tokens (
       pair_address, mint_address, base_token, narrative_tag,
       hype_score_at_qualification, risk_level_at_qualification, signal_label,
       qualified_at, first_price_usd, ath_price_usd, ath_at,
       last_price_usd, last_checked_at, first_top_holder_pct, first_lp_locked_pct,
       last_below_survival_threshold_at, last_reviewed_at, signal_status,
       narrative_confidence, narrative_match_method,
       first_mint_authority_held, first_freeze_authority_held, pair_created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (pair_address) DO NOTHING
     RETURNING *`,
    [
      record.pairAddress, record.mintAddress, JSON.stringify(record.baseToken), record.narrativeTag,
      record.hypeScoreAtQualification, record.riskLevelAtQualification, record.signalLabel ?? null,
      record.qualifiedAt, record.firstPriceUsd, record.athPriceUsd, record.athAt,
      record.lastPriceUsd, record.lastCheckedAt, record.firstTopHolderPct, record.firstLpLockedPct,
      // Nothing observed below threshold yet — a freshly-enrolled token's
      // price at t=0 is by definition 100% of its (own, brand-new) ATH.
      null,
      // Never reviewed yet — enrollToken (tokenScanner.js) doesn't itself
      // count as a review; only reviewToken does.
      // Always due on this token's very next tick regardless of age.
      null,
      record.signalStatus ?? null,
      record.narrativeConfidence ?? null,
      record.narrativeMatchMethod ?? null,
      // Item 5 (AI-training-pipeline proposal audit) — ?? null, not a
      // default false: undefined here means "never checked," a
      // genuinely different claim from "checked and it's revoked."
      record.firstMintAuthorityHeld ?? null,
      record.firstFreezeAuthorityHeld ?? null,
      record.pairCreatedAt ?? null,
    ],
  );
  return rows.length > 0 ? record : null; // already tracked
}

/**
 * Overwrites a tracked token's non-snapshot fields wholesale, same as the
 * original — patternReviewer.js reads, computes the full next state
 * (current price, ATH), and calls this with the entire record. Snapshot
 * history is appended separately via appendSnapshot, not part of this.
 */
async function updateTrackedToken(pairAddress, nextRecord) {
  const { rows } = await query(
    `UPDATE tracked_tokens SET
       mint_address = $2, base_token = $3, narrative_tag = $4,
       hype_score_at_qualification = $5, risk_level_at_qualification = $6, signal_label = $7,
       qualified_at = $8, first_price_usd = $9, ath_price_usd = $10, ath_at = $11,
       last_price_usd = $12, last_checked_at = $13, first_top_holder_pct = $14, first_lp_locked_pct = $15,
       last_below_survival_threshold_at = $16, last_reviewed_at = $17, signal_status = $18,
       narrative_confidence = $19, narrative_match_method = $20,
       first_mint_authority_held = $21, first_freeze_authority_held = $22, pair_created_at = $23
     WHERE pair_address = $1
     RETURNING *`,
    [
      pairAddress, nextRecord.mintAddress, JSON.stringify(nextRecord.baseToken), nextRecord.narrativeTag,
      nextRecord.hypeScoreAtQualification, nextRecord.riskLevelAtQualification, nextRecord.signalLabel ?? null,
      nextRecord.qualifiedAt, nextRecord.firstPriceUsd, nextRecord.athPriceUsd, nextRecord.athAt,
      nextRecord.lastPriceUsd, nextRecord.lastCheckedAt, nextRecord.firstTopHolderPct, nextRecord.firstLpLockedPct,
      nextRecord.lastBelowSurvivalThresholdAt ?? null,
      nextRecord.lastReviewedAt ?? null,
      nextRecord.signalStatus ?? null,
      nextRecord.narrativeConfidence ?? null,
      nextRecord.narrativeMatchMethod ?? null,
      // Item 5 (AI-training-pipeline proposal audit) — carried through
      // unchanged, same reasoning as firstTopHolderPct/firstLpLockedPct
      // just above (nextRecord spreads the original tracked-token record
      // first, in patternReviewer.js, so this is never recomputed here).
      nextRecord.firstMintAuthorityHeld ?? null,
      nextRecord.firstFreezeAuthorityHeld ?? null,
      nextRecord.pairCreatedAt ?? null,
    ],
  );
  return rows.length > 0 ? nextRecord : null;
}

async function removeTrackedToken(pairAddress) {
  const { rows } = await query('DELETE FROM tracked_tokens WHERE pair_address = $1 RETURNING pair_address', [pairAddress]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------
// Snapshots (Phase 2) — append-only price/safety history for a token,
// while it's actively tracked AND after it archives. Forensic
// preservation fix: this used to be deleted the instant a token
// archived (ON DELETE CASCADE against tracked_tokens) on the theory that
// pattern_archive's summary fields covered everything a completed token
// needed — see schema.sql's comment on the `snapshots` table for why
// that stopped being true and what changed. Rows already written under
// the old behavior for tokens that archived before this fix are gone;
// this only protects every token that archives from here forward.
// ---------------------------------------------------------------------

/**
 * Appends one snapshot, then prunes anything beyond the most recent
 * `patternTracking.maxCheckpointsPerToken` rows for this pair.
 *
 * That cap existed pre-Phase-2 purely to bound a single JSON file's size
 * (the config comment said so directly) — a normalized Postgres table
 * doesn't have that constraint, and at the default 3h review interval a
 * token hits its `maxTrackingAgeMs` long before accumulating enough rows
 * for table size to matter. It's kept here anyway as a defensive cap
 * against misconfiguration (e.g. someone sets a very long
 * maxTrackingAgeMs with a very short reviewIntervalMs) rather than
 * removed outright — cheap insurance, not a load-bearing constraint.
 */
async function appendSnapshot(pairAddress, snapshot) {
  await query(
    `INSERT INTO snapshots (pair_address, t, price_usd, top_holder_pct, lp_locked_pct, volume_1h, buys_1h, sells_1h, mint_authority_held, freeze_authority_held)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      pairAddress, snapshot.t, snapshot.priceUsd, snapshot.topHolderPct, snapshot.lpLockedPct,
      snapshot.volume1h ?? null, snapshot.buys1h ?? null, snapshot.sells1h ?? null,
      // Item 5 (AI-training-pipeline proposal audit) — ?? null (not
      // false): a caller that doesn't pass this at all (e.g. an older
      // call site, or a review cycle where Rugcheck was unavailable)
      // means "not checked this cycle," not "checked and revoked."
      snapshot.mintAuthorityHeld ?? null, snapshot.freezeAuthorityHeld ?? null,
    ],
  );
  await query(
    `DELETE FROM snapshots WHERE id IN (
       SELECT id FROM snapshots WHERE pair_address = $1 ORDER BY t DESC OFFSET $2
     )`,
    [pairAddress, patternTracking.maxCheckpointsPerToken],
  );
}

async function getSnapshotCount(pairAddress) {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM snapshots WHERE pair_address = $1', [pairAddress]);
  return rows[0].n;
}

async function getLatestSnapshot(pairAddress) {
  const { rows } = await query(
    'SELECT * FROM snapshots WHERE pair_address = $1 ORDER BY t DESC LIMIT 1',
    [pairAddress],
  );
  if (!rows[0]) return null;
  return rowToSnapshot(rows[0]);
}

/**
 * AUDIT FIX (rug_mechanism misclassification): the archiving cycle's
 * *literal* most recent snapshot row (getLatestSnapshot above) can have
 * topHolderPct/lpLockedPct = null just because THIS SPECIFIC cycle's
 * Rugcheck call failed or was unavailable — which is common precisely
 * because a rug event is often the same moment a token's pool vanishes or
 * gets delisted from an indexer, so a Rugcheck miss is plausibly
 * correlated with the archiving cycle, not independent of it.
 * buildArchiveRecord (patternReviewer.js) was feeding that single-row
 * value straight into classifyRugMechanism (patternAnalyzer.js), which
 * can't distinguish "never had data across the tracked lifetime" from
 * "had good data for the last N checkpoints, but this one API call
 * happened to fail" — both collapsed to null and got tagged what's now
 * called 'unknown-mechanism-data-gap' (see patternAnalyzer.js's
 * classifyRugMechanism — that label has since been split from a plain
 * 'unknown-mechanism' to also distinguish it from the separate, more
 * common 'unknown-mechanism-no-review' case, a token with ZERO tracked
 * checkpoints at all), even when the config/code comments explicitly say
 * that label should only fire when there's no safety data across the
 * whole tracked lifetime.
 *
 * Fix: look up each field's own last NON-NULL reading independently
 * (topHolderPct and lpLockedPct can go stale on different cycles from
 * each other, e.g. only one of the two Rugcheck-derived fields was
 * missing), rather than the value carried by whichever row happens to be
 * newest overall. One query, not two — same reasoning as
 * getArchiveForCategory's docstring above about not re-fetching more
 * than the caller needs.
 */
async function getLastKnownSafetyReading(pairAddress) {
  const { rows } = await query(
    `SELECT
       (SELECT top_holder_pct FROM snapshots WHERE pair_address = $1 AND top_holder_pct IS NOT NULL ORDER BY t DESC LIMIT 1) AS top_holder_pct,
       (SELECT lp_locked_pct  FROM snapshots WHERE pair_address = $1 AND lp_locked_pct  IS NOT NULL ORDER BY t DESC LIMIT 1) AS lp_locked_pct,
       (SELECT mint_authority_held   FROM snapshots WHERE pair_address = $1 AND mint_authority_held   IS NOT NULL ORDER BY t DESC LIMIT 1) AS mint_authority_held,
       (SELECT freeze_authority_held FROM snapshots WHERE pair_address = $1 AND freeze_authority_held IS NOT NULL ORDER BY t DESC LIMIT 1) AS freeze_authority_held`,
    [pairAddress],
  );
  return {
    topHolderPct: rows[0].top_holder_pct,
    lpLockedPct: rows[0].lp_locked_pct,
    // Item 5 (AI-training-pipeline proposal audit) — same "each field's
    // own last non-null value independently" approach as the two above;
    // `IS NOT NULL` correctly picks up a real `false` reading (revoked),
    // only skipping genuine "not checked this cycle" gaps.
    mintAuthorityHeld: rows[0].mint_authority_held,
    freezeAuthorityHeld: rows[0].freeze_authority_held,
  };
}

/**
 * Full snapshot history for a pair, oldest first. Used by
 * featureExtraction.js (Tier 2, Phase 5) to derive holder-concentration
 * trend, LP-lock trend, and buy/volume acceleration between checkpoints.
 */
async function getSnapshots(pairAddress) {
  const { rows } = await query(
    'SELECT * FROM snapshots WHERE pair_address = $1 ORDER BY t ASC',
    [pairAddress],
  );
  return rows.map(rowToSnapshot);
}

function rowToSnapshot(r) {
  return {
    t: r.t,
    priceUsd: r.price_usd,
    topHolderPct: r.top_holder_pct,
    lpLockedPct: r.lp_locked_pct,
    // NULL on any row written before Tier 2 added these columns — callers
    // (featureExtraction.js) must treat null here as "unknown," not zero.
    volume1h: r.volume_1h,
    buys1h: r.buys_1h,
    sells1h: r.sells_1h,
    // Item 5 (AI-training-pipeline proposal audit) — NULL on any row
    // written before this shipped, same "unknown, not a guessed value"
    // reasoning as volume1h/buys1h/sells1h just above.
    mintAuthorityHeld: r.mint_authority_held,
    freezeAuthorityHeld: r.freeze_authority_held,
  };
}

// ---------------------------------------------------------------------
// Archive (permanent historical record)
// ---------------------------------------------------------------------

async function getArchive() {
  const { rows } = await query('SELECT * FROM pattern_archive ORDER BY id');
  return rows.map(rowToArchiveRecord);
}

/**
 * AUDIT FIX (performance): tokenScanner.js calls patternAnalyzer's
 * predictForCategory once per QUALIFYING TOKEN, every ~30s scan cycle —
 * and predictForCategory only ever needs the records matching ONE
 * categoryKey. Previously it was handed the result of getArchive() above,
 * which pulls the ENTIRE pattern_archive table (unbounded, and by design
 * never pruned — see schema.sql/README) into memory and filters it down in
 * JS on every call. That's fine for the admin/report commands (infrequent,
 * genuinely need the whole table), but in the scan loop's hot path it means
 * a busy deployment re-fetches and re-filters a growing table dozens of
 * times a minute for data that idx_pattern_archive_category_key already
 * indexes directly.
 *
 * Same row shape/mapping as getArchive() (rowToArchiveRecord) — callers
 * that used to do `archive.filter(r => r.categoryKey === categoryKey)` can
 * swap in this function and skip the filter (predictForCategory still
 * re-filters defensively, which is a no-op here and costs nothing).
 */
async function getArchiveForCategory(categoryKey) {
  const { rows } = await query(
    'SELECT * FROM pattern_archive WHERE category_key = $1 ORDER BY id',
    [categoryKey],
  );
  return rows.map(rowToArchiveRecord);
}

/**
 * Same performance reasoning as getArchiveForCategory above, for
 * narrativeIntelligence.js's findSimilarHistoricalTokens: it's also called
 * once per qualifying token every scan cycle, but needs every archived
 * record for the narrative (not narrowed to one hype bucket like
 * categoryKey does) so it has the full spread of historical hype scores to
 * score closeness against. Filtering by narrative_tag in the query, using
 * idx_pattern_archive_narrative_tag, avoids pulling the entire table.
 */
async function getArchiveForNarrative(narrativeTag) {
  const { rows } = await query(
    'SELECT * FROM pattern_archive WHERE narrative_tag = $1 ORDER BY id',
    [narrativeTag],
  );
  return rows.map(rowToArchiveRecord);
}

/**
 * Shared INSERT so both appendArchiveRecord (plain pool query) and
 * archiveAndRemoveTrackedToken (same statement run against a transaction
 * client) stay in sync from one copy of the SQL instead of two that could
 * drift. `exec` is anything with a (text, params) => {rows} signature —
 * either the pool-level `query` or a pg Client's bound `.query`.
 */
async function insertArchiveRecord(exec, record) {
  const { rows } = await exec(
    `INSERT INTO pattern_archive (
       pair_address, mint_address, symbol, name, narrative_tag,
       hype_score_at_qualification, risk_level_at_qualification, signal_label, category_key,
       qualified_at, first_price_usd, ath_price_usd, ath_at, final_price_usd, peak_roi_multiple,
       outcome, archived_at, time_to_rug_from_qualification_hours, time_to_rug_from_ath_hours,
       checkpoint_count, first_top_holder_pct, last_top_holder_pct, first_lp_locked_pct, last_lp_locked_pct,
       outcome_detail, peak_roi_bucket, time_to_ath_from_qualification_hours, rug_mechanism, signal_status,
       rug_mechanism_confidence, rug_mechanism_evidence, narrative_confidence, narrative_match_method,
       first_mint_authority_held, last_mint_authority_held, first_freeze_authority_held, last_freeze_authority_held,
       pair_created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
     RETURNING *`,
    [
      record.pairAddress, record.mintAddress, record.symbol, record.name, record.narrativeTag,
      record.hypeScoreAtQualification, record.riskLevelAtQualification, record.signalLabel ?? null, record.categoryKey,
      record.qualifiedAt, record.firstPriceUsd, record.athPriceUsd, record.athAt, record.finalPriceUsd, record.peakRoiMultiple,
      record.outcome, record.archivedAt, record.timeToRugFromQualificationHours, record.timeToRugFromAthHours,
      record.checkpointCount, record.firstTopHolderPct, record.lastTopHolderPct, record.firstLpLockedPct, record.lastLpLockedPct,
      record.outcomeDetail ?? null, record.peakRoiBucket ?? null, record.timeToAthFromQualificationHours ?? null, record.rugMechanism ?? null,
      record.signalStatus ?? null,
      record.rugMechanismConfidence ?? null,
      // JSONB column — stringify a real object, but pass a raw null
      // through as-is rather than stringifying it into the text "null"
      // (pg handles a genuine null parameter for a JSONB column
      // correctly on its own; JSON.stringify(null) would instead insert
      // the JSON string "null", a subtly different, wrong value).
      record.rugMechanismEvidence ? JSON.stringify(record.rugMechanismEvidence) : null,
      record.narrativeConfidence ?? null,
      record.narrativeMatchMethod ?? null,
      // Item 5 (AI-training-pipeline proposal audit) — same first/last
      // pattern as firstTopHolderPct/lastTopHolderPct etc. above.
      record.firstMintAuthorityHeld ?? null,
      record.lastMintAuthorityHeld ?? null,
      record.firstFreezeAuthorityHeld ?? null,
      record.lastFreezeAuthorityHeld ?? null,
      record.pairCreatedAt ?? null,
    ],
  );
  return rowToArchiveRecord(rows[0]);
}

async function appendArchiveRecord(record) {
  return insertArchiveRecord(query, record);
}

/**
 * Archives a completed token and removes it from active tracking as one
 * atomic operation. Previously these were two separate queries called
 * back to back from patternReviewer.js; if the process died in between,
 * the token stayed in tracked_tokens and got archived *again* on the next
 * review cycle, leaving a permanent duplicate row in pattern_archive
 * (nothing prunes that table by design, so the duplicate — and the skew
 * it introduces into self-assessment stats and historical predictions —
 * would never get cleaned up). Wrapping both statements in a single
 * withTransaction call closed THAT gap: either both happen or neither
 * does within one call.
 *
 * AUDIT FIX (still a live bug even after the above): the single-call
 * atomicity fix does nothing to stop TWO concurrent calls for the SAME
 * pairAddress — e.g. two processes briefly overlapping (a duplicate
 * Railway service, or a rolling-deploy window) each independently
 * deciding the same tracked token should be archived this cycle. With
 * INSERT-then-DELETE, both calls' inserts can succeed (no unique
 * constraint on pattern_archive.pair_address) before either has deleted
 * the tracked_tokens row — reproduced directly with two real concurrent
 * calls against Postgres, see test/regression.test.js's "two concurrent
 * archiveAndRemoveTrackedToken callers" case. Fixed by reordering to
 * DELETE first, then gating the archive INSERT on the delete's own row
 * count: only the caller that actually removed the tracked_tokens row
 * (rowCount === 1) is allowed to insert the archive row. The other
 * caller's DELETE affects 0 rows (the first caller already removed it,
 * still inside its own transaction or having just committed), so it
 * skips the insert entirely and returns null rather than reporting a
 * second archive. Callers must treat a null return as "already archived
 * by someone else this cycle," not as a failure — see
 * patternReviewer.js's call site.
 *
 * This is the row-level half of the duplicate-archive defense; see
 * src/db/advisoryLock.js for the process-level half (stopping a second
 * process from ever reaching this code concurrently in the first place).
 * Keep both — the advisory lock is best-effort/non-blocking and this is
 * the backstop if a lock is ever bypassed, held elsewhere, or simply not
 * yet deployed everywhere that calls this function.
 *
 * The DELETE below only ever touches tracked_tokens. Since the forensic
 * preservation fix, snapshots is no longer FK'd to tracked_tokens (see
 * schema.sql), so this token's snapshot history is untouched by it and
 * remains queryable via getSnapshots(pairAddress) after archiving —
 * deliberately, not as a side effect.
 */
async function archiveAndRemoveTrackedToken(archiveRecord, pairAddress) {
  return withTransaction(async (client) => {
    const deleteResult = await client.query('DELETE FROM tracked_tokens WHERE pair_address = $1', [pairAddress]);
    if (deleteResult.rowCount === 0) return null; // lost the race — someone else already archived/removed this token
    return insertArchiveRecord(client.query.bind(client), archiveRecord);
  });
}

// ---------------------------------------------------------------------
// Wallet clustering (Tier 1) — see schema.sql's token_holders comment for
// why this is intentionally NOT scoped to pattern-tracked tokens and NOT
// cleaned up when a token gets archived. Persisted once per qualifying
// token from data already fetched for the safety gate (tokenScanner.js) —
// no extra Rugcheck calls.
// ---------------------------------------------------------------------

/**
 * Records one qualifying token's top-holder wallets. Own function (not
 * folded into enrollToken) because this runs for EVERY token that reaches
 * an alert, independent of patternTracking.enabled/shouldTrack — see
 * tokenScanner.js's call site, right after the safety gate passes.
 *
 * Idempotent via ON CONFLICT (pair_address, wallet_owner): a process
 * restart mid-scan-cycle re-qualifying the same pair (alertedPairs is
 * in-memory only — see tokenScanner.js's own comment on that) upserts
 * rather than duplicating rows.
 *
 * No-op on an empty/missing holders list rather than erroring — a token
 * with no usable wallet-level holder data (extractTopHolderWallets
 * filtered everything out, or Rugcheck's topHolders was empty) simply
 * contributes nothing to clustering, same "never fabricate, never throw
 * on missing data" posture as the rest of this pipeline.
 *
 * @param {string} pairAddress
 * @param {string} mintAddress
 * @param {Array<{owner: string, pct: number, insider: boolean|null}>} holders
 * @param {number} capturedAt - epoch ms
 */
async function recordTokenHolders(pairAddress, mintAddress, holders, capturedAt) {
  if (!Array.isArray(holders) || holders.length === 0) return;
  for (const h of holders) {
    await query(
      `INSERT INTO token_holders (pair_address, mint_address, wallet_owner, pct, insider, captured_at, first_captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (pair_address, wallet_owner)
       DO UPDATE SET pct = EXCLUDED.pct, insider = EXCLUDED.insider, captured_at = EXCLUDED.captured_at`,
      [pairAddress, mintAddress, h.owner, h.pct, h.insider ?? null, capturedAt],
    );
  }
}

/**
 * Given a set of wallet owners (typically the top holders just captured
 * for a newly-qualifying token, via recordTokenHolders above), finds which
 * of them have appeared as a top holder across at least `minTokenCount`
 * DISTINCT launches — i.e. genuinely recurring wallets, not "we've only
 * ever seen this wallet on the token qualifying right now." Call this
 * AFTER recordTokenHolders has inserted the current token's own rows, so
 * the current pair_address is already counted — a wallet found only on
 * today's token naturally has token_count = 1 and fails the >= 2 default,
 * no separate "exclude the current pair" filtering needed.
 *
 * @param {string[]} owners
 * @param {number} [minTokenCount=2]
 * @returns {Promise<Array<{ walletOwner: string, tokenCount: number, pairAddresses: string[] }>>}
 */
async function getRecurringWalletsAmong(owners, minTokenCount = 2) {
  if (!Array.isArray(owners) || owners.length === 0) return [];
  const { rows } = await query(
    `SELECT wallet_owner, COUNT(DISTINCT pair_address)::int AS token_count,
            ARRAY_AGG(DISTINCT pair_address ORDER BY pair_address) AS pair_addresses
     FROM token_holders
     WHERE wallet_owner = ANY($1::text[])
     GROUP BY wallet_owner
     HAVING COUNT(DISTINCT pair_address) >= $2
     ORDER BY token_count DESC`,
    [owners, minTokenCount],
  );
  return rows.map((r) => ({ walletOwner: r.wallet_owner, tokenCount: r.token_count, pairAddresses: r.pair_addresses }));
}

/**
 * Given a set of wallet owners (a token's current top holders) and that
 * token's own qualifiedAt (ms), finds which of those wallets were ALSO a
 * top holder of some OTHER token that had already been archived as
 * 'rugged' strictly before this token's own qualification. This is the
 * function flipBaseline.js's header comment has referenced since the
 * exposure-augmented baseline comparison was first written — it never
 * actually existed until now, which is why that comparison has been
 * running all along against an always-undefined field (walletExposedWallet
 * Count), silently bucketing every row as "clean" regardless of reality.
 * See flipBaseline.js's own header for the full history of that gap.
 *
 * Deliberately built on token_holders (Tier 1, already populated by
 * recordTokenHolders on every qualifying token, same table
 * getRecurringWalletsAmong already reads) rather than early_wallet_activity
 * (Tier 2, the Helius-signature-walk backfill) — the latter is confirmed
 * unpopulated in production (see flipFeatureModel.js's header: "captured in
 * schema, never actually populated"). This intentionally answers a
 * narrower question than the eventual Tier 2 wallet-intelligence work will
 * — "was this wallet a TOP HOLDER of a rug" rather than "did this wallet
 * genuinely trade/profit from a rug's launch window" — but it's a real,
 * populated, leakage-safe signal available today, rather than a comment
 * pointing at a table with zero rows.
 *
 * LEAKAGE SAFETY, the same principle as computeObservedPeak/embargo
 * elsewhere in this project: archived_at < beforeMs is a strict cutoff, not
 * <=, so a rug archived at the exact same millisecond as this token's own
 * qualification never counts as "prior" — this must only ever look
 * backward from the current token's own qualification instant, never
 * sideways or forward, or the resulting feature would leak the very
 * outcome information the flip-tier model is trying to predict.
 *
 * @param {string[]} owners
 * @param {number} beforeMs - the current token's own qualifiedAt; only rugs
 *   archived strictly before this count as "prior" exposure.
 * @returns {Promise<{ exposedWallets: string[], exposureCount: number }>}
 */
async function listPriorRuggedWalletExposureFor(owners, beforeMs) {
  if (!Array.isArray(owners) || owners.length === 0 || !Number.isFinite(beforeMs)) return { exposedWallets: [], exposureCount: 0 };
  const { rows } = await query(
    `SELECT DISTINCT th.wallet_owner
     FROM token_holders th
     JOIN pattern_archive pa ON pa.pair_address = th.pair_address
     WHERE th.wallet_owner = ANY($1::text[])
       AND pa.outcome = 'rugged'
       AND pa.archived_at < $2`,
    [owners, beforeMs],
  );
  const exposedWallets = rows.map((r) => r.wallet_owner);
  return { exposedWallets, exposureCount: exposedWallets.length };
}

// ---------------------------------------------------------------------
// Wallet-enhanced flip shadow model — experienced-wallet features.
// Shadow-only, additive alongside getRecurringWalletsAmong/
// listPriorRuggedWalletExposureFor above, same token_holders table, same
// "store owns the SQL" split. Answers a different question from both:
// not "is this wallet recurring at all" (getRecurringWalletsAmong) or
// "was this wallet previously exposed to a RUG specifically"
// (listPriorRuggedWalletExposureFor), but "how many DISTINCT OTHER pairs
// had this wallet already been recorded as a top holder of, strictly
// BEFORE this token's own qualification instant" — i.e. genuine prior
// launch experience, independent of any rug outcome.
// ---------------------------------------------------------------------

/**
 * Reconstructs a token's own top-holder wallet set AS OF qualification
 * time, directly from token_holders — needed for OFFLINE historical
 * reconstruction (the wallet-enhanced flip dataset builder), where there
 * is no live Rugcheck `holders` array to read, unlike tokenScanner.js's
 * live qualification path (which already has one fetched moments earlier
 * for the same purpose recordTokenHolders/getRecurringWalletsAmong use).
 *
 * Reconstructs the LATEST complete scan of this pair's holders as of
 * qualification — not a union of every historical captured_at <=
 * qualifiedAt row for this pair. A pair can have holder rows from
 * multiple scans over time (a token that spent several cycles under
 * observation before alerting, or before this function is used for
 * offline reconstruction — see tokenScanner.js's wallet-clustering block,
 * which reruns on every scan cycle a token passes market/safety gates,
 * not just its first), and because recordTokenHolders upserts on
 * (pair_address, wallet_owner), a wallet who WAS a top holder in an
 * earlier scan but had already sold out/dropped off the top-holders list
 * by a LATER scan still has a row here — its captured_at just stops
 * advancing. Unioning every such row (this function's original
 * implementation) would incorrectly count that wallet as "currently"
 * associated with the token at qualification, when the most recent
 * observation says otherwise. Taking only the rows whose captured_at
 * equals the MAX(captured_at) among this pair's rows at-or-before
 * qualifiedAt reconstructs the single latest snapshot instead — verified
 * directly: a stale, superseded holder is correctly excluded, a holder
 * from the genuinely latest scan is correctly included, and a
 * strictly-future rescan (captured_at > qualifiedAtMs) is correctly
 * excluded from the MAX() itself, not just filtered after the fact.
 *
 * captured_at <= qualifiedAtMs, not strictly <, in the inner MAX(): in the
 * live path, recordTokenHolders writes THIS pair's own rows with
 * captured_at === the same instant used as this token's own qualifiedAt
 * (see tokenScanner.js) — a strict cutoff would wrongly exclude a
 * token's own just-captured holder rows from its own reconstruction.
 *
 * This is deliberately a DIFFERENT temporal strategy from
 * getWalletExperienceAmong just below, which uses first_captured_at (the
 * original, never-overwritten observation instant) rather than captured_at
 * (the latest, upserted one) for its cross-pair comparison — the two
 * functions are answering genuinely different questions ("what does this
 * pair's holder set look like right now" vs. "was this wallet ever first
 * seen on that other pair before some cutoff"), and conflating them was
 * the root of a real, confirmed under-counting bug in the other direction
 * — see that function's own header for the full reasoning.
 *
 * @param {string} pairAddress
 * @param {number} qualifiedAtMs - epoch ms
 * @returns {Promise<string[]>} wallet_owner values
 */
async function getWalletOwnersAtQualification(pairAddress, qualifiedAtMs) {
  if (!pairAddress || !Number.isFinite(qualifiedAtMs)) return [];
  const { rows } = await query(
    `SELECT wallet_owner
     FROM token_holders
     WHERE pair_address = $1
       AND captured_at = (
         SELECT MAX(captured_at)
         FROM token_holders
         WHERE pair_address = $1
           AND captured_at <= $2
       )`,
    [pairAddress, qualifiedAtMs],
  );
  return rows.map((r) => r.wallet_owner);
}

/**
 * Given a set of wallet owners (a token's own top holders, as of
 * qualification) and that token's own qualifiedAt, computes how many
 * distinct OTHER pairs each wallet had already been recorded as a top
 * holder of, strictly before qualification — then rolls that up into the
 * three wallet-enhanced flip shadow model features.
 *
 * Filters on first_captured_at, NOT captured_at — this is load-bearing,
 * not a stylistic choice, and was the root cause of a real, confirmed bug
 * in an earlier version of this function. captured_at is upserted on
 * every rescan (see recordTokenHolders), so it only ever reflects a
 * pair's MOST RECENT observation, not when a wallet's association with it
 * was first seen. Using captured_at < qualifiedAtMs here meant: if wallet
 * W was genuinely a top holder of pair A back at time T1 (well before
 * some later token C's own qualifiedAt), but pair A got rescanned again
 * at T3 > C's qualifiedAt (e.g. A was still under multi-cycle observation
 * — tokenScanner.js's wallet-clustering block reruns on every scan cycle
 * a token passes market/safety gates, not just its first), then OFFLINE
 * reconstruction of C's features done AFTER T3 would see A's captured_at
 * = T3, fail the < qualifiedAtMs check, and silently under-count W's
 * genuine prior experience — even though W's real association with A was
 * never in question. Confirmed directly: the identical query, with the
 * identical qualifiedAt cutoff, returned a DIFFERENT (wrong) answer
 * depending solely on whether it ran before or after an unrelated later
 * rescan of a different token. This is always an UNDER-count, never a
 * leak — first_captured_at is set once at INSERT and never touched again
 * (see recordTokenHolders' ON CONFLICT clause), so it can never advance
 * past a value that was genuinely true at the time, only stay fixed at
 * the true first-seen instant while captured_at keeps moving forward
 * underneath it on every rescan. See the column's own comment in
 * schema.sql for why it exists as a separate column at all rather than
 * trying to recover this from captured_at's history some other way.
 *
 * LEAKAGE SAFETY — same strict-cutoff principle as
 * listPriorRuggedWalletExposureFor just above: first_captured_at <
 * qualifiedAtMs is a STRICT cutoff (never <=) for OTHER pairs, and
 * pairAddress <> currentPairAddress is an explicit exclusion on top of
 * that, not merely an incidental effect of the strict inequality — a
 * rescan that bumped the current pair's own token_holders.captured_at (or
 * even, adversarially, its first_captured_at, which never happens in
 * practice but isn't relied upon not to) must never let the current pair
 * count as its own "prior" experience (this is the "current token's
 * qualifying pair must not count as a prior pair" requirement). This must
 * only ever look backward from the current token's own qualification
 * instant, never sideways or forward, or the resulting feature would leak
 * the very outcome information the wallet-enhanced model is trying to
 * predict — same principle as listPriorRuggedWalletExposureFor's own
 * leakage-safety comment.
 *
 * owners is de-duplicated before counting — extractTopHolderWallets
 * doesn't guarantee unique owners (a wallet could theoretically hold more
 * than one associated token account among the top holders), and this must
 * count each DISTINCT wallet once, not once per holder-row it appears in.
 *
 * Missing/empty inputs return safe all-zero values rather than throwing —
 * same "never fabricate, never throw on missing data" posture as the rest
 * of this store.
 *
 * @param {string[]} owners - wallet_owner values for the CURRENT token's
 *   own top holders (same input shape as getRecurringWalletsAmong /
 *   listPriorRuggedWalletExposureFor).
 * @param {string} currentPairAddress - the qualifying token's own
 *   pair_address; excluded from every wallet's prior-pair count.
 * @param {number} qualifiedAtMs - the current token's own qualifiedAt;
 *   only token_holders rows FIRST captured strictly before this, for
 *   pairs other than currentPairAddress, count as "prior."
 * @returns {Promise<{ experiencedWalletCount5Plus: number, experiencedWalletCount10Plus: number, maxWalletExperience: number, walletPriorPairCounts: Record<string, number> }>}
 */
async function getWalletExperienceAmong(owners, currentPairAddress, qualifiedAtMs) {
  const empty = { experiencedWalletCount5Plus: 0, experiencedWalletCount10Plus: 0, maxWalletExperience: 0, walletPriorPairCounts: {} };
  if (!Array.isArray(owners) || owners.length === 0 || !currentPairAddress || !Number.isFinite(qualifiedAtMs)) return empty;
  const uniqueOwners = [...new Set(owners)];
  const { rows } = await query(
    `SELECT wallet_owner, COUNT(DISTINCT pair_address)::int AS prior_pair_count
     FROM token_holders
     WHERE wallet_owner = ANY($1::text[])
       AND pair_address <> $2
       AND first_captured_at < $3
     GROUP BY wallet_owner`,
    [uniqueOwners, currentPairAddress, qualifiedAtMs],
  );
  const walletPriorPairCounts = {};
  for (const r of rows) walletPriorPairCounts[r.wallet_owner] = r.prior_pair_count;
  let experiencedWalletCount5Plus = 0;
  let experiencedWalletCount10Plus = 0;
  let maxWalletExperience = 0;
  for (const owner of uniqueOwners) {
    const count = walletPriorPairCounts[owner] || 0;
    if (count >= 5) experiencedWalletCount5Plus += 1;
    if (count >= 10) experiencedWalletCount10Plus += 1;
    if (count > maxWalletExperience) maxWalletExperience = count;
  }
  return { experiencedWalletCount5Plus, experiencedWalletCount10Plus, maxWalletExperience, walletPriorPairCounts };
}

/**
 * Convenience wrapper combining getWalletOwnersAtQualification +
 * getWalletExperienceAmong for OFFLINE historical reconstruction (one call
 * per historical row, keyed by that row's own pairAddress/qualifiedAt) —
 * see scripts/build-flip-dataset.js's wallet-experience join. The live
 * qualification path in tokenScanner.js does NOT use this: it already has
 * a freshly-fetched `holders` list in scope and calls
 * getWalletExperienceAmong directly with it, the same way it already
 * calls getRecurringWalletsAmong/listPriorRuggedWalletExposureFor with
 * that same list rather than re-querying what it just wrote.
 *
 * @param {string} pairAddress
 * @param {number} qualifiedAtMs - epoch ms
 */
async function getWalletExperienceFeaturesFor(pairAddress, qualifiedAtMs) {
  const owners = await getWalletOwnersAtQualification(pairAddress, qualifiedAtMs);
  return getWalletExperienceAmong(owners, pairAddress, qualifiedAtMs);
}

/**
 * Full cross-launch history for one wallet, oldest first — every token
 * it's been recorded as a top holder of. Not currently wired into any
 * command, but useful for an admin `/wallet <address>` lookup later
 * without needing another query shape.
 *
 * @param {string} walletOwner
 */
async function getWalletHistory(walletOwner) {
  const { rows } = await query(
    'SELECT * FROM token_holders WHERE wallet_owner = $1 ORDER BY captured_at ASC',
    [walletOwner],
  );
  return rows.map((r) => ({
    pairAddress: r.pair_address,
    mintAddress: r.mint_address,
    walletOwner: r.wallet_owner,
    pct: r.pct,
    insider: r.insider,
    capturedAt: r.captured_at,
  }));
}

// ---------------------------------------------------------------------
// Item 29 (early-wallet backfill, Stage 1) — see schema.sql's comment on
// early_wallet_activity and pattern_archive.early_wallet_checked_at for
// the full "why". Store-layer only; the walk/classification logic lives
// in scripts/backfill-early-wallets.js, same split as every other
// backfill script in this project (script owns the RPC/API work, the
// store owns the SQL).
// ---------------------------------------------------------------------

/**
 * Bulk-inserts the buyer/seller rows found for one token's launch window.
 * ON CONFLICT DO NOTHING (not an upsert) — unlike token_holders, a given
 * (pair_address, wallet_address, signature, role) is an immutable
 * historical fact once captured, so a re-run finding the same row again
 * is a genuine no-op, not a value that could have legitimately changed.
 * Safe to call with an empty array (e.g. a token whose window had zero
 * qualifying transactions) — matches recordTokenHolders' same no-op
 * posture for an empty list.
 *
 * @param {Array<{walletAddress: string, role: 'buyer'|'seller',
 *   tokenDelta: number, solAmount: number|null, isMeaningful: boolean,
 *   signature: string, blockTime: number|null}>} entries
 * @param {number} capturedAt - epoch ms
 */
async function recordEarlyWalletActivity(pairAddress, mintAddress, entries, capturedAt) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  for (const e of entries) {
    // Item 41: routed by wallet_address, not written to a single table —
    // see src/db/shardPool.js's header comment for why wallet_address is
    // the shard key. shardIndexFor returns 0 (the primary DB, via the
    // `query` this file already imports) when no extra shards are
    // configured, so this is a no-op change until EARLY_WALLET_SHARD_URLS
    // is actually set.
    const shardIndex = shardPool.shardIndexFor(e.walletAddress);
    await shardPool.queryShard(
      shardIndex,
      `INSERT INTO early_wallet_activity
         (pair_address, mint_address, wallet_address, role, token_delta, sol_amount,
          target_amount, target_decimals, input_mint, input_amount_raw, input_amount, input_decimals,
          output_mint, output_amount_raw, output_amount, output_decimals, value_usd, value_sol,
          value_source, economic_confidence, route, evidence, is_meaningful, signature, block_time, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22::jsonb, $23, $24, $25, $26)
       ON CONFLICT (pair_address, wallet_address, signature, role) DO NOTHING`,
      [
        pairAddress, mintAddress, e.walletAddress, e.role, e.tokenDelta, e.solAmount ?? null,
        e.targetAmount ?? null, e.targetDecimals ?? null,
        e.inputAsset?.mint ?? null, e.inputAsset?.rawAmount ?? null, e.inputAsset?.amount ?? null, e.inputAsset?.decimals ?? null,
        e.outputAsset?.mint ?? null, e.outputAsset?.rawAmount ?? null, e.outputAsset?.amount ?? null, e.outputAsset?.decimals ?? null,
        e.valueUsd ?? null, e.valueSol ?? null, e.valueSource ?? null, e.confidence ?? null,
        e.route ? JSON.stringify(e.route) : null, e.evidence ? JSON.stringify(e.evidence) : null,
        !!e.isMeaningful, e.signature, e.blockTime ?? null, capturedAt,
      ],
    );
  }
}

/**
 * Stamps pattern_archive.early_wallet_checked_at/early_wallet_status/
 * early_wallet_sig_pages_walked for one archive row (keyed by its `id`,
 * same as every other pattern_archive backfill in this project —
 * pair_address isn't unique on this table, see review-data-quality.js's
 * "Duplicate archive rows for the same token" check). Called
 * unconditionally for every row Stage 1 attempts, success or not — see
 * the columns' schema.sql comments for why that's what makes this
 * idempotent/resumable, same lesson as backfill-pair-created-at.js's
 * `pair_created_at_checked_at`.
 *
 * @param {number} id
 * @param {string} status - see schema.sql's early_wallet_status comment for the value set
 * @param {number} checkedAt - epoch ms
 * @param {number|null} [pagesWalked] - signature pages the walk spent on
 *   this row (0 is legitimate, e.g. a 'no-signatures' row); null if not
 *   applicable (e.g. an early error before any page was walked)
 */
async function markEarlyWalletChecked(id, status, checkedAt, pagesWalked = null, rugEventEvidence = []) {
  const events = Array.isArray(rugEventEvidence) ? rugEventEvidence : [];
  await query(
    'UPDATE pattern_archive SET early_wallet_checked_at = $1, early_wallet_status = $2, early_wallet_sig_pages_walked = $3, rug_event_evidence = $4::jsonb WHERE id = $5',
    [checkedAt, status, pagesWalked, JSON.stringify(events), id],
  );
}

/**
 * Given a set of wallet addresses (typically the meaningful early buyers
 * just recorded for one token), finds which of them show up as a
 * meaningful early buyer on at least `minTokenCount` DISTINCT launches —
 * the Stage 1 building block Stage 2/3 clustering needs. Deliberately
 * scoped to is_meaningful = true only (a dust-level incidental balance
 * change recurring across launches isn't the signal this is for); pass
 * an already-captured pair_address in `owners`' caller context the same
 * way getRecurringWalletsAmong expects the current token's own rows to
 * already be inserted before calling.
 *
 * @param {string[]} walletAddresses
 * @param {number} [minTokenCount=2]
 * @returns {Promise<Array<{ walletAddress: string, tokenCount: number, pairAddresses: string[] }>>}
 */
async function getRecurringEarlyWallets(walletAddresses, minTokenCount = 2) {
  if (!Array.isArray(walletAddresses) || walletAddresses.length === 0) return [];

  // Item 41: bucket the candidate wallets by the shard that owns them,
  // then run the SAME per-wallet aggregation against each involved
  // shard. This is safe as a plain concat (no merge/de-dup step needed)
  // specifically because wallet_address is the shard key — a given
  // wallet's entire history lives on exactly one shard, so each shard's
  // partial result set is already the complete, final answer for the
  // wallets it owns. See shardPool.js's header comment for why that
  // property doesn't hold for pair_address-keyed queries.
  const buckets = shardPool.bucketByShard(walletAddresses);
  const perShardResults = await Promise.all(
    Array.from(buckets.entries()).map(([shardIndex, addrs]) => shardPool.queryShard(
      shardIndex,
      `SELECT wallet_address, COUNT(DISTINCT pair_address)::int AS token_count,
              ARRAY_AGG(DISTINCT pair_address ORDER BY pair_address) AS pair_addresses
       FROM early_wallet_activity
       WHERE wallet_address = ANY($1::text[]) AND is_meaningful = TRUE AND role = 'buyer'
       GROUP BY wallet_address
       HAVING COUNT(DISTINCT pair_address) >= $2
       ORDER BY token_count DESC`,
      [addrs, minTokenCount],
    )),
  );

  const rows = perShardResults.flatMap((r) => r.rows);
  rows.sort((a, b) => b.token_count - a.token_count);
  return rows.map((r) => ({ walletAddress: r.wallet_address, tokenCount: r.token_count, pairAddresses: r.pair_addresses }));
}

/**
 * Fan-out lookup: every early_wallet_activity row for one pair_address,
 * across every shard. Unlike getRecurringEarlyWallets, a single token's
 * buyers/sellers are typically scattered across several shards (each
 * wallet routes independently), so this genuinely has to query all of
 * them and merge — there's no shard that's guaranteed to hold the whole
 * answer for a given pair_address. Low-traffic path (admin/diagnostic
 * use, not the scan loop), so the fan-out cost doesn't matter the way it
 * would on a hot path.
 *
 * @param {string} pairAddress
 * @returns {Promise<Array>}
 */

/**
 * Qualification-time current-token capital for a wallet population.
 * Uses transaction event time (`block_time`) and the same inclusive cutoff
 * convention used by the EDPI reporting path. NULL timestamps are excluded.
 */
async function getCurrentWalletCapitalSol(pairAddress, walletAddresses, qualificationTimeMs) {
  if (!pairAddress || !Array.isArray(walletAddresses) || walletAddresses.length === 0) return {};
  const cutoffMs = Number(qualificationTimeMs);
  if (!Number.isFinite(cutoffMs)) return {};
  const uniqueOwners = [...new Set(walletAddresses)];
  const buckets = shardPool.bucketByShard(uniqueOwners);
  const results = await Promise.all(
    Array.from(buckets.entries()).map(([shardIndex, addrs]) => shardPool.queryShard(
      shardIndex,
      `SELECT wallet_address,
              SUM(COALESCE(value_sol, sol_amount)) AS total_sol,
              COUNT(*) FILTER (WHERE COALESCE(value_sol, sol_amount) IS NULL)::int AS unknown_count
         FROM early_wallet_activity
        WHERE pair_address = $1
          AND wallet_address = ANY($2::text[])
          AND role = 'buyer'
          AND block_time IS NOT NULL
          AND block_time <= $3
        GROUP BY wallet_address`,
      [pairAddress, addrs, cutoffMs],
    )),
  );
  const byWallet = {};
  for (const { rows } of results) {
    for (const row of rows) byWallet[row.wallet_address] = Number(row.unknown_count) > 0 ? null : (row.total_sol === null ? null : Number(row.total_sol));
  }
  return byWallet;
}

async function getWalletEconomicEvidenceStats(walletAddress, beforeMs = null, currentPairAddress = null) {
  if (!walletAddress) return { relevantTransactions: 0, rows: 0 };
  const cutoff = beforeMs === null || beforeMs === undefined ? null : Number(beforeMs);
  if (cutoff !== null && !Number.isFinite(cutoff)) return { relevantTransactions: 0, rows: 0 };
  const shardIndex = shardPool.shardIndexFor(walletAddress);
  const { rows } = await shardPool.queryShard(
    shardIndex,
    `SELECT COUNT(DISTINCT signature)::int AS relevant_transactions,
            COUNT(*)::int AS rows
       FROM early_wallet_activity
      WHERE wallet_address = $1
        AND ($2::bigint IS NULL OR (block_time IS NOT NULL AND block_time < $2))
        AND ($3::text IS NULL OR pair_address <> $3)`,
    [walletAddress, cutoff, currentPairAddress || null],
  );
  const row = rows[0] || {};
  return {
    relevantTransactions: Number(row.relevant_transactions) || 0,
    rows: Number(row.rows) || 0,
  };
}

async function getEarlyWalletActivityForPair(pairAddress) {
  const results = await shardPool.queryAllShards(
    'SELECT * FROM early_wallet_activity WHERE pair_address = $1 ORDER BY wallet_address',
    [pairAddress],
  );
  return results.flatMap((r) => r.rows);
}

/**
 * EDPI-L (Live Empirical Data Pattern Inference) — Evidence Family 4,
 * "wallet previous activity." Given a token's own top-holder wallets
 * (the SAME `holders` list tokenScanner.js already fetched for the
 * wallet-clustering block above), checks early_wallet_activity for
 * genuine PRIOR trading history on OTHER pairs. Deliberately separate
 * from getRecurringEarlyWallets (which answers "which wallets recur
 * across launches" for the admin/diagnostic review script, with no
 * temporal cutoff or current-pair exclusion — appropriate for that
 * read-only reporting use, wrong for a live, point-in-time feature).
 *
 * LEAKAGE SAFETY: filters on `block_time` (the actual on-chain
 * transaction time, set once from the parsed transaction and never
 * rewritten — see schema.sql's comment on the column) strictly less
 * than `beforeMs`, not `captured_at` (when THIS backfill run happened to
 * write the row, which is unrelated to when the trade itself occurred
 * and would silently under- or over-count depending on backfill
 * timing). This is the same `first_captured_at`-not-`captured_at`
 * discipline docs/flip-wallet-shadow-experiment.md's "Audit findings"
 * section documents finding and fixing for token_holders — same bug
 * class, same fix, different table. A NULL block_time (blockTime absent
 * on the original signature) is excluded from both counts rather than
 * assumed to be "before" — conservative, since the point of this
 * cutoff is to never claim knowledge of something whose timing is
 * actually unknown.
 *
 * Two distinct counts per wallet, not one, because EDPI-L's
 * "historical wallet coverage" needs both: `anyPriorPairCount` answers
 * "do we have ANY recorded activity for this wallet at all" (coverage),
 * `meaningfulPriorPairCount` answers "how much of it was a genuine
 * meaningful entry" (the actual signal) — collapsing these into one
 * number would make a wallet with ten tiny/noise rows indistinguishable
 * from one with zero rows, which is exactly the "wallet noise vs.
 * meaningful trade" distinction the EDPI research spec insists on.
 *
 * Sharded the same way getRecurringEarlyWallets is (wallet_address is
 * the shard key for early_wallet_activity — see shardPool.js) — plain
 * per-shard concat is correct here for the same reason: a given
 * wallet's full history lives on exactly one shard.
 *
 * @param {string[]} owners - the qualifying token's own top-holder wallets
 * @param {string} currentPairAddress - excluded from "prior" (a token
 *   can never be its own history)
 * @param {number} beforeMs - epoch ms; only block_time < this counts
 * @returns {Promise<{
 *   walletsWithAnyHistory: number,
 *   walletsWithMeaningfulHistory: number,
 *   walletMeaningfulPriorPairCounts: Record<string, number>,
 *   recurringHistoricalWallets: Array<{walletAddress: string, meaningfulPriorPairCount: number}>,
 * }>}
 */
async function getEarlyWalletHistoryAmong(owners, currentPairAddress, beforeMs) {
  const empty = { walletsWithAnyHistory: 0, walletsWithMeaningfulHistory: 0, walletMeaningfulPriorPairCounts: {}, recurringHistoricalWallets: [] };
  if (!Array.isArray(owners) || owners.length === 0 || !currentPairAddress || !Number.isFinite(beforeMs)) return empty;
  const uniqueOwners = [...new Set(owners)];
  const buckets = shardPool.bucketByShard(uniqueOwners);
  const perShardResults = await Promise.all(
    Array.from(buckets.entries()).map(([shardIndex, addrs]) => shardPool.queryShard(
      shardIndex,
      `SELECT wallet_address,
              COUNT(DISTINCT pair_address) FILTER (WHERE block_time IS NOT NULL AND block_time < $3)::int AS any_prior_pair_count,
              COUNT(DISTINCT pair_address) FILTER (WHERE role = 'buyer' AND is_meaningful = TRUE AND block_time IS NOT NULL AND block_time < $3)::int AS meaningful_prior_pair_count
         FROM early_wallet_activity
        WHERE wallet_address = ANY($1::text[]) AND pair_address <> $2
        GROUP BY wallet_address`,
      [addrs, currentPairAddress, beforeMs],
    )),
  );
  let walletsWithAnyHistory = 0;
  let walletsWithMeaningfulHistory = 0;
  const walletMeaningfulPriorPairCounts = {};
  const recurringHistoricalWallets = [];
  for (const { rows } of perShardResults) {
    for (const r of rows) {
      if (r.any_prior_pair_count > 0) walletsWithAnyHistory += 1;
      if (r.meaningful_prior_pair_count > 0) {
        walletsWithMeaningfulHistory += 1;
        walletMeaningfulPriorPairCounts[r.wallet_address] = r.meaningful_prior_pair_count;
        recurringHistoricalWallets.push({ walletAddress: r.wallet_address, meaningfulPriorPairCount: r.meaningful_prior_pair_count });
      }
    }
  }
  recurringHistoricalWallets.sort((a, b) => b.meaningfulPriorPairCount - a.meaningfulPriorPairCount);
  return { walletsWithAnyHistory, walletsWithMeaningfulHistory, walletMeaningfulPriorPairCounts, recurringHistoricalWallets };
}

/**
 * The data source for EDPI-L's wallet-relative anomaly AND wallet
 * historical outcome profile (see src/core/edpiLive.js) — one function
 * because both need the exact same three-way join (a wallet's raw prior
 * meaningful trades, the market snapshot for each pair those trades were
 * on, and — new here — the eventual OUTCOME of each of those pairs), and
 * splitting it into separate round trips per consumer would just mean
 * fetching the same rows twice.
 *
 * THREE separate temporal-safety requirements, not one, and getting only
 * two of them right would still leak:
 *   1. `early_wallet_activity.block_time < beforeMs` — the wallet's OWN
 *      trade must have already happened (same requirement
 *      getEarlyWalletHistoryAmong already enforces the same way, for the
 *      same reason — see that function's header).
 *   2. `pair_address <> currentPairAddress` — a token can't be its own
 *      prior history.
 *   3. `pattern_archive.archived_at < beforeMs` — THIS ONE IS NEW AND
 *      EASY TO MISS: a wallet's trade on some pair P can satisfy (1) and
 *      still tell us NOTHING about P's eventual outcome at time
 *      `beforeMs`, because P's peak/rug/outcome is typically determined
 *      DAYS after the trade itself (see pattern_archive's `ath_at`/
 *      `archived_at` columns — both routinely long after `qualified_at`).
 *      Including P's outcome in a wallet's baseline at time `beforeMs`
 *      when P didn't actually FINISH archiving until AFTER `beforeMs`
 *      would leak information nobody could have had at that moment —
 *      the same class of bug docs/flip-wallet-shadow-experiment.md
 *      documents for token_holders, one hop further downstream (there
 *      it was "did we know about this wallet's prior activity yet";
 *      here it's "did we know how that prior activity turned out yet").
 *      `archived_at` (not `ath_at` alone) is used as this cutoff because
 *      it is the point every outcome field on the row — `outcome`,
 *      `peak_roi_multiple`, `ath_price_usd`, `time_to_ath_from_
 *      qualification_hours` — becomes the fixed, final value it holds
 *      today; pattern_archive rows are written once at archive time and
 *      not later revised (see patternReviewer.js's buildArchiveRecord —
 *      one INSERT, no corresponding UPDATE path), so this is a genuinely
 *      immutable, write-once timestamp, not a moving "last touched" one.
 *
 * Trades are returned RAW (one row per on-chain transaction) — grouping
 * into entry campaigns is edpiLive.js's job (groupTradesIntoCampaigns),
 * kept out of SQL so the grouping window stays a pure, testable,
 * recomputable-without-a-new-query parameter (see that function's
 * header) rather than something baked into this query.
 *
 * @param {string[]} owners
 * @param {string} currentPairAddress
 * @param {number} beforeMs
 * @returns {Promise<{
 *   trades: Array<{walletAddress, pairAddress, solAmount, tokenDelta, blockTime}>,
 *   snapshotsByPair: Record<string, {marketCapUsd, priceUsd, priceNative, mintAuthorityHeld, qualifiedAtMs}>,
 *   outcomesByPair: Record<string, {outcome, peakRoiMultiple, firstPriceUsd, athPriceUsd, athAtMs, archivedAtMs, qualifiedAtMs, timeToAthFromQualificationHours}>,
 * }>}
 */
async function getEarlyWalletTradesWithOutcomesAmong(owners, currentPairAddress, beforeMs) {
  const empty = { trades: [], snapshotsByPair: {}, outcomesByPair: {} };
  if (!Array.isArray(owners) || owners.length === 0 || !currentPairAddress || !Number.isFinite(beforeMs)) return empty;
  const uniqueOwners = [...new Set(owners)];
  const buckets = shardPool.bucketByShard(uniqueOwners);
  const perShardResults = await Promise.all(
    Array.from(buckets.entries()).map(([shardIndex, addrs]) => shardPool.queryShard(
      shardIndex,
      `SELECT wallet_address, pair_address, mint_address, role, sol_amount, token_delta,
                target_amount, target_decimals, input_mint, input_amount_raw, input_amount, input_decimals,
                output_mint, output_amount_raw, output_amount, output_decimals, value_usd, value_sol,
                value_source, economic_confidence, route, evidence, block_time
         FROM early_wallet_activity
        WHERE wallet_address = ANY($1::text[])
          AND pair_address <> $2
          AND role = 'buyer'
          AND is_meaningful = TRUE
          AND block_time IS NOT NULL
          AND block_time < $3`,
      [addrs, currentPairAddress, beforeMs],
    )),
  );
  const trades = [];
  const pairAddressSet = new Set();
  for (const { rows } of perShardResults) {
    for (const r of rows) {
      trades.push({
        walletAddress: r.wallet_address,
        pairAddress: r.pair_address,
        mintAddress: r.mint_address || null,
        role: r.role || null,
        solAmount: r.value_sol !== null ? Number(r.value_sol) : (r.sol_amount === null ? null : Number(r.sol_amount)),
        valueSol: r.value_sol === null ? (r.sol_amount === null ? null : Number(r.sol_amount)) : Number(r.value_sol),
        valueUsd: r.value_usd === null ? null : Number(r.value_usd),
        valueSource: r.value_source || null,
        confidence: r.economic_confidence || null,
        tokenDelta: Number(r.token_delta),
        targetAmount: r.target_amount === null ? null : Number(r.target_amount),
        targetDecimals: r.target_decimals === null ? null : Number(r.target_decimals),
        inputAsset: r.input_mint ? { mint: r.input_mint, rawAmount: r.input_amount_raw === null ? null : String(r.input_amount_raw), amount: r.input_amount === null ? null : Number(r.input_amount), decimals: r.input_decimals === null ? null : Number(r.input_decimals) } : null,
        outputAsset: r.output_mint ? { mint: r.output_mint, rawAmount: r.output_amount_raw === null ? null : String(r.output_amount_raw), amount: r.output_amount === null ? null : Number(r.output_amount), decimals: r.output_decimals === null ? null : Number(r.output_decimals) } : null,
        route: r.route || null,
        evidence: r.evidence || null,
        blockTime: Number(r.block_time),
      });
      pairAddressSet.add(r.pair_address);
    }
  }
  const pairAddresses = [...pairAddressSet];
  const snapshotsByPair = {};
  const outcomesByPair = {};
  if (pairAddresses.length > 0) {
    // alert_decisions is NOT sharded (pair_address is not its shard key —
    // only early_wallet_activity/token_holders are wallet-sharded), hence
    // the plain `query`, not shardPool, for these two.
    const snapshotResult = await query(
      `SELECT DISTINCT ON (pair_address)
              pair_address,
              (feature_snapshot->'market'->>'marketCap')::numeric AS market_cap,
              (feature_snapshot->'market'->>'priceUsd')::numeric AS price_usd,
              (feature_snapshot->'market'->>'priceNative')::numeric AS price_native,
              (feature_snapshot->'safety'->>'mintAuthorityHeld')::boolean AS mint_authority_held,
              qualified_at
         FROM alert_decisions
        WHERE pair_address = ANY($1::text[])
          AND qualified_at IS NOT NULL
          AND qualified_at <= to_timestamp($2::double precision / 1000.0)
        ORDER BY pair_address, qualified_at ASC`,
      [pairAddresses, beforeMs],
    );
    for (const r of snapshotResult.rows) {
      snapshotsByPair[r.pair_address] = {
        marketCapUsd: r.market_cap !== null ? Number(r.market_cap) : null,
        priceUsd: r.price_usd !== null ? Number(r.price_usd) : null,
        priceNative: r.price_native !== null ? Number(r.price_native) : null,
        mintAuthorityHeld: r.mint_authority_held,
        qualifiedAtMs: r.qualified_at !== null ? Number(r.qualified_at) : null,
      };
    }
    const outcomeResult = await query(
      `SELECT pair_address, outcome, outcome_detail, peak_roi_multiple, first_price_usd, ath_price_usd,
              ath_at, archived_at, qualified_at, time_to_ath_from_qualification_hours
         FROM pattern_archive
        WHERE pair_address = ANY($1::text[])
          AND archived_at IS NOT NULL
          AND archived_at < $2`,
      [pairAddresses, beforeMs],
    );
    for (const r of outcomeResult.rows) {
      outcomesByPair[r.pair_address] = {
        outcome: r.outcome,
        outcomeDetail: r.outcome_detail ?? null,
        peakRoiMultiple: r.peak_roi_multiple !== null ? Number(r.peak_roi_multiple) : null,
        firstPriceUsd: r.first_price_usd !== null ? Number(r.first_price_usd) : null,
        athPriceUsd: r.ath_price_usd !== null ? Number(r.ath_price_usd) : null,
        athAtMs: r.ath_at !== null ? Number(r.ath_at) : null,
        archivedAtMs: Number(r.archived_at),
        qualifiedAtMs: r.qualified_at !== null ? Number(r.qualified_at) : null,
        timeToAthFromQualificationHours: r.time_to_ath_from_qualification_hours !== null ? Number(r.time_to_ath_from_qualification_hours) : null,
      };
    }
  }
  return { trades, snapshotsByPair, outcomesByPair };
}

/**
 * Position-lifecycle sibling of getEarlyWalletTradesWithOutcomesAmong
 * just above — SAME three point-in-time-safety cutoffs (see that
 * function's header for the full reasoning on each: a wallet's own
 * trade must already have happened, a token can't be its own history,
 * and a pair's outcome must already have finished archiving), and the
 * SAME snapshotsByPair/outcomesByPair joins, reused verbatim rather than
 * re-derived — this is genuinely just a different `trades` query,
 * nothing about the leakage protection changes.
 *
 * The ONE difference from getEarlyWalletTradesWithOutcomesAmong: that
 * function filters `role = 'buyer' AND is_meaningful = TRUE`, because its
 * only consumer (edpiLive.js's campaign/anomaly logic) only ever needed
 * entries. positionLifecycle.js's reconstructPositions needs the OPPOSITE
 * — EVERY trade, buys AND sells, regardless of is_meaningful — because a
 * position's cumulative-sell-fraction math (spec section 9/10: "multiple
 * smaller sells should be capable of cumulatively reaching the
 * threshold") would silently under-count real sells if any sub-floor
 * ones were filtered out before reconstruction ever saw them. The
 * anti-farming floor from spec section 16 is applied AFTER
 * reconstruction instead, against a position's TOTAL buy-in (see
 * positionLifecycle.js's applyTradeOnlyQualification) — filtering
 * per-transaction here would have applied it too early, at the wrong
 * granularity.
 *
 * @param {string[]} owners
 * @param {string} currentPairAddress
 * @param {number} beforeMs
 * @returns {Promise<{
 *   trades: Array<{walletAddress, pairAddress, solAmount, tokenDelta, blockTime}>,
 *   snapshotsByPair: Record<string, {marketCapUsd, priceUsd, priceNative, mintAuthorityHeld, qualifiedAtMs}>,
 *   outcomesByPair: Record<string, {outcome, peakRoiMultiple, firstPriceUsd, athPriceUsd, athAtMs, archivedAtMs, qualifiedAtMs, timeToAthFromQualificationHours}>,
 * }>}
 */
async function getEarlyWalletTradesForPositionsAmong(owners, currentPairAddress, beforeMs) {
  const empty = { trades: [], snapshotsByPair: {}, outcomesByPair: {} };
  if (!Array.isArray(owners) || owners.length === 0 || !currentPairAddress || !Number.isFinite(beforeMs)) return empty;
  const uniqueOwners = [...new Set(owners)];
  const buckets = shardPool.bucketByShard(uniqueOwners);
  const perShardResults = await Promise.all(
    Array.from(buckets.entries()).map(([shardIndex, addrs]) => shardPool.queryShard(
      shardIndex,
      `SELECT wallet_address, pair_address, mint_address, role, sol_amount, token_delta,
                target_amount, target_decimals, input_mint, input_amount_raw, input_amount, input_decimals,
                output_mint, output_amount_raw, output_amount, output_decimals, value_usd, value_sol,
                value_source, economic_confidence, route, evidence, block_time
         FROM early_wallet_activity
        WHERE wallet_address = ANY($1::text[])
          AND pair_address <> $2
          AND block_time IS NOT NULL
          AND block_time < $3`,
      [addrs, currentPairAddress, beforeMs],
    )),
  );
  const trades = [];
  const pairAddressSet = new Set();
  for (const { rows } of perShardResults) {
    for (const r of rows) {
      trades.push({
        walletAddress: r.wallet_address,
        pairAddress: r.pair_address,
        mintAddress: r.mint_address || null,
        role: r.role || null,
        solAmount: r.value_sol !== null ? Number(r.value_sol) : (r.sol_amount === null ? null : Number(r.sol_amount)),
        valueSol: r.value_sol === null ? (r.sol_amount === null ? null : Number(r.sol_amount)) : Number(r.value_sol),
        valueUsd: r.value_usd === null ? null : Number(r.value_usd),
        valueSource: r.value_source || null,
        confidence: r.economic_confidence || null,
        tokenDelta: Number(r.token_delta),
        targetAmount: r.target_amount === null ? null : Number(r.target_amount),
        targetDecimals: r.target_decimals === null ? null : Number(r.target_decimals),
        inputAsset: r.input_mint ? { mint: r.input_mint, rawAmount: r.input_amount_raw === null ? null : String(r.input_amount_raw), amount: r.input_amount === null ? null : Number(r.input_amount), decimals: r.input_decimals === null ? null : Number(r.input_decimals) } : null,
        outputAsset: r.output_mint ? { mint: r.output_mint, rawAmount: r.output_amount_raw === null ? null : String(r.output_amount_raw), amount: r.output_amount === null ? null : Number(r.output_amount), decimals: r.output_decimals === null ? null : Number(r.output_decimals) } : null,
        route: r.route || null,
        evidence: r.evidence || null,
        blockTime: Number(r.block_time),
      });
      pairAddressSet.add(r.pair_address);
    }
  }
  const pairAddresses = [...pairAddressSet];
  const snapshotsByPair = {};
  const outcomesByPair = {};
  if (pairAddresses.length > 0) {
    const snapshotResult = await query(
      `SELECT DISTINCT ON (pair_address)
              pair_address,
              (feature_snapshot->'market'->>'marketCap')::numeric AS market_cap,
              (feature_snapshot->'market'->>'priceUsd')::numeric AS price_usd,
              (feature_snapshot->'market'->>'priceNative')::numeric AS price_native,
              (feature_snapshot->'safety'->>'mintAuthorityHeld')::boolean AS mint_authority_held,
              qualified_at
         FROM alert_decisions
        WHERE pair_address = ANY($1::text[])
          AND qualified_at IS NOT NULL
          AND qualified_at <= to_timestamp($2::double precision / 1000.0)
        ORDER BY pair_address, qualified_at ASC`,
      [pairAddresses, beforeMs],
    );
    for (const r of snapshotResult.rows) {
      snapshotsByPair[r.pair_address] = {
        marketCapUsd: r.market_cap !== null ? Number(r.market_cap) : null,
        priceUsd: r.price_usd !== null ? Number(r.price_usd) : null,
        priceNative: r.price_native !== null ? Number(r.price_native) : null,
        mintAuthorityHeld: r.mint_authority_held,
        qualifiedAtMs: r.qualified_at !== null ? Number(r.qualified_at) : null,
      };
    }
    const outcomeResult = await query(
      `SELECT pair_address, outcome, outcome_detail, peak_roi_multiple, first_price_usd, ath_price_usd,
              ath_at, archived_at, qualified_at, time_to_ath_from_qualification_hours
         FROM pattern_archive
        WHERE pair_address = ANY($1::text[])
          AND archived_at IS NOT NULL
          AND archived_at < $2`,
      [pairAddresses, beforeMs],
    );
    for (const r of outcomeResult.rows) {
      outcomesByPair[r.pair_address] = {
        outcome: r.outcome,
        outcomeDetail: r.outcome_detail ?? null,
        peakRoiMultiple: r.peak_roi_multiple !== null ? Number(r.peak_roi_multiple) : null,
        firstPriceUsd: r.first_price_usd !== null ? Number(r.first_price_usd) : null,
        athPriceUsd: r.ath_price_usd !== null ? Number(r.ath_price_usd) : null,
        athAtMs: r.ath_at !== null ? Number(r.ath_at) : null,
        archivedAtMs: Number(r.archived_at),
        qualifiedAtMs: r.qualified_at !== null ? Number(r.qualified_at) : null,
        timeToAthFromQualificationHours: r.time_to_ath_from_qualification_hours !== null ? Number(r.time_to_ath_from_qualification_hours) : null,
      };
    }
  }
  return { trades, snapshotsByPair, outcomesByPair };
}

/**
 * CTO-specific historical evidence source.
 *
 * Unlike getEarlyWalletTradesForPositionsAmong(), this returns BOTH:
 *   - qualification-time-safe archive outcomes (archived_at < beforeMs), and
 *   - the eventual/latest archive outcome for retrospective research.
 *
 * Trade visibility remains strictly point-in-time: block_time < beforeMs,
 * current pair excluded. `captured_at` is never used as event time.
 */
async function getEarlyWalletCTOTradesAmong(owners, currentPairAddress, beforeMs) {
  const empty = {
    trades: [],
    snapshotsByPair: {},
    outcomesByPair: {},
    eventualOutcomesByPair: {},
    currentTokenPriorDeathEvidence: [],
  };
  if (!Array.isArray(owners) || owners.length === 0 || !currentPairAddress || !Number.isFinite(beforeMs)) return empty;

  const uniqueOwners = [...new Set(owners)];
  const buckets = shardPool.bucketByShard(uniqueOwners);
  const perShardResults = await Promise.all(
    Array.from(buckets.entries()).map(([shardIndex, addrs]) => shardPool.queryShard(
      shardIndex,
      `SELECT wallet_address, pair_address, mint_address, role, sol_amount, token_delta,
                target_amount, target_decimals, input_mint, input_amount_raw, input_amount, input_decimals,
                output_mint, output_amount_raw, output_amount, output_decimals, value_usd, value_sol,
                value_source, economic_confidence, route, evidence, block_time
         FROM early_wallet_activity
        WHERE wallet_address = ANY($1::text[])
          AND pair_address <> $2
          AND block_time IS NOT NULL
          AND block_time < $3`,
      [addrs, currentPairAddress, beforeMs],
    )),
  );

  const trades = [];
  const pairAddressSet = new Set();
  for (const { rows } of perShardResults) {
    for (const r of rows) {
      trades.push({
        walletAddress: r.wallet_address,
        pairAddress: r.pair_address,
        mintAddress: r.mint_address || null,
        role: r.role || null,
        solAmount: r.value_sol !== null ? Number(r.value_sol) : (r.sol_amount === null ? null : Number(r.sol_amount)),
        valueSol: r.value_sol === null ? (r.sol_amount === null ? null : Number(r.sol_amount)) : Number(r.value_sol),
        valueUsd: r.value_usd === null ? null : Number(r.value_usd),
        valueSource: r.value_source || null,
        confidence: r.economic_confidence || null,
        tokenDelta: Number(r.token_delta),
        targetAmount: r.target_amount === null ? null : Number(r.target_amount),
        targetDecimals: r.target_decimals === null ? null : Number(r.target_decimals),
        inputAsset: r.input_mint ? { mint: r.input_mint, rawAmount: r.input_amount_raw === null ? null : String(r.input_amount_raw), amount: r.input_amount === null ? null : Number(r.input_amount), decimals: r.input_decimals === null ? null : Number(r.input_decimals) } : null,
        outputAsset: r.output_mint ? { mint: r.output_mint, rawAmount: r.output_amount_raw === null ? null : String(r.output_amount_raw), amount: r.output_amount === null ? null : Number(r.output_amount), decimals: r.output_decimals === null ? null : Number(r.output_decimals) } : null,
        route: r.route || null,
        evidence: r.evidence || null,
        blockTime: Number(r.block_time),
      });
      pairAddressSet.add(r.pair_address);
    }
  }

  const pairAddresses = [...pairAddressSet];
  const snapshotsByPair = {};
  const outcomesByPair = {};
  const eventualOutcomesByPair = {};

  if (pairAddresses.length > 0) {
    const snapshotResult = await query(
      `SELECT DISTINCT ON (pair_address)
              pair_address,
              (feature_snapshot->'market'->>'marketCap')::numeric AS market_cap,
              (feature_snapshot->'market'->>'priceUsd')::numeric AS price_usd,
              (feature_snapshot->'market'->>'priceNative')::numeric AS price_native,
              (feature_snapshot->'safety'->>'mintAuthorityHeld')::boolean AS mint_authority_held,
              qualified_at
         FROM alert_decisions
        WHERE pair_address = ANY($1::text[])
          AND qualified_at IS NOT NULL
          AND qualified_at <= to_timestamp($2::double precision / 1000.0)
        ORDER BY pair_address, qualified_at ASC`,
      [pairAddresses, beforeMs],
    );
    for (const r of snapshotResult.rows) {
      snapshotsByPair[r.pair_address] = {
        marketCapUsd: r.market_cap !== null ? Number(r.market_cap) : null,
        priceUsd: r.price_usd !== null ? Number(r.price_usd) : null,
        priceNative: r.price_native !== null ? Number(r.price_native) : null,
        mintAuthorityHeld: r.mint_authority_held,
        qualifiedAtMs: r.qualified_at !== null ? Number(r.qualified_at) : null,
      };
    }

    const eventualResult = await query(
      `SELECT DISTINCT ON (pair_address)
              pair_address, mint_address, symbol, name, outcome, outcome_detail,
              peak_roi_multiple, first_price_usd, ath_price_usd, ath_at,
              archived_at, qualified_at, time_to_ath_from_qualification_hours,
              rug_mechanism
         FROM pattern_archive
        WHERE pair_address = ANY($1::text[])
        ORDER BY pair_address, archived_at DESC`,
      [pairAddresses],
    );
    for (const r of eventualResult.rows) {
      eventualOutcomesByPair[r.pair_address] = {
        pairAddress: r.pair_address,
        mintAddress: r.mint_address || null,
        symbol: r.symbol || null,
        name: r.name || null,
        outcome: r.outcome,
        outcomeDetail: r.outcome_detail ?? null,
        peakRoiMultiple: r.peak_roi_multiple !== null ? Number(r.peak_roi_multiple) : null,
        firstPriceUsd: r.first_price_usd !== null ? Number(r.first_price_usd) : null,
        athPriceUsd: r.ath_price_usd !== null ? Number(r.ath_price_usd) : null,
        athAtMs: r.ath_at !== null ? Number(r.ath_at) : null,
        archivedAtMs: Number(r.archived_at),
        qualifiedAtMs: r.qualified_at !== null ? Number(r.qualified_at) : null,
        timeToAthFromQualificationHours: r.time_to_ath_from_qualification_hours !== null ? Number(r.time_to_ath_from_qualification_hours) : null,
        rugMechanism: r.rug_mechanism || null,
      };
    }

    const safeResult = await query(
      `SELECT DISTINCT ON (pair_address)
              pair_address, mint_address, symbol, name, outcome, outcome_detail,
              peak_roi_multiple, first_price_usd, ath_price_usd, ath_at,
              archived_at, qualified_at, time_to_ath_from_qualification_hours,
              rug_mechanism
         FROM pattern_archive
        WHERE pair_address = ANY($1::text[])
          AND archived_at IS NOT NULL
          AND archived_at < $2
        ORDER BY pair_address, archived_at DESC`,
      [pairAddresses, beforeMs],
    );
    for (const r of safeResult.rows) {
      outcomesByPair[r.pair_address] = {
        pairAddress: r.pair_address,
        mintAddress: r.mint_address || null,
        symbol: r.symbol || null,
        name: r.name || null,
        outcome: r.outcome,
        outcomeDetail: r.outcome_detail ?? null,
        peakRoiMultiple: r.peak_roi_multiple !== null ? Number(r.peak_roi_multiple) : null,
        firstPriceUsd: r.first_price_usd !== null ? Number(r.first_price_usd) : null,
        athPriceUsd: r.ath_price_usd !== null ? Number(r.ath_price_usd) : null,
        athAtMs: r.ath_at !== null ? Number(r.ath_at) : null,
        archivedAtMs: Number(r.archived_at),
        qualifiedAtMs: r.qualified_at !== null ? Number(r.qualified_at) : null,
        timeToAthFromQualificationHours: r.time_to_ath_from_qualification_hours !== null ? Number(r.time_to_ath_from_qualification_hours) : null,
        rugMechanism: r.rug_mechanism || null,
      };
    }
  }

  return { trades, snapshotsByPair, outcomesByPair, eventualOutcomesByPair, currentTokenPriorDeathEvidence: [] };
}

/**
 * Finds prior archive records for the CURRENT mint. This is intentionally
 * separate from ordinary CTO grouping because the ordinary historical-token
 * path excludes the current token identity; this function supports the
 * special "token reappeared after prior death/rug" research case.
 */
async function getPriorDeadRuggedArchivesForMint(mintAddress, beforeMs) {
  if (!mintAddress || !Number.isFinite(beforeMs)) return [];
  const { rows } = await query(
    `SELECT DISTINCT ON (pair_address)
            pair_address, mint_address, symbol, name, outcome, outcome_detail,
            archived_at, qualified_at, rug_mechanism
       FROM pattern_archive
      WHERE mint_address = $1
        AND archived_at IS NOT NULL
        AND archived_at < $2
        AND (outcome = 'rugged' OR outcome_detail = 'dead')
      ORDER BY pair_address, archived_at DESC`,
    [mintAddress, beforeMs],
  );
  return rows.map((r) => ({
    pairAddress: r.pair_address,
    mintAddress: r.mint_address,
    symbol: r.symbol || null,
    name: r.name || null,
    outcome: r.outcome,
    outcomeDetail: r.outcome_detail || null,
    archivedAtMs: Number(r.archived_at),
    qualifiedAtMs: r.qualified_at !== null ? Number(r.qualified_at) : null,
    rugMechanism: r.rug_mechanism || null,
  }));
}

// ---------------------------------------------------------------------
// Persistent alert dedup — see schema.sql's comment on `alerted_pairs`
// for the restart problem this solves, and tokenScanner.js's
// runScanCycle for how this combines with the in-memory `alertedPairs`
// Set (this table is the cross-restart backstop, not a replacement for
// the in-memory fast path).
// ---------------------------------------------------------------------

/**
 * Batched lookup, not one query per candidate pair — runScanCycle calls
 * this once per scan cycle with that cycle's full candidate list (bounded
 * by however many pairs DexScreener returns, not by how large this table
 * has grown historically), same ANY($1::text[]) batching pattern as
 * getRecurringWalletsAmong. Returns a Set for O(1) lookup in the caller's
 * loop.
 *
 * @param {string[]} pairAddresses
 * @returns {Promise<Set<string>>}
 */
async function getAlertedPairs(pairAddresses) {
  if (!Array.isArray(pairAddresses) || pairAddresses.length === 0) return new Set();
  const { rows } = await query(
    'SELECT pair_address FROM alerted_pairs WHERE pair_address = ANY($1::text[])',
    [pairAddresses],
  );
  return new Set(rows.map((r) => r.pair_address));
}

/**
 * Records that a pair has been alerted on, so a future process restart's
 * fresh (empty) in-memory Set doesn't re-alert it. ON CONFLICT DO NOTHING
 * rather than erroring — the in-memory Set already prevents the same
 * process from calling this twice for one pair in ordinary operation, but
 * this makes the call idempotent regardless, same defensive posture as
 * subscriberStore.js's markTxSignatureUsed.
 *
 * @param {string} pairAddress
 * @param {number} alertedAt - epoch ms
 */
async function recordAlertedPair(pairAddress, alertedAt) {
  await query(
    'INSERT INTO alerted_pairs (pair_address, alerted_at) VALUES ($1, $2) ON CONFLICT (pair_address) DO NOTHING',
    [pairAddress, alertedAt],
  );
}

// ---------------------------------------------------------------------
// Description-derived narrative category registry — see
// descriptionClassifier.js for the matching algorithm this backs. Table
// stays small (dozens to low hundreds of rows) since most tokens join an
// existing category rather than minting a new one, so an unfiltered
// getDescriptionCategories() load is fine here — no pagination/category
// key filtering needed the way getArchiveForCategory needed one for the
// (much larger, unboundedly-growing) pattern_archive table.
// ---------------------------------------------------------------------

function rowToDescriptionCategory(row) {
  return {
    categoryKey: row.category_key,
    keywords: row.keywords,
    sampleDescription: row.sample_description,
    sampleTokenName: row.sample_token_name,
    tokenCount: row.token_count,
    firstSeenAt: Number(row.first_seen_at),
  };
}

/**
 * @returns {Promise<Array<{categoryKey, keywords, sampleDescription, sampleTokenName, tokenCount, firstSeenAt}>>}
 */
async function getDescriptionCategories() {
  const { rows } = await query('SELECT * FROM description_categories');
  return rows.map(rowToDescriptionCategory);
}

/**
 * Mints a brand-new description-derived category. ON CONFLICT DO NOTHING
 * rather than erroring — a race between two concurrent scan cycles both
 * discovering the same new categoryKey (same top keyword(s)) at once is
 * rare but not impossible, and the second one arriving should just no-op
 * rather than crash the whole per-token try/catch it's called from in
 * tokenScanner.js.
 *
 * @param {string} categoryKey
 * @param {string[]} keywords
 * @param {string|null} sampleDescription
 * @param {string} sampleTokenName
 * @param {number} firstSeenAt - epoch ms
 */
async function createDescriptionCategory(categoryKey, keywords, sampleDescription, sampleTokenName, firstSeenAt) {
  await query(
    `INSERT INTO description_categories (category_key, keywords, sample_description, sample_token_name, token_count, first_seen_at)
     VALUES ($1, $2, $3, $4, 1, $5)
     ON CONFLICT (category_key) DO NOTHING`,
    [categoryKey, keywords, sampleDescription, sampleTokenName, firstSeenAt],
  );
}

/**
 * Bumps the count when another token joins an existing description
 * category (descriptionClassifier.js's classifyByDescription matched it
 * to one already in the registry) — purely a "how big is this cluster"
 * stat, doesn't affect matching itself (matching always compares against
 * the category's original keywords/sampleTokenName, not an aggregate).
 *
 * @param {string} categoryKey
 */
async function incrementDescriptionCategoryCount(categoryKey) {
  await query(
    'UPDATE description_categories SET token_count = token_count + 1 WHERE category_key = $1',
    [categoryKey],
  );
}

module.exports = {
  getTrackedTokens,
  getTrackedToken,
  enrollToken,
  updateTrackedToken,
  removeTrackedToken,
  getArchive,
  getArchiveForCategory,
  getArchiveForNarrative,
  appendArchiveRecord,
  archiveAndRemoveTrackedToken,
  appendSnapshot,
  getSnapshotCount,
  getLatestSnapshot,
  getLastKnownSafetyReading,
  getSnapshots,
  recordTokenHolders,
  getRecurringWalletsAmong,
  listPriorRuggedWalletExposureFor,
  getWalletOwnersAtQualification,
  getWalletExperienceAmong,
  getWalletExperienceFeaturesFor,
  getWalletHistory,
  recordEarlyWalletActivity,
  markEarlyWalletChecked,
  getRecurringEarlyWallets,
  getEarlyWalletHistoryAmong,
  getEarlyWalletTradesWithOutcomesAmong,
  getEarlyWalletTradesForPositionsAmong,
  getEarlyWalletCTOTradesAmong,
  getPriorDeadRuggedArchivesForMint,
  getEarlyWalletActivityForPair,
  getWalletEconomicEvidenceStats,
  getCurrentWalletCapitalSol,
  getAlertedPairs,
  recordAlertedPair,
  getDescriptionCategories,
  createDescriptionCategory,
  incrementDescriptionCategoryCount,
};
