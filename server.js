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

async function postJSON(url, body, timeout = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
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

async function chainStablesAll() {
  const raw = await stablecoinsRaw();
  const by = new Map();
  for (const a of raw.peggedAssets || []) {
    if (a.pegType !== 'peggedUSD') continue;
    for (const [chain, c] of Object.entries(a.chainCirculating || {})) {
      const r = by.get(chain) || { chain, supply: 0, d1: 0, d7: 0, d30: 0 };
      const cur = usd(c.current);
      r.supply += cur; r.d1 += cur - usd(c.circulatingPrevDay); r.d7 += cur - usd(c.circulatingPrevWeek); r.d30 += cur - usd(c.circulatingPrevMonth);
      by.set(chain, r);
    }
  }
  return [...by.values()].filter((r) => r.supply > 0);
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


// ---------------------------------------------------------------- Flow Scope (layered flow graph)
// Every node returns: where value came from (left), where it went (right), and a readout.
// Each band carries a method: 'measured' (observed balance change) or 'estimated' (inferred, see note).
const CHAIN_ALIAS = { Hyperliquid: 'Hyperliquid L1' };
const ALIAS_BACK = Object.fromEntries(Object.entries(CHAIN_ALIAS).map(([a, b]) => [b, a]));
const SKIP_CHAIN_KEYS = /-|^(borrowed|staking|pool2|vesting|treasury|offers|doublecounted|liquidstaking|dcAndLsOverlap)$/i;

async function protocolsRaw() {
  return cached('protocols', 600_000, async () => {
    const j = await getJSON('https://api.llama.fi/protocols', {}, 40000);
    return j.filter((p) => p.tvl > 5e6 && p.category !== 'CEX' && p.chainTvls).map((p) => {
      const chains = {};
      for (const [k, v] of Object.entries(p.chainTvls)) {
        if (SKIP_CHAIN_KEYS.test(k)) continue;
        const val = typeof v === 'number' ? v : num(v?.tvl?.at?.(-1)?.totalLiquidityUSD);
        if (val > 0) chains[k] = val;
      }
      return { name: p.name, slug: p.slug, category: p.category, tvl: p.tvl, c1: num(p.change_1d), c7: num(p.change_7d), chains };
    });
  });
}
// TVL change implied by a % change. Includes price moves, so it is an estimate of net deposits.
const pctDelta = (v, c) => (c == null || !isFinite(c) ? null : v - v / (1 + c / 100));
const protoPct = (p, w) => (w === 'd1' ? p.c1 : p.c7);

const hlSnaps = [];
async function hlRaw() {
  return cached('hl', 60_000, async () => {
    const [meta, ctxs] = await postJSON('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
    const assets = meta.universe.map((u, i) => {
      const c = ctxs[i] || {};
      const px = num(c.markPx) || 0;
      return { coin: u.name, px, prevPx: num(c.prevDayPx), vol: num(c.dayNtlVlm) || 0, oi: (num(c.openInterest) || 0) * px, funding: num(c.funding) || 0, maxLev: u.maxLeverage };
    }).filter((a) => a.vol > 0 || a.oi > 0);
    hlSnaps.push({ t: Date.now(), oi: Object.fromEntries(assets.map((a) => [a.coin, a.oi])) });
    while (hlSnaps.length && Date.now() - hlSnaps[0].t > 26 * 3600e3) hlSnaps.shift();
    return assets;
  });
}

// Binance hourly bars carry taker-buy volume, so net aggressive flow per hour is exact.
// Hours are grouped into trading sessions by UTC time: this shows WHEN money moved, which tracks
// where the active traders are; it is not exchange-reported domicile.
const SESSIONS = [['Asia hours', (h) => h >= 22 || h < 7], ['Europe hours', (h) => h >= 7 && h < 13], ['Americas hours', (h) => h >= 13 && h < 22]];
async function sessionsRaw() {
  return cached('sessions', 600_000, async () => {
    const out = {};
    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      const k = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1h&limit=720`);
      out[sym] = k.map((r) => ({ t: r[0], net: 2 * Number(r[10]) - Number(r[7]), vol: Number(r[7]) }));
    }
    return out;
  });
}
async function coinbasePremium() {
  return cached('cbprem', 60_000, async () => {
    const [cb, bn] = await Promise.all([
      getJSON('https://api.exchange.coinbase.com/products/BTC-USD/ticker'),
      getJSON('https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT'),
    ]);
    const c = num(cb.price), b = num(bn.price);
    return c && b ? { cb: c, bn: b, bps: (c / b - 1) * 1e4 } : null;
  });
}

const WIN_LABEL = { d1: '24h', d7: '7d', d30: '30d' };
function side(items, n) {
  const s = items.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  if (s.length <= n) return s;
  const rest = s.slice(n - 1);
  return [...s.slice(0, n - 1), { label: `${rest.length} others`, value: rest.reduce((t, x) => t + x.value, 0), method: rest.every((x) => x.method === 'measured') ? 'measured' : 'estimated', tone: 'neutral', other: true }];
}
const fmt$ = (v) => { const a = Math.abs(v); const s = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : (a / 1e3).toFixed(0) + 'K'; return `${v < 0 ? '−' : ''}$${s}`; };

async function flowNode(id, w, n) {
  const W = WIN_LABEL[w] || '7d';

  if (id === 'chains') {
    const rows = await chainStablesAll();
    const total = rows.reduce((t, r) => t + r[w], 0);
    const supply = rows.reduce((t, r) => t + r.supply, 0);
    const left = rows.filter((r) => r[w] < 0).map((r) => ({ id: `chain:${r.chain}`, label: r.chain, value: -r[w], method: 'measured', tone: 'out' }));
    const right = rows.filter((r) => r[w] > 0).map((r) => ({ id: `chain:${r.chain}`, label: r.chain, value: r[w], method: 'measured', tone: 'in' }));
    (total >= 0 ? left : right).push({ label: total >= 0 ? 'Issuers (net mint)' : 'Issuers (net redeem)', value: Math.abs(total), method: 'measured', tone: total >= 0 ? 'in' : 'out' });
    const top = [...right].filter((x) => x.id).sort((a, b) => b.value - a.value)[0];
    return {
      title: 'All chains', kind: 'Stablecoin dollars', leftLabel: `Chains losing dollars, ${W}`, rightLabel: `Chains gaining dollars, ${W}`,
      left: side(left, n), right: side(right, n),
      readout: { net: total, netLabel: `Net new stablecoins, ${W}`, base: supply, baseLabel: 'Stablecoins outstanding', gauge: { value: (total / supply) * 100, min: -2, max: 2, label: 'Supply change' },
        headline: `${fmt$(Math.abs(total))} of stablecoins were ${total >= 0 ? 'minted into' : 'redeemed out of'} crypto over ${W}.${top ? ` ${top.label} still took in the most: ${fmt$(top.value)}.` : ''}`.replace(' still', total >= 0 ? '' : ' still') },
      notes: ['Bands show each chain’s net change in USD stablecoins. Individual transfers between chains are not observed yet.'],
      source: 'DefiLlama stablecoins',
    };
  }

  if (id.startsWith('chain:')) {
    const chain = id.slice(6);
    const key = CHAIN_ALIAS[chain] || chain;
    const [rows, protos] = await Promise.all([chainStablesAll(), protocolsRaw()]);
    const r = rows.find((x) => x.chain === chain) || { supply: 0, d1: 0, d7: 0, d30: 0 };
    const net = r[w];
    const ps = protos.filter((p) => p.chains[key]).map((p) => ({ p, d: pctDelta(p.chains[key], protoPct(p, w)) })).filter((x) => x.d != null && Math.abs(x.d) > 1e5);
    const left = ps.filter((x) => x.d < 0).map((x) => ({ id: `proto:${x.p.slug}`, label: x.p.name, value: -x.d, method: 'estimated', tone: 'out', sub: x.p.category }));
    const right = ps.filter((x) => x.d > 0).map((x) => ({ id: `proto:${x.p.slug}`, label: x.p.name, value: x.d, method: 'estimated', tone: 'in', sub: x.p.category }));
    if (net > 0) left.push({ id: 'chains', label: 'Other chains & issuers', value: net, method: 'measured', tone: 'in' });
    if (net < 0) right.push({ id: 'chains', label: 'Other chains & issuers', value: -net, method: 'measured', tone: 'out' });
    const tvl = protos.reduce((t, p) => t + (p.chains[key] || 0), 0);
    const topIn = [...right].filter((x) => x.id !== 'chains').sort((a, b) => b.value - a.value)[0];
    return {
      title: chain, kind: 'Chain', leftLabel: `Into ${chain}, ${W}`, rightLabel: `Out to platforms, ${W}`,
      left: side(left, n), right: side(right, n),
      readout: { net, netLabel: `Net stablecoin flow, ${W}`, base: r.supply, baseLabel: 'Stablecoins on chain', gauge: { value: r.supply ? (net / r.supply) * 100 : 0, min: -5, max: 5, label: 'Absorption' },
        extra: [['DeFi TVL on chain', fmt$(tvl)], ['Platforms tracked', String(ps.length)]],
        headline: `${chain} ${net >= 0 ? 'gained' : 'lost'} ${fmt$(Math.abs(net))} of stablecoins over ${W}.${topIn ? ` Biggest platform inflow: ${topIn.label} (${fmt$(topIn.value)}).` : ''}` },
      notes: ['Platform bands are TVL changes on this chain, so they include price moves.', w === 'd30' ? 'Platform data is 7d; 30d is shown for stablecoins only.' : null].filter(Boolean),
      source: 'DefiLlama stablecoins + protocols',
    };
  }

  if (id.startsWith('proto:')) {
    const slug = id.slice(6);
    const protos = await protocolsRaw();
    const p = protos.find((x) => x.slug === slug);
    if (!p) return { title: slug, kind: 'Platform', left: [], right: [], readout: { headline: 'This platform is not in the current dataset.' }, notes: [] };
    const pct = protoPct(p, w);
    const per = Object.entries(p.chains).map(([c, v]) => ({ chain: ALIAS_BACK[c] || c, d: pctDelta(v, pct) })).filter((x) => x.d != null);
    let left = per.filter((x) => x.d > 0).map((x) => ({ id: `chain:${x.chain}`, label: x.chain, value: x.d, method: 'estimated', tone: 'in' }));
    let right = per.filter((x) => x.d < 0).map((x) => ({ id: `chain:${x.chain}`, label: x.chain, value: -x.d, method: 'estimated', tone: 'out' }));
    const net = per.reduce((t, x) => t + x.d, 0);
    const notes = ['Bands are TVL changes per chain and include price moves.'];
    if (slug === 'hyperliquid-bridge') {
      // Assets parked in the bridge are trading margin on Hyperliquid, so their change is net deposits.
      // Arbitrum holds USDC (measured); other routes can hold volatile assets (estimated).
      left = per.map((x) => ({ id: x.chain === 'Arbitrum' ? 'chain:Arbitrum' : null, label: `${x.chain} ${x.d >= 0 ? 'deposits' : 'withdrawals'}`, value: Math.abs(x.d), method: x.chain === 'Arbitrum' ? 'measured' : 'estimated', tone: x.d >= 0 ? 'in' : 'out' }));
      right = [{ id: 'hl', label: net >= 0 ? 'Hyperliquid perps margin' : 'Net withdrawn from Hyperliquid', value: Math.abs(net), method: per.length === 1 ? 'measured' : 'estimated', tone: net >= 0 ? 'in' : 'out' }];
      notes.splice(0, 1, 'The bridge balance is trading margin on Hyperliquid, so its change is net deposits. The Arbitrum side is USDC; other routes can include volatile assets.');
    }
    return {
      title: p.name, kind: p.category, leftLabel: `Deposits from, ${W}`, rightLabel: `Withdrawn to, ${W}`,
      left: side(left, n), right: side(right, n),
      readout: { net, netLabel: `Net change, ${W}`, base: p.tvl, baseLabel: 'TVL', gauge: { value: pct ?? 0, min: -20, max: 20, label: `TVL change, ${w === 'd1' ? '24h' : '7d'}` },
        headline: `${p.name} ${net >= 0 ? 'took in' : 'lost'} ${fmt$(Math.abs(net))} over ${w === 'd1' ? '24h' : '7d'}.` },
      notes, source: 'DefiLlama protocols',
    };
  }

  if (id === 'hl') {
    const [assets, protos] = await Promise.all([hlRaw(), protocolsRaw()]);
    const br = protos.find((x) => x.slug === 'hyperliquid-bridge');
    const dep = br ? Object.values(br.chains).reduce((t, v) => t + (pctDelta(v, protoPct(br, w)) || 0), 0) : 0;
    const vol = assets.reduce((t, a) => t + a.vol, 0), oi = assets.reduce((t, a) => t + a.oi, 0);
    const right = assets.map((a) => ({ id: `hl:${a.coin}`, label: a.coin, value: a.vol, method: 'measured', tone: a.prevPx && a.px >= a.prevPx ? 'in' : 'out', sub: `OI ${fmt$(a.oi)}` }));
    const top = [...assets].sort((a, b) => b.vol - a.vol).slice(0, 3).map((a) => a.coin).join(', ');
    return {
      title: 'Hyperliquid perps', kind: 'Venue', leftLabel: `Net bridge deposits, ${w === 'd1' ? '24h' : '7d'}`, rightLabel: 'Traded into, 24h volume',
      left: [{ id: 'proto:hyperliquid-bridge', label: dep >= 0 ? 'Bridge deposits' : 'Bridge withdrawals', value: Math.abs(dep), method: 'estimated', tone: dep >= 0 ? 'in' : 'out' }],
      right: side(right, n),
      readout: { net: dep, netLabel: 'Net deposits', base: oi, baseLabel: 'Open interest', gauge: { value: oi ? (dep / oi) * 100 : 0, min: -5, max: 5, label: 'Deposits vs OI' },
        extra: [['24h volume', fmt$(vol)], ['Markets', String(assets.length)]],
        headline: `${fmt$(Math.abs(dep))} of margin ${dep >= 0 ? 'arrived through' : 'left through'} the bridge. Most trading went to ${top}.` },
      notes: ['Deposits and volume are different measures, so each side is scaled on its own.'],
      source: 'Hyperliquid info API + DefiLlama',
    };
  }

  if (id.startsWith('hl:')) {
    const coin = id.slice(3);
    const a = (await hlRaw()).find((x) => x.coin === coin);
    if (!a) return { title: coin, kind: 'Market', left: [], right: [], readout: { headline: 'Market not found.' }, notes: [] };
    const age = hlSnaps.length ? Date.now() - hlSnaps[0].t : 0;
    const old = age > 15 * 60e3 ? hlSnaps[0]?.oi?.[coin] : null;
    const oiChg = old ? a.oi - old : null;
    const chg = a.prevPx ? (a.px / a.prevPx - 1) * 100 : 0;
    const fundAnn = a.funding * 24 * 365 * 100;
    return {
      title: `${coin} perp`, kind: 'Hyperliquid market', leftLabel: 'Traded on', rightLabel: '',
      left: [{ id: 'hl', label: 'Hyperliquid perps', value: a.vol, method: 'measured', tone: chg >= 0 ? 'in' : 'out' }], right: [],
      readout: { net: oiChg ?? a.oi, netLabel: oiChg != null ? `OI change, last ${age >= 3600e3 ? Math.round(age / 3600e3) + 'h' : Math.round(age / 60e3) + 'm'}` : 'Open interest', base: a.oi, baseLabel: 'Open interest',
        gauge: { value: fundAnn, min: -50, max: 50, label: 'Funding, annualised %' },
        extra: [['Price', a.px.toLocaleString('en-US', { maximumFractionDigits: a.px < 1 ? 6 : 2 })], ['24h change', `${chg >= 0 ? '+' : '−'}${Math.abs(chg).toFixed(2)}%`], ['24h volume', fmt$(a.vol)], ['Max leverage', `${a.maxLev}x`]],
        headline: `${coin}: ${fmt$(a.vol)} traded in 24h. Funding ${fundAnn >= 0 ? 'positive, longs pay shorts' : 'negative, shorts pay longs'}.` },
      notes: ['Open-interest change is measured from this server’s own snapshots and resets when it restarts.'],
      source: 'Hyperliquid info API',
    };
  }

  if (id === 'platforms') {
    const protos = await protocolsRaw();
    const ds = protos.map((p) => ({ p, d: pctDelta(p.tvl, protoPct(p, w)) })).filter((x) => x.d != null && Math.abs(x.d) > 1e6);
    const left = ds.filter((x) => x.d < 0).map((x) => ({ id: `proto:${x.p.slug}`, label: x.p.name, value: -x.d, method: 'estimated', tone: 'out', sub: x.p.category }));
    const right = ds.filter((x) => x.d > 0).map((x) => ({ id: `proto:${x.p.slug}`, label: x.p.name, value: x.d, method: 'estimated', tone: 'in', sub: x.p.category }));
    const net = ds.reduce((t, x) => t + x.d, 0), tvl = protos.reduce((t, p) => t + p.tvl, 0);
    const W2 = w === 'd1' ? '24h' : '7d';
    return {
      title: 'All platforms', kind: 'DeFi', leftLabel: `Platforms losing TVL, ${W2}`, rightLabel: `Platforms gaining TVL, ${W2}`,
      left: side(left, n), right: side(right, n),
      readout: { net, netLabel: `Net TVL change, ${W2}`, base: tvl, baseLabel: 'TVL tracked', gauge: { value: (net / tvl) * 100, min: -5, max: 5, label: 'TVL change' },
        headline: `Biggest gainer: ${right.sort((a, b) => b.value - a.value)[0]?.label || 'none'}. Biggest loser: ${left.sort((a, b) => b.value - a.value)[0]?.label || 'none'}.` },
      notes: ['TVL changes include price moves.'], source: 'DefiLlama protocols',
    };
  }

  if (id === 'assets') {
    const sec = (await sectors()).rows;
    const left = sec.filter((r) => r.delta24h < 0).map((r) => ({ label: r.label, value: -r.delta24h, method: 'measured', tone: 'out', sub: `${r.pct24h.toFixed(2)}%` }));
    const right = sec.filter((r) => r.delta24h > 0).map((r) => ({ label: r.label, value: r.delta24h, method: 'measured', tone: 'in', sub: `+${r.pct24h.toFixed(2)}%` }));
    const net = sec.reduce((t, r) => t + r.delta24h, 0);
    return {
      title: 'Crypto narratives', kind: 'Sectors', leftLabel: 'Value leaving, 24h', rightLabel: 'Value arriving, 24h',
      left: side(left, n), right: side(right, n),
      readout: { net, netLabel: 'Net market-cap change, 24h', base: null, gauge: null,
        headline: !right.length ? `Every narrative lost value over 24h. Hardest hit: ${left.sort((a, b) => b.value - a.value)[0]?.label}.` : !left.length ? `Every narrative gained over 24h. Biggest: ${right.sort((a, b) => b.value - a.value)[0]?.label}.` : `Leading: ${right.sort((a, b) => b.value - a.value)[0].label}. Lagging: ${left.sort((a, b) => b.value - a.value)[0].label}.` },
      notes: ['Market-cap change measures valuation, not deposits. Sectors overlap (a coin can be both AI and Layer 1).'], source: 'CoinGecko categories',
    };
  }

  if (id === 'regions') {
    const hours = w === 'd1' ? 24 : w === 'd30' ? 720 : 168;
    const [ss, prem, tf] = await Promise.all([sessionsRaw(), coinbasePremium().catch(() => null), tradfi().catch(() => null)]);
    const tot = Object.fromEntries(SESSIONS.map(([name]) => [name, 0]));
    for (const rows of Object.values(ss)) for (const r of rows.slice(-hours)) {
      const h = new Date(r.t).getUTCHours();
      const sname = SESSIONS.find(([, f]) => f(h))[0];
      tot[sname] += r.net;
    }
    const left = [], right = [];
    for (const [name, v] of Object.entries(tot)) (v >= 0 ? right : left).push({ label: name, value: Math.abs(v), method: 'measured', tone: v >= 0 ? 'in' : 'out', sub: v >= 0 ? 'net buying' : 'net selling' });
    const etf = tf?.groups?.find((g) => g.group === 'Crypto ETFs');
    const etfKey = w === 'd1' ? 'flow1d' : w === 'd30' ? 'flow20d' : 'flow5d';
    const etfFlow = etf?.rows?.length ? etf.rows.reduce((t, r) => t + (r[etfKey] || 0), 0) : null;
    const buyer = right.sort((a, b) => b.value - a.value)[0];
    return {
      title: 'BTC · ETH · SOL spot', kind: 'Regions', leftLabel: `Net sellers, ${WIN_LABEL[w]}`, rightLabel: `Net buyers, ${WIN_LABEL[w]}`,
      left: side(left, n), right: side(right, n),
      readout: { net: prem ? prem.bps : null, netLabel: 'Coinbase premium (bps)', unit: 'bps', base: null,
        gauge: prem ? { value: prem.bps, min: -20, max: 20, label: 'US demand (Coinbase premium)' } : null,
        extra: [...(prem ? [['Coinbase BTC', `$${prem.cb.toLocaleString('en-US', { maximumFractionDigits: 0 })}`], ['Binance BTC', `$${prem.bn.toLocaleString('en-US', { maximumFractionDigits: 0 })}`]] : []), ...(etfFlow != null ? [['US crypto ETFs, flow proxy', fmt$(etfFlow)]] : [])],
        headline: buyer ? `${buyer.label.replace(' hours', '')} trading hours did the most net buying over ${WIN_LABEL[w]}.` : 'Every session was a net seller.' },
      notes: ['Sessions group Binance hourly buy/sell pressure by UTC time of day: Asia 22:00–07:00, Europe 07:00–13:00, Americas 13:00–22:00. They show when money moved, not where each trader lives.'],
      source: 'Binance hourly taker flow, Coinbase, ETF proxy',
    };
  }

  return { title: id, kind: '', left: [], right: [], readout: { headline: 'Unknown node.' }, notes: [] };
}

async function flowRoute(url) {
  const id = url.searchParams.get('node') || 'chains';
  const w = ['d1', 'd7', 'd30'].includes(url.searchParams.get('w')) ? url.searchParams.get('w') : 'd7';
  const n = Math.min(14, Math.max(4, Number(url.searchParams.get('n')) || 8));
  return cached(`flow:${id}:${w}:${n}`, 60_000, async () => ({ id, w, updated: Date.now(), ...(await flowNode(id, w, n)) }));
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
  const route = url.pathname === '/api/flow' ? () => flowRoute(url) : ROUTES[url.pathname];
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
export { server, flowNode };
