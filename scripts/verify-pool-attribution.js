'use strict';
// One-off check against a REAL pool before trusting Raydium attribution:
//   HELIUS_API_KEY=... node scripts/verify-pool-attribution.js <pairAddress> <tokenMint>
// Prints the decoded vaults. Confirm both vault addresses on Solscan show the expected mints and
// that their owner is the Raydium authority. If kind is "owner_pda" the pool was not recognised
// as Raydium AMM v4 (CLMM/CPMM/PumpSwap use other layouts) and the pair-owned-vault rule applies.
const { resolvePool } = require('../src/services/poolResolver');
(async () => {
  const [pairAddress, mintAddress] = process.argv.slice(2);
  const key = process.env.HELIUS_API_KEY;
  if (!pairAddress || !mintAddress || !key) { console.error('usage: HELIUS_API_KEY=... node scripts/verify-pool-attribution.js <pair> <mint>'); process.exit(2); }
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  const pool = await resolvePool({ pairAddress, mintAddress, rpc: async (payload) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json() });
  console.log(JSON.stringify(pool, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
