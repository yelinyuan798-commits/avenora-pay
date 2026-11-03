import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core.mjs";
import { createApp } from "../server/app.mjs";
import { signedHeaders } from "../scripts/sdk.mjs";

const origin = "https://demo.avenora.example";
const registry = [
  {
    id: "bsc",
    name: "BSC",
    confirmations: 15,
    tokens: [{ id: "bsc-usdt", symbol: "USDT", decimals: 18 }],
  },
];

async function setup(t, options = {}) {
  const store = new Store({ registry });
  const app = createApp({
    store,
    mode: "demo",
    production: true,
    publicBaseUrl: origin,
    ...options,
  });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(() => {
    server.close();
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function req(
    path,
    { body, method = body === undefined ? "GET" : "POST", headers = {} } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  return { store, req };
}

test("public production demo blocks live registration while keeping isolated nonpayable checkout usable", async (t) => {
  const { store, req } = await setup(t);
  const info = await req("/api/auth/me");
  assert.equal(info.body.public_demo, true);
  assert.equal(info.body.registration_enabled, false);
  assert.match(
    info.headers.get("content-security-policy"),
    /object-src 'none'/,
  );
  assert.match(
    info.headers.get("content-security-policy"),
    /img-src 'self' data:/,
  );
  const register = await req("/api/auth/register", {
    body: { email: "real@example.test", password: "fixture-password-123" },
  });
  assert.equal(register.status, 403);
  assert.equal(
    store.get("SELECT COUNT(*) AS n FROM merchants WHERE mode='live'").n,
    0,
  );
  const demo = await req("/api/auth/demo", { body: {} });
  assert.equal(demo.status, 200);
  assert.match(
    demo.headers.get("set-cookie"),
    /HttpOnly; SameSite=Strict;.*; Secure/,
  );
  const headers = { Cookie: demo.cookie };
  const repeated = await req("/api/auth/demo", { body: {}, headers });
  assert.equal(repeated.body.user.id, demo.body.user.id);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM merchants").n, 1);
  const product = (await req("/api/products", { headers })).body.products[0];
  const invalid = await req("/api/addresses", {
    headers,
    body: {
      project_id: product.project_id,
      chain: "bsc",
      address: "0x" + "1".repeat(40),
    },
  });
  assert.equal(invalid.body.error.code, "DEMO_ONLY");
  const order = await req("/api/orders", {
    headers,
    body: {
      project_id: product.project_id,
      product_id: product.id,
      chain: "bsc",
      token_id: "bsc-usdt",
    },
  });
  assert.equal(order.status, 201);
  assert.ok(order.body.checkout_url.startsWith(origin + "/checkout/"));
  assert.ok(order.body.pay_address.startsWith("demo:"));
  const state = await req(`/checkout/${order.body.checkout_token}/state`);
  assert.equal(state.body.mode, "demo");
  assert.equal(state.body.pricing.is_demo, true);
  const paid = await req(`/api/orders/${order.body.order_id}/simulate`, {
    headers,
    body: {},
  });
  assert.equal(paid.body.status, "paid");
  assert.match(paid.body.delivery, /DEMO-LICENSE/);
});

test("public demo rejects existing live sessions, logins, payment links, checkouts and API keys", async (t) => {
  const { store, req } = await setup(t);
  const merchant = store.register(
    { email: "fixture@example.test", password: "fixture-password-123" },
    "demo",
  );
  const project = store.createProject(merchant, { name: "Fixture" });
  store.addAddress(merchant, {
    project_id: project.id,
    chain: "bsc",
    address: "demo:fixture",
  });
  const order = store.createOrder(merchant, {
    project_id: project.id,
    fiat_amount: "12",
    chain: "bsc",
    token_id: "bsc-usdt",
  });
  const key = store.createKey(merchant, {
    project_id: project.id,
    name: "Fixture",
  });
  const session = store.session(merchant);
  const headers = { Cookie: "djp_session=" + session };
  const link = await req("/api/payment-links", {
    headers,
    body: {
      project_id: project.id,
      name: "Fixture",
      amount_mode: "fixed",
      amount: "12",
      currency: "USD",
    },
  });
  store.run("UPDATE merchants SET mode='live' WHERE id=?", merchant.id);
  store.run("UPDATE orders SET mode='live' WHERE order_id=?", order.order_id);
  assert.equal((await req("/api/projects", { headers })).status, 401);
  assert.equal(
    (
      await req("/api/auth/login", {
        body: { email: merchant.email, password: "fixture-password-123" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await req(`/checkout/${order.checkout_token}/state`)).status,
    403,
  );
  assert.equal(
    (await req(`/checkout/${order.checkout_token}/methods`)).status,
    403,
  );
  assert.equal(
    (
      await req(`/checkout/${order.checkout_token}/select`, {
        body: { chain: "bsc", token_id: "bsc-usdt" },
      })
    ).status,
    403,
  );
  assert.equal((await req(`/pay/${link.body.id}/state`)).status, 403);
  assert.equal(
    (await req(`/pay/${link.body.id}/orders`, { body: {} })).status,
    403,
  );
  const signature = signedHeaders({
    keyId: key.key_id,
    secret: key.secret,
    method: "GET",
    path: "/v1/whoami",
  });
  assert.equal((await req("/v1/whoami", { headers: signature })).status, 403);
});

test("trusted loopback proxy separates visitor creation limits and canonical origin rejects spoofed Host", async (t) => {
  const { req } = await setup(t, { trustProxy: "loopback" });
  for (let i = 0; i < 6; i++)
    assert.equal(
      (
        await req("/api/auth/demo", {
          body: {},
          headers: { "X-Forwarded-For": "198.51.100.10" },
        })
      ).status,
      200,
    );
  const limited = await req("/api/auth/demo", {
    body: {},
    headers: { "X-Forwarded-For": "198.51.100.10" },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "DEMO_RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(
    (
      await req("/api/auth/demo", {
        body: {},
        headers: { "X-Forwarded-For": "198.51.100.11" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await req("/api/auth/demo", {
        body: {},
        headers: {
          Origin: "https://spoof.example",
          "X-Forwarded-Host": "spoof.example",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-For": "198.51.100.12",
        },
      })
    ).status,
    403,
  );
});

test("untrusted forwarding cannot evade public demo creation limits, and total spaces are bounded", async (t) => {
  const { store, req } = await setup(t);
  let demo;
  for (let i = 0; i < 6; i++)
    demo = await req("/api/auth/demo", {
      body: {},
      headers: { "X-Forwarded-For": `198.51.100.${i + 1}` },
    });
  assert.equal(demo.status, 200);
  assert.equal(
    (
      await req("/api/auth/demo", {
        body: {},
        headers: { "X-Forwarded-For": "198.51.100.100" },
      })
    ).body.error.code,
    "DEMO_RATE_LIMITED",
  );
  for (let i = 6; i < 100; i++)
    store.run(
      "INSERT INTO merchants SELECT ?,?,name,password,mode,created_at FROM merchants LIMIT 1",
      `capacity-${i}`,
      `capacity-${i}@example.test`,
    );
  const reused = await req("/api/auth/demo", {
    headers: { Cookie: demo.cookie },
    body: {},
  });
  assert.equal(reused.status, 200);
  const app = createApp({
    store,
    mode: "demo",
    production: true,
    publicBaseUrl: origin,
    trustProxy: "loopback",
  });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/auth/demo`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Forwarded-For": "198.51.100.200",
      },
      body: "{}",
    },
  );
  assert.equal((await response.json()).error.code, "DEMO_CAPACITY");
});

test("production demo resource budgets cover orders, inventory, products, signed API and public links", async (t) => {
  const { store, req } = await setup(t);
  const demo = await req("/api/auth/demo", { body: {} });
  const merchant = store.merchant(demo.body.user.id),
    headers = { Cookie: demo.cookie };
  const project = store.all(
    "SELECT * FROM projects WHERE merchant_id=?",
    merchant.id,
  )[0];
  const product = store.all(
    "SELECT * FROM products WHERE merchant_id=?",
    merchant.id,
  )[0];
  const link = (
    await req("/api/payment-links", {
      headers,
      body: {
        project_id: project.id,
        name: "Test",
        amount_mode: "fixed",
        amount: "12",
        currency: "USD",
      },
    })
  ).body;
  const orderBody = {
    project_id: project.id,
    fiat_amount: "12",
    chain: "bsc",
    token_id: "bsc-usdt",
  };
  const key = store.createKey(merchant, {
    project_id: project.id,
    name: "Quota test",
  });
  const apiHeaders = () =>
    signedHeaders({
      keyId: key.key_id,
      secret: key.secret,
      method: "POST",
      path: "/v1/orders",
      body: JSON.stringify(orderBody),
    });
  const priorApi = await req("/v1/orders", {
    body: orderBody,
    headers: { ...apiHeaders(), "Idempotency-Key": "existing-api-order" },
  });
  assert.equal(priorApi.status, 201);
  const priorRequest = { idempotency_key: "preserve-demo-idempotency" };
  const prior = await req(`/pay/${link.id}/orders`, { body: priorRequest });
  while (
    store.get(
      "SELECT COUNT(*) AS n FROM orders WHERE merchant_id=?",
      merchant.id,
    ).n < 100
  )
    store.createOrder(merchant, orderBody);
  assert.equal(
    (await req("/api/orders", { headers, body: orderBody })).body.error.code,
    "DEMO_QUOTA_REACHED",
  );
  assert.equal(
    (await req("/API/ORDERS/", { headers, body: orderBody })).body.error.code,
    "DEMO_QUOTA_REACHED",
  );
  assert.equal(
    (await req("/v1/orders", { body: orderBody, headers: apiHeaders() })).body
      .error.code,
    "DEMO_QUOTA_REACHED",
  );
  assert.equal(
    (
      await req("/v1/orders", {
        body: orderBody,
        headers: { ...apiHeaders(), "Idempotency-Key": "existing-api-order" },
      })
    ).body.order_id,
    priorApi.body.order_id,
  );
  assert.equal(
    (await req(`/pay/${link.id}/orders`, { body: {} })).body.error.code,
    "DEMO_QUOTA_REACHED",
  );
  assert.equal(
    (await req(`/PAY/${link.id}/ORDERS/`, { body: {} })).body.error.code,
    "DEMO_QUOTA_REACHED",
  );
  assert.equal(
    (await req(`/pay/${link.id}/orders`, { body: priorRequest })).body.order_id,
    prior.body.order_id,
  );
  assert.equal(
    (
      await req("/api/billing/checkout", {
        headers,
        body: { plan_id: "starter", idempotency_key: "new-invoice" },
      })
    ).body.error.code,
    "DEMO_QUOTA_REACHED",
  );
  const stock = store.get(
    "SELECT COUNT(*) AS n FROM inventory WHERE merchant_id=?",
    merchant.id,
  ).n;
  assert.equal(
    (
      await req(`/api/products/${product.id}/inventory`, {
        headers,
        body: {
          items: Array.from(
            { length: 1001 - stock },
            (_, i) => `demo-item-${i}`,
          ),
        },
      })
    ).body.error.code,
    "DEMO_QUOTA_REACHED",
  );
  while (
    store.get(
      "SELECT COUNT(*) AS n FROM products WHERE merchant_id=?",
      merchant.id,
    ).n < 50
  )
    store.createProduct(merchant, {
      project_id: project.id,
      name: "Fixture",
      price: "1",
    });
  assert.equal(
    (
      await req("/api/products", {
        headers,
        body: { project_id: project.id, name: "Over budget", price: "1" },
      })
    ).body.error.code,
    "DEMO_QUOTA_REACHED",
  );
});

test("local demo keeps its existing registration behavior and does not gain public-preview quotas", async (t) => {
  const { store, req } = await setup(t, { production: false });
  assert.equal((await req("/api/auth/me")).body.public_demo, false);
  const registered = await req("/api/auth/register", {
    body: { email: "local@example.test", password: "fixture-password-123" },
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.mode, "live");
  const demo = await req("/api/auth/demo", { body: {} }),
    merchant = store.merchant(demo.body.user.id);
  while (
    store.get(
      "SELECT COUNT(*) AS n FROM projects WHERE merchant_id=?",
      merchant.id,
    ).n < 10
  )
    store.createProject(merchant, { name: "Local project" });
  assert.equal(
    (
      await req("/api/projects", {
        headers: { Cookie: demo.cookie },
        body: { name: "More local projects" },
      })
    ).status,
    201,
  );
});

test("public base URL rejects unsafe or non-origin configurations", () => {
  const store = new Store({ registry });
  try {
    for (const publicBaseUrl of [
      undefined,
      "http://demo.example",
      "https://user:password@demo.example",
      "https://demo.example/path",
      "https://demo.example/?next=x",
    ])
      assert.throws(() =>
        createApp({ store, production: true, mode: "demo", publicBaseUrl }),
      );
    assert.throws(() => createApp({ store, trustProxy: true }));
  } finally {
    store.close();
  }
});
