const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { solana, payments } = require('../config');

const connection = new Connection(solana.rpcUrl, 'confirmed');

/**
 * Verifies a subscription payment transaction signature.
 *
 * Checks:
 *  1. The transaction exists and is confirmed/finalized.
 *  2. It transferred SOL, USDC, or USDT to PAYMENT_WALLET_ADDRESS specifically
 *     — for SPL tokens this is verified via actual pre/post balance deltas on
 *     our wallet, not by trusting an instruction's parsed fields, so a
 *     transfer signature involving some other destination can't be replayed
 *     against us.
 *  3. The USD-equivalent amount is at least the subscription price, minus
 *     a small tolerance for price movement between quote and confirmation.
 *  4. The signature hasn't been used before (replay protection — the
 *     caller is responsible for checking/reserving this via subscriberStore
 *     BEFORE calling this function, not just after, to avoid a
 *     check-then-act race between concurrent /verify calls).
 *  5. AUDIT FIX (front-running): if `expectedSenderAddress` is supplied, the
 *     transaction's fee payer must match it. Checks 1-4 alone only prove
 *     "this transaction paid our wallet enough" — they say nothing about
 *     WHO sent it, and a transaction signature is public the instant it
 *     confirms. Without this, anyone who spots a qualifying payment (a
 *     block-explorer watcher, or another bot user) could paste that
 *     signature into their OWN /verify and claim someone else's
 *     subscription — first claim wins, not first pay. See
 *     subscriberStore.bindOrCheckSenderWallet for how the caller uses this
 *     to bind a chat to the wallet that first pays for it.
 *
 *     Known limitation, on purpose: "sender" here means the transaction's
 *     FEE PAYER (accountKeys[0]) — correct for the common case of someone
 *     paying directly from their own wallet, but not necessarily the actual
 *     token owner for a payment routed through an exchange withdrawal or a
 *     smart-contract wallet that pays fees on a user's behalf (the same
 *     CPI-routed cases getAccountLamportDelta/getOwnerTokenBalanceDelta
 *     above are deliberately built to still detect as a valid PAYMENT).
 *     Those payments still count — this check only affects whether the
 *     declared sender can be used to BIND/verify identity for anti-sniping
 *     purposes; a mismatch here is reported with a distinct reason so a
 *     legitimate edge-case payer isn't left guessing why /verify failed.
 *
 * Returns { ok: true, amountUsd, asset, senderAddress } or { ok: false, reason }.
 */
async function verifyPaymentTransaction(signature, { solUsdPrice, expectedSenderAddress } = {}) {
  let tx;
  try {
    tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
  } catch (err) {
    return { ok: false, reason: `RPC lookup failed: ${err.message}` };
  }

  if (!tx) {
    return { ok: false, reason: 'Transaction not found (not confirmed yet, or invalid signature).' };
  }
  if (tx.meta && tx.meta.err) {
    return { ok: false, reason: 'Transaction failed on-chain.' };
  }

  const senderAddress = getTransactionSender(tx);

  // AUDIT FIX: checked BEFORE the destination/amount logic below — no point
  // evaluating payment candidates for a transaction whose declared sender
  // doesn't even match, and this keeps the rejection reason specific
  // (caller can tell "wrong sender" apart from "not enough money").
  if (expectedSenderAddress) {
    if (!senderAddress) {
      return { ok: false, reason: 'Could not determine this transaction\'s fee payer to check against the declared sender.' };
    }
    if (senderAddress !== expectedSenderAddress) {
      return {
        ok: false,
        reason: `Transaction fee payer (${senderAddress}) does not match the wallet address you declared (${expectedSenderAddress}). `
          + 'Make sure you\'re pasting the signature for a transaction sent FROM that wallet.',
      };
    }
  }

  const destination = new PublicKey(payments.walletAddress);
  const destinationBase58 = destination.toBase58();

  // Evaluate every asset independently and collect all positive deltas
  // before deciding anything — a transaction can contain more than one
  // positive balance change on our wallet at once (e.g. a real, sufficient
  // USDC payment plus an incidental tiny SOL increase from a wallet-app
  // quirk or rent-related side effect; or a tiny USDC dust delta alongside
  // a genuine USDT payment). Returning as soon as the FIRST positive delta
  // was found — regardless of whether it actually cleared the minimum
  // amount — used to reject a genuinely sufficient payment in a different
  // asset without ever checking it. This applied both between SOL and SPL,
  // and between USDC and USDT within the SPL check itself.
  const candidates = [];

  // 1. Native SOL: read the actual lamport balance change on our wallet's
  // account (preBalances/postBalances, indexed by position in accountKeys),
  // rather than scanning for a top-level System Program transfer instruction.
  //
  // FIXED: an earlier version only found a payment if it appeared as a
  // literal top-level `system` transfer instruction naming our wallet as
  // `destination`. That misses any SOL transfer routed through a CPI —
  // e.g. sent via a program, a smart-contract wallet, or an exchange
  // withdrawal flow — which would still land in our wallet (and show up in
  // preBalances/postBalances) but never appear as a top-level instruction.
  // This mirrors the same balance-delta approach used for SPL tokens below,
  // for the same reason: it reflects the real on-chain outcome regardless
  // of how the transfer was executed.
  const solDeltaLamports = getAccountLamportDelta(tx, destinationBase58);
  if (solDeltaLamports > 0) {
    if (solUsdPrice) {
      const amountSol = solDeltaLamports / LAMPORTS_PER_SOL;
      candidates.push({ asset: 'SOL', amountUsd: amountSol * solUsdPrice });
    } else {
      // A positive SOL delta exists but we can't price it — record this as
      // an unpriceable candidate rather than failing immediately, in case
      // a different asset in the same transaction is sufficient on its own.
      candidates.push({ asset: 'SOL', amountUsd: null, reason: 'SOL payment detected but no SOL/USD price was supplied to convert it.' });
    }
  }

  // 2. SPL token transfers (USDC/USDT). Same balance-delta approach as
  // above — read the actual pre/post token-balance change for OUR wallet
  // specifically, rather than trusting an instruction's parsed fields.
  //
  // FIXED: an earlier version scanned instructions for "any SPL transfer
  // of an accepted mint" and never checked where the tokens actually
  // went — so any USDC/USDT transfer signature of sufficient size, sent
  // anywhere on Solana by anyone, would pass. Balance deltas are also more
  // correct in general, since they reflect the real outcome of the
  // transaction even if the transfer happened via a CPI (e.g. routed
  // through a program) rather than a top-level spl-token instruction.
  for (const [assetName, mint] of Object.entries(payments.acceptedMints)) {
    const delta = getOwnerTokenBalanceDelta(tx, destinationBase58, mint);
    if (delta > 0) {
      candidates.push({ asset: assetName, amountUsd: delta });
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: 'No recognized SOL or USDC/USDT transfer to the payment wallet found in this transaction.' };
  }

  // Accept as soon as any single candidate clears the minimum on its own.
  // Payment is expected in one asset, not summed across several — a tiny
  // incidental delta in a second asset should never combine with a real
  // payment to inflate the effective amount, so candidates are checked
  // independently, never added together.
  for (const candidate of candidates) {
    if (candidate.amountUsd === null) continue; // e.g. SOL found but no price available to convert it
    const result = finalizeVerification(candidate.amountUsd, candidate.asset);
    if (result.ok) return { ...result, senderAddress };
  }

  // Nothing cleared the minimum. Report every candidate that was found so
  // this is clearly distinguishable from "no payment found at all" —
  // useful both for the person retrying and for debugging a support report.
  const details = candidates
    .map((c) => (c.amountUsd === null ? `${c.asset}: ${c.reason}` : `${c.asset}: $${c.amountUsd.toFixed(2)}`))
    .join('; ');
  return { ok: false, reason: `No candidate payment met the required amount. Found — ${details}` };
}

/**
 * AUDIT FIX (front-running): the transaction's fee payer — by convention
 * (and by the Solana runtime's own rule) always accountKeys[0], and always
 * a signer. Used as the "declared sender" identity for binding a chatId to
 * the wallet that first pays for it — see verifyPaymentTransaction's
 * docstring for what this does and doesn't guarantee.
 *
 * Handles both accountKeys shapes getAccountLamportDelta already handles
 * (plain pubkey strings, or jsonParsed `{ pubkey, signer, writable }`
 * objects), for the same reason.
 *
 * @returns {string|null} base58 address, or null if the transaction has no
 *   discoverable accountKeys at all (shouldn't happen for a real
 *   confirmed transaction, but fail safe rather than throw).
 */
function getTransactionSender(tx) {
  const accountKeys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
  const first = accountKeys[0];
  if (!first) return null;
  return typeof first === 'string' ? first : first.pubkey.toBase58();
}

/**
 * Computes how much the given account's native SOL balance increased by
 * across this transaction, in lamports, using the RPC's preBalances/
 * postBalances arrays (indexed by position in accountKeys). Returns 0 if
 * the account isn't referenced in this transaction at all.
 *
 * Handles both accountKeys shapes returned by different RPC
 * encodings/providers: an array of pubkey strings, or (for jsonParsed
 * responses, which is what getParsedTransaction uses) an array of
 * `{ pubkey, signer, writable }` objects.
 */
function getAccountLamportDelta(tx, ownerBase58) {
  const accountKeys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
  const index = accountKeys.findIndex((key) => (
    typeof key === 'string' ? key === ownerBase58 : key.pubkey.toBase58() === ownerBase58
  ));
  if (index === -1) return 0;

  const preBalances = (tx.meta && tx.meta.preBalances) || [];
  const postBalances = (tx.meta && tx.meta.postBalances) || [];
  if (preBalances[index] === undefined || postBalances[index] === undefined) return 0;

  return postBalances[index] - preBalances[index];
}

/**
 * Computes how much `mint` the given owner's balance increased by across
 * this transaction, using the RPC's pre/post token-balance snapshots
 * (each entry includes `owner`, `mint`, and `uiTokenAmount`). Returns 0 if
 * the owner has no balance entry for that mint in either snapshot (e.g.
 * they received none of it, or it's a token account that didn't exist
 * before this tx).
 *
 * Sums across ALL of the owner's matching token accounts rather than
 * taking just the first — a wallet can legitimately hold more than one
 * token account for the same mint, and a payment could land in any of
 * them. Taking only the first match risked a false-negative rejection of
 * a genuine payment that happened to land in a non-first account.
 */
function rawTokenAmount(balance) {
  const raw = balance?.uiTokenAmount?.amount;
  if (raw !== undefined && raw !== null && raw !== '') {
    try { return BigInt(String(raw)); } catch (_) { return 0n; }
  }
  const ui = Number(balance?.uiTokenAmount?.uiAmount);
  const decimals = Number(balance?.uiTokenAmount?.decimals);
  if (!Number.isFinite(ui) || !Number.isInteger(decimals) || decimals < 0) return 0n;
  return BigInt(Math.round(ui * (10 ** decimals)));
}

function tokenDecimals(balanceList, ownerBase58, mint) {
  const row = balanceList.find((b) => b.owner === ownerBase58 && b.mint === mint);
  const decimals = Number(row?.uiTokenAmount?.decimals);
  return Number.isInteger(decimals) && decimals >= 0 ? decimals : null;
}

function humanTokenAmount(balance) {
  const raw = balance?.uiTokenAmount?.amount;
  const decimals = Number(balance?.uiTokenAmount?.decimals);
  if (raw !== undefined && raw !== null && raw !== '' && Number.isInteger(decimals) && decimals >= 0) {
    try { return Number(BigInt(String(raw))) / (10 ** decimals); } catch (_) { return 0; }
  }
  const ui = Number(balance?.uiTokenAmount?.uiAmount);
  return Number.isFinite(ui) ? ui : 0;
}

/**
 * Computes the owner's SPL-token delta in HUMAN units while doing the
 * underlying arithmetic on the RPC's exact integer `uiTokenAmount.amount`.
 * This keeps the legacy payment-verifier API numeric while removing the
 * floating-point balance summation from the calculation itself.
 */
function getOwnerTokenBalanceDelta(tx, ownerBase58, mint) {
  const pre = (tx.meta && tx.meta.preTokenBalances) || [];
  const post = (tx.meta && tx.meta.postTokenBalances) || [];
  const preMatches = pre.filter((b) => b.owner === ownerBase58 && b.mint === mint);
  const postMatches = post.filter((b) => b.owner === ownerBase58 && b.mint === mint);
  const decimals = tokenDecimals(post, ownerBase58, mint) ?? tokenDecimals(pre, ownerBase58, mint);
  if (decimals === null) {
    return postMatches.reduce((sum, b) => sum + humanTokenAmount(b), 0) - preMatches.reduce((sum, b) => sum + humanTokenAmount(b), 0);
  }
  const preRaw = preMatches.reduce((sum, b) => sum + rawTokenAmount(b), 0n);
  const postRaw = postMatches.reduce((sum, b) => sum + rawTokenAmount(b), 0n);
  return Number(postRaw - preRaw) / (10 ** decimals);
}

/**
 * Generalized version of getOwnerTokenBalanceDelta: returns exact balance
 * arithmetic per owner for the requested mint, then exposes the legacy
 * human-unit numeric result. The new transaction-economics resolver uses
 * raw BigInt internally and therefore does not depend on this compatibility
 * helper for trade reconstruction.
 */
function getAllOwnerTokenDeltasForMint(tx, mint) {
  const pre = (tx.meta && tx.meta.preTokenBalances) || [];
  const post = (tx.meta && tx.meta.postTokenBalances) || [];
  const owners = new Set([
    ...pre.filter((b) => b.mint === mint).map((b) => b.owner),
    ...post.filter((b) => b.mint === mint).map((b) => b.owner),
  ]);
  const deltas = {};
  for (const owner of owners) {
    if (!owner) continue;
    const preMatches = pre.filter((b) => b.owner === owner && b.mint === mint);
    const postMatches = post.filter((b) => b.owner === owner && b.mint === mint);
    const decimals = tokenDecimals(post, owner, mint) ?? tokenDecimals(pre, owner, mint);
    if (decimals === null) {
      deltas[owner] = postMatches.reduce((sum, b) => sum + humanTokenAmount(b), 0) - preMatches.reduce((sum, b) => sum + humanTokenAmount(b), 0);
    } else {
      const preRaw = preMatches.reduce((sum, b) => sum + rawTokenAmount(b), 0n);
      const postRaw = postMatches.reduce((sum, b) => sum + rawTokenAmount(b), 0n);
      deltas[owner] = Number(postRaw - preRaw) / (10 ** decimals);
    }
  }
  return deltas;
}

function finalizeVerification(amountUsd, asset) {
  const minAcceptable = payments.priceUsd * (1 - payments.priceTolerancePct / 100);
  if (amountUsd < minAcceptable) {
    return { ok: false, reason: `Payment amount too low: $${amountUsd.toFixed(2)} < $${minAcceptable.toFixed(2)} required.` };
  }
  return { ok: true, amountUsd, asset };
}

module.exports = {
  connection,
  verifyPaymentTransaction,
  getAccountLamportDelta, // exported for testing, and reused directly by scripts/backfill-early-wallets.js
  getOwnerTokenBalanceDelta, // exported for testing
  getAllOwnerTokenDeltasForMint, // reused by scripts/backfill-early-wallets.js (item 29)
  getTransactionSender, // exported for testing
};
