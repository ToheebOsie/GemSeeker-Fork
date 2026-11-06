const { observation } = require('../config');

/**
 * Tier 2, Phase 4 — Observation Engine.
 *
 * ON BY DEFAULT (OBSERVATION_ENABLED=true) — this is a genuine product
 * decision, not a pure bugfix/enhancement: it delays alerts on the
 * riskier tokens it applies to, trading "catch it early" against "fewer
 * false starts." It shipped off by default at first, same precedent as
 * Social Score, until the risk tiers and window were explicitly
 * confirmed and turned on. Set OBSERVATION_ENABLED=false to go back to
 * immediate alerts for every risk tier.
 *
 * What it does, when enabled: a qualifying token whose riskLevel is in
 * observation.observeRiskLevels (default ['Medium', 'High'] — NOT Low,
 * which has already cleared the strictest bar and gains the least from
 * added delay) doesn't alert the first time it qualifies. Instead it's
 * held for observation.windowMs; on a later scan cycle, if it's still in
 * DexScreener's results and still passes a FRESH market-filter +
 * safety-gate check, it "graduates" — gets a freshly-generated AI signal
 * (not the stale one from first sight) and alerts normally. If it fails
 * a fresh check at any point during observation, or simply never
 * reappears in DexScreener's results again (delisted, liquidity pulled,
 * pair no longer returned), it's dropped — never alerted at all. That
 * drop is the actual protective value: catching a flash pump/wash-trade
 * illusion that couldn't sustain itself for the length of the window.
 *
 * State is in-memory only, same non-persistence precedent as
 * tokenScanner.js's own alertedPairs Set: a restart mid-observation just
 * restarts that token's clock, the same class of minor, accepted
 * imprecision alertedPairs already has. This isn't tracked_tokens (which
 * must survive restarts to be useful over weeks) — observation windows
 * are minutes long, restarting one is a non-event.
 *
 * This module only owns timing state and the graduate/observe/started
 * decision. It does NOT re-run market filters, safety gates, or
 * anything else — tokenScanner.js's runScanCycle already re-runs those
 * fresh on every candidate every cycle (that's what "fresh check" above
 * relies on), so this module doesn't need its own copy of that logic.
 *
 * Defaults (observeRiskLevels: Medium+High, windowMs: 3 min) were an
 * unconfirmed scope call as of the previous handoff. User has since
 * explicitly confirmed both as-is, and separately confirmed the engine
 * should be live — both are settled, not open questions.
 */

// pairAddress -> { firstSeenAt: epoch ms }
const observing = new Map();

/** Whether a token with this riskLevel should be held for observation at all. */
function shouldObserve(riskLevel) {
  return observation.enabled && observation.observeRiskLevels.includes(riskLevel);
}

/**
 * Call once per scan cycle for a candidate that has ALREADY passed a
 * fresh market-filter + safety-gate check this cycle and for which
 * shouldObserve(riskLevel) is true — this function only tracks timing,
 * the caller is responsible for the fresh checks themselves.
 *
 * @returns {'started'|'observing'|'graduate'}
 *   - 'started': first time seen this process lifetime — caller must NOT
 *     alert this cycle.
 *   - 'observing': still within the window — caller must NOT alert yet.
 *   - 'graduate': window has elapsed and the token is still passing —
 *     caller should proceed to alert, then call stopObserving().
 */
function checkObservation(pairAddress, now = Date.now()) {
  const existing = observing.get(pairAddress);
  if (!existing) {
    observing.set(pairAddress, { firstSeenAt: now });
    return 'started';
  }
  return (now - existing.firstSeenAt >= observation.windowMs) ? 'graduate' : 'observing';
}

/** Call when a token graduates (about to alert) or is rejected (failed a fresh check mid-observation). */
function stopObserving(pairAddress) {
  observing.delete(pairAddress);
}

/**
 * Drops any entry that's sat for more than 2x the window without ever
 * being touched again — the one case checkObservation() itself can't
 * catch, since nothing calls it for a candidate that simply stops
 * appearing in DexScreener's results. Without this, that entry would sit
 * in memory for the rest of the process's life. Call once per scan
 * cycle, before processing candidates.
 */
function pruneStale(now = Date.now()) {
  for (const [pairAddress, meta] of observing) {
    if (now - meta.firstSeenAt > observation.windowMs * 2) {
      observing.delete(pairAddress);
    }
  }
}

function getObservingCount() {
  return observing.size;
}

// Test-only — direct visibility into raw state without timing tricks.
function _getObservingSnapshot() {
  return new Map(observing);
}

function _reset() {
  observing.clear();
}

module.exports = {
  shouldObserve,
  checkObservation,
  stopObserving,
  pruneStale,
  getObservingCount,
  _getObservingSnapshot,
  _reset,
};
