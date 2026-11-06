'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

const DEFAULT_HORIZONS = Object.freeze([
  { key: '5m', minutes: 5 },
  { key: '15m', minutes: 15 },
  { key: '1h', minutes: 60 },
  { key: '6h', minutes: 360 },
  { key: '24h', minutes: 1440 },
  { key: '72h', minutes: 4320 },
]);

const MAX_ATTEMPTS = 8;
const LEASE_MINUTES = 5;
const WALLET_EVIDENCE_POLICY_VERSION = 'v2';
const WALLET_CAPTURE_POLICY_VERSION = 'v2';

function retryAt(attempts) {
  const seconds = Math.min(300, Math.max(5, 2 ** Math.min(attempts, 8)));
  return new Date(Date.now() + seconds * 1000);
}

async function claimResearchJob(workerId) {
  const { rows } = await query(
    `WITH next_job AS (
       SELECT job_id
       FROM research_jobs
       WHERE available_at <= now()
         AND (
           status IN ('pending', 'failed')
           OR (status = 'processing' AND claimed_at < now() - ($2::int * interval '1 minute'))
         )
       ORDER BY available_at, job_id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE research_jobs rj
     SET status = 'processing', claimed_by = $1,
         claimed_at = now(), attempts = rj.attempts + 1
     FROM next_job
     WHERE rj.job_id = next_job.job_id
     RETURNING rj.*`,
    [workerId, LEASE_MINUTES],
  );
  return rows[0] || null;
}

async function completeResearchJob(jobId, workerId) {
  const { rowCount } = await query(
    `UPDATE research_jobs SET status = 'completed', completed_at = now(), claimed_by = NULL
     WHERE job_id = $1 AND claimed_by = $2 AND status = 'processing'`,
    [jobId, workerId],
  );
  return rowCount > 0;
}

async function failResearchJob(jobId, workerId, errorMessage, attempts = 1) {
  const terminal = attempts >= MAX_ATTEMPTS;
  const { rowCount } = await query(
    `UPDATE research_jobs
     SET status = $3, available_at = $4, last_error = $5, claimed_by = NULL
     WHERE job_id = $1 AND claimed_by = $2 AND status = 'processing'`,
    [jobId, workerId, terminal ? 'dead_letter' : 'failed', terminal ? new Date() : retryAt(attempts), String(errorMessage || 'unknown error').slice(0, 4000)],
  );
  return rowCount > 0;
}

async function releaseResearchJob(jobId, workerId) {
  const { rowCount } = await query(
    `UPDATE research_jobs SET status = 'pending', available_at = now() + interval '30 seconds', claimed_by = NULL
     WHERE job_id = $1 AND claimed_by = $2 AND status = 'processing'`,
    [jobId, workerId],
  );
  return rowCount > 0;
}

async function enqueueEdpiLPersistenceJob({ alertId }) {
  if (!alertId) throw new Error('alertId is required for EDPI-L persistence retry');
  const idempotencyKey = `edpi-l-persistence:${alertId}`;
  const jobId = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO research_jobs (job_id, job_type, idempotency_key, payload, available_at)
     VALUES ($1, 'edpi_l_persistence', $2, $3::jsonb, now())
     ON CONFLICT (idempotency_key) DO UPDATE SET payload = research_jobs.payload
     RETURNING job_id`,
    [jobId, idempotencyKey, JSON.stringify({ alertId })],
  );
  return rows[0].job_id;
}


function buildWalletActivityCaptureCoverageKey({ pairAddress, mintAddress, windowStartMs, windowEndMs, walletAddresses = [] }) {
  const wallets = [...new Set((walletAddresses || []).filter(Boolean))].sort();
  const walletHash = crypto.createHash('sha1').update(wallets.join(',')).digest('hex');
  return { pairAddress, mintAddress, windowStartMs: Number(windowStartMs), windowEndMs: Number(windowEndMs), walletHash };
}

async function recordWalletActivityCaptureCoverage({ pairAddress, mintAddress, windowStartMs, windowEndMs, walletAddresses = [], status, signaturesInWindow = 0, parsedEntries = 0, pagesWalked = 0, resumeSignature = null, error = null }) {
  const key = buildWalletActivityCaptureCoverageKey({ pairAddress, mintAddress, windowStartMs, windowEndMs, walletAddresses });
  const { rows } = await query(
    `INSERT INTO wallet_activity_capture_coverage
       (pair_address, mint_address, window_start_ms, window_end_ms, wallet_hash, status, signatures_in_window, parsed_entries, pages_walked, resume_signature, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (pair_address, mint_address, window_start_ms, window_end_ms, wallet_hash)
     DO UPDATE SET status = EXCLUDED.status, signatures_in_window = EXCLUDED.signatures_in_window,
                   parsed_entries = EXCLUDED.parsed_entries, pages_walked = EXCLUDED.pages_walked,
                   resume_signature = EXCLUDED.resume_signature, last_error = EXCLUDED.last_error, updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [key.pairAddress, key.mintAddress, key.windowStartMs, key.windowEndMs, key.walletHash, String(status), Number(signaturesInWindow) || 0, Number(parsedEntries) || 0, Number(pagesWalked) || 0, resumeSignature ? String(resumeSignature) : null, error ? String(error).slice(0, 4000) : null, Date.now()],
  );
  return rows[0] || null;
}

async function getWalletActivityCaptureCoverage({ pairAddress, mintAddress, windowStartMs, windowEndMs, walletAddresses = [] }) {
  const key = buildWalletActivityCaptureCoverageKey({ pairAddress, mintAddress, windowStartMs, windowEndMs, walletAddresses });
  const { rows } = await query(
    `SELECT pair_address, mint_address, window_start_ms, window_end_ms, wallet_hash, status, signatures_in_window, parsed_entries, pages_walked, resume_signature, last_error, updated_at
       FROM wallet_activity_capture_coverage
      WHERE pair_address = $1 AND mint_address = $2 AND window_start_ms = $3 AND window_end_ms = $4 AND wallet_hash = $5`,
    [key.pairAddress, key.mintAddress, key.windowStartMs, key.windowEndMs, key.walletHash],
  );
  return rows || [];
}

function buildWalletActivityCaptureIdempotencyKey({ pairAddress, mintAddress, windowStartMs, windowEndMs, walletAddresses = [] }) {
  const wallets = [...new Set((walletAddresses || []).filter(Boolean))].sort();
  const walletHash = crypto.createHash('sha1').update(wallets.join(',')).digest('hex');
  return `wallet-activity-capture:${WALLET_CAPTURE_POLICY_VERSION}:${pairAddress}:${mintAddress}:${Number(windowStartMs)}:${Number(windowEndMs)}:${walletHash}`;
}

async function enqueueWalletActivityCaptureJobs(requests = []) {
  const jobIds = [];
  for (const request of requests) {
    if (!request?.pairAddress || !request?.mintAddress || !Number.isFinite(Number(request?.windowStartMs)) || !Number.isFinite(Number(request?.windowEndMs))) continue;
    const wallets = [...new Set((request.walletAddresses || []).filter(Boolean))].sort();
    const idempotencyKey = buildWalletActivityCaptureIdempotencyKey({
      pairAddress: request.pairAddress,
      mintAddress: request.mintAddress,
      windowStartMs: request.windowStartMs,
      windowEndMs: request.windowEndMs,
      walletAddresses: wallets,
    });
    const jobId = crypto.randomUUID();
    const payload = {
      pairAddress: request.pairAddress,
      mintAddress: request.mintAddress,
      windowStartMs: Number(request.windowStartMs),
      windowEndMs: Number(request.windowEndMs),
      walletAddresses: wallets,
    };
    const { rows } = await query(
      `INSERT INTO research_jobs (job_id, job_type, idempotency_key, payload, available_at)
       VALUES ($1, 'wallet_activity_capture', $2, $3::jsonb, now())
       ON CONFLICT (idempotency_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         available_at = CASE WHEN research_jobs.status IN ('failed', 'dead_letter') THEN now() ELSE research_jobs.available_at END,
         status = CASE WHEN research_jobs.status IN ('failed', 'dead_letter') THEN 'pending' ELSE research_jobs.status END,
         claimed_by = CASE WHEN research_jobs.status IN ('failed', 'dead_letter') THEN NULL ELSE research_jobs.claimed_by END,
         claimed_at = CASE WHEN research_jobs.status IN ('failed', 'dead_letter') THEN NULL ELSE research_jobs.claimed_at END,
         last_error = CASE WHEN research_jobs.status IN ('failed', 'dead_letter') THEN NULL ELSE research_jobs.last_error END
       RETURNING job_id`,
      [jobId, idempotencyKey, JSON.stringify(payload)],
    );
    if (rows[0]) jobIds.push(rows[0].job_id);
  }
  return jobIds;
}

async function getWalletActivityEvidenceState(walletAddress) {
  if (!walletAddress) return null;
  const { rows } = await query(
    `SELECT wallet_address, target_relevant_transactions, relevant_transactions,
            raw_signatures_scanned, raw_signatures_scanned_total, pages_scanned, pairs_scanned, coverage_before_ms,
            last_pair_address, last_signature, status, last_error, updated_at
       FROM wallet_activity_evidence_state
      WHERE wallet_address = $1`,
    [walletAddress],
  );
  return rows[0] || null;
}

async function upsertWalletActivityEvidenceState({
  walletAddress,
  targetRelevantTransactions = 1000,
  relevantTransactions = 0,
  rawSignaturesScanned = 0,
  rawSignaturesScannedTotal = 0,
  pagesScanned = 0,
  pairsScanned = 0,
  coverageBeforeMs = null,
  lastPairAddress = null,
  lastSignature = null,
  status = 'pending',
  lastError = null,
} = {}) {
  if (!walletAddress) throw new Error('walletAddress is required');
  const { rows } = await query(
    `INSERT INTO wallet_activity_evidence_state
       (wallet_address, target_relevant_transactions, relevant_transactions,
        raw_signatures_scanned, raw_signatures_scanned_total, pages_scanned, pairs_scanned, coverage_before_ms,
        last_pair_address, last_signature, status, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (wallet_address) DO UPDATE SET
       target_relevant_transactions = EXCLUDED.target_relevant_transactions,
       relevant_transactions = EXCLUDED.relevant_transactions,
       raw_signatures_scanned = EXCLUDED.raw_signatures_scanned,
       raw_signatures_scanned_total = EXCLUDED.raw_signatures_scanned_total,
       pages_scanned = EXCLUDED.pages_scanned,
       pairs_scanned = EXCLUDED.pairs_scanned,
       coverage_before_ms = EXCLUDED.coverage_before_ms,
       last_pair_address = EXCLUDED.last_pair_address,
       last_signature = EXCLUDED.last_signature,
       status = EXCLUDED.status,
       last_error = EXCLUDED.last_error,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      walletAddress,
      Math.max(1, Number(targetRelevantTransactions) || 1000),
      Math.max(0, Number(relevantTransactions) || 0),
      Math.max(0, Number(rawSignaturesScanned) || 0),
      Math.max(0, Number(rawSignaturesScannedTotal) || 0),
      Math.max(0, Number(pagesScanned) || 0),
      Math.max(0, Number(pairsScanned) || 0),
      coverageBeforeMs === null ? null : Number(coverageBeforeMs),
      lastPairAddress,
      lastSignature,
      String(status),
      lastError ? String(lastError).slice(0, 4000) : null,
      Date.now(),
    ],
  );
  return rows[0] || null;
}

async function enqueueWalletEvidenceCaptureJobs(requests = []) {
  const jobIds = [];
  for (const request of requests) {
    const walletAddress = request?.walletAddress;
    if (!walletAddress || !Number.isFinite(Number(request?.beforeMs))) continue;
    const idempotencyKey = `wallet-evidence-capture:${WALLET_EVIDENCE_POLICY_VERSION}:${walletAddress}`;
    const jobId = crypto.randomUUID();
    const payload = {
      walletEvidenceMode: true,
      walletEvidencePolicyVersion: WALLET_EVIDENCE_POLICY_VERSION,
      walletAddress,
      currentPairAddress: request.currentPairAddress || null,
      beforeMs: Number(request.beforeMs),
      targetRelevantTransactions: Number(request.targetRelevantTransactions) || 1000,
      maxHistoricalPairs: Number(request.maxHistoricalPairs) || 100,
      windowMinutes: Number(request.windowMinutes) || 30,
    };
    const { rows } = await query(
      `INSERT INTO research_jobs (job_id, job_type, idempotency_key, payload, available_at)
       VALUES ($1, 'wallet_evidence_capture', $2, $3::jsonb, now())
       ON CONFLICT (idempotency_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         available_at = CASE
           WHEN research_jobs.status IN ('completed', 'failed', 'dead_letter') THEN now()
           ELSE research_jobs.available_at
         END,
         status = CASE
           WHEN research_jobs.status IN ('completed', 'failed', 'dead_letter') THEN 'pending'
           ELSE research_jobs.status
         END,
         claimed_by = CASE
           WHEN research_jobs.status IN ('completed', 'failed', 'dead_letter') THEN NULL
           ELSE research_jobs.claimed_by
         END,
         claimed_at = CASE
           WHEN research_jobs.status IN ('completed', 'failed', 'dead_letter') THEN NULL
           ELSE research_jobs.claimed_at
         END,
         last_error = CASE
           WHEN research_jobs.status IN ('completed', 'failed', 'dead_letter') THEN NULL
           ELSE research_jobs.last_error
         END
       RETURNING job_id`,
      [jobId, idempotencyKey, JSON.stringify(payload)],
    );
    if (rows[0]) jobIds.push(rows[0].job_id);
  }
  return jobIds;
}

async function enqueueAlertObservationJobs({ alertId, pairAddress, mintAddress, qualifiedAt, horizons = DEFAULT_HORIZONS }) {
  const jobIds = [];
  for (const horizon of horizons) {
    const idempotencyKey = `alert-observation:${alertId}:${horizon.key}`;
    const jobId = crypto.randomUUID();
    const availableAt = new Date(new Date(qualifiedAt).getTime() + horizon.minutes * 60_000);
    const payload = {
      alertId,
      pairAddress,
      mintAddress,
      horizon: horizon.key,
      horizonMinutes: horizon.minutes,
      qualifiedAt,
    };
    const { rows } = await query(
      `INSERT INTO research_jobs (job_id, job_type, idempotency_key, payload, available_at)
       VALUES ($1, 'alert_observation', $2, $3::jsonb, $4)
       ON CONFLICT (idempotency_key) DO UPDATE SET payload = research_jobs.payload
       RETURNING job_id`,
      [jobId, idempotencyKey, JSON.stringify(payload), availableAt],
    );
    jobIds.push(rows[0].job_id);
  }
  return jobIds;
}

module.exports = {
  DEFAULT_HORIZONS,
  MAX_ATTEMPTS,
  enqueueAlertObservationJobs,
  enqueueWalletActivityCaptureJobs,
  buildWalletActivityCaptureCoverageKey,
  recordWalletActivityCaptureCoverage,
  getWalletActivityCaptureCoverage,
  getWalletActivityEvidenceState,
  upsertWalletActivityEvidenceState,
  enqueueWalletEvidenceCaptureJobs,
  buildWalletActivityCaptureIdempotencyKey,
  enqueueEdpiLPersistenceJob,
  claimResearchJob,
  completeResearchJob,
  failResearchJob,
  releaseResearchJob,
};
