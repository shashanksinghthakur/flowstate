// FLOWSTATE — live capital flow aggregator
// Zero dependencies. Node 18+ (global fetch).
// Serves ./public and a set of /api/* endpoints that pull from free public sources,
// normalise them, and cache them in memory so upstream rate limits are respected.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const FRED_KEY = process.env.FRED_API_KEY || '';
const CG_KEY = process.env.COINGECKO_API_KEY || '';
const ALPACA_ID = process.env.ALPACA_KEY_ID || '';
const ALPACA_SECRET = process.env.ALPACA_SECRET || '';
const UA = 'Mozilla/5.0 (Flowstate; +https://github.com/) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ---------------------------------------------------------------- utilities
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  if (hit?.p) return hit.p; // de-dupe concurrent refreshes
  const p = fn()
    .then((v) => { cache.set(key, { t: Date.now(), v }); return v; })
    .catch((e) => { if (hit) { cache.set(key, hit); return hit.v; } cache.delete(key); throw e; });
  cache.set(key, { ...(hit || {}), p });
  return p;
}

async function getJSON(url, headers = {}, timeout = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function getText(url, headers = {}, timeout = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: String(e.message || e) }; } }
  }));
  return out;
}

// US cash session (9:30-16:00 New York, Mon-Fri; exchange holidays not modelled)
export function usMarketOpen(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return m >= 570 && m < 960;
}
const tradTTL = () => (usMarketOpen() ? 60_000 : 900_000);

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const isoDay = (d) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------- crypto sectors (CoinGecko)
// Market-cap delta per narrative. This is valuation change, not net deposits:
// it is the standard "rotation" read for sectors with no single settlement venue.
const SECTORS = [
  ['AI', /^(artificial-intelligence|ai-agents)$/],
  ['RWA', /^real-world-assets-rwa$/],
  ['Memecoins', /^meme-token$/],
  ['DeFi', /^decentralized-finance-defi$/],
  ['Layer 1', /^layer-1$/],
  ['Layer 2', /^layer-2$/],
  ['DePIN', /^depin$/],
  ['Gaming', /^gaming$/],
  ['Liquid staking', /^liquid-staking(-tokens)?$/],
  ['Stablecoins', /^stablecoins$/],
  ['Prediction mkts', /^prediction-markets$/],
  ['Perp DEX', /^perpetuals$/],
];

async function sectors() {
  return cached('sectors', 120_000, async () => {
    const headers = CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {};
    const rows = await getJSON('https://api.coingecko.com/api/v3/coins/categories', headers);
    const out = [];
    for (const [label, re] of SECTORS) {
      const matches = rows.filter((r) => re.test(r.id) && r.market_cap);
      if (!matches.length) continue;
      const r = matches.sort((a, b) => b.market_cap - a.market_cap)[0];
      const pct = num(r.market_cap_change_24h) ?? 0;
      const mcap = num(r.market_cap);
      out.push({
        id: r.id, label, name: r.name, mcap, pct24h: pct,
        delta24h: mcap - mcap / (1 + pct / 100),
        volume24h: num(r.volume_24h),
      });
    }
    return { source: 'CoinGecko /coins/categories', updated: Date.now(), rows: out };
  });
}

// ---------------------------------------------------------------- stablecoins (DefiLlama)
async function stablecoinsRaw() {
  return cached('stables_raw', 300_000, () => getJSON('https://stablecoins.llama.fi/stablecoins?includePrices=true'));
}
const usd = (o) => num(o?.peggedUSD) ?? 0;

async function stablecoins() {
  const raw = await stablecoinsRaw();
  const assets = (raw.peggedAssets || []).filter((a) => a.pegType === 'peggedUSD');
  const rows = assets.map((a) => ({
    symbol: a.symbol, name: a.name,
    supply: usd(a.circulating),
    d1: usd(a.circulating) - usd(a.circulatingPrevDay),
    d7: usd(a.circulating) - usd(a.circulatingPrevWeek),
    d30: usd(a.circulating) - usd(a.circulatingPrevMonth),
  })).sort((a, b) => b.supply - a.supply);
  const total = rows.reduce((s, r) => ({ supply: s.supply + r.supply, d1: s.d1 + r.d1, d7: s.d7 + r.d7, d30: s.d30 + r.d30 }), { supply: 0, d1: 0, d7: 0, d30: 0 });
  return { source: 'DefiLlama stablecoins', updated: Date.now(), total, rows: rows.slice(0, 15) };
}

// Stablecoin supply change per chain = the cleanest public read of dollars moving between chains.
async function chainStables() {
  const raw = await stablecoinsRaw();
  const by = new Map();
  for (const a of raw.peggedAssets || []) {
    if (a.pegType !== 'peggedUSD') continue;
    for (const [chain, c] of Object.entries(a.chainCirculating || {})) {
      const r = by.get(chain) || { chain, supply: 0, d1: 0, d7: 0, d30: 0 };
      const cur = usd(c.current);
      r.supply += cur;
      r.d1 += cur - usd(c.circulatingPrevDay);
      r.d7 += cur - usd(c.circulatingPrevWeek);
      r.d30 += cur - usd(c.circulatingPrevMonth);
      by.set(chain, r);
    }
  }
  const rows = [...by.values()].sort((a, b) => b.supply - a.supply).slice(0, 20);
  return { source: 'DefiLlama stablecoins (chainCirculating)', updated: Date.now(), rows };
}

// ---------------------------------------------------------------- chain TVL + bridge flows (DefiLlama)
const BRIDGE_CHAINS = ['Ethereum', 'Solana', 'Base', 'Arbitrum', 'BSC', 'Optimism', 'Polygon', 'Avalanche', 'Hyperliquid', 'Sui'];

async function chains() {
  return cached('chains', 600_000, async () => {
    const [tvl, bridges] = await Promise.all([
      getJSON('https://api.llama.fi/v2/chains').catch(() => []),
      pool(BRIDGE_CHAINS, 3, async (chain) => {
        const days = await getJSON(`https://bridges.llama.fi/bridgevolume/${encodeURIComponent(chain)}`);
        const last = (days || []).slice(-7);
        // DefiLlama convention: depositUSD = value bridged OUT of this chain, withdrawUSD = value bridged IN.
        const inflow = last.reduce((s, d) => s + (num(d.withdrawUSD) || 0), 0);
        const outflow = last.reduce((s, d) => s + (num(d.depositUSD) || 0), 0);
        const lastDay = last[last.length - 1] || {};
        return { chain, in7d: inflow, out7d: outflow, net7d: inflow - outflow, net1d: (num(lastDay.withdrawUSD) || 0) - (num(lastDay.depositUSD) || 0) };
      }),
    ]);
    const tvlRows = (tvl || []).filter((c) => c.tvl > 0).sort((a, b) => b.tvl - a.tvl).slice(0, 20).map((c) => ({ chain: c.name, tvl: c.tvl, token: c.tokenSymbol }));
    return { source: 'DefiLlama /v2/chains + bridges.llama.fi', updated: Date.now(), tvl: tvlRows, bridges: bridges.filter((b) => b && !b.error) };
  });
}

// ---------------------------------------------------------------- TradFi (Yahoo Finance chart API)
// ETF creation/redemption data is not free. We publish a transparent proxy instead:
// dollar money-flow volume = ((C-L)-(H-C))/(H-L) * Volume * Close, summed over a window.
// Positive = closing near highs on volume (accumulation). Labelled as a proxy in the UI.
export const TRADFI = {
  'US equities': ['SPY', 'QQQ', 'IWM', 'DIA'],
  'Global equities': ['EFA', 'EEM', 'INDA', 'FXI'],
  'Sectors': ['XLK', 'SMH', 'XLF', 'XLE', 'XLV'],
  'Treasuries': ['BIL', 'SHY', 'IEF', 'TLT', 'TIP'],
  'Credit': ['AGG', 'LQD', 'HYG'],
  'Commodities': ['GLD', 'SLV', 'USO'],
  'Crypto ETFs': ['IBIT', 'FBTC', 'GBTC', 'ETHA'],
  'Dollar': ['UUP'],
};
const MACRO = { '^IRX': '3M yield', '^FVX': '5Y yield', '^TNX': '10Y yield', '^TYX': '30Y yield', '^VIX': 'VIX', 'DX-Y.NYB': 'DXY' };

async function yahoo(sym) {
  return cached(`y:${sym}`, tradTTL(), async () => {
    const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`);
    const r = j?.chart?.result?.[0];
    if (!r) throw new Error('no data');
    const q = r.indicators.quote[0];
    const bars = r.timestamp.map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }))
      .filter((b) => b.c != null);
    return { sym, price: r.meta.regularMarketPrice ?? bars.at(-1)?.c, asOf: (r.meta.regularMarketTime || 0) * 1000 || bars.at(-1)?.t, bars };
  });
}

export function summarise(sym, d) {
  const b = d.bars;
  const c = b.map((x) => x.c);
  const last = c.at(-1);
  const pct = (n) => (c.length > n ? (last / c[c.length - 1 - n] - 1) * 100 : null);
  const mfv = b.map((x) => (x.h > x.l && x.v ? (((x.c - x.l) - (x.h - x.c)) / (x.h - x.l)) * x.v * x.c : 0));
  const sum = (n) => mfv.slice(-n).reduce((s, v) => s + v, 0);
  return {
    sym, price: d.price ?? last, asOf: d.asOf, chg1d: pct(1), chg5d: pct(5), chg20d: pct(20),
    dollarVol: (b.at(-1)?.v || 0) * last,
    flow1d: sum(1), flow5d: sum(5), flow20d: sum(20),
    spark: c.slice(-30),
  };
}

// Alpaca (needs free keys). Daily bars from the consolidated SIP feed are free once
// they are 15+ minutes old, so volume is full-market; latest price comes from IEX in real time.
async function alpacaBars(syms) {
  return cached('alpaca:bars', tradTTL(), async () => {
    const h = { 'APCA-API-KEY-ID': ALPACA_ID, 'APCA-API-SECRET-KEY': ALPACA_SECRET };
    const start = new Date(Date.now() - 100 * 864e5).toISOString();
    const end = new Date(Date.now() - 16 * 60e3).toISOString();
    const bars = {};
    let token = '';
    do {
      const j = await getJSON(`https://data.alpaca.markets/v2/stocks/bars?symbols=${syms.join(',')}&timeframe=1Day&start=${start}&end=${end}&feed=sip&adjustment=raw&limit=10000${token ? `&page_token=${token}` : ''}`, h);
      for (const [sym, arr] of Object.entries(j.bars || {})) (bars[sym] ||= []).push(...arr.map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
      token = j.next_page_token || '';
    } while (token);
    let latest = {};
    try { latest = (await getJSON(`https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${syms.join(',')}&feed=iex`, h)).trades || {}; } catch {}
    return Object.fromEntries(Object.entries(bars).filter(([, b]) => b.length).map(([sym, b]) => [sym, {
      sym, price: latest[sym]?.p ?? b.at(-1).c, asOf: latest[sym]?.t ? Date.parse(latest[sym].t) : b.at(-1).t, bars: b,
    }]));
  });
}

// Stooq: free daily CSV, no key. Used when Alpaca keys are absent and Yahoo refuses the server.
export async function stooq(sym) {
  return cached(`s:${sym}`, tradTTL(), async () => {
    const txt = await getText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.toLowerCase())}.us&i=d`);
    const lines = txt.trim().split(/\r?\n/);
    if (!/^date/i.test(lines[0] || '')) throw new Error('stooq: no data');
    const bars = lines.slice(1).slice(-70).map((l) => { const [d, o, h, lo, c, v] = l.split(','); return { t: Date.parse(d), o: +o, h: +h, l: +lo, c: +c, v: +v }; })
      .filter((b) => b.c > 0);
    if (!bars.length) throw new Error('stooq: empty');
    return { sym, price: bars.at(-1).c, asOf: bars.at(-1).t, bars };
  });
}

async function tradfi() {
  return cached('tradfi', tradTTL(), async () => {
    const syms = Object.values(TRADFI).flat();
    let bySym = {}, source = '';
    if (ALPACA_ID && ALPACA_SECRET) {
      try { bySym = await alpacaBars(syms); source = 'Alpaca (SIP daily bars + IEX last trade)'; } catch (e) { console.warn('alpaca', e.message); }
    }
    const missing = syms.filter((s) => !bySym[s]);
    if (missing.length) {
      const res = await pool(missing, 4, async (s) => { try { return await yahoo(s); } catch { return await stooq(s); } });
      missing.forEach((s, i) => { if (res[i]?.bars) bySym[s] = res[i]; });
      source ||= 'Yahoo / Stooq daily OHLCV';
    }
    const groups = Object.entries(TRADFI).map(([group, list]) => ({
      group, rows: list.filter((s) => bySym[s]?.bars?.length).map((s) => summarise(s, bySym[s])),
    }));
    return { source: `${source}; flow = money-flow-volume proxy`, updated: Date.now(), marketOpen: usMarketOpen(), groups };
  });
}

// Rates & dollar. FRED (free key) is the reliable server-side source; Yahoo is the fallback.
const FRED_MACRO = { '^IRX': 'DGS3MO', '^FVX': 'DGS5', '^TNX': 'DGS10', '^TYX': 'DGS30', '^VIX': 'VIXCLS', 'DX-Y.NYB': 'DTWEXBGS' };
async function fredSeries(id) {
  return cached(`fred:${id}`, 3_600_000, async () => {
    const j = await getJSON(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=45`);
    return (j.observations || []).filter((o) => o.value !== '.' && o.value != null).map((o) => ({ t: Date.parse(o.date), c: Number(o.value) })).reverse();
  });
}

async function macro() {
  return cached('macro', tradTTL(), async () => {
    const syms = Object.keys(MACRO);
    const res = await pool(syms, 3, async (s) => {
      if (FRED_KEY) {
        try {
          const obs = await fredSeries(FRED_MACRO[s]);
          if (obs.length > 2) return { sym: s, label: s === 'DX-Y.NYB' ? 'Dollar (broad)' : MACRO[s], src: 'FRED', obs };
        } catch {}
      }
      const d = await yahoo(s);
      return { sym: s, label: MACRO[s], src: 'Yahoo', obs: d.bars.map((b) => ({ t: b.t, c: b.c })), price: d.price, asOf: d.asOf };
    });
    const rows = res.filter((r) => r?.obs?.length).map((r) => {
      const c = r.obs.map((o) => o.c);
      return { sym: r.sym, label: r.label, src: r.src, asOf: r.asOf ?? r.obs.at(-1).t, value: r.price ?? c.at(-1), prev: c.at(-2), monthAgo: c.at(-22) ?? c[0], spark: c.slice(-30) };
    });
    const srcs = [...new Set(rows.map((r) => r.src))].join(' + ') || 'unavailable';
    return { source: srcs === 'FRED' ? 'FRED daily (latest published close)' : srcs, updated: Date.now(), marketOpen: usMarketOpen(), rows };
  });
}

// ---------------------------------------------------------------- liquidity (Treasury, NY Fed, FRED)
async function liquidity() {
  return cached('liquidity', 1_800_000, async () => {
    const end = new Date(); const start = new Date(Date.now() - 75 * 864e5);
    const [tga, rrp, debt, walcl] = await Promise.all([
      getJSON('https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?sort=-record_date&page[size]=300')
        .then((j) => (j.data || [])
          .filter((r) => /closing balance/i.test(r.account_type) && /tga|general account/i.test(r.account_type))
          .map((r) => ({ date: r.record_date, value: (num(r.close_today_bal) ?? num(r.open_today_bal)) * 1e6 }))
          .filter((r) => r.value > 0).reverse())
        .catch(() => []),
      getJSON(`https://markets.newyorkfed.org/api/rp/reverserepo/propositions/search.json?startDate=${isoDay(start)}&endDate=${isoDay(end)}`)
        .then((j) => (j?.repo?.operations || []).map((o) => ({ date: o.operationDate, value: num(o.totalAmtAccepted) })).filter((r) => r.value != null)
          .sort((a, b) => a.date.localeCompare(b.date)))
        .catch(() => []),
      getJSON('https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=60')
        .then((j) => (j.data || []).map((r) => ({ date: r.record_date, value: num(r.tot_pub_debt_out_amt) })).reverse())
        .catch(() => []),
      FRED_KEY
        ? getJSON(`https://api.stlouisfed.org/fred/series/observations?series_id=WALCL&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=12`)
          .then((j) => (j.observations || []).map((o) => ({ date: o.date, value: num(o.value) * 1e6 })).reverse())
          .catch(() => [])
        : Promise.resolve([]),
    ]);
    const lastV = (a) => a.at(-1)?.value ?? null;
    const net = walcl.length && tga.length && rrp.length ? lastV(walcl) - lastV(tga) - lastV(rrp) : null;
    return {
      source: 'US Treasury FiscalData (TGA, debt), NY Fed (RRP), FRED WALCL (optional key)', updated: Date.now(),
      tga, rrp, debt, walcl, netLiquidity: net, fredEnabled: Boolean(FRED_KEY),
    };
  });
}

// ---------------------------------------------------------------- http
const ROUTES = {
  '/api/sectors': sectors, '/api/stablecoins': stablecoins, '/api/chain-stables': chainStables,
  '/api/chains': chains, '/api/tradfi': tradfi, '/api/macro': macro, '/api/liquidity': liquidity,
  '/api/health': async () => ({ ok: true, live: true, fred: Boolean(FRED_KEY), alpaca: Boolean(ALPACA_ID && ALPACA_SECRET), coingecko: Boolean(CG_KEY), t: Date.now() }),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = ROUTES[url.pathname];
  if (route) {
    try {
      const body = JSON.stringify(await route());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=30', 'access-control-allow-origin': '*' });
      return res.end(body);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }
  const p = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`FLOWSTATE live on http://localhost:${PORT}`));
}
export { server };
