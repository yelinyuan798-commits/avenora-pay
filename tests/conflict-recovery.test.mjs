import test from "node:test";
import assert from "node:assert/strict";
import { Store, decimalAtomic, hash } from "../server/core.mjs";
import { createWorker } from "../server/worker.mjs";

const tokens = [
  { id: "bsc-usdt", kind: "token", symbol: "USDT", decimals: 18 },
  { id: "bsc-usdc", kind: "token", symbol: "USDC", decimals: 18 },
];
function fixture() {
  const registry = [{ id: "bsc", family: "evm", chainId: 56, confirmations: 15, tokens }];
  const config = {
    payments: { amountAllocation: "conflict_only", conflictStep: "0.0000001", automaticRecovery: true },
    pricing: { stablePolicy: "parity" },
    bsc: { enabled: true, startBlock: 0, rpcUrl: "https://fixture.invalid",
      tokens: tokens.map(token => ({ ...token, contract: "0x" + "2".repeat(40) })) },
  };
  const store = new Store({ registry, config, configuredTokens: (_chain, cfg) => cfg.tokens });
  const merchant = store.register({ email: "conflict-recovery@example.test", password: "fixture-password-123" }, "live");
  const project = store.createProject(merchant, { name: "Conflict recovery" });
  store.addAddress(merchant, { project_id: project.id, chain: "bsc", address: "0x" + "1".repeat(40) });
  const product = store.createProduct(merchant, { project_id: project.id, name: "License", price: "1.00" });
  store.importInventory(merchant, product.id, ["FIRST-LICENSE", "SECOND-LICENSE"]);
  const order = store.createOrder(merchant, {
    project_id: project.id, product_id: product.id, fiat_amount: "1.00", fiat_currency: "USD",
    chain: "bsc", token_id: "bsc-usdt",
    allowed_methods: tokens.map(token => ({ chain: "bsc", token_id: token.id })),
  });
  const transfer = {
    chain: "bsc", token_id: "bsc-usdt", to_address: order.pay_address, from_address: "0x" + "3".repeat(40),
    tx_hash: "confirmed-original-quote", event_index: 0, amount_atomic: decimalAtomic(order.payable_amount, 18).toString(),
    block_height: 100, block_hash: "block100", block_time: new Date().toISOString(),
    confirmations: 151, confirmed: true, removed: false,
  };
  return { store, merchant, project, order, transfer };
}
const raw = f => f.store.ownedOrder(f.merchant, f.order.order_id);
const transferId = tx => hash([tx.chain, tx.tx_hash, tx.event_index].join(":"));
function response(args, transactions = []) {
  return { transactions, cursor: args.toBlock ?? Math.max(200, args.fromBlock), head: 250,
    blocks: transactions.map(tx => ({ height: tx.block_height, hash: tx.block_hash, time: tx.block_time })) };
}
function originalPaymentWhileSwitched(f) {
  f.store.selectMethod(raw(f), "bsc", "bsc-usdc");
  assert.equal(f.store.ingest(f.transfer, { mode: "live" }).matched, false);
  assert.equal(f.store.get("SELECT reason FROM transfers").reason, "superseded_payment_method");
  f.store.selectMethod(raw(f), "bsc", "bsc-usdt");
  f.store.run("INSERT INTO cursors VALUES(?,?,?,?,?)", "bsc", "200", "250", new Date().toISOString(), null);
}

test("restoring an original amount quote verifies its old block again and delivers exactly once", async () => {
  const f = fixture();
  try {
    f.store.selectMethod(raw(f), "bsc", "bsc-usdc");
    let archiveAvailable = false, historicalReads = 0;
    const worker = createWorker({ store: f.store, scanChain: async args => {
      if (args.fromBlock === 100 && args.toBlock === 100) {
        historicalReads++;
        if (!archiveAvailable) throw Error("archive unavailable");
        return response(args, [f.transfer]);
      }
      return response(args, args.fromBlock === 0 ? [f.transfer] : []);
    } });
    await worker.scan();
    assert.equal(f.store.get("SELECT reason FROM transfers").reason, "superseded_payment_method");
    assert.equal(f.store.get("SELECT COUNT(*) n FROM recovery_jobs").n, 0);
    const restored = f.store.selectMethod(raw(f), "bsc", "bsc-usdt");
    assert.equal(restored.payable_amount, "1.0");
    await worker.scan();
    assert.equal(raw(f).status, "pending", "stored confirmation alone is not payment proof");
    assert.equal(raw(f).delivery, null);
    assert.equal(f.store.get("SELECT attempts FROM recovery_jobs").attempts, 1);
    archiveAvailable = true;
    f.store.run("UPDATE recovery_jobs SET next_attempt=0");
    await worker.scan();
    assert.equal(raw(f).status, "paid");
    assert.equal(raw(f).paid_source, "chain");
    assert.equal(f.store.orderView(raw(f)).delivery, "FIRST-LICENSE");
    assert.equal(raw(f).transfer_id, transferId(f.transfer));
    assert.equal(f.store.get("SELECT COUNT(*) n FROM recovery_jobs").n, 0);
    await worker.scan();
    assert.equal(historicalReads, 2);
    assert.equal(f.store.get("SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL").n, 1);
    assert.equal(f.store.get("SELECT COUNT(*) n FROM deliveries WHERE event_type='order.paid'").n, 1);
  } finally { f.store.close(); }
});

test("a restored quote can recover an in-window payment after the order expires", async () => {
  const f = fixture();
  try {
    originalPaymentWhileSwitched(f);
    f.store.run("UPDATE orders SET status='expired',expires_at=? WHERE order_id=?", f.transfer.block_time, f.order.order_id);
    f.store.run("UPDATE amount_reservations SET expires_at=? WHERE order_id=? AND token_id='bsc-usdt'", f.transfer.block_time, f.order.order_id);
    let historicalReads = 0;
    const worker = createWorker({ store: f.store, scanChain: async args => {
      const historical = args.fromBlock === 100 && args.toBlock === 100;
      if (historical) historicalReads++;
      return response(args, historical ? [f.transfer] : []);
    } });
    await worker.scan();
    assert.equal(historicalReads, 1);
    assert.equal(raw(f).status, "paid");
    assert.equal(f.store.get("SELECT COUNT(*) n FROM audit WHERE action='auto_reconcile'").n, 1);
  } finally { f.store.close(); }
});

test("terminal, ambiguous, duplicate, wrong-window and non-current amount records do not create recovery jobs", async () => {
  const situations = ["paid", "canceled", "ambiguous_amount", "duplicate_payment", "reorg_after_payment",
    "invalid_payment_reference", "invalid_reference_flag", "payment_reference", "removed", "wrong_amount",
    "before_quote", "after_quote", "after_order", "wrong_project", "wrong_merchant", "wrong_mode",
    "switched_again", "bound_elsewhere", "another_transfer", "overlapping_quote"];
  for (const situation of situations) {
    const f = fixture();
    try {
      originalPaymentWhileSwitched(f);
      if (["paid", "canceled"].includes(situation)) f.store.run("UPDATE orders SET status=?", situation);
      if (["ambiguous_amount", "duplicate_payment", "reorg_after_payment", "invalid_payment_reference"].includes(situation))
        f.store.run("UPDATE transfers SET reason=?", situation);
      if (situation === "invalid_reference_flag") f.store.run("UPDATE transfers SET payment_reference_invalid=1");
      if (situation === "payment_reference") f.store.run("UPDATE transfers SET payment_reference=?", "0x" + "f".repeat(64));
      if (situation === "removed") f.store.run("UPDATE transfers SET removed=1");
      if (situation === "wrong_amount") f.store.run("UPDATE transfers SET amount_atomic='1000000000000000001'");
      if (situation === "before_quote") f.store.run("UPDATE amount_reservations SET created_at=?", new Date(Date.parse(f.transfer.block_time) + 2000).toISOString());
      if (situation === "after_quote") f.store.run("UPDATE amount_reservations SET expires_at=?", new Date(Date.parse(f.transfer.block_time) - 1000).toISOString());
      if (situation === "after_order") f.store.run("UPDATE orders SET expires_at=?", new Date(Date.parse(f.transfer.block_time) - 1000).toISOString());
      if (situation === "wrong_project") f.store.run("UPDATE transfers SET project_id='another-project'");
      if (situation === "wrong_merchant") f.store.run("UPDATE transfers SET merchant_id='another-merchant'");
      if (situation === "wrong_mode") f.store.run("UPDATE transfers SET mode='demo'");
      if (situation === "switched_again") f.store.selectMethod(raw(f), "bsc", "bsc-usdc");
      if (situation === "bound_elsewhere") f.store.run("UPDATE transfers SET order_id='another-order'");
      if (situation === "another_transfer") f.store.run("UPDATE orders SET transfer_id='another-transfer'");
      if (situation === "overlapping_quote") {
        const other = f.store.createOrder(f.merchant, { project_id: f.project.id, fiat_amount: "1.00",
          fiat_currency: "USD", chain: "bsc", token_id: "bsc-usdt" });
        f.store.run("UPDATE amount_reservations SET payable_atomic=?,created_at=? WHERE order_id=?",
          f.transfer.amount_atomic, raw(f).payment_started_at, other.order_id);
      }
      let historicalReads = 0;
      const worker = createWorker({ store: f.store, scanChain: async args => {
        if (args.fromBlock === 100 && args.toBlock === 100) historicalReads++;
        return response(args);
      } });
      await worker.scan();
      assert.equal(historicalReads, 0, situation);
      assert.equal(f.store.get("SELECT COUNT(*) n FROM recovery_jobs").n, 0, situation);
      assert.equal(f.store.get("SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL").n, 0, situation);
    } finally { f.store.close(); }
  }
});
