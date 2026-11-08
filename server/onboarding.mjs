import { fail } from "./core.mjs";
import { assetForToken } from "./pricing.mjs";

// 开通进度只表示当前配置是否齐备，不代替真实付款和商户发货验收。
export function onboardingState(store, merchant) {
  const billing = store.billing;
  const subscription = billing.subscription(merchant);
  const owner = billing.configuredOwner();
  const supportedChains = store.registry.flatMap((chain) => {
    const tokens = chain.tokens
      .filter((token) => merchant.mode === "demo" || store.configured(chain.id, token.id))
      .map((token) => {
        let quoteReady = true;
        try {
          store.priceBook.asset(assetForToken(token.id), merchant.mode);
        } catch {
          quoteReady = false;
        }
        return {
          id: token.id,
          symbol: token.symbol,
          decimals: token.decimals,
          quote_ready: quoteReady,
          unavailable_reason: quoteReady ? null : "实时行情暂未就绪，请稍后重试",
        };
      });
    return tokens.length ? [{ id: chain.id, name: chain.name, tokens }] : [];
  });
  const quotable = new Set(supportedChains.flatMap((chain) =>
    chain.tokens.filter((token) => token.quote_ready).map((token) => `${chain.id}:${token.id}`)));

  const projects = store.all(
    "SELECT id,name FROM projects WHERE merchant_id=? ORDER BY created_at,id",
    merchant.id,
  ).map((project) => {
    const count = (table, where = "") => store.get(
      `SELECT COUNT(*) AS n FROM ${table} WHERE merchant_id=? AND project_id=?${where}`,
      merchant.id, project.id,
    ).n;
    const configuredMethods = store.availableMethods(merchant, project.id);
    const availableMethods = configuredMethods.filter((method) => quotable.has(`${method.chain}:${method.token_id}`));
    const addressCount = store.get(
      "SELECT COUNT(*) AS n FROM addresses WHERE merchant_id=? AND project_id=? AND mode=?",
      merchant.id, project.id, merchant.mode,
    ).n;
    const enabledAddressCount = store.get(
      "SELECT COUNT(*) AS n FROM addresses WHERE merchant_id=? AND project_id=? AND mode=? AND enabled=1",
      merchant.id, project.id, merchant.mode,
    ).n;
    const paymentLinksCount = count("payment_links", " AND enabled=1");
    const apiKeysCount = count("api_keys", " AND revoked=0");
    const webhooksCount = store.get(
      "SELECT COUNT(*) AS n FROM endpoints e LEFT JOIN endpoint_state s ON s.endpoint_id=e.id WHERE e.merchant_id=? AND e.project_id=? AND COALESCE(s.enabled,1)=1",
      merchant.id, project.id,
    ).n;
    const stock = store.get(
      "SELECT COUNT(i.id) AS inventory_count,COUNT(DISTINCT p.id) AS stocked_products_count FROM products p JOIN inventory i ON i.product_id=p.id AND i.merchant_id=p.merchant_id WHERE p.merchant_id=? AND p.project_id=? AND i.order_id IS NULL",
      merchant.id, project.id,
    );
    const collectionConfigured = configuredMethods.length > 0;
    const collectionReady = availableMethods.length > 0;
    const paymentLinkConfigured = paymentLinksCount > 0;
    const apiConfigured = apiKeysCount > 0 && webhooksCount > 0;
    const deliveryConfigured = stock.stocked_products_count > 0;
    const paymentLinkReady = collectionReady && paymentLinkConfigured;
    const apiReady = collectionReady && apiConfigured;
    const deliveryReady = collectionReady && deliveryConfigured;
    return {
      ...project,
      address_count: addressCount,
      enabled_address_count: enabledAddressCount,
      configured_methods: configuredMethods,
      available_methods: availableMethods,
      collection_configured: collectionConfigured,
      collection_ready: collectionReady,
      collection_unavailable_reason: collectionReady ? null : collectionConfigured
        ? "实时行情暂未就绪，已保存的收款配置无需重复添加"
        : enabledAddressCount ? "地址已保存，但平台尚未开启对应网络、币种或支付方式" : "请添加并启用收款地址",
      payment_links_count: paymentLinksCount,
      api_keys_count: apiKeysCount,
      webhooks_count: webhooksCount,
      products_count: count("products"),
      ...stock,
      payment_link_configured: paymentLinkConfigured,
      api_integration_configured: apiConfigured,
      digital_delivery_configured: deliveryConfigured,
      payment_link_ready: paymentLinkReady,
      api_integration_ready: apiReady,
      digital_delivery_ready: deliveryReady,
      setup_configured: collectionConfigured && (paymentLinkConfigured || apiConfigured || deliveryConfigured),
      setup_ready: paymentLinkReady || apiReady || deliveryReady,
    };
  });
  const collectionConfigured = projects.some((project) => project.collection_configured);
  const collectionReady = projects.some((project) => project.collection_ready);
  const setupConfigured = projects.some((project) => project.setup_configured);
  const setupReady = projects.some((project) => project.setup_ready);
  // 不返回已过期收银台，也不在读取开通状态时激活订阅或改动订单。
  const invoice = store.all(
    "SELECT i.*,o.status AS order_status,o.expires_at,o.selection_deadline,o.chain FROM billing_invoices i JOIN orders o ON o.order_id=i.order_id WHERE i.merchant_id=? AND i.mode=? AND i.status='pending' ORDER BY i.created_at DESC",
    merchant.id, merchant.mode,
  ).find((row) => row.order_status === "confirming" ||
    ["pending", "awaiting_payment"].includes(row.order_status) &&
    Date.parse(row.chain ? row.expires_at : row.selection_deadline || row.expires_at) > Date.now());

  return {
    mode: merchant.mode,
    subscription,
    plan: billing.plan(subscription.effective_plan_id),
    billing_enabled: merchant.mode === "demo" || owner.ready,
    billing_unavailable_reason: merchant.mode === "demo" || owner.ready ? null : owner.reason,
    pending_invoice: invoice ? billing.invoiceView(invoice) : null,
    supported_chains: supportedChains,
    projects,
    collection_configured: collectionConfigured,
    collection_ready: collectionReady,
    collection_unavailable_reason: collectionReady ? null : collectionConfigured
      ? "实时行情暂未就绪，已保存的收款配置无需重复添加"
      : projects.length ? "请在项目中配置平台已开启的网络和收款地址" : "请先创建收款项目",
    setup_configured: setupConfigured,
    setup_ready: setupReady,
    next_step: !projects.length ? "project" : !collectionConfigured ? "address" : !setupConfigured ? "integration" : "ready",
  };
}

export function registerOnboarding(app, { store }) {
  app.get("/api/onboarding", (req, res, next) => {
    try {
      const merchant = req.merchant || fail("UNAUTHORIZED", "请先登录", 401);
      res.json(onboardingState(store, merchant));
    } catch (error) {
      next(error);
    }
  });
}
