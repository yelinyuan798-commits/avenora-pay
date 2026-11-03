import test from "node:test";
import assert from "node:assert/strict";
import {
  displayAmount,
  tokenSymbol,
  pricingSourceLabel,
} from "../client/money.js";

test("payment amount display preserves complete BTC, SOL and EVM decimal precision", () => {
  for (const amount of [
    "0.00000546",
    "0.000000001",
    "0.000000000000000001",
    "12345678901234567890.123456789012345678",
    "0.010000000000000000",
  ]) {
    assert.equal(displayAmount(amount), amount);
  }
  assert.equal(displayAmount(null), "—");
  assert.equal(displayAmount(""), "—");
});

test("coin labels prefer server symbols and retain fallback for all native networks", () => {
  assert.equal(
    tokenSymbol({ token_symbol: "USDT0", token_id: "plasma-usdt" }),
    "USDT0",
  );
  for (const [token_id, symbol] of [
    ["bitcoin-btc", "BTC"],
    ["ethereum-eth", "ETH"],
    ["base-eth", "ETH"],
    ["arbitrum-eth", "ETH"],
    ["bsc-bnb", "BNB"],
    ["solana-sol", "SOL"],
    ["tron-trx", "TRX"],
  ]) {
    assert.equal(tokenSymbol({ token_id }), symbol);
  }
});

test("quote copy distinguishes fixed demonstration and configured pricing from observed market snapshots", () => {
  assert.equal(
    pricingSourceLabel({ price_source: "demo_fixed" }),
    "演示固定价格 · 不是实时行情",
  );
  assert.equal(
    pricingSourceLabel({ is_demo: true, price_source: "coinbase_spot" }),
    "演示固定价格 · 不是实时行情",
  );
  assert.equal(
    pricingSourceLabel({ price_source: "configured_stable_parity" }),
    "稳定币配置计价 · 非实时行情",
  );
  assert.equal(
    pricingSourceLabel({ price_source: "coinbase_spot" }),
    "Coinbase 现货报价快照",
  );
});
