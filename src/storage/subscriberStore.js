const { query } = require('../db/pool');

/**
 * Postgres-backed subscriber store. Same exported function names/shapes as
 * the JSON-file version this replaces (Phase 1 of the V2 roadmap) — every
 * caller in this codebase only depends on that contract, not the storage
 * format, per that file's own original header comment.
 *
 * ONE REAL BEHAVIOR CHANGE, unavoidable: every function here now returns a
 * Promise, including the ones that used to be synchronous reads
 * (getSubscriber, getAllSubscribers) — there's no such thing as a
 * synchronous Postgres query. Every call site that read these without
 * `await` has been updated alongside this file (see telegramBot.js). If
 * you add a new call site, it must `await` these.
 *
 * Atomicity: the old write-queue (serializing all mutations through one
 * in-process Promise chain) only protected a single process instance —
 * its own comment flagged this as a gap. reserveTxSignature and
 * extendSubscription below now use real Postgres constraints/transactions
 * instead, which also protects against running more than one bot process.
 */

function rowToSubscriber(row) {
  if (!row) return null;
  return {
    chatId: row.chat_id,
    username: row.username,
    alertsSent: row.alerts_sent,
    // Preserve the exact shape callers have always seen: an ISO string or
    // null, never a Date object, never undefined.
    subscriptionExpiresAt: row.subscription_expires_at ? row.subscription_expires_at.toISOString() : null,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    verifiedSenderWallet: row.verified_sender_wallet ?? null,
  };
}

async function getSubscriber(chatId) {
  const { rows } = await query('SELECT * FROM subscribers WHERE chat_id = $1', [chatId]);
  return rowToSubscriber(rows[0]);
}

async function getAllSubscribers() {
  const { rows } = await query('SELECT * FROM subscribers ORDER BY chat_id');
  return rows.map(rowToSubscriber);
}

/**
 * Same semantics as the original: creates the subscriber with defaults if
 * they don't exist yet, otherwise merges `patch` onto the existing row —
 * `{...existing, ...patch}` in the old JS-object version. That means a key
 * *explicitly* set to null (e.g. `{ subscriptionExpiresAt: null }`, used
 * to clear an expiry) must actually be written as null, which is
 * different from the key being *absent* (leave the existing value
 * alone) — a plain COALESCE(new, existing) can't tell those two cases
 * apart, so this checks for key presence explicitly instead.
 */
async function upsertSubscriber(chatId, patch = {}) {
  const hasUsername = Object.prototype.hasOwnProperty.call(patch, 'username');
  const hasAlertsSent = Object.prototype.hasOwnProperty.call(patch, 'alertsSent');
  const hasExpiry = Object.prototype.hasOwnProperty.call(patch, 'subscriptionExpiresAt');

  const { rows } = await query(
    `INSERT INTO subscribers (chat_id, username, alerts_sent, subscription_expires_at, created_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (chat_id) DO UPDATE SET
       username = CASE WHEN $5 THEN $2 ELSE subscribers.username END,
       alerts_sent = CASE WHEN $6 THEN $3 ELSE subscribers.alerts_sent END,
       subscription_expires_at = CASE WHEN $7 THEN $4 ELSE subscribers.subscription_expires_at END
     RETURNING *`,
    [
      chatId,
      hasUsername ? patch.username : null,
      hasAlertsSent ? patch.alertsSent : 0,
      hasExpiry ? patch.subscriptionExpiresAt : null,
      hasUsername, hasAlertsSent, hasExpiry,
    ],
  );
  return rowToSubscriber(rows[0]);
}

async function incrementAlertCount(chatId) {
  const { rows } = await query(
    `UPDATE subscribers SET alerts_sent = alerts_sent + 1 WHERE chat_id = $1 RETURNING *`,
    [chatId],
  );
  return rowToSubscriber(rows[0]) || null;
}

async function isTxSignatureUsed(signature) {
  const { rows } = await query('SELECT 1 FROM used_tx_signatures WHERE signature = $1', [signature]);
  return rows.length > 0;
}

// Kept for backwards compatibility with anything still calling it directly,
// same as the original — prefer reserveTxSignature for new code.
async function markTxSignatureUsed(signature) {
  await query(
    `INSERT INTO used_tx_signatures (signature) VALUES ($1) ON CONFLICT (signature) DO NOTHING`,
    [signature],
  );
}

/**
 * Atomically checks-and-marks a signature as used. The original comment
 * describing the race this fixes still applies verbatim; the mechanism
 * changes from "one queued JSON write" to "the signature column's own
 * PRIMARY KEY constraint" — a genuinely simpler and stronger guarantee,
 * since it holds even across multiple process instances.
 *
 * Returns true if this call reserved the signature (caller should
 * proceed to verify), false if it was already used/reserved.
 */
async function reserveTxSignature(signature) {
  const { rows } = await query(
    `INSERT INTO used_tx_signatures (signature) VALUES ($1)
     ON CONFLICT (signature) DO NOTHING
     RETURNING signature`,
    [signature],
  );
  return rows.length > 0;
}

/**
 * Frees a previously-reserved signature, same as the original — call this
 * if verification fails after reserveTxSignature succeeded, so a
 * legitimate retry isn't permanently locked out.
 */
async function releaseTxSignature(signature) {
  await query('DELETE FROM used_tx_signatures WHERE signature = $1', [signature]);
}

/**
 * AUDIT FIX — payment front-running: previously /verify only checked that
 * a transaction paid our wallet, never who sent it, which meant anyone who
 * saw a valid payment signature (public the moment it confirms — before
 * the real payer may even have copied it into the bot) could paste it into
 * their OWN /verify and claim someone else's subscription: first claim
 * wins, not first pay.
 *
 * This is the DB half of the fix (see solanaService.getTransactionSender
 * and telegramBot.js's /verify handler for the rest): the FIRST wallet
 * that successfully verifies a payment for a given chatId gets bound to
 * it, atomically. Every later verification for that same chatId must come
 * from the SAME wallet, or it's rejected before the payment is even
 * counted — so once a real subscriber has paid once, an attacker sniping a
 * signature from a wallet that isn't already bound to that chatId can't
 * hijack their account. First-ever payment for a brand-new chatId is still
 * a race (there's nothing to bind against yet) — closing that fully would
 * need proof of wallet ownership (a signed-message challenge), which this
 * doesn't attempt. Narrowing "any signature, forever" down to "any
 * signature, but only until this account has paid once" is the fix in
 * scope here.
 *
 * Doesn't touch username/alerts_sent/subscription_expires_at — only
 * verified_sender_wallet is ever written by the ON CONFLICT branch, so
 * this is safe to call independently of extendSubscription.
 *
 * @returns {{ ok: true, wallet: string } | { ok: false, existing: string }}
 *   ok:false means a DIFFERENT wallet is already bound to this chatId —
 *   `existing` is that wallet, for the rejection message.
 */
async function bindOrCheckSenderWallet(chatId, senderAddress) {
  const { rows } = await query(
    `INSERT INTO subscribers (chat_id, username, alerts_sent, subscription_expires_at, created_at, verified_sender_wallet)
     VALUES ($1, NULL, 0, NULL, now(), $2)
     ON CONFLICT (chat_id) DO UPDATE SET
       verified_sender_wallet = CASE
         WHEN subscribers.verified_sender_wallet IS NULL THEN $2
         ELSE subscribers.verified_sender_wallet
       END
     RETURNING verified_sender_wallet`,
    [chatId, senderAddress],
  );
  const bound = rows[0].verified_sender_wallet;
  return bound === senderAddress ? { ok: true, wallet: bound } : { ok: false, existing: bound };
}

/**
 * Admin-only escape hatch: clears a chat's bound wallet so their NEXT
 * /verify can bind a new one — for the legitimate case of someone actually
 * switching wallets, who would otherwise be permanently locked out by
 * bindOrCheckSenderWallet above. See telegramBot.js's /resetwallet.
 */
async function resetSenderWallet(chatId) {
  const { rows } = await query(
    `UPDATE subscribers SET verified_sender_wallet = NULL WHERE chat_id = $1 RETURNING *`,
    [chatId],
  );
  return rowToSubscriber(rows[0]) || null;
}

/**
 * Atomically extends (or starts) a subscriber's subscription by `days`,
 * stacking on top of their current expiry if it's still in the future.
 *
 * This computes the stacking arithmetic entirely inside a single
 * INSERT ... ON CONFLICT statement rather than a separate
 * read-then-write. That distinction matters specifically for a
 * subscriber's FIRST payment: an earlier version of this function used
 * `SELECT ... FOR UPDATE` to lock the row before computing the new
 * expiry — which correctly serializes concurrent payments for an
 * *existing* subscriber, but has nothing to lock when the row doesn't
 * exist yet. Two concurrent first-time payments could both read "no
 * existing row", both independently compute `now + days`, and whichever
 * INSERT lost the ON CONFLICT race would silently overwrite the other's
 * value instead of stacking — one of the two payments granted no days at
 * all. Doing the GREATEST(...) comparison inside the SET clause instead
 * means it's evaluated against the row Postgres just resolved the
 * conflict against, which is atomic by construction — there's no gap
 * between reading and writing for a second transaction to land in,
 * whether the row existed before this call or not.
 */
async function extendSubscription(chatId, days) {
  const { rows } = await query(
    `INSERT INTO subscribers (chat_id, username, alerts_sent, subscription_expires_at, created_at)
     VALUES ($1, NULL, 0, now() + ($2 * interval '1 day'), now())
     ON CONFLICT (chat_id) DO UPDATE SET
       -- GREATEST ignores NULLs (a subscriber who exists but never paid
       -- has subscription_expires_at = NULL), falling back to now() —
       -- same "extend from current expiry if still active, else from
       -- now" semantics as before.
       subscription_expires_at = GREATEST(subscribers.subscription_expires_at, now()) + ($2 * interval '1 day')
     RETURNING *`,
    [chatId, days],
  );
  return rowToSubscriber(rows[0]);
}

module.exports = {
  getSubscriber,
  getAllSubscribers,
  upsertSubscriber,
  incrementAlertCount,
  isTxSignatureUsed,
  markTxSignatureUsed,
  reserveTxSignature,
  releaseTxSignature,
  extendSubscription,
  bindOrCheckSenderWallet,
  resetSenderWallet,
};
