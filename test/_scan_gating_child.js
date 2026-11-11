'use strict';
// Child process for audit_regressions: runs one scan cycle with stores stubbed and reports which writes happened.
const path = require('path');
const root = path.join(__dirname, '..');
const calls = [];
const outcome = require(root + '/src/storage/discoveryOutcomeStore');
outcome.recordDiscoveryEvents = async () => { calls.push('events'); return { eventIds: new Map(), newEvents: [{ discoveryEventId: 'e1' }] }; };
require(root + '/src/storage/discoveryObservationStore').enqueueDiscoveryOutcomeJobs = async () => { calls.push('outcome_jobs'); return []; };
outcome.recordDiscoveryEvaluations = async () => { calls.push('evaluations'); return {}; };
require(root + '/src/storage/discoveryStore').recordDiscoveries = async () => { calls.push('provenance'); };
require(root + '/src/services/discoveryService').getCandidatePairs = async () => [];
const scanner = require(root + '/src/core/tokenScanner');
(async () => { await scanner.runScanCycle(); console.log('CALLS=' + JSON.stringify(calls)); process.exit(0); })().catch((e) => { console.log('ERR=' + e.message); process.exit(1); });
