'use strict';
const { query } = require('../db/pool');

async function upsertBucket(row) {
  await query(
    `INSERT INTO narrative_market_outcome_observations (
      narrative_tag, bucket_at, observed_at_min, observed_at_max, token_count,
      volume_known_token_count, median_volume_1h, total_volume_1h,
      buy_known_token_count, total_buys_1h, sell_known_token_count, total_sells_1h,
      price_known_token_count, median_price_usd, source
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (narrative_tag, bucket_at) DO UPDATE SET
      observed_at_min=EXCLUDED.observed_at_min, observed_at_max=EXCLUDED.observed_at_max,
      token_count=EXCLUDED.token_count, volume_known_token_count=EXCLUDED.volume_known_token_count,
      median_volume_1h=EXCLUDED.median_volume_1h, total_volume_1h=EXCLUDED.total_volume_1h,
      buy_known_token_count=EXCLUDED.buy_known_token_count, total_buys_1h=EXCLUDED.total_buys_1h,
      sell_known_token_count=EXCLUDED.sell_known_token_count, total_sells_1h=EXCLUDED.total_sells_1h,
      price_known_token_count=EXCLUDED.price_known_token_count, median_price_usd=EXCLUDED.median_price_usd,
      source=EXCLUDED.source`,
    [row.narrativeTag, row.bucketAt, row.observedAtMin, row.observedAtMax, row.tokenCount,
      row.volumeKnownTokenCount, row.medianVolume1h, row.totalVolume1h,
      row.buyKnownTokenCount, row.totalBuys1h, row.sellKnownTokenCount, row.totalSells1h,
      row.priceKnownTokenCount, row.medianPriceUsd, row.source],
  );
}

async function getHistory(narrativeTag, limit = 500) {
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 500)));
  const { rows } = await query(
    `SELECT * FROM narrative_market_outcome_observations
     WHERE narrative_tag = $1 ORDER BY bucket_at DESC LIMIT $2`,
    [narrativeTag, safeLimit],
  );
  return rows.reverse();
}

module.exports = { getHistory, upsertBucket };
