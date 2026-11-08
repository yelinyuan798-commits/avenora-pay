import express from "express";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AppError, fail, uid, nowISO, hash } from "./core.mjs";
import { validateWebhookUrl } from "./net.mjs";
import { registerSecurity } from "./security.mjs";
import { registerExtensions } from "./extensions.mjs";
import { registerBilling } from "./billing.mjs";
import { registerOnboarding } from "./onboarding.mjs";

const pick = (value, keys) =>
  Object.fromEntries(keys.map((k) => [k, value[k]]));
const cookie = (req, name) => {
  const pairs = (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim().split("="));
  return (
    pairs
      .find((x) => x[0] === name)
      ?.slice(1)
      .join("=") || null
  );
};
function endpointUrl(value) {
  try {
    return validateWebhookUrl(value).href;
  } catch (e) {
    fail("INVALID_URL", e.message);
  }
}
export function createApp({
  store,
  mode = "live",
  publicBaseUrl,
  dist = path.resolve("dist"),
  production = false,
  trustProxy = false,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  if (trustProxy === true || trustProxy === "true")
    throw new Error(
      "Configure a specific trusted proxy address or subnet, not true",
    );
  app.set("trust proxy", trustProxy);
  const publicDemo = production && mode === "demo";
  let publicOrigin;
  if (publicBaseUrl) {
    const base = new URL(publicBaseUrl);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    )
      throw new Error(
        "PUBLIC_BASE_URL must be a site origin without credentials, path, query or fragment",
      );
    publicOrigin = base.origin;
  }
  if (production && (!publicOrigin || !publicOrigin.startsWith("https://")))
    throw new Error("Production requires an HTTPS PUBLIC_BASE_URL");
  const demoQuotas = {
    projects: 10,
    addresses: 50,
    orders: 100,
    products: 50,
    inventory: 1000,
    payment_links: 50,
    api_keys: 20,
    endpoints: 20,
  };
  const demoQuotaLabels = {
    projects: "项目",
    addresses: "地址",
    orders: "订单",
    products: "商品",
    inventory: "库存",
    payment_links: "收款链接",
    api_keys: "API 密钥",
    endpoints: "回调端点",
  };
  function enforceDemoQuota(merchant, resource, additional = 1) {
    if (!publicDemo || merchant?.mode !== "demo") return;
    const used = store.get(
      `SELECT COUNT(*) AS n FROM ${resource} WHERE merchant_id=?`,
      merchant.id,
    ).n;
    if (used + additional > demoQuotas[resource])
      fail(
        "DEMO_QUOTA_REACHED",
        `演示额度已达到（${demoQuotaLabels[resource]}最多 ${demoQuotas[resource]} 项），请使用现有演示数据继续体验`,
        429,
      );
  }
  const limits = new Map();
  function consumeLimit(key, maximum, windowMs = 60_000) {
    const now = Date.now();
    for (const [key, state] of limits)
      if (state.resetAt <= now) limits.delete(key);
    const state = limits.get(key) || { count: 0, resetAt: now + windowMs };
    state.count++;
    limits.set(key, state);
    return state.count <= maximum
      ? 0
      : Math.max(1, Math.ceil((state.resetAt - now) / 1000));
  }
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    const authWrite =
      req.path.toLowerCase().startsWith("/api/auth/") && req.method === "POST";
    const demoWrite =
      publicDemo && !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const retryAfter = consumeLimit(
      `${req.ip || "unknown"}:${authWrite ? "auth" : demoWrite ? "write" : "other"}`,
      authWrite ? 40 : demoWrite ? 120 : 600,
    );
    if (retryAfter)
      return res
        .set("Retry-After", String(retryAfter))
        .status(429)
        .json({
          error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" },
        });
    next();
  });
  app.use(
    express.json({
      limit: "1mb",
      verify(req, res, buf) {
        req.rawBody = buf;
      },
    }),
  );
  app.use((req, res, next) => {
    try {
      req.merchant = store.sessionMerchant(cookie(req, "djp_session"));
      if (publicDemo && req.merchant?.mode !== "demo") req.merchant = null;
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (unsafe && !req.path.startsWith("/v1/")) {
        const origin = req.headers.origin;
        const expected = publicOrigin
          ? publicOrigin
          : `${req.protocol}://${req.headers.host}`;
        if (
          (origin && origin !== expected) ||
          req.headers["sec-fetch-site"] === "cross-site" ||
          (req.merchant && !origin)
        )
          fail("ORIGIN_REJECTED", "页面来源校验失败，请从本站重新操作", 403);
      }
      next();
    } catch (e) {
      next(e);
    }
  });
  if (publicDemo) {
    app.use((req, res, next) => {
      try {
        if (req.method === "POST" && req.merchant) {
          const route = req.path.toLowerCase().replace(/\/$/, "");
          const resource = {
            "/api/projects": "projects",
            "/api/addresses": "addresses",
            "/api/orders": "orders",
            "/api/products": "products",
            "/api/payment-links": "payment_links",
            "/api/keys": "api_keys",
            "/api/webhooks": "endpoints",
          }[route];
          if (resource) enforceDemoQuota(req.merchant, resource);
          if (
            /^\/api\/products\/[^/]+\/inventory$/.test(route) &&
            Array.isArray(req.body.items)
          )
            enforceDemoQuota(req.merchant, "inventory", req.body.items.length);
          if (
            route === "/api/billing/checkout" &&
            !store.get(
              "SELECT id FROM billing_invoices WHERE merchant_id=? AND idempotency_key=?",
              req.merchant.id,
              String(req.body.idempotency_key || ""),
            )
          )
            enforceDemoQuota(req.merchant, "orders");
        }
        next();
      } catch (error) {
        next(error);
      }
    });
    // Defense in depth if a deployment is accidentally pointed at a nonempty database.
    app.use("/checkout/:token", (req, res, next) => {
      try {
        if (store.checkout(req.params.token).mode !== "demo")
          fail("PUBLIC_DEMO_ONLY", "本站仅提供演示付款，不开放真实收款", 403);
        next();
      } catch (error) {
        next(error);
      }
    });
    app.use("/pay/:id", (req, res, next) => {
      try {
        const link = store.get(
          "SELECT m.mode FROM payment_links p JOIN merchants m ON m.id=p.merchant_id WHERE p.id=?",
          req.params.id,
        );
        if (link && link.mode !== "demo")
          fail("PUBLIC_DEMO_ONLY", "本站仅提供演示付款，不开放真实收款", 403);
        if (link && req.method === "POST" && /^\/orders\/?$/i.test(req.path)) {
          const owner = store.get(
            "SELECT m.* FROM payment_links p JOIN merchants m ON m.id=p.merchant_id WHERE p.id=?",
            req.params.id,
          );
          const requestKey =
            req.body.idempotency_key ?? req.headers["idempotency-key"];
          if (
            !requestKey ||
            !store.get(
              "SELECT order_id FROM payment_link_orders WHERE link_id=? AND request_key=?",
              req.params.id,
              hash(String(requestKey)),
            )
          )
            enforceDemoQuota(owner, "orders");
        }
        next();
      } catch (error) {
        next(error);
      }
    });
  }
  registerSecurity(app, { store });
  registerExtensions(app, { store });
  registerBilling(app, { store });
  registerOnboarding(app, { store });
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  const auth = (req, res, next) => {
    if (!req.merchant)
      return next(new AppError("UNAUTHORIZED", "请先登录", 401));
    next();
  };
  const loginCookie = (res, m) => {
    if (publicDemo && m.mode !== "demo")
      fail("PUBLIC_DEMO_ONLY", "本站为公开演示，请直接进入演示工作台", 403);
    const token = store.session(m);
    res.setHeader(
      "Set-Cookie",
      `djp_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${production ? "; Secure" : ""}`,
    );
    return { user: store.publicMerchant(m), mode: m.mode };
  };
  const externalOrder = (o) => ({
    ...apiOrder(o),
    status: o.status === "pending" && !o.chain ? "awaiting_payment" : o.status,
  });
  const apiOrder = (o) => ({
    ...o,
    checkout_url: publicOrigin
      ? new URL(o.checkout_url, publicOrigin).href
      : o.checkout_url,
  });
  app.get("/api/auth/me", (req, res) =>
    res.json({
      user: req.merchant ? store.publicMerchant(req.merchant) : null,
      mode: req.merchant?.mode || mode,
      public_demo: publicDemo,
      registration_enabled: !publicDemo,
      demo_enabled: mode === "demo",
      demo_quotas: publicDemo ? demoQuotas : null,
    }),
  );
  app.post(
    "/api/auth/register",
    wrap((req, res) => {
      if (publicDemo)
        fail(
          "PUBLIC_DEMO_ONLY",
          "公开演示不开放真实账户注册，请直接进入演示工作台",
          403,
        );
      res.status(201).json(loginCookie(res, store.register(req.body)));
    }),
  );
  app.post(
    "/api/auth/login",
    wrap((req, res) => res.json(loginCookie(res, store.login(req.body)))),
  );
  app.post(
    "/api/auth/demo",
    wrap((req, res) => {
      if (mode !== "demo") fail("DEMO_DISABLED", "当前服务未开放演示模式", 403);
      if (publicDemo && req.merchant?.mode === "demo")
        return res.json({
          user: store.publicMerchant(req.merchant),
          mode: "demo",
        });
      if (publicDemo) {
        const retryAfter = consumeLimit(
          `${req.ip || "unknown"}:demo-create`,
          6,
          600_000,
        );
        if (retryAfter) {
          res.set("Retry-After", String(retryAfter));
          fail("DEMO_RATE_LIMITED", "演示空间创建过于频繁，请稍后再试", 429);
        }
        if (
          store.get("SELECT COUNT(*) AS n FROM merchants WHERE mode='demo'")
            .n >= 100
        )
          fail(
            "DEMO_CAPACITY",
            "演示空间暂时已满，请使用已有演示空间或稍后再试",
            429,
          );
      }
      res.json(loginCookie(res, store.demoMerchant()));
    }),
  );
  app.post(
    "/api/auth/logout",
    auth,
    wrap((req, res) => {
      const token = cookie(req, "djp_session");
      if (token)
        store.run("DELETE FROM sessions WHERE token_hash=?", hash(token));
      res.setHeader(
        "Set-Cookie",
        `djp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? "; Secure" : ""}`,
      );
      res.json({ ok: true });
    }),
  );
  app.get("/api/registry", (req, res) =>
    res.json({
      chains: store.registry.map((c) => ({
        ...c,
        configured:
          req.merchant?.mode === "demo" ||
          c.tokens.some((t) => store.configured(c.id, t.id)),
      })),
      currencies: ["USD", "CNY", "EUR", "USDT", "USDC"],
      pricing: store.priceBook.status(),
    }),
  );
  app.use("/api", auth);
  app.get(
    "/api/dashboard",
    wrap((req, res) => {
      store.expire();
      const projectId = req.query.project_id
        ? store.project(req.merchant, String(req.query.project_id)).id
        : null;
      const orders = projectId
        ? store.all(
            "SELECT * FROM orders WHERE merchant_id=? AND project_id=? ORDER BY created_at DESC",
            req.merchant.id,
            projectId,
          )
        : store.all(
            "SELECT * FROM orders WHERE merchant_id=? ORDER BY created_at DESC",
            req.merchant.id,
          );
      const paid = orders.filter((o) => o.status === "paid");
      const chart = Array.from({ length: 7 }, (_, i) => {
        const date = new Date(Date.now() - (6 - i) * 86400000)
          .toISOString()
          .slice(0, 10);
        return {
          date,
          orders: orders.filter((o) => o.created_at.startsWith(date)).length,
          paid_orders: paid.filter((o) => o.created_at.startsWith(date)).length,
          amount: paid
            .filter(
              (o) => o.fiat_currency === "USD" && o.created_at.startsWith(date),
            )
            .reduce((n, o) => n + Number(o.fiat_amount), 0),
        };
      });
      res.json({
        stats: {
          total_volume: paid
            .filter((o) => o.fiat_currency === "USD")
            .reduce((n, o) => n + Number(o.fiat_amount), 0),
          currency: "USD",
          paid_orders: paid.length,
          total_orders: orders.length,
          expired_orders: orders.filter((o) => o.status === "expired").length,
          canceled_orders: orders.filter((o) => o.status === "canceled").length,
          confirming_orders: orders.filter((o) => o.status === "confirming")
            .length,
          unmatched_count: store.get(
            "SELECT COUNT(*) AS n FROM transfers WHERE merchant_id=? AND (? IS NULL OR project_id=?) AND order_id IS NULL AND removed=0",
            req.merchant.id,
            projectId,
            projectId,
          ).n,
          pending_orders: orders.filter((o) =>
            ["awaiting_payment", "pending", "confirming"].includes(o.status),
          ).length,
          success_rate: orders.length
            ? Math.round((paid.length / orders.length) * 100)
            : 0,
        },
        chart,
        recent_orders: orders.slice(0, 8).map((o) => store.orderView(o)),
        chains: store.registry.map((c) => ({
          ...c,
          configured:
            req.merchant.mode === "demo" ||
            c.tokens.some((t) => store.configured(c.id, t.id)),
          scanner:
            store.get(
              "SELECT cursor,head,last_success,last_error FROM cursors WHERE chain=?",
              c.id,
            ) || null,
        })),
        mode: req.merchant.mode,
      });
    }),
  );
  app.get(
    "/api/projects",
    wrap((req, res) =>
      res.json({
        projects: store.all(
          "SELECT id,name,description,webhook_url,created_at FROM projects WHERE merchant_id=? ORDER BY created_at DESC",
          req.merchant.id,
        ),
      }),
    ),
  );
  app.post(
    "/api/projects",
    wrap((req, res) => {
      const p = store.createProject(req.merchant, req.body);
      res.status(201).json(p);
    }),
  );
  app.get(
    "/api/payment-policies",
    wrap((req, res) => res.json({
      policies: store.all("SELECT id FROM projects WHERE merchant_id=?", req.merchant.id)
        .map(p => ({ ...store.paymentPolicy(req.merchant, p.id), available_methods: store.availableMethods(req.merchant, p.id) })),
    })),
  );
  app.put(
    "/api/projects/:id/payment-policy",
    wrap((req, res) => res.json(store.setPaymentPolicy(req.merchant, req.params.id, req.body))),
  );
  app.patch(
    "/api/projects/:id",
    wrap((req, res) => {
      const p = store.project(req.merchant, req.params.id);
      const name = String(req.body.name ?? p.name)
        .trim()
        .slice(0, 80);
      if (!name) fail("INVALID_PROJECT", "项目名称不能为空");
      store.run(
        "UPDATE projects SET name=?,description=? WHERE id=?",
        name,
        String(req.body.description ?? p.description).slice(0, 1000),
        p.id,
      );
      res.json(store.project(req.merchant, p.id));
    }),
  );
  app.get(
    "/api/project-settings/:projectId",
    wrap((req, res) =>
      res.json(store.projectSettings(req.merchant, req.params.projectId)),
    ),
  );
  app.patch(
    "/api/project-settings/:projectId",
    wrap((req, res) =>
      res.json(
        store.updateProjectSettings(
          req.merchant,
          req.params.projectId,
          req.body,
        ),
      ),
    ),
  );
  app.get(
    "/api/orders",
    wrap((req, res) => {
      store.expire();
      let rows = store.all(
        "SELECT * FROM orders WHERE merchant_id=? ORDER BY created_at DESC LIMIT 1000",
        req.merchant.id,
      );
      if (req.query.status)
        rows = rows.filter((o) => o.status === req.query.status);
      if (req.query.project_id)
        rows = rows.filter((o) => o.project_id === req.query.project_id);
      if (req.query.q) {
        const q = String(req.query.q).toLowerCase();
        rows = rows.filter(
          (o) =>
            o.order_id.toLowerCase().includes(q) ||
            o.merchant_order_id.toLowerCase().includes(q) ||
            o.tx_hash?.toLowerCase().includes(q),
        );
      }
      res.json({
        orders: rows.map((o) => store.orderView(o)),
        total: rows.length,
      });
    }),
  );
  app.post(
    "/api/orders",
    wrap((req, res) =>
      res.status(201).json(apiOrder(store.createOrder(req.merchant, req.body))),
    ),
  );
  app.post(
    "/api/orders/:id/cancel",
    wrap((req, res) => res.json(store.cancel(req.merchant, req.params.id))),
  );
  app.post(
    "/api/orders/:id/simulate",
    wrap((req, res) =>
      res.json(
        store.simulate(req.merchant, req.params.id, req.body.confirmations),
      ),
    ),
  );
  app.get(
    "/api/addresses",
    wrap((req, res) =>
      res.json({
        addresses: store
          .all(
            "SELECT id,project_id,chain,address,label,token_ids,enabled,created_at FROM addresses WHERE merchant_id=? ORDER BY created_at DESC",
            req.merchant.id,
          )
          .map((a) => ({
            ...a,
            token_ids: JSON.parse(a.token_ids),
            enabled: !!a.enabled,
          })),
      }),
    ),
  );
  app.post(
    "/api/addresses",
    wrap((req, res) =>
      res.status(201).json(store.addAddress(req.merchant, req.body)),
    ),
  );
  app.patch(
    "/api/addresses/:id",
    wrap((req, res) => {
      if (typeof req.body.enabled !== "boolean")
        fail("INVALID_VALUE", "enabled 必须是布尔值");
      const changed = store.run(
        "UPDATE addresses SET enabled=? WHERE id=? AND merchant_id=?",
        req.body.enabled ? 1 : 0,
        req.params.id,
        req.merchant.id,
      );
      if (!changed.changes) fail("NOT_FOUND", "收款地址不存在", 404);
      res.json({ ok: true, enabled: req.body.enabled });
    }),
  );
  app.get(
    "/api/keys",
    wrap((req, res) =>
      res.json({
        keys: store.all(
          "SELECT id,key_id,key_prefix,project_id,name,created_at,revoked FROM api_keys WHERE merchant_id=? ORDER BY created_at DESC",
          req.merchant.id,
        ),
      }),
    ),
  );
  app.post(
    "/api/keys",
    wrap((req, res) =>
      res.status(201).json(store.createKey(req.merchant, req.body)),
    ),
  );
  app.delete(
    "/api/keys/:id",
    wrap((req, res) => {
      const result = store.run(
        "UPDATE api_keys SET revoked=1 WHERE id=? AND merchant_id=?",
        req.params.id,
        req.merchant.id,
      );
      if (!result.changes) fail("NOT_FOUND", "密钥不存在", 404);
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/products",
    wrap((req, res) =>
      res.json({
        products: store.all(
          "SELECT p.id,p.project_id,p.name,p.price,p.currency,p.created_at,(SELECT COUNT(*) FROM inventory i WHERE i.product_id=p.id AND i.order_id IS NULL) AS stock FROM products p WHERE p.merchant_id=? ORDER BY p.created_at DESC",
          req.merchant.id,
        ),
      }),
    ),
  );
  app.post(
    "/api/products",
    wrap((req, res) =>
      res.status(201).json(store.createProduct(req.merchant, req.body)),
    ),
  );
  app.post(
    "/api/products/:id/inventory",
    wrap((req, res) =>
      res.json(
        store.importInventory(req.merchant, req.params.id, req.body.items),
      ),
    ),
  );
  app.get(
    "/api/transactions",
    wrap((req, res) =>
      res.json({
        transactions: store
          .all(
            "SELECT * FROM transfers WHERE merchant_id=? ORDER BY block_time DESC LIMIT 1000",
            req.merchant.id,
          )
          .map((t) => {
            const token = store.tokenSpec(t.chain, t.token_id).token;
            const decimal =
              store
                .chainConfig(t.chain)
                ?.tokens?.find?.((x) => x.id === t.token_id)?.decimals ??
              token.decimals;
            const s = String(t.amount_atomic).padStart(decimal + 1, "0");
            return {
              ...t,
              amount: decimal
                ? s.slice(0, -decimal) + "." + s.slice(-decimal)
                : s,
              confirmed: !!t.confirmed,
              removed: !!t.removed,
            };
          }),
      }),
    ),
  );
  app.post(
    "/api/transactions/:id/claim",
    wrap((req, res) =>
      res.json(store.claim(req.merchant, req.params.id, req.body.order_id)),
    ),
  );
  app.get(
    "/api/webhooks",
    wrap((req, res) =>
      res.json({
        deliveries: store.all(
          "SELECT id,project_id,endpoint_id,event_id,event_type,status,attempts,last_error,created_at,delivered_at,next_attempt FROM deliveries WHERE merchant_id=? ORDER BY created_at DESC LIMIT 500",
          req.merchant.id,
        ),
        endpoints: store
          .all(
            "SELECT e.id,e.project_id,e.url,e.created_at,COALESCE(s.enabled,1) AS enabled FROM endpoints e LEFT JOIN endpoint_state s ON s.endpoint_id=e.id WHERE e.merchant_id=?",
            req.merchant.id,
          )
          .map((e) => ({ ...e, enabled: !!e.enabled })),
      }),
    ),
  );
  app.post(
    "/api/webhooks",
    wrap((req, res) => {
      const p = store.project(req.merchant, req.body.project_id);
      const url = endpointUrl(req.body.url);
      const secret = randomBytes(32).toString("hex");
      const id = uid("we_");
      store.transaction(() => {
        store.callHook("enforceLimits", req.merchant, "endpoints", p.id);
        store.run(
          "INSERT INTO endpoints VALUES(?,?,?,?,?,?)",
          id,
          req.merchant.id,
          p.id,
          url,
          store.encrypt(secret),
          nowISO(),
        );
        store.run("INSERT INTO endpoint_state VALUES(?,1)", id);
        store.run("UPDATE projects SET webhook_url=? WHERE id=?", url, p.id);
        store.run(
          "UPDATE deliveries SET endpoint_id=?,status='pending',next_attempt=? WHERE project_id=? AND status='unconfigured' AND endpoint_id IS NULL",
          id,
          Date.now(),
          p.id,
        );
      });
      res
        .status(201)
        .json({ id, secret, url, project_id: p.id, enabled: true });
    }),
  );
  app.patch(
    "/api/webhooks/:id",
    wrap((req, res) => {
      const endpoint = store.get(
        "SELECT * FROM endpoints WHERE id=? AND merchant_id=?",
        req.params.id,
        req.merchant.id,
      );
      if (!endpoint) fail("NOT_FOUND", "回调端点不存在", 404);
      const url =
        req.body.url === undefined ? endpoint.url : endpointUrl(req.body.url);
      const priorEnabled =
        store.get(
          "SELECT enabled FROM endpoint_state WHERE endpoint_id=?",
          endpoint.id,
        )?.enabled !== 0;
      const enabled =
        req.body.enabled === undefined ? priorEnabled : req.body.enabled;
      if (typeof enabled !== "boolean")
        fail("INVALID_VALUE", "enabled须为布尔值");
      store.transaction(() => {
        store.run("UPDATE endpoints SET url=? WHERE id=?", url, endpoint.id);
        store.run(
          "INSERT INTO endpoint_state VALUES(?,?) ON CONFLICT(endpoint_id) DO UPDATE SET enabled=excluded.enabled",
          endpoint.id,
          enabled ? 1 : 0,
        );
        if (enabled)
          store.run(
            "UPDATE deliveries SET status='pending',next_attempt=? WHERE endpoint_id=? AND status='paused'",
            Date.now(),
            endpoint.id,
          );
        else
          store.run(
            "UPDATE deliveries SET status='paused' WHERE endpoint_id=? AND status IN ('pending','retry')",
            endpoint.id,
          );
      });
      res.json({
        id: endpoint.id,
        project_id: endpoint.project_id,
        url,
        enabled,
      });
    }),
  );
  app.post(
    "/api/webhooks/:id/rotate",
    wrap((req, res) => {
      const endpoint = store.get(
        "SELECT * FROM endpoints WHERE id=? AND merchant_id=?",
        req.params.id,
        req.merchant.id,
      );
      if (!endpoint) fail("NOT_FOUND", "回调端点不存在", 404);
      const secret = randomBytes(32).toString("hex");
      store.run(
        "UPDATE endpoints SET secret=? WHERE id=?",
        store.encrypt(secret),
        endpoint.id,
      );
      store.audit(req.merchant.id, "webhook.rotate", endpoint.id);
      res.json({ id: endpoint.id, secret });
    }),
  );
  app.post(
    "/api/webhooks/test",
    wrap((req, res) => {
      const p = store.project(req.merchant, req.body.project_id);
      const endpoints = store.activeEndpoints(p.id);
      if (!endpoints.length) fail("ENDPOINT_REQUIRED", "请先启用回调端点");
      const event_id = uid("evt_");
      const payload = {
        event_id,
        event_type: "webhook.test",
        event_version: "v1",
        created_at: nowISO(),
        data: { project_id: p.id, message: "Avenora Pay webhook test" },
      };
      const result = store.transaction(() =>
        store.enqueueEvent({
          merchant_id: req.merchant.id,
          project_id: p.id,
          event_id,
          event_type: "webhook.test",
          payload,
          endpoint_id: req.body.endpoint_id,
        }),
      );
      res.json({ id: result.ids[0], ids: result.ids, event_id, queued: true });
    }),
  );
  app.post(
    "/api/webhooks/:id/retry",
    wrap((req, res) => {
      const d = store.get(
        "SELECT * FROM deliveries WHERE id=? AND merchant_id=?",
        req.params.id,
        req.merchant.id,
      );
      if (!d) fail("NOT_FOUND", "回调记录不存在", 404);
      if (d.status === "delivered")
        fail("ALREADY_DELIVERED", "该通知已投递成功", 409);
      const endpoints = store.activeEndpoints(d.project_id);
      const ep = d.endpoint_id
        ? endpoints.find((e) => e.id === d.endpoint_id)
        : endpoints[0];
      if (!ep) fail("ENDPOINT_REQUIRED", "请先启用该通知对应的回调端点");
      store.run(
        "UPDATE deliveries SET endpoint_id=?,status='pending',attempts=0,next_attempt=?,last_error=NULL WHERE id=?",
        ep.id,
        Date.now(),
        d.id,
      );
      res.json({ ok: true });
    }),
  );
  app.get("/api/settings", (req, res) =>
    res.json(pick(req.merchant, ["id", "name", "email", "mode"])),
  );
  app.patch(
    "/api/settings",
    wrap((req, res) => {
      const name = String(req.body.name || "")
        .trim()
        .slice(0, 80);
      if (!name) fail("INVALID_NAME", "姓名不能为空");
      store.run(
        "UPDATE merchants SET name=? WHERE id=?",
        name,
        req.merchant.id,
      );
      res.json({ name, email: req.merchant.email, mode: req.merchant.mode });
    }),
  );
  app.get(
    "/checkout/:token/state",
    wrap((req, res) => {
      store.expire();
      res.json(
        store.orderView(store.checkout(req.params.token), { publicView: true }),
      );
    }),
  );
  app.post(
    "/checkout/:token/demo-pay",
    wrap((req, res) => {
      const order = store.checkout(req.params.token);
      if (mode !== "demo" || order.mode !== "demo")
        fail("DEMO_ONLY", "仅演示环境的演示订单可模拟付款", 403);
      store.expire();
      const current = store.checkout(req.params.token);
      if (!["pending", "confirming", "paid"].includes(current.status))
        fail("ORDER_NOT_PAYABLE", "此订单已不能模拟付款", 409);
      store.simulate(store.merchant(order.merchant_id), order.order_id);
      res.json(store.orderView(store.checkout(req.params.token), { publicView: true }));
    }),
  );
  app.get(
    "/checkout/:token/methods",
    wrap((req, res) => {
      const o = store.checkout(req.params.token);
      const allowed = JSON.parse(o.metadata).allowed_methods || [];
      res.json({
        methods: store
          .availableMethods(store.merchant(o.merchant_id), o.project_id, { payment_mode: o.payment_mode })
          .filter(
            (x) =>
              !allowed.length ||
              allowed.some(
                (a) => a.chain === x.chain && a.token_id === x.token_id,
              ),
          ),
      });
    }),
  );
  app.post(
    "/checkout/:token/select",
    wrap((req, res) => {
      const o = store.checkout(req.params.token);
      store.transaction(() =>
        store.selectMethod(o, req.body.chain, req.body.token_id),
      );
      res.json(
        store.orderView(store.checkout(req.params.token), { publicView: true }),
      );
    }),
  );
  app.use("/v1", (req, res, next) => {
    try {
      const u = new URL(req.originalUrl, "http://internal");
      req.api = store.authenticateApi({
        headers: req.headers,
        method: req.method,
        pathname: u.pathname,
        query: u.search.slice(1),
        body: req.rawBody || Buffer.alloc(0),
      });
      if (publicDemo && req.api.merchant.mode !== "demo")
        fail("PUBLIC_DEMO_ONLY", "公开演示不开放真实收款接口", 403);
      next();
    } catch (e) {
      next(e);
    }
  });
  app.get(
    "/v1/whoami",
    wrap((req, res) =>
      res.json({
        merchant_id: req.api.merchant.id,
        project_id: req.api.project.id,
        api_key_id: req.api.key.key_id,
        mode: req.api.merchant.mode,
      }),
    ),
  );
  app.post(
    "/v1/orders",
    wrap((req, res) => {
      const key = req.headers["idempotency-key"];
      if (
        key !== undefined &&
        (typeof key !== "string" || key.length < 1 || key.length > 200)
      )
        fail("INVALID_IDEMPOTENCY_KEY", "幂等键长度须为1–200字符");
      const digest = hash(req.rawBody || Buffer.alloc(0));
      const response = store.transaction(() => {
        if (key) {
          const prior = store.get(
            "SELECT * FROM idempotency WHERE project_id=? AND idem_key=?",
            req.api.project.id,
            key,
          );
          if (prior) {
            if (prior.request_hash !== digest)
              fail("IDEMPOTENCY_CONFLICT", "幂等键已用于不同请求", 409);
            return JSON.parse(prior.response);
          }
        }
        enforceDemoQuota(req.api.merchant, "orders");
        const order = store.createOrder(req.api.merchant, {
          ...req.body,
          project_id: req.api.project.id,
          merchant_order_id:
            req.body.merchant_order_id ||
            (key ? "IDEM-" + hash(key).slice(0, 40) : undefined),
        });
        const response = externalOrder(order);
        if (key)
          store.run(
            "INSERT INTO idempotency VALUES(?,?,?,?)",
            req.api.project.id,
            key,
            digest,
            JSON.stringify(response),
          );
        return response;
      });
      res.status(201).json(response);
    }),
  );
  app.get(
    "/v1/orders",
    wrap((req, res) => {
      store.expire();
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      if (!Number.isInteger(limit) || !Number.isInteger(offset))
        fail("INVALID_PAGINATION", "分页参数须为整数");
      const where = ["project_id=?"],
        args = [req.api.project.id];
      if (req.query.status) {
        const statuses = [
          "awaiting_payment",
          "pending",
          "confirming",
          "paid",
          "expired",
          "canceled",
          "review",
        ];
        if (!statuses.includes(req.query.status))
          fail("INVALID_FILTER", "订单状态无效");
        where.push("status=?");
        args.push(req.query.status);
      }
      for (const field of ["chain", "token_id"])
        if (req.query[field]) {
          where.push(field + "=?");
          args.push(String(req.query[field]));
        }
      for (const [field, operator] of [
        ["created_after", ">="],
        ["created_before", "<="],
      ])
        if (req.query[field]) {
          const value = String(req.query[field]);
          if (!Number.isFinite(Date.parse(value)))
            fail("INVALID_FILTER", "创建时间必须为有效时间");
          where.push("created_at" + operator + "?");
          args.push(new Date(value).toISOString());
        }
      const clause = where.join(" AND ");
      const rows = store.all(
        "SELECT * FROM orders WHERE " +
          clause +
          " ORDER BY created_at DESC LIMIT ? OFFSET ?",
        ...args,
        limit,
        offset,
      );
      res.json({
        orders: rows.map((o) => externalOrder(store.orderView(o))),
        total: store.get(
          "SELECT COUNT(*) AS n FROM orders WHERE " + clause,
          ...args,
        ).n,
        limit,
        offset,
      });
    }),
  );
  app.get(
    "/v1/orders/:id",
    wrap((req, res) => {
      store.expire();
      res.json(
        externalOrder(
          store.orderView(
            store.ownedOrder(
              req.api.merchant,
              req.params.id,
              req.api.project.id,
            ),
          ),
        ),
      );
    }),
  );
  app.post(
    "/v1/orders/:id/cancel",
    wrap((req, res) =>
      res.json(
        externalOrder(
          store.cancel(req.api.merchant, req.params.id, req.api.project.id),
        ),
      ),
    ),
  );
  app.use("/api", (req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "接口不存在" } }),
  );
  app.use("/v1", (req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "接口不存在" } }),
  );
  app.use(express.static(dist, { index: false }));
  app.get("/{*path}", (req, res) =>
    res.sendFile(path.join(dist, "index.html"), (err) => {
      if (err) res.status(503).send("页面正在准备中，请稍后刷新。");
    }),
  );
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const known = err instanceof AppError;
    const jsonParse = err.type === "entity.parse.failed";
    res.status(known ? err.status : jsonParse ? 400 : 500).json({
      error: {
        code: known ? err.code : jsonParse ? "INVALID_JSON" : "INTERNAL_ERROR",
        message: known
          ? err.message
          : jsonParse
            ? "请求 JSON 格式错误"
            : "操作未完成，请稍后重试",
      },
    });
    if (!known && !jsonParse) console.error("Request failed:", err.message);
  });
  return app;
}
