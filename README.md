# FLOWSTATE — live capital flows

Shows where money is moving across crypto sectors (AI, RWA, memecoins, DeFi, L1/L2, DePIN, gaming, perps, prediction markets), chains, stablecoins, ETFs (equities, treasuries, credit, commodities, spot crypto), yields and US dollar liquidity. It also has a live whale-trade tape.

Zero dependencies. Node 18+.

## Flow scope (landing page)
An instrument for tracing money through four lenses, chosen with the dial:
- **Chains:** net stablecoin dollars in and out of each chain, plus issuer mints/redemptions.
- **Platforms:** TVL moving between DeFi platforms.
- **Assets:** market-cap rotation between crypto narratives.
- **Regions:** Binance buy/sell pressure grouped by Asia, Europe and Americas trading hours, plus the Coinbase premium.

Tap any band to make it the centre and see where that money came from and went next. Example trace: Arbitrum → Hyperliquid Bridge → Hyperliquid perps → BTC.
Solid bands are measured balance changes. Hatched bands are estimates (TVL changes include price moves). API: `/api/flow?node=chain:Arbitrum&w=d7&n=8`.

## Run locally
```bash
node server.js          # http://localhost:8787
npm test                # parser, provider and flow tests against fixtures
npm run dev             # full app on :8790 with fixture data, no network
```
If the page can't reach `/api/health`, it falls back to **demo mode** and shows a banner saying so.

## Deploy (pick one)
- **Render:** push this folder to GitHub, then New → Blueprint. Render reads `render.yaml`.
- **Railway / Fly / any VPS:** `node server.js`. Railway and Fly can also build the included `Dockerfile`.
- **Docker:** `docker build -t flowstate . && docker run -p 8787:8787 flowstate`

## Optional env vars
| Var | Unlocks |
|---|---|
| `FRED_API_KEY` | Fed balance sheet (WALCL) and the Net Liquidity tile. Free key at fred.stlouisfed.org |
| `COINGECKO_API_KEY` | Higher CoinGecko rate limit (free demo key) |
| `PORT` | Default 8787 |

## Data and methodology
| Panel | Source | Metric |
|---|---|---|
| Crypto sectors | CoinGecko `/coins/categories` | 24h market-cap change. This measures valuation, not deposits. |
| Stablecoins | DefiLlama stablecoins | Net mint/burn over 1D/7D/30D |
| Chain flows | DefiLlama `chainCirculating` | Change in USD stablecoins held on each chain |
| Bridge flows | bridges.llama.fi | 7D withdrawals (in) minus deposits (out) |
| ETFs | Yahoo Finance daily OHLCV | Money-flow-volume proxy: `((C−L)−(H−C))/(H−L) × V × C`. This is **not** official creation/redemption data. |
| Rates & dollar | Yahoo (^IRX ^FVX ^TNX ^TYX ^VIX DXY) | Level and change |
| Liquidity | Treasury FiscalData (TGA, debt), NY Fed (RRP), FRED (WALCL) | Net liquidity = Fed BS − TGA − RRP |
| Whale tape | Binance aggTrade WS, with Coinbase `matches` as fallback | Taker side, USD size |

Caching: sectors 2m, ETFs/macro 5m, stablecoins 5m, chains 10m, liquidity 30m. If an upstream fails, the last good copy is served.

## Upgrade path
- Official ETF flows: SoSoValue or Farside (BTC/ETH), or a paid provider for shares-outstanding data
- Exchange net flows and whale wallets: Arkham, Nansen, CryptoQuant APIs
- CEX ↔ on-chain flows: Dune queries via the Dune API
- Alerts: push a Telegram or X post when a signal crosses a threshold
