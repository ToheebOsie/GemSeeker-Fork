const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { socialSignals } = require('../config');
const { buildNeedlePatterns } = require('./redditService');
const { withTimeout } = require('./asyncUtils');

/**
 * Real (not stubbed) Telegram mention-counting, via the MTProto
 * **user**-account API — a bot token (what src/bot/telegramBot.js uses)
 * fundamentally cannot read messages in public channels/groups it
 * hasn't been added to as a member/admin, so this needs a real logged-in
 * user session instead, same as this file's previous placeholder header
 * comment explained.
 *
 * LIBRARY CHOICE: `teleproto`, not `gramjs`/`telegram` (the classic
 * package this feature is usually built with). As of this writing, npm
 * flags the `telegram` package itself as **archived, no longer
 * maintained**, pointing at `teleproto` as "a largely compatible,
 * actively maintained fork" — same relationship as
 * `@the-convocation/twitter-scraper` replacing the deprecated
 * `agent-twitter-client` for the Twitter/X source. If a future `telegram`
 * release resumes maintenance, swapping back is a near drop-in — the
 * shape used here (`TelegramClient`, `StringSession`, `.connect()`,
 * `.getMessages()`) is the same one both packages share.
 *
 * SESSION SETUP — the one genuinely manual step: this file connects with
 * an already-established session string, but a session string has to be
 * created once by actually logging in interactively (phone number +
 * code, and a 2FA password if the account has one). That can't safely
 * happen inside this function — see the login-lifecycle note below — so
 * it's a separate one-time script instead: run
 *
 *   node scripts/telegram-session-login.js
 *
 * with TELEGRAM_API_ID and TELEGRAM_API_HASH set (get both, free, from
 * https://my.telegram.org — "API development tools"). It'll prompt for
 * your phone/code/password right there in the terminal, then print a
 * session string. Put that string in .env as TELEGRAM_SESSION_STRING and
 * you never need to run the login script again unless the session is
 * later revoked (e.g. from Telegram's own "active sessions" list) or
 * expires from prolonged disuse.
 *
 * IMPORTANT — login lifecycle: connect ONCE per process using the saved
 * session, cached at module scope (see ensureClient below), the same way
 * twitterScraperService.js's ensureLogin() caches its scraper — never
 * attempt a fresh interactive login inside getTelegramSignal itself.
 * Every qualifying token calling this would otherwise attempt to
 * establish a brand-new session, which (a) can't complete without a
 * human answering a phone-code prompt anyway, so it would just hang or
 * throw, and (b) is exactly the pattern that gets real accounts
 * rate-limited or banned, per this file's original placeholder warning.
 *
 * ACCOUNT RISK: same caution as Twitter/X — use a real Telegram account
 * you're comfortable putting at some risk, not your primary one. MTProto
 * user-account automation isn't Telegram's officially sanctioned way to
 * read channels at scale, even though the protocol itself is public.
 *
 * config.socialSignals.telegram.channels (src/config.js) is the list of
 * channel usernames (public channels only — without an invite link, a
 * private channel isn't reachable at all here) checked on every lookup.
 *
 * THE CONTRACT — unchanged from the placeholder this replaces:
 *  - Never throw out to the caller. Catch everything internally.
 *  - `available: false` means "no reading this cycle." `mentionCount`
 *    stays `null` whenever `available` is false; never coerced to 0.
 *  - Never return a fabricated mentionCount or topPosts entry.
 *  - Word-boundary matching via buildNeedlePatterns (redditService.js).
 *  - Channels are checked sequentially, not in parallel — Telegram, like
 *    Reddit/X, tends to throttle per-account, not per-request, so
 *    concurrent requests just get everything throttled together.
 *
 * @param {{ symbol?: string, name?: string }} baseToken
 * @param {string[]} [channels] - which channels to check; defaults to
 *   config.socialSignals.telegram.channels.
 * @returns {Promise<{
 *   available: boolean,
 *   mentionCount: number|null,
 *   topPosts: Array<{ title: string, score: number, createdAt: number }>,
 * }>}
 */

const CONNECT_TIMEOUT_MS = 10000; // matches twitterScraperService.js's order of magnitude
const CHANNEL_TIMEOUT_MS = 10000;
const MAX_MESSAGES_PER_CHANNEL = 100; // matches redditService.js's per-source limit

let client = null;
let connectPromise = null;

/**
 * Connects once, lazily, on first real use (nothing to connect to until
 * SOCIAL_TELEGRAM_ENABLED is actually on) — cached afterward, same
 * ensure-once-and-reuse shape as twitterScraperService.js's ensureLogin.
 * A failed connect clears the cached promise so the next call gets a
 * clean retry instead of a permanently cached rejection.
 */
async function ensureClient() {
  if (client && client.connected) return client;
  if (!connectPromise) {
    connectPromise = (async () => {
      const { apiId, apiHash, sessionString } = socialSignals.telegram;
      if (!apiId || !apiHash || !sessionString) {
        throw new Error(
          'TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_SESSION_STRING are not all set — '
          + 'run scripts/telegram-session-login.js once to generate a session string',
        );
      }
      const c = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 3,
      });
      await c.connect();
      const authorized = await c.isUserAuthorized().catch(() => false);
      if (!authorized) {
        throw new Error('TELEGRAM_SESSION_STRING is set but not authorized — it may have expired or been revoked; regenerate it with scripts/telegram-session-login.js');
      }
      client = c;
      return c;
    })().catch((err) => {
      connectPromise = null;
      throw err;
    });
  }
  return connectPromise;
}

/**
 * Fetches one channel's recent messages and filters to needle-matching
 * ones. Telegram's own server-side `search` param does substring/
 * full-text search, not word-boundary-aware matching — a short ticker
 * like "AI"/"GO" would still need the same client-side re-filter
 * redditService.js/twitterScraperService.js apply, so this pulls recent
 * messages unfiltered and matches client-side rather than relying on
 * `search` to do it correctly.
 *
 * Returns `null` (not an empty array) on failure, so the caller can
 * distinguish "this channel genuinely had zero matches" from "this
 * channel's fetch failed" — same shape as redditService.js's
 * getSubredditMentions.
 */
async function getChannelMentions(telegramClient, channel, needlePatterns) {
  try {
    const messages = await telegramClient.getMessages(channel, { limit: MAX_MESSAGES_PER_CHANNEL });
    return messages
      .filter((m) => typeof m.message === 'string' && m.message.length > 0)
      .filter((m) => needlePatterns.some((pattern) => pattern.test(m.message)))
      .map((m) => ({
        title: m.message,
        score: (m.views || 0) + (m.forwards || 0),
        // TL schema's Message.date is Unix SECONDS, not ms — verified
        // against the installed teleproto package source directly, not
        // assumed (same "check the actual library" approach
        // twitterScraperService.js used for .timestamp).
        createdAt: m.date ? m.date * 1000 : Date.now(),
      }));
  } catch (err) {
    console.error(`[telegram] lookup failed for channel ${channel}: ${err.message}`);
    return null;
  }
}

async function getTelegramSignal(baseToken, channels) {
  if (!socialSignals.telegram.enabled) {
    return { available: false, mentionCount: null, topPosts: [] };
  }

  const targetChannels = channels && channels.length > 0 ? channels : socialSignals.telegram.channels;
  if (!targetChannels || targetChannels.length === 0) {
    return { available: false, mentionCount: null, topPosts: [] };
  }

  const needlePatterns = buildNeedlePatterns(baseToken);
  if (needlePatterns.length === 0) {
    return { available: false, mentionCount: null, topPosts: [] };
  }

  let telegramClient;
  try {
    telegramClient = await withTimeout(ensureClient(), CONNECT_TIMEOUT_MS, '[telegram] connect');
  } catch (err) {
    console.error(`[telegram] connect failed: ${err.message}`);
    return { available: false, mentionCount: null, topPosts: [] };
  }

  let anySucceeded = false;
  let total = 0;
  const topPosts = [];

  for (const channel of targetChannels) {
    // eslint-disable-next-line no-await-in-loop
    const matches = await withTimeout(
      getChannelMentions(telegramClient, channel, needlePatterns),
      CHANNEL_TIMEOUT_MS,
      `[telegram] ${channel} lookup`,
    ).catch((err) => {
      // withTimeout itself rejecting (a genuine hang, not the
      // already-caught rejection getChannelMentions guards against)
      console.error(`[telegram] ${channel} lookup: ${err.message}`);
      return null;
    });
    if (matches) {
      anySucceeded = true;
      total += matches.length;
      topPosts.push(...matches);
    }
  }

  if (!anySucceeded) return { available: false, mentionCount: null, topPosts: [] };

  topPosts.sort((a, b) => b.score - a.score);
  return { available: true, mentionCount: total, topPosts: topPosts.slice(0, 5) };
}

module.exports = { getTelegramSignal };
