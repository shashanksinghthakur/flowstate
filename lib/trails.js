// Money trails: follow large wallets across protocols using public chain data.
// Hop 1  Aave V3 withdrawal (Ethereum or Arbitrum)            -> wallet W
// Hop 2  USDC from W into the Hyperliquid bridge on Arbitrum   -> margin on Hyperliquid
// Hop 3  W's Hyperliquid fills and open positions              -> what the money became
// Also tracks withdrawals out of Hyperliquid and large standalone Aave exits.
// Links are made by wallet address. Same address on two chains is treated as the same owner.

const RPC = {
  arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
  ethereum: process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com',
};
const CHUNK = { arbitrum: 10_000, ethereum: 2_000 };
const BACKFILL = { arbitrum: 6 * 3600 * 4, ethereum: 6 * 300 }; // ~6h of blocks
const AAVE_POOL = { arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' };
const HL_BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_WITHDRAW = '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7';
const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const addr = (topic) => '0x' + topic.slice(26).toLowerCase();
const KEEP_MS = 48 * 3600e3;
const LINK_MS = 72 * 3600e3;

export function createTrails({ fetchJSON, postJSON, minEvent = 250_000, onTrail = () => {} } = {}) {
  const state = { last: {}, events: [], trails: new Map(), hlCache: new Map(), prices: new Map(), errors: [], polls: 0, lastPoll: null, started: Date.now() };
  let id = 1;
  const rpc = async (chain, method, params) => {
    const j = await postJSON(RPC[chain], { jsonrpc: '2.0', id: id++, method, params });
    if (j.error) throw new Error(`${chain} ${method}: ${j.error.message}`);
    return j.result;
  };
  const hex = (n) => '0x' + n.toString(16);
  const note = (e) => { state.errors.unshift({ t: Date.now(), msg: String(e.message || e).slice(0, 160) }); state.errors.length = Math.min(state.errors.length, 10); };

  async function priceOf(chain, token) {
    const k = `${chain}:${token}`;
    const hit = state.prices.get(k);
    if (hit && Date.now() - hit.t < 300_000) return hit;
    const j = await fetchJSON(`https://coins.llama.fi/prices/current/${k}`);
    const c = Object.values(j.coins || {})[0];
    const v = { t: Date.now(), price: c?.price ?? null, decimals: c?.decimals ?? 18, symbol: c?.symbol || token.slice(0, 6) };
    state.prices.set(k, v);
    return v;
  }

  // Block -> time by linear interpolation between two known blocks (labelled approximate in the UI).
  async function clock(chain, from, to) {
    const [a, b] = await Promise.all([rpc(chain, 'eth_getBlockByNumber', [hex(from), false]), rpc(chain, 'eth_getBlockByNumber', [hex(to), false])]);
    const ta = parseInt(a.timestamp, 16) * 1000, tb = parseInt(b.timestamp, 16) * 1000;
    return (bn) => (to === from ? tb : ta + ((bn - from) / (to - from)) * (tb - ta));
  }

  async function scan(chain) {
    const head = parseInt(await rpc(chain, 'eth_blockNumber', []), 16);
    let from = state.last[chain] ? state.last[chain] + 1 : head - BACKFILL[chain];
    if (head - from > BACKFILL[chain] * 2) from = head - BACKFILL[chain];
    if (from > head) return;
    const t = await clock(chain, from, head);
    for (let s = from; s <= head; s += CHUNK[chain]) {
      const e = Math.min(head, s + CHUNK[chain] - 1);
      const range = { fromBlock: hex(s), toBlock: hex(e) };
      const withdraws = await rpc(chain, 'eth_getLogs', [{ ...range, address: AAVE_POOL[chain], topics: [T_WITHDRAW] }]);
      for (const l of withdraws) {
        const reserve = addr(l.topics[1]), user = addr(l.topics[2]), to = addr(l.topics[3]);
        const p = await priceOf(chain, reserve).catch(() => null);
        if (!p?.price) continue;
        const amount = Number(BigInt(l.data)) / 10 ** p.decimals;
        const usd = amount * p.price;
        if (usd < minEvent) continue;
        add({ kind: 'aave_withdraw', chain, wallet: to, owner: user, token: p.symbol, amount, usd, block: parseInt(l.blockNumber, 16), ts: t(parseInt(l.blockNumber, 16)), tx: l.transactionHash });
      }
      if (chain === 'arbitrum') {
        const [ins, outs] = await Promise.all([
          rpc(chain, 'eth_getLogs', [{ ...range, address: USDC_ARB, topics: [T_TRANSFER, null, pad(HL_BRIDGE)] }]),
          rpc(chain, 'eth_getLogs', [{ ...range, address: USDC_ARB, topics: [T_TRANSFER, pad(HL_BRIDGE)] }]),
        ]);
        for (const l of ins) {
          const usd = Number(BigInt(l.data)) / 1e6;
          if (usd >= minEvent) add({ kind: 'hl_deposit', chain, wallet: addr(l.topics[1]), token: 'USDC', amount: usd, usd, block: parseInt(l.blockNumber, 16), ts: t(parseInt(l.blockNumber, 16)), tx: l.transactionHash });
        }
        for (const l of outs) {
          const usd = Number(BigInt(l.data)) / 1e6;
          if (usd >= minEvent) add({ kind: 'hl_withdraw', chain, wallet: addr(l.topics[2]), token: 'USDC', amount: usd, usd, block: parseInt(l.blockNumber, 16), ts: t(parseInt(l.blockNumber, 16)), tx: l.transactionHash });
        }
      }
    }
    state.last[chain] = head;
  }

  function add(ev) {
    if (state.events.some((x) => x.tx === ev.tx && x.kind === ev.kind && x.wallet === ev.wallet)) return;
    state.events.push(ev);
  }

  async function hlActivity(wallet, since) {
    const hit = state.hlCache.get(wallet);
    if (hit && Date.now() - hit.t < 120_000 && hit.since <= since) return hit;
    const [fills, ch] = await Promise.all([
      postJSON('https://api.hyperliquid.xyz/info', { type: 'userFillsByTime', user: wallet, startTime: Math.floor(since) }),
      postJSON('https://api.hyperliquid.xyz/info', { type: 'clearinghouseState', user: wallet }),
    ]);
    const agg = new Map();
    for (const f of fills || []) {
      if (String(f.coin).startsWith('@')) continue; // spot pairs: skip, perps are the signal
      const k = `${f.coin}|${f.dir}`;
      const a = agg.get(k) || { coin: f.coin, dir: f.dir, notional: 0, sz: 0, pxSum: 0, first: f.time, pnl: 0 };
      const n = Number(f.px) * Number(f.sz);
      a.notional += n; a.sz += Number(f.sz); a.pxSum += n; a.first = Math.min(a.first, f.time); a.pnl += Number(f.closedPnl) || 0;
      agg.set(k, a);
    }
    const trades = [...agg.values()].map((a) => ({ coin: a.coin, dir: a.dir, notional: a.notional, avgPx: a.sz ? a.pxSum / a.sz : null, first: a.first, pnl: a.pnl })).sort((a, b) => b.notional - a.notional);
    const positions = (ch?.assetPositions || []).map(({ position: p }) => ({
      coin: p.coin, side: Number(p.szi) < 0 ? 'short' : 'long', value: Number(p.positionValue), entryPx: Number(p.entryPx),
      leverage: p.leverage?.value ?? null, upnl: Number(p.unrealizedPnl), liqPx: p.liquidationPx ? Number(p.liquidationPx) : null,
    })).filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
    const v = { t: Date.now(), since, trades, positions, equity: Number(ch?.marginSummary?.accountValue) || 0 };
    state.hlCache.set(wallet, v);
    return v;
  }

  // Build or refresh one trail per wallet that moved size onto or off Hyperliquid, plus large Aave exits.
  async function link() {
    const now = Date.now();
    state.events = state.events.filter((e) => now - e.ts < KEEP_MS + LINK_MS);
    const byWallet = new Map();
    for (const e of state.events) { if (!byWallet.has(e.wallet)) byWallet.set(e.wallet, []); byWallet.get(e.wallet).push(e); }
    let hlCalls = 0;
    for (const [wallet, evs] of byWallet) {
      evs.sort((a, b) => a.ts - b.ts);
      const anchors = evs.filter((e) => (e.kind === 'hl_deposit' || e.kind === 'hl_withdraw') && now - e.ts < KEEP_MS);
      const exits = evs.filter((e) => e.kind === 'aave_withdraw' && now - e.ts < KEEP_MS && e.usd >= minEvent * 4);
      if (!anchors.length && !exits.length) continue;
      const key = wallet;
      const prev = state.trails.get(key);
      const steps = [];
      const deposit = anchors.filter((a) => a.kind === 'hl_deposit').reduce((t, a) => t + a.usd, 0);
      const withdrawn = anchors.filter((a) => a.kind === 'hl_withdraw').reduce((t, a) => t + a.usd, 0);
      const firstAnchor = anchors[0];
      const sources = evs.filter((e) => e.kind === 'aave_withdraw' && (!firstAnchor || (e.ts <= firstAnchor.ts && firstAnchor.ts - e.ts < LINK_MS)));
      for (const s of sources) steps.push({ kind: 'source', label: `Aave on ${cap(s.chain)}`, detail: `Withdrew ${fmtAmt(s.amount)} ${s.token}`, usd: s.usd, ts: s.ts, tx: s.tx, chain: s.chain });
      if (deposit) steps.push({ kind: 'bridge', label: 'Hyperliquid bridge', detail: `Deposited ${fmtUsd(deposit)} USDC`, usd: deposit, ts: anchors.find((a) => a.kind === 'hl_deposit').ts, tx: anchors.find((a) => a.kind === 'hl_deposit').tx, chain: 'arbitrum' });
      let hl = prev?.hl || null;
      if (deposit && (hlCalls < 12) && (!prev || now - (prev.hlAt || 0) > 5 * 60e3)) {
        try { hl = await hlActivity(wallet, (anchors.find((a) => a.kind === 'hl_deposit').ts) - 10 * 60e3); hlCalls++; } catch (e) { note(e); }
      }
      if (hl) {
        for (const t of hl.trades.filter((x) => /^Open/.test(x.dir)).slice(0, 3)) steps.push({ kind: 'trade', label: `${t.coin} ${t.dir.replace('Open ', '').toLowerCase()}`, detail: `Opened ${fmtUsd(t.notional)} at ~${fmtPx(t.avgPx)}`, usd: t.notional, ts: t.first, coin: t.coin, dir: t.dir });
        const closes = hl.trades.filter((x) => /^Close/.test(x.dir));
        if (closes.length) steps.push({ kind: 'trade', label: 'Closed positions', detail: closes.slice(0, 2).map((c) => `${c.coin} ${fmtUsd(c.notional)}${c.pnl ? `, PnL ${fmtUsd(c.pnl)}` : ''}`).join('; '), usd: closes.reduce((t, c) => t + c.notional, 0), ts: closes[0].first });
      }
      if (withdrawn) steps.push({ kind: 'exit', label: 'Left Hyperliquid', detail: `Withdrew ${fmtUsd(withdrawn)} USDC to Arbitrum`, usd: withdrawn, ts: anchors.find((a) => a.kind === 'hl_withdraw').ts, tx: anchors.find((a) => a.kind === 'hl_withdraw').tx, chain: 'arbitrum' });
      if (!anchors.length) for (const x of exits) steps.push({ kind: 'source', label: `Aave on ${cap(x.chain)}`, detail: `Withdrew ${fmtAmt(x.amount)} ${x.token}`, usd: x.usd, ts: x.ts, tx: x.tx, chain: x.chain });
      steps.sort((a, b) => a.ts - b.ts);
      const size = Math.max(deposit, withdrawn, ...sources.map((s) => s.usd), ...exits.map((x) => x.usd), 0);
      const type = sources.length && deposit ? 'aave_to_hl' : deposit ? 'into_hl' : withdrawn ? 'out_of_hl' : 'aave_exit';
      const t = { id: key, wallet, type, size, steps, hl: hl ? { positions: hl.positions.slice(0, 4), equity: hl.equity } : null, hlAt: hl ? (prev?.hl === hl ? prev.hlAt : now) : prev?.hlAt, updated: now, first: steps[0]?.ts || now, last: steps.at(-1)?.ts || now };
      t.insight = insight(t);
      const isNew = !prev || prev.steps.length < t.steps.length;
      state.trails.set(key, t);
      if (isNew && type === 'aave_to_hl' && t.steps.some((s) => s.kind === 'trade')) onTrail(t);
    }
    for (const [k, t] of state.trails) if (now - t.last > KEEP_MS) state.trails.delete(k);
  }

  function insight(t) {
    const src = t.steps.filter((s) => s.kind === 'source');
    const br = t.steps.find((s) => s.kind === 'bridge');
    const trades = t.steps.filter((s) => s.kind === 'trade' && s.dir);
    const exit = t.steps.find((s) => s.kind === 'exit');
    const parts = [];
    if (src.length) parts.push(`pulled ${fmtUsd(src.reduce((a, s) => a + s.usd, 0))} out of Aave (${[...new Set(src.map((s) => s.detail.split(' ').at(-1)))].join(', ')})`);
    if (br) parts.push(`${src.length ? 'then ' : ''}moved ${fmtUsd(br.usd)} onto Hyperliquid${src.length ? ` ${ago(br.ts - src[0].ts)} later` : ''}`);
    if (trades.length) parts.push(`and opened ${trades.map((x) => `a ${fmtUsd(x.usd)} ${x.label}`).join(' and ')}`);
    else if (br) parts.push('with no new perp positions yet');
    if (exit) parts.push(`${parts.length ? '; ' : ''}took ${fmtUsd(exit.usd)} back off Hyperliquid`);
    if (!parts.length) return 'Large wallet activity.';
    const s = `A wallet ${parts.join(' ')}.`.replace(' ; ', '; ');
    return s;
  }

  function summary(list) {
    let short = 0, long = 0, fromAave = 0, intoHl = 0, outHl = 0;
    for (const t of list) {
      for (const s of t.steps) {
        if (s.kind === 'trade' && s.dir === 'Open Short') short += s.usd;
        if (s.kind === 'trade' && s.dir === 'Open Long') long += s.usd;
        if (s.kind === 'bridge') intoHl += s.usd;
        if (s.kind === 'exit') outHl += s.usd;
      }
      if (t.type === 'aave_to_hl') fromAave += t.steps.filter((s) => s.kind === 'source').reduce((a, s) => a + s.usd, 0);
    }
    const coins = new Map();
    for (const t of list) for (const s of t.steps) if (s.kind === 'trade' && s.coin && s.dir) { const c = coins.get(s.coin) || { coin: s.coin, short: 0, long: 0 }; if (/Short/.test(s.dir)) c.short += s.usd; else c.long += s.usd; coins.set(s.coin, c); }
    return { short, long, tilt: short + long ? ((long - short) / (long + short)) * 100 : 0, fromAave, intoHl, outHl, coins: [...coins.values()].sort((a, b) => b.short + b.long - a.short - a.long).slice(0, 6) };
  }

  async function poll() {
    state.polls++;
    for (const chain of ['arbitrum', 'ethereum']) { try { await scan(chain); } catch (e) { note(e); } }
    try { await link(); } catch (e) { note(e); }
    state.lastPoll = Date.now();
  }

  let timer = null, running = null;
  return {
    state,
    poll: () => (running ||= poll().finally(() => { running = null; })),
    start(everyMs = 120_000) { if (timer) return; setTimeout(() => this.poll(), 5_000); timer = setInterval(() => this.poll(), everyMs); },
    stop() { clearInterval(timer); timer = null; },
    snapshot(min = minEvent) {
      const list = [...state.trails.values()].filter((t) => t.size >= min).sort((a, b) => b.last - a.last);
      return { updated: state.lastPoll, status: { blocks: state.last, polls: state.polls, events: state.events.length, warmingUp: state.polls < 1, errors: state.errors.slice(0, 3) }, summary: summary(list.filter((t) => Date.now() - t.last < 24 * 3600e3)), trails: list.slice(0, 60) };
    },
    _add: add, _link: link,
  };
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
function fmtUsd(v) { const a = Math.abs(v); const s = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'K' : a.toFixed(0); return `${v < 0 ? '−' : ''}$${s}`; }
function fmtAmt(v) { return v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function fmtPx(v) { return v == null ? '–' : v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 1 ? v.toFixed(2) : v.toPrecision(3); }
function ago(ms) { const m = Math.max(1, Math.round(ms / 60e3)); if (m < 90) return `${m} min`; const h = m / 60; return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} hours`; }
export { fmtUsd };
