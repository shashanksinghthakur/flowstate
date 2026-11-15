/* FLOWSTATE frontend — vanilla JS, no build step. */
(() => {
'use strict';

const API = window.FLOWSTATE_API ?? '';
const REFRESH_MS = 60_000;
const S = { live: true, data: {}, win: { chains: 'd7', tradfi: 'flow5d', stables: 'd7', sectors: 'pct24h' }, tape: [], taker: {}, prices: {}, whaleMin: 100_000 };
const $ = (s, el = document) => el.querySelector(s);

// ------------------------------------------------------------ format
const MINUS = '−';
function money(v, signed = false) {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  const s = a >= 1e12 ? (a / 1e12).toFixed(2) + 'T' : a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'K' : a.toFixed(0);
  const sign = v < 0 ? MINUS : signed ? '+' : '';
  return `${sign}$${s}`;
}
const pct = (v, d = 2) => (v == null || !isFinite(v) ? '–' : `${v < 0 ? MINUS : '+'}${Math.abs(v).toFixed(d)}%`);
const bps = (v) => (v == null || !isFinite(v) ? '–' : `${v < 0 ? MINUS : '+'}${Math.abs(v).toFixed(0)} bp`);
const px = (v) => (v == null ? '–' : v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(3));
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'dn' : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function usMarketOpen(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return m >= 570 && m < 960;
}
function tradAsOf() {
  const ts = (S.data.tradfi?.groups || []).flatMap((g) => g.rows).map((r) => r.asOf).filter(Boolean);
  return ts.length ? Math.max(...ts) : null;
}
function freshness() {
  const t = tradAsOf();
  const when = t ? new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
  return usMarketOpen()
    ? `US market open · last print ${when} · refreshes every 60s`
    : `US market closed · prices as of ${when} · resumes Mon–Fri 9:30 ET`;
}
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };

// ------------------------------------------------------------ components
function dbars(rows, fmt = (v) => money(v, true), emptyMsg = 'No data from source right now.') {
  if (!rows.length) return `<div class="empty">${emptyMsg}</div>`;
  const max = Math.max(...rows.map((r) => Math.abs(r.value || 0)), 1);
  return `<div class="dbars">${rows.map((r) => {
    const w = (Math.abs(r.value || 0) / max) * 50;
    const side = r.value >= 0 ? 'pos' : 'neg';
    const tip = r.tip || `${r.label}\n${fmt(r.value)}`;
    return `<div class="drow" data-tip="${esc(tip)}"><div class="dlabel">${esc(r.label)}</div><div class="dtrack"><div class="dfill ${side}" style="width:${w.toFixed(2)}%"></div></div><div class="dval ${cls(r.value)}">${fmt(r.value)}</div></div>`;
  }).join('')}</div>`;
}
const legend = (a = 'Inflow / up', b = 'Outflow / down') => `<div class="legend"><span><i style="background:var(--in)"></i>${a}</span><span><i style="background:var(--out)"></i>${b}</span></div>`;

function spark(vals, w = 84, h = 22) {
  const v = (vals || []).filter((x) => x != null);
  if (v.length < 2) return '';
  const mn = Math.min(...v), mx = Math.max(...v), r = mx - mn || 1;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((y - mn) / r) * (h - 4)).toFixed(1)}`).join(' ');
  const col = v.at(-1) >= v[0] ? 'var(--in)' : 'var(--out)';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" points="${pts}"/></svg>`;
}

function table(cols, rows) {
  return `<div class="tbl-wrap"><table><thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const seg = (key, opts) => `<div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${S.win[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const card = (title, meta, body, span = '', ctl = '') => `<div class="card ${span}"><div class="card-head"><div><h2>${title}</h2><div class="meta">${meta}</div></div>${ctl}</div>${body}</div>`;
const tile = (k, n, d = '', c = '') => `<div class="tile"><div class="k">${k}</div><div class="n ${c}">${n}</div><div class="d">${d}</div></div>`;

function lineChart(series, labels, { w = 560, h = 220, fmt = (v) => v.toFixed(2) + '%' } = {}) {
  const pad = { l: 44, r: 64, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return '<div class="empty">No data.</div>';
  let mn = Math.min(...all), mx = Math.max(...all); const span = mx - mn || 1; mn -= span * 0.15; mx += span * 0.15;
  const X = (i) => pad.l + (i / (labels.length - 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - mn) / (mx - mn)) * (h - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((f) => mn + f * (mx - mn));
  let svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Yield curve">`;
  ticks.forEach((t) => { svg += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="#2e2e2b"/><text x="${pad.l - 6}" y="${Y(t) + 4}" fill="#8d8c84" font-size="10" text-anchor="end">${fmt(t)}</text>`; });
  labels.forEach((l, i) => { svg += `<text x="${X(i)}" y="${h - 8}" fill="#8d8c84" font-size="10" text-anchor="middle">${l}</text>`; });
  series.forEach((s) => {
    const pts = s.values.map((v, i) => (v == null ? null : `${X(i)},${Y(v)}`)).filter(Boolean).join(' ');
    svg += `<polyline fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="4 4"' : ''} points="${pts}"/>`;
    s.values.forEach((v, i) => { if (v != null) svg += `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="${s.color}" stroke="#1a1a19" stroke-width="2"/><circle cx="${X(i)}" cy="${Y(v)}" r="12" fill="transparent" data-tip="${esc(`${s.name} · ${labels[i]}\n${fmt(v)}`)}"/>`; });
    const last = s.values.at(-1);
    if (last != null) svg += `<text x="${X(labels.length - 1) + 10}" y="${Y(last) + 4}" fill="#c3c2b7" font-size="11">${s.name}</text>`;
  });
  return svg + '</svg>';
}

// ------------------------------------------------------------ data
async function get(path) {
  if (!S.live) return DEMO[path]();
  const r = await fetch(API + path, { cache: 'no-store' });
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}

async function detectLive() {
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(API + '/api/health', { signal: ctl.signal, cache: 'no-store' });
    const j = await r.json();
    return j && j.live === true;
  } catch { return false; }
}

const ENDPOINTS = { sectors: '/api/sectors', stables: '/api/stablecoins', chainStables: '/api/chain-stables', chains: '/api/chains', tradfi: '/api/tradfi', macro: '/api/macro', liquidity: '/api/liquidity' };

async function refresh() {
  await Promise.all(Object.entries(ENDPOINTS).map(async ([k, p]) => {
    try { S.data[k] = await get(p); } catch (e) { console.warn('[flowstate]', k, e.message); S.data[k] ||= null; }
  }));
  S.updated = Date.now();
  renderTicker(); render();
}

// ------------------------------------------------------------ signals
function groupFlow(win = 'flow5d') {
  return (S.data.tradfi?.groups || []).map((g) => ({ label: g.group, value: g.rows.reduce((s, r) => s + (r[win] || 0), 0) }));
}
function macroRow(sym) { return (S.data.macro?.rows || []).find((r) => r.sym === sym); }

function signals() {
  const out = [];
  const st = S.data.stables?.total;
  if (st) out.push({ v: st.d7, html: `<b>${money(st.d7, true)}</b> stablecoin net ${st.d7 >= 0 ? 'mint' : 'burn'} in 7 days`, sub: st.d7 >= 0 ? 'Fresh dollars entering crypto rails' : 'Dollars leaving crypto rails' });
  const cs = (S.data.chainStables?.rows || []).filter((r) => !/total/i.test(r.chain));
  if (cs.length) {
    const s = [...cs].sort((a, b) => b.d7 - a.d7);
    out.push({ v: s[0].d7, html: `<b>${esc(s[0].chain)}</b> pulled the most stablecoins: ${money(s[0].d7, true)} (7D)`, sub: `Biggest drain: ${esc(s.at(-1).chain)} ${money(s.at(-1).d7, true)}` });
  }
  const sec = S.data.sectors?.rows || [];
  if (sec.length) {
    const s = [...sec].filter((r) => r.label !== 'Stablecoins').sort((a, b) => b.pct24h - a.pct24h);
    out.push({ v: s[0].pct24h, html: `<b>${esc(s[0].label)}</b> leads crypto rotation, ${pct(s[0].pct24h)} (${money(s[0].delta24h, true)}) 24h`, sub: `Laggard: ${esc(s.at(-1).label)} ${pct(s.at(-1).pct24h)}` });
  }
  const gf = groupFlow('flow5d');
  if (gf.length) {
    const s = [...gf].sort((a, b) => b.value - a.value);
    out.push({ v: s[0].value, html: `TradFi money is accumulating in <b>${esc(s[0].label)}</b> (${money(s[0].value, true)} 5D flow proxy)`, sub: `Distribution: ${esc(s.at(-1).label)} ${money(s.at(-1).value, true)}` });
    const c = gf.find((g) => g.label === 'Crypto ETFs');
    if (c) out.push({ v: c.value, html: `Spot crypto ETFs: <b>${money(c.value, true)}</b> 5D flow proxy`, sub: 'IBIT · FBTC · GBTC · ETHA' });
  }
  const tnx = macroRow('^TNX');
  if (tnx) { const d = (tnx.value - tnx.prev) * 100; out.push({ v: -d, html: `10Y Treasury <b>${tnx.value.toFixed(2)}%</b>, ${bps(d)} on the day`, sub: d > 0 ? 'Rising yields tighten financial conditions' : 'Falling yields ease financial conditions' }); }
  const tga = S.data.liquidity?.tga || [];
  if (tga.length > 6) { const d = tga.at(-1).value - tga.at(-6).value; out.push({ v: -d, html: `Treasury cash (TGA) ${d >= 0 ? 'up' : 'down'} <b>${money(Math.abs(d))}</b> over 5 sessions`, sub: d >= 0 ? 'TGA build drains bank reserves' : 'TGA spend-down adds liquidity' }); }
  return out;
}

// ------------------------------------------------------------ views
const VIEWS = {
  overview() {
    const sig = signals();
    const st = S.data.stables;
    const cs = (S.data.chainStables?.rows || []).slice(0, 10).map((r) => ({ label: r.chain, value: r.d7 })).sort((a, b) => b.value - a.value);
    const sec = (S.data.sectors?.rows || []).map((r) => ({ label: r.label, value: r.pct24h, tip: `${r.label}\n${pct(r.pct24h)} (${money(r.delta24h, true)})\nMcap ${money(r.mcap)}` })).sort((a, b) => b.value - a.value);
    return `<h1>Where money is moving</h1><p class="lede">One screen for capital rotation across crypto, chains, ETFs, treasuries and dollar liquidity.</p>
    <div class="grid">
      ${card('Signals', 'Auto-generated from the feeds below', `<ul class="signals">${sig.map((s) => `<li><span class="arrow ${cls(s.v)}">${s.v >= 0 ? '▲' : '▼'}</span><div>${s.html}<small>${s.sub}</small></div></li>`).join('') || '<li>Loading…</li>'}</ul>`)}
      ${card('Asset-class money flow', '5-day money-flow-volume proxy, summed per ETF group', dbars(groupFlow('flow5d').sort((a, b) => b.value - a.value)) + legend('Accumulation', 'Distribution'), 's6')}
      ${card('Crypto sectors', '24h market-cap % change by narrative', dbars(sec, (v) => pct(v)) + legend(), 's6')}
      ${card('Stablecoin supply', 'Net mint / burn · USD-pegged', st ? `<div class="tiles">${tile('Total supply', money(st.total.supply))}${tile('24h', money(st.total.d1, true), '', cls(st.total.d1))}${tile('7D', money(st.total.d7, true), '', cls(st.total.d7))}${tile('30D', money(st.total.d30, true), '', cls(st.total.d30))}</div>` : '<div class="empty">Loading…</div>', 's6')}
      ${card('Chains · stablecoin flow', '7D change in stablecoins held on each chain (top 10 by supply)', dbars(cs) + legend(), 's6')}
      ${card('Whale tape', `Live spot trades ≥ ${money(S.whaleMin)}`, `<ul class="tape" id="tapeMini"></ul>`, '')}
    </div>`;
  },

  crypto() {
    const sec = S.data.sectors?.rows || [];
    const st = S.data.stables?.rows || [];
    const w = S.win.stables, sw = S.win.sectors;
    return `<h1>Crypto sectors</h1><p class="lede">AI, RWA, memecoins, DeFi, L1s, L2s, DePIN and more, ranked by where valuation is flowing.</p>
    <div class="grid">
      ${card('Sector rotation', `24h market-cap change · ${esc(S.data.sectors?.source || '')}`, dbars([...sec].sort((a, b) => b[sw] - a[sw]).map((r) => ({ label: r.label, value: r[sw], tip: `${r.label} (${r.name})\n${money(r.delta24h, true)} · ${pct(r.pct24h)}\nVolume ${money(r.volume24h)}` })), sw === 'pct24h' ? (v) => pct(v) : (v) => money(v, true)) + legend() +
        table([['Sector', (r) => esc(r.label)], ['Mkt cap', (r) => money(r.mcap)], ['24h', (r) => `<span class="${cls(r.pct24h)}">${pct(r.pct24h)}</span>`], ['Δ $', (r) => `<span class="${cls(r.delta24h)}">${money(r.delta24h, true)}</span>`], ['Volume', (r) => money(r.volume24h)], ['Vol / cap', (r) => (r.mcap ? ((r.volume24h / r.mcap) * 100).toFixed(1) + '%' : '–')]], sec), 's6', seg('sectors', [['pct24h', '%'], ['delta24h', '$']]))}
      ${card('Stablecoin mint / burn', 'Supply change per issuer', dbars(st.slice(0, 10).map((r) => ({ label: r.symbol, value: r[w] })).sort((a, b) => b.value - a.value)) + legend('Mint', 'Burn') +
        table([['Coin', (r) => esc(r.symbol)], ['Supply', (r) => money(r.supply)], ['24h', (r) => `<span class="${cls(r.d1)}">${money(r.d1, true)}</span>`], ['7D', (r) => `<span class="${cls(r.d7)}">${money(r.d7, true)}</span>`], ['30D', (r) => `<span class="${cls(r.d30)}">${money(r.d30, true)}</span>`]], st), 's6', seg('stables', [['d1', '1D'], ['d7', '7D'], ['d30', '30D']]))}
    </div>`;
  },

  chains() {
    const w = S.win.chains;
    const cs = S.data.chainStables?.rows || [];
    const ch = S.data.chains || {};
    const br = ch.bridges || [];
    return `<h1>Chains</h1><p class="lede">Dollars moving between chains, measured two ways: stablecoin balances and bridge flows.</p>
    <div class="grid">
      ${card('Stablecoin flow by chain', 'Change in USD stablecoins held on chain', dbars(cs.slice(0, 15).map((r) => ({ label: r.chain, value: r[w], tip: `${r.chain}\n${money(r[w], true)}\nSupply on chain ${money(r.supply)}` })).sort((a, b) => b.value - a.value)) + legend(), 's6', seg('chains', [['d1', '1D'], ['d7', '7D'], ['d30', '30D']]))}
      ${card('Bridge net flow', '7D bridged in minus bridged out', dbars([...br].sort((a, b) => b.net7d - a.net7d).map((r) => ({ label: r.chain, value: r.net7d, tip: `${r.chain}\nIn ${money(r.in7d)} · Out ${money(r.out7d)}\nNet ${money(r.net7d, true)}` })), undefined, 'Bridge data moved behind DefiLlama Pro. Live on-chain stablecoin mint/burn and transfer tracking replaces this panel next.') + legend() +
        table([['Chain', (r) => esc(r.chain)], ['In 7D', (r) => money(r.in7d)], ['Out 7D', (r) => money(r.out7d)], ['Net 7D', (r) => `<span class="${cls(r.net7d)}">${money(r.net7d, true)}</span>`], ['Net 24h', (r) => `<span class="${cls(r.net1d)}">${money(r.net1d, true)}</span>`]], br), 's6')}
      ${card('DeFi TVL by chain', esc(ch.source || ''), table([['Chain', (r) => esc(r.chain)], ['TVL', (r) => money(r.tvl)], ['Token', (r) => esc(r.token || '–')]], ch.tvl || []), '')}
    </div>`;
  },

  tradfi() {
    const w = S.win.tradfi;
    const groups = S.data.tradfi?.groups || [];
    const all = groups.flatMap((g) => g.rows.map((r) => ({ ...r, group: g.group })));
    const lab = { flow1d: '1D', flow5d: '5D', flow20d: '20D' }[w];
    return `<h1>ETFs &amp; TradFi</h1><p class="lede">Equities, treasuries, credit, commodities and spot crypto ETFs. Flow is a money-flow-volume proxy from daily price and volume, not official creations/redemptions.</p><div class="demo-note fresh">${freshness()}</div>
    <div class="grid">
      ${card(`ETF money flow · ${lab}`, 'Positive = closing near highs on volume (accumulation)', dbars(all.sort((a, b) => b[w] - a[w]).map((r) => ({ label: `${r.sym} · ${r.group}`, value: r[w], tip: `${r.sym} (${r.group})\nFlow ${lab} ${money(r[w], true)}\nPrice ${px(r.price)} · ${pct(r.chg1d)} 1D` }))) + legend('Accumulation', 'Distribution'), 's6', seg('tradfi', [['flow1d', '1D'], ['flow5d', '5D'], ['flow20d', '20D']]))}
      <div class="card s6"><h2>By group</h2><div class="meta">${esc(S.data.tradfi?.source || '')}</div>
      ${groups.map((g) => `<details open><summary>${esc(g.group)}</summary>${table([['Ticker', (r) => `<b>${r.sym}</b>`], ['30D', (r) => spark(r.spark)], ['Price', (r) => px(r.price)], ['1D', (r) => `<span class="${cls(r.chg1d)}">${pct(r.chg1d)}</span>`], ['5D', (r) => `<span class="${cls(r.chg5d)}">${pct(r.chg5d)}</span>`], ['$ Vol', (r) => money(r.dollarVol)], [`Flow ${lab}`, (r) => `<span class="${cls(r[w])}">${money(r[w], true)}</span>`]], g.rows)}</details>`).join('')}
      </div>
    </div>`;
  },

  liquidity() {
    const L = S.data.liquidity || {};
    const m = (s) => macroRow(s);
    const curveSyms = ['^IRX', '^FVX', '^TNX', '^TYX'];
    const now = curveSyms.map((s) => m(s)?.value ?? null), then = curveSyms.map((s) => m(s)?.monthAgo ?? null);
    const lastV = (a) => a?.at?.(-1)?.value;
    const delta = (a, n) => (a?.length > n ? a.at(-1).value - a.at(-1 - n).value : null);
    const t10 = m('^TNX'), t3 = m('^IRX');
    return `<h1>Treasury &amp; liquidity</h1><p class="lede">The dollar plumbing underneath every other chart: yields, Treasury cash, reverse repo and the Fed balance sheet.</p>
    <div class="grid">
      ${card('Rates & dollar', `${esc(S.data.macro?.source || '')} · ${freshness()}`, `<div class="tiles">${(S.data.macro?.rows || []).map((r) => tile(r.label, r.sym.startsWith('^') && r.sym !== '^VIX' ? r.value.toFixed(2) + '%' : px(r.value), `${r.sym.startsWith('^') && r.sym !== '^VIX' ? bps((r.value - r.prev) * 100) : pct((r.value / r.prev - 1) * 100)} 1D ${spark(r.spark, 60, 16)}`)).join('')}
        ${t10 && t3 ? tile('10Y − 3M spread', bps((t10.value - t3.value) * 100), t10.value - t3.value < 0 ? 'Inverted' : 'Positive slope') : ''}</div>`)}
      ${card('Yield curve', 'Today vs one month ago', lineChart([{ name: '1M ago', values: then, color: '#8d8c84', dash: true }, { name: 'Today', values: now, color: '#3987e5' }], ['3M', '5Y', '10Y', '30Y']) + `<div class="legend"><span><i style="background:#3987e5"></i>Today</span><span><i style="background:#8d8c84"></i>1 month ago</span></div>`, 's6')}
      ${card('Dollar liquidity', esc(L.source || ''), `<div class="tiles">
        ${tile('Treasury cash (TGA)', money(lastV(L.tga)), `${money(delta(L.tga, 5), true)} 5 sessions ${spark((L.tga || []).slice(-40).map((x) => x.value), 60, 16)}`)}
        ${tile('Reverse repo', money(lastV(L.rrp)), `${money(delta(L.rrp, 5), true)} 5 sessions ${spark((L.rrp || []).slice(-40).map((x) => x.value), 60, 16)}`)}
        ${tile('Fed balance sheet', L.walcl?.length ? money(lastV(L.walcl)) : '–', L.walcl?.length ? `${money(delta(L.walcl, 1), true)} w/w` : 'Add FRED_API_KEY')}
        ${tile('Net liquidity', L.netLiquidity ? money(L.netLiquidity) : '–', 'Fed BS − TGA − RRP')}
        ${tile('US public debt', money(lastV(L.debt)), `${money(delta(L.debt, 20), true)} ~1 month`)}
      </div>`, 's6')}
    </div>`;
  },

  tape() {
    const tk = Object.entries(S.taker).map(([s, v]) => ({ label: s, value: v, tip: `${s}\nNet taker flow this session ${money(v, true)}` })).sort((a, b) => b.value - a.value);
    return `<h1>Whale tape</h1><p class="lede">Every large spot trade as it prints. Aggressor side tells you who is paying up.</p>
    <div class="grid">
      ${card('Live trades', `Binance spot (Coinbase fallback) · ${S.feed || 'connecting'}`, `<ul class="tape" id="tapeFull"></ul>`, 's8', `<div class="seg" data-whale>${[50e3, 100e3, 250e3, 1e6].map((v) => `<button data-v="${v}" class="${S.whaleMin === v ? 'on' : ''}">${money(v)}</button>`).join('')}</div>`)}
      ${card('Net taker flow', 'Aggressive buys minus sells, all sizes, since you opened the page', `<div id="takerBars">${dbars(tk)}</div>` + legend('Net buying', 'Net selling'), 's4')}
    </div>`;
  },
};


// ------------------------------------------------------------ Flow Scope (flagship instrument)
const LENSES = [['chains', 'Chains', 'All chains'], ['platforms', 'Platforms', 'All platforms'], ['assets', 'Assets', 'Crypto narratives'], ['regions', 'Regions', 'BTC · ETH · SOL spot']];
const LENS_ANGLES = [-120, -40, 40, 120];
const LENS_W = { chains: ['d1', 'd7', 'd30'], platforms: ['d1', 'd7'], assets: ['d1'], regions: ['d1', 'd7', 'd30'] };
const WINS = [['d1', '24h'], ['d7', '7d'], ['d30', '30d']];
const DETAIL = [6, 8, 12];
const FM = { lens: 'chains', w: 'd7', n: 8, trail: [], cache: {}, req: 0, last: null, ang: 0 };
const fmNode = () => FM.trail.at(-1)?.id || FM.lens;
const lensIdx = () => LENSES.findIndex(([k]) => k === FM.lens);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function knobHTML(li) {
  const ridges = Array.from({ length: 40 }, (_, i) => `<line x1="60" y1="17" x2="60" y2="23" transform="rotate(${i * 9} 60 60)"/>`).join('');
  const marks = LENS_ANGLES.map((a) => `<line x1="60" y1="3" x2="60" y2="9" transform="rotate(${a} 60 60)"/>`).join('');
  const labels = LENSES.map(([k, l], i) => {
    const a = (LENS_ANGLES[i] * Math.PI) / 180;
    return `<button class="knob-label${i === li ? ' on' : ''}" data-lens="${k}" style="left:${(100 + Math.sin(a) * 84).toFixed(1)}px;top:${(84 - Math.cos(a) * 76).toFixed(1)}px">${l}</button>`;
  }).join('');
  return `<div class="knob-wrap">${labels}
    <div class="knob" role="slider" tabindex="0" aria-label="Lens" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${li}" aria-valuetext="${LENSES[li][1]}">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs><radialGradient id="kg" cx="38%" cy="30%" r="75%"><stop offset="0" stop-color="#55565b"/><stop offset=".55" stop-color="#2c2d30"/><stop offset="1" stop-color="#18191b"/></radialGradient>
        <radialGradient id="kf" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#3b3c40"/><stop offset="1" stop-color="#232427"/></radialGradient></defs>
        <g class="marks">${marks}</g>
        <circle cx="60" cy="62" r="45" class="shadow"/>
        <g class="cap" style="transform:rotate(${LENS_ANGLES[li]}deg)">
          <circle cx="60" cy="60" r="45" fill="url(#kg)"/><g class="ridges">${ridges}</g>
          <circle cx="60" cy="60" r="31" fill="url(#kf)" class="face"/><line class="pointer" x1="60" y1="33" x2="60" y2="47"/>
        </g>
      </svg>
    </div></div>`;
}

function switchHTML(name, opts, cur, enabled, label) {
  const i = Math.max(0, opts.findIndex(([k]) => String(k) === String(cur)));
  return `<div class="switch" role="radiogroup" aria-label="${label}" style="--n:${opts.length}">${opts.map(([k, l]) => `<button role="radio" aria-checked="${String(k) === String(cur)}" data-${name}="${k}" ${enabled.includes(k) ? '' : 'disabled'}>${l}</button>`).join('')}<span class="thumb" style="--i:${i}"></span></div>`;
}

function trailHTML() {
  const root = LENSES[lensIdx()];
  const items = [{ id: root[0], title: root[2] }, ...FM.trail];
  return items.map((t, i) => i === items.length - 1
    ? `<span class="crumb now" aria-current="step">${esc(t.title)}</span>`
    : `<button class="crumb" data-crumb="${i}">${esc(t.title)}</button><span class="sep" aria-hidden="true">›</span>`).join('');
}

VIEWS.flowmap = function () {
  const li = lensIdx();
  return `<h1 class="sr-only">Flow scope: where money moved</h1>
  <section class="scope" aria-label="Flow scope">
    <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
    <div class="scope-top">
      <div class="scope-name"><span class="led ${S.live ? 'on' : 'demo'}" title="${S.live ? 'Live data' : 'Demo data'}"></span>Flow scope</div>
      <nav class="trail" id="fmTrail" aria-label="Trace path">${trailHTML()}</nav>
    </div>
    <div class="scope-body">
      <div class="controls">
        <div class="ctl ctl-knob">${knobHTML(li)}<div class="engrave">Lens</div></div>
        <div class="ctl"><div id="fmWin">${switchHTML('win', WINS, FM.w, LENS_W[FM.lens], 'Time window')}</div><div class="engrave">Window</div></div>
        <div class="ctl"><div id="fmDet">${switchHTML('n', DETAIL.map((v) => [v, String(v)]), FM.n, DETAIL, 'Bands per side')}</div><div class="engrave">Bands per side</div></div>
      </div>
      <div class="screen" id="fmScreen">
        <div class="screen-labels"><span id="fmL"></span><span id="fmC"></span><span id="fmR"></span></div>
        <svg id="fmsvg" role="img" aria-label="Flow diagram"></svg>
        <div class="screen-msg" id="fmMsg" hidden></div>
        <div class="screen-foot"><span><i class="sw solid"></i>Measured</span><span><i class="sw est"></i>Estimated</span><span class="hint">Tap a band or a name to trace where it goes next</span></div>
      </div>
      <aside class="readout" id="fmRead" aria-live="polite"></aside>
    </div>
    <p class="scope-notes" id="fmNotes"></p>
  </section>`;
};

function gaugeHTML(g, fromAng) {
  const v = Math.max(g.min, Math.min(g.max, Number(g.value) || 0));
  const ang = -90 + ((v - g.min) / (g.max - g.min)) * 180;
  const ticks = Array.from({ length: 21 }, (_, i) => { const a = -90 + i * 9; const long = i % 5 === 0; return `<line x1="80" y1="${long ? 14 : 18}" x2="80" y2="24" transform="rotate(${a} 80 84)" class="${long ? 'long' : ''}"/>`; }).join('');
  const unit = g.label.includes('bps') || g.label.includes('premium') ? ' bps' : '%';
  const shown = `${g.value >= 0 ? '+' : '−'}${Math.abs(g.value).toFixed(Math.abs(g.value) < 10 ? 2 : 1)}${unit}`;
  return `<div class="gauge"><svg viewBox="0 0 160 96" role="img" aria-label="${esc(g.label)}: ${shown}">
    <path d="M 14 84 A 66 66 0 0 1 80 18" class="arc out"/><path d="M 80 18 A 66 66 0 0 1 146 84" class="arc in"/>
    <g class="ticks">${ticks}</g>
    <text x="14" y="95" class="gl">${g.min}</text><text x="146" y="95" class="gl" text-anchor="end">+${g.max}</text><text x="80" y="95" class="gl" text-anchor="middle">0</text>
    <g class="needle" data-ang="${ang.toFixed(1)}" style="transform:rotate(${fromAng}deg)"><line x1="80" y1="84" x2="80" y2="24"/></g><circle cx="80" cy="84" r="5.5" class="hub"/>
  </svg><div class="g-lab">${esc(g.label)} <b class="${cls(g.value)}">${shown}</b></div></div>`;
}

function readoutHTML(d) {
  const r = d.readout || {};
  const netTxt = r.net == null ? '–' : r.unit === 'bps' ? `${r.net >= 0 ? '+' : '−'}${Math.abs(r.net).toFixed(1)}` : money(r.net, true);
  const stats = [...(r.base != null ? [[r.baseLabel, money(r.base)]] : []), ...(r.extra || [])];
  return `<div class="ro-kind">${esc(d.kind || '')}</div><div class="ro-title">${esc(d.title || '')}</div>
    <div class="lcd"><div class="lcd-num ${cls(r.net)}">${netTxt}</div><div class="lcd-lab">${esc(r.netLabel || '')}</div></div>
    ${r.gauge ? gaugeHTML(r.gauge, FM.ang) : ''}
    ${stats.length ? `<dl class="ro-stats">${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    <p class="ro-head">${esc(r.headline || '')}</p>
    <p class="ro-src">${esc(d.source || '')}. Updated ${ago(d.updated || Date.now())}.</p>`;
}

function drawFlow(d) {
  FM.last = d;
  const svg = $('#fmsvg'); if (!svg) return;
  $('#fmMsg').hidden = true;
  $('#fmL').textContent = d.leftLabel || ''; $('#fmR').textContent = d.rightLabel || ''; $('#fmC').textContent = d.title || '';
  const L = (d.left || []).filter((x) => x.value > 0), R = (d.right || []).filter((x) => x.value > 0);
  const Wd = Math.max(300, svg.parentElement.clientWidth - 2);
  const narrow = Wd < 600;
  const rows = Math.max(L.length, R.length, 1);
  const A = Math.max(200, rows * (narrow ? 30 : 36));       // proportional pool height
  const minSlot = narrow ? 32 : 36, gap = 6, pad = 14;
  const slots = (items) => { const tot = items.reduce((t, x) => t + x.value, 0) || 1; return items.map((x) => { const share = x.value / tot; return { ...x, share, bh: Math.max(2, share * A), slot: Math.max(minSlot, share * A) }; }); };
  const Ls = slots(L), Rs = slots(R);
  const sideH = (a) => a.reduce((t, x) => t + x.slot, 0) + gap * Math.max(0, a.length - 1);
  const H = Math.round(Math.max(A, sideH(Ls), sideH(Rs)) + pad * 2);
  const place = (a) => { let y = pad + (H - 2 * pad - sideH(a)) / 2; return a.map((x) => { const o = { ...x, sy: y, by: y + (x.slot - x.bh) / 2 }; y += x.slot + gap; return o; }); };
  const Lp = place(Ls), Rp = place(Rs);
  const cTop = (H - A) / 2;
  const attach = (a) => { let y = cTop; return a.map((o) => { const r = { ...o, cy: y }; y += o.bh; return r; }); };
  const La = attach(Lp), Ra = attach(Rp);
  const labW = narrow ? 92 : 170, bar = 7, cw = narrow ? 12 : 16;
  const xL = labW, xR = Wd - labW - bar, cx0 = Wd / 2 - cw / 2, cx1 = Wd / 2 + cw / 2;
  const rib = (x1, y1, x2, y2, h) => { const m = (x1 + x2) / 2; return `M${x1},${y1}C${m},${y1} ${m},${y2} ${x2},${y2}L${x2},${y2 + h}C${m},${y2 + h} ${m},${y1 + h} ${x1},${y1 + h}Z`; };
  const mid = (x1, y1, x2, y2) => { const m = (x1 + x2) / 2; return `M${x1},${y1}C${m},${y1} ${m},${y2} ${x2},${y2}`; };
  const maxCh = narrow ? 12 : 22;
  const clip = (t) => (t.length > maxCh ? t.slice(0, maxCh - 1) + '…' : t);
  const tip = (o) => `${o.label}${o.sub ? ` (${o.sub})` : ''}\n${money(o.value)}  ${(o.share * 100).toFixed(1)}% of side\n${o.method === 'estimated' ? 'Estimated' : 'Measured'}${o.id ? '\nSelect to trace' : ''}`;
  const motion = !reduceMotion();
  const band = (o, x1, y1, x2, y2, i) => {
    const dur = (1.1 + (1 - o.share) * 2.6).toFixed(2), sw = Math.max(1.4, Math.min(3.4, o.bh * 0.2)).toFixed(1);
    return `<g class="band ${o.tone || 'neutral'} ${o.method}${o.id ? ' drill' : ''}" ${o.id ? `data-drill="${esc(o.id)}" data-title="${esc(o.label)}" tabindex="0" role="button" aria-label="Trace ${esc(o.label)}"` : ''} data-tip="${esc(tip(o))}" style="--d:${i * 40}ms">
      <path class="rib" d="${rib(x1, y1, x2, y2, o.bh)}"/>${o.method === 'estimated' ? `<path class="hat" d="${rib(x1, y1, x2, y2, o.bh)}"/>` : ''}
      ${motion ? `<path class="pt" d="${mid(x1, y1 + o.bh / 2, x2, y2 + o.bh / 2)}" style="animation-duration:${dur}s;stroke-width:${sw}px"/>` : ''}</g>`;
  };
  const label = (o, x, anchor) => `<g class="nlab${o.id ? ' drill' : ''}" ${o.id ? `data-drill="${esc(o.id)}" data-title="${esc(o.label)}"` : ''} data-tip="${esc(tip(o))}">
    <text x="${x}" y="${o.sy + o.slot / 2 - 3}" text-anchor="${anchor}" class="lab">${esc(clip(o.label))}</text>
    <text x="${x}" y="${o.sy + o.slot / 2 + 11}" text-anchor="${anchor}" class="val">${money(o.value)}${o.sub && !narrow ? `  ${esc(o.sub)}` : ''}</text></g>`;
  let g = `<defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.6" height="5" fill="rgba(240,239,236,.16)"/></pattern></defs>`;
  La.forEach((o, i) => { g += band(o, xL + bar, o.by, cx0, o.cy, i); });
  Ra.forEach((o, i) => { g += band(o, cx1, o.cy, xR, o.by, i + La.length); });
  La.forEach((o) => { g += `<rect class="node ${o.tone || 'neutral'}" x="${xL}" y="${o.by}" width="${bar}" height="${o.bh}" rx="1.5"/>${label(o, xL - 8, 'end')}`; });
  Ra.forEach((o) => { g += `<rect class="node ${o.tone || 'neutral'}" x="${xR}" y="${o.by}" width="${bar}" height="${o.bh}" rx="1.5"/>${label(o, xR + bar + 8, 'start')}`; });
  g += `<rect class="core" x="${cx0}" y="${cTop}" width="${cw}" height="${A}" rx="4"/>`;
  if (!L.length && !R.length) g += `<text x="${Wd / 2}" y="${H / 2}" text-anchor="middle" class="lab">No movement above the threshold in this window.</text>`;
  else if (!R.length) g += `<text x="${(cx1 + Wd) / 2}" y="${H / 2}" text-anchor="middle" class="val">End of trace. Details in the readout.</text>`;
  svg.setAttribute('viewBox', `0 0 ${Wd} ${H}`); svg.style.height = `${H}px`;
  svg.innerHTML = g;
  const ro = $('#fmRead');
  ro.innerHTML = readoutHTML(d);
  const nd = ro.querySelector('.needle');
  if (nd) requestAnimationFrame(() => requestAnimationFrame(() => { nd.style.transform = `rotate(${nd.dataset.ang}deg)`; FM.ang = Number(nd.dataset.ang); }));
  $('#fmNotes').textContent = (d.notes || []).join(' ');
  $('#fmScreen').classList.remove('busy');
}

function fmMessage(t) { const m = $('#fmMsg'); if (m) { m.textContent = t; m.hidden = false; } }

async function loadFlow() {
  const node = fmNode(), key = `${node}|${FM.w}|${FM.n}`, rq = ++FM.req;
  const hit = FM.cache[key];
  if (hit) drawFlow(hit.d); else { $('#fmScreen')?.classList.add('busy'); }
  if (hit && Date.now() - hit.t < 60_000) return;
  try {
    let d;
    if (S.live) {
      const r = await fetch(`${API}/api/flow?node=${encodeURIComponent(node)}&w=${FM.w}&n=${FM.n}`, { cache: 'no-store' });
      d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || r.status);
    } else d = demoFlow(node);
    FM.cache[key] = { t: Date.now(), d };
    if (rq === FM.req) { const t = FM.trail.at(-1); if (t && t.id === node && d.title && t.title !== d.title) { t.title = d.title; $('#fmTrail').innerHTML = trailHTML(); } drawFlow(d); }
  } catch (e) {
    if (rq === FM.req) { $('#fmScreen')?.classList.remove('busy'); if (!hit) fmMessage(`This layer could not load: ${e.message}. It retries on the next refresh.`); }
  }
}

function syncControls() {
  const li = lensIdx();
  const knob = $('.knob'); if (!knob) return;
  knob.querySelector('.cap').style.transform = `rotate(${LENS_ANGLES[li]}deg)`;
  knob.setAttribute('aria-valuenow', li); knob.setAttribute('aria-valuetext', LENSES[li][1]);
  document.querySelectorAll('.knob-label').forEach((b) => b.classList.toggle('on', b.dataset.lens === FM.lens));
  $('#fmWin').innerHTML = switchHTML('win', WINS, FM.w, LENS_W[FM.lens], 'Time window');
  $('#fmDet').innerHTML = switchHTML('n', DETAIL.map((v) => [v, String(v)]), FM.n, DETAIL, 'Bands per side');
  $('#fmTrail').innerHTML = trailHTML();
}

function setLens(k) {
  if (k === FM.lens && !FM.trail.length) return;
  FM.lens = k; FM.trail = [];
  if (!LENS_W[k].includes(FM.w)) FM.w = LENS_W[k].includes('d7') ? 'd7' : LENS_W[k][0];
  syncControls(); loadFlow();
}
function drillTo(id, title) {
  if (LENSES.some(([k]) => k === id)) { FM.lens = id; FM.trail = []; }
  else {
    const at = FM.trail.findIndex((t) => t.id === id);
    if (at >= 0) FM.trail = FM.trail.slice(0, at + 1); else FM.trail.push({ id, title });
  }
  syncControls(); loadFlow();
}

let fmRO = null;
function mountFlow() {
  const knob = $('.knob'); if (!knob) return;
  const step = (dir) => setLens(LENSES[Math.max(0, Math.min(3, lensIdx() + dir))][0]);
  const fromPointer = (e) => {
    const r = knob.getBoundingClientRect();
    const a = (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI;
    let best = 0; LENS_ANGLES.forEach((d, i) => { if (Math.abs(d - a) < Math.abs(LENS_ANGLES[best] - a)) best = i; });
    setLens(LENSES[best][0]);
  };
  knob.addEventListener('pointerdown', (e) => { knob.setPointerCapture(e.pointerId); fromPointer(e); });
  knob.addEventListener('pointermove', (e) => { if (knob.hasPointerCapture(e.pointerId)) fromPointer(e); });
  knob.addEventListener('wheel', (e) => { e.preventDefault(); step(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  knob.addEventListener('keydown', (e) => {
    if (['ArrowRight', 'ArrowUp'].includes(e.key)) { e.preventDefault(); step(1); }
    if (['ArrowLeft', 'ArrowDown'].includes(e.key)) { e.preventDefault(); step(-1); }
    if (e.key === 'Home') setLens(LENSES[0][0]); if (e.key === 'End') setLens(LENSES[3][0]);
  });
  const svg = $('#fmsvg');
  svg.addEventListener('keydown', (e) => { const g = e.target.closest?.('[data-drill]'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); drillTo(g.dataset.drill, g.dataset.title); } });
  fmRO?.disconnect();
  let t = 0;
  fmRO = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => FM.last && drawFlow(FM.last), 120); });
  fmRO.observe($('#fmScreen'));
  if (FM.last) drawFlow(FM.last);
  loadFlow();
}

document.addEventListener('click', (e) => {
  const lens = e.target.closest('[data-lens]'); if (lens) return setLens(lens.dataset.lens);
  const win = e.target.closest('[data-win]'); if (win && !win.disabled) { FM.w = win.dataset.win; syncControls(); return loadFlow(); }
  const det = e.target.closest('[data-n]'); if (det) { FM.n = Number(det.dataset.n); syncControls(); return loadFlow(); }
  const crumb = e.target.closest('[data-crumb]'); if (crumb) { FM.trail = FM.trail.slice(0, Number(crumb.dataset.crumb)); syncControls(); return loadFlow(); }
  const dr = e.target.closest('#fmsvg [data-drill]'); if (dr) { tip.classList.remove('on'); return drillTo(dr.dataset.drill, dr.dataset.title); }
});

function demoFlow(node) {
  const rnd2 = (seed) => { let x = [...seed].reduce((a, c) => a + c.charCodeAt(0), 7); return () => ((x = (x * 9301 + 49297) % 233280) / 233280); };
  const r = rnd2(node + FM.w);
  const names = { chains: ['Ethereum', 'Tron', 'Solana', 'BSC', 'Arbitrum', 'Base', 'Hyperliquid', 'Plasma', 'Avalanche', 'Polygon'], platforms: ['Aave', 'Lido', 'EigenLayer', 'Ethena', 'Hyperliquid Bridge', 'Morpho', 'Pendle', 'Sky', 'Uniswap', 'Jupiter'], assets: ['AI', 'RWA', 'Memecoins', 'DeFi', 'Layer 1', 'Layer 2', 'DePIN', 'Gaming'], regions: ['Asia hours', 'Europe hours', 'Americas hours', 'US spot crypto ETFs'] };
  const pool = names[node] || ['Ethereum', 'Arbitrum', 'Base', 'Aave', 'Uniswap', 'Pendle', 'Morpho', 'GMX'];
  const left = [], right = [];
  pool.forEach((l) => { const v = (r() - 0.45) * 9e8; (v < 0 ? left : right).push({ id: null, label: l, value: Math.abs(v), method: r() > 0.6 ? 'estimated' : 'measured', tone: v < 0 ? 'out' : 'in' }); });
  const net = right.reduce((t, x) => t + x.value, 0) - left.reduce((t, x) => t + x.value, 0);
  return { title: LENSES.find(([k]) => k === node)?.[2] || node, kind: 'Demo data', leftLabel: 'Sources', rightLabel: 'Destinations', left, right, updated: Date.now(),
    readout: { net, netLabel: 'Net flow (simulated)', base: 2.9e11, baseLabel: 'Base', gauge: { value: (r() - 0.5) * 3, min: -2, max: 2, label: 'Absorption' }, headline: 'Simulated numbers. Deploy the server to see live flows.' },
    notes: ['Demo mode: every value here is simulated.'], source: 'Demo' };
}

function route() { const h = location.hash.slice(1); return VIEWS[h] ? h : 'flowmap'; }
function render() {
  const r = route();
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + r));
  if (r === 'flowmap' && $('#fmsvg') && !render.force) { $('#updated').textContent = S.updated ? `updated ${ago(S.updated)}` : 'loading…'; loadFlow(); return; }
  $('#view').innerHTML = VIEWS[r]();
  if (r === 'flowmap') mountFlow();
  paintTape();
  $('#updated').textContent = S.updated ? `updated ${ago(S.updated)}` : 'loading…';
}

// ------------------------------------------------------------ ticker
function renderTicker() {
  const items = [];
  const open = usMarketOpen();
  for (const s of ['BTC', 'ETH', 'SOL']) { const p = S.prices[s]; items.push(`<span class="tk" id="tk-${s}"><span>${s}</span><span class="v">${p ? px(p) : '–'}</span></span>`); }
  items.push(`<span class="tk"><span>US MKT</span><span class="${open ? 'up' : 'dn'}">${open ? 'OPEN' : 'CLOSED'}</span></span>`);
  const tf = Object.fromEntries((S.data.tradfi?.groups || []).flatMap((g) => g.rows).map((r) => [r.sym, r]));
  for (const s of ['SPY', 'QQQ', 'TLT', 'GLD', 'IBIT']) { const r = tf[s]; if (r) items.push(`<span class="tk"><span>${s}</span><span class="v">${px(r.price)}</span> <span class="${cls(r.chg1d)}">${pct(r.chg1d)}</span></span>`); }
  for (const r of S.data.macro?.rows || []) {
    const isY = r.sym.startsWith('^') && r.sym !== '^VIX';
    items.push(`<span class="tk"><span>${r.label}</span><span class="v">${isY ? r.value.toFixed(2) + '%' : px(r.value)}</span> <span class="${cls(r.value - r.prev)}">${isY ? bps((r.value - r.prev) * 100) : pct((r.value / r.prev - 1) * 100)}</span></span>`);
  }
  $('#ticker').innerHTML = items.join('');
}
function tickPrice(sym, p) {
  const old = S.prices[sym]; S.prices[sym] = p;
  const el = document.querySelector(`#tk-${sym} .v`);
  if (!el) return;
  el.textContent = px(p);
  if (old && old !== p) { el.classList.remove('flash-up', 'flash-dn'); void el.offsetWidth; el.classList.add(p > old ? 'flash-up' : 'flash-dn'); }
}

// ------------------------------------------------------------ live tape
const SYMS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'SUI', 'LINK', 'ONDO', 'FET', 'TAO', 'PEPE', 'WIF', 'AVAX'];
function onTrade(sym, price, qty, sideBuy, t) {
  const usd = price * qty;
  if (['BTC', 'ETH', 'SOL'].includes(sym)) tickPrice(sym, price);
  S.taker[sym] = (S.taker[sym] || 0) + (sideBuy ? usd : -usd);
  if (usd >= 50_000) { S.tape.unshift({ sym, price, usd, buy: sideBuy, t, fresh: true }); if (S.tape.length > 300) S.tape.length = 300; queuePaint(); }
}
let paintQueued = false, takerTimer = 0;
function queuePaint() { if (paintQueued) return; paintQueued = true; requestAnimationFrame(() => { paintQueued = false; paintTape(); }); }
function paintTape() {
  const rows = S.tape.filter((r) => r.usd >= S.whaleMin);
  const li = (r) => `<li class="${r.fresh ? 'new' : ''} ${r.buy ? '' : 'sell'}"><span class="t">${new Date(r.t).toLocaleTimeString([], { hour12: false })}</span><span class="side ${r.buy ? 'up' : 'dn'}">${r.buy ? 'BUY' : 'SELL'}</span><span><b>${r.sym}</b> @ ${px(r.price)}</span><span style="text-align:right" class="${r.buy ? 'up' : 'dn'}">${money(r.usd)}</span></li>`;
  const empty = `<li class="empty">Waiting for trades ≥ ${money(S.whaleMin)}…</li>`;
  const mini = $('#tapeMini'), full = $('#tapeFull');
  if (mini) mini.innerHTML = rows.slice(0, 8).map(li).join('') || empty;
  if (full) full.innerHTML = rows.slice(0, 120).map(li).join('') || empty;
  S.tape.forEach((r) => (r.fresh = false));
  const tb = $('#takerBars');
  if (tb && Date.now() - takerTimer > 1500) { takerTimer = Date.now(); tb.innerHTML = dbars(Object.entries(S.taker).map(([s, v]) => ({ label: s, value: v })).sort((a, b) => b.value - a.value)); }
}

function connectBinance() {
  const streams = SYMS.map((s) => `${s.toLowerCase()}usdt@aggTrade`).join('/');
  let opened = false;
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
  ws.onopen = () => { opened = true; S.feed = 'Binance live'; };
  ws.onmessage = (e) => { const d = JSON.parse(e.data).data; if (!d) return; onTrade(d.s.replace('USDT', ''), +d.p, +d.q, !d.m, d.T); };
  ws.onerror = () => { if (!opened) connectCoinbase(); };
  ws.onclose = () => { if (opened) setTimeout(connectBinance, 3000); };
}
function connectCoinbase() {
  const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  ws.onopen = () => { S.feed = 'Coinbase live'; ws.send(JSON.stringify({ type: 'subscribe', product_ids: SYMS.map((s) => `${s}-USD`), channels: ['matches'] })); };
  // Coinbase reports the maker side: side "sell" means the taker bought.
  ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type !== 'match') return; onTrade(d.product_id.split('-')[0], +d.price, +d.size, d.side === 'sell', Date.parse(d.time)); };
  ws.onclose = () => setTimeout(connectCoinbase, 5000);
}

// ------------------------------------------------------------ demo mode (used only when no server is reachable)
const rnd = (() => { let a = 20261115; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const jit = (base, spread) => base * (1 + (rnd() * 2 - 1) * spread);
function walk(n, start, vol, drift = 0) { const o = [start]; for (let i = 1; i < n; i++) o.push(o[i - 1] * (1 + drift + (rnd() * 2 - 1) * vol)); return o; }
const DEMO = {
  '/api/sectors': () => ({ source: 'DEMO · simulated', rows: [['AI', 38e9], ['RWA', 24e9], ['Memecoins', 62e9], ['DeFi', 118e9], ['Layer 1', 2.6e12], ['Layer 2', 22e9], ['DePIN', 21e9], ['Gaming', 14e9], ['Liquid staking', 61e9], ['Stablecoins', 3.1e11], ['Prediction mkts', 3.2e9], ['Perp DEX', 19e9]].map(([label, m]) => { const p = (rnd() * 2 - 1) * (label === 'Stablecoins' ? 0.3 : 7); return { label, name: label, mcap: m, pct24h: p, delta24h: m - m / (1 + p / 100), volume24h: m * jit(0.08, 0.6) }; }) }),
  '/api/stablecoins': () => { const rows = [['USDT', 1.84e11], ['USDC', 7.6e10], ['USDe', 1.3e10], ['USDS', 9e9], ['DAI', 4.6e9], ['USD1', 2.9e9], ['PYUSD', 2.4e9], ['FDUSD', 1.4e9], ['RLUSD', 1.1e9], ['USDtb', 1e9]].map(([symbol, s]) => ({ symbol, name: symbol, supply: s, d1: s * (rnd() - 0.42) * 0.004, d7: s * (rnd() - 0.4) * 0.02, d30: s * (rnd() - 0.35) * 0.05 })); const total = rows.reduce((a, r) => ({ supply: a.supply + r.supply, d1: a.d1 + r.d1, d7: a.d7 + r.d7, d30: a.d30 + r.d30 }), { supply: 0, d1: 0, d7: 0, d30: 0 }); return { source: 'DEMO · simulated', total, rows }; },
  '/api/chain-stables': () => ({ source: 'DEMO · simulated', rows: [['Ethereum', 1.6e11], ['Tron', 7.8e10], ['Solana', 1.4e10], ['BSC', 1.1e10], ['Arbitrum', 7e9], ['Base', 4.6e9], ['Hyperliquid', 5.5e9], ['Plasma', 3e9], ['Avalanche', 2.1e9], ['Polygon', 2.8e9], ['Aptos', 1.2e9], ['Sui', 1e9]].map(([chain, s]) => ({ chain, supply: s, d1: s * (rnd() - 0.45) * 0.006, d7: s * (rnd() - 0.45) * 0.03, d30: s * (rnd() - 0.4) * 0.08 })) }),
  '/api/chains': () => ({ source: 'DEMO · simulated', tvl: [['Ethereum', 7.4e10], ['Solana', 1.1e10], ['BSC', 7.5e9], ['Base', 5e9], ['Arbitrum', 3.2e9], ['Hyperliquid', 2.4e9], ['Tron', 4.6e9], ['Bitcoin', 6e9], ['Avalanche', 1.7e9], ['Sui', 2e9]].map(([chain, tvl]) => ({ chain, tvl, token: '' })), bridges: ['Ethereum', 'Solana', 'Base', 'Arbitrum', 'BSC', 'Optimism', 'Polygon', 'Avalanche', 'Hyperliquid', 'Sui'].map((chain) => { const i = jit(9e8, 0.8), o = jit(9e8, 0.8); return { chain, in7d: i, out7d: o, net7d: i - o, net1d: (i - o) / jit(6, 0.5) }; }) }),
  '/api/tradfi': () => { const G = { 'US equities': [['SPY', 680, 7e7], ['QQQ', 610, 4.5e7], ['IWM', 245, 3e7], ['DIA', 470, 3e6]], 'Global equities': [['EFA', 92, 1.5e7], ['EEM', 52, 2.5e7], ['INDA', 55, 6e6], ['FXI', 38, 3e7]], 'Sectors': [['XLK', 290, 8e6], ['SMH', 330, 7e6], ['XLF', 53, 4e7], ['XLE', 90, 1.5e7], ['XLV', 140, 9e6]], 'Treasuries': [['BIL', 91.6, 9e6], ['SHY', 83, 4e6], ['IEF', 96, 8e6], ['TLT', 89, 3.5e7], ['TIP', 111, 2e6]], 'Credit': [['AGG', 100, 7e6], ['LQD', 111, 2e7], ['HYG', 81, 3.5e7]], 'Commodities': [['GLD', 380, 1e7], ['SLV', 46, 2.5e7], ['USO', 72, 4e6]], 'Crypto ETFs': [['IBIT', 58, 5e7], ['FBTC', 88, 4e6], ['GBTC', 78, 3e6], ['ETHA', 26, 2.5e7]], 'Dollar': [['UUP', 27, 3e6]] }; return { source: 'DEMO · simulated', groups: Object.entries(G).map(([group, list]) => ({ group, rows: list.map(([sym, p, v]) => { const c = walk(60, p, 0.012, (rnd() - 0.5) * 0.003); const last = c.at(-1); const mf = () => (rnd() * 2 - 1) * v * last * 0.35; const f1 = mf(); let f5 = f1; for (let i = 0; i < 4; i++) f5 += mf(); let f20 = f5; for (let i = 0; i < 15; i++) f20 += mf(); return { sym, price: last, chg1d: (last / c.at(-2) - 1) * 100, chg5d: (last / c.at(-6) - 1) * 100, chg20d: (last / c.at(-21) - 1) * 100, dollarVol: v * last, flow1d: f1, flow5d: f5, flow20d: f20, spark: c.slice(-30) }; }) })) }; },
  '/api/macro': () => ({ source: 'DEMO · simulated', rows: [['^IRX', '3M yield', 3.85, 0.004], ['^FVX', '5Y yield', 3.72, 0.01], ['^TNX', '10Y yield', 4.12, 0.01], ['^TYX', '30Y yield', 4.68, 0.008], ['^VIX', 'VIX', 17, 0.05], ['DX-Y.NYB', 'DXY', 99.4, 0.003]].map(([sym, label, b, v]) => { const c = walk(40, b, v); return { sym, label, value: c.at(-1), prev: c.at(-2), monthAgo: c.at(-22), spark: c.slice(-30) }; }) }),
  '/api/liquidity': () => { const ser = (n, s, v) => walk(n, s, v).map((value, i) => ({ date: `d${i}`, value })); const tga = ser(60, 8.6e11, 0.025), rrp = ser(60, 4e10, 0.12), walcl = ser(12, 6.55e12, 0.002); return { source: 'DEMO · simulated', tga, rrp, walcl, debt: ser(40, 3.82e13, 0.0008), netLiquidity: walcl.at(-1).value - tga.at(-1).value - rrp.at(-1).value }; },
};
function demoTape() {
  S.feed = 'DEMO · simulated';
  const base = { BTC: 98000, ETH: 3500, SOL: 190, XRP: 2.3, BNB: 900, DOGE: 0.2, SUI: 3.4, LINK: 18, ONDO: 0.9, FET: 0.6, TAO: 420, PEPE: 0.00001, WIF: 0.9, AVAX: 24 };
  const weight = ['BTC', 'BTC', 'BTC', 'ETH', 'ETH', 'SOL', 'SOL', 'XRP', 'BNB', 'DOGE', 'SUI', 'LINK', 'ONDO', 'FET', 'TAO', 'PEPE', 'WIF', 'AVAX'];
  (function tick() {
    for (let i = 0; i < 3; i++) {
      const s = weight[Math.floor(Math.random() * weight.length)];
      base[s] *= 1 + (Math.random() - 0.5) * 0.0008;
      const usd = Math.exp(Math.random() * 9 + 6.5) * (s === 'BTC' ? 2 : 1);
      onTrade(s, base[s], usd / base[s], Math.random() > 0.48, Date.now());
    }
    setTimeout(tick, 250 + Math.random() * 600);
  })();
}

// ------------------------------------------------------------ interactions
const tip = $('#tip');
function showTip(el, x, y) { tip.textContent = el.dataset.tip; tip.classList.add('on'); const r = tip.getBoundingClientRect(); tip.style.left = Math.min(x + 14, innerWidth - r.width - 8) + 'px'; tip.style.top = Math.max(8, y - r.height - 10) + 'px'; }
document.addEventListener('pointermove', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) showTip(el, e.clientX, e.clientY); else tip.classList.remove('on'); });
document.addEventListener('pointerdown', (e) => { const el = e.target.closest?.('[data-tip]'); if (el && e.pointerType !== 'mouse') showTip(el, e.clientX, e.clientY); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('.seg button'); if (!b) return;
  const segEl = b.parentElement;
  if (segEl.dataset.whale !== undefined) { S.whaleMin = +b.dataset.v; render(); return; }
  S.win[segEl.dataset.seg] = b.dataset.v; render();
});
addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
setInterval(() => { if (S.updated) $('#updated').textContent = `updated ${ago(S.updated)}`; }, 5000);

// ------------------------------------------------------------ boot
(async function boot() {
  S.live = window.FLOWSTATE_DEMO ? false : await detectLive();
  if (!S.live) {
    $('#mode').textContent = 'DEMO'; $('#mode').className = 'badge demo'; $('#dot').classList.add('demo');
    $('#demoNote').classList.remove('hidden');
    demoTape();
  } else {
    connectBinance();
  }
  render();
  await refresh();
  if (S.live) setInterval(refresh, REFRESH_MS);
})();
})();
