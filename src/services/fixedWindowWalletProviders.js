'use strict';

const DEFAULT_TIMEOUT_MS = 12_000;
const { resolvePool } = require('./poolResolver');
const ADAPTER_VERSION = 'fixed-window-providers-v1';

class ProviderError extends Error {
  constructor(provider, code, message, details = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.details = details;
  }
}

function asMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function shaSafe(value) {
  return value == null ? null : String(value);
}

async function requestJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2000) }; }
    if (!response.ok) {
      const error = new ProviderError('http', response.status === 429 ? 'rate_limited' : 'http_error', `HTTP ${response.status}`, { httpStatus: response.status, body });
      throw error;
    }
    return { body, httpStatus: response.status };
  } catch (error) {
    if (error.name === 'AbortError') throw new ProviderError('http', 'timeout', `request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTransfer(item, { provider, mintAddress, pairAddress }) {
  const from = item.fromUserAccount || item.from_address || item.fromAddress || item.from || null;
  const to = item.toUserAccount || item.to_address || item.toAddress || item.to || null;
  const mint = item.mint || item.token_address || item.mintAddress || mintAddress;
  const timestampMs = asMs(item.blockTime ?? item.block_time ?? item.unix_time ?? item.timestamp ?? item.time);
  const amount = numeric(item.amount ?? item.ui_amount ?? (typeof item.tokenAmount === 'object' ? (item.tokenAmount?.uiAmount ?? item.tokenAmount?.amount) : item.tokenAmount));
  const valueUsd = numeric(item.valueUsd ?? item.usdValue ?? item.value_usd ?? (typeof item.tokenAmount === 'object' ? item.tokenAmount?.valueUsd : undefined));
  const signature = item.signature || item.tx_hash || item.txHash || item.transactionHash || null;
  const pool = new Set([pairAddress].filter(Boolean));
  const direction = item.flow || item.direction || (pool.has(from) ? 'out' : pool.has(to) ? 'in' : 'unknown');
  const role = pool.has(from) ? 'buyer' : pool.has(to) ? 'seller' : null;
  const walletAddress = role === 'buyer' ? to : role === 'seller' ? from : null;
  return {
    provider,
    signature: shaSafe(signature),
    slot: numeric(item.slot ?? item.block_number ?? item.blockNumber),
    timestampMs,
    mintAddress: mint,
    fromAddress: from,
    toAddress: to,
    walletAddress,
    role,
    direction,
    amount,
    valueUsd,
    valueSource: valueUsd !== null ? 'provider' : null,
    raw: item,
  };
}

// Attribute one Helius transaction's tokenTransfers to a single pool.
// - Only legs of the TOKEN mint become buy/sell rows (quote legs used to be emitted as opposite-role rows).
// - Pool side = pair address OR any of the pool's resolved vault token accounts (Raydium v4 vaults are
//   owned by a shared authority, not the pair).
// - USD per trade = quote-leg amount x quoteUsdPerUnit (pair priceUsd/priceNative), apportioned across legs.
function attributeSwap(tokenTransfers, { signature, blockTime, slot, mintAddress, pairAddress, pool, quoteUsdPerUnit }) {
  const accounts = new Set([pairAddress, ...(pool?.accounts || [])].filter(Boolean));
  const poolSide = (t, side) => accounts.has(side === 'from' ? t.fromUserAccount : t.toUserAccount) || accounts.has(side === 'from' ? t.fromTokenAccount : t.toTokenAccount);
  const amountOf = (t) => numeric(typeof t.tokenAmount === 'object' ? (t.tokenAmount?.uiAmount ?? t.tokenAmount?.amount) : t.tokenAmount ?? t.amount);
  const tokenLegs = tokenTransfers.filter((t) => (t.mint || mintAddress) === mintAddress);
  const quoteLegs = tokenTransfers.filter((t) => (t.mint || mintAddress) !== mintAddress && (!pool?.quoteMint || t.mint === pool.quoteMint));
  const quoteIn = quoteLegs.filter((t) => poolSide(t, 'to') && !poolSide(t, 'from')).reduce((s, t) => s + (amountOf(t) || 0), 0);
  const quoteOut = quoteLegs.filter((t) => poolSide(t, 'from') && !poolSide(t, 'to')).reduce((s, t) => s + (amountOf(t) || 0), 0);
  const sumBase = (role) => tokenLegs.filter((t) => (role === 'buyer' ? poolSide(t, 'from') && !poolSide(t, 'to') : poolSide(t, 'to') && !poolSide(t, 'from'))).reduce((s, t) => s + (amountOf(t) || 0), 0);
  const baseBuy = sumBase('buyer');
  const baseSell = sumBase('seller');
  // Liquidity events move base AND quote the same way relative to the pool (withdraw: both out,
  // deposit: both in). They are not trades; counting them made an LP withdrawal the 'top buyer'.
  const isWithdraw = quoteOut > 0 && quoteIn === 0;
  const isDeposit = quoteIn > 0 && quoteOut === 0;
  // Routers (e.g. aggregator program authorities) can sit between the pool and the trader inside one
  // tx: follow same-mint forwarding legs, within the tx, to the real counterparty (max 3 hops).
  const followForward = (wallet, dir) => {
    let cur = wallet;
    for (let hop = 0; hop < 3 && cur; hop += 1) {
      const next = tokenLegs.find((t) => !poolSide(t, 'from') && !poolSide(t, 'to') && (dir === 'forward' ? t.fromUserAccount === cur : t.toUserAccount === cur));
      if (!next) break;
      const candidate = dir === 'forward' ? next.toUserAccount : next.fromUserAccount;
      if (!candidate || candidate === cur) break;
      cur = candidate;
    }
    return cur;
  };
  const rows = [];
  for (const leg of tokenLegs) {
    const row = normalizeTransfer({ ...leg, signature, blockTime, slot }, { provider: 'helius', mintAddress, pairAddress });
    const out = poolSide(leg, 'from') && !poolSide(leg, 'to');
    const into = poolSide(leg, 'to') && !poolSide(leg, 'from');
    if (!out && !into) continue; // wallet-to-wallet or unrelated: not a trade against this pool
    if ((out && isWithdraw) || (into && isDeposit)) continue; // liquidity event, not a trade
    row.role = out ? 'buyer' : 'seller';
    row.walletAddress = out ? (followForward(leg.toUserAccount || null, 'forward') || null) : (followForward(leg.fromUserAccount || null, 'back') || null);
    const quoteTotal = out ? quoteIn : quoteOut;
    const baseTotal = out ? baseBuy : baseSell;
    if (row.valueUsd === null && quoteTotal > 0 && baseTotal > 0 && Number.isFinite(quoteUsdPerUnit) && quoteUsdPerUnit > 0 && row.amount !== null) {
      row.valueUsd = quoteTotal * quoteUsdPerUnit * (row.amount / baseTotal);
      row.valueSource = 'swap_quote_leg';
    }
    rows.push(row);
  }
  return rows;
}

function extractHeliusItems(result) {
  if (Array.isArray(result)) return { items: result, cursor: null, complete: true };
  if (!result || typeof result !== 'object') return { items: [], cursor: null, complete: false };
  return {
    items: result.transactions || result.transfers || result.data || result.items || [],
    cursor: result.paginationToken || result.pagination_token || result.nextPageToken || null,
    complete: result.complete !== false,
  };
}

async function fetchHeliusWindow({ pairAddress, mintAddress, startMs, endMs, apiKey, limit = 1000, maxPages = 5, timeoutMs = DEFAULT_TIMEOUT_MS, quoteUsdPerUnit = null }) {
  if (!apiKey) throw new ProviderError('helius', 'not_configured', 'HELIUS_API_KEY is not configured');
  if (!pairAddress) throw new ProviderError('helius', 'missing_pair_address', 'pairAddress is required for Helius history');
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  let pool = null;
  try {
    pool = await resolvePool({ pairAddress, mintAddress, rpc: async (payload) => (await requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, timeoutMs)).body });
  } catch (error) { pool = null; } // attribution falls back to pair-owned-vault assumption
  let paginationToken = null;
  const rawPages = [];
  const transfers = [];
  let pages = 0;
  let signaturesScanned = 0;
  let cursor = null;
  let complete = false;
  do {
    const config = {
      transactionDetails: 'full',
      sortOrder: 'asc',
      commitment: 'finalized',
      limit: Math.min(1000, Math.max(1, limit)),
      maxSupportedTransactionVersion: 1,
      filters: {
        status: 'succeeded',
        blockTime: { gte: Math.floor(startMs / 1000), lt: Math.ceil(endMs / 1000) },
        tokenTransfer: { mint: mintAddress, direction: 'any' },
      },
    };
    if (paginationToken) config.paginationToken = paginationToken;
    const response = await requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `fixed-window-${Date.now()}`, method: 'getTransactionsForAddress', params: [pairAddress, config] }),
    }, timeoutMs);
    if (response.body?.error) throw new ProviderError('helius', 'provider_error', response.body.error.message || 'Helius RPC error', { body: response.body });
    rawPages.push(response.body);
    const page = extractHeliusItems(response.body?.result);
    pages += 1;
    signaturesScanned += page.items.length;
    for (const item of page.items) {
      const base = item.events?.token || item;
      const tokenTransfers = Array.isArray(item.tokenTransfers) ? item.tokenTransfers : Array.isArray(item.events?.tokenTransfers) ? item.events.tokenTransfers : null;
      if (tokenTransfers) {
        transfers.push(...attributeSwap(tokenTransfers, { signature: item.signature, blockTime: item.blockTime, slot: item.slot, mintAddress, pairAddress, pool, quoteUsdPerUnit }));
      } else {
        const normalized = normalizeTransfer({ ...base, signature: item.signature, blockTime: item.blockTime, slot: item.slot }, { provider: 'helius', mintAddress, pairAddress });
        if (normalized.timestampMs) transfers.push(normalized);
      }
    }
    cursor = page.cursor;
    paginationToken = page.cursor;
    complete = page.complete && !paginationToken;
  } while (paginationToken && pages < maxPages);

  if (paginationToken) complete = false;
  if (signaturesScanned > 0 && !transfers.some((row) => row.role)) throw new ProviderError('helius', 'unparseable_response', `Helius returned ${signaturesScanned} items but none attributable to pair ${pairAddress}`);
  const inWindow = transfers.filter((row) => row.timestampMs !== null && row.timestampMs >= startMs && row.timestampMs < endMs);
  return { provider: 'helius', adapterVersion: ADAPTER_VERSION, status: complete ? 'success' : 'partial', pagesRequested: pages, pagesCompleted: pages, signaturesScanned, cursor, coverageStartMs: startMs, coverageEndMs: endMs, transfers: inWindow, raw: rawPages };
}

async function fetchBirdeyeWindow({ pairAddress, mintAddress, startMs, endMs, apiKey, limit = 100, maxPages = 10, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) throw new ProviderError('birdeye', 'not_configured', 'BIRDEYE_API_KEY is not configured');
  const url = 'https://public-api.birdeye.so/token/v1/transfer';
  let cursor = null;
  const rawPages = [];
  const transfers = [];
  let pages = 0;
  do {
    const body = { token_address: mintAddress, time_from: Math.floor(startMs / 1000), time_to: Math.ceil(endMs / 1000), cursor, limit: Math.min(100, Math.max(1, limit)) };
    if (!cursor) delete body.cursor;
    const response = await requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey, 'x-chain': 'solana' }, body: JSON.stringify(body) }, timeoutMs);
    if (response.body?.success === false) throw new ProviderError('birdeye', 'provider_error', response.body.message || 'Birdeye error', { body: response.body });
    rawPages.push(response.body);
    const data = response.body?.data;
    const items = Array.isArray(data) ? data : data?.items || data?.data || [];
    for (const item of items) transfers.push(normalizeTransfer(item, { provider: 'birdeye', mintAddress, pairAddress }));
    pages += 1;
    cursor = data?.cursor || data?.next_cursor || data?.nextCursor || null;
  } while (cursor && pages < maxPages);
  const complete = !cursor;
  return { provider: 'birdeye', adapterVersion: ADAPTER_VERSION, status: complete ? 'success' : 'partial', pagesRequested: pages, pagesCompleted: pages, signaturesScanned: transfers.length, cursor, coverageStartMs: startMs, coverageEndMs: endMs, transfers: transfers.filter((row) => row.timestampMs !== null && row.timestampMs >= startMs && row.timestampMs < endMs), raw: rawPages };
}

async function fetchHellomoonWindow({ pairAddress, mintAddress, startMs, endMs, apiKey, limit = 100, maxPages = 5, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  throw new ProviderError('hellomoon', 'unsupported', 'Hellomoon adapter not implemented: getParsedTransaction is not a JSON-RPC method and postTokenBalances carry no buyer/seller attribution');
  if (!apiKey) throw new ProviderError('hellomoon', 'not_configured', 'HELLOMOON_API_KEY is not configured');
  if (!pairAddress) throw new ProviderError('hellomoon', 'missing_pair_address', 'pairAddress is required for Hellomoon RPC history');
  const url = `https://rpc.hellomoon.io/${encodeURIComponent(apiKey)}`;
  let before = null;
  const rawPages = [];
  const transfers = [];
  let pages = 0;
  let complete = false;
  do {
    const config = { limit: Math.min(1000, Math.max(1, limit)), commitment: 'finalized' };
    if (before) config.before = before;
    const signaturesResponse = await requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: `fixed-window-hm-${Date.now()}`, method: 'getSignaturesForAddress', params: [pairAddress, config] }) }, timeoutMs);
    if (signaturesResponse.body?.error) throw new ProviderError('hellomoon', 'provider_error', signaturesResponse.body.error.message || 'Hellomoon signature error', { body: signaturesResponse.body });
    const signatures = signaturesResponse.body?.result || [];
    rawPages.push(signaturesResponse.body);
    if (!signatures.length) { complete = true; break; }
    for (const sig of signatures) {
      const blockTimeMs = asMs(sig.blockTime);
      if (blockTimeMs !== null && blockTimeMs < startMs) { complete = true; break; }
      if (blockTimeMs === null || blockTimeMs >= endMs) continue;
      const txResponse = await requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: `fixed-window-tx-${sig.signature}`, method: 'getParsedTransaction', params: [sig.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 1 }] }) }, timeoutMs);
      if (txResponse.body?.error) continue;
      rawPages.push(txResponse.body);
      const tx = txResponse.body?.result;
      const balances = tx?.meta?.postTokenBalances || [];
      for (const balance of balances) {
        if (balance.mint !== mintAddress) continue;
        const account = balance.owner || balance.accountIndex || null;
        if (account) transfers.push(normalizeTransfer({ signature: sig.signature, blockTime: sig.blockTime, slot: sig.slot, to_address: account, token_address: balance.mint, ui_amount: balance.uiTokenAmount?.uiAmount }, { provider: 'hellomoon', mintAddress, pairAddress }));
      }
    }
    pages += 1;
    before = signatures[signatures.length - 1]?.signature || null;
    if (signatures.length < config.limit) complete = true;
  } while (before && pages < maxPages && !complete);
  return { provider: 'hellomoon', adapterVersion: ADAPTER_VERSION, status: complete ? 'success' : 'partial', pagesRequested: pages, pagesCompleted: pages, signaturesScanned: transfers.length, cursor: before, coverageStartMs: startMs, coverageEndMs: endMs, transfers: transfers.filter((row) => row.timestampMs !== null && row.timestampMs >= startMs && row.timestampMs < endMs), raw: rawPages };
}

module.exports = { ADAPTER_VERSION, ProviderError, fetchHeliusWindow, fetchBirdeyeWindow, fetchHellomoonWindow };
