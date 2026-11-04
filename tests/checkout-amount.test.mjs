import test from "node:test";
import assert from "node:assert/strict";
import {
  compactExactAmount,
  checkoutAmountRules,
} from "../client/checkout-amount.mjs";

test("收银台去掉尾零但保留七位识别增量和最小链上单位", () => {
  for (const [input, output] of [
    ["1.000000000000000000", "1.0"],
    ["1.000000100000000000", "1.0000001"],
    ["1.000000200000000000", "1.0000002"],
    ["0.000000000000000001", "0.000000000000000001"],
    ["12345678901234567890.123456789012345678", "12345678901234567890.123456789012345678"],
    ["17", "17.0"],
  ]) assert.equal(compactExactAmount(input), output);
});

test("金额冲突模式使用完整应付数量并关闭旧省尾数提示", () => {
  const result = checkoutAmountRules({
    payment_mode: "amount",
    payable_amount: "1.000000100000000000",
    payment_tolerance: { enabled: true, minimum_amount: "1.0" },
    amount_matching: {
      strategy: "conflict_only",
      base_amount: "1.000000000000000000",
      increment: "0.000000100000000000",
      adjustment: "0.000000100000000000",
      exact: true,
    },
  });
  assert.equal(result.payable, "1.0000001");
  assert.equal(result.allowTolerance, false);
  assert.deepEqual(result.matching, {
    baseAmount: "1.0", increment: "0.0000001", adjustment: "0.0000001", adjusted: true,
  });
  assert.equal(checkoutAmountRules({
    payment_mode: "amount", payable_amount: "1.0",
    amount_matching: { strategy: "conflict_only", base_amount: "1.0", increment: "0.0000001", adjustment: "0.0", exact: true },
  }).matching.adjusted, false);
});

test("旧订单格式不变，缺失新说明字段也不能显示省尾数下限", () => {
  for (const payment_mode of ["amount", "reference"]) {
    const old = checkoutAmountRules({ payment_mode, payable_amount: "1.000100000000000000" });
    assert.equal(old.payable, "1.000100000000000000");
    assert.equal(old.matching, null);
  }
  const malformed = checkoutAmountRules({
    payment_mode: "amount", payable_amount: "1.0000001",
    amount_matching: { strategy: "conflict_only", increment: "0" },
  });
  assert.equal(malformed.allowTolerance, false);
  assert.equal(malformed.matching, null);
});
