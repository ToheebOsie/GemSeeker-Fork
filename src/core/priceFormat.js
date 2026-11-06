/**
 * Formats a USD token price for human/LLM-readable display — always a
 * fixed-decimal string, NEVER JavaScript's default scientific notation.
 *
 * BUG THIS FIXES: raw string interpolation (`${priceUsd}`) relies on
 * JS's default Number -> String coercion, which silently switches to
 * exponential notation below 1e-6 (`3.821e-7`, not `0.0000003821`). Fresh
 * Solana memecoins routinely price in the 1e-7 to 1e-9 range (huge token
 * supply, tiny unit price) — exactly the tokens this bot exists to catch
 * early — so that raw interpolation showed real subscribers unreadable
 * prices on exactly the alerts that mattered most. Shared here (not a
 * private helper in alertFormatter.js) so the Telegram alert and the
 * Gemini prompt can't drift into disagreeing about how a price reads.
 *
 * Decimal count scales with magnitude so a small number still shows
 * meaningful digits — toFixed(2) on 3.8e-7 would just print "$0.00".
 */
function fmtPrice(n) {
  if (n === null || n === undefined || typeof n !== 'number' || Number.isNaN(n)) return 'unknown';
  if (n === 0) return '$0';

  const abs = Math.abs(n);
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;

  // Sub-cent — typical memecoin territory. Scale decimals to the
  // magnitude so this always shows ~4 significant figures, capped well
  // under toFixed's hard limit (100), instead of a fixed decimal count
  // that would just print "$0.0000000000" or lose all precision.
  const magnitude = Math.floor(Math.log10(abs));
  const decimals = Math.min(20, -magnitude + 3);
  return `$${n.toFixed(decimals)}`;
}

module.exports = { fmtPrice };
