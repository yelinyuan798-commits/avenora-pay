import test from "node:test";
import assert from "node:assert/strict";
import { Store, nowISO } from "../server/core.mjs";
import { createApp } from "../server/app.mjs";

const registry = [{
  id: "bsc", name: "BNB Smart Chain", confirmations: 12,
  tokens: [
    { id: "bsc-usdt", symbol: "USDT", decimals: 18 },
    { id: "bsc-bnb", symbol: "BNB", decimals: 18 },
  ],
}, {
  id: "ethereum", name: "Ethereum", confirmations: 12,
  tokens: [{ id: "ethereum-usdt", symbol: "USDT", decimals: 6 }],
}];
const chainConfig = () => ({
  pricing: { stablePolicy: "parity" },
  bsc: {
    enabled: true, startBlock: 1, rpcUrl: "https://private-node.example.test/key",
    tokens: [
      { id: "bsc-usdt", contract: "0x" + "a".repeat(40), decimals: 18 },
      { id: "bsc-bnb", native: true, decimals: 18 },
    ],
  },
});
async function environment(t, { config = chainConfig(), mode = "live", production = false, prepare } = {}) {
  const store = new Store({ registry, config });
  const merchant = store.register({ email: "merchant@example.test", password: "test-password-123", name: "Merchant" }, mode);
  const other = store.register({ email: "other@example.test", password: "test-password-456", name: "Other" }, mode);
  const prepared = prepare?.(store, merchant, other);
  const app = createApp({ store, mode, production, ...(production ? { publicBaseUrl: "https://demo.example.test" } : {}) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map([merchant, other].map((m) => [m.id, "djp_session=" + store.session(m)]));
  t.after(() => { server.close(); store.close(); });
  async function req(path = "/api/onboarding", { user = merchant, body, method = body ? "POST" : "GET" } = {}) {
    const response = await fetch(base + path, {
      method, headers: {
        "Content-Type": "application/json", Origin: production ? "https://demo.example.test" : base,
        ...(user ? { Cookie: cookies.get(user.id) || "djp_session=" + store.session(user) } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }
  const project = (user = merchant, name = "Store") => store.createProject(user, { name });
  const address = (p, user = merchant, digit = "1", tokenIds) => store.addAddress(user, {
    project_id: p.id, chain: "bsc", address: user.mode === "demo" ? `demo:${digit}` : "0x" + digit.repeat(40),
    token_ids: tokenIds,
  });
  return { store, merchant, other, req, project, address, prepared };
}

test("onboarding requires authentication and a new merchant starts on Free without inherited resources", async (t) => {
  const e = await environment(t, { config: {} });
  assert.equal((await e.req(undefined, { user: null })).status, 401);
  const registration = await e.req("/api/auth/register", {
    user: null,
    body: { email: "new@example.test", password: "new-merchant-password" },
  });
  assert.equal(registration.status, 201);
  const fresh = e.store.merchant(registration.body.user.id);
  const result = await e.req(undefined, { user: fresh });
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "live");
  assert.equal(result.body.plan.id, "free");
  assert.equal(result.body.subscription.status, "free");
  assert.equal(result.body.billing_enabled, false);
  assert.match(result.body.billing_unavailable_reason, /尚未/);
  assert.deepEqual(result.body.projects, []);
  assert.deepEqual(result.body.supported_chains, []);
  assert.equal(result.body.next_step, "project");
  assert.equal(result.body.collection_ready, false);
  assert.equal(result.body.setup_ready, false);
  assert.equal(result.body.pending_invoice, null);
  assert.equal(e.store.billing.isAdmin(fresh), false);
});

test("configured addresses and token registry alone cannot mark live collection ready", async (t) => {
  const e = await environment(t, { config: {} });
  const p = e.project();
  e.address(p);
  let state = (await e.req()).body;
  assert.equal(state.projects[0].address_count, 1);
  assert.equal(state.projects[0].enabled_address_count, 1);
  assert.equal(state.projects[0].collection_ready, false);
  assert.deepEqual(state.projects[0].available_methods, []);
  assert.equal(state.next_step, "address");

  Object.assign(e.store.config, chainConfig());
  state = (await e.req()).body;
  assert.equal(state.supported_chains.length, 1);
  assert.equal(state.supported_chains[0].id, "bsc");
  assert.equal(state.supported_chains[0].tokens.find((x) => x.id === "bsc-usdt").quote_ready, true);
  assert.equal(state.supported_chains[0].tokens.find((x) => x.id === "bsc-bnb").quote_ready, false);
  assert.deepEqual(state.projects[0].available_methods, [{ chain: "bsc", token_id: "bsc-usdt" }]);
  assert.equal(state.collection_ready, true);
  assert.equal(state.setup_ready, false);
  assert.equal(state.next_step, "integration");
  assert.equal(JSON.stringify(state).includes("private-node"), false);
  assert.equal(JSON.stringify(state).includes("0x" + "1".repeat(40)), false);
  e.store.run("UPDATE addresses SET enabled=0 WHERE project_id=?", p.id);
  assert.equal((await e.req()).body.collection_ready, false);
});

test("native-coin onboarding availability follows trusted price freshness", async (t) => {
  const e = await environment(t);
  const p = e.project();
  e.address(p, e.merchant, "1", ["bsc-bnb"]);
  let state = (await e.req()).body;
  assert.equal(state.collection_ready, false);
  assert.equal(state.collection_configured, true);
  assert.equal(state.next_step, "integration");
  assert.match(state.collection_unavailable_reason, /无需重复添加/);
  e.store.priceBook.recordAsset("BNB", "500");
  assert.equal((await e.req()).body.collection_ready, true);
  assert.equal((await e.req("/api/payment-links", { body: { project_id: p.id, name: "BNB payment", amount: "1.00" } })).status, 201);
  assert.equal((await e.req()).body.setup_ready, true);
  e.store.priceBook.recordAsset("BNB", "500", { observedAt: new Date(Date.now() - 600_000).toISOString() });
  state = (await e.req()).body;
  assert.equal(state.collection_ready, false);
  assert.equal(state.collection_configured, true);
  assert.equal(state.projects[0].collection_configured, true);
  assert.equal(state.setup_configured, true);
  assert.equal(state.setup_ready, false);
  assert.equal(state.next_step, "ready");
});

test("tenant resources and secrets never cross onboarding summaries or query parameters", async (t) => {
  const e = await environment(t);
  const own = e.project(), foreign = e.project(e.other, "Foreign project secret name");
  e.address(own);
  e.address(foreign, e.other, "2");
  const key = e.store.createKey(e.other, { project_id: foreign.id, name: "Secret key" });
  const product = e.store.createProduct(e.other, { project_id: foreign.id, name: "Foreign stock", price: "1.00" });
  e.store.importInventory(e.other, product.id, ["PRIVATE-LICENSE-CONTENT"]);
  const state = (await e.req(`/api/onboarding?merchant_id=${e.other.id}&project_id=${foreign.id}`)).body;
  assert.deepEqual(state.projects.map((x) => x.id), [own.id]);
  assert.equal(state.projects[0].products_count, 0);
  assert.equal(state.projects[0].api_keys_count, 0);
  assert.equal(state.projects[0].inventory_count, 0);
  const encoded = JSON.stringify(state);
  for (const secret of [foreign.id, "Foreign project", "PRIVATE-LICENSE-CONTENT", key.secret])
    assert.equal(encoded.includes(secret), false);
});

test("integration readiness requires resources in the same project and respects revocation and stock", async (t) => {
  const e = await environment(t, { prepare(store, merchant) {
    return [store.createProject(merchant, { name: "First" }), store.createProject(merchant, { name: "Second" })];
  } });
  const [a, b] = e.prepared;
  e.address(a); e.address(b, e.merchant, "2");
  const keyA = e.store.createKey(e.merchant, { project_id: a.id, name: "First key" });
  e.store.run("INSERT INTO endpoints VALUES(?,?,?,?,?,?)", "webhook-b", e.merchant.id, b.id, "https://callback.example.test", e.store.encrypt("webhook-private-secret"), nowISO());
  e.store.run("INSERT INTO endpoint_state VALUES(?,1)", "webhook-b");
  let state = (await e.req()).body;
  assert.equal(state.setup_ready, false);
  assert.equal(state.projects.every((x) => !x.api_integration_ready), true);
  const keyB = e.store.createKey(e.merchant, { project_id: b.id, name: "Second key" });
  state = (await e.req()).body;
  assert.equal(state.projects.find((x) => x.id === b.id).api_integration_ready, true);
  assert.equal(state.next_step, "ready");
  e.store.run("UPDATE api_keys SET revoked=1 WHERE id=?", keyB.id);
  assert.equal((await e.req()).body.setup_ready, false);
  const product = e.store.createProduct(e.merchant, { project_id: a.id, name: "Code", price: "1.00" });
  assert.equal((await e.req()).body.setup_ready, false);
  e.store.importInventory(e.merchant, product.id, ["PRIVATE-CODE"]);
  state = (await e.req()).body;
  assert.equal(state.projects.find((x) => x.id === a.id).digital_delivery_ready, true);
  assert.equal(state.projects.find((x) => x.id === a.id).inventory_count, 1);
  assert.equal(JSON.stringify(state).includes("PRIVATE-CODE"), false);
  assert.equal(JSON.stringify(state).includes(keyA.secret), false);
  e.store.run("UPDATE inventory SET order_id='fixture-used' WHERE product_id=?", product.id);
  assert.equal((await e.req()).body.setup_ready, false);
  const created = await e.req("/api/payment-links", { body: { project_id: a.id, name: "Pay", amount: "1.00" } });
  assert.equal(created.status, 201);
  assert.equal((await e.req()).body.projects.find((x) => x.id === a.id).payment_link_ready, true);
  e.store.run("UPDATE payment_links SET enabled=0 WHERE id=?", created.body.id);
  assert.equal((await e.req()).body.setup_ready, false);
});

test("subscription resume returns only the merchant's usable invoice without activating it", async (t) => {
  const e = await environment(t);
  const ownerProject = e.project(e.other, "Platform billing");
  e.address(ownerProject, e.other, "2");
  e.store.config.billing = { enabled: true, adminMerchantId: e.other.id, ownerProjectId: ownerProject.id };
  const checkout = await e.req("/api/billing/checkout", { body: { plan_id: "starter", idempotency_key: "onboarding-invoice-001" } });
  assert.equal(checkout.status, 201);
  let state = (await e.req()).body;
  assert.equal(state.billing_enabled, true);
  assert.equal(state.pending_invoice.id, checkout.body.invoice.id);
  assert.equal(state.pending_invoice.checkout_url, checkout.body.invoice.checkout_url);
  assert.equal(state.subscription.status, "free");
  assert.equal(JSON.stringify(state).includes(ownerProject.id), false);
  assert.equal((await e.req(undefined, { user: e.other })).body.pending_invoice, null);
  e.store.run("UPDATE orders SET expires_at=?,selection_deadline=? WHERE order_id=?", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", checkout.body.invoice.order_id);
  state = (await e.req()).body;
  assert.equal(state.pending_invoice, null);
  assert.equal(state.subscription.status, "free");
  assert.equal(e.store.get("SELECT status FROM billing_invoices WHERE id=?", checkout.body.invoice.id).status, "pending");
});

test("demo readiness stays explicitly simulated and public demo rejects live sessions", async (t) => {
  const e = await environment(t, { config: {}, mode: "demo", production: true });
  const p = e.project(); e.address(p);
  const state = (await e.req()).body;
  assert.equal(state.mode, "demo");
  assert.equal(state.collection_ready, true);
  assert.equal(state.billing_enabled, true);
  const live = e.store.register({ email: "live@example.test", password: "live-password-123" });
  assert.equal((await e.req(undefined, { user: live })).status, 401);
});
