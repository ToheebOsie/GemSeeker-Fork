'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

function recordDiscoveryEventIdempotencyKey(event) {
  return `${event.source}:${event.pairAddress}:${event.discoveredAt}`;
}

async function recordDiscoveryEvents(candidates) {
  const rows = [];
  for (const candidate of candidates || []) {
    const sourceCandidates = candidate?.sourceCandidates || {};
    for (const [source, sourceCandidate] of Object.entries(sourceCandidates)) {
      const d = sourceCandidate?.discovery;
      if (!d || !sourceCandidate.pairAddress || !sourceCandidate.baseToken?.address) continue;
      rows.push({
        discoveryEventId: crypto.randomUUID(),
        source,
        mintAddress: sourceCandidate.baseToken.address,
        pairAddress: sourceCandidate.pairAddress,
        dexId: sourceCandidate.dexId || null,
        symbol: sourceCandidate.baseToken.symbol || null,
        name: sourceCandidate.baseToken.name || null,
        discoveredAt: d.discoveredAt || new Date().toISOString(),
        volume1h: d.discoveryVolume1hUsd ?? null,
        totalVolume: d.discoveryTotalVolumeUsd ?? null,
        liquidity: d.discoveryLiquidityUsd ?? sourceCandidate.liquidity?.usd ?? null,
        marketCap: d.discoveryMarketCapUsd ?? sourceCandidate.marketCap ?? sourceCandidate.fdv ?? null,
        price: d.discoveryPriceUsd ?? sourceCandidate.priceUsd ?? null,
        ageMinutes: d.discoveryAgeMinutes ?? null,
        threshold: d.discoveryThresholdUsd || null,
        filterVersion: d.filterVersion || null,
        discoveryVersion: d.discoveryVersion || null,
        cohortKey: d.discoveryCohortKey || null,
        providerPath: d.providerPath || null,
        rawSnapshot: {
          pairAddress: sourceCandidate.pairAddress,
          mintAddress: sourceCandidate.baseToken.address,
          dexId: sourceCandidate.dexId || null,
          symbol: sourceCandidate.baseToken.symbol || null,
          name: sourceCandidate.baseToken.name || null,
          priceUsd: sourceCandidate.priceUsd ?? null,
          marketCap: sourceCandidate.marketCap ?? sourceCandidate.fdv ?? null,
          liquidity: sourceCandidate.liquidity?.usd ?? sourceCandidate.liquidity ?? null,
          volume1h: sourceCandidate.volume?.h1 ?? null,
          ageMinutes: d.discoveryAgeMinutes ?? null,
          discovery: d,
        },
      });
    }
  }
  let inserted = 0;
  const eventIds = new Map();
  const newEvents = [];
  for (const row of rows) {
    const result = await query(
      `INSERT INTO discovery_events (
         discovery_event_id, source, chain, mint_address, pair_address, dex_id,
         symbol, name, discovered_at, discovery_volume_1h_usd,
         discovery_total_volume_usd, discovery_liquidity_usd,
         discovery_market_cap_usd, discovery_price_usd, discovery_age_minutes,
         discovery_threshold, filter_version, discovery_version,
         discovery_cohort_key, provider_path, raw_snapshot
       ) VALUES ($1,$2,'solana',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING discovery_event_id`,
      [
        row.discoveryEventId, row.source, row.mintAddress, row.pairAddress, row.dexId,
        row.symbol, row.name, new Date(row.discoveredAt), row.volume1h,
        row.totalVolume, row.liquidity, row.marketCap, row.price, row.ageMinutes,
        JSON.stringify(row.threshold), row.filterVersion, row.discoveryVersion,
        row.cohortKey, row.providerPath, JSON.stringify(row.rawSnapshot),
      ],
    );
    const eventId = result.rows[0]?.discovery_event_id || null;
    if (eventId) {
      inserted += 1;
      newEvents.push({ discoveryEventId: eventId, source: row.source, pairAddress: row.pairAddress, mintAddress: row.mintAddress, discoveredAt: row.discoveredAt });
      eventIds.set(`${row.source}:${row.pairAddress}:${new Date(row.discoveredAt).toISOString()}`, eventId);
    } else {
      const existing = await query(
        `SELECT discovery_event_id FROM discovery_events WHERE source=$1 AND pair_address=$2`,
        [row.source, row.pairAddress],
      );
      eventIds.set(`${row.source}:${row.pairAddress}:${new Date(row.discoveredAt).toISOString()}`, existing.rows[0]?.discovery_event_id || null);
    }
  }
  return { attempted: rows.length, inserted, eventIds, newEvents };
}

async function recordDiscoveryEvaluations(evaluations) {
  if (!Array.isArray(evaluations) || evaluations.length === 0) return { attempted: 0, inserted: 0 };
  let inserted = 0;
  for (const item of evaluations) {
    const { rowCount } = await query(
      `INSERT INTO discovery_evaluations (
         evaluation_id, discovery_event_id, pair_address, mint_address,
         evaluated_at, source, stage, passed, reason,
         qualification_filter_version, safety_result
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [crypto.randomUUID(), item.discoveryEventId || null, item.pairAddress, item.mintAddress,
       new Date(item.evaluatedAt || Date.now()), item.source || null, item.stage, Boolean(item.passed),
       item.reason || null, item.qualificationFilterVersion || null, JSON.stringify(item.safetyResult || null)],
    );
    inserted += rowCount;
  }
  return { attempted: evaluations.length, inserted };
}

async function recordDiscoveryEvaluation({ discoveryEventId = null, pairAddress, mintAddress, evaluatedAt = new Date(), source = null, stage, passed, reason = null, qualificationFilterVersion = null, safetyResult = null }) {
  const { rows } = await query(
    `INSERT INTO discovery_evaluations (
       evaluation_id, discovery_event_id, pair_address, mint_address,
       evaluated_at, source, stage, passed, reason,
       qualification_filter_version, safety_result
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     RETURNING evaluation_id`,
    [crypto.randomUUID(), discoveryEventId, pairAddress, mintAddress, new Date(evaluatedAt), source, stage, Boolean(passed), reason, qualificationFilterVersion, JSON.stringify(safetyResult)],
  );
  return rows[0]?.evaluation_id || null;
}

async function getDiscoveryOutcomeResearchRows({ since = null, limit = 10000 } = {}) {
  const { rows } = await query(
    `SELECT * FROM v_discovery_outcome_research
     WHERE ($1::timestamptz IS NULL OR first_discovery_at >= $1)
     ORDER BY first_discovery_at ASC LIMIT $2`,
    [since, limit],
  );
  return rows;
}

module.exports = {
  recordDiscoveryEvents,
  recordDiscoveryEvaluation,
  recordDiscoveryEvaluations,
  getDiscoveryOutcomeResearchRows,
  recordDiscoveryEventIdempotencyKey,
};
