'use strict';

/**
 * Returns tracked tokens qualified in a UTC half-open interval [fromMs, toMs).
 * The latest alert_decisions row is joined only for structured qualification
 * context (lore/description and initial market-cap data); tracked_tokens
 * remains the source of truth for the live persisted ATH/price state.
 */
function getUtcDayBounds(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { fromMs: from, toMs: from + 86_400_000 };
}

function getUtcWeekBounds(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const day = now.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysSinceMonday * 86_400_000;
  return { fromMs: from, toMs: from + 7 * 86_400_000 };
}

async function getTrackedTokensInRange({ fromMs, toMs }) {
  const { query } = require('../db/pool');
  const { rows } = await query(
    `WITH latest_decisions AS (
       SELECT DISTINCT ON (pair_address)
              pair_address, feature_snapshot, ai_input_sanitized
         FROM alert_decisions
        ORDER BY pair_address, qualified_at DESC, created_at DESC
     )
     SELECT t.pair_address,
            t.mint_address,
            t.base_token,
            t.narrative_tag,
            t.hype_score_at_qualification,
            t.risk_level_at_qualification,
            t.signal_label,
            t.signal_status,
            t.qualified_at,
            t.pair_created_at,
            t.first_price_usd,
            t.ath_price_usd,
            t.ath_at,
            t.last_price_usd,
            d.feature_snapshot,
            d.ai_input_sanitized
       FROM tracked_tokens t
       LEFT JOIN latest_decisions d ON d.pair_address = t.pair_address
      WHERE t.qualified_at >= $1 AND t.qualified_at < $2
      ORDER BY t.qualified_at ASC, t.pair_address ASC`,
    [fromMs, toMs],
  );
  return rows;
}

module.exports = { getTrackedTokensInRange, getUtcDayBounds, getUtcWeekBounds };
