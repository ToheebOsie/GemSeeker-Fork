const { createBot, broadcastAlerts, TELEGRAM_WORKER_NAME } = require('./bot/telegramBot');
const { startScanLoop } = require('./core/tokenScanner');
const { startPatternReviewLoop } = require('./core/patternReviewer');
const { startReportScheduler } = require('./core/reportScheduler');
const { startMarketStateScheduler } = require('./core/marketStateEngine');
const { startEarlyWalletBackfillScheduler } = require('./core/earlyWalletBackfillScheduler');
const { isAlertable } = require('./core/alertPolicy');
const { ensureSchema } = require('./db/schema');
const { ensureShardSchema } = require('./db/shardSchema');
const { gemini, payments, patternTracking, admin, marketState, alerts, backgroundJobs } = require('./config'); // Verify gemini/payments config is available
const { startResearchWorker } = require('./workers/researchWorker');
const { startTelegramWorker } = require('./workers/telegramWorker');
const { startNotificationWorker } = require('./workers/notificationWorker');
const { startResearchObservationWorker } = require('./workers/researchObservationWorker');
const { startHealthServer } = require('./observability/healthServer');
const { requiredWorkers, startIf } = require('./core/backgroundJobs');
const { logRuntimeIdentity, runtimeTag } = require('./observability/runtimeIdentity');

// Last-resort safety net. This is NOT a substitute for proper try/catch at
// call sites (which is the real fix — see telegramBot.js's safeSend and the
// /verify handler), but it protects against anything that slips through
// regardless: without this, ANY unhandled rejection anywhere in the process
// terminates it immediately (Node 15+ default), which for an always-on bot
// means one bad interaction takes down alerts for every subscriber until
// someone manually restarts it. We'd rather log and keep running.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal-guard] Unhandled promise rejection (bot stayed alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal-guard] Uncaught exception (bot stayed alive):', err);
});

async function main() {
  logRuntimeIdentity();
  // Verify required configuration on startup — fail fast and loudly rather
  // than starting "successfully" and only discovering a missing/broken
  // setting when a real user hits it (e.g. every /verify silently failing
  // because PAYMENT_WALLET_ADDRESS was never set).
  if (!gemini.apiKey) {
    console.error('[fatal] GEMINI_API_KEY is not configured in environment.');
    process.exit(1);
  }
  if (!payments.walletAddress) {
    console.error('[fatal] PAYMENT_WALLET_ADDRESS is not configured in environment — no payment could ever be verified.');
    process.exit(1);
  }

  await ensureSchema();
  await ensureShardSchema();
  console.log('[startup] Database schema verified/applied.');

  const bot = createBot();
  console.log('[startup] Telegram bot connected and polling.');

  // Single-service Railway mode: keep Telegram polling in this process and
  // embed the PostgreSQL outbox/research workers rather than requiring one
  // Railway service per worker. Consumer workers do not open HTTP ports;
  // notification and observation workers share the main health server.
  const workerDryRun = process.env.WORKER_DRY_RUN !== 'false';
  const bg = backgroundJobs;
  const stopResearchWorker = startIf(bg.researchWorkerEnabled, () => startResearchWorker({ dryRun: workerDryRun }));
  const stopTelegramWorker = startTelegramWorker({ dryRun: workerDryRun });
  const stopNotificationWorker = startNotificationWorker({
    dryRun: process.env.NOTIFICATION_WORKER_DRY_RUN !== 'false',
    healthPort: false,
  }).stop;
  const stopResearchObservationWorker = startIf(bg.researchObservationWorkerEnabled, () => startResearchObservationWorker({
    dryRun: process.env.RESEARCH_OBSERVATION_DRY_RUN !== 'false',
    healthPort: false,
  }).stop);
  const mainHealthServer = startHealthServer({
    port: Number(process.env.HEALTH_PORT || 8080),
    // 'telegram' added so /readyz (and the process this container runs
    // under, e.g. Railway's health check) can actually detect a dead
    // polling loop instead of only ever reflecting the two DB workers.
    // Also catches the case where createBot() is never even called at all
    // (e.g. this container's start command doesn't run src/index.js) —
    // the 'telegram' worker then never registers with workerHealth in the
    // first place, so isReady() sees it as missing rather than merely
    // unhealthy and /readyz correctly reports not-ready.
    requiredWorkers: requiredWorkers({ researchObservationWorkerEnabled: bg.researchObservationWorkerEnabled, telegramWorkerName: TELEGRAM_WORKER_NAME }),
  });
  console.log(`[startup] Embedded database workers active (worker dry-run: ${workerDryRun ? 'on' : 'off'}, research observation: ${process.env.RESEARCH_OBSERVATION_DRY_RUN === 'false' ? 'live' : 'dry-run'}, notifications: ${process.env.NOTIFICATION_WORKER_DRY_RUN === 'false' ? 'live' : 'dry-run'}).`);
  console.log(`[startup] Background jobs — research worker: ${bg.researchWorkerEnabled ? 'on' : 'OFF'}, research-observation worker: ${bg.researchObservationWorkerEnabled ? 'on' : 'OFF'}, discovery events: ${bg.discoveryEventsEnabled ? 'on' : 'OFF'}, discovery evaluations: ${bg.discoveryEvaluationsEnabled ? 'on' : 'OFF'}.`);
  if (bg.discoveryEventsEnabled && !bg.researchObservationWorkerEnabled) console.warn('[startup] WARNING: discovery events are stored but the research-observation worker is OFF — discovery_observation jobs will queue unprocessed in this process.');
  console.log(`[startup] Gemini AI signals active using model: ${gemini.model}`);
  const allAlertsUnfiltered = alerts.classLevels.length === 3 && alerts.verdicts.length === 3;
  console.log(allAlertsUnfiltered
    ? '[startup] Alert broadcast filter: none (CLASS_ALERTS/VERDICT_ALERTS unset — every risk class and verdict is sent, same as always).'
    : `[startup] Alert broadcast filter active — classes: [${alerts.classLevels.join(', ') || 'none'}], verdicts: [${alerts.verdicts.join(', ') || 'none'}]. Every class/verdict is still tracked and archived regardless.`);

  const stopScanning = startScanLoop(async (qualifiedTokens) => {
    console.log(`[scanner] ${qualifiedTokens.length} token(s) qualified this cycle.`);
    // CLASS_ALERTS/VERDICT_ALERTS filter — see alertPolicy.js. Every
    // qualified token was already tracked/archived/enrolled inside
    // runScanCycle above regardless of this filter; this only decides
    // which subset actually gets sent to subscribers below.
    const alertableTokens = qualifiedTokens.filter(isAlertable);
    if (alertableTokens.length < qualifiedTokens.length) {
      console.log(`[alerts] ${qualifiedTokens.length - alertableTokens.length} of ${qualifiedTokens.length} qualified token(s) held back from broadcast by CLASS_ALERTS/VERDICT_ALERTS (still tracked normally).`);
    }
    // Persisted decisions already created ALERT_QUALIFIED outbox events.
    // Let the embedded Telegram and notification workers own delivery so the
    // direct legacy broadcast path cannot send the same alert twice. Only
    // decisions that failed to persist have no outbox event and use the
    // best-effort legacy fallback.
    const fallbackTokens = alertableTokens.filter((token) => !token.alertId);
    if (fallbackTokens.length > 0) {
      console.error(`[alerts] ${fallbackTokens.length} alert(s) lacked durable IDs; using direct fallback broadcast.`);
      await broadcastAlerts(bot, fallbackTokens);
    }
  });

  const stopPatternReview = startPatternReviewLoop();
  if (patternTracking.enabled) {
    console.log(`[startup] Pattern tracking active — reviewing tokens under ${patternTracking.earlyLifeWindowMs / 3_600_000}h old every ${patternTracking.earlyLifeReviewIntervalMs / 60_000}min, older tokens every ${patternTracking.reviewIntervalMs / 3_600_000}h.`);
  }

  if (admin.chatIds.length > 0) {
    console.log(`[startup] Admin chat IDs configured: ${admin.chatIds.length} (unlimited alert access, admin commands, self-assessment reports).`);
  } else {
    console.log('[startup] No ADMIN_CHAT_IDS configured — admin panel and self-assessment reports are disabled.');
  }
  const stopReportScheduler = startReportScheduler(bot);

  const stopMarketState = startMarketStateScheduler(marketState.intervalMs, marketState.enabled);
  const stopEarlyWalletBackfill = startEarlyWalletBackfillScheduler();
  if (marketState.enabled) {
    console.log(`[startup] Market state engine active — recomputing daily per-narrative aggregates every ${marketState.intervalMs / 3_600_000}h.`);
  }

  const shutdown = async () => {
    console.log('\n[shutdown] Stopping scan loop, pattern review loop, report scheduler, market state engine, early-wallet backfill scheduler, and bot polling...');
    stopScanning();
    stopPatternReview();
    stopReportScheduler();
    stopMarketState();
    stopEarlyWalletBackfill();
    mainHealthServer.close();
    await Promise.allSettled([
      stopResearchWorker(),
      stopTelegramWorker(),
      stopNotificationWorker(),
      stopResearchObservationWorker(),
    ]);
    await bot.stopPolling();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
