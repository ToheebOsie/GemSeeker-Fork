const { admin, reports } = require('../config');
const patternStore = require('../storage/tokenPatternStore');
const reportState = require('../storage/reportStateStore');
const { computeSelfAssessment } = require('./selfAssessment');
const { formatSelfAssessmentReport } = require('../bot/reportFormatter');

/**
 * Wraps bot.sendMessage the same way telegramBot.js's safeSend does — a
 * failed send (blocked bot, transient Telegram error) should be logged,
 * not thrown, so it can never take down the scan loop or the process.
 */
async function sendToAdmins(bot, text) {
  for (const chatId of admin.chatIds) {
    try {
      await bot.sendMessage(chatId, text);
    } catch (err) {
      console.error(`[reportScheduler] failed to send report to admin ${chatId}: ${err.message}`);
    }
  }
}

/**
 * Checks whether the daily/weekly windows have elapsed since they were
 * last sent (per reportStateStore) and sends+records any that have. Both
 * are checked independently in the same tick so a slow restart doesn't
 * cause them to drift apart. Isolated in its own try/catch per report so
 * a failure sending the daily report can't suppress the weekly one.
 */
async function checkAndSendReports(bot, now = Date.now()) {
  if (!reports.enabled) return;
  if (admin.chatIds.length === 0) return; // nobody to send to

  const state = await reportState.getState();
  const archive = await patternStore.getArchive();

  const dailyDue = !state.lastDailyReportAt || (now - state.lastDailyReportAt) >= reports.dailyIntervalMs;
  if (dailyDue) {
    try {
      const stats = computeSelfAssessment(archive, reports.dailyIntervalMs, now);
      await sendToAdmins(bot, formatSelfAssessmentReport('Daily', stats));
      await reportState.setState({ lastDailyReportAt: now });
    } catch (err) {
      console.error(`[reportScheduler] daily report failed: ${err.message}`);
    }
  }

  const weeklyDue = !state.lastWeeklyReportAt || (now - state.lastWeeklyReportAt) >= reports.weeklyIntervalMs;
  if (weeklyDue) {
    try {
      const stats = computeSelfAssessment(archive, reports.weeklyIntervalMs, now);
      await sendToAdmins(bot, formatSelfAssessmentReport('Weekly', stats));
      await reportState.setState({ lastWeeklyReportAt: now });
    } catch (err) {
      console.error(`[reportScheduler] weekly report failed: ${err.message}`);
    }
  }
}

/**
 * Starts the hourly-tick scheduler loop. Returns a stop function, same
 * shape as startScanLoop/startPatternReviewLoop in the other core/*.js
 * modules, so index.js can shut all three down uniformly.
 */
function startReportScheduler(bot) {
  if (!reports.enabled) {
    console.log('[reportScheduler] reports.enabled is false — scheduler not started.');
    return () => {};
  }
  if (admin.chatIds.length === 0) {
    console.log('[reportScheduler] no ADMIN_CHAT_IDS configured — scheduler not started.');
    return () => {};
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await checkAndSendReports(bot);
    } catch (err) {
      console.error(`[reportScheduler] tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  tick(); // catch up immediately on startup if a window was missed while offline
  const handle = setInterval(tick, reports.checkIntervalMs);
  return () => clearInterval(handle);
}

module.exports = {
  checkAndSendReports,
  startReportScheduler,
};
