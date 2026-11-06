'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { earlyWalletBackfill } = require('../config');

/**
 * Runs the existing RPC backfill as a bounded child process. The scheduler is
 * opt-in because early-wallet reconstruction consumes RPC quota; every run
 * remains resumable through the backfill script's checkpoints and archive
 * status columns. A single child is allowed at a time.
 */
function startEarlyWalletBackfillScheduler() {
  if (!earlyWalletBackfill.enabled) {
    console.log('[earlyWalletBackfill] disabled — set EARLY_WALLET_BACKFILL_ENABLED=true to enable.');
    return () => {};
  }

  let child = null;
  let stopped = false;
  let timer = null;
  let startTimer = null;
  let running = false;
  const script = path.resolve(__dirname, '../../scripts/backfill-early-wallets.js');

  const runOnce = () => {
    if (stopped || running) return;
    running = true;
    const args = [script,
      `--limit=${earlyWalletBackfill.batchSize}`,
      `--window-minutes=${earlyWalletBackfill.windowMinutes}`,
      `--min-sol=${earlyWalletBackfill.minSol}`,
      `--sig-cap=${earlyWalletBackfill.sigCap}`,
      `--max-tx-parse=${earlyWalletBackfill.maxTxParse}`,
      `--max-rpc-requests=${earlyWalletBackfill.maxRpcRequests}`,
      `--max-elapsed-ms=${earlyWalletBackfill.maxElapsedMs}`,
      `--max-db-writes=${earlyWalletBackfill.maxDbWrites}`,
      `--page-sleep-ms=${earlyWalletBackfill.pageSleepMs}`,
      `--tx-sleep-ms=${earlyWalletBackfill.txSleepMs}`,
    ];
    console.log(`[earlyWalletBackfill] starting bounded run: ${args.slice(1).join(' ')}`);
    child = spawn(process.execPath, args, { env: process.env, stdio: 'inherit' });
    child.once('error', (error) => {
      console.error(`[earlyWalletBackfill] child failed to start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      child = null;
      running = false;
      console.log(`[earlyWalletBackfill] run finished: code=${code ?? 'null'} signal=${signal || 'none'}`);
    });
  };

  timer = setInterval(runOnce, earlyWalletBackfill.intervalMs);
  startTimer = setTimeout(runOnce, earlyWalletBackfill.startDelayMs);
  console.log(`[earlyWalletBackfill] enabled — ${earlyWalletBackfill.batchSize} token(s) every ${earlyWalletBackfill.intervalMs / 60000} minute(s).`);

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(startTimer);
    if (child) {
      child.kill('SIGTERM');
      child = null;
    }
  };
}

module.exports = { startEarlyWalletBackfillScheduler };
