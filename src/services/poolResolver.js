'use strict';

// Resolves which token accounts belong to a pool, so swaps can be attributed on AMMs whose vaults
// are NOT owned by the pair address. Raydium AMM v4 vaults are owned by a shared authority PDA, so
// "transfer from/to pairAddress" never matches there; the vault token accounts must be read from
// the AMM account itself.
//
// Layout offsets below are Raydium's LIQUIDITY_STATE_LAYOUT_V4 (752 bytes) from the public SDK.
// They are verified AT RUNTIME: the decoded base/quote mint must include the token we asked about,
// otherwise the decode is rejected (returns null) and callers fall back. A wrong offset therefore
// fails closed instead of attributing the wrong accounts.
const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_AMM_V4_SIZE = 752;
const OFFSETS = { baseVault: 336, quoteVault: 368, baseMint: 400, quoteMint: 432 };
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
}

function readKey(buf, offset) { return base58Encode(buf.subarray(offset, offset + 32)); }

function decodeRaydiumAmmV4(data, mintAddress) {
  if (!Buffer.isBuffer(data) || data.length !== RAYDIUM_AMM_V4_SIZE) return null;
  const baseMint = readKey(data, OFFSETS.baseMint);
  const quoteMint = readKey(data, OFFSETS.quoteMint);
  const baseVault = readKey(data, OFFSETS.baseVault);
  const quoteVault = readKey(data, OFFSETS.quoteVault);
  let tokenVault; let quoteVaultOut; let quoteMintOut;
  if (baseMint === mintAddress) { tokenVault = baseVault; quoteVaultOut = quoteVault; quoteMintOut = quoteMint; }
  else if (quoteMint === mintAddress) { tokenVault = quoteVault; quoteVaultOut = baseVault; quoteMintOut = baseMint; }
  else return null; // runtime self-check failed: not this token's pool, or layout mismatch
  return { kind: 'raydium_amm_v4', tokenVault, quoteVault: quoteVaultOut, quoteMint: quoteMintOut };
}

const CACHE_MAX = 2000;
const pool_ = (pairAddress) => ({ kind: 'owner_pda', accounts: [pairAddress], quoteMint: null });
const cache = new Map();

// rpc(body) must return the parsed JSON-RPC response body. Errors propagate to the caller.
async function resolvePool({ pairAddress, mintAddress, rpc }) {
  const key = `${pairAddress}:${mintAddress}`;
  if (cache.has(key)) return cache.get(key);
  const body = await rpc({ jsonrpc: '2.0', id: 'pool-resolve', method: 'getAccountInfo', params: [pairAddress, { encoding: 'base64', commitment: 'confirmed' }] });
  if (body?.error) throw new Error(`getAccountInfo failed: ${body.error.message || 'rpc error'}`); // transient failure must not be cached as 'not raydium'
  if (!body || !body.result) throw new Error('getAccountInfo returned no result');
  const value = body.result.value;
  if (value === null || value === undefined) return pool_(pairAddress); // account not visible yet: answer, but do not cache
  let pool = pool_(pairAddress);
  if (value && value.owner === RAYDIUM_AMM_V4_PROGRAM && Array.isArray(value.data) && value.data[0]) {
    const decoded = decodeRaydiumAmmV4(Buffer.from(value.data[0], 'base64'), mintAddress);
    if (decoded) pool = { kind: decoded.kind, accounts: [pairAddress, decoded.tokenVault, decoded.quoteVault], tokenVault: decoded.tokenVault, quoteVault: decoded.quoteVault, quoteMint: decoded.quoteMint };
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, pool);
  return pool;
}

module.exports = { RAYDIUM_AMM_V4_PROGRAM, base58Encode, decodeRaydiumAmmV4, resolvePool, _cache: cache };
