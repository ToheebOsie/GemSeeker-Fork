const BASE_SCORE = 5;

/**
 * Computes a 0-10 "Hype Score" from market performance and Rugcheck safety
 * signals. Starts at a baseline and is nudged up/down — tune the weights
 * freely, they're intentionally simple and transparent rather than a black box.
 *
 * IMPORTANT: safety.riskScore is a RISK score (0-100, HIGHER = RISKIER).
 * A previous version of this function treated a high riskScore as a good
 * sign and rewarded it — that's what was causing likely-rug tokens to get
 * inflated hype scores. Fixed below: only LOW riskScore earns a bonus, and
 * the penalty scales with how risky Rugcheck says the token is.
 */
function computeHypeScore(token, safety) {
  let score = BASE_SCORE;

  // --- Positive signals (market activity) ---
  if (token.volume1h >= 20000) score += 1.5;
  else if (token.volume1h >= 5000) score += 0.75;

  const buySellRatio = token.sells1h > 0 ? token.buys1h / token.sells1h : token.buys1h;
  if (buySellRatio >= 3) score += 1;
  else if (buySellRatio >= 1.5) score += 0.5;

  if (token.priceChange1h >= 50) score += 1.5;
  else if (token.priceChange1h >= 15) score += 0.75;

  // --- Rugcheck-derived signals ---
  if (safety.available && safety.riskScore !== null) {
    if (safety.riskScore <= 20) score += 1;        // solidly in "Good" band
    else if (safety.riskScore <= 30) score += 0.5;  // top of "Good" band
    else if (safety.riskScore >= 60) score -= 2;    // "High risk / Danger" band
    else if (safety.riskScore >= 45) score -= 1;    // upper "Medium" band
  }

  // Liquidity lock: null means "unknown", which we treat as a mild negative
  // rather than assuming it's fine — an unlocked/unknown LP is one of the
  // clearest rug mechanisms (creator can pull liquidity at will).
  if (safety.available) {
    if (safety.liquidityLocked === false) score -= 1.5;
    else if (safety.liquidityLocked === null) score -= 0.5;
  }

  // Weight individual risk flags by Rugcheck's own severity level rather
  // than treating every flag the same.
  if (safety.available && Array.isArray(safety.risks) && safety.risks.length > 0) {
    const dangerCount = safety.risks.filter((r) => r.level === 'danger').length;
    const warnCount = safety.risks.length - dangerCount;
    score -= Math.min(dangerCount * 1 + warnCount * 0.4, 3);
  }

  if (token.priceChange1h <= -20) score -= 1.5;

  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

/**
 * Maps a hype score + safety signals to a risk classification. Rugcheck's
 * own risk banding takes priority here — strong market momentum should
 * never be able to fully mask a token Rugcheck already flagged as
 * High risk, which is what let rugs slip through as "Low Risk" before.
 */
function classifyRisk(hypeScore, safety) {
  if (safety.available && safety.riskScore !== null) {
    if (safety.riskScore >= 60) return 'High';   // Rugcheck "High risk / Danger" band
    if (safety.riskScore >= 30) {
      // Rugcheck "Medium" band — let a strong hype score lift it to Medium
      // at best, never Low.
      return hypeScore >= 8 ? 'Medium' : 'High';
    }
  }

  const highRiskCombo = safety.available
    && safety.liquidityLocked !== true // false OR unknown both count here
    && safety.topHolderPct !== null
    && safety.topHolderPct > 20;

  if (hypeScore <= 5 || highRiskCombo) return 'High';
  if (hypeScore <= 7) return 'Medium';
  return 'Low';
}

module.exports = {
  computeHypeScore,
  classifyRisk,
};
