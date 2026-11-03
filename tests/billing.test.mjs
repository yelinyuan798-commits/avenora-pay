import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Store, AppError } from "../server/core.mjs";
import { initializeBilling, registerBilling } from "../server/billing.mjs";
import { registerExtensions } from "../server/extensions.mjs";

const registry = [
  {
    id: "bsc",
    name: "BSC",
    confirmations: 15,
    tokens: [{ id: "bsc-usdt", symbol: "USDT", decimals: 18 }],
  },
];
async function environment(t, { enabled = true } = {}) {
  let time = Date.now();
  const store = new Store({
    registry,
    config: {
      pricing: { stablePolicy: "parity" },
      bsc: {
        enabled: true,
        rpcUrl: "https://fixture.invalid",
        startBlock: 0,
        tokens: [
          { id: "bsc-usdt", contract: "0x" + "a".repeat(40), decimals: 18 },
        ],
      },
    },
  });
  const admin = store.register({
    email: "operator@example.test",
    name: "Operator",
    password: "test-operator-password",
  });
  const buyer = store.register({
    email: "buyer@example.test",
    name: "Buyer",
    password: "test-buyer-password",
  });
  const other = store.register({
    email: "other@example.test",
    name: "Other",
    password: "test-other-password",
  });
  const ownerProject = store.createProject(admin, { name: "Platform billing" });
  store.addAddress(admin, {
    project_id: ownerProject.id,
    chain: "bsc",
    address: "0x" + "1".repeat(40),
  });
  store.config.billing = {
    enabled,
    adminMerchantId: admin.id,
    ownerProjectId: ownerProject.id,
  };
  const billing = initializeBilling(store, { now: () => time });
  const app = express();
  app.use(express.json());
  const merchants = new Map([admin, buyer, other].map((m) => [m.id, m]));
  app.use((req, res, next) => {
    req.merchant = merchants.get(req.headers["x-test-merchant"]) || null;
    next();
  });
  registerBilling(app, { store });
  registerExtensions(app, { store });
  app.use((error, req, res, next) =>
    res
      .status(error instanceof AppError ? error.status : 500)
      .json({ error: { code: error.code, message: error.message } }),
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    store.close();
  });
  async function req(
    path,
    { merchant, body, method = body === undefined ? "GET" : "POST" } = {},
  ) {
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(merchant ? { "x-test-merchant": merchant.id } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  function settle(orderId) {
    let order = store.get("SELECT * FROM orders WHERE order_id=?", orderId);
    if (!order.chain) {
      store.transaction(() => store.selectMethod(order, "bsc", "bsc-usdt"));
      order = store.get("SELECT * FROM orders WHERE order_id=?", orderId);
    }
    return store.ingest({
      chain: order.chain,
      token_id: order.token_id,
      tx_hash: "fixture-" + orderId,
      event_index: 0,
      to_address: order.pay_address,
      from_address: "fixture-payer",
      amount_atomic: order.payable_atomic,
      block_height: 100,
      block_hash: "fixture-block",
      block_time: order.created_at,
      confirmations: 15,
      confirmed: true,
      removed: false,
    });
  }
  return {
    store,
    billing,
    admin,
    buyer,
    other,
    ownerProject,
    merchants,
    req,
    settle,
    advance: (milliseconds) => {
      time += milliseconds;
    },
  };
}

test("subscription checkout fails closed until platform collection is configured", async (t) => {
  const e = await environment(t, { enabled: false });
  const state = await e.req("/api/subscription", { merchant: e.buyer });
  assert.equal(state.body.plan.id, "free");
  assert.equal(state.body.billing_enabled, false);
  assert.equal(
    (
      await e.req("/api/billing/checkout", {
        merchant: e.buyer,
        body: { plan_id: "starter", idempotency_key: "disabled-request-0001" },
      })
    ).body.error.code,
    "BILLING_DISABLED",
  );
  assert.equal((await e.req("/plans")).body.plans.length, 4);
  e.store.config.billing.enabled = true;
  e.store.run("UPDATE addresses SET enabled=0 WHERE merchant_id=?", e.admin.id);
  assert.equal(
    (await e.req("/api/subscription", { merchant: e.buyer })).body
      .billing_enabled,
    false,
  );
  assert.equal(e.store.get("SELECT COUNT(*) AS n FROM billing_invoices").n, 0);
});

test("paid chain settlement activates once, renews once, and rejects forged or cross-tenant changes", async (t) => {
  const e = await environment(t);
  const request = {
    plan_id: "starter",
    idempotency_key: "invoice-request-0001",
    status: "paid",
    amount: "0.01",
    merchant_id: e.other.id,
  };
  const first = await e.req("/api/billing/checkout", {
    merchant: e.buyer,
    body: request,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.invoice.amount, "10.00");
  assert.equal(e.billing.subscription(e.buyer).status, "free");
  assert.equal(
    (await e.req("/api/billing/checkout", { merchant: e.buyer, body: request }))
      .body.invoice.id,
    first.body.invoice.id,
  );
  assert.equal(
    (
      await e.req(`/api/billing/invoices/${first.body.invoice.id}/simulate`, {
        merchant: e.buyer,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await e.req(`/api/billing/invoices/${first.body.invoice.id}/cancel`, {
        merchant: e.other,
        body: {},
      })
    ).status,
    404,
  );
  assert.throws(
    () =>
      e.billing.afterPaid({
        order_id: first.body.invoice.order_id,
        status: "paid",
      }),
    (error) => error.code === "BILLING_PAYMENT_UNVERIFIED",
  );
  e.settle(first.body.invoice.order_id);
  const activated = e.billing.subscription(e.buyer);
  assert.equal(activated.effective_plan_id, "starter");
  assert.equal(activated.source, "payment");
  e.settle(first.body.invoice.order_id);
  assert.equal(
    e.billing.subscription(e.buyer).expires_at,
    activated.expires_at,
  );
  assert.equal(
    (await e.req("/api/billing", { merchant: e.other })).body.invoices.length,
    0,
  );
  const paid = (await e.req("/api/billing", { merchant: e.buyer })).body
    .invoices[0];
  assert.equal(paid.status, "paid");
  assert.ok(paid.activated_at);
  assert.equal(
    (
      await e.req("/api/billing/checkout", {
        merchant: e.buyer,
        body: { plan_id: "pro", idempotency_key: "switch-request-00001" },
      })
    ).body.error.code,
    "PLAN_CHANGE_REQUIRES_EXPIRY",
  );
  const renewal = await e.req("/api/billing/checkout", {
    merchant: e.buyer,
    body: { plan_id: "starter", idempotency_key: "renewal-request-0001" },
  });
  e.settle(renewal.body.invoice.order_id);
  assert.ok(
    Date.parse(e.billing.subscription(e.buyer).expires_at) >
      Date.parse(activated.expires_at),
  );
  assert.equal(
    e.billing.usage(e.admin).monthly_gmv.used,
    "0.000000000000000000",
  );
  assert.equal(e.billing.subscription(e.other).status, "free");
});

test("admin is a configured merchant ID, manual grants are audited without fake paid invoices, expiry restores free limits", async (t) => {
  const e = await environment(t);
  assert.equal((await e.req("/api/platform/plans")).status, 401);
  assert.equal(
    (await e.req("/api/platform/plans", { merchant: e.buyer })).status,
    403,
  );
  assert.equal(
    (
      await e.req(`/api/platform/merchants/${e.buyer.id}/grant`, {
        merchant: e.buyer,
        body: { plan_id: "business", days: 30, reason: "fake" },
      })
    ).status,
    403,
  );
  const granted = await e.req(`/api/platform/merchants/${e.buyer.id}/grant`, {
    merchant: e.admin,
    body: {
      plan_id: "starter",
      days: 1,
      reason: "Manual trial approved by operator",
    },
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.subscription.source, "admin_grant");
  e.store.createProject(e.buyer, { name: "Project A" });
  e.store.createProject(e.buyer, { name: "Project B" });
  assert.equal(e.store.get("SELECT COUNT(*) AS n FROM billing_invoices").n, 0);
  assert.equal(
    (await e.req("/api/platform/grants", { merchant: e.admin })).body.actions
      .length,
    1,
  );
  e.advance(2 * 86400000);
  assert.equal(e.billing.subscription(e.buyer).status, "grace");
  assert.equal(e.billing.subscription(e.buyer).effective_plan_id, "starter");
  assert.ok(e.billing.subscription(e.buyer).grace_until);
  e.advance(3 * 86400000);
  assert.equal(e.billing.subscription(e.buyer).effective_plan_id, "free");
  assert.throws(
    () => e.store.createProject(e.buyer, { name: "Project C" }),
    (error) => error.code === "BILLING_RESOURCE_LIMIT",
  );
});

test("grace renewals start from now, plan changes wait for grace, and zero grace expires immediately", async (t) => {
  const e = await environment(t);
  e.billing.grant(e.admin, e.buyer.id, {
    plan_id: "starter",
    days: 1,
    reason: "Grace test",
  });
  const prior = e.billing.subscription(e.buyer);
  e.advance(2 * 86400000);
  const grace = e.billing.subscription(e.buyer);
  assert.equal(grace.status, "grace");
  assert.equal(
    Date.parse(grace.grace_until) - Date.parse(prior.expires_at),
    3 * 86400000,
  );
  assert.throws(
    () =>
      e.billing.checkout(e.buyer, {
        plan_id: "pro",
        idempotency_key: "grace-plan-change-001",
      }),
    (error) => error.code === "PLAN_CHANGE_REQUIRES_EXPIRY",
  );
  const renewed = e.billing.checkout(e.buyer, {
    plan_id: "starter",
    idempotency_key: "grace-same-renew-0001",
  });
  const nowBefore = e.billing.now();
  e.settle(renewed.order_id);
  assert.equal(e.billing.subscription(e.buyer).status, "active");
  assert.equal(
    Date.parse(e.billing.subscription(e.buyer).starts_at),
    nowBefore,
  );
  assert.ok(
    Date.parse(e.billing.subscription(e.buyer).expires_at) >=
      nowBefore + 28 * 86400000,
  );
  e.billing.grant(e.admin, e.other.id, {
    plan_id: "starter",
    days: 1,
    reason: "No grace test",
  });
  e.store.config.billing.graceDays = 0;
  e.advance(86400000);
  assert.equal(e.billing.subscription(e.other).status, "expired");
  assert.equal(e.billing.subscription(e.other).effective_plan_id, "free");
});

test("resource, reserved order, and API rate quotas are enforced server-side", async (t) => {
  const e = await environment(t);
  await e.req("/api/platform/plans", {
    merchant: e.admin,
    method: "PATCH",
    body: {
      id: "free",
      limits: {
        monthly_paid: 2,
        monthly_paid_soft: 1,
        active_orders: 2,
        api_requests: 2,
      },
    },
  });
  const p = e.store.createProject(e.buyer, { name: "Buyer project" });
  assert.throws(
    () => e.store.createProject(e.buyer, { name: "Extra project" }),
    (error) => error.code === "BILLING_RESOURCE_LIMIT",
  );
  e.store.addAddress(e.buyer, {
    project_id: p.id,
    chain: "bsc",
    address: "0x" + "2".repeat(40),
  });
  e.store.addAddress(e.buyer, {
    project_id: p.id,
    chain: "bsc",
    address: "0x" + "3".repeat(40),
  });
  assert.throws(
    () =>
      e.store.addAddress(e.buyer, {
        project_id: p.id,
        chain: "bsc",
        address: "0x" + "4".repeat(40),
      }),
    (error) => error.code === "BILLING_ADDRESS_PROJECT_LIMIT",
  );
  e.store.createKey(e.buyer, { project_id: p.id });
  e.store.createKey(e.buyer, { project_id: p.id });
  assert.throws(
    () => e.store.createKey(e.buyer, { project_id: p.id }),
    (error) => error.code === "BILLING_RESOURCE_LIMIT",
  );
  const payload = {
    project_id: p.id,
    name: "Pay",
    amount_mode: "fixed",
    amount: "1",
    currency: "USD",
  };
  assert.equal(
    (await e.req("/api/payment-links", { merchant: e.buyer, body: payload }))
      .status,
    201,
  );
  assert.equal(
    (await e.req("/api/payment-links", { merchant: e.buyer, body: payload }))
      .status,
    201,
  );
  assert.equal(
    (await e.req("/api/payment-links", { merchant: e.buyer, body: payload }))
      .status,
    402,
  );
  const o1 = e.store.createOrder(e.buyer, {
    project_id: p.id,
    fiat_amount: "2",
    chain: "bsc",
    token_id: "bsc-usdt",
  });
  const o2 = e.store.createOrder(e.buyer, {
    project_id: p.id,
    fiat_amount: "3",
    chain: "bsc",
    token_id: "bsc-usdt",
  });
  assert.throws(
    () => e.store.createOrder(e.buyer, { project_id: p.id, fiat_amount: "1" }),
    (error) => error.code === "BILLING_ACTIVE_ORDER_LIMIT",
  );
  e.settle(o1.order_id);
  e.settle(o2.order_id);
  assert.throws(
    () => e.store.createOrder(e.buyer, { project_id: p.id, fiat_amount: "1" }),
    (error) => error.code === "BILLING_MONTHLY_ORDER_LIMIT",
  );
  e.store.enforceLimits(e.buyer, "api_requests");
  e.store.enforceLimits(e.buyer, "api_requests");
  assert.throws(
    () => e.store.enforceLimits(e.buyer, "api_requests"),
    (error) => error.status === 429,
  );
  e.advance(60000);
  assert.doesNotThrow(() => e.store.enforceLimits(e.buyer, "api_requests"));
});

test("GMV reservations include payable tail and cannot be bypassed by forged subscription metadata", async (t) => {
  const e = await environment(t);
  const updated = await e.req("/api/platform/plans", {
    merchant: e.admin,
    method: "PATCH",
    body: { id: "free", limits: { monthly_gmv: 10, monthly_gmv_soft: 8 } },
  });
  assert.equal(updated.status, 200);
  const p = e.store.createProject(e.buyer, { name: "Quoted shop" });
  e.store.addAddress(e.buyer, {
    project_id: p.id,
    chain: "bsc",
    address: "0x" + "5".repeat(40),
  });
  const first = e.store.createOrder(e.buyer, {
    project_id: p.id,
    fiat_amount: "5",
    chain: "bsc",
    token_id: "bsc-usdt",
    metadata: { kind: "platform_subscription" },
  });
  assert.throws(
    () =>
      e.store.createOrder(e.buyer, {
        project_id: p.id,
        fiat_amount: "5",
        chain: "bsc",
        token_id: "bsc-usdt",
      }),
    (error) => error.code === "BILLING_GMV_LIMIT",
  );
  assert.equal(
    e.store.get(
      "SELECT COUNT(*) AS n FROM orders WHERE merchant_id=?",
      e.buyer.id,
    ).n,
    1,
  );
  e.settle(first.order_id);
  assert.equal(
    e.billing.usage(e.buyer).monthly_gmv.used,
    "5.000100000000000000",
  );
  assert.throws(
    () =>
      e.store.createOrder(e.buyer, {
        project_id: p.id,
        fiat_amount: "5",
        chain: "bsc",
        token_id: "bsc-usdt",
      }),
    (error) => error.code === "BILLING_GMV_LIMIT",
  );
});

test("demo subscription payments stay isolated and do not require real collection configuration", async (t) => {
  const e = await environment(t, { enabled: false });
  const demo = e.store.demoMerchant();
  e.merchants.set(demo.id, demo);
  const created = await e.req("/api/billing/checkout", {
    merchant: demo,
    body: { plan_id: "pro", idempotency_key: "demo-invoice-request1" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const paid = await e.req(
    `/api/billing/invoices/${created.body.invoice.id}/simulate`,
    { merchant: demo, body: {} },
  );
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.subscription.effective_plan_id, "pro");
  assert.equal(paid.body.subscription.source, "demo_payment");
  assert.equal(e.billing.subscription(e.buyer).effective_plan_id, "free");
  assert.equal(
    (await e.req("/api/subscription", { merchant: e.buyer })).body
      .billing_enabled,
    false,
  );
  assert.equal(
    (await e.req("/api/platform/plans", { merchant: demo })).status,
    403,
  );
});
