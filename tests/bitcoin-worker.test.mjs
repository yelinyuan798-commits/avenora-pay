import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, decimalAtomic } from '../server/core.mjs';
import { createWorker } from '../server/worker.mjs';

function fixture() {
  const store = new Store({
    registry: [{ id: 'bitcoin', name: 'Bitcoin', family: 'bitcoin', confirmations: 6,
      tokens: [{ id: 'bitcoin-btc', symbol: 'BTC', kind: 'native', native: true, priceAsset: 'BTC', decimals: 8 }] }],
    config: { bitcoin: { enabled: true, rpcUrl: 'http://127.0.0.1:8332', startBlock: 0,
      tokens: [{ id: 'bitcoin-btc', native: true, decimals: 8 }] } },
  });
  const merchant = store.register({ email: 'btc-worker@example.test', password: 'safe-password-123' }, 'demo');
  const project = store.createProject(merchant, { name: 'Bitcoin checkout' });
  store.addAddress(merchant, { project_id: project.id, chain: 'bitcoin', address: 'demo:bitcoin' });
  const order = store.createOrder(merchant, { project_id: project.id, fiat_currency: 'USD', fiat_amount: '12', chain: 'bitcoin', token_id: 'bitcoin-btc' });
  store.run("UPDATE merchants SET mode='live'");
  store.run("UPDATE addresses SET mode='live'");
  store.run("UPDATE orders SET mode='live'");
  store.run('INSERT INTO cursors VALUES(?,?,?,?,?)', 'bitcoin', '100', '100', new Date().toISOString(), null);
  return { store, merchant, order };
}

test('Bitcoin unconfirmed block times cannot advance the expiry watermark', async () => {
  const { store } = fixture();
  try {
    const older = new Date(Date.now() - 3600_000).toISOString();
    const newer = new Date().toISOString();
    const worker = createWorker({ store, scanChain: async (args) => ({
      transactions: [], cursor: args.toBlock ?? 106, head: 106,
      blocks: args.toBlock === undefined
        ? [{ height: 101, hash: 'confirmed101', time: older }, { height: 106, hash: 'tip106', time: newer }]
        : [],
    }) });
    await worker.scan();
    assert.equal(store.get('SELECT block_time FROM scanner_watermarks WHERE chain=?', 'bitcoin').block_time, older);
    assert.equal(store.get('SELECT cursor FROM cursors WHERE chain=?', 'bitcoin').cursor, '106');
  } finally { store.close(); }
});

test('Bitcoin reorg sweep discovers a replacement output in a formerly empty block', async () => {
  const { store, merchant, order } = fixture();
  try {
    const calls = [];
    const time = new Date().toISOString();
    const worker = createWorker({ store, scanChain: async (args) => {
      calls.push(args);
      const recheck = args.toBlock !== undefined;
      return {
        cursor: recheck ? 100 : 105, head: 105,
        blocks: recheck ? [{ height: 100, hash: 'replacement100', time }] : [],
        transactions: recheck ? [{ chain: 'bitcoin', token_id: 'bitcoin-btc', tx_hash: 'b'.repeat(64), event_index: 1,
          to_address: order.pay_address, from_address: '', amount_atomic: decimalAtomic(order.payable_amount, 8).toString(),
          block_height: 100, block_hash: 'replacement100', block_time: time, confirmations: 6, confirmed: true, removed: false }] : [],
      };
    } });
    await worker.scan();
    assert.equal(calls[0].fromBlock, 101);
    assert.ok(calls[1].fromBlock <= 100);
    assert.equal(calls[1].toBlock, 100);
    assert.equal(store.ownedOrder(merchant, order.order_id).status, 'paid');
    assert.equal(store.get('SELECT cursor FROM cursors WHERE chain=?', 'bitcoin').cursor, '105');
    assert.equal(store.get('SELECT count(*) AS n FROM transfers').n, 1);
    await worker.scan();
    assert.equal(store.get('SELECT count(*) AS n FROM transfers').n, 1);
  } finally { store.close(); }
});
