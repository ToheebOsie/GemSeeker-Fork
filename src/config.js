require('dotenv').config();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.warn(`[config] Missing env var ${name} — related features will be disabled until it's set.`);
  }
  return val;
}


function validatedNumberEnv(name, fallback, { minExclusive = null, minInclusive = null, integer = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  const finite = Number.isFinite(value);
  const integerOk = !integer || Number.isInteger(value);
  const exclusiveOk = minExclusive === null || value > minExclusive;
  const inclusiveOk = minInclusive === null || value >= minInclusive;
  if (!finite || !integerOk || !exclusiveOk || !inclusiveOk) {
    throw new Error(`[config] ${name} must be ${integer ? 'a finite integer' : 'a finite number'}${minExclusive !== null ? ` > ${minExclusive}` : ''}${minInclusive !== null ? ` >= ${minInclusive}` : ''}; got ${raw}.`);
  }
  return value;
}

function positiveIntEnv(name, fallback, { min = 1, max = 600000 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`[config] ${name} must be an integer between ${min} and ${max}; using ${fallback}.`);
    return fallback;
  }
  return value;
}

/**
 * Parses a comma-separated allow-list env var against a fixed set of valid
 * values (e.g. scoring.js's riskLevel strings, gemini_signal_generator.js's
 * signal labels), case-insensitively — CLASS_ALERTS=low,high matches the
 * real 'Low'/'High' casing used everywhere else in the codebase just as
 * well as CLASS_ALERTS=Low,High does, so a caller doesn't need to know or
 * guess the internal casing to configure this. Unset entirely -> every
 * valid value (i.e. no filtering, current/default behavior unchanged). An
 * entry that doesn't match any valid value is dropped with a warning
 * rather than silently kept (a case-sensitive .includes() check later
 * would just never match it anyway — better to say so at startup than
 * leave someone wondering why a filter "isn't working").
 */
function parseAllowList(envVarName, validValues) {
  const raw = process.env[envVarName];
  if (raw === undefined) return validValues.slice();

  const lookup = new Map(validValues.map((v) => [v.toLowerCase(), v]));
  const result = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const matched = lookup.get(part.toLowerCase());
    if (!matched) {
      console.warn(`[config] ${envVarName} contains unrecognized value "${part}" — ignoring it. Valid values: ${validValues.join(', ')}.`);
    } else if (!result.includes(matched)) {
      result.push(matched);
    }
  }
  return result;
}

module.exports = {
  telegram: {
    token: requireEnv('TELEGRAM_BOT_TOKEN'),
  },

  gemini: {
    apiKey: requireEnv('GEMINI_API_KEY'),
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  },


  rugcheck: {
    apiKey: process.env.RUGCHECK_API_KEY, // optional at low volume, required for higher rate limits
    baseUrl: 'https://api.rugcheck.xyz/v1',
    // Full /report responses can take longer than a lightweight API call.
    // Keep this configurable so production can tolerate temporary Rugcheck
    // slowness without hard-coding an aggressive 10s cutoff.
    reportTimeoutMs: positiveIntEnv('RUGCHECK_TIMEOUT_MS', 20000, { min: 1000, max: 60000 }),
    // Rugcheck's score is a RISK score, 0-100, HIGHER = RISKIER (this is the
    // opposite of a "trust score" — don't flip this without re-reading
    // rugcheckService.js's extractSafetySignals comment). Rugcheck's own
    // bands: 0-30 Low risk (Good), 30-60 Medium, 60-100 High risk (Danger).
    // A token is discarded if its riskScore is ABOVE this value.
    // Tune this to taste:
    //   20  = strict, only "Good" band passes
    //   50  = moderate, allows some Medium-risk tokens through (current default)
    //   60+ = loose, starts letting "High risk" tokens through — not recommended
    maxRiskScore: 50,
    maxTopHolderPct: 30, // top holder owning more than this % of supply => discarded

    // --- Client-side throttling (fix for the 2026-09 429 storm) ---
    // We don't have a verified, current req/min figure for Rugcheck's API
    // (it's a third-party service that can change its limits without
    // notice — check your own dashboard at rugcheck.xyz for your key's
    // actual tier), so these default to conservative values and are meant
    // to be tuned via env vars once you know your real limit, not trusted
    // blindly. All of this lives in rugcheckService.js's shared `http`
    // client, so it protects every caller (tokenScanner AND
    // patternReviewer both go through the same one) without either of
    // them needing to know about it.

    // Minimum gap enforced between consecutive Rugcheck requests,
    // regardless of caller. This is spacing, not a burst allowance — it
    // exists so that a scan cycle with many qualifying candidates doesn't
    // fire them back-to-back and trip the limit itself.
    minRequestIntervalMs: Number(process.env.RUGCHECK_MIN_REQUEST_INTERVAL_MS || 1100),

    // Circuit breaker: the moment we get ONE 429, we know every other
    // in-flight/queued call is almost certainly about to get 429'd too —
    // see rugcheckService.js's doc comment for why we stop trying instead
    // of retrying each one individually. This caps how long we'll wait
    // before trying Rugcheck again when the response doesn't include a
    // usable Retry-After header.
    fallbackBackoffMs: Number(process.env.RUGCHECK_FALLBACK_BACKOFF_MS || 15_000),
    maxBackoffMs: Number(process.env.RUGCHECK_MAX_BACKOFF_MS || 5 * 60 * 1000),

    // Per-mint negative cache: once a specific mint has failed (429, or a
    // genuine "not indexed yet" 404/400), don't ask about that SAME mint
    // again until this much time has passed — even after the circuit
    // breaker above has closed. Without this, a token that keeps
    // reappearing as a scan candidate every SCAN_INTERVAL_MS re-triggers
    // the identical failure every single cycle (exactly what the
    // repeated-mint-address pattern in the 2026-09 incident log showed).
    failureCacheTtlMs: Number(process.env.RUGCHECK_FAILURE_CACHE_TTL_MS || 5 * 60 * 1000),
  },

  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    // Optional, separate RPC endpoint/key for scripts/backfill-early-wallets.js
    // specifically — set this to a DIFFERENT provider account's key so the
    // backfill's own rate-limit budget stops being shared with the live
    // bot's SOLANA_RPC_URL above. Unset = falls back to rpcUrl, today's
    // behavior. See backfill-early-wallets.js's header comment for why
    // this exists (the shared-key contention found investigating a
    // Neon compute-hour exhaustion incident, then a Helius rate-limit
    // slowness question that followed it).
    backfillRpcUrl: process.env.BACKFILL_SOLANA_RPC_URL || null,
  },

  // Postgres — see src/db/pool.js, src/db/schema.sql, scripts/migrate.js.
  // Replaces the three JSON-file stores below as of Phase 1 of the V2
  // roadmap. DATABASE_URL is required for the live app; the storage.*/
  // patternTracking.dbFile/archiveFile/reports.stateFile paths further
  // down are kept only as the migration script's read source, not used by
  // the live stores anymore.
  db: {
    connectionString: requireEnv('DATABASE_URL'),
    // Optional: a NON-pooled ("direct") connection string, used only for
    // session-scoped Postgres features that transaction-mode poolers
    // (Neon's built-in PgBouncer, Supabase's Supavisor, etc.) silently
    // break — currently just src/db/advisoryLock.js. Neon's own docs list
    // session-level advisory locks explicitly as needing the direct
    // hostname (the one without "-pooler"), because a transaction-mode
    // pooler can return the physical backend to the pool — and reset its
    // session state — between any two statements sent on what looks like
    // one stable client connection from Node's side, even without an
    // explicit disconnect. A lock acquired on one physical backend can be
    // gone by the time the matching unlock (or even the next statement)
    // runs, with no error raised — the two statements simply don't share
    // a session anymore. Falls back to `connectionString` above if unset,
    // which is correct for direct/unpooled databases (local dev, most
    // non-serverless Postgres hosts) but silently reintroduces this exact
    // bug if DATABASE_URL itself points at a transaction-mode pooler and
    // this is left unconfigured — see the startup check in db/pool.js.
    directConnectionString: process.env.DIRECT_DATABASE_URL || null,
    ssl: (process.env.DATABASE_SSL ?? 'false') === 'true',
    poolMax: positiveIntEnv('DATABASE_POOL_MAX', 10, { min: 1, max: 100 }),
    connectionTimeoutMs: positiveIntEnv('DATABASE_CONNECTION_TIMEOUT_MS', 10000),
    idleTimeoutMs: positiveIntEnv('DATABASE_IDLE_TIMEOUT_MS', 30000),
    statementTimeoutMs: positiveIntEnv('DATABASE_STATEMENT_TIMEOUT_MS', 30000),
    queryTimeoutMs: positiveIntEnv('DATABASE_QUERY_TIMEOUT_MS', 35000),
    keepAlive: (process.env.DATABASE_KEEP_ALIVE ?? 'true') !== 'false',
    applicationName: process.env.DATABASE_APPLICATION_NAME || 'gem-seeker',
  },

  // Early-wallet-activity sharding (item 41) - see src/db/shardPool.js's
  // header comment for the full design. EARLY_WALLET_SHARD_URLS is a
  // comma-separated list of Postgres connection strings for shards 1..N;
  // shard 0 is always the primary `db` pool above, never listed here.
  // Unset/empty = zero extra shards = today's single-database behavior,
  // so this is safe to leave unconfigured until shards are actually
  // provisioned.
  earlyWalletShards: {
    extraShardUrls: (process.env.EARLY_WALLET_SHARD_URLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
        ssl: (process.env.DATABASE_SSL ?? 'false') === 'true',
    poolMax: positiveIntEnv('DATABASE_POOL_MAX', 10, { min: 1, max: 100 }),
    connectionTimeoutMs: positiveIntEnv('DATABASE_CONNECTION_TIMEOUT_MS', 10000),
    idleTimeoutMs: positiveIntEnv('DATABASE_IDLE_TIMEOUT_MS', 30000),
    statementTimeoutMs: positiveIntEnv('DATABASE_STATEMENT_TIMEOUT_MS', 30000),
    queryTimeoutMs: positiveIntEnv('DATABASE_QUERY_TIMEOUT_MS', 35000),
    keepAlive: (process.env.DATABASE_KEEP_ALIVE ?? 'true') !== 'false',
    applicationName: process.env.DATABASE_APPLICATION_NAME || 'gem-seeker-shard',
  },

  // Historical and future-token early-wallet reconstruction is deliberately
  // opt-in: it spends RPC quota and writes many immutable activity rows. Each
  // scheduler run invokes the resumable backfill script with conservative
  // bounds, so enabling it does not create overlapping unbounded workers.
  // Canonical wallet evidence-depth capture. This is shared by EDPI-L, CTO,
  // and future wallet-intelligence consumers: it expands evidence depth
  // without changing any downstream scoring rules. The target counts unique
  // wallet-level economic transactions already classified by the canonical
  // capture path; it is deliberately NOT a raw-RPC transaction limit.
  walletActivityEvidence: {
    enabled: (process.env.WALLET_ACTIVITY_EVIDENCE_ENABLED ?? 'true') !== 'false',
    targetRelevantTransactions: positiveIntEnv('WALLET_ACTIVITY_EVIDENCE_TARGET', 1000, { min: 1, max: 5000 }),
    rawPageSize: positiveIntEnv('WALLET_ACTIVITY_EVIDENCE_RAW_PAGE_SIZE', 1000, { min: 100, max: 1000 }),
    maxRawTransactions: positiveIntEnv('WALLET_ACTIVITY_EVIDENCE_MAX_RAW', 20_000, { min: 1000, max: 100_000 }),
    maxPages: positiveIntEnv('WALLET_ACTIVITY_EVIDENCE_MAX_PAGES', 25, { min: 1, max: 100 }),
    maxHistoricalPairs: positiveIntEnv('WALLET_ACTIVITY_EVIDENCE_MAX_PAIRS', 100, { min: 1, max: 500 }),
    perWindowMaxTxParse: positiveIntEnv('WALLET_ACTIVITY_EVIDENCE_WINDOW_MAX_TX_PARSE', 20_000, { min: 100, max: 100_000 }),
    windowMinutes: positiveIntEnv('WALLET_ACTIVITY_EVIDENCE_WINDOW_MINUTES', 30, { min: 1, max: 240 }),
    minSol: validatedNumberEnv('WALLET_ACTIVITY_EVIDENCE_MIN_SOL', 0.5, { minInclusive: 0 }),
    pageSleepMs: positiveIntEnv('WALLET_ACTIVITY_EVIDENCE_PAGE_SLEEP_MS', 500, { min: 0, max: 60_000 }),
    txSleepMs: positiveIntEnv('WALLET_ACTIVITY_EVIDENCE_TX_SLEEP_MS', 250, { min: 0, max: 60_000 }),
  },

  earlyWalletBackfill: {
    enabled: (process.env.EARLY_WALLET_BACKFILL_ENABLED ?? 'false') === 'true',
    // Default max override: the scheduler is designed to run hourly by default,
    // which exceeds positiveIntEnv's own default 600000ms (10min) cap - without
    // this override, explicitly setting EARLY_WALLET_BACKFILL_INTERVAL_MS above
    // 10 minutes would be silently rejected back to the 1h fallback.
    intervalMs: positiveIntEnv('EARLY_WALLET_BACKFILL_INTERVAL_MS', 60 * 60 * 1000, { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }),
    startDelayMs: positiveIntEnv('EARLY_WALLET_BACKFILL_START_DELAY_MS', 15 * 1000),
    batchSize: positiveIntEnv('EARLY_WALLET_BACKFILL_BATCH_SIZE', 5, { min: 1, max: 50 }),
    windowMinutes: positiveIntEnv('EARLY_WALLET_BACKFILL_WINDOW_MINUTES', 30, { min: 1, max: 240 }),
    minSol: Number(process.env.EARLY_WALLET_BACKFILL_MIN_SOL || 0.5),
    sigCap: positiveIntEnv('EARLY_WALLET_BACKFILL_SIG_CAP', 50, { min: 1, max: 500 }),
    maxTxParse: positiveIntEnv('EARLY_WALLET_BACKFILL_MAX_TX_PARSE', 50, { min: 1, max: 300 }),
    maxRpcRequests: positiveIntEnv('EARLY_WALLET_BACKFILL_MAX_RPC_REQUESTS', 500),
    maxElapsedMs: positiveIntEnv('EARLY_WALLET_BACKFILL_MAX_ELAPSED_MS', 10 * 60 * 1000),
    maxDbWrites: positiveIntEnv('EARLY_WALLET_BACKFILL_MAX_DB_WRITES', 10_000),
    pageSleepMs: positiveIntEnv('EARLY_WALLET_BACKFILL_PAGE_SLEEP_MS', 500),
    txSleepMs: positiveIntEnv('EARLY_WALLET_BACKFILL_TX_SLEEP_MS', 250),
  },

  dexscreener: {
    baseUrl: 'https://api.dexscreener.com',
    searchTerms: ['pump', 'raydium'],
    chainId: 'solana',
  },

  discoveryLearning: {
    qualificationFilterVersion: process.env.QUALIFICATION_FILTER_VERSION || 'qualification-v1',
    minimumComparisonSampleSize: Number(process.env.DISCOVERY_MIN_COMPARISON_SAMPLE || 30),
  },

  // High-ROI winner-pattern rule. Shadow-only: it is persisted with live
  // evidence for prospective evaluation, but cannot change qualification,
  // Gemini verdicts, tracking, or broadcasts.
  highRoiPatternShadow: {
    enabled: (process.env.HIGH_ROI_PATTERN_SHADOW_ENABLED ?? 'true') !== 'false',
  },

  // Background persistence/worker switches. All default ON (unchanged behaviour); set to exactly
  // 'false' to turn one off without a code change.
  backgroundJobs: {
    researchWorkerEnabled: (process.env.RESEARCH_WORKER_ENABLED ?? 'true') !== 'false',
    researchObservationWorkerEnabled: (process.env.RESEARCH_OBSERVATION_WORKER_ENABLED ?? 'true') !== 'false',
    discoveryEventsEnabled: (process.env.DISCOVERY_EVENTS_ENABLED ?? 'true') !== 'false',
    discoveryEvaluationsEnabled: (process.env.DISCOVERY_EVALUATIONS_ENABLED ?? 'true') !== 'false',
    // discovery_observations (per-pair provenance summary, written every scan cycle)
    discoveryObservationsEnabled: (process.env.DISCOVERY_OBSERVATIONS_ENABLED ?? 'true') !== 'false',
    // discovery_outcome_observations (5m..72h follow-up snapshots) + the research_jobs rows that schedule them
    discoveryOutcomeObservationsEnabled: (process.env.DISCOVERY_OUTCOME_OBSERVATIONS_ENABLED ?? 'true') !== 'false',
  },

  // Standalone model-focused fork. Tier-2 collection is permitted only after
  // the pre-Gemini high-ROI discovery fingerprint passes. This boundary is
  // separate from the full shadow rubric because that rubric includes the
  // later Gemini signal label.
  modelFocus: {
    enabled: (process.env.MODEL_FOCUS_ENABLED ?? 'true') !== 'false',
    enforceTier1Gate: (process.env.MODEL_FOCUS_ENFORCE_TIER1_GATE ?? 'true') !== 'false',
    shortCircuitNonTier1: (process.env.MODEL_FOCUS_SHORT_CIRCUIT_NON_TIER1 ?? 'true') !== 'false',
    tier1MinimumPoints: Number(process.env.MODEL_FOCUS_TIER1_MIN_POINTS || 6),
    collectTier2OnlyAfterTier1: (process.env.MODEL_FOCUS_TIER2_ONLY_AFTER_TIER1 ?? 'true') !== 'false',
  },

  // Fixed-window Tier-2 wallet evidence. This is only invoked after the
  // modelFocus Tier-1 admission gate in the standalone fork.
  fixedWindowWallet: {
    enabled: (process.env.FIXED_WINDOW_WALLET_ENABLED ?? 'true') !== 'false',
    captureAtDiscovery: (process.env.FIXED_WINDOW_CAPTURE_AT_DISCOVERY ?? 'true') !== 'false',
    heliusApiKey: process.env.HELIUS_API_KEY || null,
    birdeyeApiKey: process.env.BIRDEYE_API_KEY || null,
    hellomoonApiKey: process.env.HELLOMOON_API_KEY || null,
    timeoutMs: positiveIntEnv('FIXED_WINDOW_PROVIDER_TIMEOUT_MS', 12000, { min: 1000, max: 60000 }),
    pageLimit: positiveIntEnv('FIXED_WINDOW_PROVIDER_PAGE_LIMIT', 100, { min: 1, max: 1000 }),
    maxPages: positiveIntEnv('FIXED_WINDOW_PROVIDER_MAX_PAGES', 5, { min: 1, max: 100 }),
    windows: Object.freeze([
      { key: 'pre_discovery_30m', phase: 'discovery', minutes: 30 },
      { key: 'pre_discovery_60m', phase: 'discovery', minutes: 60 },
    ]),
  },

  tier2Scoring: {
    enabled: (process.env.TIER2_SCORING_ENABLED ?? 'true') !== 'false',
    threshold: Number(process.env.TIER2_SCORE_THRESHOLD || 8),
    minBuyerCountStrong: Number(process.env.TIER2_MIN_BUYERS_STRONG || 5),
    minBuyerCountWeak: Number(process.env.TIER2_MIN_BUYERS_WEAK || 3),
    maxTop1BuyerShareStrongPct: Number(process.env.TIER2_MAX_TOP1_SHARE_STRONG_PCT || 35),
    maxTop1BuyerShareWeakPct: Number(process.env.TIER2_MAX_TOP1_SHARE_WEAK_PCT || 50),
    maxBuyerHhi: Number(process.env.TIER2_MAX_BUYER_HHI || 0.25),
    minBuySellTransactionRatio: Number(process.env.TIER2_MIN_BUY_SELL_TX_RATIO || 1.5),
    minBuySellValueRatio: Number(process.env.TIER2_MIN_BUY_SELL_VALUE_RATIO || 1.1),
    minPlatformActivity60m: Number(process.env.TIER2_MIN_PLATFORM_ACTIVITY_60M || 1),
    maxPlatformActivity60m: Number(process.env.TIER2_MAX_PLATFORM_ACTIVITY_60M || 100),
    requireCompleteDiscoveryWindows: (process.env.TIER2_REQUIRE_COMPLETE_WINDOWS ?? 'true') !== 'false',
  },

  // GeckoTerminal discovery configuration. The service is shared by the
  // production discovery adapter and the separate early-discovery research
  // experiment; `discovery.enabled` is the explicit live-pipeline gate.
  geckoTerminal: {
    // Production discovery integration is opt-in so the existing
    // DexScreener-only behavior remains unchanged until explicitly enabled.
    discovery: {
      enabled: process.env.GECKOTERMINAL_DISCOVERY_ENABLED === 'true',
      minVolume1hUsd: Number(process.env.GECKO_MIN_VOLUME_1H_USD || 100),
      minTotalVolumeUsd: Number(process.env.GECKO_MIN_TOTAL_VOLUME_USD || 1000),
    },
    // Keyless base — no signup, no key required. GeckoTerminal's own docs
    // (apiguide.geckoterminal.com) state ~10 calls/min for onchain
    // endpoints on this host, with responses cached ~60s either way, so
    // polling faster than that buys nothing. A separate third-party page
    // quotes 30/min for the same host — we don't have a verified figure
    // for OUR key/IP (same "check your own actual limit" caveat as
    // rugcheck.maxRiskScore's neighbor comment), so this defaults to the
    // more conservative number and is tunable via env once observed
    // against real traffic (see docs for what to watch for).
    baseUrl: 'https://api.geckoterminal.com/api/v2',
    network: process.env.GECKOTERMINAL_NETWORK || 'solana',
    minRequestIntervalMs: Number(process.env.GECKOTERMINAL_MIN_REQUEST_INTERVAL_MS || 6000), // ~10/min ceiling
    fallbackBackoffMs: Number(process.env.GECKOTERMINAL_FALLBACK_BACKOFF_MS || 15_000),
    maxBackoffMs: Number(process.env.GECKOTERMINAL_MAX_BACKOFF_MS || 5 * 60 * 1000),
    timeoutMs: Number(process.env.GECKOTERMINAL_TIMEOUT_MS || 10000),

    // Free fallback path (spec section 2): CoinGecko's own "Demo API key"
    // program — free signup at coingecko.com, same underlying onchain
    // dataset as GeckoTerminal but a DIFFERENT host and a SEPARATE
    // rate-limit pool (api.coingecko.com/api/v3/onchain, not
    // api.geckoterminal.com/api/v2), so a rate-limit or outage on one
    // host does not take out the other. This is NOT a second independent
    // data source (same vendor, same underlying indexer) — see the
    // docs file's "Known limitation" section for why a genuinely
    // independent second source (e.g. a Pump.fun-specific feed) was
    // deliberately not added in this first pass. Unset
    // (COINGECKO_DEMO_API_KEY empty) = fallback path is simply skipped;
    // the experiment still runs on the primary path alone.
    fallbackBaseUrl: 'https://api.coingecko.com/api/v3/onchain',
    fallbackApiKey: process.env.COINGECKO_DEMO_API_KEY || null,
  },

  payments: {
    walletAddress: requireEnv('PAYMENT_WALLET_ADDRESS'),
    priceUsd: Number(process.env.SUBSCRIPTION_PRICE_USD || 5),
    subscriptionDays: Number(process.env.SUBSCRIPTION_DAYS || 30),
    trialAlertCount: Number(process.env.TRIAL_ALERT_COUNT || 50),
    // Accepted margin around the USD price to tolerate SOL/USDC/USDT price
    // volatility between quote time and confirmation time.
    priceTolerancePct: 5,
    acceptedMints: {
      // USDC and USDT mint addresses on Solana mainnet.
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
  },

  // Legacy JSON store path — only read by scripts/migrate.js now. The live
  // app uses src/storage/subscriberStore.js, which is Postgres-backed.
  storage: {
    dbFile: process.env.DB_FILE || './data/subscribers.json',
  },

  // Admin access: chat IDs listed here bypass trial/subscription gating
  // entirely (unlimited alerts, never decremented) and are the only
  // recipients of the daily/weekly self-assessment reports below and the
  // /admin, /report admin-only bot commands. Get a chat ID by messaging
  // @userinfobot on Telegram, or from the chatId your bot logs when that
  // person sends /start.
  admin: {
    chatIds: (process.env.ADMIN_CHAT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Alert-BROADCAST filter only — does NOT touch tracking, archiving,
  // pattern predictions, market state, or anything else in
  // tokenScanner.js/patternReviewer.js, all of which keep running exactly
  // as before for every risk class and every verdict regardless of these
  // settings. This only decides which of the already-qualified tokens
  // index.js hands to telegramBot.js's broadcastAlerts for actually being
  // sent to subscribers — see src/core/alertPolicy.js's isAlertable, the
  // sole consumer of this config.
  //
  // CLASS_ALERTS   - which scoring.js riskLevel(s) to alert on. Default
  //                  (unset): Low, Medium, High — everything, unchanged
  //                  from before this existed.
  // VERDICT_ALERTS - which gemini_signal_generator.js signalLabel(s) to
  //                  alert on. Default (unset): BUY, WAIT, SKIP —
  //                  everything, unchanged from before this existed.
  // A token must match BOTH lists to be sent — e.g. CLASS_ALERTS=Low
  // VERDICT_ALERTS=BUY sends only Low-risk BUY alerts; a Low-risk WAIT or
  // a Medium-risk BUY are both suppressed from broadcast (but still
  // tracked/archived normally, per above).
  alerts: {
    classLevels: parseAllowList('CLASS_ALERTS', ['Low', 'Medium', 'High']),
    verdicts: parseAllowList('VERDICT_ALERTS', ['BUY', 'WAIT', 'SKIP']),
  },

  // Self-assessment reporting: the bot periodically reviews its own
  // completed (archived) pattern-tracking history — see patternTracking
  // below — and reports the average/median peak ROI actually achieved by
  // tokens it labeled BUY vs WAIT (vs SKIP), broken down by day/week, to
  // every chat ID in admin.chatIds above.
  reports: {
    enabled: (process.env.REPORTS_ENABLED ?? 'true') !== 'false',
    dailyIntervalMs: 24 * 60 * 60 * 1000,
    weeklyIntervalMs: 7 * 24 * 60 * 60 * 1000,
    // How often the scheduler wakes up to check whether a daily/weekly
    // boundary has been crossed since the last report. Doesn't need to be
    // frequent — reports are date-window based, not wall-clock-precise.
    checkIntervalMs: Number(process.env.REPORT_CHECK_INTERVAL_MS || 60 * 60 * 1000), // hourly
    // Legacy JSON path — only read by scripts/migrate.js now. The live app
    // uses src/storage/reportStateStore.js, which is Postgres-backed.
    stateFile: process.env.REPORT_STATE_FILE || './data/report_state.json',
  },

  // Tier 2, Phase 13 — Market State Engine. See src/core/marketStateEngine.js
  // for the actual computation and src/storage/marketStateStore.js for the
  // Postgres-backed store. Read by the /insights command
  // (marketStateFormatter.js), so this has no chatIds/enabled-for-whom concept the way
  // reports does — it only computes and stores.
  marketState: {
    enabled: (process.env.MARKET_STATE_ENABLED ?? 'true') !== 'false',
    // How often to recompute today's per-narrative aggregates. Cheap to
    // recompute (upsert, not append), so this can run far more often than
    // "daily" without any downside — each tick just refreshes today's row
    // with the latest tracked-token/archive data. Defaults to hourly,
    // piggybacking the same cadence reports.checkIntervalMs uses.
    intervalMs: Number(process.env.MARKET_STATE_INTERVAL_MS || 60 * 60 * 1000),
  },

  // Tier 2, Phase 4 — Observation Engine. See src/core/observationEngine.js
  // for the full reasoning. Was OFF by default pending explicit sign-off
  // (same precedent as Social Score); user has since confirmed both the
  // risk tiers and window below AND explicitly asked to turn it on, so as
  // of this session it defaults to ON. Set OBSERVATION_ENABLED=false to
  // turn it back off without a code change.
  observation: {
    enabled: (process.env.OBSERVATION_ENABLED ?? 'true') === 'true',
    // Only tokens whose riskLevel (from scoring.js) is in this list get
    // held for observation before alerting — Low is deliberately excluded
    // by default: it's already cleared the strictest bar, so it has the
    // least to gain and the most "early" value to lose from added delay.
    // Confirmed: Medium+High.
    observeRiskLevels: (process.env.OBSERVATION_RISK_LEVELS || 'Medium,High').split(',').map((s) => s.trim()).filter(Boolean),
    // How long a token must keep passing fresh market-filter + safety-gate
    // checks before it graduates from observation to an actual alert.
    // At the default 30s scan interval (scanner.intervalMs) this is ~6
    // fresh passes required. Confirmed: 3 min.
    windowMs: Number(process.env.OBSERVATION_WINDOW_MS || 3 * 60 * 1000),
  },

  scanner: {
    intervalMs: Number(process.env.SCAN_INTERVAL_MS || 30000),
    newTokenAgeMinutes: 10,
    thresholds: {
      // A token is discarded if marketCap is more than this many times
      // volume1h, OR volume1h is more than this many times marketCap.
      // Both directions are red flags on their own:
      //   mc >> volume  -> stale/no real trading behind the market cap
      //   volume >> mc  -> volume wildly disproportionate to size, often
      //                    wash trading or an unsustainable pump
      // Set to `null` to disable this check entirely.
      maxMcapToVolumeRatio: 20,
      new: { // age < 10 minutes
        minVolume1h: 1000,
        minBuys1h: 5,
        minMarketCapIfNoLiquidity: 10000,
        minLiquidity: 3000,
      },
      established: { // age >= 10 minutes
        minVolume1h: 5000,
        minBuys1h: 20,
        minMarketCapIfNoLiquidity: 30000,
        minLiquidity: 10000,
      },
    },
  },

  // Pattern-tracking / historical prediction feature.
  // See src/core/narrativeClassifier.js and src/core/patternAnalyzer.js for
  // the pure logic, src/core/patternReviewer.js for the 3-hourly job, and
  // src/storage/tokenPatternStore.js for the two JSON stores this reads/writes.
  patternTracking: {
    enabled: true,

    // How often the review job re-checks every actively-tracked token.
    reviewIntervalMs: Number(process.env.PATTERN_REVIEW_INTERVAL_MS || 3 * 60 * 60 * 1000), // 3 hours

    // AUDIT FOLLOW-UP: at the un-tiered reviewIntervalMs above, a token
    // that rugs before its very first review tick gets ZERO snapshots
    // rows, ever — enrollToken (tokenScanner.js) never writes one, only
    // reviewToken (patternReviewer.js) does. That's not a data-quality
    // gap, it's a review-cadence gap: patternAnalyzer.js's
    // classifyRugMechanism can't distinguish "we looked and saw nothing
    // move" from "we never got to look at all," and a fast-rugging
    // memecoin hitting that gap is the common case, not the edge case.
    // A token younger than earlyLifeWindowMs (since qualifiedAt) is
    // reviewed on this faster cadence instead of reviewIntervalMs, so
    // more of them survive to at least one real, independently-fetched
    // Rugcheck observation before they might archive. Tokens past this
    // age fall back to the normal reviewIntervalMs cadence unchanged —
    // this only adds load for the (much smaller) young-token population,
    // not the whole tracked set. See reviewAllTrackedTokens' dueForReview
    // filter for how the two cadences are actually applied.
    //
    // Defaults chosen without a real time-to-rug distribution to tune
    // against yet (worth revisiting once one's available — see
    // HANDOFF.md): earlyLifeWindowMs matches the OLD un-tiered
    // reviewIntervalMs (3h), so "young" means "would have been at risk
    // of zero review under the previous behavior"; earlyLifeReviewIntervalMs
    // (15 min) is a starting guess balanced against Rugcheck rate limits,
    // not a backtested number.
    earlyLifeWindowMs: Number(process.env.PATTERN_EARLY_LIFE_WINDOW_MS || 3 * 60 * 60 * 1000), // 3 hours
    earlyLifeReviewIntervalMs: Number(process.env.PATTERN_EARLY_LIFE_REVIEW_INTERVAL_MS || 15 * 60 * 1000), // 15 minutes

    // Only tokens whose riskLevel (from scoring.js) is in this list get
    // enrolled into tracking when they first qualify for an alert — PLUS,
    // regardless of riskLevel, any token whose AI signal came back WAIT or
    // BUY (see tokenScanner.js's shouldTrack). Those two paths are not
    // configurable here by design: WAIT/BUY already mean "worth watching
    // or acting on," independent of risk tier. Only a SKIP on a
    // non-Low-risk token is excluded from tracking.
    trackRiskLevels: ['Low'],

    // A tracked token is archived (stopped tracking, removed from the active
    // list) once its price drops to this fraction of its all-time-high price
    // recorded while we were tracking it. 0.01 = stop once price is below 1%
    // of ATH (i.e. down 99%+ from peak) — the point we're calling it "rugged"
    // for pattern-learning purposes.
    rugThresholdPctOfAth: 0.01,

    // Primary "survived" path: a tracked token is archived as 'survived' as
    // soon as its price has held at or above this fraction of its ATH for
    // this many consecutive hours, checked every review cycle. Chosen over
    // waiting out maxTrackingAgeMs below because (a) it resolves in days,
    // not weeks/months, so the archive's survived class actually fills at a
    // usable rate, and (b) "held its value shortly after being alerted" is
    // closer to what a subscriber actually cares about than "was still
    // being tracked 30 days later." A token that dips below minPctOfAth
    // resets the clock — the window must be unbroken, not cumulative.
    // Superseded immediately if the token instead crosses rugThresholdPctOfAth
    // first (isRugged is checked ahead of this in patternReviewer.js).
    survivedThreshold: {
      minPctOfAth: Number(process.env.PATTERN_SURVIVED_MIN_PCT_OF_ATH || 0.5),
      sustainedHours: Number(process.env.PATTERN_SURVIVED_SUSTAINED_HOURS || 72),
    },

    // Fallback safety valve: a token that neither rugs nor ever sustains
    // survivedThreshold above (e.g. one that oscillates between the two
    // bands indefinitely) would otherwise stay in the active tracking list
    // forever, growing the dataset unboundedly and burning a
    // Rugcheck+DexScreener call every review cycle indefinitely. After this
    // many ms of being tracked, it's archived anyway, tagged as "survived"
    // rather than "rugged". Set to `null` to disable and track indefinitely.
    // In practice, survivedThreshold above should catch most genuine
    // survivors well before this fires.
    maxTrackingAgeMs: Number(process.env.PATTERN_MAX_TRACKING_AGE_MS || 30 * 24 * 60 * 60 * 1000), // 30 days

    // Don't show a historical-pattern prediction for a category until at
    // least this many completed (archived) tokens exist in it — a
    // prediction from 1-2 data points is noise dressed up as a statistic.
    minSampleSizeForPrediction: 5,

    // How many "closest past archived token" rows narrativeIntelligence.js's
    // findSimilarHistoricalTokens surfaces in the alert's "Historical
    // Matches" section. Unlike minSampleSizeForPrediction above, this isn't
    // an aggregate statistic needing a minimum sample — each row is its own
    // individually-scored match, so even a single match is shown as-is.
    historicalMatchLimit: 3,

    // Hype score (0-10, from scoring.js) is bucketed into coarse tiers for
    // categorization, since raw hype score is too granular to group
    // meaningfully with a limited historical sample size. Buckets are
    // inclusive of `min`, exclusive of `max`.
    hypeScoreBuckets: [
      { label: 'moderate-hype', min: 0, max: 7 },
      { label: 'strong-hype', min: 7, max: 8.5 },
      { label: 'very-strong-hype', min: 8.5, max: 10.01 },
    ],

    // Phase 8: same bucketing idea as hypeScoreBuckets above, applied to
    // an archived token's peak ROI multiple — gives selfAssessment.js and
    // the daily/weekly reports a readable category instead of only a raw
    // float. Buckets are inclusive of `min`, exclusive of `max`.
    peakRoiBuckets: [
      { label: '<1x', min: 0, max: 1 },
      { label: '1x-2x', min: 1, max: 2 },
      { label: '2x-5x', min: 2, max: 5 },
      { label: '5x-10x', min: 5, max: 10 },
      { label: '10x-20x', min: 10, max: 20 },
      { label: '20x-50x', min: 20, max: 50 },
      { label: '50x-100x', min: 50, max: 100 },
      { label: '100x+', min: 100, max: Infinity },
    ],

    // Phase 8: thresholds for classifying a completed token's
    // `outcomeDetail` — a finer label than the base 'rugged'/'survived'
    // distinction, computed once at archive time from fields already
    // tracked (peakRoiMultiple, timeToRugFromQualificationHours,
    // athPriceUsd, finalPriceUsd). See patternAnalyzer.js's
    // classifyOutcomeDetail.
    outcomeDetail: {
      // A 'rugged' token's rug-timing bucket, keyed off
      // timeToRugFromQualificationHours — time from when THIS BOT
      // detected/qualified the token to the rug, not time from the
      // token's own price peak (timeToRugFromAthHours measures that
      // instead, and is still stored on the archive record, just no
      // longer what drives this label) — "how long would a subscriber
      // who bought right after the alert have had" is the more directly
      // actionable question than "how fast did it crash from its peak".
      // Each bucket is `hours < max` for the first boundary that fits;
      // maxHours: Infinity is the catch-all for anything at or beyond
      // the last real boundary. Boundaries are readability aids for
      // reports, not scientifically derived cutoffs.
      rugTimingBuckets: [
        { label: 'immediate-rug', maxHours: 1 },
        { label: 'rug-within-3h', maxHours: 3 },
        { label: 'rug-within-6h', maxHours: 6 },
        { label: 'rug-within-12h', maxHours: 12 },
        { label: 'rug-within-24h', maxHours: 24 },
        { label: 'rug-after-24h', maxHours: Infinity },
      ],
      // A 'survived' token that never exceeded this peak multiple is
      // 'dead' — it aged out or is still tracked-and-later-archived
      // without ever really moving, as distinct from one that pumped and
      // gave it back.
      deadMaxPeakMultiple: 1.3,
      // A 'survived' token is 'pump-and-dump' if it peaked at least this
      // high AND retraced at least pumpAndDumpMinRetracementPct from that
      // peak by archive time — i.e. it behaved like a rug in substance
      // (pumped, then gave most of it back) without technically crossing
      // the strict rugThresholdPctOfAth line during the tracking window.
      pumpAndDumpMinPeakMultiple: 2,
      pumpAndDumpMinRetracementPct: 60,
    },

    // Phase 9: `rugMechanism` — WHY a 'rugged' token rugged, not just how
    // fast (that's still outcomeDetail's job above). Computed once at
    // archive time by patternAnalyzer.js's classifyRugMechanism from the
    // same firstTopHolderPct/lastTopHolderPct/firstLpLockedPct/
    // lastLpLockedPct fields already on the archive record — no threshold
    // to tune here, since it deliberately reuses featureExtraction.js's
    // TOP_HOLDER_PCT_TREND_EPSILON/LP_LOCKED_PCT_TREND_EPSILON rather than
    // defining a second "what counts as a meaningful move" elsewhere.
    // Values: 'liquidity-pull-rug' (LP unlocked), 'distribution-dump-rug'
    // (top holder distributed, LP didn't unlock), 'organic-death' (neither
    // moved, and BOTH signals had a real first-vs-latest reading),
    // 'partial-unknown' (neither moved, but only one of the two signals
    // was ever captured — kept distinct from 'organic-death' so that
    // label doesn't overstate confidence), 'unknown-mechanism-no-review'
    // (zero post-enrollment snapshots exist at all — this token archived
    // before its first review tick ever ran, a timing gap; see
    // earlyLifeWindowMs below), 'unknown-mechanism-data-gap' (reviewed at
    // least once, but Rugcheck never returned usable topHolderPct/
    // lpLockedPct either time — a genuine data gap, not a timing one),
    // 'unknown-mechanism-no-checkpoint-data' (checkpointCount itself
    // unknown — only reachable via scripts/migrate.js's one-time
    // legacy-JSON migration for archive records that predate
    // checkpointCount existing as a tracked concept at all; a genuinely
    // different epistemic state from the two labels above, which each
    // assert something specific about the review count that this case
    // has no basis for).
    // null for 'survived' records.
    //
    // AUDIT FIX: lastTopHolderPct/lastLpLockedPct must come from each
    // field's own last NON-NULL snapshot reading (tokenPatternStore.js's
    // getLastKnownSafetyReading), not literally the newest snapshot row —
    // a token with a solid tracked history whose archiving-cycle Rugcheck
    // call happened to fail was otherwise misclassified as what's now
    // called 'unknown-mechanism-data-gap' despite having plenty of
    // earlier safety data.

    // Defensive cap on how many snapshot rows (see src/db/schema.sql's
    // `snapshots` table) a single tracked token can accumulate — not a
    // hard requirement at the default reviewIntervalMs/maxTrackingAgeMs
    // (a token ages out long before this matters), but cheap insurance
    // against a misconfiguration that leaves tokens tracked far longer
    // than intended. Oldest snapshots are pruned first once this is hit
    // (see tokenPatternStore.js's appendSnapshot).
    maxCheckpointsPerToken: 80, // ~10 days of history at a 3h interval

    // Legacy JSON store paths — only read by scripts/migrate.js now. The
    // live app uses src/storage/tokenPatternStore.js, which is
    // Postgres-backed.
    dbFile: process.env.PATTERN_DB_FILE || './data/tracked_tokens.json',
    archiveFile: process.env.PATTERN_ARCHIVE_FILE || './data/pattern_archive.json',
  },

  // Tier 1 wallet clustering — see rugcheckService.js's
  // extractTopHolderWallets and tokenPatternStore.js's recordTokenHolders/
  // getRecurringWalletsAmong. Costs no new API calls (rides the Rugcheck
  // /report call already made for the safety gate) and needs no new
  // vendor — deliberately separate from Tier 2 (real wallet-activity/
  // timing-based clustering), which would need an on-chain data provider
  // like Helius and isn't implemented here. ON by default since it's
  // purely additive (same posture as marketState) — set
  // WALLET_CLUSTERING_ENABLED=false to turn it off without a code change.
  walletClustering: {
    enabled: (process.env.WALLET_CLUSTERING_ENABLED ?? 'true') !== 'false',
    // A wallet must have appeared as a top holder on at least this many
    // DISTINCT qualifying tokens (including the one qualifying right now)
    // before alertFormatter.js surfaces it as a "seen before" note. 2 is
    // the lowest number that means anything ("recurring" requires at
    // least one prior appearance) — raise this if two coincidental
    // overlaps turn out to be too noisy in practice.
    minTokenCountForAlert: Number(process.env.WALLET_CLUSTERING_MIN_TOKEN_COUNT || 2),
  },

  // EDPI-L (Live Empirical Data Pattern Inference) — see src/core/edpiLive.js
  // for the feature-collection logic itself. A live, per-qualification
  // intelligence layer built entirely from evidence already fetched for
  // this qualification (Rugcheck's report, the wallet-clustering block
  // above) plus an OPTIONAL early_wallet_activity lookup — never a
  // prerequisite the way the Tier 2 backfill is for other things. ON by
  // default (purely additive, same posture as walletClustering above):
  // it only ever writes an additional live_evidence.edpiLive key, never
  // reads by qualification/scoring/broadcast logic.
  edpiLive: {
    enabled: (process.env.EDPI_LIVE_ENABLED ?? 'true') !== 'false',
    // Whether Gemini's own prompt includes an EDPI-L summary line.
    // Deliberately OFF by default and independent of `enabled` above:
    // EDPI-L is always computed and persisted to live_evidence once
    // `enabled` is true, but must not change what Gemini (and therefore
    // signalLabel/BUY-WAIT-SKIP) sees until this is explicitly turned on
    // — see edpiLive.js's header for why that split exists and how it
    // preserves an actual with/without comparison rather than a
    // point-in-time behavior change with no baseline to compare against.
    geminiContextEnabled: process.env.EDPI_LIVE_GEMINI_CONTEXT_ENABLED === 'true',
    // How many of a token's OWN top-holder wallets to check against
    // early_wallet_activity for historical enrichment (Evidence Family 4
    // in the spec) — bounded so a token with an unusually large
    // Rugcheck-reported holder list doesn't turn every qualification
    // into an unbounded shard fan-out.
    maxWalletsForHistoricalLookup: Number(process.env.EDPI_LIVE_MAX_WALLETS_FOR_HISTORY || 50),
    // Wallet-relative anomaly (Evidence Family 5) — see edpiLive.js's
    // buildWalletHistoricalBaseline/computeWalletRelativeAnomaly. A wallet
    // needs at least this many distinct historical entry campaigns
    // (early_wallet_activity, point-in-time filtered) before its baseline
    // is trusted enough to compare anything against — below this, the
    // median/percentiles would just be noise from 1-2 data points. This
    // gates ELIGIBILITY for a baseline, not the anomaly interpretation
    // itself (no bullish/bearish threshold here, just a sample-size floor).
    walletBaselineMinSampleSize: Number(process.env.EDPI_LIVE_WALLET_BASELINE_MIN_SAMPLE || 3),
    // Fragmented-buy grouping window — see edpiLive.js's
    // groupTradesIntoCampaigns header for the full reasoning. Two buys
    // from the same wallet on the same pair within this many ms of each
    // other are treated as one entry campaign, not two independent
    // trades. Chosen as a round, conservative default (most liquidity-
    // driven fragmentation happens within minutes, not hours) rather than
    // derived from an actual distribution of real gap times — this
    // environment has no live data to derive one from; see
    // docs/edpi-live.md's campaign-methodology section.
    campaignWindowMs: Number(process.env.EDPI_LIVE_CAMPAIGN_WINDOW_MS || 30 * 60 * 1000),
    // Comparable-entry outcome profile (see edpiLive.js's
    // buildComparableEntryOutcomeProfile) — a wallet's past campaign only
    // counts toward this conditioned view if its OWN entry MC and buy
    // size were both within this multiplier of the CURRENT entry/buy
    // size (either direction). An explicit, configurable RESEARCH
    // PARAMETER (per the spec's explicit instruction not to invent a
    // similarity threshold like "±20%" without justification) — 3x was
    // chosen only as a round, deliberately loose starting band wide
    // enough to keep sample sizes usable while still excluding wildly
    // different entries (the spec's own example: a $900k/$5,000 trade
    // clearly should not count toward a $90k/$400 current entry).
    comparableEntryBandMultiplier: Number(process.env.EDPI_LIVE_COMPARABLE_ENTRY_BAND_MULTIPLIER || 3),
  },

  // EDPI wallet population + position-lifecycle reconstruction. The
  // population is the production EDPI-L C1/C2/C4 input and the shared
  // historical-position foundation for the research/shadow CTO path. It
  // remains separate from edpiLive.js's older score-free campaign model.
  edpiPositionLifecycle: {
    // How many of a token's raw (unfiltered) top holders to rank before
    // excluding infrastructure — see edpiWalletSelection.js's header for
    // why this has to happen BEFORE, not after, the LP/pool exclusion.
    topHolderCount: Number(process.env.EDPI_POSITION_TOP_HOLDER_COUNT || 20),
    // A reconstructed position only counts toward the historical outcome
    // profile if its total buy-in reaches this SOL floor — reusing
    // earlyWalletBackfill.minSol (the ALREADY-established "meaningful
    // trade" floor early_wallet_activity itself is captured/stamped
    // with; see that block's comment and schema.sql's is_meaningful
    // column), not a new invented number. This is specifically the
    // anti-farming guard from the spec's section 16: a repeated
    // buy-$20/sell-$20 wash pattern falls under this floor and never
    // becomes a "completed meaningful position," however cleanly it
    // reconstructs at the pure trade-accounting layer.
    minPositionSolAmount: Number(process.env.EDPI_POSITION_MIN_SOL_AMOUNT || 0.5),
    // Cumulative sold/bought fraction (by TOKEN QUANTITY, not USD — see
    // positionLifecycle.js's reconstructPositions) at which a position is
    // considered exited. 40% is the spec's own explicit research value,
    // not derived from data — see docs/edpi-position-lifecycle.md if this
    // ever needs revisiting against real outcomes.
    majorExitFraction: Number(process.env.EDPI_POSITION_MAJOR_EXIT_FRACTION || 0.4),
    // A buyback (a new position opened via a buy AFTER a prior major
    // exit on the same pair) must be held at least this long before its
    // major exit to qualify as a completed meaningful buyback — the
    // spec's explicit research value (3 hours), meant to reduce the
    // influence of short-lived/farmed cycles specifically on buybacks
    // (the ORIGINAL, non-buyback position has no such holding-period
    // gate — see positionLifecycle.js's header for why that asymmetry is
    // intentional, not an oversight).
    buybackMinHoldingMs: Number(process.env.EDPI_POSITION_BUYBACK_MIN_HOLDING_MS || 3 * 60 * 60 * 1000),
  },

  // Production EDPI-L scoring. The model is versioned independently from
  // the older score-free evidence collectors so historical evaluations remain
  // reproducible when implementation details change.
  edpiL: {
    enabled: process.env.EDPI_L_ENABLED !== 'false',
    scoringVersion: process.env.EDPI_L_SCORING_VERSION || 'edpi-l-scoring-v1',
    strengthVersion: process.env.EDPI_L_STRENGTH_VERSION || 'edpi-l-strength-v1',
    geminiContextEnabled: process.env.EDPI_L_GEMINI_CONTEXT_ENABLED === 'true',
  },

  // EDPI CTO convergence evidence (research/shadow-only). This is deliberately
  // separate from general behavioral convergence: it groups by exact historical
  // token identity and is persisted only as evidence, never as a production
  // decision input. Disabled by default so enabling the subsystem is an explicit
  // research choice after archive/backfill coverage has been reviewed.
  edpiCTO: {
    enabled: process.env.EDPI_CTO_ENABLED === 'true',
    topHolderCount: 5,
  },

  // EDPI behavioral-pattern measurements used by production EDPI-L C1/C2/C4
  // and the separate research/reporting paths. Built ON TOP of
  // edpiPositionLifecycle above: every baseline here is
  // sourced from completed_meaningful POSITIONS (positionLifecycle.js/
  // walletOutcomeProfile.js), not the older campaign-based baseline
  // edpiLive.js's own Family 5 still uses — see that doc for why both
  // exist side by side rather than one replacing the other.
  edpiBehavioralPatterns: {
    // Reuses edpiLive.walletBaselineMinSampleSize's own reasoning
    // exactly (a median/percentile from 1-2 positions is just noise) —
    // kept as its own separate value rather than importing edpiLive's
    // because position-lifecycle data has different availability
    // characteristics (fewer, more precisely-scoped data points per
    // wallet) and may need its own floor once real data is reviewed.
    minSampleSize: validatedNumberEnv('EDPI_BEHAVIORAL_MIN_SAMPLE_SIZE', 3, { minInclusive: 1, integer: true }),
    // How many of a wallet's most-recent completed positions count as
    // "recent" for the recent-vs-established regime comparison (spec's
    // "behavioral-regime analysis" section) — an explicit, tunable
    // research parameter per the spec's own "do not invent arbitrary
    // production thresholds" instruction, not a validated cutover point.
    recentPositionCount: Number(process.env.EDPI_BEHAVIORAL_RECENT_POSITION_COUNT || 5),
    // A regime-deviation ratio (current-vs-own-historical-median) at or
    // beyond this multiple (or at or below its reciprocal) is what
    // `evaluateWalletBehavioralProfile` calls "deviation flagged" for
    // cross-wallet prevalence counting (spec section 12's "number
    // exhibiting the pattern"). Same kind of explicit, documented,
    // easy-to-change multiplier as edpiLive.comparableEntryBandMultiplier
    // just above — not a validated threshold, a research starting point.
    deviationRatioMultiplier: validatedNumberEnv('EDPI_BEHAVIORAL_DEVIATION_RATIO_MULTIPLIER', 2, { minExclusive: 1 }),
    // "Short duration" for the repeated-short-duration-loss pattern —
    // reuses the SAME 3-hour research value as the buyback holding-period
    // gate above for consistency, not because the two concepts are the
    // same thing (a short HOLD isn't automatically a buyback), just
    // because both are "was this quick" judgments and one already-chosen
    // research number is better than two independently-guessed ones.
    shortDurationMs: validatedNumberEnv('EDPI_BEHAVIORAL_SHORT_DURATION_MS', 3 * 60 * 60 * 1000, { minExclusive: 0 }),
    // Coefficient of variation (stddev/mean, here approximated as
    // IQR/median for robustness against the small samples this feature
    // will usually have) AT OR BELOW this value is what counts as
    // "repeated similar-sized entries" — low dispersion means the
    // wallet's position sizes cluster tightly. Explicit research
    // parameter, not derived from real data yet.
    similarSizeDispersionMax: Number(process.env.EDPI_BEHAVIORAL_SIMILAR_SIZE_DISPERSION_MAX || 0.3),
    // How many of a wallet's most recent completed positions to look at
    // for the "proportion ending in loss" and "consecutive loss streak"
    // measurements — deliberately the SAME window as recentPositionCount
    // above rather than a third independent number.
  },

  // "Social Score" — a second, ADDITIONAL score alongside the existing
  // Hype Score/Risk Level, built from social-attention signals.
  // Deliberately informational/display-only: it is NEVER read by
  // scoring.js's classifyRisk or filters.js's qualification gates, and it
  // never changes which tokens get tracked or alerted — see
  // src/services/socialSignals.js's own header comment for why that
  // boundary matters and must stay that way.
  //
  // OFF by default (SOCIAL_SIGNALS_ENABLED=false) — purely additive.
  // All five sources are real data sources now:
  //   - Reddit: real, via Reddit's public read-only JSON endpoints (no API
  //     key needed) — src/services/redditService.js.
  //   - Trading-volume velocity: real, computed from data the scanner
  //     already has (volume1h vs. age-in-minutes) — no external call.
  //   - Twitter/X: real, via @the-convocation/twitter-scraper — logs in
  //     as a real X account — src/services/twitterScraperService.js.
  //   - Telegram: real, via teleproto's MTProto user-account API — needs
  //     its own one-time session setup, see that file's header comment —
  //     src/services/telegramScraperService.js.
  //   - Google Trends: real, via google-trends-api, no account needed —
  //     src/services/googleTrendsService.js.
  // Every source fails closed (`{ available: false, ... }`) on any error,
  // rate limit, or missing credential, already folded into the weighted
  // score correctly when unavailable — see SCRAPERS.md for the original
  // implementation guide these were all built from.
  socialSignals: {
    enabled: process.env.SOCIAL_SIGNALS_ENABLED === 'true', // OFF by default — purely additive feature

    // Weights feed a single weighted 0-10 composite; see
    // socialSignals.js's getSocialSignals for how weights renormalize
    // across only the sources that actually produced a reading this
    // cycle, so a disabled/unavailable source never silently drags the
    // combined score toward 0. Defaults sum to 1.0 but don't need to —
    // renormalization makes the absolute scale irrelevant, only the
    // relative proportions matter.
    weights: {
      twitter: Number(process.env.SOCIAL_WEIGHT_TWITTER || 0.30),
      telegram: Number(process.env.SOCIAL_WEIGHT_TELEGRAM || 0.20),
      googleTrends: Number(process.env.SOCIAL_WEIGHT_GOOGLE_TRENDS || 0.15),
      reddit: Number(process.env.SOCIAL_WEIGHT_REDDIT || 0.15),
      volumeGrowth: Number(process.env.SOCIAL_WEIGHT_VOLUME_GROWTH || 0.20),
    },

    reddit: {
      enabled: process.env.SOCIAL_REDDIT_ENABLED === 'true',
      subreddits: (process.env.SOCIAL_REDDIT_SUBREDDITS || 'solana,CryptoMoonShots,SolanaMemeCoins').split(',').map((s) => s.trim()),
      timeoutMs: Number(process.env.SOCIAL_REDDIT_TIMEOUT_MS || 8000),
    },

    // Real implementation via @the-convocation/twitter-scraper — see
    // src/services/twitterScraperService.js. Needs a real X account's
    // credentials (throwaway account recommended — see that file's header
    // comment on ban risk). Two auth paths, tried in this order:
    //   1. cookiesJson, if set (lower ban risk — no login challenge/2FA
    //      flow to trip on every fresh session). Export cookies from a
    //      logged-in browser session as a JSON array and put them here.
    //   2. username/password (+ optional email/twoFactorSecret) if cookie
    //      auth isn't configured or the cookies have expired.
    twitter: {
      enabled: process.env.SOCIAL_TWITTER_ENABLED === 'true',
      username: process.env.TWITTER_USERNAME,
      password: process.env.TWITTER_PASSWORD,
      // Only needed if X challenges the login with an email-verification
      // step, which happens more often for newer/less-established accounts.
      email: process.env.TWITTER_EMAIL,
      // Only needed if the account has TOTP-based 2FA enabled.
      twoFactorSecret: process.env.TWITTER_TOTP_SECRET,
      // Optional: JSON array of cookie objects exported from a logged-in
      // browser session, e.g. via a browser extension like "Cookie-Editor".
      cookiesJson: process.env.TWITTER_COOKIES_JSON,
    },

    // Real implementation via teleproto (MTProto user-account API) — see
    // src/services/telegramScraperService.js and
    // scripts/telegram-session-login.js for the one-time setup step.
    // `channels` is the list of public channel usernames checked on every
    // lookup; apiId/apiHash come from https://my.telegram.org,
    // sessionString from running the login script once.
    telegram: {
      enabled: process.env.SOCIAL_TELEGRAM_ENABLED === 'true',
      channels: (process.env.SOCIAL_TELEGRAM_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean),
      apiId: Number(process.env.TELEGRAM_API_ID) || undefined,
      apiHash: process.env.TELEGRAM_API_HASH,
      sessionString: process.env.TELEGRAM_SESSION_STRING,
    },

    // Real implementation via google-trends-api — see
    // src/services/googleTrendsService.js for why this source is a poor
    // fit for tokens that just launched, even once it's working correctly.
    googleTrends: {
      enabled: process.env.SOCIAL_GOOGLE_TRENDS_ENABLED === 'true',
      // How far back interestOverTime() looks. Kept short and
      // configurable rather than the library's own multi-year default —
      // this bot cares about current interest for a token that may be
      // minutes old, not a multi-year history.
      windowMinutes: Number(process.env.SOCIAL_GOOGLE_TRENDS_WINDOW_MINUTES || 240),
    },
  },
};
