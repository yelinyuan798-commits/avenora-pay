import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core.mjs';
import { createApp } from '../server/app.mjs';
import { registry, configuredTokens, normalizeAddress, validateAddress } from '../server/chains.mjs';

async function environment(t) {
  const store = new Store({ registry, configuredTokens, normalizeAddress, validateAddress });
  const app = createApp({ store, mode: 'demo' });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); store.close(); });
  let cookie;
  async function req(path, body, { publicRequest = false } = {}) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...(!publicRequest && cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0];
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
  await req('/api/auth/demo', {});
  return { store, req };
}

test('all seven major assets complete isolated public checkout and exactly-once delivery', async t => {
  const { store, req } = await environment(t);
  const product = (await req('/api/products')).products[0];
  const methods = [
    ['tron', 'tron-usdt', 'USDT'], ['ethereum', 'ethereum-usdc', 'USDC'],
    ['bitcoin', 'bitcoin-btc', 'BTC'], ['ethereum', 'ethereum-eth', 'ETH'],
    ['bsc', 'bsc-bnb', 'BNB'], ['solana', 'solana-sol', 'SOL'], ['tron', 'tron-trx', 'TRX'],
  ];
  const delivered = new Set();
  for (const [chain, token_id, symbol] of methods) {
    const created = await req('/api/orders', { project_id: product.project_id, product_id: product.id });
    const path = `/checkout/${created.checkout_token}`;
    const available = await req(path + '/methods', undefined, { publicRequest: true });
    assert.ok(available.methods.some(method => method.chain === chain && method.token_id === token_id), symbol);
    const selected = await req(path + '/select', { chain, token_id }, { publicRequest: true });
    assert.equal(selected.status, 'pending');
    assert.match(selected.payable_amount, /^\d+\.\d+$/);
    assert.equal(typeof selected.payable_amount, 'string');
    assert.equal(selected.delivery, null);
    assert.equal(selected.checkout_token, undefined);
    const confirmed = await req(`/api/orders/${created.order_id}/simulate`, {});
    assert.equal(confirmed.status, 'paid', symbol);
    const firstDelivery = (await req(path + '/state', undefined, { publicRequest: true })).delivery;
    assert.match(firstDelivery, /DEMO-LICENSE/);
    assert.ok(!delivered.has(firstDelivery));
    delivered.add(firstDelivery);
    await req(`/api/orders/${created.order_id}/simulate`, {});
    assert.equal((await req(path + '/state', undefined, { publicRequest: true })).delivery, firstDelivery);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM transfers WHERE tx_hash=?', confirmed.tx_hash).n, 1);
  }
  assert.equal(delivered.size, 7);
});

test('Bitcoin subscription requires all confirmations and cannot activate twice', async t => {
  const { req, store } = await environment(t);
  const checkout = await req('/api/billing/checkout', { plan_id: 'starter', idempotency_key: 'bitcoin-subscription-demo-1' });
  const invoice = checkout.invoice;
  const order = store.get('SELECT checkout_token FROM orders WHERE order_id=?', invoice.order_id);
  await req(`/checkout/${order.checkout_token}/select`, { chain: 'bitcoin', token_id: 'bitcoin-btc' });
  const first = await req(`/api/orders/${invoice.order_id}/simulate`, { confirmations: 1 });
  assert.equal(first.status, 'confirming');
  assert.equal((await req('/api/subscription')).subscription.status, 'free');
  const paid = await req(`/api/orders/${invoice.order_id}/simulate`, { confirmations: 6 });
  assert.equal(paid.status, 'paid');
  const subscription = (await req('/api/subscription')).subscription;
  assert.equal(subscription.effective_plan_id, 'starter');
  await req(`/api/orders/${invoice.order_id}/simulate`, { confirmations: 6 });
  assert.equal((await req('/api/subscription')).subscription.expires_at, subscription.expires_at);
  const invoices = (await req('/api/billing')).invoices;
  assert.equal(invoices.find(item => item.id === invoice.id).status, 'paid');
});
