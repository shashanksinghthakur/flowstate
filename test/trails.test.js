// Replays one complete trail through the engine with simulated chain + Hyperliquid responses:
// Aave V3 (Ethereum) withdraws 1,000 WETH to W -> W deposits $1.8M USDC to the Hyperliquid bridge -> W opens an ETH short.
import assert from 'node:assert/strict';
import { createTrails } from '../lib/trails.js';

const W = '0x00000000000000000000000000000000000000aa';
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');
const now = Date.now();
const heads = { arb: 500_000_000, eth: 26_000_000 };
const WETH_ETH = '0xc02aaa39b223fe8d0a0e5c4f27ead083c756cc2';
const hexN = (n) => '0x' + BigInt(n).toString(16);
let notified = [];

const rpcFor = (url, body) => {
  const arb = url.includes('arbitrum');
  const head = arb ? heads.arb : heads.eth;
  const { method, params } = body;
  if (method === 'eth_blockNumber') return hexN(head);
  if (method === 'eth_getBlockByNumber') { const bn = parseInt(params[0], 16); const secsPerBlock = arb ? 0.25 : 12; return { timestamp: hexN(Math.floor((now - (head - bn) * secsPerBlock * 1000) / 1000)) }; }
  if (method === 'eth_getLogs') {
    const f = params[0]; const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    const inRange = (b) => b >= from && b <= to;
    const out = [];
    // Aave withdraw on Ethereum, 3h ago
    const wBlock = heads.eth - 900;
    if (!arb && f.topics[0].startsWith('0x3115') && inRange(wBlock)) out.push({ topics: [f.topics[0], pad(WETH_ETH), pad(W), pad(W)], data: hexN(1000n * 10n ** 18n), blockNumber: hexN(wBlock), transactionHash: '0xaaa1' });
    // Bridge deposit on Arbitrum, 2h ago (topics[2] = bridge for deposits)
    const dBlock = heads.arb - 2 * 3600 * 4;
    if (arb && f.topics[0].startsWith('0xddf2') && f.topics[2] && inRange(dBlock)) out.push({ topics: [f.topics[0], pad(W), f.topics[2]], data: hexN(1_800_000n * 10n ** 6n), blockNumber: hexN(dBlock), transactionHash: '0xbbb2' });
    // A small deposit that must be ignored
    if (arb && f.topics[0].startsWith('0xddf2') && f.topics[2] && inRange(dBlock + 10)) out.push({ topics: [f.topics[0], pad('0x00000000000000000000000000000000000000bb'), f.topics[2]], data: hexN(5_000n * 10n ** 6n), blockNumber: hexN(dBlock + 10), transactionHash: '0xccc3' });
    return out;
  }
  throw new Error('unexpected ' + method);
};
const postJSON = async (url, body) => {
  if (url.includes('hyperliquid')) {
    if (body.type === 'userFillsByTime') return [
      { coin: 'ETH', dir: 'Open Short', px: '1830', sz: '2500', time: now - 1.5 * 3600e3, closedPnl: '0' },
      { coin: 'ETH', dir: 'Open Short', px: '1826', sz: '2400', time: now - 1.4 * 3600e3, closedPnl: '0' },
      { coin: '@107', dir: 'Buy', px: '1', sz: '10', time: now - 3600e3, closedPnl: '0' },
    ];
    if (body.type === 'clearinghouseState') return { marginSummary: { accountValue: '1790000' }, assetPositions: [{ position: { coin: 'ETH', szi: '-4900', positionValue: '8960000', entryPx: '1828', leverage: { value: 5 }, unrealizedPnl: '-12000', liquidationPx: '2150' } }] };
  }
  return { jsonrpc: '2.0', id: body.id, result: rpcFor(url, body) };
};
const fetchJSON = async (url) => ({ coins: { [url.split('/').pop()]: { price: 1830, decimals: 18, symbol: 'WETH' } } });

const tr = createTrails({ fetchJSON, postJSON, onTrail: (t) => notified.push(t) });
await tr.poll();
const snap = tr.snapshot();
assert.equal(snap.status.errors.length, 0, JSON.stringify(snap.status.errors));
assert.equal(snap.trails.length, 1, 'one trail; the $5K deposit is ignored');
const t = snap.trails[0];
assert.equal(t.type, 'aave_to_hl');
assert.deepEqual(t.steps.map((s) => s.kind), ['source', 'bridge', 'trade']);
assert.match(t.steps[0].detail, /1,000 WETH/);
assert.match(t.steps[2].label, /ETH short/);
assert.ok(Math.abs(t.steps[2].usd - (1830 * 2500 + 1826 * 2400)) < 1, 'perp notional summed, spot fill ignored');
assert.match(t.insight, /pulled \$1\.83M out of Aave \(WETH\) then moved \$1\.80M onto Hyperliquid 60 min later and opened a \$8\.96M ETH short/);
assert.equal(t.hl.positions[0].side, 'short'); assert.equal(t.hl.positions[0].leverage, 5);
assert.equal(snap.summary.short > 0 && snap.summary.long === 0, true); assert.equal(Math.round(snap.summary.tilt), -100);
assert.equal(notified.length, 1, 'Telegram hook fires once');
await tr.poll();
assert.equal(notified.length, 1, 'no repeat alert on the next poll');
console.log('trails tests passed:', t.insight);
