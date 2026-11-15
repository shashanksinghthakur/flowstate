// Every Flow Scope node returns a well-formed, conserving graph from fixture data.
import assert from 'node:assert/strict';
process.env.FLOWSTATE_NO_LISTEN = '1';
const { server } = await import('../scripts/mock-server.js');
const { flowNode } = await import('../server.js');

for (const w of ['d1', 'd7', 'd30']) {
  const root = await flowNode('chains', w, 50);
  const sum = (a) => a.reduce((t, x) => t + x.value, 0);
  assert.ok(Math.abs(sum(root.left) - sum(root.right)) < 1, `chains ${w}: inflows equal outflows incl. issuers`);
}
const nodes = ['chains', 'chain:Arbitrum', 'chain:Ethereum', 'proto:hyperliquid-bridge', 'proto:aave-v3', 'hl', 'hl:BTC', 'platforms', 'assets', 'regions', 'proto:does-not-exist', 'hl:NOPE'];
for (const id of nodes) {
  const d = await flowNode(id, 'd7', 8);
  assert.ok(d.title, `${id}: title`);
  for (const x of [...d.left, ...d.right]) {
    assert.ok(x.value >= 0 && isFinite(x.value), `${id}: finite non-negative band`);
    assert.ok(['measured', 'estimated'].includes(x.method), `${id}: band method`);
  }
  assert.ok(d.left.length <= 8 && d.right.length <= 8, `${id}: band cap respected`);
}
const br = await flowNode('proto:hyperliquid-bridge', 'd7', 8);
assert.equal(br.left[0].id, 'chain:Arbitrum'); assert.equal(br.right[0].id, 'hl');
assert.equal(br.left[0].method, 'measured');
const hl = await flowNode('hl', 'd7', 8);
assert.equal(hl.right[0].label, 'BTC', 'highest-volume market first');
const reg = await flowNode('regions', 'd7', 8);
assert.ok([...reg.left, ...reg.right].every((x) => x.label.endsWith('hours')), 'regions bands are sessions only');
server.close?.();
console.log('flow tests passed');
