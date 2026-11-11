'use strict';
// Child process for audit_regressions: processes one queued discovery_observation job with outcome observations disabled.
const path = require('path');
const root = path.join(__dirname, '..');
const calls = [];
const jobs = require(root + '/src/storage/researchJobStore');
jobs.completeResearchJob = async () => { calls.push('complete'); };
jobs.releaseResearchJob = async () => { calls.push('release'); };
require(root + '/src/storage/discoveryObservationStore').upsertDiscoveryObservation = async () => { calls.push('WRITE'); return {}; };
global.fetch = async () => { calls.push('FETCH'); throw new Error('no network expected'); };
const worker = require(root + '/src/workers/researchObservationWorker');
(async () => {
  const out = await worker.processObservationJob({ job_id: 'j1', job_type: 'discovery_observation', payload: { discoveryEventId: 'e1', pairAddress: 'P', mintAddress: 'M', source: 'dexscreener', horizon: '5m', discoveredAt: new Date().toISOString() } }, { dryRun: false });
  console.log('OUT=' + JSON.stringify({ status: out.status, calls }));
  process.exit(0);
})().catch((e) => { console.log('ERR=' + e.message); process.exit(1); });
