'use strict';

// Outbound Bot API sends share one process-wide throttle/circuit breaker. The
// notification worker normally has one bot instance, but module scope prevents
// multiple instances from independently retrying a 429.
let sendRateLimitedUntil = 0;

function retryAfterMs(value) {
  if (value === undefined || value === null) return null;
  const seconds = Number(String(value).trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Small Telegram Bot API adapter for GemSeeker.
 *
 * It intentionally implements only the stable surface used by this project:
 * sendMessage, onText, polling, and stopPolling. Native fetch removes the
 * deprecated request/request-promise dependency chain formerly pulled in by
 * node-telegram-bot-api.
 */
class TelegramBotApi {
  constructor(token, {
    polling = false,
    apiRoot = 'https://api.telegram.org',
    pollingTimeoutSeconds = 25,
    // How long to wait before retrying getUpdates after a failure, and how
    // much that grows on consecutive failures (doubling, capped at
    // pollErrorMaxDelayMs, plus a little jitter so a fleet of instances
    // recovering from the same outage doesn't all hammer Telegram in
    // lockstep). Reset to pollErrorBaseDelayMs the moment a poll succeeds —
    // this is about riding out a bad patch, not permanently slowing down.
    pollErrorBaseDelayMs = 1000,
    pollErrorMaxDelayMs = 30000,
    // Upper bound for any single non-polling API call (sendMessage,
    // deleteWebhook, ...). Without it a slow or black-holed Telegram
    // connection leaves fetch() pending indefinitely: the notification
    // worker's send never settles, its delivery row stays parked at
    // 'sending', and (worker ticks are serialized on the in-flight promise)
    // every later notification queues up behind it. Calls that pass their own
    // AbortSignal (pollOnce's long-poll) keep that signal instead.
    requestTimeoutMs = 30000,
    sendRateLimitMaxRetries = 2,
    sendRateLimitMaxBackoffMs = 30000,
  } = {}) {
    if (!token) throw new Error('Telegram bot token is required');
    this.token = token;
    this.apiRoot = apiRoot.replace(/\/$/, '');
    this.pollingTimeoutSeconds = pollingTimeoutSeconds;
    this.pollErrorBaseDelayMs = pollErrorBaseDelayMs;
    this.pollErrorMaxDelayMs = pollErrorMaxDelayMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sendRateLimitMaxRetries = sendRateLimitMaxRetries;
    this.sendRateLimitMaxBackoffMs = sendRateLimitMaxBackoffMs;
    this.textHandlers = [];
    this.eventHandlers = new Map();
    this.sentMessages = [];
    this._simulationDepth = 0;
    this.offset = 0;
    this.stopped = true;
    this._consecutivePollErrors = 0;
    this._recoveryAttemptedForStreak = false;
    this._currentAbortController = null;
    this.pollingPromise = Promise.resolve();
    if (polling) this.pollingPromise = this.startPolling();
  }

  apiUrl(method) { return `${this.apiRoot}/bot${this.token}/${method}`; }

  /**
   * Runs `work(signal)` under this.requestTimeoutMs unless the caller already
   * supplied its own signal. The timer covers the whole exchange — connect,
   * response headers AND the body read (aborting the signal rejects a pending
   * body read too) — and is always cleared. A timeout surfaces as a normal
   * Error with code 'ETIMEDOUT' so callers' existing failure paths (the
   * notification worker marks the delivery failed and the job retries) treat
   * it like any other transport failure.
   */
  async _withTimeout(method, signal, work) {
    if (signal || !(this.requestTimeoutMs > 0)) return work(signal);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.requestTimeoutMs);
    try {
      return await work(controller.signal);
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error(`Telegram ${method} timed out after ${this.requestTimeoutMs}ms`);
        timeoutError.code = 'ETIMEDOUT';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async _callOnce(method, body = {}, { signal } = {}) {
    return this._withTimeout(method, signal, async (effectiveSignal) => {
      const response = await fetch(this.apiUrl(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: effectiveSignal,
      });
      let payload;
      try { payload = await response.json(); } catch (error) {
        if (effectiveSignal?.aborted) throw error; // timeout/abort, not a malformed body — let _withTimeout classify it
        throw new Error(`Telegram ${method} returned non-JSON HTTP ${response.status}`);
      }
      if (!response.ok || !payload.ok) {
        const description = payload?.description || `HTTP ${response.status}`;
        const error = new Error(`Telegram ${method} failed: ${description}`);
        error.statusCode = response.status;
        error.telegramErrorCode = payload?.error_code;
        error.retryAfterMs = retryAfterMs(payload?.parameters?.retry_after ?? response.headers?.get?.('retry-after'));
        throw error;
      }
      return payload.result;
    });
  }

  async call(method, body = {}, { signal } = {}) {
    // Long polling has its own failure backoff and caller-owned AbortSignal;
    // ordinary outbound API calls use the shared 429 limiter.
    if (method === 'getUpdates' || signal) return this._callOnce(method, body, { signal });
    for (let attempt = 0; ; attempt += 1) {
      const now = Date.now();
      if (now < sendRateLimitedUntil) await sleep(sendRateLimitedUntil - now);
      try {
        return await this._callOnce(method, body);
      } catch (error) {
        if (error.telegramErrorCode !== 429 || attempt >= this.sendRateLimitMaxRetries) throw error;
        const requested = error.retryAfterMs ?? (1000 * (2 ** attempt));
        const delay = Math.min(this.sendRateLimitMaxBackoffMs, Math.max(50, requested));
        sendRateLimitedUntil = Math.max(sendRateLimitedUntil, Date.now() + delay);
      }
    }
  }

  async sendMessage(chatId, text, options = {}) {
    if (this._simulationDepth > 0) {
      const result = { message_id: this.sentMessages.length + 1, chat: { id: chatId }, text };
      this.sentMessages.push({ chatId, text, opts: options });
      return result;
    }
    const result = await this.call('sendMessage', { chat_id: chatId, text, ...options });
    this.sentMessages.push({ chatId, text, opts: options });
    return result;
  }

  async sendDocument(chatId, document, options = {}) {
    if (!document || !document.filename || typeof document.content !== 'string') throw new TypeError('sendDocument requires filename and string content');
    if (this._simulationDepth > 0) {
      const result = { message_id: this.sentMessages.length + 1, chat: { id: chatId }, document: { file_name: document.filename } };
      this.sentMessages.push({ chatId, document: document.filename, caption: options.caption || null, content: document.content });
      return result;
    }
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (options.caption) form.append('caption', options.caption);
    if (options.parse_mode) form.append('parse_mode', options.parse_mode);
    form.append('document', new Blob([document.content], { type: 'application/x-ndjson' }), document.filename);
    const result = await this._withTimeout('sendDocument', undefined, async (signal) => {
      const response = await fetch(this.apiUrl('sendDocument'), { method: 'POST', body: form, signal });
      let payload;
      try { payload = await response.json(); } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`Telegram sendDocument returned non-JSON HTTP ${response.status}`);
      }
      if (!response.ok || !payload.ok) throw new Error(`Telegram sendDocument failed: ${payload?.description || `HTTP ${response.status}`}`);
      return payload.result;
    });
    this.sentMessages.push({ chatId, document: document.filename, caption: options.caption || null });
    return result;
  }

  onText(pattern, handler) {
    if (!(pattern instanceof RegExp)) throw new TypeError('onText pattern must be a RegExp');
    if (typeof handler !== 'function') throw new TypeError('onText handler must be a function');
    this.textHandlers.push({ pattern, handler });
    return this;
  }

  on(eventName, handler) {
    if (typeof handler !== 'function') throw new TypeError('event handler must be a function');
    if (!this.eventHandlers.has(eventName)) this.eventHandlers.set(eventName, []);
    this.eventHandlers.get(eventName).push(handler);
    return this;
  }

  /**
   * Fires registered `on(eventName, ...)` handlers for internal lifecycle
   * events ('polling_tick' on every successful getUpdates cycle,
   * 'polling_error' on every failed one) — this is how a caller (e.g.
   * telegramBot.js) can wire polling health into observability
   * (src/observability/workerHealth.js) without this generic transport
   * class needing to know that module exists. Deliberately fire-and-forget:
   * a broken observability handler must never be able to take down
   * polling itself, so both a synchronous throw and an async rejection
   * from a handler are caught and logged here, never propagated.
   */
  emit(eventName, payload) {
    const handlers = this.eventHandlers.get(eventName) || [];
    for (const handler of handlers) {
      try {
        const result = handler(payload);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => console.error(`[telegram] ${eventName} handler failed: ${error.message}`));
        }
      } catch (error) {
        console.error(`[telegram] ${eventName} handler failed: ${error.message}`);
      }
    }
  }

  /**
   * Clears any webhook registered for this bot token. Telegram refuses
   * getUpdates entirely (409 "Conflict: can't use getUpdates method while
   * webhook is active") while a webhook is set, and nothing else in this
   * codebase — which only ever uses long-polling, never webhooks — would
   * clear one left over from manual testing (e.g. a stray `setWebhook`
   * curl call) or a previous deployment. Safe to call unconditionally: a
   * no-op (still `ok: true`) when no webhook is set.
   */
  async deleteWebhook({ dropPendingUpdates = false } = {}) {
    if (this._simulationDepth > 0) return true;
    return this.call('deleteWebhook', { drop_pending_updates: dropPendingUpdates });
  }

  async simulateMessage(text, msgOverrides = {}) {
    for (const { pattern, handler } of this.textHandlers) {
      const match = pattern.exec(text);
      if (match) {
        const msg = { chat: { id: msgOverrides.chatId ?? 1, username: msgOverrides.username ?? 'testuser' }, ...msgOverrides };
        this._simulationDepth += 1;
        try { return await handler(msg, match); } finally { this._simulationDepth -= 1; }
      }
    }
    throw new Error(`No registered handler matched: ${text}`);
  }

  async processUpdate(update) {
    const handlers = this.eventHandlers.get(update?.message ? 'message' : update?.callback_query ? 'callback_query' : null) || [];
    for (const handler of handlers) await handler(update.message || update.callback_query || update);
    const text = update?.message?.text;
    if (typeof text !== 'string') return;
    // Preserve the legacy client’s behavior: every matching registration runs.
    for (const { pattern, handler } of this.textHandlers) {
      const match = pattern.exec(text);
      if (match) await handler(update.message, match);
    }
  }

  async pollOnce() {
    // Tracked on the instance (not just a local const) so stopPolling() can
    // abort THIS specific in-flight request immediately rather than
    // blocking a graceful shutdown for up to pollingTimeoutSeconds+10s
    // waiting for it to time out on its own.
    const controller = new AbortController();
    this._currentAbortController = controller;
    const timer = setTimeout(() => controller.abort(), (this.pollingTimeoutSeconds + 10) * 1000);
    try {
      const updates = await this.call('getUpdates', {
        offset: this.offset,
        timeout: this.pollingTimeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      }, { signal: controller.signal });
      for (const update of updates || []) {
        this.offset = Math.max(this.offset, Number(update.update_id) + 1);
        try { await this.processUpdate(update); } catch (error) { console.error(`[telegram] update ${update.update_id} failed: ${error.message}`); }
      }
      // A successful cycle means whatever was wrong before (network blip,
      // transient 5xx, momentary conflict) has cleared — reset the backoff
      // and the once-per-streak recovery guard so the NEXT failure streak
      // starts fresh rather than inheriting an already-maxed-out delay.
      this._consecutivePollErrors = 0;
      this._recoveryAttemptedForStreak = false;
      this.emit('polling_tick', { updateCount: (updates || []).length });
    } finally {
      clearTimeout(timer);
      if (this._currentAbortController === controller) this._currentAbortController = null;
    }
  }

  /**
   * How long to wait before the next getUpdates attempt after `attempt`
   * consecutive failures. Doubles each time (1s, 2s, 4s, ... capped at
   * pollErrorMaxDelayMs) instead of the old flat 1s retry, which just
   * hammered Telegram's API every second for as long as the underlying
   * problem lasted (an invalid token, a conflicting second poller, a
   * genuine outage) with no growth at all. A little random jitter avoids
   * every instance in a fleet retrying in exact lockstep.
   */
  computePollBackoffMs(attempt) {
    const exponential = this.pollErrorBaseDelayMs * (2 ** Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * 250);
    return Math.min(this.pollErrorMaxDelayMs, exponential + jitter);
  }

  /**
   * A setTimeout-based delay that stopPolling() can cut short immediately
   * (see there) — plain `await new Promise((r) => setTimeout(r, ms))`,
   * used for the backoff wait between failed polls, would otherwise leave
   * a shutdown blocked for up to pollErrorMaxDelayMs if it happens to land
   * while polling is already in an error-backoff state, the same class of
   * "shutdown silently waits on a timer nothing can cancel" gap pollOnce's
   * AbortController fixes for the in-flight request itself.
   */
  _cancellableDelay(ms) {
    return new Promise((resolve) => {
      this._backoffResolve = resolve;
      this._backoffTimer = setTimeout(() => {
        this._backoffTimer = null;
        this._backoffResolve = null;
        resolve();
      }, ms);
    });
  }

  async startPolling() {
    if (!this.stopped) return this.pollingPromise;
    this.stopped = false;
    this.pollingPromise = (async () => {
      // Defensive, not curative: if this token's ONLY problem is a stray
      // webhook (manual testing, a previous deployment mode), this clears
      // it before the first getUpdates call ever runs, instead of that
      // call failing with a 409 it could never recover from on its own —
      // see deleteWebhook()'s own comment. A failure here (network hiccup,
      // bad token — which the first getUpdates call below will report
      // properly anyway) must never block polling from starting at all.
      try {
        await this.deleteWebhook();
      } catch (error) {
        console.error(`[telegram] startup deleteWebhook failed (continuing to poll anyway): ${error.message}`);
      }

      while (!this.stopped) {
        try {
          await this.pollOnce();
        } catch (error) {
          if (this.stopped && error.name === 'AbortError') {
            // Expected: stopPolling() aborted our in-flight request as
            // part of a clean shutdown, not a real polling failure.
            break;
          }
          if (!this.stopped) {
            this._consecutivePollErrors += 1;
            this.emit('polling_error', { error, consecutiveFailures: this._consecutivePollErrors });

            if (error.telegramErrorCode === 401) {
              // Won't resolve on its own — retrying rapidly is pure noise
              // until someone fixes TELEGRAM_BOT_TOKEN.
              console.error(`[telegram] polling unauthorized (401, attempt ${this._consecutivePollErrors}) — TELEGRAM_BOT_TOKEN is missing, invalid, or revoked; this will not resolve without operator action: ${error.message}`);
            } else if (error.telegramErrorCode === 409) {
              console.error(`[telegram] polling conflict (409, attempt ${this._consecutivePollErrors}) — another process is calling getUpdates with this same bot token, or a webhook is set: ${error.message}`);
              // Try the one thing we CAN self-heal (a stray webhook) once
              // per failure streak, not on every retry — if this is
              // actually a second live poller, deleteWebhook is a no-op
              // and spamming it adds nothing but log noise.
              if (!this._recoveryAttemptedForStreak) {
                this._recoveryAttemptedForStreak = true;
                try {
                  await this.deleteWebhook();
                } catch (recoveryError) {
                  console.error(`[telegram] deleteWebhook recovery attempt failed: ${recoveryError.message}`);
                }
              }
            } else {
              console.error(`[telegram] polling failed (attempt ${this._consecutivePollErrors}): ${error.message}`);
            }

            const delay = this.computePollBackoffMs(this._consecutivePollErrors);
            await this._cancellableDelay(delay);
          }
        }
      }
    })();
    return this.pollingPromise;
  }

  async stopPolling() {
    this.stopped = true;
    // Cancel whatever getUpdates call is currently in flight instead of
    // leaving stopPolling() to block for up to pollingTimeoutSeconds+10s
    // waiting for it to finish or time out on its own — see pollOnce's
    // comment.
    if (this._currentAbortController) this._currentAbortController.abort();
    // And if polling happened to be sitting in an error-backoff wait
    // instead, cut that short too rather than blocking up to
    // pollErrorMaxDelayMs — see _cancellableDelay's comment.
    if (this._backoffTimer) {
      clearTimeout(this._backoffTimer);
      this._backoffTimer = null;
    }
    if (this._backoffResolve) {
      this._backoffResolve();
      this._backoffResolve = null;
    }
    await this.pollingPromise;
  }
}

module.exports = TelegramBotApi;
