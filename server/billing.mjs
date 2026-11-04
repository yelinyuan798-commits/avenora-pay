import {
  decimalAtomic,
  formatAtomic,
  fail,
  hash,
  uid,
  nowISO,
} from "./core.mjs";

const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
const merchantOf = (req) =>
  req.merchant || fail("UNAUTHORIZED", "请先登录", 401);
const dayMs = 86400000;
const resources = [
  "projects",
  "addresses",
  "api_keys",
  "endpoints",
  "payment_links",
  "products",
  "monthly_paid",
  "active_orders",
  "api_requests",
  "addresses_per_project",
  "monthly_paid_soft",
  "monthly_gmv",
  "monthly_gmv_soft",
];
const defaults = [
  {
    id: "free",
    name: "免费计划",
    price: "0.00",
    limits: [1, 2, 2, 1, 2, 10, 100, 10, 60, 2, 80, 500, 400],
  },
  {
    id: "starter",
    name: "起步计划",
    price: "10.00",
    limits: [3, 30, 3, 2, 5, 50, 1500, 50, 120, 10, 1000, 6000, 5000],
  },
  {
    id: "pro",
    name: "专业计划",
    price: "20.00",
    limits: [10, 50, 50, 10, 50, 250, 5000, 200, 600, 20, 4000, 30000, 25000],
  },
  {
    id: "business",
    name: "商业计划",
    price: "50.00",
    limits: [
      50, 250, 250, 50, 250, 1000, 20000, 1000, 1200, 50, 16000, 120000, 100000,
    ],
  },
];

function nextMonth(timestamp) {
  const d = new Date(timestamp),
    originalDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(originalDay, last));
  return d.toISOString();
}

export function initializeBilling(store, { now = () => Date.now() } = {}) {
  if (store.billing) return store.billing;
  const isoNow = () => new Date(now()).toISOString();
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS billing_plans(id TEXT PRIMARY KEY,name TEXT NOT NULL,price TEXT NOT NULL,currency TEXT NOT NULL,limits_json TEXT NOT NULL,enabled INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_subscriptions(merchant_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,starts_at TEXT NOT NULL,expires_at TEXT,source TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_invoices(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,plan_id TEXT NOT NULL,plan_name TEXT NOT NULL,amount TEXT NOT NULL,currency TEXT NOT NULL,owner_merchant_id TEXT NOT NULL,owner_project_id TEXT NOT NULL,order_id TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,status TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,created_at TEXT NOT NULL,paid_at TEXT,activated_at TEXT,UNIQUE(merchant_id,idempotency_key));
    CREATE INDEX IF NOT EXISTS billing_invoices_merchant ON billing_invoices(merchant_id,created_at);
    CREATE TABLE IF NOT EXISTS billing_paid_usage(order_id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,paid_at TEXT NOT NULL,mode TEXT NOT NULL,source TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_rate_buckets(merchant_id TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(merchant_id,bucket));
    CREATE TABLE IF NOT EXISTS billing_admin_actions(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,merchant_id TEXT,action TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
  if (
    !store
      .all("PRAGMA table_info(billing_paid_usage)")
      .some((column) => column.name === "usd_atomic")
  )
    store.db.exec(
      "ALTER TABLE billing_paid_usage ADD COLUMN usd_atomic TEXT NOT NULL DEFAULT '0'",
    );
  for (const plan of defaults) {
    const defaultLimits = Object.fromEntries(
      resources.map((name, i) => [name, plan.limits[i]]),
    );
    store.run(
      "INSERT OR IGNORE INTO billing_plans VALUES(?,?,?,?,?,?,?)",
      plan.id,
      plan.name,
      plan.price,
      "USD",
      JSON.stringify(defaultLimits),
      1,
      isoNow(),
    );
    const existing = store.get(
      "SELECT limits_json FROM billing_plans WHERE id=?",
      plan.id,
    );
    const existingLimits = JSON.parse(existing.limits_json);
    if (resources.some((key) => existingLimits[key] === undefined))
      store.run(
        "UPDATE billing_plans SET limits_json=? WHERE id=?",
        JSON.stringify({ ...defaultLimits, ...existingLimits }),
        plan.id,
      );
  }
  if (
    !store
      .all("PRAGMA table_info(billing_paid_usage)")
      .some((column) => column.name === "valuation_status")
  )
    store.db.exec(
      "ALTER TABLE billing_paid_usage ADD COLUMN valuation_status TEXT NOT NULL DEFAULT 'unknown'",
    );
  // Historical stablecoin settlements can be conservatively valued at parity. Unknown native-coin
  // rows stay explicitly unvalued; they must never silently count as one dollar per coin.
  store.run(
    "INSERT OR IGNORE INTO billing_paid_usage(order_id,merchant_id,paid_at,mode,source) SELECT order_id,merchant_id,created_at,mode,'legacy_creation_time' FROM orders WHERE status='paid'",
  );
  for (const order of store.all(
    "SELECT o.*,u.source AS usage_source FROM orders o JOIN billing_paid_usage u ON u.order_id=o.order_id WHERE u.valuation_status!='locked'",
  )) {
    const invoice = !!store.get(
      "SELECT id FROM billing_invoices WHERE order_id=?",
      order.order_id,
    );
    let usd = "0",
      status = "unknown";
    try {
      usd = String(store.orderUsdAtomic(order));
      const quote = store.orderQuote(order);
      status = quote?.pricing_json ? "locked" : "legacy_stable_parity";
    } catch (e) {
      if (e.code !== "PRICE_SNAPSHOT_MISSING") throw e;
    }
    store.run(
      "UPDATE billing_paid_usage SET usd_atomic=?,valuation_status=?,source=? WHERE order_id=?",
      usd,
      status,
      invoice ? "platform_subscription" : order.usage_source,
      order.order_id,
    );
  }

  function plan(id) {
    if (typeof id !== "string" || !id)
      fail("PLAN_NOT_FOUND", "请选择有效套餐", 400);
    const row = store.get("SELECT * FROM billing_plans WHERE id=?", id);
    if (!row) fail("PLAN_NOT_FOUND", "套餐不存在", 404);
    return {
      id: row.id,
      name: row.name,
      price: row.price,
      currency: row.currency,
      interval: "month",
      limits: JSON.parse(row.limits_json),
      enabled: !!row.enabled,
    };
  }
  function plans(includeDisabled = false) {
    return defaults
      .map((item) => plan(item.id))
      .filter((item) => includeDisabled || item.enabled || item.id === "free");
  }
  function subscription(merchant) {
    const stored = store.get(
      "SELECT * FROM billing_subscriptions WHERE merchant_id=?",
      merchant.id,
    );
    const graceDays = store.config.billing?.graceDays ?? 3;
    if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 30)
      fail("BILLING_INVALID_CONFIG", "订阅宽限天数须为0–30的整数", 503);
    const paidPlan = !!stored && stored.plan_id !== "free";
    const expiry = paidPlan ? Date.parse(stored.expires_at) : NaN;
    const active = paidPlan && expiry > now();
    const graceUntil =
      paidPlan && Number.isFinite(expiry)
        ? new Date(expiry + graceDays * dayMs).toISOString()
        : null;
    const grace = paidPlan && !active && Date.parse(graceUntil) > now();
    return {
      plan_id: stored?.plan_id || "free",
      effective_plan_id: active || grace ? stored.plan_id : "free",
      status: active
        ? "active"
        : grace
          ? "grace"
          : paidPlan
            ? "expired"
            : "free",
      starts_at: stored?.starts_at || null,
      expires_at: stored?.expires_at || null,
      grace_until: graceUntil,
      source: stored?.source || "default",
    };
  }
  function isAdmin(merchant) {
    return (
      !!merchant &&
      merchant.mode === "live" &&
      !!store.config.billing?.adminMerchantId &&
      merchant.id === store.config.billing.adminMerchantId
    );
  }
  function requireAdmin(req) {
    const merchant = merchantOf(req);
    if (!isAdmin(merchant)) fail("FORBIDDEN", "仅平台管理员可操作", 403);
    return merchant;
  }
  function configuredOwner() {
    const config = store.config.billing;
    if (
      config?.enabled !== true ||
      !config.adminMerchantId ||
      !config.ownerProjectId
    )
      return { ready: false, reason: "平台尚未开启订阅收费" };
    const owner = store.get(
      "SELECT * FROM merchants WHERE id=? AND mode='live'",
      config.adminMerchantId,
    );
    const project =
      owner &&
      store.get(
        "SELECT * FROM projects WHERE id=? AND merchant_id=?",
        config.ownerProjectId,
        owner.id,
      );
    if (!owner || !project)
      return { ready: false, reason: "平台收款项目尚未配置完成" };
    if (!store.availableMethods(owner, project.id).length)
      return { ready: false, reason: "平台尚未配置可用的真实收款地址和链节点" };
    return { ready: true, owner, project };
  }
  function count(table, merchant, where = "") {
    if (
      !store.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        table,
      )
    )
      return 0;
    return store.get(
      `SELECT COUNT(*) AS n FROM ${table} WHERE merchant_id=?${where}`,
      merchant.id,
    ).n;
  }
  function usage(merchant) {
    const active = subscription(merchant),
      limits = plan(active.effective_plan_id).limits;
    const date = new Date(now()),
      monthStart = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      ).toISOString();
    const values = {
      projects: count("projects", merchant),
      addresses: count("addresses", merchant),
      api_keys: count("api_keys", merchant, " AND revoked=0"),
      endpoints: count("endpoints", merchant),
      payment_links: count("payment_links", merchant),
      products: count("products", merchant),
      monthly_paid: store.get(
        "SELECT COUNT(*) AS n FROM billing_paid_usage WHERE merchant_id=? AND paid_at>=? AND source!='platform_subscription'",
        merchant.id,
        monthStart,
      ).n,
      active_orders: count(
        "orders",
        merchant,
        " AND status IN ('pending','awaiting_payment','confirming','review')",
      ),
      api_requests:
        store.get(
          "SELECT count FROM billing_rate_buckets WHERE merchant_id=? AND bucket=?",
          merchant.id,
          Math.floor(now() / 60000),
        )?.count || 0,
      addresses_per_project: store.get(
        "SELECT COALESCE(MAX(n),0) AS n FROM (SELECT COUNT(*) AS n FROM addresses WHERE merchant_id=? GROUP BY project_id)",
        merchant.id,
      ).n,
    };
    values.monthly_paid_soft = values.monthly_paid;
    const gmv = paidGmv(merchant, false);
    const valuationIncomplete = unvaluedCount(merchant) > 0;
    values.monthly_gmv = formatAtomic(gmv, 18);
    values.monthly_gmv_soft = values.monthly_gmv;
    return Object.fromEntries(
      resources.map((key) => [
        key,
        {
          used: values[key],
          limit: limits[key],
          ...(["monthly_gmv", "monthly_gmv_soft"].includes(key)
            ? { valuation_incomplete: valuationIncomplete }
            : {}),
          ...(key === "api_requests"
            ? {
                resets_at: new Date(
                  (Math.floor(now() / 60000) + 1) * 60000,
                ).toISOString(),
              }
            : {}),
        },
      ]),
    );
  }
  function monthStart() {
    const date = new Date(now());
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    ).toISOString();
  }
  function unvaluedCount(merchant) {
    return store.get(
      "SELECT COUNT(*) AS n FROM billing_paid_usage WHERE merchant_id=? AND paid_at>=? AND source!='platform_subscription' AND valuation_status='unknown'",
      merchant.id,
      monthStart(),
    ).n;
  }
  function paidGmv(merchant, requireComplete = true) {
    if (requireComplete && unvaluedCount(merchant))
      fail(
        "BILLING_VALUATION_MISSING",
        "历史订单缺少美元计价快照，需管理员核对后继续收款",
        409,
      );
    return store
      .all(
        "SELECT usd_atomic FROM billing_paid_usage WHERE merchant_id=? AND paid_at>=? AND source!='platform_subscription' AND valuation_status!='unknown'",
        merchant.id,
        monthStart(),
      )
      .reduce((sum, item) => sum + BigInt(item.usd_atomic), 0n);
  }
  function enforceQuote(merchant, order, quote) {
    if (merchant.mode === "demo" || isAdmin(merchant)) return;
    const limits = plan(subscription(merchant).effective_plan_id).limits;
    if (!/^\d+$/.test(quote.usd_atomic || ""))
      fail("BILLING_VALUATION_MISSING", "新报价缺少锁定美元计价值", 409);
    const quoted = BigInt(quote.usd_atomic);
    const reserved = store
      .all(
        "SELECT o.* FROM orders o WHERE o.merchant_id=? AND o.order_id!=? AND o.status IN ('pending','awaiting_payment','confirming','review') AND o.payable_amount IS NOT NULL AND NOT EXISTS(SELECT 1 FROM billing_invoices i WHERE i.order_id=o.order_id)",
        merchant.id,
        order.order_id,
      )
      .reduce((sum, row) => sum + store.orderUsdAtomic(row), 0n);
    if (
      paidGmv(merchant) + reserved + quoted >
      BigInt(limits.monthly_gmv) * 10n ** 18n
    )
      fail(
        "BILLING_GMV_LIMIT",
        "本月计费收款额度已用完或已被待支付订单占用",
        402,
      );
  }
  function enforce(merchant, resource, projectId) {
    // Synthetic previews and the explicitly configured platform operator do not consume merchant quotas.
    if (merchant.mode === "demo" || isAdmin(merchant)) return;
    const u = usage(merchant);
    if (resource === "addresses" && projectId) {
      const perProject = store.get(
        "SELECT COUNT(*) AS n FROM addresses WHERE merchant_id=? AND project_id=?",
        merchant.id,
        projectId,
      ).n;
      if (perProject >= u.addresses_per_project.limit)
        fail(
          "BILLING_ADDRESS_PROJECT_LIMIT",
          "该项目已达到当前套餐的收款地址上限",
          402,
        );
    }
    if (resource === "api_requests") {
      store.transaction(() => {
        const bucket = Math.floor(now() / 60000);
        const used =
          store.get(
            "SELECT count FROM billing_rate_buckets WHERE merchant_id=? AND bucket=?",
            merchant.id,
            bucket,
          )?.count || 0;
        if (used >= u.api_requests.limit)
          fail(
            "BILLING_API_RATE_LIMITED",
            "已达到当前套餐的每分钟 API 请求额度",
            429,
          );
        store.run(
          "INSERT INTO billing_rate_buckets VALUES(?,?,1) ON CONFLICT(merchant_id,bucket) DO UPDATE SET count=count+1",
          merchant.id,
          bucket,
        );
        store.run(
          "DELETE FROM billing_rate_buckets WHERE bucket<?",
          bucket - 10,
        );
      });
      return;
    }
    if (resource === "orders") {
      if (u.monthly_gmv.valuation_incomplete)
        fail(
          "BILLING_VALUATION_MISSING",
          "历史订单缺少美元计价快照，需管理员核对",
          409,
        );
      if (u.active_orders.used >= u.active_orders.limit)
        fail(
          "BILLING_ACTIVE_ORDER_LIMIT",
          "已达到当前套餐的待处理订单上限",
          402,
        );
      // Reserve capacity for outstanding payment windows; already-issued invoices are always reconciled.
      if (u.monthly_paid.used + u.active_orders.used >= u.monthly_paid.limit)
        fail(
          "BILLING_MONTHLY_ORDER_LIMIT",
          "本月订单额度已用完或已被待支付订单占用",
          402,
        );
      return;
    }
    if (u[resource] && u[resource].used >= u[resource].limit)
      fail(
        "BILLING_RESOURCE_LIMIT",
        "已达到当前套餐的资源上限，请升级套餐",
        402,
      );
  }
  function refreshInvoices(merchantId) {
    const rows = merchantId
      ? store.all(
          "SELECT i.id,o.status AS order_status FROM billing_invoices i JOIN orders o ON o.order_id=i.order_id WHERE i.merchant_id=? AND i.status='pending'",
          merchantId,
        )
      : store.all(
          "SELECT i.id,o.status AS order_status FROM billing_invoices i JOIN orders o ON o.order_id=i.order_id WHERE i.status='pending'",
        );
    for (const row of rows)
      if (["expired", "canceled"].includes(row.order_status))
        store.run(
          "UPDATE billing_invoices SET status=? WHERE id=? AND status='pending'",
          row.order_status,
          row.id,
        );
  }
  function invoiceView(invoice) {
    const order = store.get(
      "SELECT checkout_token,status FROM orders WHERE order_id=?",
      invoice.order_id,
    );
    return {
      id: invoice.id,
      merchant_id: invoice.merchant_id,
      plan_id: invoice.plan_id,
      plan_name: invoice.plan_name,
      amount: invoice.amount,
      currency: invoice.currency,
      order_id: invoice.order_id,
      mode: invoice.mode,
      status: invoice.status,
      created_at: invoice.created_at,
      paid_at: invoice.paid_at,
      activated_at: invoice.activated_at,
      checkout_url: order ? `/checkout/${order.checkout_token}` : null,
      payment_status: order?.status || null,
    };
  }
  function afterPaid(passedOrder) {
    const order = store.get(
      "SELECT * FROM orders WHERE order_id=?",
      passedOrder.order_id,
    );
    if (!order || order.status !== "paid")
      fail("BILLING_PAYMENT_UNVERIFIED", "订阅只能由已确认支付订单激活", 409);
    const invoice = store.get(
      "SELECT * FROM billing_invoices WHERE order_id=?",
      order.order_id,
    );
    store.run(
      "INSERT OR IGNORE INTO billing_paid_usage(order_id,merchant_id,paid_at,mode,source,usd_atomic,valuation_status) VALUES(?,?,?,?,?,?,?)",
      order.order_id,
      order.merchant_id,
      isoNow(),
      order.mode,
      invoice ? "platform_subscription" : "settlement",
      String(store.orderUsdAtomic(order)),
      "locked",
    );
    if (!invoice || invoice.activated_at) return;
    const subscriber = store.merchant(invoice.merchant_id);
    if (
      order.merchant_id !== invoice.owner_merchant_id ||
      order.project_id !== invoice.owner_project_id ||
      order.mode !== invoice.mode ||
      subscriber.mode !== invoice.mode ||
      order.fiat_amount !== invoice.amount ||
      order.fiat_currency !== invoice.currency
    )
      fail("BILLING_PAYMENT_MISMATCH", "订阅账单与支付记录不匹配", 409);
    const current = subscription(subscriber);
    // There is at most one open subscription invoice per merchant. Existing active plans cannot be switched mid-term.
    if (
      ["active", "grace"].includes(current.status) &&
      current.effective_plan_id !== invoice.plan_id
    )
      fail(
        "BILLING_PLAN_CONFLICT",
        "当前套餐仍有效或处于宽限期，账单需要人工核对",
        409,
      );
    const start = current.status === "active" ? current.starts_at : isoNow();
    const base =
      current.status === "active"
        ? Math.max(now(), Date.parse(current.expires_at))
        : now();
    const expires = nextMonth(base);
    store.run(
      "INSERT INTO billing_subscriptions VALUES(?,?,?,?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET plan_id=excluded.plan_id,starts_at=excluded.starts_at,expires_at=excluded.expires_at,source=excluded.source,updated_at=excluded.updated_at",
      subscriber.id,
      invoice.plan_id,
      start,
      expires,
      invoice.mode === "demo" ? "demo_payment" : "payment",
      isoNow(),
    );
    store.run(
      "UPDATE billing_invoices SET status='paid',paid_at=?,activated_at=? WHERE id=? AND activated_at IS NULL",
      isoNow(),
      isoNow(),
      invoice.id,
    );
    store.audit(subscriber.id, "billing.subscription_activated", invoice.id);
  }
  function checkout(merchant, input) {
    const target = plan(input.plan_id);
    if (target.id === "free" || !target.enabled)
      fail("PLAN_UNAVAILABLE", "此套餐不能购买");
    if (
      typeof input.idempotency_key !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotency_key)
    )
      fail("INVALID_IDEMPOTENCY_KEY", "请提供16–128位随机请求编号");
    return store.transaction(() => {
      const key = hash(input.idempotency_key),
        requestHash = hash(target.id);
      const previous = store.get(
        "SELECT * FROM billing_invoices WHERE merchant_id=? AND idempotency_key=?",
        merchant.id,
        key,
      );
      if (previous) {
        if (previous.request_hash !== requestHash)
          fail("IDEMPOTENCY_CONFLICT", "该请求编号已用于其他套餐", 409);
        return invoiceView(previous);
      }
      const current = subscription(merchant);
      if (
        ["active", "grace"].includes(current.status) &&
        current.effective_plan_id !== target.id
      )
        fail(
          "PLAN_CHANGE_REQUIRES_EXPIRY",
          "当前套餐及宽限期结束后可切换档位；同档续费增加一个月",
          409,
        );
      refreshInvoices(merchant.id);
      if (
        store.get(
          "SELECT id FROM billing_invoices WHERE merchant_id=? AND status='pending'",
          merchant.id,
        )
      )
        fail(
          "BILLING_INVOICE_PENDING",
          "已有待支付订阅账单，请先完成或取消",
          409,
        );
      let owner, project;
      if (merchant.mode === "demo") {
        owner = merchant;
        project = store
          .all("SELECT * FROM projects WHERE merchant_id=?", merchant.id)
          .find((p) => store.availableMethods(merchant, p.id).length);
        if (!project)
          fail("BILLING_DEMO_UNCONFIGURED", "请先建立带有演示收款地址的项目");
      } else {
        const state = configuredOwner();
        if (!state.ready) fail("BILLING_DISABLED", state.reason, 503);
        owner = state.owner;
        project = state.project;
      }
      const id = uid("bi_");
      const order = store.createOrder(
        owner,
        {
          project_id: project.id,
          fiat_amount: target.price,
          fiat_currency: target.currency,
          merchant_order_id: "SUB-" + id,
          metadata: { kind: "platform_subscription", billing_invoice_id: id },
        },
        { skipLimits: true },
      );
      const invoice = {
        id,
        merchant_id: merchant.id,
        plan_id: target.id,
        plan_name: target.name,
        amount: target.price,
        currency: target.currency,
        owner_merchant_id: owner.id,
        owner_project_id: project.id,
        order_id: order.order_id,
        mode: merchant.mode,
        status: "pending",
        idempotency_key: key,
        request_hash: requestHash,
        created_at: isoNow(),
        paid_at: null,
        activated_at: null,
      };
      store.run(
        "INSERT INTO billing_invoices VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ...Object.values(invoice),
      );
      return invoiceView(invoice);
    });
  }
  function adminAudit(actor, action, merchantId, details) {
    store.run(
      "INSERT INTO billing_admin_actions VALUES(?,?,?,?,?,?)",
      uid("ba_"),
      actor.id,
      merchantId || null,
      action,
      JSON.stringify(details),
      isoNow(),
    );
    store.audit(actor.id, "platform." + action, merchantId || details.id);
  }
  function grant(actor, merchantId, input) {
    return store.transaction(() => {
      const merchant = store.merchant(merchantId),
        target = plan(input.plan_id);
      if (
        typeof input.reason !== "string" ||
        !input.reason.trim() ||
        input.reason.length > 1000
      )
        fail("GRANT_REASON_REQUIRED", "人工开通必须填写原因（最多1000字）");
      const days = input.days;
      if (
        target.id !== "free" &&
        (!Number.isInteger(days) || days < 1 || days > 366)
      )
        fail("INVALID_DURATION", "开通时长需为1–366天");
      refreshInvoices(merchantId);
      if (
        store.get(
          "SELECT id FROM billing_invoices WHERE merchant_id=? AND status='pending'",
          merchantId,
        )
      )
        fail(
          "BILLING_INVOICE_PENDING",
          "商户有待支付账单，请先处理后人工调整套餐",
          409,
        );
      const expires =
        target.id === "free"
          ? null
          : new Date(now() + days * dayMs).toISOString();
      store.run(
        "INSERT INTO billing_subscriptions VALUES(?,?,?,?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET plan_id=excluded.plan_id,starts_at=excluded.starts_at,expires_at=excluded.expires_at,source=excluded.source,updated_at=excluded.updated_at",
        merchantId,
        target.id,
        isoNow(),
        expires,
        "admin_grant",
        isoNow(),
      );
      adminAudit(actor, "subscription_grant", merchantId, {
        plan_id: target.id,
        days: target.id === "free" ? 0 : days,
        reason: input.reason.trim(),
      });
      return subscription(merchant);
    });
  }

  const priorLimit = store.enforceLimits,
    priorPaid = store.afterPaid,
    priorQuote = store.enforceQuoteLimit;
  store.enforceLimits = (merchant, resource, projectId) => {
    if (priorLimit) {
      const value = priorLimit(merchant, resource, projectId);
      if (value?.then) fail("ASYNC_BILLING_HOOK", "额度钩子必须同步");
    }
    enforce(merchant, resource, projectId);
  };
  store.afterPaid = (order) => {
    if (priorPaid) {
      const value = priorPaid(order);
      if (value?.then) fail("ASYNC_BILLING_HOOK", "支付钩子必须同步");
    }
    afterPaid(order);
  };
  store.enforceQuoteLimit = (merchant, order, quote) => {
    if (priorQuote) {
      const value = priorQuote(merchant, order, quote);
      if (value?.then) fail("ASYNC_BILLING_HOOK", "报价钩子必须同步");
    }
    enforceQuote(merchant, order, quote);
  };
  store.billing = {
    plan,
    plans,
    subscription,
    usage,
    isAdmin,
    requireAdmin,
    configuredOwner,
    refreshInvoices,
    invoiceView,
    checkout,
    grant,
    adminAudit,
    afterPaid,
    now,
    isoNow,
  };
  return store.billing;
}

export function registerBilling(app, { store }) {
  const b = initializeBilling(store);
  app.get(
    "/plans",
    wrap((req, res) =>
      res.json({
        plans: b.plans(),
        billing_enabled: b.configuredOwner().ready,
      }),
    ),
  );
  app.get(
    "/api/subscription",
    wrap((req, res) => {
      const merchant = merchantOf(req),
        sub = b.subscription(merchant),
        owner = b.configuredOwner();
      res.json({
        subscription: sub,
        plan: b.plan(sub.effective_plan_id),
        usage: b.usage(merchant),
        plans: b.plans(),
        billing_enabled: merchant.mode === "demo" || owner.ready,
        billing_mode: merchant.mode,
        billing_unavailable_reason:
          merchant.mode === "demo" || owner.ready ? null : owner.reason,
        is_admin: b.isAdmin(merchant),
      });
    }),
  );
  app.get(
    "/api/billing",
    wrap((req, res) => {
      const merchant = merchantOf(req);
      b.refreshInvoices(merchant.id);
      res.json({
        invoices: store
          .all(
            "SELECT * FROM billing_invoices WHERE merchant_id=? ORDER BY created_at DESC",
            merchant.id,
          )
          .map(b.invoiceView),
      });
    }),
  );
  app.post(
    "/api/billing/checkout",
    wrap((req, res) => {
      const invoice = b.checkout(merchantOf(req), req.body);
      res.status(201).json({ invoice, checkout_url: invoice.checkout_url });
    }),
  );
  app.post(
    "/api/billing/invoices/:id/simulate",
    wrap((req, res) => {
      const merchant = merchantOf(req),
        invoice = store.get(
          "SELECT * FROM billing_invoices WHERE id=? AND merchant_id=?",
          req.params.id,
          merchant.id,
        );
      if (!invoice) fail("NOT_FOUND", "账单不存在", 404);
      if (
        merchant.mode !== "demo" ||
        invoice.mode !== "demo" ||
        invoice.owner_merchant_id !== merchant.id
      )
        fail("DEMO_ONLY", "仅本人隔离演示账单可模拟付款", 403);
      let order = store.ownedOrder(merchant, invoice.order_id);
      if (!order.chain) {
        const method = store.availableMethods(merchant, order.project_id, { payment_mode: order.payment_mode })[0];
        if (!method) fail("METHOD_REQUIRED", "请先配置演示支付方式");
        store.transaction(() =>
          store.selectMethod(order, method.chain, method.token_id),
        );
      }
      store.simulate(merchant, order.order_id);
      res.json({
        invoice: b.invoiceView(
          store.get("SELECT * FROM billing_invoices WHERE id=?", invoice.id),
        ),
        subscription: b.subscription(merchant),
      });
    }),
  );
  app.post(
    "/api/billing/invoices/:id/cancel",
    wrap((req, res) => {
      const merchant = merchantOf(req),
        invoice = store.get(
          "SELECT * FROM billing_invoices WHERE id=? AND merchant_id=?",
          req.params.id,
          merchant.id,
        );
      if (!invoice) fail("NOT_FOUND", "账单不存在", 404);
      if (invoice.status !== "pending")
        fail("BILLING_INVOICE_NOT_CANCELABLE", "此账单不能取消", 409);
      store.transaction(() => {
        store.cancel(
          store.merchant(invoice.owner_merchant_id),
          invoice.order_id,
          invoice.owner_project_id,
        );
        store.run(
          "UPDATE billing_invoices SET status='canceled' WHERE id=?",
          invoice.id,
        );
      });
      res.json({
        invoice: b.invoiceView(
          store.get("SELECT * FROM billing_invoices WHERE id=?", invoice.id),
        ),
      });
    }),
  );
  app.get(
    "/api/platform/plans",
    wrap((req, res) => {
      b.requireAdmin(req);
      res.json({ plans: b.plans(true) });
    }),
  );
  app.patch(
    "/api/platform/plans",
    wrap((req, res) => {
      const actor = b.requireAdmin(req),
        previous = b.plan(req.body.id);
      const name = req.body.name ?? previous.name;
      if (typeof name !== "string" || !name.trim() || name.length > 80)
        fail("INVALID_PLAN", "套餐名称格式不正确");
      const priceValue = req.body.price ?? previous.price;
      if (typeof priceValue !== "string")
        fail("INVALID_AMOUNT", "套餐价格须为十进制字符串");
      const cents = decimalAtomic(priceValue, 2);
      if (
        (previous.id === "free" && cents !== 0n) ||
        (previous.id !== "free" && (cents <= 0n || cents > 100000000n))
      )
        fail("INVALID_AMOUNT", "套餐价格超出允许范围");
      const enabled = req.body.enabled ?? previous.enabled;
      if (typeof enabled !== "boolean" || (previous.id === "free" && !enabled))
        fail("INVALID_PLAN", "免费套餐必须保持启用");
      if (
        req.body.limits !== undefined &&
        (!req.body.limits ||
          Array.isArray(req.body.limits) ||
          typeof req.body.limits !== "object")
      )
        fail("INVALID_LIMITS", "额度配置必须为对象");
      const limits = { ...previous.limits, ...(req.body.limits || {}) };
      for (const [resource, value] of Object.entries(limits))
        if (
          !resources.includes(resource) ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 10000000
        )
          fail("INVALID_LIMITS", "额度须为0–10000000整数，且使用支持的资源名");
      if (
        limits.monthly_paid_soft > limits.monthly_paid ||
        limits.monthly_gmv_soft > limits.monthly_gmv
      )
        fail("INVALID_LIMITS", "软提醒阈值不能超过硬上限");
      store.transaction(() => {
        store.run(
          "UPDATE billing_plans SET name=?,price=?,limits_json=?,enabled=?,updated_at=? WHERE id=?",
          name.trim(),
          formatAtomic(cents),
          JSON.stringify(limits),
          enabled ? 1 : 0,
          b.isoNow(),
          previous.id,
        );
        b.adminAudit(actor, "plan_update", null, {
          id: previous.id,
          before: previous,
          after: { name, price: formatAtomic(cents), limits, enabled },
        });
      });
      res.json({ plan: b.plan(previous.id), plans: b.plans(true) });
    }),
  );
  app.get(
    "/api/platform/merchants",
    wrap((req, res) => {
      b.requireAdmin(req);
      res.json({
        merchants: store
          .all(
            "SELECT id,email,name,mode,created_at FROM merchants ORDER BY created_at DESC",
          )
          .map((merchant) => {
            const subscription = b.subscription(merchant);
            return {
              ...merchant,
              subscription,
              plan: b.plan(subscription.effective_plan_id),
              usage: b.usage(merchant),
            };
          }),
      });
    }),
  );
  app.get(
    "/api/platform/invoices",
    wrap((req, res) => {
      b.requireAdmin(req);
      b.refreshInvoices();
      res.json({
        invoices: store
          .all(
            "SELECT * FROM billing_invoices ORDER BY created_at DESC LIMIT 1000",
          )
          .map(b.invoiceView),
      });
    }),
  );
  app.post(
    "/api/platform/merchants/:id/grant",
    wrap((req, res) =>
      res.json({
        subscription: b.grant(b.requireAdmin(req), req.params.id, req.body),
      }),
    ),
  );
  app.get(
    "/api/platform/grants",
    wrap((req, res) => {
      b.requireAdmin(req);
      res.json({
        actions: store
          .all(
            "SELECT * FROM billing_admin_actions ORDER BY created_at DESC LIMIT 500",
          )
          .map((action) => ({
            ...action,
            details: JSON.parse(action.details),
          })),
      });
    }),
  );
}
