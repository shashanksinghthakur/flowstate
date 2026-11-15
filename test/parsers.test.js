// Verifies every normaliser against fixture payloads shaped like the real upstream APIs.
import assert from 'node:assert/strict';

const day = 864e5, now = Date.now();
const bars = (n, p) => ({ chart: { result: [{ meta: { regularMarketPrice: p }, timestamp: Array.from({ length: n }, (_, i) => Math.floor((now - (n - i) * day) / 1000)),
  indicators: { quote: [{ open: Array(n).fill(p), high: Array(n).fill(p * 1.01), low: Array(n).fill(p * 0.99), close: Array.from({ length: n }, (_, i) => p * (1 + i * 0.001)), volume: Array(n).fill(1e6) }] } }] } });
const FIX = [
  [/coingecko/, [{ id: 'artificial-intelligence', name: 'AI', market_cap: 4e10, market_cap_change_24h: 5, volume_24h: 3e9 }, { id: 'meme-token', name: 'Meme', market_cap: 6e10, market_cap_change_24h: -2, volume_24h: 5e9 }]],
  [/stablecoins\.llama/, { peggedAssets: [{ symbol: 'USDT', name: 'Tether', pegType: 'peggedUSD', circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 90 }, circulatingPrevWeek: { peggedUSD: 80 }, circulatingPrevMonth: { peggedUSD: 70 },
    chainCirculating: { Ethereum: { current: { peggedUSD: 60 }, circulatingPrevDay: { peggedUSD: 50 }, circulatingPrevWeek: { peggedUSD: 40 }, circulatingPrevMonth: { peggedUSD: 30 } }, Tron: { current: { peggedUSD: 40 }, circulatingPrevDay: { peggedUSD: 40 }, circulatingPrevWeek: { peggedUSD: 40 }, circulatingPrevMonth: { peggedUSD: 40 } } } },
    { symbol: 'EURC', pegType: 'peggedEUR', circulating: { peggedEUR: 5 } }] }],
  [/bridges\.llama/, [{ date: '1', depositUSD: 10, withdrawUSD: 30 }, { date: '2', depositUSD: 5, withdrawUSD: 1 }]],
  [/api\.llama\.fi\/v2\/chains/, [{ name: 'Ethereum', tvl: 5e10, tokenSymbol: 'ETH' }, { name: 'Dead', tvl: 0 }]],
  [/yahoo/, null],
  [/operating_cash_balance/, { data: [{ record_date: '2026-11-13', account_type: 'Treasury General Account (TGA) Closing Balance', close_today_bal: '850000', open_today_bal: 'null' }, { record_date: '2026-11-12', account_type: 'Treasury General Account (TGA) Opening Balance', open_today_bal: '1' }, { record_date: '2026-11-12', account_type: 'Treasury General Account (TGA) Closing Balance', close_today_bal: '800000' }] }],
  [/reverserepo/, { repo: { operations: [{ operationDate: '2026-11-13', totalAmtAccepted: 5e9 }, { operationDate: '2026-11-12', totalAmtAccepted: 4e9 }] } }],
  [/debt_to_penny/, { data: [{ record_date: '2026-11-13', tot_pub_debt_out_amt: '38000000000000' }] }],
];
globalThis.fetch = async (url) => {
  const f = FIX.find(([re]) => re.test(url));
  if (!f) throw new Error('unmocked ' + url);
  const body = /yahoo/.test(url) ? bars(60, 100) : f[1];
  return { ok: true, status: 200, json: async () => body };
};

const { server, summarise } = await import('../server.js');
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const realFetch = (await import('node:http')).get;
const get = (p) => new Promise((res, rej) => realFetch(base + p, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
const J = async (p) => { const r = await get(p); assert.equal(r.status, 200, p + ' ' + r.body); return JSON.parse(r.body); };

const sec = await J('/api/sectors');
assert.equal(sec.rows.length, 2);
const ai = sec.rows.find((r) => r.label === 'AI');
assert.ok(Math.abs(ai.delta24h - (4e10 - 4e10 / 1.05)) < 1, 'sector delta');

const st = await J('/api/stablecoins');
assert.equal(st.rows.length, 1, 'non-USD pegs excluded');
assert.deepEqual([st.total.d1, st.total.d7, st.total.d30], [10, 20, 30]);

const cs = await J('/api/chain-stables');
const eth = cs.rows.find((r) => r.chain === 'Ethereum');
assert.deepEqual([eth.supply, eth.d1, eth.d7, eth.d30], [60, 10, 20, 30]);

const ch = await J('/api/chains');
assert.equal(ch.tvl.length, 1);
assert.equal(ch.bridges[0].net7d, 31 - 15);
assert.equal(ch.bridges[0].net1d, 1 - 5);

const tf = await J('/api/tradfi');
assert.ok(tf.groups.every((g) => g.rows.length === g.rows.length));
const spy = tf.groups[0].rows[0];
assert.equal(spy.sym, 'SPY');
assert.ok(spy.flow5d > 0, 'closing above mid on volume => accumulation');

const mc = await J('/api/macro');
assert.equal(mc.rows.length, 6);

const lq = await J('/api/liquidity');
assert.deepEqual(lq.tga.map((r) => r.value), [8e11, 8.5e11], 'TGA closing balances, millions -> dollars, oldest first');
assert.deepEqual(lq.rrp.map((r) => r.date), ['2026-11-12', '2026-11-13']);
assert.equal(lq.debt.at(-1).value, 38e12);

// money-flow proxy sign checks
const mk = (c) => ({ bars: [{ h: 11, l: 9, c, v: 100 }] });
assert.ok(summarise('X', mk(11)).flow1d > 0);
assert.ok(summarise('X', mk(9)).flow1d < 0);
assert.equal(summarise('X', mk(10)).flow1d, 0);

const idx = await get('/');
assert.equal(idx.status, 200); assert.match(idx.body, /FLOWSTATE|Flowstate/);
assert.equal((await get('/../server.js')).status !== 200, true, 'no path traversal');

server.close();
console.log('all parser tests passed');
