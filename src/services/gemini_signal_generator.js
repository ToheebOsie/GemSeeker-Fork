const { GoogleGenAI } = require('@google/genai');
const { gemini } = require('../config');
const { fmtPrice } = require('../core/priceFormat');
const { ASSESSMENT_VERSION } = require('../core/geminiAssessment');
const telemetry = require('../observability/geminiTelemetry');

const ai = new GoogleGenAI({ apiKey: gemini.apiKey });

const ASSESSMENT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    assessmentVersion: { type: 'string', enum: [ASSESSMENT_VERSION] },
    signalLabel: { type: 'string', enum: ['BUY', 'WAIT', 'SKIP'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    momentum: { type: 'string' },
    exitRange: { type: 'string' },
    rationale: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    invalidation: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  },
  required: ['assessmentVersion', 'signalLabel', 'confidence', 'momentum', 'exitRange', 'rationale', 'risks', 'invalidation', 'evidence'],
};

// Only the live scan path calls buildPrompt today, and tokenScanner.js's
// normalizePair() always hands it a finite ageMinutes there — so this
// can't currently crash. Guarded anyway (same "unknown" convention as
// fmtPrice/fmtUsd and alertFormatter.js's fmtAgeMinutes) so it stays safe
// if a future caller ever feeds this a persisted/reconstructed token,
// where ageMinutes can be null (see rowToAlertDecision).
function fmtAgeMinutes(n) {
  if (n === null || n === undefined || typeof n !== 'number' || Number.isNaN(n)) return 'unknown';
  return `${n.toFixed(1)} minutes`;
}

/**
 * Builds a compact, data-grounded prompt so the model isn't guessing —
 * every number it might reference is handed to it explicitly.
 */
function buildPrompt(token) {
  return `You are a terse crypto trading assistant. Analyze this Solana token using ONLY the data below. Do not invent numbers.

Token: ${token.baseToken.symbol} (${token.baseToken.name})
Age: ${fmtAgeMinutes(token.ageMinutes)}
Price USD: ${fmtPrice(token.priceUsd)}
Market Cap: $${token.marketCap ?? 'unknown'}
Liquidity USD: $${token.liquidity ?? 'unknown'}
Volume (1h): $${token.volume1h}
Buys (1h): ${token.buys1h} | Sells (1h): ${token.sells1h}
Price change (1h): ${token.priceChange1h}%
Rugcheck risk score: ${token.rugcheck.riskScore ?? 'unknown'}/100 (higher = riskier; 0-30 good, 30-60 medium, 60-100 high risk)
Top holder %: ${token.rugcheck.topHolderPct ?? 'unknown'}
Liquidity locked: ${token.rugcheck.liquidityLocked === true ? 'yes' : token.rugcheck.liquidityLocked === false ? 'no' : 'unknown'}
Hype Score (internal, 0-10): ${token.hypeScore}
Risk level (internal): ${token.riskLevel}
Narrative category (internal): ${token.narrativeTag}
${buildPredictionContextLine(token.prediction)}
${buildEdpiLiveContextLine(token.edpiLive)}${buildEdpiLContextLine(token.edpiL)}
Respond with ONLY one valid JSON object matching this exact schema:
{
  "assessmentVersion": "gemini-assessment-v1",
  "signalLabel": "BUY|WAIT|SKIP",
  "confidence": "low|medium|high",
  "momentum": "one concise sentence",
  "exitRange": "a conservative range such as 1.5x-2x, or unknown",
  "rationale": "one concise evidence-grounded sentence",
  "risks": ["short risk statement"],
  "invalidation": "one condition that would invalidate the assessment",
  "evidence": ["specific supplied metric or fact"]
}
Use ONLY supplied data. Do not invent numbers, accounts, social activity, or historical evidence. Do not use markdown, disclaimers, or additional keys.`;
}

/**
 * If a historical-pattern prediction exists for this token's category (see
 * patternAnalyzer.js), hands it to the model as one more grounded data
 * point — explicitly labeled as past behavior of OTHER tokens, not this
 * one, so the model doesn't conflate the two.
 */
function buildPredictionContextLine(prediction) {
  if (!prediction) return 'Historical pattern data: not enough past tokens in this category yet.';
  const roi = prediction.medianPeakRoiMultiple !== null ? `${prediction.medianPeakRoiMultiple.toFixed(1)}x` : 'unknown';
  const rugTime = prediction.medianTimeToRugFromAthHours !== null ? `${prediction.medianTimeToRugFromAthHours.toFixed(1)}h after peak` : 'unknown';
  return `Historical pattern data (${prediction.sampleSize} past tokens in this same narrative+hype category, NOT this token): median peak ROI ${roi}, median time-to-rug ${rugTime}, ${prediction.ruggedCount} rugged / ${prediction.survivedCount} survived.`;
}

/**
 * EDPI-L context line — deliberately OMITTED (returns '', not a
 * placeholder string) whenever `token.edpiLive` isn't present, rather
 * than printing something like "EDPI-L: not available." This is what
 * makes the config gate in tokenScanner.js/config.js
 * (edpiLive.geminiContextEnabled, default OFF) an ACTUAL no-op on the
 * prompt when disabled — buildPrompt's output is byte-for-byte
 * unchanged from before EDPI-L existed unless a caller explicitly
 * attaches `token.edpiLive`, which tokenScanner.js only does when that
 * config flag is on. See edpiLive.js's own header for why this
 * independent, more-conservative-by-default gate exists.
 *
 * Uses `evidence` (already a handful of short, human-readable strings —
 * see edpiLive.js's buildEvidence) rather than dumping the full nested
 * component/coverage object into the prompt: Gemini gets the same kind
 * of grounded, pre-summarized facts every other context line here
 * already gives it, not a JSON blob it has to interpret itself. Capped
 * at 5 lines even though `evidence` itself is already short, as a
 * deliberate belt-and-suspenders prompt-size guard.
 */
function buildEdpiLiveContextLine(edpiLive) {
  if (!edpiLive || !Array.isArray(edpiLive.evidence) || edpiLive.evidence.length === 0) return '';
  const lines = edpiLive.evidence.slice(0, 5);
  return `EDPI-L (internal wallet/holder intelligence, informational only — not a standalone recommendation):\n- ${lines.join('\n- ')}\n`;
}


/**
 * Structured EDPI-L scoring context. The deterministic application result is
 * authoritative; Gemini is explicitly instructed to interpret it rather than
 * recalculate it.
 */
function buildEdpiLContextLine(edpiL) {
  if (!edpiL) return '';
  return `EDPI-L deterministic result (authoritative; do not recalculate): score ${edpiL.edpi_l_score ?? 'unknown'}, strength ${edpiL.strength_label ?? 'unknown'}, active scoring classes ${edpiL.active_class_count ?? 0}, class scores C1=${edpiL.class_scores?.class_1 ?? 0}, C2=${edpiL.class_scores?.class_2 ?? 0}, C4=${edpiL.class_scores?.class_4 ?? 0}. Wallet evidence: ${edpiL.eligible_wallet_count ?? 0} eligible / ${edpiL.wallet_sample_size ?? 0} sampled / ${edpiL.insufficient_history_count ?? 0} insufficient history. Report-only EDPI evidence is supplied separately and must not be converted into additional points.
`;
}

/**
 * Calls Gemini to generate a short trading signal for a qualified token.
 * Returns plain text, or a safe fallback string if the call fails — a
 * failed AI call should never block the alert from being sent, since the
 * numeric filters already did the real safety gating.
 *
 * FIXED: both fallback strings used to open with a real label
 * ("SKIP — AI analysis unavailable." / "WAIT — AI analysis temporarily
 * unavailable..."). extractSignalLabel() below doesn't know or care
 * *why* a signal contains "WAIT" — it just extracts it — so an outage
 * placeholder was silently recorded as a genuine WAIT/SKIP decision and
 * counted toward that bucket's ROI stats in the self-assessment reports.
 * Neither fallback string may contain the words BUY, WAIT, or SKIP.
 */
// Plan A (signal_status): named constants instead of inline literals, so
// isFallbackText below (and tokenScanner.js, which calls it) can tell
// "the AI genuinely responded but said nothing parseable" apart from
// "the AI never responded at all" — see isFallbackText's own doc comment.
// Deliberately not changing generateSignal's return shape to something
// like {text, aiAvailable} to get this distinction: it's mocked as a
// plain string in ~20 places in test/regression.test.js, and every one
// of those call sites would need touching for no real gain.
const NO_CONTENT_FALLBACK_TEXT = 'AI analysis returned no content — review the raw metrics above manually.';
const API_ERROR_FALLBACK_TEXT = 'AI analysis temporarily unavailable — review the raw metrics above manually.';

async function generateSignal(token) {
  telemetry.increment('requests_total');
  try {
    const response = await ai.models.generateContent({
      model: gemini.model,
      contents: buildPrompt(token),
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: ASSESSMENT_RESPONSE_SCHEMA,
      },
    });

    const text = response.text;
    if (!text) {
      telemetry.increment('empty_response_total');
      return NO_CONTENT_FALLBACK_TEXT;
    }
    const raw = text.trim();
    const { packetFromSignal, extractJsonCandidate } = require('../core/geminiAssessment');
    const packet = packetFromSignal(raw);
    if (extractJsonCandidate(raw) && packet.signalLabel) telemetry.increment('structured_valid_total');
    else if (extractJsonCandidate(raw)) telemetry.increment('structured_invalid_total');
    else telemetry.increment('legacy_text_total');
    return raw;
  } catch (err) {
    telemetry.increment('request_errors_total');
    console.error(`[gemini] signal generation failed for ${token.baseToken.symbol}: ${err.message}`);
    return API_ERROR_FALLBACK_TEXT;
  }
}

/**
 * True if `text` is exactly one of generateSignal's own fallback strings —
 * i.e. the AI call itself never produced real model output, as opposed to
 * producing real output that just didn't contain a parseable BUY/WAIT/SKIP
 * (see extractSignalLabel below). Plan A (signal_status) uses this at the
 * tokenScanner.js call site to distinguish AI_UNAVAILABLE (this) from
 * AI_NO_VERDICT (real output, extractSignalLabel still came back null) —
 * an infra problem vs. a prompt/formatting problem, which have different
 * implications for what to actually do about them.
 *
 * Exact string equality, not a substring/regex check — these are fixed
 * literals generateSignal itself returns verbatim, never model output
 * that could merely resemble them.
 */
function isFallbackText(text) {
  return text === NO_CONTENT_FALLBACK_TEXT || text === API_ERROR_FALLBACK_TEXT;
}

const VALID_SIGNAL_LABELS = ['BUY', 'WAIT', 'SKIP'];

/**
 * Finds a label in `text`. Case-sensitive by default (the prompt demands
 * EXACTLY "BUY"/"WAIT"/"SKIP" in caps), optionally case-insensitive as a
 * looser fallback. Returns whichever label's LAST match starts latest in
 * the text, or null if none match.
 */
function findLastLabelMatch(text, caseInsensitive = false) {
  let bestLabel = null;
  let bestIndex = -1;
  for (const label of VALID_SIGNAL_LABELS) {
    const re = new RegExp(`\\b${label}\\b`, caseInsensitive ? 'gi' : 'g');
    let match;
    let lastIndex = -1;
    while ((match = re.exec(text)) !== null) lastIndex = match.index;
    if (lastIndex > bestIndex) {
      bestIndex = lastIndex;
      bestLabel = label;
    }
  }
  return bestLabel;
}

/**
 * Pulls a structured label out of the free-text signal returned by
 * generateSignal, for self-assessment tracking (see
 * core/selfAssessment.js) — the prompt asks the model for a final line
 * that's EXACTLY one of BUY/WAIT/SKIP, but this stays lenient about exact
 * placement rather than trusting formatting to always be perfect.
 *
 * IMPORTANT: this is scoped to the LAST LINE first, not the whole text.
 * The justification that follows the label routinely uses "buy"/"wait"/
 * "skip" as ordinary English (e.g. "...better to wait for more liquidity
 * before you buy in" after a SKIP call) — scanning the whole text for the
 * last occurrence of any label word picked up "buy" from that sentence
 * instead of the actual "SKIP" label. Restricting to the last line first
 * avoids that; the whole-text scan is only a fallback for the rare case
 * where the model didn't isolate the label onto its own line at all.
 *
 * @param {string} signalText
 * @returns {'BUY'|'WAIT'|'SKIP'|null} null if no label word is present at all
 */
function extractSignalLabel(signalText) {
  if (!signalText || typeof signalText !== 'string') return null;

  const lines = signalText.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || '';

  // Tier 1: last line, case-sensitive (the format the prompt asks for).
  const exact = findLastLabelMatch(lastLine, false);
  if (exact) return exact;

  // Tier 2: last line, case-insensitive — tolerates the model slipping on
  // casing while staying scoped to the label line, not the prose above it.
  const looseLine = findLastLabelMatch(lastLine, true);
  if (looseLine) return looseLine;

  // Tier 3: whole text, case-sensitive — only reached if the model never
  // isolated the label onto its own line. Kept case-sensitive so ordinary
  // lowercase mentions in the justification still can't win here.
  return findLastLabelMatch(signalText, false);
}

module.exports = {
  generateSignal,
  extractSignalLabel,
  isFallbackText,
  buildPrompt,
  buildEdpiLiveContextLine,
  buildEdpiLContextLine,
  ASSESSMENT_RESPONSE_SCHEMA,
};
