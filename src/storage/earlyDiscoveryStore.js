const crypto = require('crypto');
const { query } = require('../db/pool');

/**
 * Postgres-backed store for the GeckoTerminal/CoinGecko early-discovery
 * EXPERIMENT (see docs/early-discovery-experiment.md). Every write here
 * targets early_discovery_observations / early_discovery_poll_log only —
 * this file never touches tracked_tokens, pattern_archive, alert_decisions,
 * or alerted_pairs. Read-side report queries DO join against
 * alert_decisions (read-only) to answer "did the production pipeline
 * eventually qualify this same token" — see getQualificationOutcomes below.
 */

const GECKO_SOURCES = ['geckoterminal', 'geckoterminal_fallback'];

/**
 * Inserts one observation. ON CONFLICT (source, mint_address) DO NOTHING
 * is the whole restart-safety/dedup mechanism (see schema.sql's header
 * comment on early_discovery_observations) — this is always safe to call
 * again for a mint this source has already seen; it just won't insert a
 * second row or touch first_seen_at.
 */
async function insertObservation(source, candidate) {
  if (!candidate || !candidate.mintAddress) {
    throw new Error('insertObservation requires a candidate with mintAddress');
  }
  const observationId = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO early_discovery_observations
       (observation_id, source, chain, mint_address, pool_address, symbol, name,
        source_created_at, market_cap_usd, liquidity_usd, price_usd, raw_observation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (source, mint_address) DO NOTHING
     RETURNING observation_id`,
    [
      observationId,
      source,
      candidate.chain || 'solana',
      candidate.mintAddress,
      candidate.poolAddress || null,
      candidate.symbol || null,
      candidate.name || null,
      candidate.sourceCreatedAt || null,
      candidate.marketCapUsd ?? null,
      candidate.liquidityUsd ?? null,
      candidate.priceUsd ?? null,
      JSON.stringify(candidate.raw || {}),
    ],
  );
  return { inserted: rows.length > 0, observationId: rows.length > 0 ? rows[0].observation_id : null };
}

async function recordPollLog({ source, dryRun, requestCount = 0, candidatesSeen = 0, newObservations = 0, usedFallback = false, error = null }) {
  const pollId = crypto.randomUUID();
  await query(
    `INSERT INTO early_discovery_poll_log
       (poll_id, source, dry_run, request_count, candidates_seen, new_observations, used_fallback, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [pollId, source, Boolean(dryRun), requestCount, candidatesSeen, newObservations, Boolean(usedFallback), error],
  );
  return pollId;
}

// --- Report queries (spec section 11) -----------------------------------

/** Item 1/2: observation and unique-token counts, GeckoTerminal (primary+fallback combined) vs DexScreener. */
async function getSourceTotals() {
  const { rows } = await query(`
    SELECT
      CASE WHEN source = ANY($1::text[]) THEN 'geckoterminal' ELSE source END AS source_family,
      COUNT(*)::int AS observation_count,
      COUNT(DISTINCT mint_address)::int AS unique_token_count
    FROM early_discovery_observations
    GROUP BY 1
    ORDER BY 1
  `, [GECKO_SOURCES]);
  return rows;
}

/** Item 2/3/4: discovery overlap — both sources, GeckoTerminal-only, DexScreener-only. */
async function getOverlapCounts() {
  const { rows } = await query(`
    WITH by_family AS (
      SELECT DISTINCT mint_address,
             CASE WHEN source = ANY($1::text[]) THEN 'geckoterminal' ELSE source END AS source_family
      FROM early_discovery_observations
    ),
    agg AS (
      SELECT mint_address, array_agg(DISTINCT source_family) AS families
      FROM by_family
      GROUP BY mint_address
    )
    SELECT
      COUNT(*) FILTER (WHERE 'geckoterminal' = ANY(families) AND 'dexscreener' = ANY(families))::int AS both_count,
      COUNT(*) FILTER (WHERE 'geckoterminal' = ANY(families) AND NOT ('dexscreener' = ANY(families)))::int AS geckoterminal_only_count,
      COUNT(*) FILTER (WHERE 'dexscreener' = ANY(families) AND NOT ('geckoterminal' = ANY(families)))::int AS dexscreener_only_count
    FROM agg
  `, [GECKO_SOURCES]);
  return rows[0];
}

/**
 * Item 5/6: GeckoTerminal lead time (DexScreener first_seen_at minus
 * GeckoTerminal first_seen_at, per spec section 7's formula — positive
 * means GeckoTerminal was earlier) for every mint seen by both sources.
 * Returns the full aggregate AND the raw per-mint samples (bounded by
 * `sampleLimit`) so the report script can also print/bucket the actual
 * distribution, not just central-tendency numbers.
 */
async function getLeadTimeStats(sampleLimit = 2000) {
  const { rows: aggRows } = await query(`
    WITH gecko AS (
      SELECT mint_address, MIN(first_seen_at) AS first_seen_at
      FROM early_discovery_observations
      WHERE source = ANY($1::text[])
      GROUP BY mint_address
    ),
    dex AS (
      SELECT mint_address, first_seen_at
      FROM early_discovery_observations
      WHERE source = 'dexscreener'
    ),
    paired AS (
      SELECT g.mint_address,
             EXTRACT(EPOCH FROM (dex.first_seen_at - g.first_seen_at)) * 1000 AS lead_ms
      FROM gecko g
      JOIN dex ON dex.mint_address = g.mint_address
    )
    SELECT
      COUNT(*)::int AS paired_count,
      AVG(lead_ms) AS avg_lead_ms,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY lead_ms) AS median_lead_ms,
      percentile_cont(0.1) WITHIN GROUP (ORDER BY lead_ms) AS p10_lead_ms,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY lead_ms) AS p90_lead_ms,
      MIN(lead_ms) AS min_lead_ms,
      MAX(lead_ms) AS max_lead_ms,
      COUNT(*) FILTER (WHERE lead_ms > 0)::int AS geckoterminal_earlier_count,
      COUNT(*) FILTER (WHERE lead_ms < 0)::int AS dexscreener_earlier_count,
      COUNT(*) FILTER (WHERE lead_ms = 0)::int AS tie_count
    FROM paired
  `, [GECKO_SOURCES]);

  const { rows: sampleRows } = await query(`
    WITH gecko AS (
      SELECT mint_address, MIN(first_seen_at) AS first_seen_at
      FROM early_discovery_observations
      WHERE source = ANY($1::text[])
      GROUP BY mint_address
    ),
    dex AS (
      SELECT mint_address, first_seen_at
      FROM early_discovery_observations
      WHERE source = 'dexscreener'
    )
    SELECT g.mint_address,
           EXTRACT(EPOCH FROM (dex.first_seen_at - g.first_seen_at)) * 1000 AS lead_ms
    FROM gecko g
    JOIN dex ON dex.mint_address = g.mint_address
    ORDER BY lead_ms
    LIMIT $2
  `, [GECKO_SOURCES, sampleLimit]);

  return { aggregate: aggRows[0], samples: sampleRows };
}

/**
 * Item 7: market-cap/liquidity/age characteristics of GeckoTerminal
 * discoveries at capture time. `captureLagSeconds` is how long after the
 * source-reported pool_created_at our poller actually first saw the pool —
 * a diagnostic on poll-interval latency, not a market-age figure.
 */
async function getGeckoTerminalCandidateStats() {
  const { rows } = await query(`
    SELECT
      COUNT(*)::int AS count,
      AVG(market_cap_usd) AS avg_market_cap_usd,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY market_cap_usd) AS median_market_cap_usd,
      AVG(liquidity_usd) AS avg_liquidity_usd,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY liquidity_usd) AS median_liquidity_usd,
      COUNT(*) FILTER (WHERE market_cap_usd IS NULL)::int AS null_market_cap_count,
      COUNT(*) FILTER (WHERE liquidity_usd IS NULL)::int AS null_liquidity_count,
      AVG(EXTRACT(EPOCH FROM (first_seen_at - source_created_at)))
        FILTER (WHERE source_created_at IS NOT NULL) AS avg_capture_lag_seconds
    FROM early_discovery_observations
    WHERE source = ANY($1::text[])
  `, [GECKO_SOURCES]);
  return rows[0];
}

/**
 * Item 8/11: for every GeckoTerminal-discovered mint, whether the
 * EXISTING production pipeline (dexscreenerService -> tokenScanner ->
 * alert_decisions) ever independently qualified the same mint — i.e.
 * "did earlier discovery actually point at something our real pipeline
 * would also have found." Reuses alert_decisions (spec section 6's
 * "use existing structures where appropriate") rather than a new outcome
 * table; alert_decisions already covers every qualifying token
 * unconditionally, not just tracked/alerted ones (see
 * docs/gemseeker-engineering-skill/SKILL.md's "Current implementation
 * status" note on this).
 */
async function getQualificationOutcomes() {
  const { rows } = await query(`
    WITH gecko AS (
      SELECT mint_address, MIN(first_seen_at) AS first_seen_at
      FROM early_discovery_observations
      WHERE source = ANY($1::text[])
      GROUP BY mint_address
    ),
    matched AS (
      SELECT g.mint_address, g.first_seen_at, d.qualified_at, d.risk_level, d.signal_label
      FROM gecko g
      JOIN LATERAL (
        SELECT qualified_at, risk_level, signal_label
        FROM alert_decisions ad
        WHERE ad.mint_address = g.mint_address
        ORDER BY ad.qualified_at ASC
        LIMIT 1
      ) d ON true
    )
    SELECT
      (SELECT COUNT(*)::int FROM gecko) AS geckoterminal_unique_count,
      COUNT(*)::int AS later_qualified_count,
      COUNT(*) FILTER (WHERE signal_label = 'BUY')::int AS later_buy_count,
      COUNT(*) FILTER (WHERE signal_label = 'WAIT')::int AS later_wait_count,
      COUNT(*) FILTER (WHERE signal_label = 'SKIP')::int AS later_skip_count,
      AVG(EXTRACT(EPOCH FROM (qualified_at - first_seen_at))) AS avg_seconds_to_qualification
    FROM matched
  `, [GECKO_SOURCES]);
  return rows[0];
}

/** Item 9/10: API request accounting and error/fallback diagnostics per source. */
async function getPollLogSummary() {
  const { rows } = await query(`
    SELECT source,
           COUNT(*)::int AS poll_count,
           SUM(request_count)::int AS total_requests,
           SUM(candidates_seen)::int AS total_candidates_seen,
           SUM(new_observations)::int AS total_new_observations,
           COUNT(*) FILTER (WHERE used_fallback)::int AS fallback_uses,
           COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS error_count,
           MIN(polled_at) AS first_polled_at,
           MAX(polled_at) AS last_polled_at
    FROM early_discovery_poll_log
    GROUP BY source
    ORDER BY source
  `);
  return rows;
}

async function getRecentPollErrors(limit = 20) {
  const { rows } = await query(
    `SELECT source, polled_at, error, used_fallback
     FROM early_discovery_poll_log
     WHERE error IS NOT NULL
     ORDER BY polled_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

module.exports = {
  insertObservation,
  recordPollLog,
  getSourceTotals,
  getOverlapCounts,
  getLeadTimeStats,
  getGeckoTerminalCandidateStats,
  getQualificationOutcomes,
  getPollLogSummary,
  getRecentPollErrors,
  GECKO_SOURCES,
};
