// Alpaca, FRED and Stooq providers, with Yahoo blocked (as it is on cloud hosts).
import assert from 'node:assert/strict';
process.env.ALPACA_KEY_ID = 'k'; process.env.ALPACA_SECRET = 's'; process.env.FRED_API_KEY = 'f';

const day = 864e5, now = Date.now();
const alpacaBar = (i, p) => ({ t: new Date(now - (60 - i) * day).toISOString(), o: p, h: p * 1.01, l: p * 0.99, c: p * (1 + i * 0.001), v: 1e6 });
let alpacaPages = 0;
globalThis.fetch = async (url) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => body });
  if (/yahoo/.test(url)) return { ok: false, status: 429, json: async () => ({}), text: async () => '' };
  if (/alpaca\.markets\/v2\/stocks\/bars/.test(url)) {
    alpacaPages++;
    const syms = decodeURIComponent(url.match(/symbols=([^&]+)/)[1]).split(',');
    const half = Math.ceil(syms.length / 2);
    const page = /page_token=p2/.test(url) ? syms.slice(half) : syms.slice(0, half);
    return ok({ bars: Object.fromEntries(page.map((s) => [s, Array.from({ length: 60 }, (_, i) => alpacaBar(i, 100))])), next_page_token: /page_token/.test(url) ? null : 'p2' });
  }
  if (/trades\/latest/.test(url)) return ok({ trades: { SPY: { p: 123.45, t: new Date(now).toISOString() } } });
  if (/stlouisfed/.test(url)) {
    const id = url.match(/series_id=([A-Z0-9]+)/)[1];
    return ok({ observations: Array.from({ length: 30 }, (_, i) => ({ date: new Date(now - i * day).toISOString().slice(0, 10), value: i === 3 ? '.' : String(4 + i * 0.01) })) , id });
  }
  if (/stooq/.test(url)) return ok('Date,Open,High,Low,Close,Volume\n2026-11-12,10,11,9,10.5,1000\n2026-11-13,10.5,12,10,11.8,2000\n');
  return ok({});
};

const { server, stooq } = await import('../server.js');
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const http = await import('node:http');
const J = (p) => new Promise((res, rej) => http.get(base + p, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));

const tf = await J('/api/tradfi');
const rows = tf.groups.flatMap((g) => g.rows);
const { TRADFI } = await import('../server.js');
assert.equal(rows.length, Object.values(TRADFI).flat().length, 'every ticker via Alpaca across 2 pages');
assert.equal(alpacaPages, 2);
assert.equal(rows.find((r) => r.sym === 'SPY').price, 123.45, 'latest IEX trade overrides daily close');
assert.match(tf.source, /Alpaca/);

const mc = await J('/api/macro');
assert.equal(mc.rows.length, 6, 'all macro series from FRED');
const tnx = mc.rows.find((r) => r.sym === '^TNX');
assert.equal(tnx.value, 4, 'latest observation, "." values skipped');
assert.match(mc.source, /FRED/);

const h = await J('/api/health');
assert.equal(h.alpaca, true); assert.equal(h.fred, true);

const s = await stooq('SPY');
assert.equal(s.bars.length, 2); assert.equal(s.price, 11.8);

server.close();
console.log('provider tests passed');
