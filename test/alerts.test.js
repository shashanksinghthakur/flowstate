// Telegram alerts in dry-run mode (no bot token): checks what would be posted.
import assert from 'node:assert/strict';
process.env.FLOWSTATE_NO_LISTEN = '1';
await import('../scripts/mock-server.js');
const { alerts, flowNode } = await import('../server.js');
assert.equal(alerts.enabled, false, 'dry run without token');
await alerts.digest(true);
assert.match(alerts.log[0].text, /Flowstate daily: where money moved/);
assert.match(alerts.log[0].text, /Top inflow: /);
const before = alerts.log.length;
await alerts.checkFlows();
const posted = alerts.log.slice(0, alerts.log.length - before).map((x) => x.text);
const root = await flowNode('chains', 'd1', 50);
const issuers = [...root.left, ...root.right].find((x) => x.label.startsWith('Issuers'));
assert.equal(posted.some((t) => /mint wave|redemption wave/.test(t)), issuers.value >= 5e8, 'mint/redeem wave fires only above $500M');
const br = await flowNode('proto:hyperliquid-bridge', 'd1', 8);
assert.equal(posted.some((t) => /Hyperliquid deposits|Hyperliquid withdrawals/.test(t)), Math.abs(br.readout.net) >= 1e8, 'bridge alert fires only above $100M');

// Threshold behaviour with controlled inputs
const { createAlerts } = await import('../lib/alerts.js');
const fmt$ = (v) => `$${(Math.abs(v) / 1e6).toFixed(0)}M`;
const a2 = createAlerts({ fmt$, data: {
  chainStablesAll: async () => [{ chain: 'Arbitrum', supply: 9e9, d1: 6e8 }, { chain: 'Tron', supply: 8e10, d1: 1e7 }],
  protocolsRaw: async () => [{ slug: 'hyperliquid-bridge', c1: 5, chains: { Arbitrum: 4.2e9 } }],
  pctDelta: (v, c) => v - v / (1 + c / 100),
} });
await a2.checkFlows();
const t2 = a2.log.map((x) => x.text).join('\n');
assert.match(t2, /mint wave/, '$610M net mint fires');
assert.match(t2, /Arbitrum inflow/, '$600M chain inflow fires');
assert.doesNotMatch(t2, /Tron/, '$10M chain move stays quiet');
assert.match(t2, /Hyperliquid deposits/, '$200M bridge deposit fires');
const n = alerts.log.length;
await alerts.checkFlows();
assert.equal(alerts.log.length, n, 'same-day alerts are not repeated');
console.log('alerts tests passed');
