import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, decimalAtomic, hash } from "../server/core.mjs";
import { createWorker } from "../server/worker.mjs";

const registry = [{
  id: "bsc", name: "BNB Smart Chain", confirmations: 12,
  tokens: [{ id: "bsc-usdt", symbol: "USDT", decimals: 18, kind: "token" }],
}];
const config = () => ({
  payments: { automaticRecovery: true },
  pricing: { stablePolicy: "parity" },
  bsc: { rpcUrl: "https://node.example.test", chainId: 56, startBlock: 0,
    tokens: [{ id: "bsc-usdt", contract: "0x" + "1".repeat(40), decimals: 18, paymentReference: true }] },
});
function fixture(filename, reference = false) {
  const chains = registry.map((chain) => ({ ...chain, ...(reference ? { family: "evm", chainId: 56 } : {}), tokens: chain.tokens.map((t) => ({ ...t })) }));
  const store = new Store({ registry: chains, config: config(), ...(filename ? { filename } : {}) });
  const merchant = store.register({ email: "recovery@example.test", password: "safe-password-123" }, "demo");
  const project = store.createProject(merchant, { name: "Automatic recovery" });
  store.addAddress(merchant, { project_id: project.id, chain: "bsc", address: "demo:recovery" });
  return { store, merchant, project };
}
const order = (f, extra = {}) => {
  const o = f.store.createOrder(f.merchant, {
    project_id: f.project.id, fiat_amount: "19.90", fiat_currency: "USD",
    chain: "bsc", token_id: "bsc-usdt", ...extra,
  });
  return { ...o, payment_reference: f.store.ownedOrder(f.merchant, o.order_id).payment_reference };
};
const transfer = (o, extra = {}) => ({
  chain: "bsc", token_id: "bsc-usdt", tx_hash: `tx_${o.order_id}`, event_index: 0,
  to_address: o.pay_address, from_address: "demo:sender",
  amount_atomic: decimalAtomic(o.payable_amount, 18).toString(),
  ...(o.payment_reference ? { payment_reference: o.payment_reference } : {}),
  block_height: 100, block_hash: "block100", block_time: new Date().toISOString(),
  confirmations: 12, confirmed: true, removed: false, ...extra,
});
function live(f) {
  for (const table of ["merchants", "addresses", "orders", "transfers"])
    f.store.run(`UPDATE ${table} SET mode='live'`);
  f.merchant.mode = "live";
  f.store.run("INSERT INTO cursors VALUES(?,?,?,?,?)", "bsc", "200", "200", new Date().toISOString(), null);
}
function response(args, transactions = []) {
  return {
    transactions, cursor: args.toBlock ?? args.fromBlock,
    head: 1000, blocks: transactions.map((t) => ({ height: t.block_height, hash: t.block_hash, time: t.block_time })),
  };
}

// Records produced by the legacy scanner could remain confirmed but unbound
// after the order had expired. Seed exactly that persisted state for replay.
function historicalTransfer(f, tx, reason = "expired_order_requires_review") {
  const row = {
    id: hash([tx.chain, tx.tx_hash, tx.event_index].join(":")),
    merchant_id: f.merchant.id, project_id: f.project.id,
    ...tx, confirmed: tx.confirmed ? 1 : 0, removed: tx.removed ? 1 : 0,
    order_id: null, mode: "live", reason,
  };
  const columns = Object.keys(row);
  f.store.run(`INSERT INTO transfers (${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`, ...Object.values(row));
}

test("an expired reference payment is rescanned through its order confirmation threshold before automatic settlement", async () => {
  const f = fixture(undefined, true);
  try {
    f.store.setPaymentPolicy(f.merchant, f.project.id, { payment_mode: "reference" });
    const o = order(f);
    assert.equal(o.payment_mode, "reference");
    assert.ok(o.payment_reference);
    live(f);
    const start = new Date(Date.now() - 7200000).toISOString();
    const expiry = new Date(Date.now() - 3600000).toISOString();
    const paidAt = new Date(Date.now() - 5400000).toISOString();
    f.store.run("UPDATE orders SET status='expired',required_confirmations=24,created_at=?,payment_started_at=?,expires_at=? WHERE order_id=?", start, start, expiry, o.order_id);
    f.store.run("UPDATE amount_reservations SET created_at=? WHERE order_id=?", start, o.order_id);
    const tx = transfer(o, { block_time: paidAt });
    historicalTransfer(f, tx);
    const calls = [];
    const worker = createWorker({ store: f.store, scanChain: async (args) => {
      calls.push(args);
      return response(args, args.fromBlock === 100 && args.toBlock === 100 ? [tx] : []);
    } });
    await worker.scan();
    assert.equal(calls[0].fromBlock, 100);
    assert.equal(calls[0].toBlock, 100);
    assert.equal(f.store.ownedOrder(f.merchant, o.order_id).status, "confirming");
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM recovery_jobs").n, 1);
    tx.confirmations = 24;
    f.store.run("UPDATE recovery_jobs SET next_attempt=0");
    await worker.scan();
    const recovered = f.store.ownedOrder(f.merchant, o.order_id);
    assert.equal(recovered.status, "paid");
    assert.equal(recovered.paid_source, "chain");
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM audit WHERE action='auto_reconcile' AND subject=?", o.order_id).n, 1);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM recovery_jobs").n, 0);
    await worker.scan();
    assert.equal(calls.filter((args) => args.fromBlock === 100 && args.toBlock === 100).length, 2);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM deliveries WHERE event_type='order.paid'").n, 1);
  } finally { f.store.close(); }
});

test("terminal, invalid, old-reference and ambiguous transfers do not create endless recovery jobs", async () => {
  for (const situation of ["canceled", "paid", "outside_window", "wrong_amount", "unreferenced_ambiguity", "no_reference", "wrong_reference", "wrong_project", "old_reference", "invalid_reference", "invalid_reference_unconfirmed"]) {
    const f = fixture(undefined, true);
    try {
      f.store.setPaymentPolicy(f.merchant, f.project.id, { payment_mode: "reference" });
      const o = order(f);
      live(f);
      if (["canceled", "paid"].includes(situation))
        f.store.run("UPDATE orders SET status=? WHERE order_id=?", situation, o.order_id);
      const tx = transfer(o, {
        ...(situation === "outside_window" ? { block_time: new Date(Date.parse(o.expires_at) + 1000).toISOString() } : {}),
        ...(situation === "wrong_amount" ? { amount_atomic: "1" } : {}),
        ...(["no_reference", "unreferenced_ambiguity"].includes(situation) ? { payment_reference: null } : {}),
        ...(situation === "wrong_reference" ? { payment_reference: "0x" + "f".repeat(64) } : {}),
        ...(situation.startsWith("invalid_reference") ? { payment_reference_invalid: 1 } : {}),
        ...(situation === "invalid_reference_unconfirmed" ? { confirmed: false } : {}),
      });
      historicalTransfer(f, tx, situation === "unreferenced_ambiguity" ? "ambiguous_amount" : "unmatched_amount");
      if (situation === "wrong_project") f.store.run("UPDATE transfers SET project_id='another-project'");
      if (situation === "old_reference") f.store.run("UPDATE orders SET payment_reference=? WHERE order_id=?", "0x" + "e".repeat(64), o.order_id);
      let historicalReads = 0;
      const worker = createWorker({ store: f.store, scanChain: async (args) => {
        if (args.fromBlock === 100 && args.toBlock === 100) historicalReads++;
        return response(args);
      } });
      await worker.scan();
      assert.equal(historicalReads, 0, situation);
      assert.equal(f.store.get("SELECT COUNT(*) AS n FROM recovery_jobs").n, 0, situation);
      assert.equal(f.store.get("SELECT COUNT(*) AS n FROM transfers WHERE order_id IS NOT NULL").n, 0, situation);
    } finally { f.store.close(); }
  }
});

test("an unbound amount ambiguity with a verified reference can recover only after fresh chain verification", async () => {
  const f = fixture(undefined, true);
  try {
    f.store.setPaymentPolicy(f.merchant, f.project.id, { payment_mode: "reference" });
    const o = order(f);
    live(f);
    const tx = transfer(o);
    historicalTransfer(f, tx, "ambiguous_amount");
    let available = false, rescans = 0;
    const worker = createWorker({ store: f.store, scanChain: async (args) => {
      if (args.fromBlock === 100 && args.toBlock === 100) {
        rescans++;
        if (!available) throw Error("verification unavailable");
        return response(args, [tx]);
      }
      return response(args);
    } });
    await worker.scan();
    assert.equal(f.store.ownedOrder(f.merchant, o.order_id).status, "pending");
    assert.equal(f.store.get("SELECT order_id FROM transfers").order_id, null);
    available = true;
    f.store.run("UPDATE recovery_jobs SET next_attempt=0");
    await worker.scan();
    assert.equal(f.store.ownedOrder(f.merchant, o.order_id).status, "paid");
    assert.equal(rescans, 2);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM recovery_jobs").n, 0);
  } finally { f.store.close(); }
});

test("two same-address same-amount payments recover by reference and each fulfills only its own order", async () => {
  const f = fixture(undefined, true);
  try {
    f.store.setPaymentPolicy(f.merchant, f.project.id, { payment_mode: "reference" });
    const product = f.store.createProduct(f.merchant, { project_id: f.project.id, name: "Identical items", price: "19.90" });
    f.store.importInventory(f.merchant, product.id, ["FIRST-ITEM", "SECOND-ITEM"]);
    const a = order(f, { product_id: product.id }), b = order(f, { product_id: product.id });
    assert.equal(a.pay_address, b.pay_address);
    assert.equal(a.payable_amount, b.payable_amount);
    assert.notEqual(a.payment_reference, b.payment_reference);
    live(f);
    const start = new Date(Date.now() - 7200000).toISOString();
    const expiry = new Date(Date.now() - 3600000).toISOString();
    const block_time = new Date(Date.now() - 5400000).toISOString();
    f.store.run("UPDATE orders SET status='expired',created_at=?,payment_started_at=?,expires_at=?", start, start, expiry);
    f.store.run("UPDATE amount_reservations SET created_at=?", start);
    const first = transfer(a, { block_time }), second = transfer(b, { block_time });
    historicalTransfer(f, first); historicalTransfer(f, second);
    let rescans = 0;
    const worker = createWorker({ store: f.store, scanChain: async (args) => {
      const recovery = args.fromBlock === 100 && args.toBlock === 100;
      if (recovery) rescans++;
      return response(args, recovery ? [second, first] : []);
    } });
    await worker.scan();
    const paidA = f.store.orderView(f.store.ownedOrder(f.merchant, a.order_id));
    const paidB = f.store.orderView(f.store.ownedOrder(f.merchant, b.order_id));
    assert.equal(paidA.status, "paid"); assert.equal(paidB.status, "paid");
    assert.equal(paidA.tx_hash, first.tx_hash); assert.equal(paidB.tx_hash, second.tx_hash);
    assert.equal(paidA.delivery, "SECOND-ITEM"); assert.equal(paidB.delivery, "FIRST-ITEM");
    await worker.scan();
    assert.equal(rescans, 1, "one block job covers both references and disappears after settlement");
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM deliveries WHERE event_type='order.paid'").n, 2);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM inventory WHERE order_id IS NOT NULL").n, 2);
  } finally { f.store.close(); }
});

test("an unavailable old block backs off without blocking a new payment or forward health", async () => {
  const f = fixture();
  try {
    const old = order(f), next = order(f);
    f.store.ingest(transfer(old, { confirmations: 1, confirmed: false }), { mode: "demo" });
    live(f);
    const calls = [];
    const worker = createWorker({ store: f.store, scanChain: async (args) => {
      calls.push(args);
      if (args.toBlock !== undefined) throw Error("archive unavailable at https://node.example.test/private");
      return response(args, [transfer(next, { block_height: 201, block_hash: "block201" })]);
    } });
    await worker.scan();
    assert.deepEqual(calls.map((a) => [a.fromBlock, a.toBlock]), [[100, 100], [201, undefined]]);
    assert.equal(f.store.ownedOrder(f.merchant, next.order_id).status, "paid");
    assert.equal(f.store.ownedOrder(f.merchant, old.order_id).status, "confirming");
    const cursor = f.store.get("SELECT * FROM cursors WHERE chain='bsc'");
    assert.equal(cursor.cursor, "201");
    assert.equal(cursor.last_error, null);
    const job = f.store.get("SELECT * FROM recovery_jobs");
    assert.equal(job.attempts, 1);
    assert.ok(job.next_attempt > Date.now());
    assert.match(job.last_error, /archive unavailable at \[node\]/);
    assert.ok(!job.last_error.includes("private"));
  } finally { f.store.close(); }
});

test("restocked orders settle once only after a successful fresh block scan", async () => {
  const f = fixture();
  try {
    const product = f.store.createProduct(f.merchant, { project_id: f.project.id, name: "One license", price: "19.90" });
    f.store.importInventory(f.merchant, product.id, ["FIRST-CUSTOMER"]);
    const competing = order(f, { product_id: product.id });
    const o = order(f, { product_id: product.id });
    const tx = transfer(o);
    f.store.ingest(transfer(competing), { mode: "demo" });
    f.store.ingest(tx, { mode: "demo" });
    assert.equal(f.store.ownedOrder(f.merchant, o.order_id).status, "review");
    live(f);
    f.store.importInventory(f.merchant, product.id, ["SINGLE-DELIVERY"]);
    let available = false, oldReads = 0;
    const worker = createWorker({ store: f.store, scanChain: async (args) => {
      if (args.toBlock !== undefined) {
        oldReads++;
        if (!available) throw Error("node is unavailable");
        return response(args, [tx]);
      }
      return response(args);
    } });
    await worker.scan();
    assert.equal(f.store.ownedOrder(f.merchant, o.order_id).status, "review");
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM inventory WHERE order_id=?", o.order_id).n, 0);
    available = true;
    f.store.run("UPDATE recovery_jobs SET next_attempt=0");
    await worker.scan();
    assert.equal(f.store.orderView(f.store.ownedOrder(f.merchant, o.order_id)).delivery, "SINGLE-DELIVERY");
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM recovery_jobs").n, 0);
    await worker.scan();
    assert.equal(oldReads, 2, "settled transfers stop producing recovery jobs");
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM inventory WHERE order_id=?", o.order_id).n, 1);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM deliveries WHERE event_type='order.paid' AND json_extract(payload,'$.data.order_id')=?", o.order_id).n, 1);
  } finally { f.store.close(); }
});

test("more than fifty waiting-stock blocks are visited fairly with a bounded batch", async () => {
  const f = fixture();
  try {
    const product = f.store.createProduct(f.merchant, { project_id: f.project.id, name: "Temporarily unavailable", price: "19.90" });
    f.store.importInventory(f.merchant, product.id, ["FIRST-CUSTOMER"]);
    const competing = order(f, { product_id: product.id });
    const transfers = new Map();
    for (let height = 1; height <= 57; height++) {
      const tx = transfer(order(f, { product_id: product.id }), { block_height: height, block_hash: `block${height}` });
      transfers.set(height, tx);
    }
    f.store.ingest(transfer(competing, { block_height: 99 }), { mode: "demo" });
    for (const tx of transfers.values()) f.store.ingest(tx, { mode: "demo" });
    live(f);
    const visited = [], batches = [];
    let forwards = 0;
    const worker = createWorker({ store: f.store, intervalMs: 60000, scanChain: async (args) => {
      if (args.toBlock !== undefined) {
        visited.push(args.fromBlock);
        return response(args, [transfers.get(args.fromBlock)]);
      }
      forwards++;
      return response(args);
    } });
    for (let i = 0; i < 12; i++) {
      const before = visited.length;
      await worker.scan();
      batches.push(visited.length - before);
    }
    assert.deepEqual(visited, Array.from({ length: 57 }, (_, i) => i + 1));
    assert.ok(batches.every((n) => n <= 5));
    assert.equal(forwards, 12);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM recovery_jobs").n, 57);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM orders WHERE status='review'").n, 57);
  } finally { f.store.close(); }
});

test("all chains share one recovery budget and a busy first chain cannot starve another", async () => {
  const f = fixture();
  try {
    f.store.registry.push({ id: "ethereum", name: "Ethereum", confirmations: 12,
      tokens: [{ id: "ethereum-usdt", symbol: "USDT", decimals: 18 }] });
    f.store.config.ethereum = { ...config().bsc, chainId: 1,
      tokens: [{ id: "ethereum-usdt", contract: "0x" + "2".repeat(40), decimals: 18 }] };
    f.store.addAddress(f.merchant, { project_id: f.project.id, chain: "ethereum", address: "demo:ethereum" });
    const transfers = new Map();
    for (const chain of ["bsc", "ethereum"]) for (let height = 1; height <= 6; height++) {
      const token_id = chain + "-usdt";
      const tx = transfer(order(f, { chain, token_id }), {
        chain, token_id, block_height: height, block_hash: chain + height,
        confirmed: false, confirmations: 1,
      });
      transfers.set(chain + ":" + height, tx);
      f.store.ingest(tx, { mode: "demo" });
    }
    live(f);
    f.store.run("INSERT INTO cursors VALUES(?,?,?,?,?)", "ethereum", "200", "200", new Date().toISOString(), null);
    const visited = [], forwards = [];
    const worker = createWorker({ store: f.store, intervalMs: 60000, scanChain: async (args) => {
      if (args.toBlock !== undefined) {
        const key = args.chain + ":" + args.fromBlock;
        visited.push(key);
        return response(args, [transfers.get(key)]);
      }
      forwards.push(args.chain);
      return response(args);
    } });
    for (let i = 0; i < 3; i++) {
      const before = visited.length;
      await worker.scan();
      assert.ok(visited.length - before <= 5, "limit applies across all chains, not separately per chain");
    }
    assert.equal(visited.length, 12);
    assert.equal(new Set(visited).size, 12);
    assert.equal(forwards.length, 6);
  } finally { f.store.close(); }
});

test("block recovery jobs and their backoff survive a worker and database restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "avenora-recovery-"));
  const filename = path.join(dir, "app.sqlite");
  const f = fixture(filename);
  let reopened;
  try {
    const o = order(f), tx = transfer(o);
    f.store.ingest({ ...tx, confirmations: 1, confirmed: false }, { mode: "demo" });
    live(f);
    const first = createWorker({ store: f.store, scanChain: async (args) => {
      if (args.toBlock !== undefined) throw Error("archive temporarily offline");
      return response(args);
    } });
    await first.scan();
    const saved = f.store.get("SELECT * FROM recovery_jobs");
    first.stop();
    f.store.close();
    reopened = new Store({ filename, registry, config: config() });
    let reads = 0;
    const second = createWorker({ store: reopened, scanChain: async (args) => {
      if (args.toBlock !== undefined) { reads++; return response(args, [tx]); }
      return response(args);
    } });
    await second.scan();
    assert.equal(reads, 0, "restart must preserve rather than reset backoff");
    assert.deepEqual(reopened.get("SELECT * FROM recovery_jobs"), saved);
    reopened.run("UPDATE recovery_jobs SET next_attempt=0");
    await second.scan();
    assert.equal(reads, 1);
    assert.equal(reopened.get("SELECT status FROM orders WHERE order_id=?", o.order_id).status, "paid");
    assert.equal(reopened.get("SELECT COUNT(*) AS n FROM recovery_jobs").n, 0);
  } finally {
    try { f.store.close(); } catch {}
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed canonical sweeps retain and extend their unfinished range across forward progress and restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "avenora-reorg-recovery-"));
  const filename = path.join(dir, "app.sqlite");
  const f = fixture(filename);
  let reopened;
  try {
    f.store.registry[0].family = "evm";
    const first = order(f), later = order(f);
    live(f);
    const payments = [
      transfer(first, { block_height: 190, block_hash: "replacement190" }),
      transfer(later, { block_height: 210, block_hash: "replacement210" }),
    ];
    let available = false, head = 200;
    const ranges = [];
    const scanChain = async (args) => {
      if (args.toBlock === undefined) {
        head = args.fromBlock + 9;
        return { cursor: head, head, transactions: [], blocks: [] };
      }
      ranges.push([args.fromBlock, args.toBlock]);
      if (!available) throw Error("canonical archive unavailable");
      const transactions = payments.filter((tx) => tx.block_height >= args.fromBlock && tx.block_height <= args.toBlock);
      return { ...response(args, transactions), head };
    };
    const firstWorker = createWorker({ store: f.store, scanChain });
    await firstWorker.scan();
    const original = f.store.get("SELECT * FROM reorg_scan_jobs");
    assert.equal(original.from_block, 187);
    assert.equal(original.to_block, 200);
    assert.equal(original.attempts, 1);
    await firstWorker.scan();
    assert.deepEqual(ranges, [[187, 200]], "backoff avoids another failing request while forward continues");
    assert.equal(f.store.get("SELECT cursor FROM cursors").cursor, "220");
    assert.equal(f.store.get("SELECT to_block FROM reorg_scan_jobs").to_block, 210);
    firstWorker.stop(); f.store.close();
    reopened = new Store({ filename, config: config(), registry: registry.map((chain) => ({ ...chain, family: "evm" })) });
    const secondWorker = createWorker({ store: reopened, scanChain });
    await secondWorker.scan();
    let pending = reopened.get("SELECT * FROM reorg_scan_jobs");
    assert.equal(pending.from_block, 187);
    assert.equal(pending.to_block, 220);
    assert.equal(pending.next_attempt, original.next_attempt);
    reopened.run("UPDATE reorg_scan_jobs SET next_attempt=0");
    await secondWorker.scan();
    pending = reopened.get("SELECT * FROM reorg_scan_jobs");
    assert.equal(pending.attempts, 2);
    assert.equal(pending.from_block, 187);
    assert.equal(pending.to_block, 230);
    assert.equal(reopened.get("SELECT cursor FROM cursors").cursor, "240");
    assert.equal(reopened.get("SELECT last_error FROM cursors").last_error, null);
    available = true;
    reopened.run("UPDATE reorg_scan_jobs SET next_attempt=0");
    await secondWorker.scan();
    assert.deepEqual(ranges, [[187, 200], [187, 230], [187, 240]]);
    assert.equal(reopened.get("SELECT COUNT(*) AS n FROM reorg_scan_jobs").n, 0);
    for (const o of [first, later]) assert.equal(reopened.get("SELECT status FROM orders WHERE order_id=?", o.order_id).status, "paid");
    assert.equal(reopened.get("SELECT cursor FROM cursors").cursor, "250");
    await secondWorker.scan();
    assert.equal(reopened.get("SELECT COUNT(*) AS n FROM deliveries WHERE event_type='order.paid'").n, 2);
  } finally {
    try { f.store.close(); } catch {}
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic webhook recovery continues after eight failures and preserves event identity and fulfillment", async () => {
  const f = fixture();
  try {
    f.store.run("INSERT INTO endpoints VALUES(?,?,?,?,?,?)", "endpoint", f.merchant.id, f.project.id,
      "https://merchant.example.test/events", f.store.encrypt("test-webhook-secret"), new Date().toISOString());
    const product = f.store.createProduct(f.merchant, { project_id: f.project.id, name: "One delivery", price: "19.90" });
    f.store.importInventory(f.merchant, product.id, ["FULFILLED-ONCE"]);
    const o = order(f, { product_id: product.id });
    f.store.ingest(transfer(o), { mode: "demo" });
    live(f);
    const paid = f.store.get("SELECT * FROM deliveries WHERE event_type='order.paid'");
    const sent = [];
    let successful = false;
    const options = { store: f.store, scanChain: async (args) => response(args), post: async (_url, payload) => {
      sent.push(payload);
      return { status: successful ? 204 : 503 };
    } };
    const first = createWorker(options);
    for (let i = 0; i < 9; i++) {
      f.store.run("UPDATE deliveries SET next_attempt=0");
      await first.deliver();
    }
    const retry = f.store.get("SELECT * FROM deliveries WHERE id=?", paid.id);
    assert.equal(retry.status, "retry");
    assert.equal(retry.attempts, 9);
    assert.ok(retry.next_attempt >= Date.now() + 3590000);
    first.stop();
    // An existing legacy dead letter is also eligible once automatic recovery is enabled.
    f.store.run("UPDATE deliveries SET status='dead',next_attempt=0 WHERE id=?", paid.id);
    successful = true;
    await createWorker(options).deliver();
    const delivered = f.store.get("SELECT * FROM deliveries WHERE id=?", paid.id);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attempts, 10);
    assert.equal(delivered.event_id, paid.event_id);
    const retries = sent.filter((payload) => payload.headers["DJP-Webhook-ID"] === paid.event_id);
    assert.equal(retries.length, 10);
    assert.ok(retries.every((payload) => payload.body === paid.payload));
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM deliveries WHERE event_type='order.paid'").n, 1);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM inventory WHERE order_id=?", o.order_id).n, 1);
  } finally { f.store.close(); }
});
