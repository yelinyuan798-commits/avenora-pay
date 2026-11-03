import test from "node:test";
import assert from "node:assert/strict";
import {
  Store,
  decimalAtomic,
  formatAtomic,
  signRequest,
  hash,
} from "../server/core.mjs";
import { createWorker } from "../server/worker.mjs";
const registry = [
  {
    id: "bsc",
    name: "BNB Smart Chain",
    confirmations: 12,
    tokens: [{ id: "bsc-usdt", symbol: "USDT", decimals: 18 }],
  },
];
function fixture() {
  const s = new Store({ registry });
  const m = s.register(
    {
      email: "merchant@example.test",
      password: "safe-password-123",
      name: "Merchant",
    },
    "demo",
  );
  const p = s.createProject(m, { name: "Store" });
  s.addAddress(m, { project_id: p.id, chain: "bsc", address: "demo:address" });
  return { s, m, p };
}
const order = (f, extra = {}) =>
  f.s.createOrder(f.m, {
    project_id: f.p.id,
    fiat_amount: "19.90",
    fiat_currency: "USD",
    chain: "bsc",
    token_id: "bsc-usdt",
    ...extra,
  });
const transfer = (o, extra = {}) => ({
  chain: "bsc",
  token_id: "bsc-usdt",
  tx_hash: "tx_" + o.order_id,
  event_index: 0,
  to_address: o.pay_address,
  from_address: "demo:sender",
  amount_atomic: decimalAtomic(o.payable_amount, 18).toString(),
  block_height: 100,
  block_hash: "block100",
  block_time: new Date().toISOString(),
  confirmations: 12,
  confirmed: true,
  removed: false,
  ...extra,
});
test("decimal arithmetic never passes through floating point", () => {
  assert.equal(
    decimalAtomic("123456789.123456789123456789", 18),
    123456789123456789123456789n,
  );
  assert.equal(formatAtomic(1n, 18), "0.000000000000000001");
  assert.throws(() => decimalAtomic("1e6", 18));
  assert.throws(() => decimalAtomic("-1", 18));
  assert.throws(() => decimalAtomic("1.001", 2));
});
test("distinct orders allocate globally distinct exact amounts; repeated merchant id is idempotent", () => {
  const f = fixture();
  const a = order(f, { merchant_order_id: "a" });
  const repeat = order(f, { merchant_order_id: "a" });
  assert.equal(a.order_id, repeat.order_id);
  const b = order(f, { merchant_order_id: "b" });
  assert.notEqual(a.payable_amount, b.payable_amount);
  assert.throws(
    () => order(f, { merchant_order_id: "a", fiat_amount: "29" }),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  f.s.close();
});
test("same chain address cannot be bound across merchants", () => {
  const f = fixture();
  const m = f.s.register(
    { email: "other@example.test", password: "safe-password-123" },
    "demo",
  );
  const p = f.s.createProject(m, { name: "Other" });
  assert.throws(
    () =>
      f.s.addAddress(m, {
        project_id: p.id,
        chain: "bsc",
        address: "demo:address",
      }),
    (e) => e.code === "ADDRESS_EXISTS",
  );
  f.s.close();
});
test("confirmation threshold, duplicate events and one-use inventory are transactional", () => {
  const f = fixture();
  const p = f.s.createProduct(f.m, {
    project_id: f.p.id,
    name: "License",
    price: "19.90",
  });
  f.s.importInventory(f.m, p.id, ["LICENSE-A", "LICENSE-B"]);
  const a = order(f, { product_id: p.id });
  const b = order(f, { product_id: p.id });
  const tx = transfer(a, { confirmations: 1, confirmed: false });
  assert.equal(f.s.ingest(tx, { mode: "demo" }).order.status, "confirming");
  assert.equal(
    f.s.get("SELECT COUNT(*) AS n FROM inventory WHERE order_id IS NOT NULL").n,
    0,
  );
  tx.confirmations = 12;
  tx.confirmed = true;
  assert.equal(f.s.ingest(tx, { mode: "demo" }).order.delivery, "LICENSE-A");
  for (let i = 0; i < 4; i++) f.s.ingest(tx, { mode: "demo" });
  assert.equal(
    f.s.ingest(transfer(b), { mode: "demo" }).order.delivery,
    "LICENSE-B",
  );
  assert.equal(
    f.s.get(
      "SELECT COUNT(*) AS n FROM deliveries WHERE event_type='order.paid'",
    ).n,
    2,
  );
  assert.equal(
    f.s.get("SELECT COUNT(*) AS n FROM inventory WHERE order_id IS NOT NULL").n,
    2,
  );
  f.s.close();
});
test("inventory exhaustion holds a paid transfer for review and claim resumes only once", () => {
  const f = fixture();
  const p = f.s.createProduct(f.m, {
    project_id: f.p.id,
    name: "Limited",
    price: "19.90",
  });
  f.s.importInventory(f.m, p.id, ["ONLY-ONE"]);
  const a = order(f, { product_id: p.id }),
    b = order(f, { product_id: p.id });
  f.s.ingest(transfer(a), { mode: "demo" });
  f.s.ingest(transfer(b), { mode: "demo" });
  assert.equal(f.s.ownedOrder(f.m, b.order_id).status, "review");
  f.s.importInventory(f.m, p.id, ["NEXT-ONE"]);
  const tx = f.s.get(
    "SELECT * FROM transfers WHERE tx_hash=?",
    "tx_" + b.order_id,
  );
  assert.equal(f.s.claim(f.m, tx.id, b.order_id).delivery, "NEXT-ONE");
  f.s.claim(f.m, tx.id, b.order_id);
  assert.equal(
    f.s.get(
      "SELECT COUNT(*) AS n FROM deliveries WHERE event_type='order.paid'",
    ).n,
    2,
  );
  f.s.close();
});
test("wrong amount, wrong token, old block, removed block never settle", () => {
  const f = fixture();
  const a = order(f);
  assert.equal(
    f.s.ingest(transfer(a, { amount_atomic: "1" }), { mode: "demo" }).matched,
    false,
  );
  assert.equal(
    f.s.ingest(transfer(a, { tx_hash: "wrong-token", token_id: "bsc-fake" }), {
      mode: "demo",
    }).ignored,
    true,
  );
  assert.equal(
    f.s.ingest(
      transfer(a, { tx_hash: "old", block_time: "2020-01-01T00:00:00Z" }),
      { mode: "demo" },
    ).matched,
    false,
  );
  assert.equal(
    f.s.ingest(transfer(a, { tx_hash: "removed", removed: true }), {
      mode: "demo",
    }).matched,
    false,
  );
  assert.equal(f.s.ownedOrder(f.m, a.order_id).status, "pending");
  f.s.close();
});
test("expired orders remain terminal until a merchant explicitly claims a valid in-window payment", () => {
  const f = fixture();
  const a = order(f);
  const tx = transfer(a);
  f.s.run("UPDATE orders SET status='expired' WHERE order_id=?", a.order_id);
  assert.equal(f.s.ingest(tx, { mode: "demo" }).matched, false);
  assert.equal(f.s.ownedOrder(f.m, a.order_id).status, "expired");
  const stored = f.s.get("SELECT * FROM transfers WHERE tx_hash=?", tx.tx_hash);
  assert.equal(stored.reason, "expired_order_requires_review");
  const claimed = f.s.claim(f.m, stored.id, a.order_id);
  assert.equal(claimed.status, "paid");
  assert.equal(claimed.paid_source, "manual");
  assert.equal(
    f.s.get("SELECT action FROM audit WHERE subject=?", stored.id).action,
    "merchant_claim",
  );
  const b = order(f);
  assert.equal(
    f.s.ingest(
      transfer(b, {
        block_time: new Date(Date.parse(b.expires_at) + 1000).toISOString(),
      }),
      { mode: "demo" },
    ).matched,
    false,
  );
  f.s.close();
});
test("tenant isolation and demo/live isolation hold for settlement and claim", () => {
  const f = fixture();
  const a = order(f);
  assert.equal(f.s.ingest(transfer(a), { mode: "live" }).ignored, true);
  const m = f.s.register({
    email: "other@example.test",
    password: "safe-password-123",
  });
  assert.throws(
    () => f.s.ownedOrder(m, a.order_id),
    (e) => e.code === "NOT_FOUND",
  );
  assert.throws(
    () => f.s.simulate(m, a.order_id),
    (e) => e.code === "NOT_FOUND",
  );
  assert.throws(
    () => f.s.createOrder(m, { project_id: f.p.id, fiat_amount: "9.90" }),
    (e) => e.code === "NOT_FOUND",
  );
  f.s.close();
});
test("unconfigured live payment fails closed and credential values are encrypted at rest", () => {
  const f = fixture();
  const m = f.s.register({
    email: "live@example.test",
    password: "safe-password-123",
  });
  const p = f.s.createProject(m, { name: "Live" });
  assert.throws(
    () => f.s.createOrder(m, { project_id: p.id, fiat_amount: "10" }),
    (e) => e.code === "PAYMENT_UNCONFIGURED",
  );
  const key = f.s.createKey(f.m, { project_id: f.p.id });
  assert.notEqual(f.s.get("SELECT secret FROM api_keys").secret, key.secret);
  assert.equal(
    f.s.decrypt(f.s.get("SELECT secret FROM api_keys").secret),
    key.secret,
  );
  f.s.close();
});
test("HMAC authenticates raw body, rejects tampering, nonce replay, expiry and revoked keys", () => {
  const f = fixture();
  const key = f.s.createKey(f.m, { project_id: f.p.id });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = Buffer.from('{"fiat_amount":"19.90"}');
  const nonce = "nonce-1234567890123456";
  const headers = {
    "djp-key-id": key.key_id,
    "djp-timestamp": timestamp,
    "djp-nonce": nonce,
    "djp-signature": signRequest(
      key.secret,
      "POST",
      "/v1/orders",
      "",
      body,
      timestamp,
      nonce,
    ),
  };
  const request = {
    headers,
    method: "POST",
    pathname: "/v1/orders",
    query: "",
    body,
  };
  assert.equal(f.s.authenticateApi(request).project.id, f.p.id);
  assert.throws(
    () => f.s.authenticateApi(request),
    (e) => e.code === "NONCE_REPLAY",
  );
  assert.throws(
    () => f.s.authenticateApi({ ...request, body: Buffer.from("{}") }),
    (e) => e.code === "INVALID_SIGNATURE",
  );
  assert.throws(
    () =>
      f.s.authenticateApi({
        ...request,
        headers: {
          ...headers,
          "djp-timestamp": String(Number(timestamp) - 600),
        },
      }),
    (e) => e.code === "TIMESTAMP_EXPIRED",
  );
  f.s.run("UPDATE api_keys SET revoked=1");
  assert.throws(
    () => f.s.authenticateApi(request),
    (e) => e.code === "INVALID_SIGNATURE",
  );
  f.s.close();
});
test("public checkout strips tenant, metadata, credentials, tokens, prepayment delivery", () => {
  const f = fixture();
  const o = order(f, { metadata: { private: "hidden" } });
  const pub = f.s.orderView(f.s.ownedOrder(f.m, o.order_id), {
    publicView: true,
  });
  for (const field of [
    "merchant_id",
    "metadata",
    "request_hash",
    "checkout_token",
    "project_id",
    "checkout_url",
  ])
    assert.equal(pub[field], undefined);
  assert.equal(pub.delivery, null);
  f.s.close();
});
test("webhook failure retries with same event ID then enters dead letter; signatures verify", async () => {
  const f = fixture();
  const ep = "endpoint";
  const secret = "webhook-secret";
  f.s.run(
    "INSERT INTO endpoints VALUES(?,?,?,?,?,?)",
    ep,
    f.m.id,
    f.p.id,
    "https://merchant.example.test/hooks",
    f.s.encrypt(secret),
    new Date().toISOString(),
  );
  const o = order(f);
  f.s.simulate(f.m, o.order_id);
  f.s.run("UPDATE merchants SET mode='live' WHERE id=?", f.m.id);
  const sent = [];
  const worker = createWorker({
    store: f.s,
    scanChain: async () => ({ transactions: [] }),
    post: async (url, payload) => {
      sent.push(payload);
      return { status: 500 };
    },
  });
  for (let i = 0; i < 8; i++) {
    f.s.run("UPDATE deliveries SET next_attempt=0");
    await worker.deliver();
  }
  const d = f.s.get("SELECT * FROM deliveries WHERE event_type='order.paid'");
  assert.equal(d.status, "dead");
  assert.equal(d.attempts, 8);
  assert.equal(
    sent.filter((p) => p.headers["DJP-Webhook-ID"] === d.event_id).length,
    8,
  );
  assert.equal(sent[0].headers["DJP-Webhook-Signature"].length, 64);
  f.s.close();
});
test("scanner errors preserve cursor and record retryable health state", async () => {
  const f = fixture();
  f.s.config = {
    pricing: { stablePolicy: "parity" },
    bsc: {
      rpcUrl: "https://node.example.test",
      tokens: [{ id: "bsc-usdt", contract: "0xabc", decimals: 18 }],
      startBlock: 90,
    },
  };
  f.s.run("UPDATE addresses SET mode='live'");
  f.s.run(
    "INSERT INTO cursors VALUES(?,?,?,?,?)",
    "bsc",
    "100",
    "105",
    new Date().toISOString(),
    null,
  );
  const worker = createWorker({
    store: f.s,
    scanChain: async () => {
      throw Error("node temporarily unavailable");
    },
  });
  await worker.scan();
  assert.equal(f.s.get("SELECT cursor FROM cursors").cursor, "100");
  assert.match(
    f.s.get("SELECT last_error FROM cursors").last_error,
    /unavailable/,
  );
  f.s.close();
});
test("forward scanner progresses independently from pending recheck and rolls back a replaced block", async () => {
  const f = fixture();
  f.s.config = {
    pricing: { stablePolicy: "parity" },
    bsc: {
      rpcUrl: "https://node.example.test",
      tokens: [{ id: "bsc-usdt", contract: "0xabc", decimals: 18 }],
      startBlock: 0,
    },
  };
  const o = order(f);
  f.s.ingest(transfer(o, { confirmations: 1, confirmed: false }), {
    mode: "demo",
  });
  f.s.run("UPDATE merchants SET mode='live'");
  f.s.run("UPDATE addresses SET mode='live'");
  f.s.run("UPDATE orders SET mode='live'");
  f.s.run("UPDATE transfers SET mode='live'");
  f.s.run(
    "INSERT INTO cursors VALUES(?,?,?,?,?)",
    "bsc",
    "100",
    "100",
    new Date().toISOString(),
    null,
  );
  const calls = [];
  const worker = createWorker({
    store: f.s,
    scanChain: async (args) => {
      calls.push(args);
      return {
        transactions: [],
        blocks: [{ height: 100, hash: "replacement" }],
        cursor: args.toBlock ?? 110,
        head: 110,
      };
    },
  });
  await worker.scan();
  assert.equal(calls[0].fromBlock, 100);
  assert.equal(calls[0].toBlock, 100);
  assert.equal(calls[1].fromBlock, 101);
  assert.equal(f.s.get("SELECT cursor FROM cursors").cursor, "110");
  assert.equal(f.s.ownedOrder(f.m, o.order_id).status, "pending");
  assert.equal(f.s.get("SELECT removed FROM transfers").removed, 1);
  f.s.close();
});
test("live order expiry waits for verified scan time to pass its deadline and healthy scanner", () => {
  const f = fixture();
  const o = order(f);
  f.s.run(
    "UPDATE orders SET mode='live',expires_at=? WHERE order_id=?",
    new Date(Date.now() - 10000).toISOString(),
    o.order_id,
  );
  f.s.expire();
  assert.equal(f.s.ownedOrder(f.m, o.order_id).status, "pending");
  f.s.run(
    "INSERT INTO scanner_watermarks VALUES(?,?)",
    "bsc",
    new Date().toISOString(),
  );
  f.s.run(
    "INSERT INTO cursors VALUES(?,?,?,?,?)",
    "bsc",
    "100",
    "100",
    new Date().toISOString(),
    "node failure",
  );
  f.s.expire();
  assert.equal(f.s.ownedOrder(f.m, o.order_id).status, "pending");
  f.s.run("UPDATE cursors SET last_error=NULL");
  f.s.expire();
  assert.equal(f.s.ownedOrder(f.m, o.order_id).status, "expired");
  f.s.close();
});
test("block timestamps with second precision include payment in order creation second", () => {
  const f = fixture();
  const o = order(f);
  const timestamp = new Date(
    Math.floor(Date.parse(o.created_at) / 1000) * 1000,
  ).toISOString();
  assert.equal(
    f.s.ingest(transfer(o, { block_time: timestamp }), { mode: "demo" }).order
      .status,
    "paid",
  );
  f.s.close();
});
test("recent EVM sweep discovers payment introduced by reorg into a previously empty scanned block", async () => {
  const f = fixture();
  f.s.registry[0].family = "evm";
  f.s.config = {
    pricing: { stablePolicy: "parity" },
    bsc: {
      rpcUrl: "https://node.example.test",
      tokens: [{ id: "bsc-usdt", contract: "0xabc", decimals: 18 }],
      startBlock: 0,
    },
  };
  const o = order(f);
  f.s.run("UPDATE merchants SET mode='live'");
  f.s.run("UPDATE addresses SET mode='live'");
  f.s.run("UPDATE orders SET mode='live'");
  f.s.run(
    "INSERT INTO cursors VALUES(?,?,?,?,?)",
    "bsc",
    "100",
    "100",
    new Date().toISOString(),
    null,
  );
  const calls = [];
  const tx = transfer(o, { block_height: 99, block_hash: "reorg99" });
  const worker = createWorker({
    store: f.s,
    scanChain: async (args) => {
      calls.push(args);
      const recheck = args.toBlock !== undefined;
      return {
        transactions: recheck ? [tx] : [],
        blocks: recheck
          ? [{ height: 99, hash: "reorg99", time: tx.block_time }]
          : [{ height: 112, hash: "head112", time: tx.block_time }],
        cursor: recheck ? 100 : 112,
        head: 112,
      };
    },
  });
  await worker.scan();
  assert.equal(calls[0].fromBlock, 101);
  assert.ok(calls[1].fromBlock <= 99);
  assert.equal(calls[1].toBlock, 100);
  assert.equal(f.s.ownedOrder(f.m, o.order_id).status, "paid");
  assert.equal(f.s.get("SELECT cursor FROM cursors").cursor, "112");
  assert.equal(
    f.s.get("SELECT block_time FROM scanner_watermarks").block_time,
    tx.block_time,
  );
  f.s.close();
});

test("deferred selection starts payment clock once; switching retains old reservations and locked expiry", () => {
  const f = fixture();
  f.s.registry[0].tokens.push({ id: "bsc-usdc", symbol: "USDC", decimals: 18 });
  f.s.run(
    "UPDATE addresses SET token_ids=?",
    JSON.stringify(["bsc-usdt", "bsc-usdc"]),
  );
  const o = f.s.createOrder(f.m, {
    project_id: f.p.id,
    fiat_amount: "10.00",
    allowed_methods: [
      { chain: "bsc", token_id: "bsc-usdt" },
      { chain: "bsc", token_id: "bsc-usdc" },
    ],
  });
  assert.equal(o.status, "awaiting_payment");
  assert.equal(o.expires_at, null);
  assert.ok(o.selection_deadline);
  assert.equal(
    f.s.orderView(f.s.ownedOrder(f.m, o.order_id), { publicView: true })
      .payable,
    false,
  );
  const first = f.s.selectMethod(
    f.s.ownedOrder(f.m, o.order_id),
    "bsc",
    "bsc-usdt",
  );
  assert.equal(first.status, "pending");
  assert.ok(first.expires_at);
  assert.equal(first.fiat_total, "10.00");
  const switched = f.s.selectMethod(
    f.s.ownedOrder(f.m, o.order_id),
    "bsc",
    "bsc-usdc",
  );
  assert.equal(switched.expires_at, first.expires_at);
  assert.equal(f.s.ingest(transfer(first), { mode: "demo" }).matched, false);
  assert.equal(
    f.s.get("SELECT reason FROM transfers").reason,
    "superseded_payment_method",
  );
  const next = order(f, { fiat_amount: "10.00" });
  assert.notEqual(next.payable_amount, first.payable_amount);
  const back = f.s.selectMethod(
    f.s.ownedOrder(f.m, o.order_id),
    "bsc",
    "bsc-usdt",
  );
  assert.notEqual(back.payable_amount, first.payable_amount);
  assert.equal(back.expires_at, first.expires_at);
  assert.equal(
    f.s.get(
      "SELECT COUNT(*) AS n FROM deliveries WHERE event_type='order.method_selected'",
    ).n,
    3,
  );
  f.s.close();
});
test("fixed method cannot switch; expired selection cannot allocate a new amount", () => {
  const f = fixture();
  const o = order(f);
  assert.throws(
    () => f.s.selectMethod(f.s.ownedOrder(f.m, o.order_id), "bsc", "bsc-usdc"),
    (e) => e.code === "METHOD_LOCKED",
  );
  const deferred = f.s.createOrder(f.m, {
    project_id: f.p.id,
    fiat_amount: "10.00",
  });
  f.s.run(
    "UPDATE orders SET selection_deadline=? WHERE order_id=?",
    new Date(Date.now() - 1000).toISOString(),
    deferred.order_id,
  );
  assert.throws(
    () =>
      f.s.selectMethod(
        f.s.ownedOrder(f.m, deferred.order_id),
        "bsc",
        "bsc-usdt",
      ),
    (e) => e.code === "ORDER_NOT_PAYABLE",
  );
  f.s.expire();
  assert.equal(f.s.ownedOrder(f.m, deferred.order_id).status, "expired");
  f.s.close();
});
test("project fee is integer rounded, affects actual payable, and snapshots survive settings changes", () => {
  const f = fixture();
  f.s.updateProjectSettings(f.m, f.p.id, {
    display_name: "Brand Store",
    support_email: "help@example.test",
    fee_enabled: true,
    fee_percent: "1.50",
  });
  const o = order(f);
  assert.equal(o.fee_percent, "1.50");
  assert.equal(o.fee_amount, "0.30");
  assert.equal(o.fiat_total, "20.20");
  assert.equal(o.payable_amount, "20.200100000000000000");
  assert.equal(o.exchange_rate, "1");
  assert.equal(o.brand.display_name, "Brand Store");
  f.s.updateProjectSettings(f.m, f.p.id, { fee_percent: "8.00" });
  const before = f.s.orderView(f.s.ownedOrder(f.m, o.order_id), {
    publicView: true,
  });
  assert.equal(before.fee_percent, "1.50");
  assert.equal(before.payable_amount, o.payable_amount);
  assert.throws(
    () => f.s.updateProjectSettings(f.m, f.p.id, { fee_percent: "10.01" }),
    (e) => e.code === "INVALID_FEE",
  );
  assert.throws(
    () =>
      f.s.updateProjectSettings(f.m, f.p.id, {
        logo_data_url: "data:image/svg+xml;base64,PHN2Zz4=",
      }),
    (e) => e.code === "INVALID_LOGO",
  );
  const other = f.s.register({
    email: "outsider@example.test",
    password: "strong-password-123",
  });
  assert.throws(
    () => f.s.projectSettings(other, f.p.id),
    (e) => e.code === "NOT_FOUND",
  );
  f.s.close();
});
test("a transaction predating deferred method allocation cannot pay the later quote", () => {
  const f = fixture();
  const o = f.s.createOrder(f.m, { project_id: f.p.id, fiat_amount: "10.00" });
  f.s.run(
    "UPDATE orders SET created_at=? WHERE order_id=?",
    new Date(Date.now() - 120000).toISOString(),
    o.order_id,
  );
  const selected = f.s.selectMethod(
    f.s.ownedOrder(f.m, o.order_id),
    "bsc",
    "bsc-usdt",
  );
  assert.equal(
    f.s.ingest(
      transfer(selected, {
        block_time: new Date(Date.now() - 60000).toISOString(),
      }),
      { mode: "demo" },
    ).matched,
    false,
  );
  f.s.close();
});

test("SaaS hooks enforce quotas without breaking replay and only trusted internal options bypass order limits", () => {
  const f = fixture();
  const first = order(f, { merchant_order_id: "quota-replay" });
  f.s.enforceLimits = (m, resource) => {
    if (resource === "orders")
      throw Object.assign(new Error("quota exceeded"), {
        code: "QUOTA_EXCEEDED",
      });
  };
  assert.equal(
    order(f, { merchant_order_id: "quota-replay" }).order_id,
    first.order_id,
  );
  assert.throws(
    () => order(f, { skipLimits: true }),
    (e) => e.code === "QUOTA_EXCEEDED",
  );
  const internal = f.s.createOrder(
    f.m,
    {
      project_id: f.p.id,
      fiat_amount: "2.00",
      chain: "bsc",
      token_id: "bsc-usdt",
    },
    { skipLimits: true },
  );
  assert.ok(internal.order_id);
  f.s.close();
});
test("afterPaid hook executes once inside settlement transaction and failed hook rolls back inventory and payment", () => {
  const f = fixture();
  const p = f.s.createProduct(f.m, {
    project_id: f.p.id,
    name: "Subscription",
    price: "10.00",
  });
  f.s.importInventory(f.m, p.id, ["LICENSE"]);
  const o = order(f, { product_id: p.id });
  const tx = transfer(o);
  f.s.afterPaid = () => {
    throw Error("subscription activation failed");
  };
  assert.throws(() => f.s.ingest(tx, { mode: "demo" }), /activation failed/);
  assert.equal(f.s.ownedOrder(f.m, o.order_id).status, "pending");
  assert.equal(f.s.get("SELECT order_id FROM inventory").order_id, null);
  let activations = 0;
  f.s.afterPaid = (paid) => {
    assert.equal(paid.status, "paid");
    activations++;
  };
  f.s.ingest(tx, { mode: "demo" });
  f.s.ingest(tx, { mode: "demo" });
  assert.equal(activations, 1);
  f.s.close();
});

test("legacy single-endpoint database migrates without losing pending events and supports event fanout", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "dujiao-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "test.sqlite");
  const old = new DatabaseSync(filename);
  old.exec(
    "CREATE TABLE endpoints(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL UNIQUE,url TEXT NOT NULL,secret TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE deliveries(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,endpoint_id TEXT,event_id TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,last_error TEXT,created_at TEXT NOT NULL,delivered_at TEXT);",
  );
  old
    .prepare("INSERT INTO endpoints VALUES(?,?,?,?,?,?)")
    .run(
      "ep1",
      "m1",
      "p1",
      "https://example.test/one",
      "legacy-secret",
      "2026-01-01",
    );
  old
    .prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "d1",
      "m1",
      "p1",
      "ep1",
      "event-old",
      "order.paid",
      "{}",
      "retry",
      2,
      0,
      "old error",
      "2026-01-01",
      null,
    );
  old.close();
  const s = new Store({ filename, masterKey: Buffer.alloc(32, 7), registry });
  t.after(() => s.close());
  assert.equal(
    s.get("SELECT attempts FROM deliveries WHERE id=?", "d1").attempts,
    2,
  );
  s.run(
    "INSERT INTO endpoints VALUES(?,?,?,?,?,?)",
    "ep2",
    "m1",
    "p1",
    "https://example.test/two",
    s.encrypt("new-secret"),
    "2026-01-02",
  );
  const queued = s.enqueueEvent({
    merchant_id: "m1",
    project_id: "p1",
    event_id: "event-new",
    event_type: "order.paid",
    payload: { event_id: "event-new", event_type: "order.paid" },
  });
  assert.equal(queued.ids.length, 2);
  assert.equal(
    s.get("SELECT COUNT(*) AS n FROM deliveries WHERE event_id=?", "event-new")
      .n,
    2,
  );
  assert.equal(s.get("SELECT COUNT(*) AS n FROM endpoints").n, 2);
});

test("real billing quote limit serializes competing selections and excludes a switched order old quote", async () => {
  const { initializeBilling } = await import("../server/billing.mjs");
  const f = fixture();
  f.s.registry[0].tokens.push({ id: "bsc-usdc", symbol: "USDC", decimals: 18 });
  f.s.run(
    "UPDATE addresses SET token_ids=?,mode=?",
    JSON.stringify(["bsc-usdt", "bsc-usdc"]),
    "live",
  );
  f.s.run("UPDATE merchants SET mode='live'");
  f.m = f.s.merchant(f.m.id);
  f.s.config = {
    pricing: { stablePolicy: "parity" },
    bsc: {
      startBlock: 0,
      rpcUrl: "https://fixture.invalid",
      tokens: [
        { id: "bsc-usdt", contract: "0x" + "a".repeat(40), decimals: 18 },
        { id: "bsc-usdc", contract: "0x" + "b".repeat(40), decimals: 18 },
      ],
    },
  };
  const billing = initializeBilling(f.s);
  const limits = {
    ...billing.plan("free").limits,
    monthly_gmv: 10,
    monthly_gmv_soft: 8,
  };
  f.s.run(
    "UPDATE billing_plans SET limits_json=? WHERE id=?",
    JSON.stringify(limits),
    "free",
  );
  const allowed = [
    { chain: "bsc", token_id: "bsc-usdt" },
    { chain: "bsc", token_id: "bsc-usdc" },
  ];
  const a = f.s.createOrder(f.m, {
    project_id: f.p.id,
    fiat_amount: "5.00",
    allowed_methods: allowed,
  });
  const b = f.s.createOrder(f.m, {
    project_id: f.p.id,
    fiat_amount: "5.00",
    allowed_methods: allowed,
  });
  const results = await Promise.allSettled(
    [a, b].map((o) =>
      Promise.resolve().then(() =>
        f.s.selectMethod(f.s.ownedOrder(f.m, o.order_id), "bsc", "bsc-usdt"),
      ),
    ),
  );
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.find((x) => x.status === "rejected").reason.code,
    "BILLING_GMV_LIMIT",
  );
  assert.equal(f.s.get("SELECT COUNT(*) AS n FROM amount_reservations").n, 1);
  const selected = results.find((x) => x.status === "fulfilled").value;
  const failedOrder = f.s.ownedOrder(
    f.m,
    selected.order_id === a.order_id ? b.order_id : a.order_id,
  );
  assert.equal(failedOrder.status, "awaiting_payment");
  assert.equal(failedOrder.payable_atomic, null);
  const switched = f.s.selectMethod(
    f.s.ownedOrder(f.m, selected.order_id),
    "bsc",
    "bsc-usdc",
  );
  assert.equal(switched.status, "pending");
  assert.equal(switched.payable_amount, "5.000100000000000000");
  assert.equal(f.s.get("SELECT COUNT(*) AS n FROM amount_reservations").n, 2);
  assert.throws(
    () =>
      f.s.createOrder(f.m, {
        project_id: f.p.id,
        fiat_amount: "5.00",
        chain: "bsc",
        token_id: "bsc-usdt",
        skipLimits: true,
      }),
    (error) => error.code === "BILLING_GMV_LIMIT",
  );
  assert.equal(f.s.get("SELECT COUNT(*) AS n FROM orders").n, 2);
  f.s.close();
});
