// Payment amounts arrive as exact decimal strings. Never round them through Number.
export function displayAmount(value) {
  return value == null || value === "" ? "—" : String(value);
}

export function tokenSymbol(value = {}) {
  return (
    value.token_symbol ||
    value.symbol ||
    value.token_id?.split("-").at(-1)?.toUpperCase() ||
    ""
  );
}

export function pricingSourceLabel(pricing = {}) {
  if (pricing.is_demo || pricing.price_source === "demo_fixed")
    return "演示固定价格 · 不是实时行情";
  if (pricing.price_source === "coinbase_spot") return "Coinbase 现货报价快照";
  if (pricing.price_source === "configured_stable_parity")
    return "稳定币配置计价 · 非实时行情";
  return "订单报价快照";
}
