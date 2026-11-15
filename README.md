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
npm test                # parser, provider, flow and alert tests against fixtures
npm run dev             # full app on :8790 with fixture data, no network
```
If the page can't reach `/api/health`, it falls back to **demo mode** and shows a banner saying so.

## Deploy (pick one)
- **Render:** push this folder to GitHub, then New → Blueprint. Render reads `render.yaml`.
- **Railway / Fly / any VPS:** `node server.js`. Railway and Fly can also build the included `Dockerfile`.
- **Docker:** `docker build -t flowstate . && docker run -p 8787:8787 flowstate`

## Money trails
Follows large wallets hop by hop: an Aave V3 withdrawal (Ethereum or Arbitrum), then USDC sent from the same address to the Hyperliquid bridge, then that address's Hyperliquid trades and open positions (e.g. "pulled $1.8M of WETH from Aave, moved $1.8M onto Hyperliquid 60 min later, opened a $9M ETH short at 5x"). Also tracks withdrawals off Hyperliquid and large standalone Aave exits.
- Data: public Arbitrum and Ethereum RPC nodes (no key), Hyperliquid info API, DefiLlama prices. Polls every 2 minutes and backfills 6 hours on start.
- Trails of $1M+ that end in a new position post to the Telegram channel.
- Optional: `ARBITRUM_RPC_URL` / `ETHEREUM_RPC_URL` (e.g. Alchemy) for higher limits, `TRAIL_MIN_USD` (default 250000).
- API: `/api/trails`.

## Login = newsletter signup
Every email entered on the login page is added to the Noise Floor list (source `signup`, or `early-access` before accounts are switched on). Before Supabase is connected, emails queue in `data/pending-subscribers.jsonl` and flush to Supabase automatically once it is. Render's free disk is wiped on each deploy, so connect Supabase before you drive traffic.

## Accounts, newsletter and alerts setup

### Supabase (login, onboarding answers, newsletter list), about 10 minutes
1. Create a free project at supabase.com.
2. SQL Editor → New query → paste `supabase/schema.sql` → Run.
3. Authentication → URL Configuration: set **Site URL** to your Render URL and add the same URL under **Redirect URLs**.
4. Project Settings → API: copy the Project URL, the `anon` key and the `service_role` key into Render as `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
5. Supabase's built-in email sender is rate-limited and meant for testing. Before launch, add a custom SMTP sender under Authentication → SMTP Settings (for example Resend).

Export the newsletter list any time: `https://<your-site>/api/admin/subscribers.csv?token=<ADMIN_TOKEN>` (Render generates `ADMIN_TOKEN`; find it under Environment).

### Telegram alert channel, about 5 minutes
1. In Telegram, message @BotFather, send `/newbot`, and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Create a public channel (e.g. `@flowstate_alerts`). Add the bot as an admin with permission to post.
3. Set `TELEGRAM_CHAT_ID` to `@flowstate_alerts` and `TELEGRAM_CHANNEL_URL` to `https://t.me/flowstate_alerts`.
4. Test: open `https://<your-site>/api/admin/alert?token=<ADMIN_TOKEN>` with a POST (or `kind=digest` for the daily digest).

Alerts posted: stablecoin mint/redemption waves over $500M, chain swings over $300M, Hyperliquid bridge moves over $100M (all 24h), Coinbase whale bursts over $5M, Coinbase premium beyond ±15 bps, and a daily digest at 13:00 UTC. Tune with `ALERT_WHALE_MIN_USD` and `ALERT_DIGEST_HOUR_UTC`. Without a token the bot runs in dry-run mode and logs what it would post at `/api/alerts/recent`.

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
