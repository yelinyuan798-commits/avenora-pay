import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core.mjs";
import { createApp } from "../server/app.mjs";
import {
  PaymentClient,
  signedHeaders,
  verifyWebhook,
} from "../scripts/sdk.mjs";
import { createWorker } from "../server/worker.mjs";
const registry = [
  {
    id: "bsc",
    name: "BNB Smart Chain",
    confirmations: 12,
    tokens: [{ id: "bsc-usdt", symbol: "USDT", decimals: 18 }],
  },
];
async function environment(t, mode = "demo") {
  const store = new Store({ registry });
  const app = createApp({ store, mode });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    store.close();
  });
  return {
    store,
    base,
    async req(url, options = {}) {
      const response = await fetch(base + url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      return {
        status: response.status,
        body: await response.json(),
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    },
  };
}
test("isolated demo session supports real API workflow and public checkout without leaking secrets", async (t) => {
  const e = await environment(t);
  const login = await e.req("/api/auth/demo", { method: "POST", body: "{}" });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /djp_session=/);
  const headers = { Cookie: login.cookie, Origin: e.base };
  const products = await e.req("/api/products", { headers });
  const p = products.body.products[0];
  const created = await e.req("/api/orders", {
    method: "POST",
    headers,
    body: JSON.stringify({
      project_id: p.project_id,
      product_id: p.id,
      chain: "bsc",
      token_id: "bsc-usdt",
    }),
  });
  assert.equal(created.status, 201);
  const state = await e.req(`/checkout/${created.body.checkout_token}/state`);
  assert.equal(state.body.status, "pending");
  assert.equal(state.body.checkout_token, undefined);
  assert.equal(state.body.delivery, null);
  const paid = await e.req(`/api/orders/${created.body.order_id}/simulate`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(paid.body.status, "paid");
  const delivered = await e.req(
    `/checkout/${created.body.checkout_token}/state`,
  );
  assert.match(delivered.body.delivery, /DEMO-LICENSE/);
});
test("CSRF, unauthenticated writes, tenant crossing and fake provider callbacks are rejected", async (t) => {
  const e = await environment(t);
  assert.equal((await e.req("/api/projects")).status, 401);
  const a = await e.req("/api/auth/demo", { method: "POST", body: "{}" });
  const b = await e.req("/api/auth/demo", { method: "POST", body: "{}" });
  const project = (
    await e.req("/api/projects", { headers: { Cookie: a.cookie } })
  ).body.projects[0];
  assert.equal(
    (
      await e.req("/api/projects", {
        method: "POST",
        headers: { Cookie: a.cookie, Origin: "https://attacker.invalid" },
        body: '{"name":"Bad"}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await e.req("/api/projects", {
        method: "POST",
        headers: { Cookie: a.cookie },
        body: '{"name":"Bad"}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await e.req("/api/orders", {
        method: "POST",
        headers: { Cookie: b.cookie, Origin: e.base },
        body: JSON.stringify({ project_id: project.id, fiat_amount: "10" }),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await e.req("/api/payment/callback", {
        method: "POST",
        headers: { Cookie: a.cookie, Origin: e.base },
        body: '{"status":"paid"}',
      })
    ).status,
    404,
  );
});
test("live mode disables demo, unconfigured live payment and simulation", async (t) => {
  const e = await environment(t, "live");
  assert.equal(
    (await e.req("/api/auth/demo", { method: "POST", body: "{}" })).status,
    403,
  );
  const a = await e.req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: "live@example.test",
      password: "strong-password-123",
    }),
  });
  const headers = { Cookie: a.cookie, Origin: e.base };
  const p = await e.req("/api/projects", {
    method: "POST",
    headers,
    body: '{"name":"Live"}',
  });
  const o = await e.req("/api/orders", {
    method: "POST",
    headers,
    body: JSON.stringify({ project_id: p.body.id, fiat_amount: "10" }),
  });
  assert.equal(o.body.error.code, "PAYMENT_UNCONFIGURED");
});
test("SDK signed requests roundtrip, canonical query matches, revoked credentials fail", async (t) => {
  const e = await environment(t);
  const a = await e.req("/api/auth/demo", { method: "POST", body: "{}" });
  const headers = { Cookie: a.cookie, Origin: e.base };
  const p = (await e.req("/api/projects", { headers })).body.projects[0];
  const key = (
    await e.req("/api/keys", {
      method: "POST",
      headers,
      body: JSON.stringify({ project_id: p.id, name: "Integration" }),
    })
  ).body;
  const sdk = new PaymentClient({
    baseUrl: e.base,
    keyId: key.key_id,
    secret: key.secret,
  });
  assert.equal((await sdk.whoami()).project_id, p.id);
  assert.ok(
    (await sdk.request("GET", "/v1/orders", { query: "z=a+b&a=two&a=one" }))
      .orders.length,
  );
  const order = await sdk.createOrder({
    fiat_amount: "12.00",
    fiat_currency: "USD",
    chain: "bsc",
    token_id: "bsc-usdt",
    merchant_order_id: "SDK-TEST",
  });
  assert.equal((await sdk.getOrder(order.order_id)).order_id, order.order_id);
  await e.req("/api/keys/" + key.id, { method: "DELETE", headers, body: "{}" });
  await assert.rejects(
    () => sdk.whoami(),
    (error) => error.code === "INVALID_SIGNATURE",
  );
});
test("outbox signatures pass independent SDK verification and reject modified body", async (t) => {
  const e = await environment(t);
  const a = await e.req("/api/auth/demo", { method: "POST", body: "{}" });
  const headers = { Cookie: a.cookie, Origin: e.base };
  const p = (await e.req("/api/projects", { headers })).body.projects[0];
  const ep = (
    await e.req("/api/webhooks", {
      method: "POST",
      headers,
      body: JSON.stringify({
        project_id: p.id,
        url: "https://merchant.example.test/notify",
      }),
    })
  ).body;
  await e.req("/api/webhooks/test", {
    method: "POST",
    headers,
    body: JSON.stringify({ project_id: p.id }),
  });
  e.store.run("UPDATE merchants SET mode='live'");
  const sent = [];
  const worker = createWorker({
    store: e.store,
    scanChain: async () => ({ transactions: [] }),
    post: async (url, payload) => {
      sent.push(payload);
      return { status: 200 };
    },
  });
  await worker.deliver();
  assert.ok(sent.length);
  assert.equal(
    verifyWebhook({
      secret: ep.secret,
      headers: sent[0].headers,
      rawBody: sent[0].body,
    }),
    true,
  );
  assert.equal(
    verifyWebhook({
      secret: ep.secret,
      headers: sent[0].headers,
      rawBody: "{}",
    }),
    false,
  );
});
test("idempotency key replays the original response even after settlement and conflicts on changed body", async (t) => {
  const e = await environment(t);
  const a = await e.req("/api/auth/demo", { method: "POST", body: "{}" });
  const headers = { Cookie: a.cookie, Origin: e.base };
  const p = (await e.req("/api/projects", { headers })).body.projects[0];
  const key = (
    await e.req("/api/keys", {
      method: "POST",
      headers,
      body: JSON.stringify({ project_id: p.id }),
    })
  ).body;
  const sdk = new PaymentClient({
    baseUrl: e.base,
    keyId: key.key_id,
    secret: key.secret,
  });
  const payload = { fiat_amount: "5.00", chain: "bsc", token_id: "bsc-usdt" };
  const first = await sdk.createOrder(payload, "integration-key");
  assert.equal(first.status, "pending");
  await e.req("/api/orders/" + first.order_id + "/simulate", {
    method: "POST",
    headers,
    body: "{}",
  });
  const repeated = await sdk.createOrder(payload, "integration-key");
  assert.deepEqual(repeated, first);
  await assert.rejects(
    () =>
      sdk.createOrder({ ...payload, fiat_amount: "8.00" }, "integration-key"),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await sdk.getOrder(first.order_id)).status, "paid");
});

test("external order filters and deferred public selection agree with stored state", async (t) => {
  const e = await environment(t);
  const a = await e.req("/api/auth/demo", { method: "POST", body: "{}" });
  const headers = { Cookie: a.cookie, Origin: e.base };
  const p = (await e.req("/api/projects", { headers })).body.projects[0];
  const key = (
    await e.req("/api/keys", {
      method: "POST",
      headers,
      body: JSON.stringify({ project_id: p.id }),
    })
  ).body;
  const sdk = new PaymentClient({
    baseUrl: e.base,
    keyId: key.key_id,
    secret: key.secret,
  });
  const o = await sdk.createOrder({
    fiat_amount: "8.00",
    merchant_order_id: "DEFERRED-FILTER",
  });
  assert.equal(o.status, "awaiting_payment");
  assert.equal(o.expires_at, null);
  const listed = await sdk.listOrders({
    status: "awaiting_payment",
    created_after: "2020-01-01T00:00:00Z",
    created_before: "2099-01-01T00:00:00Z",
  });
  assert.equal(listed.total, 1);
  assert.equal(listed.orders[0].order_id, o.order_id);
  const state = await e.req("/checkout/" + o.checkout_token + "/state");
  assert.equal(state.body.status, "awaiting_payment");
  const selected = await e.req("/checkout/" + o.checkout_token + "/select", {
    method: "POST",
    headers: { Origin: e.base },
    body: '{"chain":"bsc","token_id":"bsc-usdt"}',
  });
  assert.equal(selected.body.status, "pending");
  assert.equal(selected.body.payable, true);
  assert.equal((await sdk.listOrders({ status: "awaiting_payment" })).total, 0);
  assert.ok(
    (await sdk.listOrders({ chain: "bsc", token_id: "bsc-usdt" })).total > 0,
  );
  await assert.rejects(
    () => sdk.listOrders({ created_after: "not-a-date" }),
    (error) => error.code === "INVALID_FILTER",
  );
});

test('multiple webhook endpoints fan out one event, pause independently, rotate secrets, and isolate ownership',async t=>{
 const e=await environment(t);const a=await e.req('/api/auth/demo',{method:'POST',body:'{}'});const headers={Cookie:a.cookie,Origin:e.base};const p=(await e.req('/api/projects',{headers})).body.projects[0];
 const one=(await e.req('/api/webhooks',{method:'POST',headers,body:JSON.stringify({project_id:p.id,url:'https://one.example.test/hook'})})).body;const two=(await e.req('/api/webhooks',{method:'POST',headers,body:JSON.stringify({project_id:p.id,url:'https://two.example.test/hook'})})).body;assert.notEqual(one.id,two.id);
 const testEvent=(await e.req('/api/webhooks/test',{method:'POST',headers,body:JSON.stringify({project_id:p.id})})).body;assert.equal(testEvent.ids.length,2);assert.equal(e.store.get('SELECT COUNT(*) AS n FROM deliveries WHERE event_id=?',testEvent.event_id).n,2);
 const disabled=await e.req('/api/webhooks/'+one.id,{method:'PATCH',headers,body:'{"enabled":false}'});assert.equal(disabled.body.enabled,false);assert.equal(e.store.get('SELECT status FROM deliveries WHERE event_id=? AND endpoint_id=?',testEvent.event_id,one.id).status,'paused');
 const selected=(await e.req('/api/webhooks/test',{method:'POST',headers,body:JSON.stringify({project_id:p.id,endpoint_id:two.id})})).body;assert.equal(selected.ids.length,1);const rotated=(await e.req('/api/webhooks/'+two.id+'/rotate',{method:'POST',headers,body:'{}'})).body;assert.notEqual(rotated.secret,two.secret);
 const worker=createWorker({store:e.store,scanChain:async()=>({transactions:[]})});await worker.deliver();assert.equal(e.store.get('SELECT status FROM deliveries WHERE id=?',selected.id).status,'delivered');assert.equal(e.store.get('SELECT status FROM deliveries WHERE event_id=? AND endpoint_id=?',testEvent.event_id,one.id).status,'paused');
 const b=await e.req('/api/auth/demo',{method:'POST',body:'{}'});assert.equal((await e.req('/api/webhooks/'+one.id,{method:'PATCH',headers:{Cookie:b.cookie,Origin:e.base},body:'{"enabled":true}'})).status,404);
});
test('dashboard project scope reports complete project totals and verifies ownership',async t=>{const e=await environment(t);const a=await e.req('/api/auth/demo',{method:'POST',body:'{}'});const headers={Cookie:a.cookie,Origin:e.base};const fresh=(await e.req('/api/projects',{method:'POST',headers,body:'{"name":"Empty project"}'})).body;const dashboard=await e.req('/api/dashboard?project_id='+fresh.id,{headers});assert.equal(dashboard.body.stats.total_orders,0);assert.equal(dashboard.body.chart.reduce((sum,x)=>sum+x.orders,0),0);assert.equal((await e.req('/api/dashboard?project_id=foreign',{headers})).status,404);});
