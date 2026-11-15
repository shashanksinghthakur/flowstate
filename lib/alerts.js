// Telegram alert channel. Posts to TELEGRAM_CHAT_ID (e.g. @flowstate_alerts) via the bot in TELEGRAM_BOT_TOKEN.
// The bot must be an admin of the channel with permission to post.
const sent = new Map();          // dedupe key -> time
const recent = [];               // timestamps of posts, for the hourly cap
const H = 3600e3;
const day = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function createAlerts(cfg) {
  const { token, chat, site = '', fmt$, data } = cfg;
  const whaleMin = Number(cfg.whaleMin) || 5e6;
  const maxPerHour = Number(cfg.maxPerHour) || 12;
  const digestHour = Number.isFinite(Number(cfg.digestHour)) ? Number(cfg.digestHour) : 13;
  const enabled = Boolean(token && chat);
  const log = [];

  async function send(html, key, { force = false } = {}) {
    if (key && sent.has(key)) return false;
    while (recent.length && Date.now() - recent[0] > H) recent.shift();
    if (!force && recent.length >= maxPerHour) return false;
    if (key) sent.set(key, Date.now());
    recent.push(Date.now());
    log.unshift({ t: Date.now(), key, text: html.replace(/<[^>]+>/g, '') }); log.length = Math.min(log.length, 50);
    if (!enabled) return true;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) { const e = await r.text(); console.warn('telegram', r.status, e.slice(0, 200)); return false; }
    return true;
  }
  const link = (label, hash) => (site ? `\n<a href="${site}/#${hash}">${esc(label)}</a>` : '');
  const sign = (v) => (v >= 0 ? '▲' : '▼');

  // ---------------- big flow moves (every 15 min)
  async function checkFlows() {
    const rows = await data.chainStablesAll();
    const total = rows.reduce((t, r) => t + r.d1, 0);
    if (Math.abs(total) >= (cfg.mintMin || 5e8)) {
      await send(`${sign(total)} <b>Stablecoin ${total >= 0 ? 'mint' : 'redemption'} wave</b>\n${fmt$(Math.abs(total))} net ${total >= 0 ? 'minted into' : 'redeemed out of'} crypto in 24h.${link('Trace it on Flowstate', 'flowmap')}`, `mint:${day()}:${Math.sign(total)}`);
    }
    for (const r of rows) {
      if (Math.abs(r.d1) < (cfg.chainMin || 3e8)) continue;
      const pct = r.supply ? (r.d1 / r.supply) * 100 : 0;
      await send(`${sign(r.d1)} <b>${esc(r.chain)} ${r.d1 >= 0 ? 'inflow' : 'outflow'}</b>\n${fmt$(Math.abs(r.d1))} of stablecoins ${r.d1 >= 0 ? 'arrived' : 'left'} in 24h (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}% of its base).${link('See where it went', 'flowmap')}`, `chain:${r.chain}:${day()}:${Math.sign(r.d1)}`);
    }
    const protos = await data.protocolsRaw();
    const br = protos.find((p) => p.slug === 'hyperliquid-bridge');
    if (br) {
      const d = Object.values(br.chains).reduce((t, v) => t + (data.pctDelta(v, br.c1) || 0), 0);
      if (Math.abs(d) >= (cfg.bridgeMin || 1e8)) await send(`${sign(d)} <b>Hyperliquid ${d >= 0 ? 'deposits' : 'withdrawals'}</b>\n${fmt$(Math.abs(d))} of margin ${d >= 0 ? 'moved onto' : 'left'} Hyperliquid in 24h.${link('Trace the bridge', 'flowmap')}`, `hlbridge:${day()}:${Math.sign(d)}`);
    }
  }

  // ---------------- US demand: Coinbase premium (every 5 min)
  let premState = 0;
  async function checkPremium() {
    const p = await data.coinbasePremium();
    if (!p) return;
    const th = cfg.premiumBps || 15;
    if (Math.abs(p.bps) >= th && Math.sign(p.bps) !== premState) {
      premState = Math.sign(p.bps);
      await send(`${sign(p.bps)} <b>US ${p.bps > 0 ? 'buyers paying up' : 'selling pressure'}</b>\nCoinbase BTC is trading ${Math.abs(p.bps).toFixed(1)} bps ${p.bps > 0 ? 'above' : 'below'} Binance ($${Math.round(p.cb).toLocaleString('en-US')} vs $${Math.round(p.bn).toLocaleString('en-US')}).${link('Open Regions', 'flowmap')}`, `prem:${Date.now() / H | 0}`);
    } else if (Math.abs(p.bps) < th / 3) premState = 0;
  }

  // ---------------- daily digest
  async function digest(force = false) {
    const now = new Date();
    if (!force && now.getUTCHours() !== digestHour) return;
    const key = force ? null : `digest:${day()}`;
    if (key && sent.has(key)) return;
    const [rows, sec, prem] = await Promise.all([data.chainStablesAll(), data.sectors().catch(() => null), data.coinbasePremium().catch(() => null)]);
    const total = rows.reduce((t, r) => t + r.d1, 0);
    const byIn = [...rows].sort((a, b) => b.d1 - a.d1);
    const s = sec?.rows ? [...sec.rows].sort((a, b) => b.pct24h - a.pct24h) : [];
    const lines = [
      `<b>Flowstate daily: where money moved</b>`,
      `Stablecoins: ${total >= 0 ? '+' : '−'}${fmt$(Math.abs(total)).replace('−', '')} net in 24h`,
      `Top inflow: ${esc(byIn[0].chain)} ${fmt$(byIn[0].d1)}`,
      `Top outflow: ${esc(byIn.at(-1).chain)} ${fmt$(byIn.at(-1).d1)}`,
      s.length ? `Leading narrative: ${esc(s[0].label)} ${s[0].pct24h >= 0 ? '+' : '−'}${Math.abs(s[0].pct24h).toFixed(1)}%` : null,
      s.length ? `Lagging: ${esc(s.at(-1).label)} ${s.at(-1).pct24h >= 0 ? '+' : '−'}${Math.abs(s.at(-1).pct24h).toFixed(1)}%` : null,
      prem ? `Coinbase premium: ${prem.bps >= 0 ? '+' : '−'}${Math.abs(prem.bps).toFixed(1)} bps` : null,
    ].filter(Boolean);
    await send(lines.join('\n') + link('Open Flow Scope', 'flowmap'), key, { force });
  }

  // ---------------- whale trades: Coinbase public match stream (works from US servers)
  let ws = null, burst = {};
  function connectWhales() {
    if (typeof WebSocket === 'undefined') return;
    ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD', 'ETH-USD', 'SOL-USD'], channels: ['matches'] }));
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.type !== 'match') return;
      const buy = d.side === 'sell'; // Coinbase reports the maker side
      const k = `${d.product_id}:${buy ? 'b' : 's'}`;
      const usd = Number(d.price) * Number(d.size);
      const b = burst[k] && Date.now() - burst[k].t < 3000 ? burst[k] : (burst[k] = { t: Date.now(), usd: 0, px: Number(d.price), fired: false });
      b.usd += usd; b.t = Date.now();
      if (!b.fired && b.usd >= whaleMin) {
        b.fired = true;
        const asset = d.product_id.split('-')[0];
        send(`${buy ? '▲' : '▼'} <b>Whale ${buy ? 'buy' : 'sell'}: ${asset}</b>\n${fmt$(b.usd)} hit Coinbase at ~$${b.px.toLocaleString('en-US', { maximumFractionDigits: 2 })} within seconds.${link('Live tape', 'tape')}`, `whale:${k}:${Date.now() / 600e3 | 0}`).catch(() => {});
      }
    };
    ws.onclose = () => setTimeout(connectWhales, 10_000);
    ws.onerror = () => {};
  }

  const timers = [];
  function start() {
    const safe = (fn) => () => fn().catch((e) => console.warn('alerts', e.message));
    timers.push(setInterval(safe(checkFlows), 15 * 60e3), setInterval(safe(checkPremium), 5 * 60e3), setInterval(safe(() => digest()), 10 * 60e3));
    setTimeout(safe(checkFlows), 30e3); setTimeout(safe(checkPremium), 20e3);
    connectWhales();
    console.log(`alerts: ${enabled ? `posting to ${chat}` : 'dry run (no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)'}`);
  }
  function stop() { timers.forEach(clearInterval); ws?.close(); }
  return { enabled, start, stop, send, digest, checkFlows, checkPremium, log };
}
