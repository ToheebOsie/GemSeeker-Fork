const TelegramBot = require('../services/telegramBotApi');
const { PublicKey } = require('@solana/web3.js');
const { telegram, payments, admin, patternTracking, reports, observation } = require('../config');
const health = require('../observability/workerHealth');
const store = require('../storage/subscriberStore');
const patternStore = require('../storage/tokenPatternStore');
const marketStateStore = require('../storage/marketStateStore');
const reportState = require('../storage/reportStateStore');
const observationEngine = require('../core/observationEngine');
const { utcDateString } = require('../core/marketStateEngine');
const solanaService = require('../services/solanaService');
const priceService = require('../services/priceService');
const { formatAlert } = require('./alertFormatter');
const { formatSelfAssessmentReport } = require('./reportFormatter');
const { formatNarrativeIntelligence, formatNarrativeEvolution } = require('./narrativeFormatter');
const { formatMarketInsights, formatMarketInsightsHistory } = require('./marketStateFormatter');
const { NARRATIVE_LABELS, resolveNarrativeTag } = require('../core/narrativeLabels');
const { computeSelfAssessment } = require('../core/selfAssessment');
const researchReportStore = require('../storage/researchReportStore');
const { buildAdminExport } = require('../services/adminDataExport');
const trackedTokenReportStore = require('../storage/trackedTokenReportStore');
const { formatTrackedTokenReport } = require('./trackedTokenReportFormatter');
const {
  getNarrativeHeat, getNarrativeRotation, getNarrativeEvolution, getMonthlyNarrativeAssessment,
} = require('../core/narrativeIntelligence');

/**
 * Whether a chat ID is a configured admin — see config.js `admin.chatIds`
 * (from the ADMIN_CHAT_IDS env var). Admins bypass trial/subscription
 * gating entirely (broadcastAlerts below) and get access to the
 * admin-only /admin and /report commands.
 */
function isAdmin(chatId) {
  return admin.chatIds.includes(String(chatId));
}

// Name this bot's polling loop is tracked under in
// src/observability/workerHealth.js — same registry every other worker
// (notification, research-observation) already reports into. Before this,
// the Telegram bot was the one worker with zero presence in /healthz,
// /readyz, or /metrics: if polling wedged (an invalid token, a conflicting
// second poller, ...) nothing would ever surface it short of grepping raw
// console logs for "[telegram] polling failed".
const WORKER_NAME = 'telegram';

function createBot() {
  if (!telegram.token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set — cannot start the bot.');
  }
  health.ensureWorker(WORKER_NAME);
  const bot = new TelegramBot(telegram.token, { polling: true });
  // Registered right after construction, before any await has had a chance
  // to run (see telegramBotApi.js's constructor/startPolling — the first
  // real network call doesn't happen until the current synchronous tick
  // finishes), so no tick or error from the very first poll can be missed.
  bot.on('polling_tick', () => health.markTick(WORKER_NAME));
  bot.on('polling_error', ({ error }) => health.markError(WORKER_NAME, error, 'polling_errors_total'));
  registerHandlers(bot);
  health.markStarted(WORKER_NAME);
  return bot;
}

/**
 * Wraps bot.sendMessage so a failure (blocked user, Telegram API hiccup,
 * rate limit) is logged instead of becoming an unhandled promise
 * rejection. Every send in this file used to be fire-and-forget
 * (no await, no .catch) with no global process-level safety net either —
 * a single failed send could crash the whole bot process for every
 * subscriber, not just the one interaction. Returns true/false so callers
 * that need to know (e.g. broadcastAlerts, for alert-count bookkeeping)
 * still can.
 */
async function safeSend(bot, chatId, text, opts) {
  try {
    await bot.sendMessage(chatId, text, opts);
    return true;
  } catch (err) {
    console.error(`[bot] sendMessage to ${chatId} failed: ${err.message}`);
    return false;
  }
}

function registerHandlers(bot) {
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const existing = await store.getSubscriber(chatId);
      if (!existing) {
        await store.upsertSubscriber(chatId, { username: msg.chat.username || null });
      }
      const lines = [
        'Welcome to Gem Seeker — Solana memecoin launch alerts.',
        '',
      ];
      if (isAdmin(chatId)) {
        lines.push('You are an admin — unlimited alert access, no trial limit or subscription needed.');
      } else {
        lines.push(`You get ${payments.trialAlertCount} free alerts to try it out.`);
        lines.push(`After that, it's $${payments.priceUsd}/month, paid in SOL, USDC, or USDT.`);
      }
      lines.push('', 'Commands:', '/status — check your trial/subscription status', '/subscribe — see payment instructions', '/verify <tx_signature> <your_wallet_address> — confirm a payment you sent');
      if (isAdmin(chatId)) {
        lines.push(
          '/admin — admin panel (subscriber & tracking stats)',
          '/report — on-demand self-assessment report',
          '/resetwallet <chatId> — clear a subscriber\'s bound payment wallet (legitimate wallet switches)',
          '/dailyupdate — tracked tokens qualified today (UTC)',
          '/weeklyupdate — tracked tokens qualified this week (UTC)',
        );
      }
      lines.push('', 'This is not a financial advice. Signals are automated and speculative — always do your own research.');
      await safeSend(bot, chatId, lines.join('\n'));
    } catch (err) {
      console.error(`[bot] /start error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Something went wrong setting up your account. Please try /start again in a moment.');
    }
  });

  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      if (isAdmin(chatId)) {
        await safeSend(bot, chatId, 'Admin — unlimited alert access (no trial limit, no subscription required).');
        return;
      }
      const sub = await store.getSubscriber(chatId);
      if (!sub) {
        await safeSend(bot, chatId, "You're not registered yet — send /start first.");
        return;
      }
      const expiresAt = sub.subscriptionExpiresAt ? new Date(sub.subscriptionExpiresAt) : null;
      const isActive = expiresAt && expiresAt.getTime() > Date.now();

      if (isActive) {
        await safeSend(bot, chatId, `Active subscription — renews/expires ${expiresAt.toISOString().slice(0, 10)}.`);
      } else {
        const remaining = Math.max(0, payments.trialAlertCount - (sub.alertsSent || 0));
        await safeSend(bot, chatId, remaining > 0
          ? `Trial mode — ${remaining} of ${payments.trialAlertCount} free alerts remaining.`
          : 'Your trial has ended and you have no active subscription. Send /subscribe to continue.');
      }
    } catch (err) {
      console.error(`[bot] /status error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Something went wrong checking your status. Please try again in a moment.');
    }
  });

  bot.onText(/\/subscribe/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await safeSend(bot, chatId, [
        `To subscribe ($${payments.priceUsd}/month):`,
        `1. Send SOL, USDC, or USDT worth at least $${payments.priceUsd} to:`,
        `\`${payments.walletAddress}\``,
        '2. Copy the transaction signature from your wallet.',
        '3. Send it here as: /verify <signature> <your_wallet_address>',
        '',
        '`your_wallet_address` is the wallet you just paid FROM — this ties the '
        + 'payment to your account so a signature (which becomes public the moment '
        + 'it confirms) can\'t be claimed by someone else who happens to spot it first.',
      ].join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`[bot] /subscribe error for ${chatId}: ${err.message}`);
    }
  });

  // AUDIT FIX (front-running): now requires TWO arguments — the tx
  // signature AND the wallet address it was sent from. Previously /verify
  // only checked that a transaction paid our wallet, never who sent it —
  // since a signature is public the instant it confirms, anyone who spotted
  // a qualifying payment could paste it into their OWN /verify and claim
  // someone else's subscription. The declared sender is checked against the
  // transaction's actual fee payer on-chain (solanaService), then
  // bound/checked against this chat's previously-verified wallet, if any
  // (subscriberStore.bindOrCheckSenderWallet) — so once an account has paid
  // once, a stranger sniping a different signature from a different wallet
  // can no longer hijack it. See solanaService.verifyPaymentTransaction's
  // docstring for the known limitation this doesn't cover (first-ever
  // payment for a brand-new chat still has nothing to bind against yet).
  bot.onText(/\/verify (\S+)\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const signature = match[1].trim();
    const senderAddress = match[2].trim();
    let reserved = false;

    // Cheap format check before touching the reservation table or the RPC
    // at all — PublicKey's constructor throws on anything that isn't a
    // valid base58-encoded 32-byte address, which catches typos/garbage
    // immediately with a clear message instead of a confusing downstream
    // "fee payer doesn't match" failure.
    try {
      // eslint-disable-next-line no-new
      new PublicKey(senderAddress);
    } catch (err) {
      await safeSend(bot, chatId, `"${senderAddress}" doesn't look like a valid Solana wallet address. Usage: /verify <tx_signature> <your_wallet_address>`);
      return;
    }

    // Everything is inside one try/catch now, including the reservation
    // call itself. Previously reserveTxSignature() was awaited OUTSIDE
    // any try/catch — if it ever rejected (e.g. a transient store write
    // failure), that was an unhandled promise rejection with no global
    // safety net, which crashes the whole process. See subscriberStore's
    // mutate()/reserveTxSignature docstrings for the underlying issue.
    try {
      reserved = await store.reserveTxSignature(signature);
      if (!reserved) {
        await safeSend(bot, chatId, 'That transaction signature has already been used for a subscription.');
        return;
      }

      await safeSend(bot, chatId, 'Checking that transaction on-chain, one moment...');

      let solUsdPrice;
      try {
        solUsdPrice = await priceService.getSolUsdPrice();
      } catch (err) {
        console.error(`[bot] SOL price lookup failed: ${err.message}`);
      }

      const result = await solanaService.verifyPaymentTransaction(signature, { solUsdPrice, expectedSenderAddress: senderAddress });

      if (!result.ok) {
        await store.releaseTxSignature(signature); // free it up — this attempt didn't actually consume it
        await safeSend(bot, chatId, `Couldn't verify that payment: ${result.reason}`);
        return;
      }

      // AUDIT FIX: bind this chat to the wallet that just paid, or confirm
      // it matches a wallet already bound. A mismatch here means the
      // transaction is genuinely valid and paid enough — it just came from
      // a DIFFERENT wallet than whatever previously verified for this
      // chat, which is either someone trying to hijack an account they
      // don't own, or a legitimate wallet switch that needs an admin to
      // clear via /resetwallet. Either way it's not counted, and the
      // signature is released so a legitimate retry (after a reset) isn't
      // blocked by "already used".
      const bindResult = await store.bindOrCheckSenderWallet(chatId, result.senderAddress);
      if (!bindResult.ok) {
        await store.releaseTxSignature(signature);
        await safeSend(bot, chatId, [
          'That payment checks out on-chain, but this account is already linked to a different wallet',
          `(ending in ...${bindResult.existing.slice(-6)}).`,
          'If you\'ve switched wallets, ask an admin to run /resetwallet for your account, then try /verify again.',
        ].join(' '));
        return;
      }

      // FIXED: this used to be a plain (non-queued) getSubscriber() read,
      // computed in this handler, followed by a separate queued write —
      // two concurrent valid payments for the same chatId could both read
      // the same stale expiry and the second write would overwrite rather
      // than stack on the first. extendSubscription() does the whole
      // read-compute-write as one atomic queued operation.
      const sub = await store.extendSubscription(chatId, payments.subscriptionDays);
      const newExpiry = new Date(sub.subscriptionExpiresAt);

      await safeSend(bot, chatId, `Payment verified (${result.asset}, ~$${result.amountUsd.toFixed(2)}). Subscription active until ${newExpiry.toISOString().slice(0, 10)}.`);
    } catch (err) {
      console.error(`[bot] verification error for ${chatId}: ${err.message}`);
      if (reserved) {
        // Don't leave a signature stuck reserved on an unexpected error —
        // but this release is itself best-effort: if the store is what
        // failed, don't let a second failure here mask the original error
        // or throw again.
        try {
          await store.releaseTxSignature(signature);
        } catch (releaseErr) {
          console.error(`[bot] also failed to release signature ${signature}: ${releaseErr.message}`);
        }
      }
      await safeSend(bot, chatId, 'Something went wrong verifying that transaction. Please try again in a moment.');
    }
  });

  // Usage-error fallback: /verify with zero or one argument (missing the
  // wallet address the AUDIT FIX above now requires). Registered AFTER the
  // two-argument handler — node-telegram-bot-api runs every matching
  // pattern, so a bare "/verify abc123" cleanly falls through to this
  // rather than silently doing nothing.
  bot.onText(/^\/verify(?:\s+(\S+))?\s*$/, async (msg) => {
    const chatId = msg.chat.id;
    await safeSend(bot, chatId, 'Usage: /verify <tx_signature> <your_wallet_address> — the wallet address is the one you sent the payment FROM. See /subscribe for full instructions.');
  });

  bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return; // silently ignore — don't reveal the command exists to non-admins
    try {
      const subscribers = await store.getAllSubscribers();
      const now = Date.now();
      const activeSubs = subscribers.filter((s) => s.subscriptionExpiresAt && new Date(s.subscriptionExpiresAt).getTime() > now).length;
      const inTrial = subscribers.length - activeSubs;
      const trackedCount = (await patternStore.getTrackedTokens()).length;
      const archiveCount = (await patternStore.getArchive()).length;
      const state = await reportState.getState();

      const fmtWhen = (t) => (t ? `${((now - t) / 3_600_000).toFixed(1)}h ago` : 'never');

      await safeSend(bot, chatId, [
        '🛠 Admin panel',
        '',
        `Subscribers: ${subscribers.length} total (${activeSubs} active paid, ${inTrial} trial/expired)`,
        `Pattern tracking: ${trackedCount} active, ${archiveCount} archived (${patternTracking.enabled ? 'enabled' : 'disabled'})`,
        `Observation engine: ${observation.enabled ? `enabled, ${observationEngine.getObservingCount()} currently under observation` : 'disabled — alerts go out immediately'}`,
        `Admin chat IDs configured: ${admin.chatIds.length}`,
        '',
        `Last daily report sent: ${fmtWhen(state.lastDailyReportAt)}`,
        `Last weekly report sent: ${fmtWhen(state.lastWeeklyReportAt)}`,
        '',
        'Send /report for an on-demand self-assessment (BUY vs WAIT avg ROI) covering the last day and week.',
        'Send /exportdaily or /exportweekly to download recent database records as an NDJSON file.',
        'Send /dailyupdate or /weeklyupdate for tracked-token status by UTC day/week.',
      ].join('\n'));
    } catch (err) {
      console.error(`[bot] /admin error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Something went wrong building the admin panel. Check the logs.');
    }
  });

  async function sendAdminExport(msg, period) {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    try {
      const exportData = await buildAdminExport(period);
      await bot.sendDocument(chatId, { filename: exportData.filename, content: exportData.content }, {
        caption: `${period === 'daily' ? 'Daily' : 'Weekly'} database export — ${Object.values(exportData.counts).reduce((a, b) => a + b, 0)} records.`,
      });
    } catch (err) {
      console.error(`[bot] /export${period} error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, `Something went wrong building the ${period} export. Check the logs.`);
    }
  }

  bot.onText(/^\/exportdaily\s*$/, async (msg) => sendAdminExport(msg, 'daily'));
  bot.onText(/^\/exportweekly\s*$/, async (msg) => sendAdminExport(msg, 'weekly'));

  async function sendTrackedTokenUpdate(msg, period) {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    try {
      const bounds = period === 'daily'
        ? trackedTokenReportStore.getUtcDayBounds()
        : trackedTokenReportStore.getUtcWeekBounds();
      const rows = await trackedTokenReportStore.getTrackedTokensInRange(bounds);
      const chunks = formatTrackedTokenReport(rows, { period, ...bounds });
      for (const chunk of chunks) await safeSend(bot, chatId, chunk);
    } catch (err) {
      console.error(`[bot] /${period === 'daily' ? 'DailyUpdate' : 'WeeklyUpdate'} error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, `The ${period} tracked-token update is unavailable. Check the database and logs.`);
    }
  }

  bot.onText(/^\/dailyupdate\s*$/i, async (msg) => sendTrackedTokenUpdate(msg, 'daily'));
  bot.onText(/^\/weeklyupdate\s*$/i, async (msg) => sendTrackedTokenUpdate(msg, 'weekly'));

  bot.onText(/\/report/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return; // silently ignore — don't reveal the command exists to non-admins
    try {
      const archive = await patternStore.getArchive();
      const daily = computeSelfAssessment(archive, reports.dailyIntervalMs);
      const weekly = computeSelfAssessment(archive, reports.weeklyIntervalMs);
      await safeSend(bot, chatId, formatSelfAssessmentReport('Daily (on-demand)', daily));
      await safeSend(bot, chatId, formatSelfAssessmentReport('Weekly (on-demand)', weekly));
    } catch (err) {
      console.error(`[bot] /report error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Something went wrong building the report. Check the logs.');
    }
  });

  bot.onText(/\/signalreport(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const days = Math.min(90, Math.max(1, Number(match[1] || 7)));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    try {
      const [summary, quality, delivery] = await Promise.all([
        researchReportStore.getSignalSummary({ since }),
        researchReportStore.getDataQualitySummary({ since }),
        researchReportStore.getDeliverySummary({ since }),
      ]);
      const lines = [`Signal report — last ${days} day(s)`, ''];
      if (summary.length === 0) {
        lines.push('No alert-evaluation rows are available yet.');
      } else {
        for (const row of summary) {
          lines.push(`${row.signal_label || 'UNLABELED'} / ${row.risk_level || 'Unknown'}: ${row.alert_count} alerts, ${row.resolved_count} resolved, ${row.validated_count} validated, avg score ${row.avg_analytical_score ?? 'n/a'}, coverage ${row.avg_observation_coverage ?? 'n/a'}`);
        }
      }
      lines.push('', `Data quality: ${quality?.alerts || 0} alerts; ${quality?.complete_observations || 0} complete observations; ${quality?.partial_observations || 0} partial; ${quality?.unavailable_observations || 0} unavailable.`);
      lines.push(`Delivery: ${delivery?.sent || 0} sent, ${delivery?.failed || 0} failed, ${delivery?.suppressed || 0} suppressed.`);
      await safeSend(bot, chatId, lines.join('\n'));
    } catch (err) {
      console.error(`[bot] /signalreport error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Signal report is unavailable. Check the database and worker logs.');
    }
  });

  bot.onText(/\/alertaudit(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const alertId = (match[1] || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(alertId)) {
      await safeSend(bot, chatId, 'Usage: /alertaudit <alert UUID>');
      return;
    }
    try {
      const audit = await researchReportStore.getAlertAudit(alertId);
      if (!audit) {
        await safeSend(bot, chatId, 'Alert audit not found.');
        return;
      }
      const evaluation = audit.outcome_label || 'not evaluated';
      const evidence = audit.evidence_class || 'unknown';
      const lines = [
        `Alert audit: ${audit.alert_id}`,
        `Token: ${audit.mint_address}`,
        `Qualified: ${audit.qualified_at}`,
        `Signal: ${audit.signal_label || 'unlabeled'} / ${audit.signal_status}`,
        `Risk: ${audit.risk_level} | Hype: ${audit.hype_score ?? 'n/a'}`,
        `Versions: score=${audit.scoring_version || 'n/a'}, prompt=${audit.prompt_version || 'n/a'}, config=${audit.config_version || 'n/a'}`,
        `Evaluation: ${evaluation} | evidence=${evidence} | score=${audit.analytical_score ?? 'n/a'} | confidence=${audit.confidence || 'n/a'}`,
        `Decision features: ${audit.feature_snapshot ? 'present' : 'missing'}`,
        `Source snapshot: ${audit.source_snapshot ? 'present' : 'missing'}`,
        `AI packet: ${audit.ai_input_sanitized ? 'present' : 'missing'}`,
      ];
      await safeSend(bot, chatId, lines.join('\n'));
    } catch (err) {
      console.error(`[bot] /alertaudit error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Alert audit is unavailable. Check the database and logs.');
    }
  });

  bot.onText(/\/dataquality(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const days = Math.min(90, Math.max(1, Number(match[1] || 7)));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    try {
      const rows = await researchReportStore.getDataQualityBreakdown({ since });
      if (!rows.length) {
        await safeSend(bot, chatId, `No data-quality rows for the last ${days} day(s).`);
        return;
      }
      const lines = [`Data quality — last ${days} day(s)`, ''];
      for (const row of rows) {
        lines.push(`${row.signal_status || 'unknown'}: ${row.alerts} alerts; features ${row.feature_snapshots}; sources ${row.source_snapshots}; AI packets ${row.ai_inputs}; complete obs ${row.complete_observations}; partial ${row.partial_observations}; unavailable ${row.unavailable_observations}`);
      }
      await safeSend(bot, chatId, lines.join('\n'));
    } catch (err) {
      console.error(`[bot] /dataquality error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Data-quality report is unavailable. Check the database and logs.');
    }
  });

  // AUDIT FIX companion command: bindOrCheckSenderWallet (subscriberStore.js)
  // permanently locks a chat to the first wallet that verifies a payment for
  // it — necessary to close the front-running gap in /verify, but it also
  // means a subscriber who genuinely switches wallets would otherwise be
  // stuck forever. This is the manual escape hatch: an admin clears the
  // bind, then the subscriber's next /verify binds their new wallet.
  bot.onText(/\/resetwallet (\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return; // silently ignore — don't reveal the command exists to non-admins
    const targetChatId = match[1].trim();
    try {
      const sub = await store.resetSenderWallet(targetChatId);
      if (!sub) {
        await safeSend(bot, chatId, `No subscriber found with chat ID ${targetChatId}.`);
        return;
      }
      await safeSend(bot, chatId, `Cleared the bound wallet for chat ID ${targetChatId}. Their next /verify will bind whatever wallet pays it.`);
    } catch (err) {
      console.error(`[bot] /resetwallet error (target ${targetChatId}): ${err.message}`);
      await safeSend(bot, chatId, 'Something went wrong resetting that subscriber\'s wallet. Check the logs.');
    }
  });

  // Phase 6 — narrative intelligence, ported from narrativeIntelligence.js.
  // Heat/rotation only need qualification activity (archive + still-active
  // tracked tokens), so this works even before any token has finished its
  // lifecycle.
  bot.onText(/\/narratives/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    try {
      const [archive, tracked] = await Promise.all([patternStore.getArchive(), patternStore.getTrackedTokens()]);
      const windowDays = 7;
      const heat = getNarrativeHeat(archive, tracked, { windowDays });
      const rotation = getNarrativeRotation(archive, tracked, { windowDays });
      await safeSend(bot, chatId, formatNarrativeIntelligence(heat, rotation, windowDays));
    } catch (err) {
      console.error(`[bot] /narratives error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Something went wrong building the narrative report. Check the logs.');
    }
  });

  // Evolution/monthly assessment are archive-only (need a finished
  // peakRoiMultiple), so a brand-new deployment will show mostly "not
  // enough resolved tokens yet" until some tokens complete their lifecycle
  // — that's the formatter's own honest fallback, not a bug here.
  bot.onText(/\/narrativeevolution/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    try {
      const archive = await patternStore.getArchive();
      const evolutionWeeks = getNarrativeEvolution(archive, { weeks: 4 });
      const monthlyAssessment = getMonthlyNarrativeAssessment(archive, { days: 30, limit: 10 });
      await safeSend(bot, chatId, formatNarrativeEvolution(evolutionWeeks, monthlyAssessment));
    } catch (err) {
      console.error(`[bot] /narrativeevolution error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Something went wrong building the narrative evolution report. Check the logs.');
    }
  });

  // Tier 2, Phase 13 — the first reader of market_state_daily, which
  // marketStateEngine.js has been computing hourly since it shipped.
  // Always today's UTC row (utcDateString(), same convention the engine
  // itself writes with) — this is a "what's happening right now" snapshot,
  // not a historical query, same shape as /narratives' "heat" half.
  //
  // `\b` here (not just `/\/insights/`) is load-bearing, not stylistic:
  // node-telegram-bot-api's onText matches EVERY registered regex against
  // each message (see TelegramBot.processUpdate — it's a `.some()` that
  // only stops early if `onlyFirstMatch` is set, which this bot doesn't
  // set), not just the first one that matches. An unanchored `/insights`
  // is a substring of "/insightshistory", so without the boundary, typing
  // /insightshistory would silently ALSO fire this handler and send two
  // messages. `\b` fails to match between "insights" and "history" (both
  // word characters, no boundary between them) but still matches at end-
  // of-string or before a space, so plain "/insights" is unaffected.
  bot.onText(/\/insights\b/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    try {
      const date = utcDateString(Date.now());
      const rows = await marketStateStore.getStateForDate(date);
      await safeSend(bot, chatId, formatMarketInsights(rows, date));
    } catch (err) {
      console.error(`[bot] /insights error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Something went wrong building the market insights report. Check the logs.');
    }
  });

  // Trend-view follow-up to /insights, flagged in earlier handoffs as a
  // natural next step once there was more than a day or two of
  // market_state_daily rows to show a trend across. Reads
  // marketStateStore.getStateForNarrative (previously unused) for one
  // narrative's full oldest-to-newest history, rather than /insights'
  // single "today" snapshot. Accepts either the narrative's internal tag
  // or its display label, case/whitespace-insensitive
  // (narrativeLabels.js's resolveNarrativeTag) — an admin shouldn't have
  // to know "Dog Meme" is internally "dog-themed" to look up its history.
  // No argument (or an unrecognized one) replies with the full valid list
  // rather than staying silent, same "admin-only, not admin-cryptic"
  // spirit as every other admin command here.
  bot.onText(/\/insightshistory(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;

    const validList = Object.entries(NARRATIVE_LABELS)
      .map(([tag, label]) => `${label} (\`${tag}\`)`)
      .join('\n');

    const rawInput = match[1] ? match[1].trim() : '';
    if (!rawInput) {
      await safeSend(
        bot, chatId,
        `Usage: \`/insightshistory <narrative>\`\n\nValid narratives:\n${validList}`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const narrativeTag = resolveNarrativeTag(rawInput);
    if (!narrativeTag) {
      await safeSend(
        bot, chatId,
        `Unrecognized narrative "${rawInput}".\n\nValid narratives:\n${validList}`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    try {
      const rows = await marketStateStore.getStateForNarrative(narrativeTag);
      await safeSend(bot, chatId, formatMarketInsightsHistory(rows, narrativeTag));
    } catch (err) {
      console.error(`[bot] /insightshistory error for ${chatId}: ${err.message}`);
      await safeSend(bot, chatId, 'Something went wrong building the insights history report. Check the logs.');
    }
  });
}

/**
 * Sends a qualified-token alert to every subscriber who still has trial
 * alerts remaining or an active paid subscription, PLUS every configured
 * admin chat ID — admins get unlimited access: every alert, regardless of
 * trial/subscription state, and their alert count (if they happen to also
 * be a registered subscriber) is never decremented.
 */
async function broadcastAlerts(bot, qualifiedTokens) {
  // AUDIT FIX: formatAlert(token) is pre-computed once per token, here,
  // outside every subscriber loop, with its own try/catch — not called
  // inline inside the per-subscriber send loops below like it used to be.
  //
  // Previously a single malformed token (missing baseToken, an unexpected
  // shape from a future formatter change, etc.) threw out of formatAlert()
  // from *inside* the per-subscriber loop, and neither that loop nor this
  // function had a try/catch around it. The exception propagated all the
  // way up through index.js's tick(), which does catch it — but only after
  // this entire broadcast had already aborted. That meant every subscriber
  // not yet reached in this cycle got NONE of the batch's alerts (not just
  // the bad one), while subscribers already processed were left with
  // whatever partial subset they'd received before the throw — silent,
  // inconsistent under-delivery across a single cycle. This is the exact
  // per-item isolation bug tokenScanner.js's runScanCycle and
  // patternReviewer.js's reviewAllTrackedTokens were already fixed for
  // (see their own comments) — broadcastAlerts was the one place that
  // isolation had never been applied.
  //
  // Formatting once per token (not once per subscriber per token, which is
  // what the old inline call did) is also strictly less redundant work,
  // since formatAlert's output never depends on which subscriber it's
  // being sent to.
  const formattedTokens = [];
  for (const token of qualifiedTokens) {
    try {
      formattedTokens.push(formatAlert(token));
    } catch (err) {
      console.error(`[bot] formatAlert failed for a qualified token — skipping it for this broadcast: ${err.message}`);
    }
  }

  const subscribers = await store.getAllSubscribers();
  const subscriberChatIds = new Set(subscribers.map((s) => String(s.chatId)));

  for (const sub of subscribers) {
    const chatIdIsAdmin = isAdmin(sub.chatId);
    const expiresAt = sub.subscriptionExpiresAt ? new Date(sub.subscriptionExpiresAt).getTime() : 0;
    const hasActiveSub = expiresAt > Date.now();
    // `let`, not `const`: this must be decremented as alerts go out within
    // this same batch (see loop below). FIXED — this used to be `const`,
    // computed once from the pre-batch alertsSent count and never updated,
    // so the `trialRemaining <= 0` break check below stayed permanently
    // false for the whole batch even as store.incrementAlertCount() wrote
    // real increments to disk. A trial user with e.g. 1 alert left could
    // receive every token in a single multi-token batch (5, 10, however
    // many qualified that cycle) instead of just 1 — the persisted count
    // still went up correctly, it just didn't stop the send loop in time.
    let trialRemaining = Math.max(0, payments.trialAlertCount - (sub.alertsSent || 0));

    if (!chatIdIsAdmin && !hasActiveSub && trialRemaining <= 0) continue;

    for (const text of formattedTokens) {
      if (!chatIdIsAdmin && !hasActiveSub && trialRemaining <= 0) break;
      const sent = await safeSend(bot, sub.chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
      // Unlimited for admins: never consume trial count, regardless of
      // subscription state.
      if (sent && !chatIdIsAdmin && !hasActiveSub) {
        await store.incrementAlertCount(sub.chatId);
        trialRemaining -= 1;
      }
    }
  }

  // Admin chat IDs that aren't also registered subscribers (never sent
  // /start) still get every alert — unlimited access shouldn't require
  // going through the trial/subscription flow at all.
  for (const chatId of admin.chatIds) {
    if (subscriberChatIds.has(String(chatId))) continue; // already covered above
    for (const text of formattedTokens) {
      await safeSend(bot, chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    }
  }
}

module.exports = { createBot, broadcastAlerts, isAdmin, TELEGRAM_WORKER_NAME: WORKER_NAME };
