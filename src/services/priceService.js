const axios = require('axios');

// CoinGecko's public simple-price endpoint — no key required, but has a
// modest rate limit on the free tier. If you're verifying many payments per
// minute, consider caching this for ~30-60s or switching to a paid/pro key.
// Docs: https://docs.coingecko.com/reference/simple-price
async function getSolUsdPrice() {
  const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: 'solana', vs_currencies: 'usd' },
    timeout: 8000,
  });
  const price = data && data.solana && data.solana.usd;
  if (!price) throw new Error('Could not resolve SOL/USD price from CoinGecko response.');
  return price;
}

module.exports = { getSolUsdPrice };
