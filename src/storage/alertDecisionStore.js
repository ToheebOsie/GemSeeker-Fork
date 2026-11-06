'use strict';

const crypto = require('crypto');
const { withTransaction } = require('../db/pool');
const { buildEvent, EVENT_TYPES, CONSUMERS } = require('../contracts/events');
const { packetFromSignal, renderAssessment } = require('../core/geminiAssessment');

function createAlertId() {
  return crypto.randomUUID();
}

function json(value, fallback = {}) {
  return JSON.stringify(value === undefined ? fallback : value);
}

/**
 * Persists the decision and its downstream work in one transaction.
 * The decision is immutable; duplicate retries return the existing alert_id.
 */

async function persistEdpiLEvaluationWithClient(input, alertId, client) {
  const edpiL = input?.edpiL;
  if (!edpiL) return null;
  if (!input.qualifiedAt) throw new Error(`EDPI-L persistence requires an immutable qualifiedAt/evaluation timestamp for alert ${alertId}`);

  const evaluationId = crypto.randomUUID();
    const inserted = await client.query(
      `INSERT INTO edpi_l_evaluations (
         evaluation_id, alert_id, pair_address, mint_address, qualified_at,
         edpi_l_scoring_version, edpi_l_strength_version,
         class_1_score, class_2_score, class_4_score, class_5_composite,
         active_class_count, average_class_score, edpi_l_score, strength_label,
         qualifying_wallet_counts, scoring_wallet_counts,
         wallet_sample_size, raw_candidate_wallet_count, unique_candidate_wallet_count,
         eligible_wallet_count, insufficient_history_count,
         excluded_wallet_count, data_coverage, scoring_configuration,
         report_only_evidence, no_lookahead
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24::jsonb,$25::jsonb,$26::jsonb,$27::jsonb
       )
       ON CONFLICT (alert_id) DO NOTHING
       RETURNING evaluation_id`,
      [
        evaluationId,
        alertId,
        input.pairAddress,
        input.mintAddress,
        new Date(input.qualifiedAt),
        edpiL.edpi_l_scoring_version,
        edpiL.edpi_l_strength_version,
        edpiL.class_scores?.class_1 ?? 0,
        edpiL.class_scores?.class_2 ?? 0,
        edpiL.class_scores?.class_4 ?? 0,
        edpiL.class_5_composite ?? null,
        edpiL.active_class_count ?? 0,
        edpiL.average_class_score ?? 0,
        edpiL.edpi_l_score ?? 0,
        edpiL.strength_label || 'No Active Scoring Evidence',
        json(edpiL.qualifying_wallet_counts),
        json(edpiL.scoring_wallet_counts),
        edpiL.wallet_sample_size ?? 0,
        edpiL.raw_candidate_wallet_count ?? edpiL.wallet_sample_size ?? 0,
        edpiL.unique_candidate_wallet_count ?? edpiL.wallet_sample_size ?? 0,
        edpiL.eligible_wallet_count ?? 0,
        edpiL.insufficient_history_count ?? 0,
        edpiL.excluded_wallet_count ?? 0,
        json(edpiL.data_coverage),
        json(edpiL.scoring_configuration),
        json(edpiL.report_only_evidence),
        json(edpiL.no_lookahead),
      ],
    );

    const persistedEvaluationId = inserted.rows[0]?.evaluation_id;
    const targetEvaluationId = persistedEvaluationId || (await client.query(
      `SELECT evaluation_id FROM edpi_l_evaluations WHERE alert_id = $1`,
      [alertId],
    )).rows[0]?.evaluation_id;
    if (!targetEvaluationId) throw new Error(`EDPI-L evaluation row unavailable after persistence attempt for alert ${alertId}`);

    for (const wallet of Array.isArray(edpiL.wallet_evidence) ? edpiL.wallet_evidence : []) {
      await client.query(
        `INSERT INTO edpi_l_wallet_evidence (
           wallet_evidence_id, evaluation_id, wallet_address, holder_pct,
           status, eligible, excluded, exclusion_reason, history_depth,
           class_1_qualifying, class_1_points, class_2_qualifying, class_2_points,
           class_4_qualifying, class_4_points, current_entry_mc_usd, current_capital_sol,
           class_1_evidence, class_2_evidence, class_4_evidence,
           behavioral_evidence, historical_profile
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb
         )
         ON CONFLICT (evaluation_id, wallet_address) DO NOTHING`,
        [
          crypto.randomUUID(),
          targetEvaluationId,
          wallet.walletAddress,
          wallet.holderPct ?? null,
          wallet.status || 'unknown',
          Boolean(wallet.eligible),
          Boolean(wallet.excluded),
          wallet.exclusionReason || null,
          wallet.historyDepth ?? null,
          Boolean(wallet.class1?.qualifying),
          wallet.class1?.points ?? 0,
          Boolean(wallet.class2?.qualifying),
          wallet.class2?.points ?? 0,
          Boolean(wallet.class4?.qualifying),
          wallet.class4?.points ?? 0,
          wallet.current?.entryMcUsd ?? null,
          wallet.current?.capitalSol ?? null,
          json(wallet.class1),
          json(wallet.class2),
          json(wallet.class4),
          json(wallet.behavioral, null),
          json(wallet.walletProfile, null),
        ],
      );
    }
  return { evaluationId: targetEvaluationId, inserted: Boolean(persistedEvaluationId) };
}

async function persistEdpiLEvaluation(input, alertId) {
  return withTransaction((client) => persistEdpiLEvaluationWithClient(input, alertId, client));
}

async function persistAlertDecision(input) {
  const alertId = input.alertId || createAlertId();
  const occurredAt = input.occurredAt || new Date().toISOString();
  const event = buildEvent({
    eventId: alertId,
    eventType: EVENT_TYPES.ALERT_QUALIFIED,
    aggregateType: 'alert_decision',
    aggregateId: alertId,
    occurredAt,
    payload: { alertId },
  });

  let inserted = false;
  await withTransaction(async (client) => {
    const insertDecision = await client.query(
      `INSERT INTO alert_decisions (
         alert_id, chain_id, pair_address, mint_address, dex_id,
         quote_token_address, candidate_seen_at, qualified_at,
         observation_started_at, observation_graduated_at,
         qualification_status, signal_label, signal_status, risk_level,
         hype_score, market_momentum_score, identity_context_score,
         feature_snapshot, source_snapshot, social_snapshot, live_evidence,
         ai_input_sanitized, ai_output_raw, ai_decision_json,
         ai_model, prompt_version, scoring_version, feature_schema_version,
         config_version, broadcast_policy
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24::jsonb,
         $25,$26,$27,$28,$29,$30
       )
       ON CONFLICT (alert_id) DO NOTHING`,
      [
        alertId,
        input.chainId || 'solana',
        input.pairAddress,
        input.mintAddress,
        input.dexId || null,
        input.quoteTokenAddress || null,
        input.candidateSeenAt ? new Date(input.candidateSeenAt) : null,
        new Date(input.qualifiedAt || occurredAt),
        input.observationStartedAt ? new Date(input.observationStartedAt) : null,
        input.observationGraduatedAt ? new Date(input.observationGraduatedAt) : null,
        input.qualificationStatus || 'PASS',
        input.signalLabel || null,
        input.signalStatus || 'AI_NO_VERDICT',
        input.riskLevel || 'Unknown',
        input.hypeScore ?? null,
        input.marketMomentumScore ?? null,
        input.identityContextScore ?? null,
        json(input.featureSnapshot),
        json(input.sourceSnapshot),
        json(input.socialSnapshot, null),
        json(input.liveEvidence, null),
        json(input.aiInputSanitized, null),
        input.aiOutputRaw || null,
        json(input.aiDecisionJson, null),
        input.aiModel || null,
        input.promptVersion || null,
        input.scoringVersion || null,
        input.featureSchemaVersion || null,
        input.configVersion || null,
        input.broadcastPolicy || 'ALLOW',
      ],
    );

    inserted = insertDecision.rowCount > 0;
    if (inserted) {
      await client.query(
        `INSERT INTO outbox_events (
           event_id, event_type, schema_version, aggregate_type,
           aggregate_id, payload, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT (event_type, aggregate_id) DO NOTHING`,
        [event.eventId, event.eventType, event.schemaVersion, event.aggregateType, event.aggregateId, json(event), new Date(event.occurredAt)],
      );

      for (const consumerName of [CONSUMERS.RESEARCH, CONSUMERS.TELEGRAM]) {
        await client.query(
          `INSERT INTO event_consumptions (event_id, consumer_name)
           VALUES ($1,$2)
           ON CONFLICT (event_id, consumer_name) DO NOTHING`,
          [event.eventId, consumerName],
        );
      }
      await client.query(
        `UPDATE outbox_events
         SET status = 'published', published_at = now()
         WHERE event_id = $1`,
        [event.eventId],
      );

    }

    // EDPI-L persistence is atomic with the alert decision. A failure
    // rolls back both rather than allowing a successful alert to exist
    // without its authoritative EDPI-L evaluation. On an idempotent retry,
    // this also repairs an alert whose evaluation row is missing.
    if (input.edpiL) {
      await persistEdpiLEvaluationWithClient(input, alertId, client);
    }
  });

  return { alertId, eventId: alertId, inserted };
}

function rowToAlertDecision(row) {
  if (!row) return null;
  const feature = row.feature_snapshot || {};
  const market = feature.market || {};
  const safety = feature.safety || {};
  const context = feature.context || {};
  const source = row.source_snapshot || {};
  const tokenIdentity = feature.token || {};
  // Keep ai_output_raw immutable for audit/training provenance, but never
  // expose it directly as the Telegram signal. Structured Gemini output is
  // rendered through the same clean text renderer used by the alert UX.
  const assessmentPacket = row.ai_decision_json || packetFromSignal(row.ai_output_raw || '');
  const cleanSignal = renderAssessment(assessmentPacket);
  return {
    alertId: row.alert_id,
    pairAddress: row.pair_address,
    mintAddress: row.mint_address,
    baseToken: {
      address: tokenIdentity.address || row.mint_address,
      symbol: tokenIdentity.symbol || null,
      name: tokenIdentity.name || null,
    },
    priceUsd: market.priceUsd,
    marketCap: market.marketCap,
    liquidity: market.liquidityUsd,
    volume1h: market.volume1h,
    buys1h: market.buys1h,
    sells1h: market.sells1h,
    priceChange1h: market.priceChange1h,
    ageMinutes: market.ageMinutes,
    pairCreatedAt: market.pairCreatedAt,
    hypeScore: row.hype_score === null ? null : Number(row.hype_score),
    riskLevel: row.risk_level,
    signal: cleanSignal || row.signal_label || '',
    signalLabel: row.signal_label,
    narrativeTag: context.narrativeTag,
    subNarrativeTag: context.subNarrativeTag,
    categoryKey: context.categoryKey,
    prediction: context.prediction,
    historicalMatches: context.historicalMatches || [],
    recurringWallets: context.recurringWallets || [],
    socialSignals: row.social_snapshot || context.socialSignals || null,
    socialMetadata: context.socialMetadata || null,
    discovery: context.discovery || null,
    liveEvidence: row.live_evidence || context.liveEvidence || null,
    // EDPI-L is persisted as an explicit alert-decision contract field and
    // mirrored inside live_evidence for the broader evidence record. Expose
    // the authoritative persisted result to the alert formatter so the
    // Telegram alert can show the same score that was calculated at
    // qualification time, without recomputing it during delivery.
    edpiL: row.live_evidence?.edpiL || row.edpi_l || null,
    rugcheck: safety ? {
      riskScore: safety.score,
      liquidityLocked: safety.lpLockedPct === null || safety.lpLockedPct === undefined
        ? null
        : Number(safety.lpLockedPct) > 0,
      topHolderPct: safety.topHolderPct,
      lpLockedPct: safety.lpLockedPct,
      mintAuthorityHeld: safety.mintAuthorityHeld,
      freezeAuthorityHeld: safety.freezeAuthorityHeld,
      risks: safety.risks || [],
    } : null,
    url: feature.url || source.dexscreener?.pairUrl || null,
    alertDecision: {
      signalStatus: row.signal_status,
      qualificationStatus: row.qualification_status,
      qualifiedAt: row.qualified_at,
      promptVersion: row.prompt_version,
      scoringVersion: row.scoring_version,
      configVersion: row.config_version,
    },
  };
}

async function getAlertDecision(alertId) {
  const { rows } = await require('../db/pool').query('SELECT * FROM alert_decisions WHERE alert_id = $1', [alertId]);
  return rowToAlertDecision(rows[0]);
}

module.exports = { persistAlertDecision, persistEdpiLEvaluation, createAlertId, getAlertDecision, rowToAlertDecision };
