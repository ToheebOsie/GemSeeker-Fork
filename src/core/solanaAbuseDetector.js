'use strict';

const TOKEN_PROGRAMS = new Set(['spl-token', 'spl-token-2022']);
const POOL_PROGRAM_HINTS = new Set(['raydium_amm', 'raydium_clmm', 'whirlpool', 'meteora', 'orca', 'amm', 'amm_v4', 'amm_v3', 'liquidity_pool']);
const WITHDRAW_TYPES = new Set(['removeliquidity', 'removeliquiditysingle', 'decreaseliquidity', 'withdrawliquidity', 'withdraw', 'withdrawall', 'remove_liquidity', 'remove_liquidity_single', 'decrease_liquidity']);
const MIGRATION_TYPES = new Set(['migratepool', 'migrate_pool', 'migrate']);

function keyAddress(key) { return typeof key === 'string' ? key : key?.pubkey || key?.toString?.() || null; }
function instructionList(tx) { return [...(tx?.transaction?.message?.instructions || []), ...(tx?.meta?.innerInstructions || []).flatMap((item) => item.instructions || [])]; }
function tokenMintsByAccount(tx) {
  const out = new Map();
  for (const balance of [...(tx?.meta?.preTokenBalances || []), ...(tx?.meta?.postTokenBalances || [])]) {
    const address = keyAddress(tx?.transaction?.message?.accountKeys?.[balance.accountIndex]);
    if (address && balance.mint) out.set(address, balance.mint);
  }
  return out;
}
function baseEvent(kind, instruction, signature, slot, blockTime, info) {
  return { kind, observed: true, signature: signature || null, slot: slot ?? null, blockTime: blockTime ?? null, source: 'solana_parsed_transaction', evidence: { instructionType: instruction.parsed?.type, program: instruction.program, info } };
}
function programLooksLikePool(instruction) {
  const program = String(instruction?.program || instruction?.programId || '').toLowerCase();
  return POOL_PROGRAM_HINTS.has(program) || [...POOL_PROGRAM_HINTS].some((hint) => program.includes(hint));
}
function detectMintFreezeEvents(tx, { mintAddress, signature = null, slot = null, blockTime = null } = {}) {
  if (!tx || !mintAddress) return [];
  const accountMints = tokenMintsByAccount(tx);
  const events = [];
  for (const instruction of instructionList(tx)) {
    if (!instruction?.parsed || !TOKEN_PROGRAMS.has(instruction.program)) continue;
    const type = instruction.parsed.type;
    const info = instruction.parsed.info || {};
    if ((type === 'mintTo' || type === 'mintToChecked') && info.mint === mintAddress) {
      const amount = Number(info.amount ?? info.tokenAmount?.amount);
      if (Number.isFinite(amount) && amount > 0) events.push(baseEvent('mint-abuse', instruction, signature, slot, blockTime, { mint: info.mint, destination: info.account || info.destination || null, authority: info.authority || null, amount }));
    }
    if (type === 'freezeAccount' && (info.mint === mintAddress || accountMints.get(info.account) === mintAddress)) events.push(baseEvent('freeze-abuse', instruction, signature, slot, blockTime, { mint: info.mint || mintAddress, account: info.account || null, authority: info.authority || null }));
  }
  return events;
}
function detectPoolFlowEvents(tx, { mintAddress, signature = null, slot = null, blockTime = null } = {}) {
  if (!tx || !mintAddress) return [];
  const events = [];
  for (const instruction of instructionList(tx)) {
    if (!instruction?.parsed || !programLooksLikePool(instruction)) continue;
    const type = String(instruction.parsed.type || '').toLowerCase();
    const info = instruction.parsed.info || {};
    const referencesMint = [info.mint, info.coinMint, info.pcMint, info.tokenMint, info.tokenAMint, info.tokenBMint].includes(mintAddress);
    if (!referencesMint) continue;
    if (WITHDRAW_TYPES.has(type)) events.push(baseEvent('pool-flow-withdrawal', instruction, signature, slot, blockTime, { mint: mintAddress, pool: info.pool || info.poolId || info.amm || null, authority: info.authority || info.owner || null, amount: info.amount || info.tokenAmount || null }));
    else if (MIGRATION_TYPES.has(type)) events.push(baseEvent('pool-migration', instruction, signature, slot, blockTime, { mint: mintAddress, sourcePool: info.sourcePool || info.pool || null, destinationPool: info.destinationPool || info.newPool || null, authority: info.authority || info.owner || null }));
  }
  return events;
}
function detectAbuseEvents(tx, options = {}) { return [...detectMintFreezeEvents(tx, options), ...detectPoolFlowEvents(tx, options)]; }
module.exports = { TOKEN_PROGRAMS, WITHDRAW_TYPES, MIGRATION_TYPES, detectMintFreezeEvents, detectPoolFlowEvents, detectAbuseEvents };
