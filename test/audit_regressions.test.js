'use strict';
// Regression tests for the Nov-2026 audit findings (model-fork Tier-1/Tier-2 path).
// Run: node test/audit_regressions.test.js
// DB tests need @electric-sql/pglite (npm i --no-save @electric-sql/pglite); they skip otherwise.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');
const PAIR = 'PAIRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
let db = null;
const stubs = {
  [path.join(root, 'src/config.js')]: {
    fixedWindowWallet: { enabled: true, heliusApiKey: 'hk', birdeyeApiKey: 'bk', hellomoonApiKey: 'hm', timeoutMs: 2000, pageLimit: 100, maxPages: 2,
      windows: [{ key: 'pre_discovery_30m', phase: 'discovery', minutes: 30 }, { key: 'pre_discovery_60m', phase: 'discovery', minutes: 60 }] },
    modelFocus: { collectTier2OnlyAfterTier1: true }, tier2Scoring: { enabled: true },
  },
  [path.join(root, 'src/db/pool.js')]: {
    withTransaction: async (fn) => !db ? { captureId: 0 } : db.transaction((tx) => fn({ query: (s, p) => tx.query(s, p) })),
    query: async (s, p) => (db ? db.query(s, p) : { rows: [] }),
  },
};
const resolve = Module._resolveFilename, load = Module._load;
Module._load = function (req, parent, ...rest) {
  try { const r = resolve.call(Module, req, parent); if (stubs[r]) return stubs[r]; } catch (e) {}
  return load.call(Module, req, parent, ...rest);
};
const collector = require('../src/services/fixedWindowWalletCollector');
const providers = require('../src/services/fixedWindowWalletProviders');
const tier2 = require('../src/core/tier2ScoringEngine');
const rule = require('../src/core/highRoiPatternRule');

const cutoff = Date.now();
const sec = (m) => Math.floor((cutoff - m * 60_000) / 1000);
const swap = (i, from, to, m) => ({ signature: 's' + i, blockTime: sec(m), slot: i, tokenTransfers: [{ fromUserAccount: from, toUserAccount: to, mint: 'MINT', tokenAmount: 10 }] });
const token = { priceUsd: 0.5, pairAddress: PAIR, baseToken: { address: 'MINT' }, dexId: 'raydium', marketCap: 5e4, liquidity: 2e4, discovery: { source: 'dexscreener', discoveredAt: new Date(cutoff - 120000).toISOString() }, pairCreatedAt: cutoff - 600000 };
const mockHttp = (fn) => { global.fetch = async (url, o) => ({ ok: true, status: 200, text: async () => JSON.stringify(fn(String(url), o?.body ? JSON.parse(o.body) : null)) }); };
const win = (a, key) => ({ windowKey: key, featurePhase: 'discovery', windowEndMs: cutoff, featureCutoffAtMs: cutoff, coverageStatus: 'complete', eligibleForDiscoveryModel: true, ...a });
const score = (a, rules) => tier2.scoreTier2FixedWindowFeatures({ windows: [win(a, 'pre_discovery_30m'), win(a, 'pre_discovery_60m')], platformTiming: { platform: 'pump_fun', discoveryHourUtc: 3 }, ...(rules ? { rules } : {}) });

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('aggregator: provider with no USD keeps volume null (not 0)', async () => {
  const rows = [0, 1, 2].map((i) => ({ timestampMs: cutoff - 1000 * (i + 1), mintAddress: 'M', role: 'buyer', walletAddress: 'W' + i, fromAddress: PAIR, toAddress: 'W' + i, valueUsd: null }));
  const a = collector.aggregateTransfers(rows, { pairAddress: PAIR, windowStartMs: cutoff - 36e5, windowEndMs: cutoff });
  assert.strictEqual(a.buyVolumeUsd, null);
  assert.strictEqual(a.walletDataCompletenessPct, null);
});
t('tier2: zero sells with many buys is not penalised', async () => {
  const r = score({ uniqueBuyers: 12, buyTransactionCount: 30, sellTransactionCount: 0, buyVolumeUsd: 9000, sellVolumeUsd: null, top1BuyerSharePct: 15, buyerHhi: 0.08 });
  assert.strictEqual(r.points, 8); assert.ok(r.pass);
});
t('tier2: requireCompleteDiscoveryWindows=false is honoured by pass', async () => {
  const a = { uniqueBuyers: 12, buyTransactionCount: 30, sellTransactionCount: 1, buyVolumeUsd: 9000, sellVolumeUsd: 1, top1BuyerSharePct: 15, buyerHhi: 0.08, coverageStatus: 'partial' };
  assert.ok(score(a, { ...tier2.DEFAULT_TIER2_RULES, requireCompleteDiscoveryWindows: false }).pass);
  assert.ok(!score(a).pass);
});
t('providers: epoch-ms timestamps are not multiplied by 1000', async () => {
  mockHttp(() => ({ success: true, data: { items: [{ from_address: PAIR, to_address: 'B1', value: 5, block_time: cutoff - 60000 }] } }));
  const r = await providers.fetchBirdeyeWindow({ pairAddress: PAIR, mintAddress: 'MINT', startMs: cutoff - 36e5, endMs: cutoff, apiKey: 'k' });
  assert.strictEqual(r.transfers.length, 1);
});
t('providers: hellomoon cannot report success', async () => {
  await assert.rejects(() => providers.fetchHellomoonWindow({ pairAddress: PAIR, mintAddress: 'MINT', startMs: 0, endMs: 1, apiKey: 'k' }), (e) => e.code === 'unsupported');
});
t('providers: unattributable helius page is an error, not an empty success', async () => {
  mockHttp(() => ({ result: { data: [{ blockTime: sec(5), slot: 1, transaction: {}, meta: {} }] } }));
  await assert.rejects(() => providers.fetchHeliusWindow({ pairAddress: PAIR, mintAddress: 'MINT', startMs: cutoff - 36e5, endMs: cutoff, apiKey: 'k' }), (e) => e.code === 'unparseable_response');
});
t('capture: partial helius data is kept, not overwritten by an empty fallback', async () => {
  mockHttp((url) => url.includes('helius') ? { result: { data: [0, 1, 2, 3, 4, 5].map((i) => swap(i, PAIR, 'B' + i, 5 + i)), paginationToken: 'more' } } : url.includes('hellomoon') ? { result: [] } : { success: false, message: 'x' });
  const r = await collector.captureFixedWindowWalletFeatures({ token, tier1Admission: { pass: true }, cutoffMs: cutoff });
  assert.strictEqual(r.tier2Score.coverage.complete, false);
  assert.strictEqual(r.tier2Score.components.find((c) => c.key === 'buyer_breadth').value, 6);
});
t('tier1: missing pairCreatedAt is unknown age, not "very early"', async () => {
  const base = { marketCap: 8e4, liquidity: 2e4, volume1h: 3e4 };
  const missing = rule.discoveryComponents({ token: { ...base, ageMinutes: 0, pairCreatedAt: null }, safety: {}, hypeScore: 5 }, rule.DEFAULT_RULES);
  assert.ok(!('discovery_age_very_early' in missing.componentPoints));
  assert.ok('discoveryAgeMinutes' in rule.preEnrichmentComponents({ token: { ...base, ageMinutes: 0, pairCreatedAt: null }, safety: {}, hypeScore: 5 }).missingFeatures.reduce((o, k) => ({ ...o, [k]: 1 }), {}));
  const real = rule.discoveryComponents({ token: { ...base, ageMinutes: 2, pairCreatedAt: cutoff - 120000 }, safety: {}, hypeScore: 5 }, rule.DEFAULT_RULES);
  assert.ok('discovery_age_very_early' in real.componentPoints);
});

t('value basis: token amounts drive shares/HHI when no USD is supplied', async () => {
  const mk = (w, amt, usd) => ({ timestampMs: cutoff - 1000, mintAddress: 'M', role: 'buyer', walletAddress: w, fromAddress: PAIR, toAddress: w, amount: amt, valueUsd: usd });
  const a = collector.aggregateTransfers([mk('A', 60, null), mk('B', 20, null), mk('C', 20, null)], { pairAddress: PAIR, windowStartMs: cutoff - 36e5, windowEndMs: cutoff });
  assert.strictEqual(a.valueBasis, 'token_amount');
  assert.strictEqual(a.buyVolumeUsd, null);
  assert.strictEqual(a.top1BuyerSharePct, 60);
  assert.ok(Math.abs(a.buyerHhi - 0.44) < 1e-9);
  assert.strictEqual(a.sellValue, 0);
});
t('value basis: mixed USD/no-USD rows never mix units', async () => {
  const mk = (w, amt, usd) => ({ timestampMs: cutoff - 1000, mintAddress: 'M', role: 'buyer', walletAddress: w, fromAddress: PAIR, toAddress: w, amount: amt, valueUsd: usd });
  const a = collector.aggregateTransfers([mk('A', 10, 500), mk('B', 10, null)], { pairAddress: PAIR, windowStartMs: cutoff - 36e5, windowEndMs: cutoff });
  assert.strictEqual(a.valueBasis, 'token_amount');
  assert.strictEqual(a.top1BuyerSharePct, 50);
});
t('value basis: no USD and no amounts -> unknown (null), never 0', async () => {
  const a = collector.aggregateTransfers([{ timestampMs: cutoff - 1000, mintAddress: 'M', role: 'buyer', walletAddress: 'A', fromAddress: PAIR, toAddress: 'A' }], { pairAddress: PAIR, windowStartMs: cutoff - 36e5, windowEndMs: cutoff });
  assert.strictEqual(a.valueBasis, null); assert.strictEqual(a.buyValue, null); assert.strictEqual(a.top1BuyerSharePct, null);
});
t('tier2: can reach full score on token-amount basis (no USD anywhere)', async () => {
  const r = score({ uniqueBuyers: 12, buyTransactionCount: 30, sellTransactionCount: 2, valueBasis: 'token_amount', buyValue: 9000, sellValue: 100, top1BuyerSharePct: 15, buyerHhi: 0.08 });
  assert.strictEqual(r.points, 8); assert.ok(r.pass);
});
t('capture end-to-end: Helius transfers without USD yield scored concentration features', async () => {
  mockHttp((url) => url.includes('helius') ? { result: { data: Array.from({ length: 12 }, (_, i) => swap(i, PAIR, 'B' + i, 5 + (i % 20))) } } : { success: false, message: 'x' });
  const r = await collector.captureFixedWindowWalletFeatures({ token, tier1Admission: { pass: true }, cutoffMs: cutoff });
  const c = Object.fromEntries(r.tier2Score.components.map((x) => [x.key, x]));
  assert.ok(c.buyer_concentration.points > 0 && c.buyer_diversification.points === 1 && c.net_buy_value_flow.points === 1, JSON.stringify(r.tier2Score.components.map((x) => x.key + ':' + x.points)));
});

t('usd conversion: amount x pair price is applied before evaluation', async () => {
  const mk = (w, amt) => ({ timestampMs: cutoff - 1000, mintAddress: 'M', role: 'buyer', walletAddress: w, fromAddress: PAIR, toAddress: w, amount: amt, valueUsd: null });
  const a = collector.aggregateTransfers([mk('A', 100), mk('B', 100)], { pairAddress: PAIR, windowStartMs: cutoff - 36e5, windowEndMs: cutoff, priceUsd: 0.002 });
  assert.strictEqual(a.valueBasis, 'usd'); assert.strictEqual(a.usdSource, 'spot_price_estimate');
  assert.ok(Math.abs(a.buyVolumeUsd - 0.4) < 1e-12); assert.strictEqual(a.usdPriceUsed, 0.002);
});
t('usd conversion: provider USD is kept, mixed sources are labelled', async () => {
  const mk = (w, amt, usd) => ({ timestampMs: cutoff - 1000, mintAddress: 'M', role: 'buyer', walletAddress: w, fromAddress: PAIR, toAddress: w, amount: amt, valueUsd: usd });
  const a = collector.aggregateTransfers([mk('A', 10, 7), mk('B', 10, null)], { pairAddress: PAIR, windowStartMs: cutoff - 36e5, windowEndMs: cutoff, priceUsd: 1 });
  assert.strictEqual(a.usdSource, 'mixed'); assert.strictEqual(a.buyVolumeUsd, 17);
});
t('usd conversion: price 0/missing (normalizePair default) is not a price', async () => {
  const mk = (w) => ({ timestampMs: cutoff - 1000, mintAddress: 'M', role: 'buyer', walletAddress: w, fromAddress: PAIR, toAddress: w, amount: 5, valueUsd: null });
  const a = collector.aggregateTransfers([mk('A')], { pairAddress: PAIR, windowStartMs: cutoff - 36e5, windowEndMs: cutoff, priceUsd: 0 });
  assert.strictEqual(a.valueBasis, 'token_amount'); assert.strictEqual(a.buyVolumeUsd, null);
});
t('providers: a bare `value` field is not treated as USD', async () => {
  mockHttp(() => ({ success: true, data: { items: [{ from_address: PAIR, to_address: 'B1', amount: 5, value: 999, block_time: sec(3) }] } }));
  const r = await providers.fetchBirdeyeWindow({ pairAddress: PAIR, mintAddress: 'MINT', startMs: cutoff - 36e5, endMs: cutoff, apiKey: 'k' });
  assert.strictEqual(r.transfers[0].valueUsd, null);
});

// ---- Raydium v4 / swap attribution ----
const resolver = require('../src/services/poolResolver');
const bs58 = (n) => resolver.base58Encode(Buffer.alloc(32, n));
const KEYS = { baseMint: bs58(7), quoteMint: bs58(9), baseVault: bs58(11), quoteVault: bs58(13), authority: bs58(15) };
const poolAccountData = (baseMintIsToken = true) => {
  const b = Buffer.alloc(752);
  Buffer.alloc(32, 11).copy(b, 336); Buffer.alloc(32, 13).copy(b, 368);
  Buffer.alloc(32, baseMintIsToken ? 7 : 9).copy(b, 400); Buffer.alloc(32, baseMintIsToken ? 9 : 7).copy(b, 432);
  return b.toString('base64');
};
const RAY = resolver.RAYDIUM_AMM_V4_PROGRAM;
const rpcFor = (value) => async () => ({ result: { value } });
const leg = (mint, amt, fromU, fromT, toU, toT) => ({ mint, tokenAmount: amt, fromUserAccount: fromU, fromTokenAccount: fromT, toUserAccount: toU, toTokenAccount: toT });
const rayBuy = (i, user, base, quote, min) => ({ signature: 'r' + i, blockTime: sec(min), slot: i, tokenTransfers: [
  leg(KEYS.quoteMint, quote, user, 'UT' + i, KEYS.authority, KEYS.quoteVault),
  leg(KEYS.baseMint, base, KEYS.authority, KEYS.baseVault, user, 'UB' + i)] });
const raySell = (i, user, base, quote, min) => ({ signature: 'q' + i, blockTime: sec(min), slot: i, tokenTransfers: [
  leg(KEYS.baseMint, base, user, 'UB' + i, KEYS.authority, KEYS.baseVault),
  leg(KEYS.quoteMint, quote, KEYS.authority, KEYS.quoteVault, user, 'UT' + i)] });

t('pool resolver: decodes Raydium v4 vaults and rejects a pool that does not hold the token', async () => {
  const ok = resolver.decodeRaydiumAmmV4(Buffer.from(poolAccountData(true), 'base64'), KEYS.baseMint);
  assert.deepStrictEqual([ok.tokenVault, ok.quoteVault, ok.quoteMint], [KEYS.baseVault, KEYS.quoteVault, KEYS.quoteMint]);
  const flipped = resolver.decodeRaydiumAmmV4(Buffer.from(poolAccountData(false), 'base64'), KEYS.baseMint);
  assert.deepStrictEqual([flipped.tokenVault, flipped.quoteVault], [KEYS.quoteVault, KEYS.baseVault]);
  assert.strictEqual(resolver.decodeRaydiumAmmV4(Buffer.from(poolAccountData(true), 'base64'), bs58(99)), null);
  assert.strictEqual(resolver.decodeRaydiumAmmV4(Buffer.alloc(100), KEYS.baseMint), null);
});
t('pool resolver: non-Raydium owner falls back to pair-owned vaults', async () => {
  resolver._cache.clear();
  const pool = await resolver.resolvePool({ pairAddress: 'P1', mintAddress: KEYS.baseMint, rpc: rpcFor({ owner: 'SomeOtherProgram', data: ['', 'base64'] }) });
  assert.strictEqual(pool.kind, 'owner_pda');
});
t('raydium v4: buys/sells attributed via vaults, one row per swap, USD from the quote leg', async () => {
  resolver._cache.clear();
  const swaps = [rayBuy(0, 'U0', 1000, 2, 5), rayBuy(1, 'U1', 3000, 6, 6), raySell(2, 'U0', 500, 1, 4)];
  mockHttp((url, body) => {
    if (body && body.method === 'getAccountInfo') return { result: { value: { owner: RAY, data: [poolAccountData(true), 'base64'] } } };
    return { result: { data: swaps } };
  });
  const r = await providers.fetchHeliusWindow({ pairAddress: 'AMMID', mintAddress: KEYS.baseMint, startMs: cutoff - 36e5, endMs: cutoff, apiKey: 'k', quoteUsdPerUnit: 150 });
  assert.strictEqual(r.transfers.length, 3, 'quote legs must not become extra rows');
  const buys = r.transfers.filter((x) => x.role === 'buyer'), sells = r.transfers.filter((x) => x.role === 'seller');
  assert.deepStrictEqual(buys.map((x) => x.walletAddress), ['U0', 'U1']);
  assert.deepStrictEqual(sells.map((x) => x.walletAddress), ['U0']);
  assert.ok(buys.every((x) => x.valueSource === 'swap_quote_leg'));
  assert.strictEqual(buys[0].valueUsd, 2 * 150); assert.strictEqual(buys[1].valueUsd, 6 * 150); assert.strictEqual(sells[0].valueUsd, 1 * 150);
  const a = collector.aggregateTransfers(r.transfers, { pairAddress: 'AMMID', windowStartMs: cutoff - 36e5, windowEndMs: cutoff, priceUsd: 0.001 });
  assert.strictEqual(a.usdSource, 'swap_quote_leg'); assert.strictEqual(a.buyVolumeUsd, 1200);
  assert.strictEqual(a.usdPriceUsed, null);
});
t('wsol pool owned by pair: quote leg no longer double-counted as an opposite-role row', async () => {
  resolver._cache.clear();
  const swap1 = { signature: 'w1', blockTime: sec(5), slot: 1, tokenTransfers: [
    leg('So11111111111111111111111111111111111111112', 2, 'U0', 'UT0', PAIR, 'PV1'),
    leg('MINT', 1000, PAIR, 'PV2', 'U0', 'UB0')] };
  mockHttp((url, body) => (body && body.method === 'getAccountInfo') ? { result: { value: null } } : { result: { data: [swap1] } });
  const r = await providers.fetchHeliusWindow({ pairAddress: PAIR, mintAddress: 'MINT', startMs: cutoff - 36e5, endMs: cutoff, apiKey: 'k', quoteUsdPerUnit: 100 });
  assert.strictEqual(r.transfers.length, 1); assert.strictEqual(r.transfers[0].role, 'buyer'); assert.strictEqual(r.transfers[0].valueUsd, 200);
});
t('swap USD is apportioned by amount when one tx has several legs; unmatched quote falls back to spot', async () => {
  resolver._cache.clear();
  const multi = { signature: 'm1', blockTime: sec(5), slot: 1, tokenTransfers: [
    leg(KEYS.quoteMint, 10, 'U0', 'UT0', KEYS.authority, KEYS.quoteVault),
    leg(KEYS.baseMint, 300, KEYS.authority, KEYS.baseVault, 'U0', 'UB0'), leg(KEYS.baseMint, 700, KEYS.authority, KEYS.baseVault, 'U9', 'UB9')] };
  const noQuote = { signature: 'm2', blockTime: sec(4), slot: 2, tokenTransfers: [leg(KEYS.baseMint, 100, KEYS.authority, KEYS.baseVault, 'U5', 'UB5')] };
  mockHttp((url, body) => (body && body.method === 'getAccountInfo') ? { result: { value: { owner: RAY, data: [poolAccountData(true), 'base64'] } } } : { result: { data: [multi, noQuote] } });
  const r = await providers.fetchHeliusWindow({ pairAddress: 'AMMID', mintAddress: KEYS.baseMint, startMs: cutoff - 36e5, endMs: cutoff, apiKey: 'k', quoteUsdPerUnit: 10 });
  const usd = Object.fromEntries(r.transfers.map((x) => [x.walletAddress, x.valueUsd]));
  assert.strictEqual(usd.U0, 30); assert.strictEqual(usd.U9, 70); assert.strictEqual(usd.U5, null);
  const a = collector.aggregateTransfers(r.transfers, { pairAddress: 'AMMID', windowStartMs: cutoff - 36e5, windowEndMs: cutoff, priceUsd: 0.05 });
  assert.strictEqual(a.usdSource, 'mixed'); assert.strictEqual(a.buyVolumeUsd, 30 + 70 + 100 * 0.05);
});
t('capture: per-trade USD flows through scoring with quoteUsdPerUnit = priceUsd/priceNative', async () => {
  resolver._cache.clear();
  const swaps = Array.from({ length: 12 }, (_, i) => rayBuy(i, 'U' + i, 1000, 1 + (i % 3), 5 + i));
  mockHttp((url, body) => url.includes('helius') ? ((body && body.method === 'getAccountInfo') ? { result: { value: { owner: RAY, data: [poolAccountData(true), 'base64'] } } } : { result: { data: swaps } }) : { success: false, message: 'x' });
  const tk = { ...token, pairAddress: 'AMMID', baseToken: { address: KEYS.baseMint }, priceUsd: 0.0003, priceNative: 0.000002 };
  const r = await collector.captureFixedWindowWalletFeatures({ token: tk, tier1Admission: { pass: true }, cutoffMs: cutoff });
  const c = Object.fromEntries(r.tier2Score.components.map((x) => [x.key, x]));
  assert.ok(c.buyer_breadth.value === 12 && c.buyer_diversification.points === 1, JSON.stringify(r.tier2Score.components.map((x) => x.key + ':' + x.points + ':' + x.value)));
});

t('pool resolver: a transient RPC error is not cached as "not Raydium"', async () => {
  resolver._cache.clear();
  await assert.rejects(() => resolver.resolvePool({ pairAddress: 'AMMID', mintAddress: KEYS.baseMint, rpc: async () => ({ error: { message: 'rate limited' } }) }));
  assert.strictEqual(resolver._cache.size, 0);
  const pool = await resolver.resolvePool({ pairAddress: 'AMMID', mintAddress: KEYS.baseMint, rpc: async () => ({ result: { value: { owner: RAY, data: [poolAccountData(true), 'base64'] } } }) });
  assert.strictEqual(pool.kind, 'raydium_amm_v4');
  resolver._cache.clear();
  const unseen = await resolver.resolvePool({ pairAddress: 'NEW', mintAddress: KEYS.baseMint, rpc: async () => ({ result: { value: null } }) });
  assert.strictEqual(unseen.kind, 'owner_pda'); assert.strictEqual(resolver._cache.size, 0);
});
t('liquidity add/remove are not trades (LP withdraw must not become the top buyer)', async () => {
  resolver._cache.clear();
  const wd = { signature: 'wd', blockTime: sec(5), slot: 1, tokenTransfers: [leg(KEYS.baseMint, 5e6, KEYS.authority, KEYS.baseVault, 'RUGGER', 'x1'), leg(KEYS.quoteMint, 400, KEYS.authority, KEYS.quoteVault, 'RUGGER', 'x2')] };
  const dp = { signature: 'dp', blockTime: sec(8), slot: 2, tokenTransfers: [leg(KEYS.baseMint, 9e6, 'CREATOR', 'c1', KEYS.authority, KEYS.baseVault), leg(KEYS.quoteMint, 50, 'CREATOR', 'c2', KEYS.authority, KEYS.quoteVault)] };
  mockHttp((u, b) => (b && b.method === 'getAccountInfo') ? { result: { value: { owner: RAY, data: [poolAccountData(true), 'base64'] } } } : { result: { data: [wd, dp, rayBuy(3, 'U1', 1000, 2, 4)] } });
  const r = await providers.fetchHeliusWindow({ pairAddress: 'AMMID', mintAddress: KEYS.baseMint, startMs: cutoff - 36e5, endMs: cutoff, apiKey: 'k', quoteUsdPerUnit: 100 });
  assert.deepStrictEqual(r.transfers.map((x) => x.walletAddress), ['U1']);
});
t('router hop: buyer/seller resolve to the real trader, not the router authority', async () => {
  resolver._cache.clear();
  const buy = { signature: 'j1', blockTime: sec(5), slot: 1, tokenTransfers: [leg(KEYS.quoteMint, 3, 'USERA', 'a1', KEYS.authority, KEYS.quoteVault), leg(KEYS.baseMint, 1500, KEYS.authority, KEYS.baseVault, 'JUP_AUTH', 'j1'), leg(KEYS.baseMint, 1500, 'JUP_AUTH', 'j1', 'USERA', 'a2')] };
  const sell = { signature: 'j2', blockTime: sec(4), slot: 2, tokenTransfers: [leg(KEYS.baseMint, 700, 'USERB', 'b1', 'JUP_AUTH', 'j2'), leg(KEYS.baseMint, 700, 'JUP_AUTH', 'j2', KEYS.authority, KEYS.baseVault), leg(KEYS.quoteMint, 1, KEYS.authority, KEYS.quoteVault, 'USERB', 'b2')] };
  mockHttp((u, b) => (b && b.method === 'getAccountInfo') ? { result: { value: { owner: RAY, data: [poolAccountData(true), 'base64'] } } } : { result: { data: [buy, sell] } });
  const r = await providers.fetchHeliusWindow({ pairAddress: 'AMMID', mintAddress: KEYS.baseMint, startMs: cutoff - 36e5, endMs: cutoff, apiKey: 'k', quoteUsdPerUnit: 100 });
  assert.deepStrictEqual(r.transfers.map((x) => `${x.role}:${x.walletAddress}`), ['buyer:USERA', 'seller:USERB']);
});
t('participants: per-wallet USD is only written when the window basis is usd', async () => {
  const mk = (w, amt, usd) => ({ timestampMs: cutoff - 1000, mintAddress: 'M', role: 'buyer', walletAddress: w, fromAddress: 'P', toAddress: w, amount: amt, valueUsd: usd });
  const a = collector.aggregateTransfers([mk('A', 10, 500), mk('B', 10, null)], { pairAddress: 'P', windowStartMs: cutoff - 36e5, windowEndMs: cutoff, priceUsd: 0 });
  assert.strictEqual(a.valueBasis, 'token_amount');
  assert.ok(a.participants.every((p) => p.buyVolumeUsd === null));
});
let pglite = null;
try { pglite = require('@electric-sql/pglite'); } catch (e) { try { pglite = require(path.join(process.env.PGLITE_DIR || '/home/claude/pgtest', 'node_modules/@electric-sql/pglite')); } catch (e2) {} }
if (pglite) {
  const setup = async () => { db = new pglite.PGlite(); await db.exec(fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8')); await db.exec(fs.readFileSync(path.join(root, 'src/db/fixed_window_feature_schema.sql'), 'utf8')); };
  t('db: partial-coverage capture persists', async () => {
    await setup();
    mockHttp((url) => url.includes('helius') ? { result: { data: [0, 1].map((i) => swap(i, PAIR, 'B' + i, 5 + i)), paginationToken: 'next' } } : { success: false, message: 'down' });
    const r = await collector.captureFixedWindowWalletFeatures({ token, tier1Admission: { pass: true }, cutoffMs: cutoff });
    assert.ok(r.captureId);
    const vb = await db.query("select value_basis, buy_token_amount from wallet_window_features limit 1");
    assert.strictEqual(vb.rows[0].value_basis, 'usd'); assert.ok(Number(vb.rows[0].buy_token_amount) > 0);
    const us = await db.query('select usd_source, usd_price_used from wallet_window_features limit 1'); assert.strictEqual(us.rows[0].usd_source, 'spot_price_estimate'); assert.strictEqual(Number(us.rows[0].usd_price_used), 0.5);
    const q = await db.query("select coverage_status, coverage_reason from wallet_window_features");
    assert.ok(q.rows.length === 2 && q.rows.every((x) => x.coverage_status === 'partial' && x.coverage_reason));
  });
  t('db: wallet selling before buying in-window persists', async () => {
    await setup();
    mockHttp((url) => !url.includes('helius') ? { success: false, message: 'down' } : { result: { data: [swap(0, 'WX', PAIR, 20), swap(1, PAIR, 'WX', 10), swap(2, PAIR, 'B2', 9)] } });
    const r = await collector.captureFixedWindowWalletFeatures({ token, tier1Admission: { pass: true }, cutoffMs: cutoff });
    assert.ok(r.captureId);
  });
  t('db: platform activity query runs', async () => {
    await setup();
    const { collectPlatformTimingFeatures } = require('../src/services/platformTimingCollector');
    const p = await collectPlatformTimingFeatures({ token, cutoffMs: cutoff });
    assert.strictEqual(p.activityCoverageStatus, 'complete', String(p.activityError && p.activityError.message));
  });
} else console.log('SKIP db tests (pglite not installed)');

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS', name); } catch (e) { failed += 1; console.log('FAIL', name, '->', e.message.split('\n')[0]); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
