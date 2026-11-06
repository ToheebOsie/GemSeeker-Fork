# Gem Seeker — Model-Focused Fork

Telegram bot that scans Solana DEX launches every 30s, filters them by
age-tiered volume/liquidity thresholds, a market-cap-to-volume sanity check,
and a Rugcheck risk score, computes a 0-10 hype score, generates a
plain-language BUY/WAIT/SKIP signal with Gemini, and alerts subscribers.
Subscriptions are verified on-chain against a Solana wallet address.

## Setup

```bash
npm install
cp .env.example .env
# fill in .env — see comments in that file for where each value comes from,
# including DATABASE_URL
npm start
```

The schema is created automatically on first run. If you're upgrading from
an earlier JSON-file version of this bot with existing data, see
[Storage](#storage) below before starting.

### Required accounts / keys

| Variable | Where to get it |
| --- | --- |
| `DATABASE_URL` | A Postgres connection string, e.g. `postgres://user:pass@host:5432/dbname`. Any managed Postgres works (Railway, Render, Supabase, RDS); a local install works too for development. |
| `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather) on Telegram, `/newbot` |
| `GEMINI_API_KEY` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| `RUGCHECK_API_KEY` | [rugcheck.xyz](https://rugcheck.xyz) dashboard → API (optional for light use, needed at higher volume) |
| `SOLANA_RPC_URL` | A dedicated RPC provider — **do not use the public endpoint in production**, it will rate-limit you. Helius, QuickNode, and Alchemy all have free tiers. |
| `PAYMENT_WALLET_ADDRESS` | Your public Solana wallet address that receives subscription payments. Only the public address is needed — never put a private key in this project. |

If you have existing data in `data/*.json` from before the Postgres
migration, run `npm run migrate` once (after setting `DATABASE_URL`) to
copy it over — see [Storage](#storage) below.

> **Security note:** an earlier version of this project's `.env` (with live
> keys) was shared in chat while debugging. Treat those Telegram, Gemini, and
> Rugcheck keys as compromised and regenerate all three before going live.

## Project layout

```
src/
  config.js                     ALL tunable thresholds live here — start here to customize
  index.js                      entry point
  core/
    tokenScanner.js             the 30s discovery → filter → score → AI loop
    filters.js                  age-tiered market filters, mc/volume sanity check, safety gates
    scoring.js                  hype score + risk classification
    narrativeClassifier.js      keyword-based "what kind of meme is this" tagging
    descriptionClassifier.js    fallback for narrativeClassifier misses — description/name similarity clustering, see below
    alertPolicy.js               isAlertable() — CLASS_ALERTS/VERDICT_ALERTS broadcast filter, see below
    patternAnalyzer.js          pure stats: buckets hype score, aggregates archive into predictions
    patternReviewer.js          the 3-hourly job — re-checks tracked tokens, archives completed ones
	    featureExtraction.js        pure stats: derives price/holder/LP/buy trend from a token's snapshot history
	    highRoiPatternRule.js       shadow-only winner-pattern rubric and current-state gate
	    marketStateEngine.js        hourly-tick job — aggregates featureExtraction.js output + archive into daily per-narrative state
    observationEngine.js        on-by-default alert-delay for Medium/High-risk tokens before they alert — see below
    priceFormat.js               fmtPrice() — fixed-decimal USD price display, never scientific notation
    selfAssessment.js            pure stats: aggregates the archive into BUY/WAIT/SKIP ROI stats
    reportScheduler.js           hourly-tick job — sends daily/weekly self-assessment reports to admins
  services/
    dexscreenerService.js       token/pair discovery
    rugcheckService.js          safety audit lookups
    gemini_signal_generator.js  AI signal generation + BUY/WAIT/SKIP label extraction
    solanaService.js            on-chain payment verification
    priceService.js             SOL/USD lookup (for pricing SOL payments)
    socialSignals.js            optional "Social Score" aggregator (off by default) — see SCRAPERS.md
    redditService.js            real Reddit mention-counting (no API key needed)
    twitterScraperService.js    real Twitter/X mention-counting — logs in as a real account, see security note below
    telegramScraperService.js   real Telegram mention-counting (MTProto user-account API, needs one-time session setup, see security note below)
    googleTrendsService.js      real Google Trends interest scoring (no account needed, but a poor fit for brand-new tokens — see that file)
    fixedWindowWalletProviders.js Helius → Birdeye → Hellomoon bounded wallet-activity adapters
    fixedWindowWalletCollector.js cutoff-safe fixed-window aggregation and transactional persistence
    platformTimingCollector.js   launch-platform normalization, UTC timing, and prior-platform activity features
  bot/
    telegramBot.js              commands + alert broadcasting + admin bypass/commands
    alertFormatter.js           message formatting
    reportFormatter.js          self-assessment report message formatting
    narrativeFormatter.js       /narratives + /narrativeevolution message formatting
    marketStateFormatter.js     /insights + /insightshistory message formatting
  db/
    pool.js                      Postgres connection pool (+ BIGINT/NUMERIC type-parser fix)
    schema.sql                   table definitions
    schema.js                    ensureSchema() — applies base and fixed-window schemas on startup
  storage/
    subscriberStore.js          Postgres-backed subscriber persistence
    tokenPatternStore.js        Postgres-backed tracked-tokens + permanent pattern archive
    reportStateStore.js         Postgres-backed store of when reports were last sent
    marketStateStore.js         Postgres-backed store of daily per-narrative aggregates
	```

## High-ROI pattern shadow fork

This fork preserves the existing discovery, Rugcheck, scoring, Gemini, tracking, archive, and Telegram rules. It adds the established high-ROI winner fingerprint as a transparent shadow-only rule. The rule is attached to immutable `liveEvidence` during qualification and cannot change qualification, risk, signal, tracking, or broadcast behavior.

## Model-focused collection boundary

This standalone fork adds a hard pre-Gemini Tier-1 admission boundary. It records cheap discovery and first-safety evidence for every candidate, then collects wallet, EDPI, CTO, canonical activity, social, Gemini, alert-decision, and tracking data only for candidates that meet the configurable pre-enrichment fingerprint threshold. Non-admitted candidates are short-circuited by default. See [`docs/model-focused-fork.md`](docs/model-focused-fork.md) and [`docs/feature-utility-and-tier-gating.md`](docs/feature-utility-and-tier-gating.md).

The exact thresholds and the prospective evaluation protocol are documented in [`docs/high-roi-pattern-shadow.md`](docs/high-roi-pattern-shadow.md). The feature is enabled by default and can be disabled with `HIGH_ROI_PATTERN_SHADOW_ENABLED=false`. It is intentionally fail-closed when current holder, activity, LP, or adverse-state evidence is missing.

The fixed-window storage contract for wallet, platform, timing, provider-fallback, and leakage-safe feature capture is documented in [`docs/fixed-window-feature-storage-contract.md`](docs/fixed-window-feature-storage-contract.md), with the active additive schema at [`src/db/fixed_window_feature_schema.sql`](src/db/fixed_window_feature_schema.sql). Startup applies these tables after the base schema. Set `HELIUS_API_KEY` for the primary collector, `BIRDEYE_API_KEY` for the first fallback, and `HELLOMOON_API_KEY` for the secondary fallback. Capture is invoked only after the model-focused Tier-1 gate passes. Platform activity counts are computed from prior `discovery_events` only, excluding the current pair and all future rows.

The platform and timing feature details are documented in [`docs/platform-timing-feature-collector.md`](docs/platform-timing-feature-collector.md).

The Tier-2 8-point fixed-window scoring engine is documented in [`docs/tier2-scoring-engine.md`](docs/tier2-scoring-engine.md). Its default result is shadow-only and is persisted for research evaluation; it does not change live alert decisions.

## Pattern tracking — historical ROI / rug-time prediction

Every token that qualifies for an alert gets enrolled into ongoing tracking
if **either**: it's classified `riskLevel: 'Low'`, **or** its AI signal came
back `WAIT` or `BUY` — regardless of risk level. WAIT/BUY already mean
"worth watching or acting on," so tracking isn't limited to Low-risk only;
a Medium/High-risk token that gets a WAIT or BUY still has its outcome
recorded. (Only a `SKIP`-labeled token outside `riskLevel: 'Low'` is not
tracked — see `patternTracking.trackRiskLevels` and `tokenScanner.js`'s
`shouldTrack`.)
Every `patternTracking.reviewIntervalMs`
(default 3 hours) — or `patternTracking.earlyLifeReviewIntervalMs` (default
15 minutes) for tokens younger than `patternTracking.earlyLifeWindowMs`
(default 3h) since qualification, see "Early-life review cadence" below —
`patternReviewer.js` re-checks each due tracked token's price and Rugcheck
data, updates its recorded all-time-high, and either keeps tracking it or
archives it into a permanent historical dataset:

- **Archived as `'rugged'`** once price falls to `patternTracking.rugThresholdPctOfAth`
  (default 1%) of its recorded ATH — removed from active tracking, but its
  full lifecycle (peak ROI, time from peak to rug, top-holder % and LP-lock %
  trend from first checkpoint to last) is kept permanently in the
  `pattern_archive` Postgres table.
- **Archived as `'survived'`**, via either of two paths:
  - **Fast path (primary):** price has held at or above
    `patternTracking.survivedThreshold.minPctOfAth` (default 50%) of its
    recorded ATH for an unbroken `patternTracking.survivedThreshold.sustainedHours`
    (default 72h) — a dip below the threshold resets the clock. Resolves in
    days for a token that's genuinely holding value, rather than requiring
    it to sit in active tracking for weeks.
  - **Fallback (safety valve):** `patternTracking.maxTrackingAgeMs` (default
    30 days) passes without rugging *and* without ever satisfying the fast
    path above — catches a token that trades sideways in between the two
    bands indefinitely, so it doesn't stay in the active list forever or get
    mislabeled as "rugged" just because we stopped watching it.

Every *new* qualifying token gets classified into a `narrative:hype-bucket`
category (e.g. `dog-themed:strong-hype`) and matched against the archive —
if there are at least `patternTracking.minSampleSizeForPrediction` (default
5) completed tokens in that same category, the alert includes a line like:

```
📊 Historical pattern (Dog Meme, 8 past tokens tracked): peak ROI ~3.2x
median, rugged ~14.5h after peak (median). Past behavior of similar
tokens, not a prediction for this one.
```

Separately, every new qualifying token is also matched individually against
the archive via `narrativeIntelligence.js`'s `findSimilarHistoricalTokens` —
the closest past archived tokens in the same narrative, scored by how close
their hype score and risk level were at qualification time. Unlike the
aggregate prediction above, this doesn't need a minimum sample size (each
row is its own match, not a statistic), so it appears as soon as at least
one match exists:

```
📚 Historical Matches
• DOGE2 (87% similar) — peaked 3.2x in 6.5h, rugged
• SHIB99 (74% similar) — peaked 1.8x in 30.0h, survived
```

`patternTracking.historicalMatchLimit` (default 3) controls how many rows
are shown.

### Early-life review cadence

`enrollToken` (qualification time) never writes a `snapshots` row — only
`reviewToken` does, on its review cadence. At the un-tiered `reviewIntervalMs`
(3h default) this used to mean: a token that rugs before its very first
review tick has **zero** snapshot rows, ever, regardless of how good its
enrollment-time Rugcheck data was. That's not a data-quality problem,
it's a review-timing gap — and for a fast-rugging memecoin, hitting it is
the common case, not the edge case. `patternAnalyzer.js`'s
`classifyRugMechanism` (see "Rug mechanism classification" below) can't
tell "we looked and saw nothing move" from "we never got to look at all"
without knowing this.

A token younger than `patternTracking.earlyLifeWindowMs` (default 3h,
since `qualifiedAt`) is reviewed on the faster
`patternTracking.earlyLifeReviewIntervalMs` (default 15 min) instead of
`reviewIntervalMs` — so more tokens survive to at least one real,
independently-fetched Rugcheck observation before they might archive.
Tokens past that age fall back to the normal `reviewIntervalMs` cadence,
completely unchanged — this only adds load for the (much smaller)
young-token population, not the whole tracked set. Mechanically:
`tracked_tokens.last_reviewed_at` (`NULL` until a token's first real
review) tracks per-token due-ness; `reviewAllTrackedTokens` filters to
only the tokens actually due on their own cadence *before* resolving
pairs, so the DexScreener/Rugcheck load on the older-token population is
identical to what it was before this existed — only young tokens get
checked more often. `startPatternReviewLoop`'s own tick runs on
`Math.min(reviewIntervalMs, earlyLifeReviewIntervalMs)` so young tokens
actually get woken up on time.

`reviewToken` itself is unchanged — every call still does a fresh,
independent Rugcheck fetch, exactly as before; only *how often* it's
called for young tokens changed, not what it does. No bootstrap/synthetic
snapshot is ever written at enrollment — doing so would risk a token with
exactly one real observation reading as `delta = 0` (`'flat'`) against
itself, fabricating a false `'organic-death'` (implying "we watched this
and nothing moved") instead of the honest "we only ever took one
reading." `getLastKnownSafetyReading` only ever sees genuinely distinct,
independently-fetched observations, by construction.

The defaults (3h / 15 min) are a starting point, not backtested against a
real time-to-rug distribution — worth tuning once one's available (see
`HANDOFF.md`). Both are configurable via `PATTERN_EARLY_LIFE_WINDOW_MS`
and `PATTERN_EARLY_LIFE_REVIEW_INTERVAL_MS`.

### Rug mechanism classification

Every archived `'rugged'` record also gets a `rugMechanism` tag from
`patternAnalyzer.js`'s `classifyRugMechanism` — *why* it rugged, not just
*when* (that's `outcomeDetail`'s separate rug-timing bucket; the two are
orthogonal and a record carries both). Computed from
`firstLpLockedPct`/`lastLpLockedPct` and `firstTopHolderPct`/
`lastTopHolderPct` (the latter via `getLastKnownSafetyReading` — each
field's own last non-null snapshot reading independently, not just the
literal most recent row, so one failed Rugcheck call on the archiving
cycle itself can't erase an otherwise-solid tracked history):

- **`liquidity-pull-rug`** — LP-locked % dropped meaningfully (checked
  first: the more direct, more deliberate signal).
- **`distribution-dump-rug`** — LP stayed locked, but top-holder %
  dropped meaningfully instead.
- **`mint-authority-rug`** / **`freeze-authority-rug`** — neither of the
  two above triggered, but the token's mint/freeze authority was held
  (not renounced) at some point during tracking — item 5 from the
  AI-training-pipeline proposal audit (see `HANDOFF.md`). Checked AFTER
  `liquidity-pull-rug`/`distribution-dump-rug` (directly-observed
  behavior still wins when present) but BEFORE `organic-death`/
  `unknown-mechanism-*` below — a mint-then-dump or freeze-then-drain
  doesn't necessarily show up as classic LP-unlock or top-holder-
  concentration movement, so without this check those cases would
  silently read as "no idea why it rugged" despite a real, known
  explanation being available. `firstXHeld`/`lastXHeld` combined with
  OR: SPL authority revocation is one-way and permanent (held→revoked
  possible, revoked→held never is), so a `true` reading at EITHER
  checkpoint is equally valid evidence, and a token whose first reading
  failed can still get credit from a later one. No backfill possible for
  rows archived before this shipped — the data was simply never fetched
  for them, unlike `rug_mechanism_confidence`, which was recomputable
  from data already on disk.
- **`organic-death`** — both signals were genuinely captured, neither
  moved. The only label that claims "we checked both and confirmed
  nothing."
- **`partial-unknown`** — one signal known and flat, the other never
  captured at all. Deliberately distinct from `organic-death` so it
  doesn't overstate how much was actually verified. **This was the
  dominant rug-mechanism outcome in practice — 86% of archived rugs** —
  traced back to a real parsing bug (`extractSafetySignals` read a
  Rugcheck field that never existed, so `lpLockedPct` was `null` on
  every call), not genuine data unavailability. See item 18 in "Known/
  fixed issues" below; the fix is forward-looking only; the already-
  archived `partial-unknown` rows can't be recovered.
- **`unknown-mechanism-no-review`** — zero snapshot rows exist for this
  token at all; it archived before its first review tick ever ran. A
  *timing* gap — see "Early-life review cadence" above, which exists
  specifically to shrink this bucket over time.
- **`unknown-mechanism-data-gap`** — reviewed at least once, but Rugcheck
  never returned a usable reading for either field, any time it was
  checked. A genuine *data* gap, not a timing one — reviewing sooner
  wouldn't have fixed this case.
- **`unknown-mechanism-no-checkpoint-data`** — `checkpointCount` itself
  is unknown (not 0, not ≥1 — genuinely not known), so neither of the
  two labels above is honestly supportable. Only reachable via
  `scripts/migrate.js`'s one-time legacy-JSON migration, for archive
  records that predate `checkpointCount` existing as a tracked concept
  at all — a small, bounded, non-growing population, not an ongoing one.

`null` for `'survived'` records — the question doesn't apply to a token
that never crossed the rug threshold. `/report`'s self-assessment surfaces
this as a "Rug cause" breakdown line per group (`reportFormatter.js`'s
`formatRugMechanismLine`).

#### Confidence + evidence (Plan B)

`rugMechanism` alone doesn't say how much was actually *verified* —
`organic-death` and `unknown-mechanism-data-gap` are both "neither
signal moved," but one watched both signals and the other never saw
either. `patternAnalyzer.js`'s `classifyRugMechanismDetail` wraps
`classifyRugMechanism` (same function, called once — the label itself
never changes shape, still a bare string, so nothing that already
asserts against it needed touching) and adds two more fields, stored on
the archive record as `rugMechanismConfidence`/`rugMechanismEvidence`:

- **`confidence`** — `'HIGH'` (a real signal genuinely captured:
  `liquidity-pull-rug`, `distribution-dump-rug`, `organic-death` from
  two independently captured behavioral readings; `mint-authority-rug`/
  `freeze-authority-rug` from a direct, unambiguous on-chain fact rather
  than an inference — same HIGH tier), `'MEDIUM'` (`partial-unknown` —
  only one signal ever captured), `'NONE'` (any of the three
  `unknown-mechanism-*` labels — neither signal captured, for any
  reason), or `null` (`'survived'` — the question doesn't apply).
- **`evidence`** — `{ lpLockedPctDelta, topHolderPctDelta, checkpointCount,
  firstMintAuthorityHeld, lastMintAuthorityHeld, firstFreezeAuthorityHeld,
  lastFreezeAuthorityHeld }`. The first three are the exact raw numbers
  that decided the label, recomputed via the same pure `delta()`
  function `classifyRugMechanism` itself used internally (not a second,
  potentially-divergent calculation — same inputs, same function, so it
  can't disagree). The four authority fields are raw readings, not a
  derived delta (that doesn't make sense for a one-way boolean the way
  it does for a percentage) — `null` when never captured (any row
  archived before this shipped), not `undefined` leaking into the JSONB
  column.

`npm run backfill-rug-mechanism-confidence` fills these in for every
existing `'rugged'` row — a pure recompute from data already stored
(`checkpoint_count` and the four `first`/`last*Pct` columns), no new
data needed.

### Wallet clustering (Tier 1)

Every qualifying token also has its top-holder *wallets* (not just the
aggregate max %) persisted to a standalone `token_holders` table, via
`rugcheckService.js`'s `extractTopHolderWallets` — pulled from the same
Rugcheck `/report` call already made for the safety gate, so this costs no
extra API call and needs no new vendor/infrastructure. If a wallet shows up
as a top holder on `walletClustering.minTokenCountForAlert` (default 2) or
more separate token launches, the alert includes:

```
🔗 Top holder also seen on other tokens: GpMZ…3kXo (3 tokens)
```

This is deliberately an *observation*, not an accusation — a wallet can
legitimately hold a stake in several unrelated tokens. It's a starting
signal, not proof of coordination. `token_holders` is intentionally never
cascade-deleted when a token archives (unlike `snapshots`) — the entire
point is spotting a wallet that recurs across *different* launches over
time, which only works if each launch's holder snapshot survives that
launch being archived. See `src/db/schema.sql`'s comment on the table and
`tokenPatternStore.js`'s `getRecurringWalletsAmong`/`getWalletHistory`.
Set `WALLET_CLUSTERING_ENABLED=false` to turn this off without a code
change.

**What this is NOT:** real wallet-activity/timing-based clustering
(early-buyer, sniper, or insider-network detection from actual
transaction history) — that needs per-transaction on-chain data (e.g. a
Helius webhook feed), which is a genuinely new always-on ingestion path
and a new cost line, not implemented here. This Tier 1 version only
answers "has this exact wallet been a top holder before," from data the
bot already had. See "Early-wallet backfill (item 29, Stage 1)" just
below for the retroactive, backfill-only version of the real thing.

### Early-wallet backfill (item 29, Stage 1)

`scripts/backfill-early-wallets.js` — a one-off backfill, not a live
scan-path feature — reconstructs who actually bought/sold each archived
token in its **narrow launch window**: `pair_created_at` (the pool's
real on-chain birth time, from `backfill-pair-created-at.js` — see the
"One-off backfill scripts" list in Storage below, which needs to have
been run first) through `pair_created_at + --window-minutes` (default
30). Unlike the Tier 1 clustering above, this reads real on-chain
transaction history via `getSignaturesForAddress`/`getParsedTransaction`
— the thing the Tier 1 note above says isn't implemented as a live path.
It still isn't a live path here either: this only ever runs as a
deliberate, rate-limited backfill against already-archived rows, never
inline during scanning.

```bash
npm run backfill-early-wallets -- --limit=20 --window-minutes=30 --min-sol=0.05 --sig-cap=5
```

Every buyer/seller found in the window is written to `early_wallet_activity`
(one row per wallet/signature/role), with `is_meaningful` set for buys at
or above `--min-sol` SOL. Never guesses a truncated window the way an
earlier diagnostic (`_diagnostic_early_wallet_reconstruction.js`) found
real production evidence for: a still-heavily-traded winner can need far
more than `--sig-cap` pages of signature history to walk all the way back
to its own launch, so a row that hits the cap is marked
`pattern_archive.early_wallet_status = 'truncated'` rather than silently
treated as a complete picture — see that column's comment in
`schema.sql` for the full status set. `--retry-unresolved` exists for a
deliberate re-pass at a higher `--sig-cap` on exactly those rows, same
pattern as the `pair_created_at` backfill below.

This is Stage 1 of a staged design (narrow window + SOL floor → targeted
funding-source tracing on interesting wallets only → deep profiling of
recurring clusters). Stage 2 and 3 aren't built — `getRecurringEarlyWallets`
in `tokenPatternStore.js` is the query Stage 3 will eventually need, ready
now but with nothing populating enough data yet for it to be useful. See
`HANDOFF.md`'s "Suggested next steps" for the current state, and its
"wallet-intelligence roadmap" section for the full agreed sequencing —
notably, two more stages (a wallet-performance-stats layer, then a
candidate ranking) sit between this and Stage 2, specifically so
"interesting wallet" gets defined from real data rather than guessed.

`npm run review-early-wallet-backfill` is a read-only companion report —
backlog size, `complete`/`truncated`/`error` breakdown, total signature
pages spent (the actual RPC cost this backfill has consumed so far), how
many buyers/sellers were found, and which wallets already recur across
more than one launch. Run it any time, including with zero data.

### Description-based narrative fallback

`narrativeClassifier.js`'s keyword rules miss most tokens in practice —
anything whose name/symbol doesn't contain a recognized word falls into
`'uncategorized'`. `descriptionClassifier.js` runs automatically as a
fallback, only when the rule-based classifier finds nothing, and never
overrides a real theme match:

- **With a description** (DexScreener's token-profiles data, when
  available, and not launchpad boilerplate — see below): extracts
  keywords from it and compares them, via Jaccard similarity, against
  every category already in the `description_categories` registry. A
  match at ≥70% similarity (`SIMILARITY_THRESHOLD`) joins that category;
  no match mints a brand-new one, labeled from its own top keywords (e.g.
  `desc:agent-autonomous`) — the `desc:` prefix keeps these always visibly
  distinct from a hand-curated `NARRATIVE_RULES` tag in any report.
- **Without a usable description** (DexScreener's keyword-search endpoint
  never returns one, *or* the description is boilerplate — see below):
  falls back to character-trigram similarity on the token's own
  name/symbol against the registry's representative token names, at a
  lower ≥60% threshold (`NAME_SIMILARITY_THRESHOLD` — deliberately a
  separate, lower constant from the description path's 70%, tuned against
  real near-miss production data; see "Known/fixed issues" below). Can
  only *join* an existing category this way, never mint a new one —
  there's no description text to derive a label from.
- **Boilerplate descriptions are filtered before either path runs**
  (`descriptionBoilerplateFilter.js`'s `isBoilerplateDescription`) —
  launchpad-tool credit lines ("Deployed using j7tracker.io") and vacuous
  placeholder text ("memecoin") carry no real narrative signal and are
  treated exactly like a missing description, falling through to the
  name-similarity path instead. Without this, two unrelated tokens that
  both used the same launchpad's default credit line could get
  Jaccard-matched into the same category purely because they share that
  tool's boilerplate text — a false merge, not a real narrative
  connection. The same filter also runs ahead of the Gemini-based
  historical recovery pipeline (see below) for the identical reason.

A `desc:*` category behaves like any other narrative tag for pattern
tracking, prediction, and the historical-match section of an alert. The
one thing it can't yet do is be looked up by name in `/insightshistory`
(`/insights`, the full list, shows `desc:*` rows fine) — a gap worth
closing if drilling into one turns out to matter.

**One-off backfill for pre-existing `'uncategorized'` rows:**
`descriptionClassifier.js` only runs for tokens scanned from when it
shipped forward — it can't retroactively add a description to an
already-archived row, since that text was never captured and DexScreener
has no historical-lookup endpoint for it. `scripts/backfill-description-
narrative.js` (`npm run backfill-description-narrative`) closes part of
that gap: it re-checks every `'uncategorized'` `pattern_archive`/
`tracked_tokens` row against the *current* `description_categories`
registry via the same no-description name-similarity path described
above. It can only ever join an existing category this way, never mint a
new one, so it's worth re-running periodically as the live registry
grows — an old row's name might match something today that didn't exist
when the row first archived. Idempotent: a row this script already
reclassified is skipped on the next run. Safe to run against an empty
registry (does nothing) or repeatedly against production.

```bash
DATABASE_URL=postgres://... npm run backfill-description-narrative
```

**Honest limitations, on purpose:**
- **Narrative classification is keyword matching on the name/symbol**
  (`narrativeClassifier.js`), not real NLP — anything that doesn't contain a
  recognized word falls into `'uncategorized'`. Extending it is a one-line
  addition to `NARRATIVE_RULES` in that file.
- **No prediction is shown below the minimum sample size** — an early
  deployment with little history yet will show no historical-pattern line at
  all rather than a confident-looking number built from 1-2 data points.
- **"Wallet behavior" tracking is holder-concentration and LP-lock trend**
  (top-holder % and `lpLockedPct` at each 3-hourly checkpoint) plus, as of
  the wallet-clustering feature above, "has this specific wallet been a top
  holder on other launches" — still not individual-wallet *activity*
  forensic tracking (buy/sell timing, transaction graphs). Everything
  implemented so far comes from data Rugcheck already provides; real
  transaction-level tracking would need a new on-chain data provider (see
  the wallet-clustering section's "What this is NOT").
- The prediction line is always phrased as **past behavior of other tokens**,
  never as a forecast for the specific token in the alert — this is
  deliberate, both to stay honest about what a small historical sample can
  actually tell you, and to keep this squarely in "factual information for
  you to make your own decision" territory rather than a confident
  recommendation.

#### Narrative confidence (Plan B)

`narrativeTag` alone doesn't say *how sure* the classifier was — a rule
match and a borderline description match both just look like "a tag."
Two more fields, `narrativeConfidence`/`narrativeMatchMethod`, are set
alongside `narrativeTag` wherever it's set (qualification time, carried
through unchanged to the archive record):

- **`matchedVia: 'rule'`, `confidence: 1.0`** — `narrativeClassifier.js`'s
  keyword match hit. Binary by nature (a keyword either matched or it
  didn't), so this is always exactly 1.0 whenever it applies.
- **`matchedVia: 'description'` or `'name-similarity'`, `confidence: <score>`**
  — the description fallback matched an existing category; `confidence`
  is the real Jaccard (description) or trigram (no-description,
  name-only) similarity score that decided it — see
  `classifyByDescription`'s own return value in `descriptionClassifier.js`,
  which used to compute this score and immediately discard it.
- **`confidence: null` on a freshly-minted `desc:*` category** — present
  and explicit, not silently absent: there's no existing bucket to
  report a similarity score *against* when one's just being created.
- **`null`/`null`** — neither classifier found anything at all (still
  `'uncategorized'`). Deliberate, not a bug: there's nothing to report a
  confidence *in*. **This doesn't reduce the uncategorized rate itself**
  — it's an explainability layer for tokens that already got some
  classification, not a fix for classification coverage. If cutting the
  raw uncategorized rate matters, that's separate work (e.g. expanding
  `NARRATIVE_RULES`, tuning `SIMILARITY_THRESHOLD`).

`npm run backfill-narrative-confidence` seeds these for existing rows —
honestly, not uniformly: a tag that's neither `'uncategorized'` nor
`desc:*`-prefixed can *only* have come from the rule-based classifier
(the tag value itself proves it), so those rows are fully recoverable as
`1.0`/`'rule'`. A `desc:*` tag's exact match path/score was never
persisted historically, so those rows get `matchedVia:
'unknown-pre-migration'` and `confidence` stays `null` — a label without
a fabricated number, rather than guessing.

## Tuning qualification thresholds

Every knob that controls which tokens get reported lives in **`src/config.js`**.
Nothing here needs a code change elsewhere — edit the number, save, restart
the bot. The relevant block is `scanner.thresholds` and `rugcheck`:

```js
rugcheck: {
  // Rugcheck's score is a RISK score: 0-100, HIGHER = RISKIER.
  //   0-30  = Low risk (Good)
  //   30-60 = Medium risk
  //   60-100 = High risk (Danger)
  // Token is discarded if its risk score is ABOVE this number.
  maxRiskScore: 50,        // lower = stricter (e.g. 20 = only "Good" band passes)
  maxTopHolderPct: 30,     // discard if any single holder owns more than this %
},

scanner: {
  thresholds: {
    // Discard if marketCap is more than this many times volume1h, OR
    // volume1h is more than this many times marketCap (either direction
    // is a red flag). Set to `null` to disable.
    maxMcapToVolumeRatio: 20,

    new: {          // tokens younger than 10 minutes
      minVolume1h: 1000,
      minBuys1h: 5,
      minMarketCapIfNoLiquidity: 10000,
      minLiquidity: 3000,
    },
    established: {  // tokens 10+ minutes old
      minVolume1h: 5000,
      minBuys1h: 20,
      minMarketCapIfNoLiquidity: 30000,
      minLiquidity: 10000,
    },
  },
},
```

**To make the bot stricter** (fewer, higher-confidence alerts): lower
`maxRiskScore`, lower `maxTopHolderPct`, lower `maxMcapToVolumeRatio`, raise
the `minVolume1h`/`minLiquidity` numbers.

**To make it looser** (more alerts, more risk tolerance): the reverse. Going
above `maxRiskScore: 60` starts letting Rugcheck's own "High risk / Danger"
band through — not recommended.

## Observation engine (on by default — a real product decision, not just a flag)

By default, a Medium/High-risk token no longer alerts the instant it first
passes every filter and gate. Set `OBSERVATION_ENABLED=false` to go back to
that original behavior (every risk tier alerts immediately) if you'd
rather not hold anything back. With it on, a Medium/High-risk token is
held for `OBSERVATION_WINDOW_MS` (default 3 minutes). On each subsequent
30s scan cycle, it's re-checked against the same market filters and safety
gates, fresh — not reused from when it was first seen. Only once the full
window has elapsed *and* it's still passing does it "graduate": get a
freshly-generated AI signal (not the stale one from first sight) and alert
normally.

If it fails a fresh check at any point during observation — liquidity
pulled, top-holder concentration spiked, Rugcheck's risk score jumped — or
it simply stops appearing in DexScreener's results at all (delisted), it's
dropped. **It never alerts.** That's the actual protective value: catching
a flash pump or wash-trading illusion that couldn't sustain itself for the
length of the window, at the cost of losing "first to see it" positioning
on tokens that do turn out to be real. `OBSERVATION_RISK_LEVELS` controls
which risk tiers get held (default `Medium,High` — Low is excluded, since
it's already cleared the strictest bar and has the least to gain from
added delay).

State is in-memory only, with no persistent backstop — unlike the
scanner's alert-dedup set (see the numbered fix list above), which
gained one specifically because its failure mode was a duplicate
user-facing alert. Losing observation state on restart doesn't have that
same failure mode: a restart mid-observation just restarts that token's
clock, a minutes-long non-event, not a duplicate anything. `/admin` shows
the current count under observation when this is enabled.

## Alert-broadcast filter (`CLASS_ALERTS` / `VERDICT_ALERTS`)

Two optional env vars narrow which qualified tokens actually get sent as
a Telegram message, without touching anything else in the pipeline —
tracking, archiving, pattern predictions, and market state all keep
running exactly as before for every risk class and every verdict,
regardless of these settings:

```bash
# Comma-separated, case-insensitive. Leaving both unset (the default)
# sends every class and verdict, same as always. A token must match
# BOTH lists to be sent.
CLASS_ALERTS=Low,Medium,High     # scoring.js riskLevel(s) to alert on
VERDICT_ALERTS=BUY,WAIT,SKIP     # the AI signal label(s) to alert on
```

For example, `CLASS_ALERTS=Low` with `VERDICT_ALERTS=BUY` sends only
Low-risk BUY alerts — a Low-risk WAIT or a Medium-risk BUY are both held
back from broadcast, but still fully tracked/archived as normal. A token
whose AI signal came back unparseable (no clean BUY/WAIT/SKIP line —
see `gemini_signal_generator.js`'s `extractSignalLabel`) never matches
any configured `VERDICT_ALERTS` list, the same as any other value not in
it — there's no way to configure this to alert on an unparseable signal.

This filter is applied in `index.js`, immediately before tokens are
handed to `broadcastAlerts()` — **upstream of the admin bypass**
described below, so it affects every recipient identically, admins
included. There's no separate knob to give admins an unfiltered feed;
if you want that, don't set these two env vars, or run a second bot
instance with its own `ADMIN_CHAT_IDS` and no filter configured. See
`src/core/alertPolicy.js`'s `isAlertable()` for the actual logic — a
small, single-purpose function deliberately not called from inside
`tokenScanner.js` or `broadcastAlerts()` itself, so it stays one clearly
scoped seam rather than something that could quietly start affecting
tracking if the call site ever moved.

## Admin panel & unlimited alerts

Set `ADMIN_CHAT_IDS` in `.env` to a comma-separated list of Telegram chat
IDs (get yours from `@userinfobot`, or from the chat ID the bot logs when
that person sends `/start`). Every chat ID in that list:

- **Gets every alert, unconditionally** (subject to the `CLASS_ALERTS`/
  `VERDICT_ALERTS` broadcast filter below, if configured — that filter
  runs upstream of this bypass and applies to every recipient the same
  way, admins included; see "Alert-broadcast filter" for why). Admins
  bypass the trial-count and active-subscription gating in
  `broadcastAlerts()` entirely — no free-alert limit, no expiry, and (if
  they're also a registered subscriber) their `alertsSent` count is never
  incremented. This works even for an admin chat ID that's never sent
  `/start`.
- **Unlocks six admin-only bot commands** (silently ignored for everyone
  else, so non-admins don't even see they exist):
  - `/admin` — subscriber counts (total / active paid / trial), pattern
    tracking counts (active / archived), and when the last daily/weekly
    self-assessment report went out.
  - `/report` — generates the daily + weekly self-assessment report
    on demand, without waiting for the schedule below.
  - `/exportdaily` — sends an admin-only NDJSON download of analytical and
    operational records from the preceding 24 hours.
  - `/exportweekly` — sends an admin-only NDJSON download of analytical and
    operational records from the preceding 7 days.
  - `/narratives` — narrative heat (last 7 days) and rotation vs. the prior
    7 days, computed entirely from this bot's own qualification history.
  - `/narrativeevolution` — average peak ROI per narrative, week by week,
    plus a monthly top-10 leaderboard. Archive-only (needs completed
    lifecycles), so a fresh deployment shows "not enough resolved tokens
    yet" until some tokens finish tracking.
  - `/insights` — today's per-narrative market state: currently-tracked
    tokens' top-holder/buy-acceleration trends, plus today's archived
    rugged/survived counts and average peak ROI. See "Market state engine"
    below for the full shape.
  - `/insightshistory <narrative>` — one narrative's full day-by-day
    history from the same table `/insights` reads, oldest to newest
    (capped to the most recent 14 days per message). Accepts either the
    internal tag or the display label, case/whitespace-insensitive (e.g.
    `/insightshistory dog meme` and `/insightshistory dog-themed` both
    work); with no argument, or an unrecognized one, it replies with the
    full list of valid narratives instead of staying silent.

There's no separate web dashboard — "admin panel" here means these
Telegram-native admin commands plus the env-configured access list, which
fits how this bot is deployed (no existing web frontend to attach one to).

For a single Railway service, use `node src/index.js`. The main process owns Telegram polling and embeds the PostgreSQL outbox consumers, research workers, notification dispatcher, reporting scheduler, and market-state scheduler. The separate worker entrypoints remain available for deployments that require independent scaling, but they should not be run alongside the embedded equivalents in the same environment.

## Admin database exports

`/exportdaily` and `/exportweekly` are Telegram-native, admin-only downloads of recent PostgreSQL records. The daily command covers the preceding 24 hours and the weekly command covers the preceding 7 days, using UTC half-open windows. Each export is an NDJSON document with a manifest line followed by typed table records.

The export includes alert decisions, observations, analytical evaluations, delivery audits, notification and research jobs, outbox events, tracked tokens, archived tokens, and market snapshots. It does not include environment secrets, local files, or database credentials. Subscriber/payment identity records and ML-training tables are intentionally excluded from this first operational export surface. Exports are on demand; they are not an automatic daily or weekly scheduler.

## Self-assessment reports (BUY vs WAIT average ROI)

Once a day and once a week, the bot reviews its own pattern-tracking
archive (the `pattern_archive` Postgres table — see below) and sends every admin a
report of the average and median peak ROI actually achieved by tokens it
labeled **BUY** vs **WAIT** vs **SKIP**, plus how many rugged vs survived.

How it works:

- `gemini_signal_generator.js`'s `extractSignalLabel()` pulls a structured
  `BUY`/`WAIT`/`SKIP` label out of the free-text AI signal at the moment a
  token qualifies, and it's stored on the pattern-tracking record
  (`signalLabel`) alongside the narrative tag and hype score already
  tracked there.
- When `patternReviewer.js` later archives that token (rugged or
  survived — see the Pattern tracking section above), the label is carried
  through onto the permanent archive record, next to its `peakRoiMultiple`.
- `core/selfAssessment.js` aggregates the archive by label within a time
  window (last 24h for daily, last 7d for weekly), based on `archivedAt`
  (when the outcome was determined, not when it was first alerted).
- `core/reportScheduler.js` wakes up hourly (`REPORT_CHECK_INTERVAL_MS`,
  default 1h — the check interval, not the report interval), checks
  the `report_state` Postgres table for when each report last went out, and sends
  any that are due. This is restart-safe: the table survives process
  restarts, so a report is never silently skipped or duplicated because the
  bot happened to be down at the exact moment a window elapsed.

**Scope note, worth knowing:** only tokens enrolled into pattern tracking
ever show up here — that's `Low` risk (per `patternTracking.trackRiskLevels`
in `config.js`) **or** any `WAIT`- or `BUY`-labeled token regardless of
risk level (see the Pattern tracking section above), so this report — like
the "historical pattern" line in alerts — reflects outcomes for that
tracked subset only, not every alert ever sent. A `SKIP` label on a
Medium/High-risk token is never tracked; a `SKIP` on a `Low`-risk token
still is (`SKIP`-labeled tokens can show up here if the AI signal
disagreed with the bot's own risk score).

Turn it off entirely with `REPORTS_ENABLED=false`, or just leave
`ADMIN_CHAT_IDS` empty — the scheduler no-ops if there's nobody to send to.

### Why signal_label is null (Plan A: signal_status)

A `null` `signalLabel` has exactly two possible causes
(`gemini_signal_generator.js`): the AI call itself never returned real
output — a network/API error, or an empty response, both hardcoded
fallback strings deliberately free of any BUY/WAIT/SKIP word — or it DID
return real model output, but `extractSignalLabel` found nothing
parseable anywhere in it. An infra problem vs. a prompt/formatting
problem, which imply different things to actually do about them;
`signal_label IS NULL` alone can't tell them apart. `signalStatus`
(stored alongside `signalLabel`, both on the tracked-token record and
carried through unchanged to the archive record) does:

- **`SIGNALLED`** — a real label was extracted.
- **`AI_UNAVAILABLE`** — the AI call itself never returned real output
  (`gemini_signal_generator.js`'s `isFallbackText` matched one of its own
  two literal fallback strings).
- **`AI_NO_VERDICT`** — real model output, but no parseable BUY/WAIT/SKIP
  anywhere in it.

Same honesty pattern as the other Plan A/B additions: this is an
explainability layer, not a fix that reduces how often the AI fails to
produce a clean verdict. `npm run backfill-signal-status` seeds existing
rows — it can tell `SIGNALLED` apart from "one of the other two" (a
non-null `signal_label` can only mean `SIGNALLED`), but can't
retroactively split `AI_UNAVAILABLE` from `AI_NO_VERDICT` for older rows,
since the raw AI response text that would disambiguate them was never
persisted. Those get `UNKNOWN_PRE_MIGRATION` rather than a guess.

## Market state engine (backs `/insights` and `/insightshistory`)

`core/marketStateEngine.js` wakes up hourly (`MARKET_STATE_INTERVAL_MS`,
default 1h) and recomputes today's per-narrative aggregate state, upserted
into the `market_state_daily` Postgres table (one row per date+narrative —
always a fresh "today so far" snapshot, not an accumulating counter, so a
missed tick just means a slightly stale row until the next one runs).
Two independent slices per narrative, deliberately not merged into one
score:

- **Currently tracked** — every currently-tracked token in that narrative,
  run through `core/featureExtraction.js` (price momentum, top-holder
  concentration trend, LP-lock trend, buy/sell-ratio acceleration — all
  derived from that token's snapshot history) and rolled up into
  `accumulatingPct` / `distributingPct` / `buyAcceleratingPct` /
  `buyDeceleratingPct`.
- **Archived today** — `pattern_archive` rows whose `archived_at` falls in
  today's UTC calendar day: rugged/survived counts, average peak ROI, and
  a BUY/WAIT/SKIP breakdown.

Same scope note as the self-assessment reports above applies here too:
both slices only ever cover the tracked subset, not every alert ever
sent. Two commands read this table: `/insights` shows today's UTC row
across every narrative, sorted by total activity (tracked + archived);
`/insightshistory <narrative>` shows one narrative's full day-by-day
history instead, oldest to newest (`getStateForNarrative` in
`marketStateStore.js`, capped to the most recent 14 days per message) —
see `marketStateFormatter.js` for both. Turn the engine off with
`MARKET_STATE_ENABLED=false`; unlike the report scheduler, it
isn't gated on `ADMIN_CHAT_IDS` since it doesn't send anything to anyone
on its own (both commands are pull, not push).

## Social Score (optional, off by default)

A separate, purely-additive "Social Score" line can appear on alerts,
built from social-attention signals — never read by `scoring.js`'s hype
score/risk classification, and never affects which tokens qualify or get
tracked. Off by default (`SOCIAL_SIGNALS_ENABLED=false`).

All five sources are real: Reddit and a trading-volume velocity proxy
(both computed from data the scanner already has, no account needed),
Twitter/X mention-counting via `twitterScraperService.js`, Telegram
mention-counting via `telegramScraperService.js`, and Google Trends
interest scoring via `googleTrendsService.js`. See
**[SCRAPERS.md](./SCRAPERS.md)** for the original implementation guide
all of them were built from — still useful reading if you want to swap
in a different library/approach for any one source, or add a sixth.

**Before enabling Twitter/X (`SOCIAL_TWITTER_ENABLED=true`):** unlike
Reddit, this source logs into a real X account through an unofficial
scraper library (`@the-convocation/twitter-scraper`) rather than X's paid
official API — see that file's header comment for the full reasoning.
Use a throwaway account, not your main one: unofficial scrapers carry a
real ban/suspension risk, and there's no bot-side fallback if the account
gets locked mid-cycle beyond the lookup simply failing closed (no Twitter
component that cycle, nothing else in the pipeline affected). Keep
credentials in `.env` only, never commit them, and prefer
`TWITTER_COOKIES_JSON` over a raw username/password where practical.

**Before enabling Telegram (`SOCIAL_TELEGRAM_ENABLED=true`):** this one
needs a one-time interactive setup step first, since a bot token can't
read arbitrary public channels — run
`TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node scripts/telegram-session-login.js`
once (credentials free from <https://my.telegram.org>), which prompts for
your phone/code/2FA right in the terminal and prints a
`TELEGRAM_SESSION_STRING` to put in `.env`. Same account-risk note as
Twitter/X above — consider a secondary account, and treat that session
string like a password (anyone with it can act as that account). See
`telegramScraperService.js`'s header comment for the full reasoning,
including why this uses `teleproto` rather than the more commonly-referenced
`gramjs`/`telegram` package (the latter is archived/unmaintained as of
this writing).

**Google Trends (`SOCIAL_GOOGLE_TRENDS_ENABLED=true`)** needs no account
or credentials, but is worth calibrating your expectations for: this bot
alerts on tokens minutes after launch, and Trends needs real accumulated
search volume to register anything — expect `available: false` far more
often than the other four sources even once this is on, especially at
alert time. See `googleTrendsService.js`'s header comment for why.

## Tuning the hype score itself

The point weights that build the 0-10 hype score live in
`src/core/scoring.js`, inside `computeHypeScore`. Each `score += 0.5` /
`score -= 1.5` line is independent — e.g. to make Rugcheck risk matter more
than raw volume, increase the `-2` / `-1` penalties in the "Rugcheck-derived
signals" block relative to the volume/price bonuses above them. The function
is deliberately flat and readable rather than a black box specifically so you
can do this.

## Known/fixed issues from the previous version

These were found and fixed in this pass — worth knowing if you're comparing
against an older copy:

1. **Rugcheck score direction was inverted.** Rugcheck's score is a *risk*
   score (higher = riskier), not a trust score. The old code required
   `score >= 65` to pass, which actually favored high-risk tokens and
   rejected safe ones — the direct cause of "high scores on likely rugs."
   Fixed in `rugcheckService.js` / `filters.js` / `scoring.js`; the field is
   now called `riskScore` everywhere to make the direction unambiguous.
2. **Top-holder check was silently disabled.** It was reading `topHolders`
   from the `/report/summary` endpoint, which doesn't include that field.
   Switched to the full `/report` endpoint.
3. **Liquidity-lock detection was a fragile regex guess** that defaulted to
   "locked" when uncertain. Replaced with Rugcheck's direct `lpLockedPct`
   field, and "unknown" is now treated as a mild negative instead of a pass.
4. **The bot couldn't start at all** — `tokenScanner.js` required a
   nonexistent file (`./services/geminiService`). Fixed to point at the real
   `../services/gemini_signal_generator`.
5. **The Gemini call would have crashed on first use** — it imported the
   deprecated `@google/generative-ai` package while `package.json` installs
   the current `@google/genai`. Rewritten against the SDK that's actually
   installed.
6. **New:** added the mc/volume sanity check described above.
7. **`/verify` could be front-run.** It only checked that a transaction paid
   `PAYMENT_WALLET_ADDRESS`, never who sent it — and a transaction signature
   is public the instant it confirms, so anyone who spotted a qualifying
   payment (a block-explorer watcher, or another bot user) could paste that
   same signature into their own `/verify` and claim someone else's
   subscription: first *claim* won, not first *pay*. `/verify` now takes a
   second argument, the paying wallet's address (`/verify <signature>
   <wallet>`), which is checked against the transaction's actual fee payer
   on-chain and then bound to that chat (`subscribers.verified_sender_wallet`)
   — once an account has paid once, a different signature from a different
   wallet can no longer hijack it. See `solanaService.js`'s
   `verifyPaymentTransaction` docstring for the known limitation this doesn't
   close (a brand-new chat's very first payment still has nothing to bind
   against yet — closing that fully needs a signed-message ownership proof,
   which this doesn't attempt). Admins can clear a stuck bind (e.g. a
   legitimate wallet switch) with `/resetwallet <chatId>`.
8. **`predictForCategory`'s archive lookup read the entire `pattern_archive`
   table on every qualifying token, every scan cycle** — `getArchive()`
   fetches every row unconditionally, and `tokenScanner.js` called it once
   per qualifying token just to filter it down to one category in JS,
   ignoring the `category_key` index that already exists for exactly this
   query. Added `tokenPatternStore.getArchiveForCategory(categoryKey)`,
   which does the filtering in SQL, and switched the scan loop to use it.
   `getArchive()` itself is unchanged and still used as-is by the
   infrequent admin/report commands, which genuinely need the whole table.
9. **Token prices rendered as raw JS scientific notation in live alerts.**
   Fresh Solana memecoins routinely price in the 1e-7–1e-9 range (huge
   supply, tiny unit price), and JS's default `Number -> String` coercion
   switches to exponential notation below 1e-6 — so a real subscriber
   would see `Price: $3.821e-7` instead of a readable decimal, on exactly
   the tokens this bot exists to catch early. `marketCap`/`liquidity` were
   already routed through a formatter; `priceUsd` was interpolated raw.
   Added `core/priceFormat.js`'s `fmtPrice()` (fixed-decimal, scales
   precision to magnitude, never exponential) and applied it in both
   `alertFormatter.js` and the Gemini prompt (`gemini_signal_generator.js`)
   — shared in one place so the two can't drift into disagreeing about how
   a price reads.
10. **DexScreener pair lookups weren't batched, despite the API supporting
    it.** `getCandidatePairs()` resolved up to 30 token profiles with up
    to 30 separate sequential requests, and `patternReviewer.js`'s review
    loop did the same, one request per tracked token, every review cycle —
    against the documented 300 req/min "DEX/pairs" limit, adding avoidable
    latency to a bot whose whole value proposition is speed. DexScreener's
    `/tokens/v1/{chainId}/{tokenAddresses}` endpoint accepts up to 30
    comma-separated addresses per request. Added
    `dexscreenerService.getPairsForTokens` (batched) and `chunk` (splits a
    longer list into groups of 30), and switched both call sites to use
    them — `getCandidatePairs` directly, and `patternReviewer.js`'s
    `reviewAllTrackedTokens` via a new optional `prefetchedPair` parameter
    on `reviewToken` (its standalone single-token behavior, and every
    existing test that calls it directly, is unchanged).
11. **`rug_mechanism` collapsed to `'unknown-mechanism'` on a single bad
    API call, not just genuinely missing data.** `buildArchiveRecord`
    (`patternReviewer.js`) read `lastTopHolderPct`/`lastLpLockedPct` off
    `getLatestSnapshot()` — the literal most recent snapshot row. If
    *that one* review cycle's Rugcheck call failed (plausibly correlated
    with the rug itself — a crashed pool can disappear from Rugcheck's
    index right when it rugs), that row has both fields `null` even
    though the token's tracked history otherwise had good data, and
    `classifyRugMechanism` mislabels a real liquidity-pull or
    distribution-dump as "unknown," despite `config.js`'s own comment
    defining `unknown-mechanism` as "no safety data across the tracked
    lifetime." Added `tokenPatternStore.getLastKnownSafetyReading()`,
    which returns the last NON-NULL reading for each field independently,
    and switched `buildArchiveRecord` to use it instead. See
    `test/regression.test.js`'s two `AUDIT FIX (rug_mechanism)` tests for
    a regression test that reproduces the exact failure mode and confirms
    the fix. (`unknown-mechanism` itself has since been split further —
    see item 14 below and "Rug mechanism classification" above.)
12. **A token already alerted could get re-alerted after a process
    restart.** `tokenScanner.js`'s alert dedup was an in-memory-only
    `Set` — correct within one process's lifetime, but reset to empty on
    every restart (deploy, crash, PM2 restart). A token alerted moments
    before a restart, still passing every filter on the next cycle, would
    get re-evaluated fresh and re-alerted. Added a persistent backstop:
    `alerted_pairs` table + `tokenPatternStore.getAlertedPairs`/
    `recordAlertedPair`, checked via one batched query per scan cycle
    (bounded by that cycle's candidate count, not by the table's
    historical size) alongside the in-memory `Set`, which stays as the
    same-cycle/same-process fast path. Fails open on a DB error — a
    lookup failure falls back to that cycle's in-memory-only behavior
    rather than blocking the scan. See `test/regression.test.js`'s
    `REGRESSION GUARD — a token already alerted does NOT get re-alerted
    after a simulated process restart` test, which verifies this by
    actually dropping `tokenScanner.js` from Node's module cache and
    re-requiring it — a faithful restart simulation, not just testing the
    store functions in isolation.
13. **`deriveCategoryLabel` mishandled single-keyword input** — the
    label-widening loop started at a hardcoded `n = 2`, so for a
    1-keyword input `2 <= keywords.length` was never true and it fell
    straight into the "every candidate collided" numeric-suffix fallback
    without ever trying a real candidate, producing e.g. `desc:dragon-2`
    instead of `desc:dragon` even against a completely empty registry
    where no collision was possible. A real, common case in practice:
    `extractKeywords` legitimately returns just one word once `STOPWORDS`
    (coin/token/crypto/community/etc.) filters a short, generic
    description down — e.g. "A dragon coin for the community" reduces to
    exactly one keyword. Cosmetic rather than data-corrupting (a second
    single-keyword token with the same word still correctly joins the
    first via the Jaccard-similarity check, which runs before label
    derivation and doesn't care about the suffix — clusters didn't
    silently fragment), but a confirmed, reproducible deviation from the
    function's own documented contract. Fixed by starting the loop at
    `Math.min(2, keywords.length)` instead of a hardcoded `2` in
    `descriptionClassifier.js`. See `test/regression.test.js`'s `AUDIT
    FIX: deriveCategoryLabel with exactly ONE keyword...` and `AUDIT FIX:
    classifyByDescription end-to-end with a short/generic description...`
    tests.
14. **`rug_mechanism` conflated two very different "we don't know" cases
    under one `'unknown-mechanism'` label.** A token with zero snapshot
    rows at all (archived before its first review tick ever ran — a
    *timing* gap) and a token reviewed multiple times where Rugcheck just
    never returned usable data (a genuine *data* gap) both collapsed to
    the same string, making it impossible to tell from the archive data
    alone how much of the "unknown" bucket was even fixable by reviewing
    sooner. Split `classifyRugMechanism` (`patternAnalyzer.js`) into
    `unknown-mechanism-no-review` (`checkpointCount === 0`) and
    `unknown-mechanism-data-gap` (`checkpointCount >= 1`, still no usable
    reading) — see "Rug mechanism classification" above for the full
    label set. `reportFormatter.js`'s `RUG_MECHANISM_ORDER`/
    `RUG_MECHANISM_LABEL` updated to match. No backfill script for
    existing archive rows yet — see `HANDOFF.md`.
15. **Fast-rugging tokens routinely got zero post-enrollment safety
    data, driving item 14's `-no-review` bucket.** Root cause: only
    `patternReviewer.js`'s `reviewToken` ever writes a `snapshots` row
    (`enrollToken` doesn't), and at the un-tiered default `reviewIntervalMs`
    (3h), a token that rugs before its first tick has literally nothing
    to look back on, however good its enrollment-time Rugcheck read was.
    Added an early-life review cadence — see "Early-life review cadence"
    above — that reviews tokens younger than
    `patternTracking.earlyLifeWindowMs` (default 3h) on a faster
    `patternTracking.earlyLifeReviewIntervalMs` (default 15 min) instead,
    via a new `tracked_tokens.last_reviewed_at` column and a `dueForReview`
    filter in `reviewAllTrackedTokens`, without increasing load on the
    (much larger) already-past-early-life tracked population.
    `reviewToken` itself is unchanged — still a fresh, independent
    Rugcheck fetch every single call — so every `lastReviewedAt`-derived
    "last known" reading stays a genuinely distinct observation, never a
    reused enrollment-time value.
16. **`classifyRugMechanism`'s `checkpointCount === 0` check silently
    treated `undefined`/`null` the same as `>= 1`**, asserting "this
    token was reviewed at least once" with no actual basis for that
    claim. Found during an independent code audit, before Plans A/B
    below were built on top of it. The only real path to this: an
    archive record migrated by `scripts/migrate.js` from the
    pre-Postgres legacy JSON archive, predating `checkpointCount`
    existing as a tracked concept at all — `patternReviewer.js`'s live
    archiving path always supplies a real number via
    `store.getSnapshotCount`, which returns `0`, never `null`/`undefined`.
    Fixed with a third label, `unknown-mechanism-no-checkpoint-data` —
    see "Rug mechanism classification" above — rather than silently
    picking one of the two more specific (and therefore overclaiming)
    existing options.
17. **Plans A + B: `signal_status`, and confidence/evidence for both rug
    mechanism and narrative classification.** Reviewed a separately-
    drafted implementation plan against the real code before building
    anything from it (same standard as any other proposal — verified its
    line-number citations and call-site counts directly, not assumed)
    and found two real gaps worth fixing along the way: the plan's
    `classifyByDescription` snippet only patched one of the two
    similarity-scored return sites, and its rug-mechanism backfill would
    have silently inherited item 16's bug. See "Why signal_label is
    null" and the "Confidence + evidence"/"Narrative confidence"
    subsections above for what shipped. Both, like item 14 before them,
    are explainability layers — neither reduces how often a signal comes
    back null or a token stays uncategorized; see those sections for why
    that's a deliberate scope choice, not an oversight.
18. **`extractSafetySignals` read `report.lpLockedPct` as a flat
    top-level field — it never existed.** Confirmed against a live
    Rugcheck response (fetched directly, not inferred): `typeof
    report.lpLockedPct` is `undefined`, always. The real data lives
    per-*market* — `report.markets[]` (a single mint can have many pools;
    one real production example had 923), each with its own `lp` object
    containing the actual `lpLockedPct`. This wasn't an occasional gap —
    production data showed **100% of `partial-unknown` rugged rows
    (747 of 869 archived rugs, 86%)** had both `first_lp_locked_pct` and
    `last_lp_locked_pct` null, including tokens reviewed many times over
    hours. A uniform 100% failure rate across a heterogeneous population
    is what actually gave this away as a parsing bug rather than genuine
    data unavailability — real intermittent gaps look different from
    "always exactly zero."
    - **This is a bigger fix than the rug-mechanism story alone.**
      `liquidityLocked` (derived from `lpLockedPct`) also feeds
      `computeHypeScore`/`classifyRisk` (`scoring.js`) — since it could
      only ever be `null`, every token got the same flat `-0.5` "unknown
      lock status" hype penalty regardless of its real lock status (zero
      discriminating power), and `classifyRisk`'s high-risk-combo check
      could never benefit from a genuinely-locked LP excluding a token
      from it. This means the fix changes live scoring/qualification
      behavior going forward, not just historical labels.
    - **Fix:** match `report.markets[].pubkey` against the specific pool
      this bot is already tracking (`pairAddress` — the same value
      DexScreener uses, since both index the same on-chain pool
      account), and read `lpLockedPct` from *that* market's `lp` object.
      Deliberately not an aggregate (min/max/first) across unrelated
      pools — a rugger could leave a decoy pool locked while draining
      the real one, and picking the wrong pool's number would misreport
      it as safe. No match (pool not yet indexed by Rugcheck, or no
      `pairAddress` given) fails closed to `null`, same as every other
      "we don't know" case in this function.
    - **Backward compatible on purpose:** the flat-field read is checked
      *first*, not removed — ~30 test fixtures across
      `test/regression.test.js` mock a simple `{ lpLockedPct: N }` shape,
      and none needed rewriting (same reasoning as item 17's
      `generateSignal` — don't force a rewrite of dozens of call sites
      for no functional gain). It's also correct defensive code on its
      own merits: if Rugcheck ever adds a flat field back in some future
      API version, it's picked up automatically.
    - **No backfill possible for existing archive rows** — this is
      forward-looking only. A rugged token's LP-lock history is gone the
      moment it archives (`snapshots` cascade-deletes with
      `tracked_tokens`; only summary fields survive into
      `pattern_archive`), and Rugcheck's API only returns *current*
      state, not what a pool's lock status was at some point in the
      past. The 747 already-`partial-unknown` rows stay that way
      permanently; only new tokens tracked from here forward benefit.
19. **The live description-based narrative fallback (`descriptionClassifier.js`)
    could mint or join a `desc:*` category purely from launchpad
    boilerplate text.** `descriptionBoilerplateFilter.js`'s
    `isBoilerplateDescription` was built and unit-tested to keep this
    kind of text out of the historical Gemini-recovery pipeline
    (`backfill-narrative-gemini.js`), but wasn't wired into the live
    Jaccard classifier those same tokens run through at qualification
    time — flagged explicitly at the time as "not wired in, a plausible
    contributor to the registry fragmentation" (242 `description_categories`
    rows for only 299 tokens joined, averaging 1.24 members each). Now
    wired in: `classifyByDescription` checks `isBoilerplateDescription`
    before ever extracting keywords from a description, and treats a
    boilerplate description exactly like a missing one — falls through to
    the name-similarity path instead of either minting a junk category
    (`desc:deployed-j7tracker`-style labels) or Jaccard-matching two
    unrelated tokens into the same bucket purely because they used the
    same launchpad's default credit line. See "Description-based
    narrative fallback" above for the updated two-path description. No
    backfill for already-minted boilerplate-derived categories — this is
    forward-looking only, same posture as most fixes in this list;
    whether any already exist in production hasn't been checked (worth a
    quick `SELECT category_key, sample_description FROM
    description_categories` scan to see if `isBoilerplateDescription`
    would flag any of them).
20. **Every standalone `backfill-*.js` script assumed the target database
    already had every column its own `schema.sql` version defines.**
    `ensureSchema()` (idempotent — `CREATE TABLE`/`ADD COLUMN IF NOT
    EXISTS`) is what actually applies schema changes, and was only ever
    called from the live bot process (`src/index.js`, on every start) and
    `scripts/migrate.js` — none of the 9 real backfill scripts called it
    themselves, even though every `_smoketest_*` throwaway script did
    (they build their own scratch schema from nothing, so they had to).
    Surfaced as a real production error: running a backfill script
    straight after pulling new code, before the live bot had been
    restarted against the updated schema, failed with `column "..." does
    not exist`. Reproduced directly (a scratch database seeded with the
    real pre-change `schema.sql`, confirmed the same error) before fixing.
    Fixed by adding `await ensureSchema();` as the first line of every
    backfill script's `main()` — same pattern `migrate.js` and every
    smoketest script already used, just never applied to the scripts that
    actually run against production. Costs nothing on an already-current
    database (a few no-op `IF NOT EXISTS` checks); fully unblocks a stale
    one. See `HANDOFF.md` for the full list of affected scripts and the
    reproduction/verification steps.
21. **`backfill-narrative-gemini.js` had no rate-limit awareness** — its
    only pacing was a flat 300ms "courtesy" delay, unrelated to any
    documented rate limit. Surfaced as a real production error: Gemini's
    free tier caps `gemini-3.5-flash-lite` at 15 requests/minute, and the
    script blew through that in the first ~4.5 seconds of a run, then
    kept retrying at the same flat pace for the rest of it — 23 of 50
    attempted calls failed with HTTP 429 in one real run, each abandoning
    its row(s) to "left for retry" even though the API's own response
    already specified exactly how long to wait
    (`RetryInfo.retryDelay`). Fixed: a 429/`RESOURCE_EXHAUSTED` error is
    now retried in place (same call, up to 4 times) using that
    server-provided wait time, instead of being abandoned like any other
    API error. Deliberately doesn't hardcode Gemini's free-tier RPM
    number anywhere — that's account/tier-specific and would go stale;
    reading the server's own `retryDelay` self-adapts to whatever the
    real limit actually is. Verified via two new smoketest cases (a
    rate-limited call that retries and succeeds; a persistently
    rate-limited call that correctly exhausts its bounded retries and
    falls back to the pre-existing behavior) and, since fixing it,
    confirmed under real, repeated production load: zero Gemini calls
    were abandoned across four full production runs that together
    cleared the entire outstanding backlog, with only the occasional
    single-retry backoff visible in the output. See `HANDOFF.md`'s
    "RATE-LIMIT FIX" section for the full story.
22. **`backfill-narrative-gemini.js`'s `--limit N` CLI flag was silently
    ignored** — the script only ever read `process.env.LIMIT`, never
    `process.argv`, so `node scripts/backfill-narrative-gemini.js --limit
    100` ran at the default 50 with no warning that the flag had done
    nothing. Found from real production output: two consecutive
    invocations with `--limit` flags both silently defaulted, only
    becoming visible on close reading of the "Pass 2: making up to N
    calls" line. Fixed: `--limit N` / `--limit=N` are now real,
    parsed CLI flags, taking precedence over the `LIMIT` env var when
    both are given; a malformed value warns instead of failing silently;
    and the effective limit plus which of the three sources produced it
    is now printed unconditionally as the very first line of every run
    (`Effective LIMIT for this run: 100 (from --limit flag).`), so this
    can't go unnoticed again regardless of how it's set. Verified via 6
    new spawned-child-process smoketest cases covering both flag forms,
    env-var-only, CLI-over-env precedence, the no-input default, and the
    malformed-value warning.
22. **`rug_mechanism` couldn't distinguish "we have no idea why it
    rugged" from "the creator kept the ability to mint unlimited supply
    or freeze any wallet the whole time."** A mint-then-dump or
    freeze-then-drain doesn't necessarily move `lpLockedPct` or
    `topHolderPct` the way a classic LP-pull or holder-dump does, so
    these cases silently fell into `organic-death`/`unknown-mechanism-*`
    despite a real, known explanation being available — item 5 from the
    AI-training-pipeline proposal audit (see `HANDOFF.md`). Fixed:
    `extractSafetySignals` now surfaces `mintAuthorityHeld`/
    `freezeAuthorityHeld` directly from Rugcheck's report (a real pubkey
    present, or permanently renounced — clean SPL semantics, captured at
    zero extra API cost since it's the same call already made for
    `topHolderPct`/`lpLockedPct`), and `classifyRugMechanism` gained two
    new values — see "Rug mechanism classification" above for the full
    priority ordering and reasoning. Verified non-breaking empirically
    (ran the full suite before writing a single new test to confirm all
    15 pre-existing `classifyRugMechanism` assertions still passed
    unchanged), then covered with new tests at every layer — pure
    extraction, pure classification, confidence/evidence shape, and two
    full end-to-end integration tests (a real `runScanCycle` enrollment,
    and a full enroll→review→rug→archive cycle against a real Postgres
    database) rather than trusting the pure-function tests alone to
    prove the DB wiring was correct. **238 → 243.** No backfill possible
    for rows archived before this shipped — see "Rug mechanism
    classification" above.

## Storage

All persistence — subscribers, active pattern-tracking, the permanent
pattern archive, and report-send timestamps — lives in Postgres
(`src/db/schema.sql`, applied automatically the first time you run
`npm run migrate` or on any fresh `DATABASE_URL`). This replaced an earlier
flat-JSON-file version; the migration is one-directional and one-off.

**Fresh install:** just set `DATABASE_URL` and start the bot — the schema
is created automatically (`CREATE TABLE IF NOT EXISTS`, safe to run
repeatedly).

**Upgrading from the JSON-file version**, with existing data under
`data/*.json`:

```bash
DATABASE_URL=postgres://... npm run migrate
```

This applies the schema, copies everything over, and records what it did
in a `migration_state` row so a second accidental run is refused (pass
`--force` if you genuinely need to re-run it). The JSON files under `data/`
are left in place afterward as a backup — the running bot no longer reads
or writes them — safe to archive elsewhere once you've confirmed the bot
is working correctly against Postgres.

Active-tracking price/safety history (`snapshots`) is append-only — every
3-hourly review adds a row rather than overwriting an in-place blob.
Rows for a given token are automatically deleted the moment it's archived
(`ON DELETE CASCADE`); the summary fields a completed token needs
(checkpoint count, first/last holder %, first/last LP-locked %) are
captured into `pattern_archive` at that point, so there's nothing further
to keep. A defensive cap (`patternTracking.maxCheckpointsPerToken`, still
80) prunes anything beyond the most recent N rows per token — mostly
theoretical at the default review interval, kept as insurance against
misconfiguration rather than the hard requirement it used to be for
bounding a single JSON file's size.

`pattern_archive` also carries `outcome_detail` (a finer label than the
base `outcome`: for a rugged token, a rug-timing bucket relative to when
THIS BOT detected it — `immediate-rug` (<1h), `rug-within-3h`,
`rug-within-6h`, `rug-within-12h`, `rug-within-24h`, `rug-after-24h`
(≥24h), or `rug-timing-unknown` if the record lacks usable timing data;
for a survived token, `dead` / `pump-and-dump` / `stable-survivor` —
additive alongside `outcome`, nothing that reads `outcome === 'rugged'`
today needed to change) and `peak_roi_bucket` (a readable `2x-5x`-style
category), both derived once at archive time from data already being
tracked. The rug-timing buckets are keyed off `timeToRugFromQualification
Hours` specifically (time from THIS BOT's detection/qualification to the
rug) rather than `timeToRugFromAthHours` (time from the token's own price
peak to the rug, still stored on the record but no longer what drives
this label) — "how long would someone who bought right after the alert
have had" is the more directly actionable question. The daily/weekly
self-assessment reports break down by these automatically now. See
`patternAnalyzer.js`'s `classifyOutcomeDetail` and its config thresholds
(`patternTracking.outcomeDetail.rugTimingBuckets`) in `config.js` if you
want to tune the boundaries, or "dead" vs a real pump-and-dump.

**One-off backfill scripts** (each safe to re-run — read-only until their
final per-row write, and idempotent: already-processed rows are skipped
on a re-run, not re-touched):

- `npm run backfill-rug-timing` — recomputes `outcome_detail`'s rug-timing
  bucket for every existing `'rugged'` archive row against the
  qualification-relative logic described above (only relevant if
  upgrading from the older ATH-relative/2-way version of this field).
- `npm run backfill-survival-watermark` — seeds `tracked_tokens.last_below_
  survival_threshold_at` from each already-tracked token's existing
  snapshot history, for tokens enrolled before the fast-path `'survived'`
  logic above existed.
- `npm run backfill-description-narrative` — see "Description-based
  narrative fallback" above.
- `npm run backfill-rug-mechanism-split` — see "Rug mechanism
  classification" above.
- `npm run backfill-signal-status` — see "Why signal_label is null" above.
- `npm run backfill-rug-mechanism-confidence` — see "Confidence +
  evidence (Plan B)" above.
- `npm run backfill-narrative-confidence` — see "Narrative confidence
  (Plan B)" above.
- `node scripts/backfill-pair-created-at.js` (not npm-registered, same as
  `backfill-recover-description.js`/`backfill-narrative-gemini.js`
  mentioned above — none of the three ever got an npm script added) — retroactively fills `pair_created_at` (the pool's real
  on-chain birth time) for rows enrolled before that column existed:
  DexScreener first (cheap, and — counterintuitively — the CHEAP case is
  a still-live winner, since DexScreener is most likely to still have it
  indexed), on-chain signature walk as fallback only when DexScreener no
  longer has the pair. `--limit`/`--sig-cap`/`--skip-onchain`/
  `--retry-unresolved` flags; a row only ever gets one attempt by default
  (`pair_created_at_checked_at` dedup) unless `--retry-unresolved` is
  passed deliberately. See "Early-wallet backfill (item 29, Stage 1)"
  above, which depends on this having been run first.
- `npm run backfill-early-wallets` — see "Early-wallet backfill (item 29,
  Stage 1)" above.
- `npm run review-early-wallet-backfill` — read-only cost/quality report
  over whatever the above has written so far (backlog, status breakdown,
  RPC page cost, discovery yield, recurring wallets, truncated/error
  samples). Not a scan-path or scoring feature — see "Early-wallet
  backfill" above and `HANDOFF.md`'s wallet-intelligence roadmap for
  where this fits (it's roadmap step 1's own deliverable, nothing more).
- `npm run review-taxonomy-suggestions` — read-only report, not a
  backfill (nothing is written). Aggregates every `suggestedNewNarrative`
  the Gemini semantic classifier (`backfill-narrative-gemini.js`) has
  ever proposed for a token that didn't fit any existing
  `NARRATIVE_RULES` tag, grouped by suggestion text and sorted by
  occurrence count — e.g. `"animal-themed" — 9 occurrence(s)`. Optional
  `MIN_COUNT=N` (default 2) to control how rare a suggestion has to be
  before it's hidden from the main list (still counted in a summary
  line). Safe to run any time, as often as wanted; never creates a
  category on its own — deciding whether a repeated suggestion is worth
  a real `NARRATIVE_RULES` entry is still a manual call, same as every
  other taxonomy-suggestion touchpoint in this project.
- `npm run review-outlier-outcomes` — read-only report, not a backfill.
  Surfaces archived tokens where the bot's own signal disagreed sharply
  with what happened: skipped tokens that went 10x+, BUY/WAIT signals
  that rugged within 3 hours, low-hype/low-risk sleepers that mooned
  anyway, and high-hype/low-risk tokens that rugged immediately despite
  passing every check. Every threshold reuses an existing bucket
  boundary already defined in `config.js` (`peakRoiBuckets`,
  `hypeScoreBuckets`, `outcomeDetail.rugTimingBuckets`) rather than
  inventing a new one. These are the calls the bot got most wrong —
  more informative for a future training pass than an ordinary correct
  one.
- `npm run review-data-quality` — read-only report, not a backfill. Runs
  9 checks against the archive before any Tier 3 training work should
  start: missing narrative, missing ATH price, impossible/inconsistent
  ROI, missing snapshot history, duplicate archive rows, contradictory
  rug labels, low-confidence classifier output, thin lifecycle data
  (too few review checkpoints), and suspicious timestamps. Two
  thresholds here (`LOW_CONFIDENCE_THRESHOLD = 0.5`,
  `MIN_CHECKPOINTS = 2`) are genuinely new numbers invented for this
  script specifically, not pulled from an existing project convention —
  called out explicitly in the script's own header as a starting point,
  not a settled value.

## Early-discovery experiment (GeckoTerminal/CoinGecko, research-only)

A standalone script measures whether GeckoTerminal/CoinGecko's on-chain
`new_pools` data can surface Solana tokens earlier than the existing
DexScreener-based discovery above — and whether that earlier discovery is
actually useful, not just noise. Not wired into `npm start`/`src/index.js`
in any way: no BUY/WAIT/SKIP behavior, qualification threshold, or EDPI-L
scoring changes as a result of this. Dry-run by default.

```bash
EARLY_DISCOVERY_DRY_RUN=false EARLY_DISCOVERY_MAX_CYCLES=20 npm run early-discovery:run
npm run early-discovery:report
```

See **[docs/early-discovery-experiment.md](./docs/early-discovery-experiment.md)**
for the full design (architecture, endpoints/rate limits, schema, known
limitation on the fallback path, and what's deliberately left for later).

## EDPI wallet selection & position-lifecycle reconstruction (research/shadow-only)

Restricts EDPI's wallet population to a token's Top-20 holders by raw rank
(LP/pool entries excluded via Rugcheck's own `type` field — see
`src/core/edpiWalletSelection.js`), and reconstructs a wallet's own
buy/sell history into real positions — multi-buy accumulation, minor
sells, a 40%-cumulative-reduction major exit, and buybacks as separate
positions with their own 3-hour-hold + exit>entry-MC qualification (see
`src/core/positionLifecycle.js` / `src/core/walletOutcomeProfile.js`).
Wallet selection is live in the qualification path
(`evidence.edpiWalletSelection`); the heavier position-lifecycle economics
are built, tested, and runnable but deliberately not yet wired into the
hot path — see the doc below for why.

```bash
DATABASE_URL=... node scripts/report-edpi-positions.js --pair-address=<pairAddress>
```

See **[docs/edpi-position-lifecycle.md](./docs/edpi-position-lifecycle.md)**
for the full design, findings from inspecting the existing codebase, known
limitations, and what's deliberately not built yet.

## EDPI-L behavioral-pattern expansion (research/shadow-only)

Compares each Top-20 candidate wallet's CURRENT position against its own
historical distribution — entry-MC deviation and capital deviation,
computed and reported fully independently (a wallet can show either,
both, or neither) — plus dead/rugged vs. stable/survived
surrounding-activity classification, repeated-similar-size entries, and
consecutive-loss sequences. Cross-wallet aggregation counts how many
wallets independently exhibit each PATTERN, never how many share the same
historical token (that's a deliberately separate, not-yet-built
mechanism — see the doc below). Not wired into the qualification path;
built, tested, and runnable via the same report script above.

See **[docs/edpi-behavioral-patterns.md](./docs/edpi-behavioral-patterns.md)**
for the full design, what already existed vs. what's new, a real bug
caught and fixed during development, and what's explicitly out of scope
(the dead-token CTO-convergence subsystem).

## Known limitations

1. ~~**Storage.**~~ Resolved — storage moved to Postgres (see
   [Storage](#storage) above), which also closes the multi-process-instance
   gap the flat-JSON version had (Postgres transactions/constraints protect
   `reserveTxSignature` and `extendSubscription` across processes, not just
   within one).
2. ~~**SPL token payment verification.**~~ Resolved — `solanaService.js`'s
   `getOwnerTokenBalanceDelta` fully resolves the destination token
   account's owner and verifies the balance delta directly, rather than
   just checking that a transfer instruction exists.
3. **Rugcheck field names** are based on their documented `/report` shape as
   of writing, not a versioned schema — verify against
   https://api.rugcheck.xyz/swagger/index.html if fields come back `undefined`.
4. **Rate limits.** DexScreener allows 60 req/min on the token-profile
   endpoint and 300 req/min on search/pairs endpoints; the full Rugcheck
   `/report` endpoint is heavier than `/report/summary`, so watch your quota
   as you lower `SCAN_INTERVAL_MS`.
5. **Legal/compliance.** You're charging a recurring fee for automated
   trading signals on speculative assets. Have clear terms of service and a
   "not financial advice" disclaimer, and check requirements in your
   jurisdiction before launching publicly.
6. **Pattern tracking adds ongoing API load independent of the 30s scan
   loop.** Every tracked token costs one DexScreener call + one Rugcheck
   call per `reviewIntervalMs` (default every 3h), for as long as it stays
   below the rug threshold and under `maxTrackingAgeMs` — a busy deployment
   with hundreds of tracked tokens at once will add up. The `pattern_archive`
   table also grows without bound (nothing ever deletes from it, by design —
   it's the training data) — this is a non-issue at Postgres scale for a
   long time, but worth an index/vacuum check if it ever grows into the
   millions of rows.
