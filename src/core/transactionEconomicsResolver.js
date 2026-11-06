'use strict';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000n;

const DEFAULT_STABLECOIN_MINTS = Object.freeze({
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
});

// A standard 165-byte SPL token account's rent-exempt minimum is 2,039,280
// lamports. A wallet-owned-token-account "funding" transfer at or below a
// small multiple of that is unambiguously account-creation rent, not trade
// value. Funding *above* it is real economic value leaving the wallet --
// most commonly, wrapping SOL into an already-existing WSOL account to use
// as swap input -- and must not be discarded, or every wallet that reuses
// one WSOL account across trades (instead of paying rent to open/close a
// fresh one every swap) would have its SOL-denominated trades silently
// vanish. See AUDIT_FOLLOWUP_2026-09-25.md.
const TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS = 2_039_280n;
const MECHANICAL_FUNDING_MAX_LAMPORTS = TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS * 3n;

function asBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') return 0n;
  try {
    return BigInt(String(value));
  } catch (_) {
    return 0n;
  }
}

function publicKeyString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  if (typeof value.pubkey === 'string') return value.pubkey;
  if (value.pubkey && typeof value.pubkey.toBase58 === 'function') return value.pubkey.toBase58();
  return null;
}

function accountKeys(tx) {
  return (tx?.transaction?.message?.accountKeys || []).map(publicKeyString);
}

function decimalsFromBalance(balance) {
  const d = Number(balance?.uiTokenAmount?.decimals);
  return Number.isInteger(d) && d >= 0 ? d : null;
}

function rawAmountFromBalance(balance) {
  const raw = balance?.uiTokenAmount?.amount;
  if (raw !== undefined && raw !== null && raw !== '') return asBigInt(raw);
  const ui = Number(balance?.uiTokenAmount?.uiAmount);
  const decimals = decimalsFromBalance(balance);
  if (Number.isFinite(ui) && decimals !== null) return asBigInt(Math.round(ui * (10 ** decimals)));
  return 0n;
}

function tokenBalanceRows(tx) {
  return [
    ...(tx?.meta?.preTokenBalances || []),
    ...(tx?.meta?.postTokenBalances || []),
  ];
}

/**
 * Exact wallet asset movement engine. The result is deliberately independent
 * of DEX program IDs: it reconstructs the wallet's net economic movements
 * from the transaction outcome first, then uses parsed transfers only to
 * separate native SOL fees/rent/wrapping mechanics from trade movement.
 */
function collectWalletAssetMovements(tx, walletAddress) {
  const wallet = publicKeyString(walletAddress);
  if (!wallet) return { assets: new Map(), targetAccounts: new Set(), evidence: [] };

  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const byMint = new Map();
  const tokenAccounts = new Map();

  const addTokenBalance = (row, sign) => {
    if (!row || !row.mint) return;
    // Record every token account's real owner -- including accounts that
    // belong to somebody else entirely -- so a later system transfer that
    // funds a *third party's* newly created token account (e.g. a referral
    // fee ATA a swap route creates on the trader's behalf) can be
    // recognized as such. Only the byMint economic-delta sum below stays
    // gated to the wallet we're resolving the trade for.
    const index = Number(row.accountIndex);
    const keys = accountKeys(tx);
    if (row.owner && Number.isInteger(index) && index >= 0 && keys[index] && !tokenAccounts.has(keys[index])) {
      tokenAccounts.set(keys[index], { owner: row.owner, mint: row.mint });
    }
    if (row.owner !== wallet) return;
    const raw = rawAmountFromBalance(row);
    const decimals = decimalsFromBalance(row);
    const current = byMint.get(row.mint) || { mint: row.mint, rawDelta: 0n, decimals: decimals ?? null, isWsol: row.mint === WSOL_MINT };
    current.rawDelta += sign * raw;
    if (current.decimals === null && decimals !== null) current.decimals = decimals;
    byMint.set(row.mint, current);
  };

  for (const row of pre) addTokenBalance(row, -1n);
  for (const row of post) addTokenBalance(row, 1n);

  const nativeDelta = nativeLamportDelta(tx, wallet);
  const feeLamports = asBigInt(tx?.meta?.fee);
  const nativeTransfer = nativeEconomicMovementFromParsedInstructions(tx, wallet, tokenAccounts);

  // Prefer explicit system transfers/create-account movements when available;
  // those let us exclude fee/rent/wrap funding rather than treating every
  // decrease in the fee payer's SOL balance as trade value.
  const walletTokenAccountLamports = tokenAccountLamportDelta(tx, tokenAccounts, wallet);
  let nativeRawDelta = nativeTransfer.available
    ? nativeTransfer.netLamports
    : nativeDelta + (isFeePayer(tx, wallet) ? feeLamports : 0n) + walletTokenAccountLamports;

  // A balance delta that consists only of the fee correction is not a trade
  // counter asset. This also prevents malformed/incomplete RPC fixtures from
  // manufacturing a tiny SOL counter movement when the wallet balances were
  // otherwise unchanged.
  if (!nativeTransfer.available && isFeePayer(tx, wallet) && nativeRawDelta !== 0n) {
    const feeOnly = nativeRawDelta > 0n ? nativeRawDelta === feeLamports : -nativeRawDelta === feeLamports;
    if (feeOnly) nativeRawDelta = 0n;
  }

  // A wallet can have no explicit system transfer in a program-routed swap.
  // In that case the fee-adjusted balance delta remains useful, but its
  // confidence is deliberately lower and rent is not guessed.
  const nativeEvidence = {
    mint: null,
    rawDelta: nativeRawDelta,
    decimals: 9,
    isWsol: false,
    asset: 'SOL',
    evidence: nativeTransfer.available ? 'parsed_system_transfers' : 'pre_post_balance_delta_fee_adjusted',
    rawBalanceDelta: nativeDelta.toString(),
    feeLamports: feeLamports.toString(),
    parsedTransferEvidence: nativeTransfer.evidence,
  };

  if (nativeRawDelta !== 0n) byMint.set('__NATIVE_SOL__', nativeEvidence);

  return {
    assets: byMint,
    tokenAccounts: new Map(tokenAccounts),
    evidence: nativeTransfer.evidence,
    nativeEconomicMovement: nativeTransfer,
  };
}

function tokenAccountLamportDelta(tx, tokenAccounts, wallet) {
  if (!tokenAccounts || tokenAccounts.size === 0) return 0n;
  const keys = accountKeys(tx);
  let delta = 0n;
  for (const [account, meta] of tokenAccounts.entries()) {
    if (!meta?.owner || meta.owner !== wallet || !account) continue;
    const index = keys.indexOf(account);
    if (index < 0) continue;
    const pre = tx?.meta?.preBalances?.[index];
    const post = tx?.meta?.postBalances?.[index];
    if (pre === undefined || post === undefined) continue;
    delta += asBigInt(post) - asBigInt(pre);
  }
  return delta;
}

function nativeLamportDelta(tx, wallet) {
  const keys = accountKeys(tx);
  const index = keys.indexOf(wallet);
  if (index < 0) return 0n;
  const pre = tx?.meta?.preBalances?.[index];
  const post = tx?.meta?.postBalances?.[index];
  if (pre === undefined || post === undefined) return 0n;
  return asBigInt(post) - asBigInt(pre);
}

function isFeePayer(tx, wallet) {
  return accountKeys(tx)[0] === wallet;
}

function parsedInstructions(tx) {
  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap((entry) => entry.instructions || []);
  return [...top, ...inner];
}

function parsedSplTransfers(tx) {
  const transfers = [];
  for (const ix of parsedInstructions(tx)) {
    const parsed = ix?.parsed;
    if (!parsed?.info || ix.program !== 'spl-token') continue;
    if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') continue;
    const info = parsed.info;
    transfers.push({
      type: parsed.type,
      source: publicKeyString(info.source),
      destination: publicKeyString(info.destination),
      mint: info.mint || info.tokenAmount?.mint || null,
      rawAmount: info.amount ?? info.tokenAmount?.amount ?? null,
      decimals: info.tokenAmount?.decimals ?? null,
    });
  }
  return transfers;
}

function nativeEconomicMovementFromParsedInstructions(tx, wallet, tokenAccounts) {
  let outgoing = 0n;
  let incoming = 0n;
  const evidence = [];
  let found = false;

  for (const ix of parsedInstructions(tx)) {
    const parsed = ix?.parsed;
    if (!parsed || ix.program !== 'system' || !parsed.info) continue;
    const type = parsed.type;
    const info = parsed.info;
    const source = publicKeyString(info.source);
    const destination = publicKeyString(info.destination);
    let lamports = asBigInt(info.lamports);
    if (lamports <= 0n) continue;

    // createAccount has the same lamports field, but the destination is often
    // a freshly created ATA/WSOL account. Funding the wallet's *own* such
    // account is mechanics only up to rent size (see
    // MECHANICAL_FUNDING_MAX_LAMPORTS above -- above that, it's a real wrap
    // for trade value). Funding *someone else's* token account is a
    // different case entirely: swap routes commonly create and rent-fund a
    // fee-recipient's ATA (e.g. a referral/platform fee split) on the
    // trader's behalf as an execution cost of the route. That is never the
    // trader's own economic counter asset, at any size, because the trader
    // never receives or controls what lands in an account they don't own.
    const destinationTokenAccount = destination ? tokenAccounts.get(destination) : null;
    const isOwnAccountRentFunding = destinationTokenAccount && destinationTokenAccount.owner === wallet
      && lamports <= MECHANICAL_FUNDING_MAX_LAMPORTS;
    const isThirdPartyAccountFunding = destinationTokenAccount && destinationTokenAccount.owner !== wallet;
    const mechanicalDestination = isOwnAccountRentFunding || isThirdPartyAccountFunding;
    if (mechanicalDestination) {
      evidence.push({
        type, source, destination, lamports: lamports.toString(),
        excluded: isThirdPartyAccountFunding ? 'third_party_token_account_funding' : 'wallet_owned_token_account_funding',
      });
      found = true;
      continue;
    }

    if (type === 'transfer' || type === 'createAccount') {
      if (source === wallet) {
        outgoing += lamports;
        evidence.push({ type, source, destination, lamports: lamports.toString(), direction: 'out' });
        found = true;
      } else if (destination === wallet) {
        incoming += lamports;
        evidence.push({ type, source, destination, lamports: lamports.toString(), direction: 'in' });
        found = true;
      }
    }
  }

  const outgoingTransfers = evidence.filter((item) => item.direction === 'out').length;
  const incomingTransfers = evidence.filter((item) => item.direction === 'in').length;
  const ambiguous = outgoingTransfers > 1 || incomingTransfers > 1 || (outgoingTransfers > 0 && incomingTransfers > 0);

  return {
    available: found,
    // Kept as a BigInt here deliberately: collectWalletAssetMovements uses
    // this value directly in BigInt arithmetic (nativeRawDelta comparisons
    // against 0n/feeLamports). It is stringified only where this whole
    // object gets embedded into persisted evidence -- see
    // serializableNativeMovement below.
    netLamports: incoming - outgoing,
    evidence,
    outgoingTransfers,
    incomingTransfers,
    ambiguous,
  };
}

// nativeEconomicMovementFromParsedInstructions's netLamports is a BigInt
// (kept that way for the internal arithmetic that consumes it -- see its
// own comment). This object is also embedded verbatim as evidence.native on
// every resolved trade, which recordEarlyWalletActivity later
// JSON.stringify's for persistence; JSON.stringify cannot serialize a raw
// BigInt. Convert just the one non-serializable field before embedding,
// without touching the original object other callers still use.
function serializableNativeMovement(native) {
  if (!native) return null;
  return { ...native, netLamports: native.netLamports.toString() };
}

function humanAmount(raw, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) && Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    // Convert through decimal string to avoid silently rounding large SPL
    // quantities before the final human-readable representation.
    const s = raw.toString();
    if (decimals === 0) return Number(s);
    const negative = s.startsWith('-');
    const digits = negative ? s.slice(1) : s;
    const padded = digits.padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals) || '0';
    const frac = padded.slice(-decimals).replace(/0+$/, '');
    const value = Number(frac ? `${whole}.${frac}` : whole);
    return negative ? -value : value;
  }
  return n / (10 ** decimals);
}

function assetKey(asset) {
  return asset?.mint || asset?.asset || null;
}

function positiveOrNull(n) {
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stablecoinName(mint, stablecoinMints) {
  for (const [name, address] of Object.entries(stablecoinMints)) if (address === mint) return name;
  return null;
}

function buildAsset(raw, { mint, decimals, isWsol = false, asset = null, evidence = null }) {
  const amount = humanAmount(raw < 0n ? -raw : raw, decimals);
  return {
    mint: mint || null,
    asset: asset || (isWsol ? 'WSOL' : null),
    amount,
    rawAmount: (raw < 0n ? -raw : raw).toString(),
    decimals,
    isWsol,
    evidence,
  };
}

function chooseCounterAsset(candidates) {
  if (candidates.length === 0) return { asset: null, ambiguous: false };
  if (candidates.length === 1) return { asset: candidates[0], ambiguous: false };

  // Never compare raw human quantities across unrelated mints. One SOL, one
  // USDC, and one million meme tokens are not comparable quantities. If more
  // than one material counter asset survives the wallet-level movement filter,
  // the economic counterparty cannot be established safely from these deltas
  // alone, so fail closed instead of selecting by numeric magnitude.
  return { asset: null, ambiguous: true, candidates: [...candidates] };
}

function resolveTrade(tx, { walletAddress, targetMint, valuation = {}, stablecoinMints = DEFAULT_STABLECOIN_MINTS } = {}) {
  if (!tx || !walletAddress || !targetMint) return null;
  if (tx.meta?.err) {
    return {
      side: 'UNKNOWN', targetAmount: null, inputAsset: null, outputAsset: null,
      valueUsd: null, valueSol: null, valueSource: 'NONE', confidence: 'UNKNOWN',
      route: [], evidence: { failed: true }, reason: 'failed_transaction',
    };
  }

  const movement = collectWalletAssetMovements(tx, walletAddress);
  const target = movement.assets.get(targetMint);
  if (!target || target.rawDelta === 0n) return null;

  const side = target.rawDelta > 0n ? 'BUY' : 'SELL';
  const counterDirection = side === 'BUY' ? -1n : 1n;
  const candidates = [];

  for (const [key, asset] of movement.assets.entries()) {
    if (key === targetMint) continue;
    if (key === '__NATIVE_SOL__' && movement.nativeEconomicMovement?.ambiguous) continue;
    if (asset.rawDelta * counterDirection <= 0n) continue;
    const absRaw = asset.rawDelta < 0n ? -asset.rawDelta : asset.rawDelta;
    const decimals = asset.decimals ?? (key === '__NATIVE_SOL__' ? 9 : null);
    if (!Number.isInteger(decimals)) continue;
    candidates.push(buildAsset(absRaw, {
      mint: asset.mint || null,
      decimals,
      isWsol: asset.isWsol,
      asset: asset.asset,
      evidence: asset.evidence,
    }));
  }

  const selected = chooseCounterAsset(candidates);
  if (!selected.asset) {
    return {
      side: 'UNKNOWN', targetAmount: humanAmount(target.rawDelta < 0n ? -target.rawDelta : target.rawDelta, target.decimals),
      inputAsset: null, outputAsset: null, valueUsd: null, valueSol: null,
      valueSource: 'NONE', confidence: 'UNKNOWN', route: [],
      evidence: { wallet: walletAddress, targetMint, ambiguousCounterAsset: selected.ambiguous, candidates, native: serializableNativeMovement(movement.nativeEconomicMovement) },
      reason: selected.ambiguous ? 'ambiguous_counter_asset' : 'no_counter_asset',
    };
  }

  const targetAmount = humanAmount(target.rawDelta < 0n ? -target.rawDelta : target.rawDelta, target.decimals);
  const counter = selected.asset;
  const inputAsset = side === 'BUY' ? counter : buildAsset(asBigInt(target.rawDelta < 0n ? -target.rawDelta : target.rawDelta), { mint: targetMint, decimals: target.decimals });
  const outputAsset = side === 'BUY' ? buildAsset(asBigInt(target.rawDelta < 0n ? -target.rawDelta : target.rawDelta), { mint: targetMint, decimals: target.decimals }) : counter;

  const counterMint = counter.mint || (counter.isWsol ? WSOL_MINT : null);
  const stableName = stablecoinName(counterMint, stablecoinMints);
  const counterAmount = Number(counter.amount);
  let valueUsd = null;
  let valueSol = null;
  let valueSource = 'UNKNOWN';
  let confidence = 'UNKNOWN';

  if (stableName && Number.isFinite(counterAmount) && counterAmount > 0) {
    valueUsd = counterAmount;
    valueSource = `${stableName}_REALIZED`;
    confidence = 'HIGH';
    if (positiveOrNull(valuation.solUsd)) valueSol = valueUsd / valuation.solUsd;
  } else if (counter.isWsol || counter.asset === 'SOL' || counterMint === WSOL_MINT) {
    valueSol = counterAmount;
    if (positiveOrNull(valuation.solUsd)) valueUsd = valueSol * valuation.solUsd;
    valueSource = positiveOrNull(valuation.solUsd) ? 'REALIZED_SOL_PLUS_TX_RATE' : 'REALIZED_SOL';
    confidence = positiveOrNull(valuation.solUsd) ? 'HIGH' : 'MEDIUM';
  } else if (Number.isFinite(counterAmount) && counterAmount > 0 && positiveOrNull(valuation.counterPriceSol)) {
    valueSol = counterAmount * valuation.counterPriceSol;
    if (positiveOrNull(valuation.solUsd)) valueUsd = valueSol * valuation.solUsd;
    valueSource = valuation.counterPriceSource || 'COUNTER_TRANSACTION_TIME_RATE';
    confidence = valuation.counterPriceConfidence || 'HIGH';
  } else if (Number.isFinite(counterAmount) && counterAmount > 0 && positiveOrNull(valuation.targetPriceNative ?? valuation.priceNative) && Number.isFinite(targetAmount) && targetAmount > 0) {
    // When a trustworthy market snapshot exists close to the on-chain event,
    // the realized target/counter exchange ratio converts that target SOL
    // price into a transaction-time counter-token SOL price. This avoids
    // inventing a current price for an arbitrary SPL counter asset.
    const derivedCounterPriceSol = (valuation.targetPriceNative ?? valuation.priceNative) * targetAmount / counterAmount;
    if (positiveOrNull(derivedCounterPriceSol)) {
      valueSol = counterAmount * derivedCounterPriceSol;
      if (positiveOrNull(valuation.solUsd)) valueUsd = valueSol * valuation.solUsd;
      valueSource = 'COUNTER_TRANSACTION_TIME_RATE_FROM_TARGET_SNAPSHOT';
      confidence = 'MEDIUM';
    }
  }

  const route = inferRoute(tx, walletAddress, inputAsset, outputAsset);
  return {
    side,
    targetAmount,
    inputAsset,
    outputAsset,
    valueUsd,
    valueSol,
    valueSource,
    confidence,
    route,
    evidence: {
      wallet: walletAddress,
      targetMint,
      parsedSplTransfers: parsedSplTransfers(tx),
      candidateCounters: candidates,
      selectedCounter: counter,
      rawTargetDelta: target.rawDelta.toString(),
      valuation: {
        counterPriceSol: Number.isFinite(valueSol) && counterAmount > 0 ? valueSol / counterAmount : null,
        counterPriceSource: valueSource,
        confidence,
        targetPriceNative: positiveOrNull(valuation.targetPriceNative ?? valuation.priceNative) || null,
        reference: valuation.evidence || null,
      },
      native: serializableNativeMovement(movement.nativeEconomicMovement),
    },
  };
}

function inferRoute(tx, walletAddress, inputAsset, outputAsset) {
  const programs = [];
  for (const ix of parsedInstructions(tx)) {
    const program = ix?.program || ix?.programId;
    if (program) programs.push(typeof program === 'string' ? program : publicKeyString(program));
  }
  return {
    inputMint: assetKey(inputAsset),
    outputMint: assetKey(outputAsset),
    programs: [...new Set(programs.filter(Boolean))],
    wallet: walletAddress,
    collapsed: true,
  };
}

module.exports = {
  DEFAULT_STABLECOIN_MINTS,
  SYSTEM_PROGRAM_ID,
  WSOL_MINT,
  TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS,
  MECHANICAL_FUNDING_MAX_LAMPORTS,
  collectWalletAssetMovements,
  resolveTrade,
  humanAmount,
};