'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('../db/pool');

function createRunId() {
  return crypto.randomUUID();
}

async function createBackfillRun({ runId = createRunId(), operation, policyVersion, args = {} } = {}) {
  if (!operation || !policyVersion) throw new Error('operation and policyVersion are required');
  const { rows } = await query(
    `INSERT INTO backfill_runs (run_id, operation, policy_version, args)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [runId, operation, policyVersion, JSON.stringify(args)],
  );
  return rows[0];
}

async function getCheckpoint(runId, archiveId, policyVersion) {
  const { rows } = await query(
    `SELECT * FROM backfill_checkpoints
     WHERE run_id = $1 AND archive_id = $2 AND policy_version = $3`,
    [runId, archiveId, policyVersion],
  );
  return rows[0] || null;
}

async function ensureCheckpoint(runId, archiveId, policyVersion) {
  const { rows } = await query(
    `INSERT INTO backfill_checkpoints (run_id, archive_id, policy_version)
     VALUES ($1, $2, $3)
     ON CONFLICT (run_id, archive_id) DO UPDATE
       SET policy_version = backfill_checkpoints.policy_version
     RETURNING *`,
    [runId, archiveId, policyVersion],
  );
  return rows[0];
}

async function commitPage({ runId, archiveId, policyVersion, cursorSignature = null, pagesWalked, signaturesScanned, entriesWritten, pageNumber, beforeSignature = null, afterSignature = null, signatures = [], lastPageObservedAt = new Date(), persistPage }) {
  if (typeof persistPage !== 'function') throw new TypeError('persistPage must be a function');
  return withTransaction(async (client) => {
    await persistPage(client);
    if (Number.isInteger(pageNumber)) {
      await client.query(
        `INSERT INTO backfill_signature_pages
           (run_id, archive_id, policy_version, page_number,
            before_signature, after_signature, signatures, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (run_id, archive_id, page_number) DO NOTHING`,
        [runId, archiveId, policyVersion, pageNumber, beforeSignature, afterSignature, JSON.stringify(signatures), lastPageObservedAt],
      );
    }
    const { rows } = await client.query(
      `INSERT INTO backfill_checkpoints
         (run_id, archive_id, policy_version, cursor_signature,
          pages_walked, signatures_scanned, entries_written,
          status, last_page_observed_at, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,NULL,now())
       ON CONFLICT (run_id, archive_id) DO UPDATE SET
         policy_version = EXCLUDED.policy_version,
         cursor_signature = EXCLUDED.cursor_signature,
         pages_walked = EXCLUDED.pages_walked,
         signatures_scanned = EXCLUDED.signatures_scanned,
         entries_written = EXCLUDED.entries_written,
         status = 'running',
         last_page_observed_at = EXCLUDED.last_page_observed_at,
         last_error = NULL,
         updated_at = now()
       RETURNING *`,
      [runId, archiveId, policyVersion, cursorSignature, pagesWalked, signaturesScanned, entriesWritten, lastPageObservedAt],
    );
    return rows[0];
  });
}

async function listSignaturePages(runId, archiveId, policyVersion) {
  const { rows } = await query(
    `SELECT page_number, before_signature, after_signature, signatures, fetched_at
     FROM backfill_signature_pages
     WHERE run_id = $1 AND archive_id = $2 AND policy_version = $3
     ORDER BY page_number`,
    [runId, archiveId, policyVersion],
  );
  return rows;
}

async function markCheckpoint({ runId, archiveId, status, error = null, attempts = null }) {
  const { rows } = await query(
    `UPDATE backfill_checkpoints
     SET status = $3,
         last_error = $4,
         attempts = COALESCE($5, attempts),
         updated_at = now()
     WHERE run_id = $1 AND archive_id = $2
     RETURNING *`,
    [runId, archiveId, status, error ? String(error).slice(0, 4000) : null, attempts],
  );
  return rows[0] || null;
}

async function finishBackfillRun(runId, status, summary = {}) {
  const allowed = new Set(['completed', 'stopped', 'failed']);
  if (!allowed.has(status)) throw new Error(`invalid terminal run status: ${status}`);
  const { rows } = await query(
    `UPDATE backfill_runs
     SET status = $2, finished_at = now(),
         rows_seen = COALESCE($3, rows_seen),
         rows_completed = COALESCE($4, rows_completed),
         rows_failed = COALESCE($5, rows_failed),
         pages_fetched = COALESCE($6, pages_fetched),
         requests_used = COALESCE($7, requests_used),
         last_error = COALESCE($8, last_error)
     WHERE run_id = $1
     RETURNING *`,
    [runId, status, summary.rowsSeen, summary.rowsCompleted, summary.rowsFailed, summary.pagesFetched, summary.requestsUsed, summary.lastError],
  );
  return rows[0] || null;
}

module.exports = {
  createRunId,
  createBackfillRun,
  getCheckpoint,
  ensureCheckpoint,
  listSignaturePages,
  commitPage,
  markCheckpoint,
  finishBackfillRun,
};
