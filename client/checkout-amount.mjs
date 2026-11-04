// 金额始终按十进制字符串展示，只去掉不影响数值的尾零。
export function compactExactAmount(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))
    return value == null || value === "" ? "—" : String(value);
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.replace(/0+$/, "") || "0"}`;
}

export function checkoutAmountRules(order = {}) {
  const matching = order.amount_matching;
  const conflictOnly =
    order.payment_mode !== "reference" && matching?.strategy === "conflict_only";
  const decimal = (value) =>
    typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value);
  const hasDetails =
    conflictOnly &&
    matching.exact === true &&
    [matching.base_amount, matching.increment, matching.adjustment].every(decimal) &&
    /[1-9]/.test(matching.increment);
  return {
    conflictOnly,
    // 新规则绝不退回旧的省尾数提示，即使说明元数据不完整。
    allowTolerance: !conflictOnly,
    payable: conflictOnly
      ? compactExactAmount(order.payable_amount)
      : order.payable_amount,
    matching: hasDetails
      ? {
          baseAmount: compactExactAmount(matching.base_amount),
          increment: compactExactAmount(matching.increment),
          adjustment: compactExactAmount(matching.adjustment),
          adjusted: /[1-9]/.test(matching.adjustment),
        }
      : null,
  };
}
