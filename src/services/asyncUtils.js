/**
 * Small shared helpers for the social-signal scrapers. Originally lived
 * inline in twitterScraperService.js; pulled out here once
 * telegramScraperService.js and googleTrendsService.js needed the exact
 * same pattern too — three copies of a six-line function is the point
 * where "shared util" stops being premature abstraction.
 */

/**
 * Races `promise` against a timeout, rejecting with a labeled error if
 * `ms` elapses first. This is defense in depth, not just a nicety: an
 * unofficial/scraping-based client hanging on a slow or rate-limited
 * response is a real, observed failure mode (see
 * twitterScraperService.js's header comment on the 13-minute rate-limit
 * wait it guards against) — and per SCRAPERS.md's "isolated failure,
 * always" rule, tokenScanner.js's outer try/catch does NOT save you from
 * a promise that never resolves, only from one that rejects/throws.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
