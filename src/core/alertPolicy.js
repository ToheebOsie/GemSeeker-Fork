const { alerts } = require('../config');

/**
 * Decides whether a qualified token's alert should actually be BROADCAST
 * to subscribers — a filter on what gets SENT, nothing else. Every other
 * pipeline stage (market/safety-gate qualification, pattern-tracking
 * enrollment, wallet clustering, description-category registry, historical
 * matches, market state) already ran to completion in
 * tokenScanner.js's runScanCycle before this is ever consulted, and none
 * of that is gated by this function or by CLASS_ALERTS/VERDICT_ALERTS — a
 * token filtered out here is still fully tracked and archived exactly as
 * it always was, it just never becomes a Telegram message.
 *
 * index.js is the sole caller, applying this to runScanCycle's output
 * right before handing the survivors to telegramBot.js's broadcastAlerts.
 * Deliberately NOT called from inside broadcastAlerts itself or
 * tokenScanner.js — keeps this a single, clearly-scoped seam rather than
 * something that could quietly affect tracking if someone later moved the
 * call site without reading this comment.
 *
 * See config.js's `alerts` for where CLASS_ALERTS/VERDICT_ALERTS are
 * parsed (case-insensitively, defaulting to "every value" when unset —
 * i.e. no filtering, current behavior, if neither env var is set).
 *
 * A token must match BOTH the configured class list AND the configured
 * verdict list to be alertable (AND, not OR). A token with no signalLabel
 * at all (Gemini call failed to produce a parseable BUY/WAIT/SKIP — see
 * gemini_signal_generator.js's extractSignalLabel) never matches any
 * configured verdict list, the same as any other value not in the list —
 * there's no way to configure this to alert on an unparseable signal.
 *
 * @param {{ riskLevel?: string, signalLabel?: string|null }} token
 * @returns {boolean}
 */
function isAlertable(token) {
  return alerts.classLevels.includes(token.riskLevel) && alerts.verdicts.includes(token.signalLabel);
}

module.exports = { isAlertable };
