const { narrativeLabel } = require('../core/narrativeLabels');
const { fmtPrice } = require('../core/priceFormat');

function fmtUsd(n) {
  if (n === null || n === undefined) return 'unknown';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

// Token symbol/name come straight from DexScreener, which reflects
// whatever the (anonymous, unvetted) token creator named it — this is
// attacker-controlled input. Messages are sent with parse_mode: 'Markdown'
// (Telegram's legacy mode), whose special characters are just _ * ` [ —
// escape those so a crafted token name can't break message formatting or
// inject fake links/styling into an alert.
//
// The same escaping is applied to the AI-generated `signal` text below.
// That text is meant to be plain language, but the prompt that produced it
// (see gemini_signal_generator.js) also embeds the raw, attacker-controlled
// symbol/name — so a crafted token name attempting a prompt injection
// could in principle get the model to echo Markdown-breaking characters
// or a fake link into its own output, bypassing symbol/name escaping
// alone. Escaping the model's output too closes that gap regardless of
// whether the model follows its "no markdown" instruction.
function escapeMarkdown(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/([_*`[])/g, '\\$1');
}

const RISK_EMOJI = { Low: '🟢', Medium: '🟡', High: '🔴' };

// discovery.source is set by discoveryService.js's normalizeDexScreenerPair
// / normalizeGeckoPool to exactly 'dexscreener' or 'geckoterminal' — the
// two pipelines a token can be discovered through. Falls back to the raw
// source string (or is omitted) if neither is recognized, so a future
// third pipeline doesn't silently disappear from the alert.
const DISCOVERY_SOURCE_LABELS = { dexscreener: 'DexScreener', geckoterminal: 'GeckoTerminal' };

function formatDiscoverySourceLine(discovery) {
  if (!discovery || !discovery.source) return null;
  const label = DISCOVERY_SOURCE_LABELS[discovery.source] || discovery.source;
  return `Discovered via ${label}`;
}

// baseToken.address is the on-chain mint/contract address (CA), taken from
// the structured token-identity field of the DexScreener/GeckoTerminal API
// response (see discoveryService.js) — not free-text like symbol/name, so
// no Markdown escaping is needed. Wrapped in backticks so Telegram renders
// it as tap-to-copy monospace text.
function formatContractAddressLine(address) {
  if (!address) return null;
  return `CA: \`${address}\``;
}

// Same "unknown" convention as fmtUsd/fmtPrice above: a persisted alert
// row can carry a null/NaN ageMinutes (older rows predating this field,
// or an unvalidated pairCreatedAt from the upstream API — see
// rowToAlertDecision in alertDecisionStore.js), so this must never assume
// a finite number the way a bare `ageMinutes.toFixed(0)` does.
function fmtAgeMinutes(n) {
  if (n === null || n === undefined || typeof n !== 'number' || Number.isNaN(n)) return 'unknown';
  return `${n.toFixed(0)}m`;
}

/**
 * 📣 Social Score — the one line the (opt-in, off-by-default) Social
 * Score feature adds; see src/services/socialSignals.js. Returns null
 * (line omitted entirely) whenever the feature is off, or on but no
 * source produced a reading this cycle — never shows a fabricated
 * number.
 */
function formatSocialLine(token) {
  if (!token.socialSignals || !token.socialSignals.available) return null;
  return `📣 Social Score: *${token.socialSignals.socialScore}/10*`;
}

/**
 * EDPI-L is a deterministic wallet-intelligence score calculated at
 * qualification time. It is persisted with the alert decision and rendered
 * here from that persisted result; delivery must never recalculate it.
 *
 * A score of 0 with no active scoring evidence is intentionally displayed as
 * "No Active Scoring Evidence" rather than pretending that 0 means a negative
 * wallet signal. Older alerts without EDPI-L remain compatible and simply
 * omit the line.
 */
function formatEdpiLLine(edpiL) {
  if (!edpiL) return null;
  const rawScore = Number(edpiL.edpi_l_score);
  const score = Number.isFinite(rawScore) ? rawScore.toFixed(1) : null;
  const strength = edpiL.strength_label || null;
  if (!score && !strength) return null;

  const scorePart = score ? `*${score}/10*` : '*N/A*';
  const status = edpiL.score_status === 'no_active_scoring_evidence'
    ? 'No Active Scoring Evidence'
    : strength;
  return `🧠 EDPI-L: ${scorePart}${status ? ` (${escapeMarkdown(status)})` : ''}`;
}

function formatSocialMetadataLine(metadata) {
  if (!metadata || !metadata.available) return null;
  const parts = [];
  const socials = Array.isArray(metadata.socials) ? metadata.socials.slice(0, 3) : [];
  for (const social of socials) {
    const handle = typeof social.handle === 'string' ? social.handle.trim() : '';
    const url = typeof social.url === 'string' ? social.url.trim() : '';
    // Some persisted/legacy records contain an X/Twitter path in `handle`
    // without a populated `url`. Never fall back to exposing that raw path:
    // reconstruct the canonical URL so old records and fresh records render
    // identically. This deliberately handles both /status/... and
    // /i/communities/... shapes.
    const isTwitterPath = ['twitter', 'x'].includes(String(social.platform || '').toLowerCase()) && /\//.test(handle);
    const derivedTwitterUrl = isTwitterPath && !/^https?:\/\//i.test(handle)
      ? `https://x.com/${handle.replace(/^\/+/, '')}`
      : null;
    const value = isTwitterPath ? (url || derivedTwitterUrl || handle) : (handle || url);
    if (value) parts.push(`${social.platform}: ${escapeMarkdown(value)}`);
  }
  const links = Array.isArray(metadata.links) ? metadata.links : [];
  if (parts.length === 0 && links.length > 0) {
    parts.push(...links.slice(0, 2).map((link) => `${link.label || link.platform}: ${escapeMarkdown(link.url)}`));
  }
  if (metadata.communityTakeover) parts.push('community takeover reported');
  const lore = metadata.description ? ` | Lore: ${escapeMarkdown(metadata.description.slice(0, 180))}` : '';
  return parts.length > 0 || lore ? `🌐 Social context: ${parts.join(' · ')}${lore}` : null;
}

/**
 * Tier 1 wallet clustering — "🔗 Repeat wallet" line. Shows when one or
 * more of THIS token's top holders have also shown up as a top holder on
 * other qualifying tokens (see config.js's walletClustering block and
 * tokenPatternStore.js's getRecurringWalletsAmong). Deliberately phrased
 * as an observation, not an accusation — a wallet can legitimately hold a
 * stake in several unrelated tokens, this isn't proof of coordination on
 * its own, same "past behavior, not a verdict" posture as the historical-
 * pattern line below.
 *
 * Caps how many individual wallets are listed inline (display cap, not a
 * data cap — getRecurringWalletsAmong itself isn't limited) so a wallet
 * that's recurred across dozens of tokens doesn't blow out the alert.
 */
function formatRecurringWalletsLine(recurringWallets) {
  if (!recurringWallets || recurringWallets.length === 0) return null;
  const DISPLAY_CAP = 3;
  const parts = recurringWallets
    .slice(0, DISPLAY_CAP)
    .map((w) => `${w.walletOwner.slice(0, 4)}…${w.walletOwner.slice(-4)} (${w.tokenCount} tokens)`);
  const suffix = recurringWallets.length > DISPLAY_CAP ? ` +${recurringWallets.length - DISPLAY_CAP} more` : '';
  return `🔗 Top holder also seen on other tokens: ${parts.join(', ')}${suffix}`;
}

function formatAlert(token) {
  const { baseToken, hypeScore, riskLevel, signal, priceUsd, marketCap, liquidity, volume1h, ageMinutes, url, rugcheck, narrativeTag, subNarrativeTag, prediction, historicalMatches, recurringWallets, socialMetadata, edpiL, discovery } = token;
  const symbol = escapeMarkdown(baseToken.symbol);
  const name = escapeMarkdown(baseToken.name);
  const safeSignal = escapeMarkdown(signal);

  const riskScoreLine = rugcheck && rugcheck.riskScore !== null
    ? `Rugcheck risk: ${rugcheck.riskScore}/100 (higher = riskier) | LP locked: ${rugcheck.liquidityLocked === true ? 'yes' : rugcheck.liquidityLocked === false ? 'no' : 'unknown'}`
    : null;

  // narrativeTag itself comes from our own fixed keyword rule set (never
  // attacker-controlled), so it's safe to interpolate directly without
  // escaping — unlike baseToken.symbol/name above. Still routed through
  // narrativeLabel() so the alert shows the friendly display name (e.g.
  // "Dog Meme") rather than the raw internal tag ("dog-themed"), same as
  // narrativeFormatter.js does everywhere else.
  const predictionLine = formatPredictionLine(narrativeTag, prediction);
  const historicalMatchesSection = formatHistoricalMatchesSection(historicalMatches);

  // subNarrativeTag (e.g. "AI Companion", "Shiba Lineage") comes from
  // narrativeClassifier.js's SUB_NARRATIVE_RULES — same fixed, non-
  // attacker-controlled rule set as narrativeTag, so no escaping needed.
  // Display/context only: never shown as a promise or stat, just a more
  // specific label than the primary narrative when one matched. Omitted
  // entirely (not shown as "(null)") when nothing matched.
  const subNarrativeSuffix = subNarrativeTag ? ` (${subNarrativeTag})` : '';

  return [
    `${RISK_EMOJI[riskLevel] || '⚪'} *${symbol}* — ${name}${subNarrativeSuffix}`,
    formatContractAddressLine(baseToken.address),
    formatDiscoverySourceLine(discovery),
    `Hype Score: *${hypeScore}/10* (${riskLevel} Risk) | Age: ${fmtAgeMinutes(ageMinutes)}`,
    formatEdpiLLine(edpiL),
    formatSocialLine(token),
    formatSocialMetadataLine(socialMetadata),
    `Price: ${fmtPrice(priceUsd)} | MCap: ${fmtUsd(marketCap)} | Liq: ${fmtUsd(liquidity)}`,
    `Vol (1h): ${fmtUsd(volume1h)}`,
    riskScoreLine,
    formatRecurringWalletsLine(recurringWallets),
    predictionLine,
    historicalMatchesSection,
    '',
    safeSignal,
    '',
    url ? `[View on DexScreener](${url})` : null,
  ].filter(Boolean).join('\n');
}

/**
 * Builds the "historical pattern" line — explicitly labeled as a
 * statistic derived from this bot's own past tracking data, never phrased
 * as a promise or forecast. Returns null (line omitted entirely) if there
 * isn't a large enough historical sample yet — see
 * patternTracking.minSampleSizeForPrediction in config.js. Showing a
 * confident-sounding number from 1-2 past tokens would be misleading, not
 * useful.
 */
function formatPredictionLine(narrativeTag, prediction) {
  if (!prediction) return null;

  const roiPart = prediction.medianPeakRoiMultiple !== null
    ? `peak ROI ~${prediction.medianPeakRoiMultiple.toFixed(1)}x median`
    : 'peak ROI: not enough data';

  const rugPart = prediction.medianTimeToRugFromAthHours !== null
    ? `rugged ~${prediction.medianTimeToRugFromAthHours.toFixed(1)}h after peak (median)`
    : 'no rugged samples yet in this category';

  return `📊 Historical pattern (${narrativeLabel(narrativeTag)}, ${prediction.sampleSize} past tokens tracked): ${roiPart}, ${rugPart}. Past behavior of similar tokens, not a prediction for this one.`;
}

/**
 * Builds the "📚 HISTORICAL MATCHES" section — the closest past archived
 * tokens in the same narrative, from narrativeIntelligence.js's
 * findSimilarHistoricalTokens (see that file's own doc comment for how
 * similarity is scored). Returns null (section omitted entirely) when
 * there are no matches — a brand-new narrative, or one with no archived
 * history yet, simply shows no section rather than an empty header.
 *
 * Each match's symbol is escaped the same way baseToken.symbol is above:
 * it was itself attacker-controlled DexScreener input at the time that
 * historical token qualified, so the same Markdown-injection risk
 * applies here.
 */
function formatHistoricalMatchesSection(historicalMatches) {
  if (!historicalMatches || historicalMatches.length === 0) return null;

  const lines = ['', '📚 *Historical Matches*'];
  for (const match of historicalMatches) {
    const roiPart = match.peakRoiMultiple !== null ? `peaked ${match.peakRoiMultiple.toFixed(1)}x` : 'peak ROI unknown';
    const timePart = match.timeToPeakHours !== null ? ` in ${match.timeToPeakHours.toFixed(1)}h` : '';
    const symbol = escapeMarkdown(match.symbol);
    lines.push(`• ${symbol} (${match.similarityPct}% similar) — ${roiPart}${timePart}, ${match.outcome}`);
  }
  return lines.join('\n');
}

module.exports = { formatAlert, escapeMarkdown };
