'use strict';

const { getAlertDecision, persistEdpiLEvaluation } = require('../storage/alertDecisionStore');
const { listAlertObservations } = require('../storage/alertObservationStore');
const { upsertEvaluation } = require('../storage/alertEvaluationStore');
const {
  claimResearchJob,
  completeResearchJob,
  failResearchJob,
  releaseResearchJob,
} = require('../storage/researchJobStore');
const { collectAlertObservation } = require('../services/alertObservationService');
const { collectDiscoveryOutcomeObservation } = require('../services/discoveryOutcomeObservationService');
const { processWalletActivityCaptureJob } = require('../services/canonicalWalletActivityCapture');
const { evaluateAlert } = require('../core/alertEvaluator');
const health = require('../observability/workerHealth');
const { startHealthServer } = require('../observability/healthServer');

const WORKER_NAME = 'research-observation';
health.ensureWorker(WORKER_NAME);

const POLL_MS = Number(process.env.RESEARCH_OBSERVATION_POLL_MS || 1000);
const WORKER_ID = `research-observation-${process.pid}-${Math.random().toString(16).slice(2)}`;

async function processObservationJob(job, { dryRun = false } = {}) {
  const payload = job.payload || {};
  if (!['alert_observation', 'discovery_observation', 'edpi_l_persistence', 'wallet_activity_capture', 'wallet_evidence_capture'].includes(job.job_type)) {
    await completeResearchJob(job.job_id, WORKER_ID);
    return { status: 'ignored', jobId: job.job_id };
  }

  if (dryRun) {
    await releaseResearchJob(job.job_id, WORKER_ID);
    return { status: 'dry_run', jobId: job.job_id };
  }

  if (job.job_type === 'edpi_l_persistence') {
    const decision = await getAlertDecision(payload.alertId);
    if (!decision) throw new Error(`alert decision not found: ${payload.alertId}`);
    const edpiL = decision.liveEvidence?.edpiL || null;
    if (!edpiL) throw new Error(`EDPI-L evidence not present in alert decision: ${payload.alertId}`);
    await persistEdpiLEvaluation({
      alertId: payload.alertId,
      pairAddress: decision.pairAddress,
      mintAddress: decision.mintAddress,
      qualifiedAt: decision.alertDecision?.qualifiedAt,
      edpiL,
    }, payload.alertId);
    await completeResearchJob(job.job_id, WORKER_ID);
    return { status: 'completed', jobId: job.job_id, persistenceType: 'edpi_l' };
  }

  if (job.job_type === 'wallet_activity_capture' || job.job_type === 'wallet_evidence_capture') {
    const result = await processWalletActivityCaptureJob({ ...payload, recordCoverage: true });
    const terminalCaptureStatuses = new Set([
      'complete', 'complete-empty', 'complete-tx-capped', 'target-reached',
      'end_of_history', 'raw_safety_cap', 'pair_safety_cap',
    ]);
    const retryableCaptureStatuses = new Set(['error', 'truncated', 'parse-incomplete', 'complete-tx-capped']);
    if (retryableCaptureStatuses.has(result.status)) {
      await failResearchJob(job.job_id, WORKER_ID, `wallet activity capture incomplete: ${result.status}${result.error ? `: ${result.error}` : ''}`, job.attempts);
      return { status: 'retry_scheduled', jobId: job.job_id, captureStatus: result.status, entries: result.entries?.length || 0 };
    }
    if (!terminalCaptureStatuses.has(result.status)) {
      throw new Error(`unknown wallet activity capture status: ${result.status}`);
    }
    await completeResearchJob(job.job_id, WORKER_ID);
    return {
      status: 'completed',
      jobId: job.job_id,
      captureStatus: result.status,
      entries: result.entries?.length || 0,
      relevantTransactions: result.relevantTransactions ?? null,
      rawSignaturesScanned: result.rawSignaturesScanned ?? null,
    };
  }

  if (job.job_type === 'discovery_observation') {
    const observation = await collectDiscoveryOutcomeObservation({
      discoveryEventId: payload.discoveryEventId,
      pairAddress: payload.pairAddress,
      mintAddress: payload.mintAddress,
      source: payload.source,
      horizonKey: payload.horizon,
      targetAt: new Date(new Date(payload.discoveredAt).getTime() + Number(payload.horizonMinutes || 0) * 60_000),
    });
    await completeResearchJob(job.job_id, WORKER_ID);
    return { status: 'completed', jobId: job.job_id, observationId: observation.observation_id, observationType: 'discovery' };
  }

  const observation = await collectAlertObservation({
    alertId: payload.alertId,
    pairAddress: payload.pairAddress,
    mintAddress: payload.mintAddress,
    horizonKey: payload.horizon,
    targetAt: payload.qualifiedAt
      ? new Date(new Date(payload.qualifiedAt).getTime() + Number(payload.horizonMinutes || 0) * 60_000)
      : new Date(),
  });

  const decision = await getAlertDecision(payload.alertId);
  if (!decision) throw new Error(`alert decision not found: ${payload.alertId}`);
  const observations = await listAlertObservations(payload.alertId);
  const evaluation = evaluateAlert({
    signalLabel: decision.signalLabel,
    referencePrice: decision.priceUsd,
    observations,
    evidenceClass: payload.evidenceClass || 'forward',
  });
  await upsertEvaluation({ alertId: payload.alertId, ...evaluation });
  await completeResearchJob(job.job_id, WORKER_ID);
  return { status: 'completed', jobId: job.job_id, observationId: observation.observation_id, outcomeLabel: evaluation.outcomeLabel };
}

async function runObservationTick({ dryRun = false } = {}) {
  health.markTick(WORKER_NAME);
  let job;
  try {
    job = await claimResearchJob(WORKER_ID);
  } catch (err) {
    health.markError(WORKER_NAME, err, 'claim_errors_total');
    console.error(`[research-observation] claim failed: ${err.message}`);
    return { status: 'degraded', error: err.message };
  }
  if (!job) {
    health.markSuccess(WORKER_NAME, 'empty_polls_total');
    return null;
  }
  try {
    const result = await processObservationJob(job, { dryRun });
    health.markSuccess(WORKER_NAME, result.status === 'completed' ? 'jobs_completed_total' : 'jobs_skipped_total');
    return result;
  } catch (err) {
    health.markError(WORKER_NAME, err, 'job_errors_total');
    await failResearchJob(job.job_id, WORKER_ID, err.message, job.attempts);
    console.error(`[research-observation] job ${job.job_id} failed: ${err.message}`);
    return { status: 'failed', jobId: job.job_id, error: err.message };
  }
}

function startResearchObservationWorker({ dryRun = process.env.RESEARCH_OBSERVATION_DRY_RUN !== 'false', pollMs = POLL_MS, healthPort = Number(process.env.HEALTH_PORT || 8080) } = {}) {
  health.markStarted(WORKER_NAME);
  const healthServer = healthPort === false ? { close() {} } : startHealthServer({ requiredWorkers: [WORKER_NAME], port: healthPort });
  let stopped = false;
  let inFlight = null;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = runObservationTick({ dryRun }).finally(() => { inFlight = null; });
  }, pollMs);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      healthServer.close();
      if (inFlight) await inFlight;
    },
  };
}

if (require.main === module) {
  startResearchObservationWorker();
  console.log(`[research-observation] started in ${process.env.RESEARCH_OBSERVATION_DRY_RUN === 'false' ? 'active' : 'dry-run'} mode`);
}

module.exports = { processObservationJob, runObservationTick, startResearchObservationWorker, WORKER_ID };
