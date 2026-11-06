#!/usr/bin/env node
/**
 * One-off JSON -> Postgres migration.
 *
 * The V2 roadmap's Phase 1 describes a `/migrate` admin command with
 * resume-if-interrupted logic and a dual-write transition period. That's
 * built for a deployment with an existing JSON *and* SQLite dataset to
 * reconcile. This project only has JSON, and it's whatever's in
 * data/*.json right now — a single run of this script is enough. If you
 * outgrow "run a script once," that's the signal to build the fancier
 * version, not a reason to build it preemptively.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate.js
 *
 * Safe to run against an empty database (creates the schema first). Will
 * refuse to run twice against the same database unless --force is passed,
 * since re-inserting would either duplicate archive rows or silently
 * no-op on conflicting primary keys depending on the table — better to
 * fail loudly than guess.
 */

const fs = require('fs');
const path = require('path');
const { storage, patternTracking, reports } = require('../src/config');
const { query, closePool } = require('../src/db/pool');
const { ensureSchema } = require('../src/db/schema');
const { deriveOutcomeEnrichment } = require('../src/core/patternAnalyzer');
const { FALLBACK_TAG } = require('../src/core/narrativeClassifier');

const FORCE = process.argv.includes('--force');

/**
 * Same inference scripts/backfill-signal-status.js and
 * scripts/backfill-narrative-confidence.js apply to already-migrated
 * rows, applied here instead so a FRESH migration run populates these
 * from the start rather than leaving every legacy row NULL for a
 * follow-up backfill to fix. See those two scripts' own header comments
 * for the full reasoning behind each inference (in particular: why a
 * non-'uncategorized', non-'desc:*' tag is fully, not just probably,
 * knowable as 'rule' — the tag value itself proves it).
 */
function inferSignalStatus(signalLabel) {
  return signalLabel ? 'SIGNALLED' : 'UNKNOWN_PRE_MIGRATION';
}
function inferNarrativeConfidenceAndMethod(narrativeTag) {
  if (!narrativeTag || narrativeTag === FALLBACK_TAG) return { narrativeConfidence: null, narrativeMatchMethod: null };
  if (narrativeTag.startsWith('desc:')) return { narrativeConfidence: null, narrativeMatchMethod: 'unknown-pre-migration' };
  return { narrativeConfidence: 1.0, narrativeMatchMethod: 'rule' };
}

function readJsonFile(filePath, fallback) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.log(`  (no file at ${resolved}, treating as empty)`);
    return fallback;
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
}

// Schema application itself now lives in src/db/schema.js (ensureSchema),
// shared with index.js's startup path and the test suite — this script
// used to have its own private copy of this exact logic.


async function checkAlreadyMigrated() {
  const { rows } = await query('SELECT * FROM migration_state WHERE id = 1');
  if (rows.length > 0 && rows[0].migrated_at && !FORCE) {
    console.error(
      `\nThis database already has a migration_state record from ${rows[0].migrated_at.toISOString()}.\n` +
      `Running this script again would duplicate pattern_archive rows and skip existing\n` +
      `subscribers/tracked_tokens (their primary keys already exist).\n\n` +
      `If you're sure you want to re-run anyway, pass --force.\n`,
    );
    process.exit(1);
  }
}

async function migrateSubscribers() {
  const db = readJsonFile(storage.dbFile, { subscribers: {}, usedTxSignatures: [] });
  const subscribers = Object.values(db.subscribers || {});
  for (const sub of subscribers) {
    await query(
      `INSERT INTO subscribers (chat_id, username, alerts_sent, subscription_expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chat_id) DO NOTHING`,
      [sub.chatId, sub.username ?? null, sub.alertsSent ?? 0, sub.subscriptionExpiresAt, sub.createdAt ?? new Date().toISOString()],
    );
  }
  const usedTxSignatures = db.usedTxSignatures || [];
  for (const signature of usedTxSignatures) {
    if (!signature) continue; // JSON file had an empty-string placeholder in the sample data — skip blanks
    await query(`INSERT INTO used_tx_signatures (signature) VALUES ($1) ON CONFLICT (signature) DO NOTHING`, [signature]);
  }
  console.log(`Subscribers: ${subscribers.length} migrated, ${usedTxSignatures.filter(Boolean).length} used tx signatures migrated.`);
  return { subscriberCount: subscribers.length, usedTxSignatureCount: usedTxSignatures.filter(Boolean).length };
}

async function migrateTrackedTokens() {
  const db = readJsonFile(patternTracking.dbFile, { tokens: {} });
  const tokens = Object.values(db.tokens || {});
  let snapshotCount = 0;
  for (const t of tokens) {
    const { narrativeConfidence, narrativeMatchMethod } = inferNarrativeConfidenceAndMethod(t.narrativeTag);
    await query(
      `INSERT INTO tracked_tokens (
         pair_address, mint_address, base_token, narrative_tag,
         hype_score_at_qualification, risk_level_at_qualification, signal_label,
         qualified_at, first_price_usd, ath_price_usd, ath_at,
         last_price_usd, last_checked_at, first_top_holder_pct, first_lp_locked_pct,
         signal_status, narrative_confidence, narrative_match_method
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (pair_address) DO NOTHING`,
      [
        t.pairAddress, t.mintAddress, JSON.stringify(t.baseToken), t.narrativeTag,
        t.hypeScoreAtQualification, t.riskLevelAtQualification, t.signalLabel ?? null,
        t.qualifiedAt, t.firstPriceUsd, t.athPriceUsd, t.athAt,
        t.lastPriceUsd, t.lastCheckedAt, t.firstTopHolderPct ?? null, t.firstLpLockedPct ?? null,
        inferSignalStatus(t.signalLabel), narrativeConfidence, narrativeMatchMethod,
      ],
    );
    // Phase 2 normalized the old embedded `checkpoints` array into the
    // `snapshots` table — migrate each entry as its own row so
    // in-progress tracked tokens don't lose their price/safety history.
    for (const cp of t.checkpoints ?? []) {
      await query(
        `INSERT INTO snapshots (pair_address, t, price_usd, top_holder_pct, lp_locked_pct)
         VALUES ($1, $2, $3, $4, $5)`,
        [t.pairAddress, cp.t, cp.priceUsd, cp.topHolderPct ?? null, cp.lpLockedPct ?? null],
      );
      snapshotCount++;
    }
  }
  console.log(`Tracked tokens: ${tokens.length} migrated, ${snapshotCount} snapshot(s) migrated from their checkpoints history.`);
  return { trackedTokenCount: tokens.length };
}

async function migrateArchive() {
  const db = readJsonFile(patternTracking.archiveFile, { records: [] });
  const records = db.records || [];
  for (const r of records) {
    // Phase 8/9 postdate every JSON archive record — none of them have
    // outcomeDetail/peakRoiBucket/timeToAthFromQualificationHours/
    // rugMechanism yet. Same derivation patternReviewer.js uses for new
    // records, so a migrated archive is consistent with one built after
    // Phase 9. Also covers Plan B's rugMechanismConfidence/Evidence, same
    // reasoning — deriveOutcomeEnrichment computes those too now.
    const enrichment = deriveOutcomeEnrichment(r);
    const { narrativeConfidence, narrativeMatchMethod } = inferNarrativeConfidenceAndMethod(r.narrativeTag);
    await query(
      `INSERT INTO pattern_archive (
         pair_address, mint_address, symbol, name, narrative_tag,
         hype_score_at_qualification, risk_level_at_qualification, signal_label, category_key,
         qualified_at, first_price_usd, ath_price_usd, ath_at, final_price_usd, peak_roi_multiple,
         outcome, archived_at, time_to_rug_from_qualification_hours, time_to_rug_from_ath_hours,
         checkpoint_count, first_top_holder_pct, last_top_holder_pct, first_lp_locked_pct, last_lp_locked_pct,
         outcome_detail, peak_roi_bucket, time_to_ath_from_qualification_hours, rug_mechanism,
         signal_status, rug_mechanism_confidence, rug_mechanism_evidence, narrative_confidence, narrative_match_method
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)`,
      [
        r.pairAddress, r.mintAddress, r.symbol, r.name, r.narrativeTag,
        r.hypeScoreAtQualification, r.riskLevelAtQualification, r.signalLabel ?? null, r.categoryKey,
        r.qualifiedAt, r.firstPriceUsd, r.athPriceUsd, r.athAt, r.finalPriceUsd, r.peakRoiMultiple,
        r.outcome, r.archivedAt, r.timeToRugFromQualificationHours, r.timeToRugFromAthHours,
        r.checkpointCount, r.firstTopHolderPct ?? null, r.lastTopHolderPct ?? null, r.firstLpLockedPct ?? null, r.lastLpLockedPct ?? null,
        enrichment.outcomeDetail, enrichment.peakRoiBucket, enrichment.timeToAthFromQualificationHours, enrichment.rugMechanism,
        inferSignalStatus(r.signalLabel), enrichment.rugMechanismConfidence,
        enrichment.rugMechanismEvidence ? JSON.stringify(enrichment.rugMechanismEvidence) : null,
        narrativeConfidence, narrativeMatchMethod,
      ],
    );
  }
  console.log(`Pattern archive: ${records.length} migrated (outcomeDetail/peakRoiBucket/rugMechanism backfilled for all).`);
  return { archiveRecordCount: records.length };
}

async function migrateReportState() {
  const state = readJsonFile(reports.stateFile, { lastDailyReportAt: null, lastWeeklyReportAt: null });
  await query(
    `INSERT INTO report_state (id, last_daily_report_at, last_weekly_report_at)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET
       last_daily_report_at = EXCLUDED.last_daily_report_at,
       last_weekly_report_at = EXCLUDED.last_weekly_report_at`,
    [state.lastDailyReportAt ?? null, state.lastWeeklyReportAt ?? null],
  );
  console.log('Report state: migrated.');
}

async function recordMigrationState(counts) {
  await query(
    `INSERT INTO migration_state (id, migrated_at, source, subscriber_count, used_tx_signature_count, tracked_token_count, archive_record_count)
     VALUES (1, now(), 'json-files', $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       migrated_at = now(), source = 'json-files',
       subscriber_count = $1, used_tx_signature_count = $2, tracked_token_count = $3, archive_record_count = $4`,
    [counts.subscriberCount, counts.usedTxSignatureCount, counts.trackedTokenCount, counts.archiveRecordCount],
  );
}

async function verifyCounts(expected) {
  const [sub, tok, arc] = await Promise.all([
    query('SELECT COUNT(*)::int AS n FROM subscribers'),
    query('SELECT COUNT(*)::int AS n FROM tracked_tokens'),
    query('SELECT COUNT(*)::int AS n FROM pattern_archive'),
  ]);
  console.log('\nVerification (row counts now in Postgres):');
  console.log(`  subscribers:     ${sub.rows[0].n}`);
  console.log(`  tracked_tokens:  ${tok.rows[0].n}`);
  console.log(`  pattern_archive: ${arc.rows[0].n}`);
  const mismatch = sub.rows[0].n < expected.subscriberCount || tok.rows[0].n < expected.trackedTokenCount || arc.rows[0].n < expected.archiveRecordCount;
  if (mismatch) {
    console.warn(
      '\nWARNING: Postgres row counts are lower than the source JSON counts. This is\n' +
      'expected if the database already had some of this data (ON CONFLICT DO NOTHING\n' +
      'skips existing rows) — but if this is a fresh database, investigate before\n' +
      'trusting the migrated data.',
    );
  }
}

async function main() {
  console.log('Gem Seeker — JSON to Postgres migration\n');
  await ensureSchema();
  console.log('Schema applied (idempotent — CREATE TABLE/INDEX IF NOT EXISTS).');
  await checkAlreadyMigrated();

  const subCounts = await migrateSubscribers();
  const tokCounts = await migrateTrackedTokens();
  const arcCounts = await migrateArchive();
  await migrateReportState();

  const counts = { ...subCounts, ...tokCounts, ...arcCounts };
  await recordMigrationState(counts);
  await verifyCounts(counts);

  console.log('\nDone. The live app now reads/writes Postgres exclusively — the JSON files');
  console.log('under data/ are no longer touched by the running bot, but are left in place');
  console.log('as a backup. Safe to archive them elsewhere once you\'ve confirmed the bot');
  console.log('is working correctly against Postgres.');
}

main()
  .catch((err) => {
    console.error('\nMigration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
