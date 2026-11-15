// Dev tool: runs the real server against realistic fixture payloads, no network needed.
// `node scripts/mock-server.js` serves on :8790. Tests import it with FLOWSTATE_NO_LISTEN=1.
const day = 864e5, now = Date.now();
let seed = 42; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const chains = { Ethereum: 1.6e11, Tron: 7.8e10, Solana: 1.4e10, BSC: 1.1e10, Arbitrum: 7e9, Base: 4.6e9, Hyperliquid: 5.5e9, Plasma: 3e9, Avalanche: 2.1e9, Polygon: 2.8e9, Aptos: 1.2e9, Sui: 1e9, Optimism: 8e8, TON: 7e8 };
const coin = (sym, share) => {
  const cc = {}; let cur = 0, p1 = 0, p7 = 0, p30 = 0;
  for (const [c, v] of Object.entries(chains)) { const x = v * share * (0.6 + rnd() * 0.8); const f = (s) => x * (1 - (rnd() - 0.45) * s); const a = f(0.004), b = f(0.03), d = f(0.08); cc[c] = { current: { peggedUSD: x }, circulatingPrevDay: { peggedUSD: a }, circulatingPrevWeek: { peggedUSD: b }, circulatingPrevMonth: { peggedUSD: d } }; cur += x; p1 += a; p7 += b; p30 += d; }
  return { symbol: sym, name: sym, pegType: 'peggedUSD', circulating: { peggedUSD: cur }, circulatingPrevDay: { peggedUSD: p1 }, circulatingPrevWeek: { peggedUSD: p7 }, circulatingPrevMonth: { peggedUSD: p30 }, chainCirculating: cc };
};
const stables = { peggedAssets: [coin('USDT', .6), coin('USDC', .25), coin('USDe', .05), coin('DAI', .02), coin('PYUSD', .01)] };
const P = (name, slug, category, chainTvls, c1, c7) => ({ name, slug, category, tvl: Object.values(chainTvls).reduce((a, b) => a + b, 0), chainTvls, change_1d: c1, change_7d: c7 });
const protocols = [
  P('Hyperliquid Bridge', 'hyperliquid-bridge', 'Bridge', { Arbitrum: 5.88e9 }, 1.4, 6.1),
  P('Aave V3', 'aave-v3', 'Lending', { Ethereum: 2.6e10, Arbitrum: 9e8, Base: 7e8, Avalanche: 4e8 }, -0.8, -3.2),
  P('Lido', 'lido', 'Liquid Staking', { Ethereum: 2.4e10 }, -0.5, -2.4),
  P('GMX V2', 'gmx-v2', 'Derivatives', { Arbitrum: 4.2e8, Avalanche: 6e7 }, 2.1, 9.4),
  P('Uniswap V3', 'uniswap-v3', 'Dexs', { Ethereum: 2.1e9, Arbitrum: 3.6e8, Base: 4.1e8 }, 0.4, -1.9),
  P('Pendle', 'pendle', 'Yield', { Ethereum: 3.1e9, Arbitrum: 2.2e8 }, 1.2, 4.8),
  P('Morpho', 'morpho', 'Lending', { Ethereum: 4e9, Base: 1.6e9 }, 0.9, 7.2),
  P('Camelot', 'camelot', 'Dexs', { Arbitrum: 9e7 }, -3.2, -11.5),
  P('Radiant', 'radiant', 'Lending', { Arbitrum: 6e7 }, -1.1, -6.3),
  P('Jupiter', 'jupiter', 'Dexs', { Solana: 2.4e9 }, 2.4, 5.5),
  P('Kamino', 'kamino', 'Lending', { Solana: 2.1e9 }, -0.4, -3.3),
  P('Ethena', 'ethena', 'Basis Trading', { Ethereum: 9e9 }, -1.6, -8.2),
  P('Aerodrome', 'aerodrome', 'Dexs', { Base: 1.1e9 }, 1.8, 3.9),
  P('JustLend', 'justlend', 'Lending', { Tron: 5e9 }, 0.1, -0.6),
  P('Hyperliquid Earn', 'hyperliquid-earn', 'Lending', { 'Hyperliquid L1': 1.4e9 }, -2.4, -7.3),
  P('Silo', 'silo', 'Lending', { Arbitrum: 1.2e8, Sonic: 2e8 }, 3.2, 14.1),
];
const hlU = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'SUI', 'kPEPE', 'FARTCOIN', 'ENA', 'AVAX', 'LINK', 'TAO', 'WIF'];
const hl = [{ universe: hlU.map((n) => ({ name: n, maxLeverage: n === 'BTC' ? 40 : 10 })) }, hlU.map((n, i) => { const px = [65421, 1830, 72, 31, 2.1, .16, 2.2, .009, .8, .45, 18, 13, 300, .6][i]; return { markPx: String(px), prevDayPx: String(px * (1 + (rnd() - 0.5) * 0.08)), dayNtlVlm: String(7.9e9 / (i + 1) ** 1.3), openInterest: String(5e9 / (i + 1) ** 1.2 / px), funding: String((rnd() - 0.4) * 0.00004) }; })];
const klines = Array.from({ length: 720 }, (_, i) => { const t = now - (720 - i) * 3600e3; const q = 4e7 * (0.5 + rnd()); const h = new Date(t).getUTCHours(); const bias = h >= 13 && h < 22 ? 0.53 : h >= 22 || h < 7 ? 0.47 : 0.505; return [t, '1', '1', '1', '1', '1', t + 3599999, String(q), 1, '1', String(q * (bias + (rnd() - 0.5) * 0.06)), '0']; });
const sectors = [['artificial-intelligence', 'AI', 3.8e10, 4.1], ['real-world-assets-rwa', 'RWA', 2.4e10, 1.2], ['meme-token', 'Meme', 6.2e10, -5.3], ['decentralized-finance-defi', 'DeFi', 1.18e11, -1.4], ['layer-1', 'L1', 2.1e12, -2.2], ['layer-2', 'L2', 2.2e10, -3.1], ['depin', 'DePIN', 2.1e10, 2.6], ['gaming', 'Gaming', 1.4e10, -0.9], ['stablecoins', 'Stables', 2.9e11, 0.1]].map(([id, name, mc, p]) => ({ id, name, market_cap: mc, market_cap_change_24h: p, volume_24h: mc * 0.07 }));
const bars = (p) => ({ chart: { result: [{ meta: { regularMarketPrice: p, regularMarketTime: Math.floor(now / 1000) - 3600 }, timestamp: Array.from({ length: 60 }, (_, i) => Math.floor((now - (60 - i) * day) / 1000)), indicators: { quote: [{ open: Array(60).fill(p), high: Array(60).fill(p * 1.01), low: Array(60).fill(p * .99), close: Array.from({ length: 60 }, () => p * (1 + (rnd() - 0.5) * 0.02)), volume: Array(60).fill(3e7) }] } }] } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => (typeof b === 'string' ? b : JSON.stringify(b)) });
  await new Promise((r) => setTimeout(r, 30));
  if (/stablecoins\.llama/.test(url)) return ok(stables);
  if (/api\.llama\.fi\/protocols/.test(url)) return ok(protocols);
  if (/api\.llama\.fi\/v2\/chains/.test(url)) return ok(Object.entries(chains).map(([name, v]) => ({ name, tvl: v / 3, tokenSymbol: '' })));
  if (/hyperliquid/.test(url)) return ok(hl);
  if (/klines/.test(url)) return ok(klines);
  if (/ticker\/price/.test(url)) return ok({ price: '65400.10' });
  if (/coinbase/.test(url)) return ok({ price: '65419.99' });
  if (/coingecko/.test(url)) return ok(sectors);
  if (/yahoo/.test(url)) return ok(bars(100 + rnd() * 400));
  if (/operating_cash_balance/.test(url)) return ok({ data: Array.from({ length: 40 }, (_, i) => ({ record_date: `2026-10-${String(40 - i).padStart(2, '0')}`, account_type: 'Treasury General Account (TGA) Closing Balance', close_today_bal: String(850000 + i * 3000) })) });
  if (/reverserepo/.test(url)) return ok({ repo: { operations: [{ operationDate: '2026-11-13', totalAmtAccepted: 4e10 }] } });
  if (/debt_to_penny/.test(url)) return ok({ data: [{ record_date: '2026-11-13', tot_pub_debt_out_amt: '38200000000000' }] });
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};
const { server } = await import('../server.js');
if (!process.env.FLOWSTATE_NO_LISTEN) server.listen(8790, () => console.log('Flowstate with fixtures on http://localhost:8790'));
export { server };
