import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Store, AppError, decimalAtomic, formatAtomic } from '../server/core.mjs';
import { registerExtensions } from '../server/extensions.mjs';

const registry = [{ id: 'bsc', name: 'BSC', confirmations: 15, tokens: [{ id: 'bsc-usdt', symbol: 'USDT', decimals: 18 }] }];

async function environment(t) {
  const store = new Store({ registry });
  const a = store.register({ email: 'a@example.test', name: 'A', password: 'test-password-a' }, 'demo');
  const b = store.register({ email: 'b@example.test', name: 'B', password: 'test-password-b' }, 'demo');
  const pa = store.createProject(a, { name: 'A project' }), pb = store.createProject(b, { name: 'B project' });
  store.addAddress(a, { project_id: pa.id, chain: 'bsc', address: 'demo:a:bsc' });
  store.addAddress(b, { project_id: pb.id, chain: 'bsc', address: 'demo:b:bsc' });
  const app = express();
  app.use(express.json());
  // Test-only identity injection. Production registerExtensions requires the existing server session middleware.
  app.use((req, res, next) => { req.merchant = req.headers['x-test-merchant'] === a.id ? a : req.headers['x-test-merchant'] === b.id ? b : null; next(); });
  registerExtensions(app, { store });
  app.use((error, req, res, next) => res.status(error instanceof AppError ? error.status : 500).json({ error: { code: error.code || 'INTERNAL_ERROR', message: error.message } }));
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => { server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function req(path, { merchant, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(merchant ? { 'x-test-merchant': merchant.id } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  async function link(overrides = {}) {
    const result = await req('/api/payment-links', { merchant: a, body: { project_id: pa.id, name: 'Test link', title: 'Support the project', description: 'A payment link', amount_mode: 'fixed', amount: '9.90', currency: 'USD', ...overrides } });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  return { store, a, b, pa, pb, req, link };
}

test('payment-link merchant endpoints enforce identity and project ownership', async t => {
  const e = await environment(t);
  assert.equal((await e.req('/api/payment-links')).status, 401);
  assert.equal((await e.req('/api/payment-links', { merchant: e.b, body: { project_id: e.pa.id, name: 'Wrong tenant' } })).status, 404);
  const link = await e.link();
  assert.equal((await e.req(`/api/payment-links/${link.id}`, { merchant: e.b, method: 'PATCH', body: { enabled: false } })).status, 404);
  assert.deepEqual((await e.req('/api/payment-links', { merchant: e.b })).body.links, []);
  assert.equal((await e.req(`/api/payment-links/${link.id}`, { merchant: e.a, method: 'PATCH', body: { project_id: e.pb.id } })).body.error.code, 'PROJECT_LOCKED');
});

test('fixed payment links reject price/project tampering and replay only one checkout', async t => {
  const e = await environment(t), link = await e.link();
  const state = await e.req(`/pay/${link.id}/state`);
  assert.equal(state.body.amount, '9.90');
  assert.equal(state.body.merchant_id, undefined);
  assert.equal(state.body.project_id, undefined);
  const body = { amount: '0.01', fiat_amount: '0.01', currency: 'CNY', project_id: e.pb.id, merchant_id: e.b.id, idempotency_key: 'payment-request-00001' };
  const first = await e.req(`/pay/${link.id}/orders`, { body });
  const duplicate = await e.req(`/pay/${link.id}/orders`, { body: { ...body, amount: '100' } });
  assert.equal(first.status, 201);
  assert.deepEqual(duplicate.body, first.body);
  const order = e.store.get('SELECT * FROM orders WHERE order_id=?', first.body.order_id);
  assert.equal(order.fiat_amount, '9.90'); assert.equal(order.fiat_currency, 'USD'); assert.equal(order.project_id, e.pa.id); assert.equal(order.merchant_id, e.a.id);
  assert.equal(e.store.get('SELECT COUNT(*) AS n FROM orders').n, 1);
  const before = (await e.req('/api/payment-links', { merchant: e.a })).body.links[0];
  assert.equal(before.order_count, 1); assert.equal(before.paid_count, 0);
  e.store.transaction(() => e.store.selectMethod(order, 'bsc', 'bsc-usdt'));
  e.store.simulate(e.a, order.order_id);
  const after = (await e.req('/api/payment-links', { merchant: e.a })).body.links[0];
  assert.equal(after.paid_count, 1);
  assert.equal((await e.req(`/pay/${link.id}/orders`, { body })).body.order_id, order.order_id);
});

test('custom payment links validate exact amounts, idempotency conflicts and disabled state', async t => {
  const e = await environment(t), link = await e.link({ amount_mode: 'custom', amount: null });
  for (const amount of ['0', '-1', '1e3', '0.001', '100000000.01', 10]) {
    const response = await e.req(`/pay/${link.id}/orders`, { body: { amount } });
    assert.equal(response.status, 400, String(amount));
  }
  const valid = await e.req(`/pay/${link.id}/orders`, { body: { amount: '12.34', idempotency_key: 'custom-request-00001' } });
  assert.equal(valid.body.fiat_amount, '12.34');
  const changed = await e.req(`/pay/${link.id}/orders`, { body: { amount: '12.35', idempotency_key: 'custom-request-00001' } });
  assert.equal(changed.status, 409);
  assert.equal((await e.req(`/api/payment-links/${link.id}`, { merchant: e.a, method: 'PATCH', body: { enabled: false } })).status, 200);
  assert.equal((await e.req(`/pay/${link.id}/state`)).status, 404);
  assert.equal((await e.req(`/pay/${link.id}/orders`, { body: { amount: '12.34' } })).status, 404);
});

function paidProductOrder(e) {
  const product = e.store.createProduct(e.a, { project_id: e.pa.id, name: 'License', price: '9.90' });
  e.store.importInventory(e.a, product.id, ['LICENSE-ONE', 'LICENSE-TWO']);
  const order = e.store.createOrder(e.a, { project_id: e.pa.id, product_id: product.id, chain: 'bsc', token_id: 'bsc-usdt' });
  e.store.simulate(e.a, order.order_id);
  return e.store.get('SELECT * FROM orders WHERE order_id=?', order.order_id);
}

test('refund records preserve paid state and delivered inventory, deduplicate and emit one event per change', async t => {
  const e = await environment(t), order = paidProductOrder(e);
  const payload = { order_id: order.order_id, amount: '5', tx_hash: '0xrefundtransaction001', note: 'External refund; awaiting reconciliation' };
  const first = await e.req('/api/refunds', { merchant: e.a, body: payload });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.verification_status, 'unverified');
  assert.equal(first.body.status, 'recorded');
  const duplicate = await e.req('/api/refunds', { merchant: e.a, body: payload });
  assert.equal(duplicate.body.id, first.body.id);
  assert.equal(e.store.get("SELECT COUNT(*) AS n FROM deliveries WHERE event_type='refund.recorded'").n, 1);
  assert.equal((await e.req('/api/refunds', { merchant: e.a, body: { ...payload, amount: '4' } })).status, 409);
  assert.equal((await e.req('/api/refunds', { merchant: e.b, body: payload })).status, 404);
  assert.equal((await e.req(`/api/refunds/${first.body.id}/void`, { merchant: e.b, body: {} })).status, 404);
  const voided = await e.req(`/api/refunds/${first.body.id}/void`, { merchant: e.a, body: {} });
  assert.equal(voided.body.status, 'voided');
  await e.req(`/api/refunds/${first.body.id}/void`, { merchant: e.a, body: {} });
  assert.equal(e.store.get("SELECT COUNT(*) AS n FROM deliveries WHERE event_type='refund.recorded'").n, 2);
  const events = e.store.all("SELECT payload FROM deliveries WHERE event_type='refund.recorded' ORDER BY created_at").map(row => JSON.parse(row.payload));
  assert.deepEqual(events.map(event => event.data.status), ['recorded', 'voided']);
  const final = e.store.get('SELECT * FROM orders WHERE order_id=?', order.order_id);
  assert.equal(final.status, 'paid'); assert.equal(final.delivery, order.delivery);
  assert.equal(e.store.get('SELECT COUNT(*) AS n FROM inventory WHERE order_id=?', order.order_id).n, 1);
  assert.equal(e.store.get("SELECT COUNT(*) AS n FROM deliveries WHERE event_type='order.paid'").n, 1);
  assert.deepEqual((await e.req('/api/refunds', { merchant: e.b })).body.refunds, []);
});

test('refund cumulative cap uses token integer precision and ignores voided records', async t => {
  const e = await environment(t), order = paidProductOrder(e);
  const one = await e.req('/api/refunds', { merchant: e.a, body: { order_id: order.order_id, amount: '5', tx_hash: 'refund-transaction-a' } });
  const remaining = BigInt(order.payable_atomic) - decimalAtomic('5', 18);
  assert.equal((await e.req('/api/refunds', { merchant: e.a, body: { order_id: order.order_id, amount: formatAtomic(remaining + 1n, 18), tx_hash: 'refund-transaction-b' } })).body.error.code, 'REFUND_EXCEEDS_PAYMENT');
  assert.equal((await e.req('/api/refunds', { merchant: e.a, body: { order_id: order.order_id, amount: formatAtomic(remaining, 18), tx_hash: 'refund-transaction-c' } })).status, 201);
  await e.req(`/api/refunds/${one.body.id}/void`, { merchant: e.a, body: {} });
  assert.equal((await e.req('/api/refunds', { merchant: e.a, body: { order_id: order.order_id, amount: '5', tx_hash: 'refund-transaction-d' } })).status, 201);
  assert.equal((await e.req('/api/refunds', { merchant: e.a, body: { order_id: order.order_id, amount: '0.000000000000000001', tx_hash: 'refund-transaction-e' } })).status, 409);
  const pending = e.store.createOrder(e.a, { project_id: e.pa.id, fiat_amount: '1', chain: 'bsc', token_id: 'bsc-usdt' });
  assert.equal((await e.req('/api/refunds', { merchant: e.a, body: { order_id: pending.order_id, amount: '1', tx_hash: 'refund-pending-test' } })).body.error.code, 'ORDER_NOT_PAID');
});

test('refund records cannot include a waived fingerprint or assume a missing receipt', async t => {
  const e = await environment(t);
  e.store.config.payments = { allowFingerprintUnderpayment: true };
  const order = e.store.createOrder(e.a, { project_id:e.pa.id, fiat_amount:'1.00', fiat_currency:'USD', chain:'bsc', token_id:'bsc-usdt' });
  const paid = e.store.ingest({chain:'bsc',token_id:'bsc-usdt',to_address:order.pay_address,from_address:'demo:payer',
    tx_hash:'demo-refund-tolerance',event_index:0,amount_atomic:decimalAtomic('1',18).toString(),
    block_height:100,block_hash:'demo-block',block_time:new Date(Date.now()+2000).toISOString(),
    confirmations:15,confirmed:true,removed:false},{mode:'demo'}).order;
  assert.equal(paid.received_amount,'1.0');
  assert.notEqual(paid.payable_amount,paid.received_amount);
  const refund = (amount, suffix) => e.req('/api/refunds',{merchant:e.a,body:{order_id:order.order_id,amount,tx_hash:'refund-tolerance-'+suffix}});
  assert.equal((await refund(order.payable_amount,'over-single')).status,400);
  assert.equal((await refund('0.6','first')).status,201);
  assert.equal((await refund('0.400000000000000001','over-total')).body.error.code,'REFUND_EXCEEDS_PAYMENT');
  assert.equal((await refund('0.4','remaining')).status,201);
  e.store.run('UPDATE orders SET transfer_id=NULL WHERE order_id=?',order.order_id);
  assert.equal((await refund('0.1','missing')).body.error.code,'PAYMENT_RECEIPT_MISSING');
});
