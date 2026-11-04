import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, hash } from '../server/core.mjs';
import { ceilDivide, USD_SCALE, fixed } from '../server/pricing.mjs';
import { createWorker } from '../server/worker.mjs';
import { initializeBilling } from '../server/billing.mjs';

const Q = 1000000000000n;
const tokens = [
  { id: 'bsc-bnb', symbol: 'BNB', kind: 'native', decimals: 18 },
  { id: 'bsc-usdt', symbol: 'USDT', kind: 'token', decimals: 18 },
];
function fixture() {
  const config = { payments: { allowLegacyBnbRounding: true, automaticRecovery: true },
    pricing: { stablePolicy: 'parity' }, bsc: { enabled: true, startBlock: 0,
      tokens, rpcUrl: 'https://fixture.invalid' } };
  const store = new Store({ config, registry: [{ id: 'bsc', family: 'evm', confirmations: 15, tokens }],
    configuredTokens: (_chain, cfg) => cfg.tokens });
  store.priceBook.recordAsset('BNB', '715.62');
  const merchant = store.register({ email: 'bnb-rounding@example.test', password: 'fixture-password-123' }, 'live');
  const project = store.createProject(merchant, { name: 'BNB precision' });
  store.addAddress(merchant, { project_id: project.id, chain: 'bsc', address: '0x' + '1'.repeat(40) });
  const product = store.createProduct(merchant, { project_id: project.id, name: 'Test item', price: '1.00' });
  store.importInventory(merchant, product.id, ['FIRST', 'SECOND', 'THIRD']);
  const f = { store, merchant, project, product };
  f.order = legacyOrder(f);
  initializeBilling(store);
  f.transfer = { chain: 'bsc', token_id: 'bsc-bnb', to_address: f.order.pay_address,
    from_address: '0x' + '2'.repeat(40), tx_hash: 'legacy-rounded-bnb', event_index: -1,
    amount_atomic: '1397530000000000', block_height: 100, block_hash: 'canonical100',
    block_time: new Date().toISOString(), confirmations: 50, confirmed: true, removed: false };
  return f;
}
function newOrder(f) {
  return f.store.createOrder(f.merchant, { project_id: f.project.id, product_id: f.product.id,
    chain: 'bsc', token_id: 'bsc-bnb', allowed_methods: tokens.map(t => ({ chain: 'bsc', token_id: t.id })) });
}
function legacyOrder(f, amount = 1397529415052683n) {
  const view = newOrder(f), raw = f.store.ownedOrder(f.merchant, view.order_id);
  const q = f.store.orderQuote(raw), s = JSON.parse(q.pricing_json);
  // 升级前真实报价的不可变快照格式，使用整数重建，不依赖新版报价精度。
  const pn = BigInt(s.price_numerator), pd = BigInt(s.price_denominator);
  s.base_payable_atomic = ceilDivide(USD_SCALE * pd, pn).toString();
  s.usd_atomic = ceilDivide(amount * pn, pd).toString();
  s.usd_value = fixed(s.usd_atomic);
  s.fingerprint_usd = fixed(BigInt(s.usd_atomic) - USD_SCALE);
  delete s.payment_decimals; delete s.rounding_quantum_atomic;
  const created = new Date(Date.now() - 5000).toISOString();
  f.store.run('UPDATE amount_reservations SET payable_atomic=?,pricing_json=?,created_at=? WHERE order_id=?',
    amount.toString(), JSON.stringify(s), created, raw.order_id);
  f.store.run('UPDATE orders SET payable_atomic=?,payable_amount=?,payment_started_at=? WHERE order_id=?',
    amount.toString(), fixed(amount), created, raw.order_id);
  return f.store.orderView(f.store.ownedOrder(f.merchant, raw.order_id));
}
const raw = f => f.store.ownedOrder(f.merchant, f.order.order_id);
const id = tx => hash([tx.chain, tx.tx_hash, tx.event_index].join(':'));
const settle = f => f.store.ingest(f.transfer, { mode: 'live' });
const count = f => f.store.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n;
function response(args, txs = []) {
  return { transactions: txs, cursor: args.toBlock ?? Math.max(200, args.fromBlock), head: 250,
    blocks: txs.map(tx => ({ height: tx.block_height, hash: tx.block_hash, time: tx.block_time })) };
}

test('legacy BNB ceil8 payment settles once, preserves original quote and records actual receipt', () => {
  const f = fixture();
  try {
    const before = raw(f), quote = f.store.orderQuote(before);
    assert.equal(settle(f).matched, true);
    assert.equal(raw(f).status, 'paid'); assert.equal(raw(f).paid_source, 'chain');
    assert.equal(raw(f).payable_atomic, before.payable_atomic);
    assert.deepEqual(f.store.orderQuote(raw(f)), quote);
    assert.equal(f.store.orderView(raw(f)).received_amount, '0.00139753');
    assert.equal(f.store.orderView(raw(f)).delivery, 'FIRST');
    assert.equal(f.store.get('SELECT order_id FROM transfers WHERE id=?', id(f.transfer)).order_id, f.order.order_id);
    settle(f); assert.equal(count(f), 1);
    const usage = f.store.get('SELECT * FROM billing_paid_usage WHERE order_id=?', f.order.order_id);
    assert.equal(usage.usd_atomic, ceilDivide(BigInt(f.transfer.amount_atomic) * 71562n, 100n).toString());
    assert.equal(usage.source, 'settlement');
    const paidEvent = JSON.parse(f.store.get("SELECT payload FROM deliveries WHERE event_type='order.paid'").payload);
    assert.equal(paidEvent.data.received_amount, '0.00139753');
    assert.equal(paidEvent.data.waived_fingerprint_amount, undefined);
    assert.equal(f.store.get('SELECT COUNT(*) n FROM billing_paid_usage').n, 1);
    assert.equal(f.store.get("SELECT COUNT(*) n FROM deliveries WHERE event_type='order.paid'").n, 1);
    const duplicate = { ...f.transfer, tx_hash: 'different-payment' };
    assert.equal(f.store.ingest(duplicate, { mode: 'live' }).matched, false);
    assert.equal(f.store.get('SELECT reason FROM transfers WHERE id=?', id(duplicate)).reason, 'duplicate_payment');
    assert.equal(count(f), 1);
  } finally { f.store.close(); }
});

test('legacy BNB recovery needs explicit opt-in and fresh canonical RPC before expired auto delivery', async () => {
  const f = fixture();
  try {
    f.store.config.payments.allowLegacyBnbRounding = false;
    assert.equal(settle(f).matched, false);
    f.store.run("UPDATE orders SET status='expired' WHERE order_id=?", f.order.order_id);
    f.store.run('INSERT INTO cursors VALUES(?,?,?,?,?)', 'bsc', '200', '250', new Date().toISOString(), null);
    let available = false, reads = 0;
    const worker = createWorker({ store: f.store, scanChain: async args => {
      if (args.fromBlock === 100 && args.toBlock === 100) {
        reads++; if (!available) throw Error('archive unavailable');
        return response(args, [f.transfer]);
      }
      return response(args);
    } });
    await worker.scan(); assert.equal(reads, 0);
    f.store.config.payments.allowLegacyBnbRounding = true;
    await worker.scan(); assert.equal(reads, 1); assert.equal(raw(f).status, 'expired'); assert.equal(count(f), 0);
    assert.equal(f.store.get('SELECT attempts FROM recovery_jobs').attempts, 1);
    available = true; f.store.run('UPDATE recovery_jobs SET next_attempt=0');
    await worker.scan(); assert.equal(raw(f).status, 'paid'); assert.equal(count(f), 1);
    assert.equal(f.store.get("SELECT COUNT(*) n FROM audit WHERE action='auto_reconcile'").n, 1);
    await worker.scan(); assert.equal(reads, 2); assert.equal(count(f), 1);
    assert.equal(f.store.get('SELECT COUNT(*) n FROM recovery_jobs').n, 0);
  } finally { f.store.close(); }
});

test('exact and rounded BNB candidates compete, including historical terminal or superseded quotes', () => {
  for (const scenario of ['same_alias', 'exact_alias', 'paid', 'canceled', 'expired', 'superseded']) {
    const f = fixture();
    try {
      const other = legacyOrder(f, scenario === 'exact_alias' ? 1397530000000000n : 1397529415052684n);
      if (['paid', 'canceled', 'expired'].includes(scenario)) f.store.run('UPDATE orders SET status=? WHERE order_id=?', scenario, other.order_id);
      if (scenario === 'expired') f.store.run('UPDATE amount_reservations SET expires_at=? WHERE order_id=?', new Date(Date.parse(f.transfer.block_time) - 1).toISOString(), other.order_id);
      if (scenario === 'superseded') f.store.selectMethod(f.store.ownedOrder(f.merchant, other.order_id), 'bsc', 'bsc-usdt');
      assert.equal(settle(f).matched, false, scenario);
      assert.equal(f.store.get('SELECT reason FROM transfers WHERE id=?', id(f.transfer)).reason, 'ambiguous_amount', scenario);
      assert.equal(count(f), 0);
    } finally { f.store.close(); }
  }
});

test('legacy compatibility rejects underpayment, arbitrary overpayment, invalid snapshots and wrong windows', () => {
  for (const scenario of ['floor', 'over', 'near', 'disabled', 'new_metadata', 'bad_price', 'bad_base', 'bad_budget',
    'before_quote', 'same_second_before', 'after_quote', 'after_order', 'canceled', 'superseded', 'removed']) {
    const f = fixture();
    try {
      if (scenario === 'floor') f.transfer.amount_atomic = '1397520000000000';
      if (scenario === 'over') f.transfer.amount_atomic = '1397540000000000';
      if (scenario === 'near') f.transfer.amount_atomic = '1397529415052684';
      if (scenario === 'disabled') f.store.config.payments.allowLegacyBnbRounding = false;
      if (['new_metadata', 'bad_price', 'bad_base', 'bad_budget'].includes(scenario)) {
        const s = JSON.parse(f.store.orderQuote(raw(f)).pricing_json);
        if (scenario === 'new_metadata') s.payment_decimals = 8;
        if (scenario === 'bad_price') s.price_source = 'untrusted';
        if (scenario === 'bad_base') s.base_payable_atomic = '1';
        if (scenario === 'bad_budget') s.fingerprint_limit_usd = '0.000000000001';
        f.store.run('UPDATE amount_reservations SET pricing_json=? WHERE order_id=?', JSON.stringify(s), f.order.order_id);
      }
      if (scenario === 'before_quote') f.transfer.block_time = new Date(Date.now() - 60000).toISOString();
      if (scenario === 'same_second_before') {
        const start = Math.floor(Date.now() / 1000) * 1000;
        f.transfer.block_time = new Date(start).toISOString();
        f.store.run('UPDATE amount_reservations SET created_at=? WHERE order_id=?', new Date(start + 1).toISOString(), f.order.order_id);
      }
      if (scenario === 'after_quote') f.store.run('UPDATE amount_reservations SET expires_at=? WHERE order_id=?', new Date(Date.parse(f.transfer.block_time) - 1).toISOString(), f.order.order_id);
      if (scenario === 'after_order') f.store.run('UPDATE orders SET expires_at=? WHERE order_id=?', new Date(Date.parse(f.transfer.block_time) - 1).toISOString(), f.order.order_id);
      if (scenario === 'canceled') f.store.run("UPDATE orders SET status='canceled' WHERE order_id=?", f.order.order_id);
      if (scenario === 'superseded') f.store.selectMethod(raw(f), 'bsc', 'bsc-usdt');
      if (scenario === 'removed') f.transfer.removed = true;
      assert.equal(settle(f).matched, false, scenario); assert.equal(count(f), 0, scenario);
    } finally { f.store.close(); }
  }
});

test('new BNB allocation permanently skips legacy rounded aliases even with compatibility disabled', () => {
  const f = fixture();
  try {
    // 让旧报价的八位向上取整别名，恰好占据新版分配的第一个候选值。
    const priced = f.store.amountFor(f.merchant, '1.00', 'USD', 'bsc', 'bsc-bnb');
    const first = priced.amount + priced.step;
    const q = f.store.orderQuote(raw(f)), s = JSON.parse(q.pricing_json), exact = first - 1n;
    s.usd_atomic = ceilDivide(exact * BigInt(s.price_numerator), BigInt(s.price_denominator)).toString();
    f.store.run('UPDATE amount_reservations SET payable_atomic=?,pricing_json=? WHERE order_id=?', exact.toString(), JSON.stringify(s), f.order.order_id);
    f.store.run("UPDATE orders SET payable_atomic=?,status='canceled' WHERE order_id=?", exact.toString(), f.order.order_id);
    f.store.config.payments.allowLegacyBnbRounding = false;
    const fresh = newOrder(f), value = BigInt(f.store.ownedOrder(f.merchant, fresh.order_id).payable_atomic);
    assert.ok(value > first); assert.equal(value % Q, 0n);
    assert.ok(fresh.payable_amount.split('.')[1].length <= 6);
  } finally { f.store.close(); }
});

test('BNB chain reorg preserves binding and never duplicates delivered stock', () => {
  const f = fixture();
  try {
    f.transfer.confirmed = false; f.transfer.confirmations = 1;
    settle(f); assert.equal(raw(f).status, 'confirming');
    f.transfer.removed = true; settle(f); assert.equal(raw(f).status, 'pending');
    assert.equal(f.store.get('SELECT order_id FROM transfers WHERE id=?', id(f.transfer)).order_id, f.order.order_id);
    f.transfer.removed = false; f.transfer.confirmed = true; f.transfer.confirmations = 20;
    settle(f); assert.equal(raw(f).status, 'paid'); assert.equal(count(f), 1);
    f.transfer.removed = true; settle(f);
    assert.equal(f.store.get('SELECT reason FROM transfers WHERE id=?', id(f.transfer)).reason, 'reorg_after_payment');
    assert.equal(count(f), 1);
  } finally { f.store.close(); }
});

test('new exact BNB quote recovers an on-time late-scanned payment without legacy rounding opt-in', async () => {
  const f = fixture();
  try {
    f.store.config.payments.allowLegacyBnbRounding = false;
    const view = newOrder(f), o = f.store.ownedOrder(f.merchant, view.order_id);
    const tx = { ...f.transfer, tx_hash: 'new-precision-bnb', amount_atomic: o.payable_atomic,
      block_time: new Date().toISOString() };
    f.store.run("UPDATE orders SET status='expired' WHERE order_id=?", o.order_id);
    // 模拟旧版本记录为过期未认单；新 worker 只能通过再次读取链上区块完成恢复。
    f.store.run(`INSERT INTO transfers(id,merchant_id,project_id,chain,token_id,tx_hash,event_index,to_address,
      amount_atomic,block_height,block_hash,block_time,confirmations,confirmed,removed,mode,reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id(tx), o.merchant_id, o.project_id, tx.chain, tx.token_id,
      tx.tx_hash, tx.event_index, tx.to_address, tx.amount_atomic, tx.block_height, tx.block_hash,
      tx.block_time, tx.confirmations, 1, 0, 'live', 'expired_order_requires_review');
    f.store.run('INSERT INTO cursors VALUES(?,?,?,?,?)', 'bsc', '200', '250', new Date().toISOString(), null);
    let reads = 0;
    const worker = createWorker({ store: f.store, scanChain: async args => {
      const old = args.fromBlock === 100 && args.toBlock === 100;
      if (old) reads++;
      return response(args, old ? [tx] : []);
    } });
    await worker.scan();
    assert.equal(reads, 1);
    assert.equal(f.store.ownedOrder(f.merchant, o.order_id).status, 'paid');
    assert.equal(raw(f).status, 'pending');
    assert.equal(count(f), 1);
    assert.equal(f.store.get('SELECT COUNT(*) n FROM recovery_jobs').n, 0);
  } finally { f.store.close(); }
});

test('BNB recovery never schedules ambiguous, wrong-scope, invalid, terminal or already-bound records', async () => {
  for (const scenario of ['canceled', 'paid', 'ambiguous_amount', 'duplicate_payment', 'removed', 'reference',
    'wrong_merchant', 'wrong_project', 'bound_elsewhere', 'other_transfer', 'automatic_off', 'after_order']) {
    const f = fixture();
    try {
      f.store.config.payments.allowLegacyBnbRounding = false; settle(f);
      f.store.config.payments.allowLegacyBnbRounding = true;
      if (['canceled', 'paid'].includes(scenario)) f.store.run('UPDATE orders SET status=? WHERE order_id=?', scenario, f.order.order_id);
      if (['ambiguous_amount', 'duplicate_payment'].includes(scenario)) f.store.run('UPDATE transfers SET reason=?', scenario);
      if (scenario === 'removed') f.store.run('UPDATE transfers SET removed=1');
      if (scenario === 'reference') f.store.run("UPDATE transfers SET payment_reference='invalid',payment_reference_invalid=1");
      if (scenario === 'wrong_merchant') f.store.run("UPDATE transfers SET merchant_id='other'");
      if (scenario === 'wrong_project') f.store.run("UPDATE transfers SET project_id='other'");
      if (scenario === 'bound_elsewhere') f.store.run("UPDATE transfers SET order_id='other'");
      if (scenario === 'other_transfer') f.store.run("UPDATE orders SET transfer_id='other' WHERE order_id=?", f.order.order_id);
      if (scenario === 'automatic_off') f.store.config.payments.automaticRecovery = false;
      if (scenario === 'after_order') f.store.run('UPDATE orders SET expires_at=? WHERE order_id=?', new Date(Date.parse(f.transfer.block_time) - 1).toISOString(), f.order.order_id);
      f.store.run('INSERT INTO cursors VALUES(?,?,?,?,?)', 'bsc', '200', '250', new Date().toISOString(), null);
      let reads = 0;
      const worker = createWorker({ store: f.store, scanChain: async args => {
        if (args.fromBlock === 100 && args.toBlock === 100) reads++;
        return response(args);
      } });
      await worker.scan(); assert.equal(reads, 0, scenario);
      assert.equal(f.store.get('SELECT COUNT(*) n FROM recovery_jobs').n, 0, scenario);
      assert.equal(count(f), 0, scenario);
    } finally { f.store.close(); }
  }
});

function enableBnbConflict(f) {
  Object.assign(f.store.config.payments, { amountAllocation: 'conflict_only',
    conflictTokens: ['bsc-usdt', 'bsc-bnb'], conflictStep: '0.0000001',
    conflictSteps: { 'bsc-bnb': '0.000001' } });
}

test('BNB six-decimal conflict allocation starts at base, increments by one unit and preserves USDT step', () => {
  const f = fixture();
  try {
    enableBnbConflict(f);
    const first = newOrder(f), second = newOrder(f);
    assert.equal(first.payable_amount, '0.001398');
    assert.equal(second.payable_amount, '0.001399');
    assert.equal(first.amount_matching.base_amount, '0.001398');
    assert.equal(first.amount_matching.increment, '0.000001');
    const stable = f.store.createOrder(f.merchant, { project_id: f.project.id, fiat_amount: '1.00', fiat_currency: 'USD', chain: 'bsc', token_id: 'bsc-usdt' });
    assert.equal(stable.amount_matching.increment, '0.0000001');
    const tx = { ...f.transfer, tx_hash: 'six-decimal-conflict', amount_atomic: '1398000000000000', block_time: new Date().toISOString() };
    assert.equal(f.store.ingest(tx, { mode: 'live' }).order.order_id, first.order_id);
    assert.equal(f.store.ownedOrder(f.merchant, second.order_id).status, 'pending');
    assert.equal(raw(f).status, 'pending'); assert.equal(count(f), 1);
  } finally { f.store.close(); }
});

test('new BNB conflict amounts may be reused after expiry while legacy aliases stay reserved', () => {
  const f = fixture();
  try {
    enableBnbConflict(f);
    const first = newOrder(f), expired = new Date(Date.now() - 2000).toISOString();
    f.store.run("UPDATE orders SET status='canceled',expires_at=? WHERE order_id=?", expired, first.order_id);
    f.store.run('UPDATE amount_reservations SET expires_at=? WHERE order_id=?', expired, first.order_id);
    const next = newOrder(f);
    assert.equal(next.payable_amount, first.payable_amount);
    const tx = { ...f.transfer, tx_hash: 'reused-six-decimal-conflict', amount_atomic: '1398000000000000', block_time: new Date().toISOString() };
    assert.equal(f.store.ingest(tx, { mode: 'live' }).order.order_id, next.order_id);
    assert.equal(f.store.ownedOrder(f.merchant, first.order_id).status, 'canceled');
  } finally { f.store.close(); }
});

test('BNB conflict allocator blocks old ceil8 alias even if legacy compatibility is off', () => {
  const f = fixture();
  try {
    enableBnbConflict(f);
    const q = f.store.orderQuote(raw(f)), s = JSON.parse(q.pricing_json), exact = 1398000000000000n - 1n;
    s.usd_atomic = ceilDivide(exact * BigInt(s.price_numerator), BigInt(s.price_denominator)).toString();
    f.store.run('UPDATE amount_reservations SET payable_atomic=?,pricing_json=? WHERE order_id=?', exact.toString(), JSON.stringify(s), f.order.order_id);
    f.store.run("UPDATE orders SET payable_atomic=?,status='canceled' WHERE order_id=?", exact.toString(), f.order.order_id);
    f.store.config.payments.allowLegacyBnbRounding = false;
    assert.equal(newOrder(f).payable_amount, '0.001399');
    f.store.config.payments.conflictSteps['bsc-bnb'] = '0.0000001';
    assert.throws(() => newOrder(f), error => error.code === 'INVALID_PAYMENT_CONFIG');
  } finally { f.store.close(); }
});

test('previous eight-decimal quotes remain exact after six-decimal rollout and can recover after expiry', () => {
  const f = fixture();
  try {
    f.store.config.payments.allowLegacyBnbRounding = false;
    const view = newOrder(f), order = f.store.ownedOrder(f.merchant, view.order_id);
    const quote = f.store.orderQuote(order), s = JSON.parse(quote.pricing_json);
    const amount = 1397670000000000n;
    s.payment_decimals = 8; s.rounding_quantum_atomic = '10000000000';
    const precise = ceilDivide(USD_SCALE * BigInt(s.price_denominator), BigInt(s.price_numerator));
    s.base_payable_atomic = (ceilDivide(precise, 10000000000n) * 10000000000n).toString();
    s.usd_atomic = ceilDivide(amount * BigInt(s.price_numerator), BigInt(s.price_denominator)).toString();
    f.store.run('UPDATE amount_reservations SET payable_atomic=?,pricing_json=? WHERE order_id=?', amount.toString(), JSON.stringify(s), order.order_id);
    f.store.run("UPDATE orders SET status='expired',payable_atomic=?,payable_amount=? WHERE order_id=?", amount.toString(), fixed(amount), order.order_id);
    const current = f.store.ownedOrder(f.merchant, order.order_id);
    assert.equal(f.store.bnbQuoteAmount(current), amount);
    assert.equal(f.store.paymentAmountMatches(current, '1398000000000000'), false, 'six-decimal policy never widens an existing eight-decimal quote');
    const tx = { ...f.transfer, tx_hash: 'old-eight-decimal-quote', amount_atomic: amount.toString(), block_time: new Date().toISOString() };
    assert.equal(f.store.ingest(tx, { mode: 'live' }).order.order_id, order.order_id);
    assert.equal(f.store.ownedOrder(f.merchant, order.order_id).status, 'paid');
    assert.equal(count(f), 1);
  } finally { f.store.close(); }
});
