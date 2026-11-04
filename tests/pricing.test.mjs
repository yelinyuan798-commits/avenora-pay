import test from "node:test";
import assert from "node:assert/strict";
import { PriceBook, parseFixed, fixed, USD_SCALE, BNB_PAYMENT_QUANTUM, roundUpBnbPayment } from "../server/pricing.mjs";
import { Store } from "../server/core.mjs";
import { initializeBilling } from "../server/billing.mjs";

const assets = {
  BTC: "100000",
  ETH: "2000",
  BNB: "500",
  SOL: "100",
  TRX: "0.25",
  USDT: "1",
  USDC: "1",
};
const registry = [
  {
    id: "bitcoin",
    family: "bitcoin",
    confirmations: 6,
    tokens: [{ id: "bitcoin-btc", symbol: "BTC", kind: "native", decimals: 8 }],
  },
  {
    id: "ethereum",
    family: "evm",
    confirmations: 20,
    tokens: [
      { id: "ethereum-eth", symbol: "ETH", kind: "native", decimals: 18 },
    ],
  },
  {
    id: "bsc",
    family: "evm",
    confirmations: 15,
    tokens: [
      { id: "bsc-bnb", symbol: "BNB", kind: "native", decimals: 18 },
      { id: "bsc-usdt", symbol: "USDT", kind: "token", decimals: 18 },
    ],
  },
  {
    id: "solana",
    family: "solana",
    confirmations: 32,
    tokens: [{ id: "solana-sol", symbol: "SOL", kind: "native", decimals: 9 }],
  },
  {
    id: "tron",
    family: "tron",
    confirmations: 19,
    tokens: [{ id: "tron-trx", symbol: "TRX", kind: "native", decimals: 6 }],
  },
];
function fixture() {
  let time = Date.now();
  const book = new PriceBook({ now: () => time });
  for (const [asset, price] of Object.entries(assets))
    book.recordAsset(asset, price);
  book.recordFiatUsd("CNY", "0.14");
  book.recordFiatUsd("EUR", "1.08");
  const config = Object.fromEntries(
    registry.map((c) => [
      c.id,
      {
        startBlock: 0,
        enabled: true,
        rpcUrl: "https://fixture.invalid",
        tokens: c.tokens.map((t) => ({
          ...t,
          ...(t.kind === "token" ? { contract: "0x" + "a".repeat(40) } : {}),
        })),
      },
    ]),
  );
  const store = new Store({ registry, config, priceBook: book });
  const m = store.register({
    email: "pricing@example.test",
    password: "fixture-password-123",
  });
  const p = store.createProject(m, { name: "Multi-coin store" });
  for (const c of registry)
    store.addAddress(m, {
      project_id: p.id,
      chain: c.id,
      address: "fixture:" + c.id,
    });
  return {
    store,
    m,
    p,
    book,
    advance: (ms) => (time += ms),
    close: () => store.close(),
  };
}
function order(f, chain, tokenId, extra = {}) {
  return f.store.createOrder(f.m, {
    project_id: f.p.id,
    fiat_amount: "10.00",
    fiat_currency: "USD",
    chain,
    token_id: tokenId,
    ...extra,
  });
}
function settle(f, o) {
  const raw = f.store.ownedOrder(f.m, o.order_id);
  return f.store.ingest({
    chain: raw.chain,
    token_id: raw.token_id,
    tx_hash: "fixture-" + raw.order_id,
    event_index: 0,
    to_address: raw.pay_address,
    from_address: "fixture-payer",
    amount_atomic: raw.payable_atomic,
    block_height: 100,
    block_hash: "fixture-block",
    block_time: new Date().toISOString(),
    confirmations: raw.required_confirmations,
    confirmed: true,
    removed: false,
  });
}

test("official provider refresh validates asset identity, stores fiat inversion and retains age on failed refresh", async () => {
  let time = Date.now(),
    bad = false;
  const seen = [];
  const book = new PriceBook({
    now: () => time,
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.includes("exchange-rates"))
        return new Response(
          JSON.stringify({
            data: { currency: "USD", rates: { CNY: "7.2", EUR: "0.9" } },
          }),
          { headers: { date: new Date(time).toUTCString() } },
        );
      const asset = /prices\/([A-Z]+)-USD/.exec(url)[1];
      return new Response(
        JSON.stringify({
          data: {
            base: bad && asset === "BTC" ? "ETH" : asset,
            currency: "USD",
            amount: assets[asset],
          },
        }),
        { headers: { date: new Date(time).toUTCString() } },
      );
    },
  });
  assert.equal((await book.refresh()).failures.length, 0);
  assert.ok(seen.every((url) => url.startsWith("https://api.coinbase.com/")));
  const quoted = book.quote({
    tokenId: "bitcoin-btc",
    decimals: 8,
    fiatAmount: "72.00",
    currency: "CNY",
    mode: "live",
  });
  assert.equal(quoted.amount, 10000n);
  assert.equal(quoted.usdTarget, 10n * USD_SCALE);
  bad = true;
  time += 121000;
  const result = await book.refresh();
  assert.ok(result.failures.some((x) => x.startsWith("BTC:")));
  assert.throws(
    () =>
      book.quote({
        tokenId: "bitcoin-btc",
        decimals: 8,
        fiatAmount: "10.00",
        currency: "USD",
        mode: "live",
      }),
    (e) => e.code === "PRICE_STALE",
  );
});
test("live missing or stale quotes fail closed, explicit parity applies only to known stablecoins", () => {
  const f = fixture();
  f.book.cache.delete("asset:BTC");
  assert.throws(
    () => order(f, "bitcoin", "bitcoin-btc"),
    (e) => e.code === "PRICE_UNAVAILABLE",
  );
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM orders").n, 0);
  f.book.configSource = { stablePolicy: "parity" };
  f.book.cache.delete("asset:USDT");
  assert.ok(order(f, "bsc", "bsc-usdt"));
  assert.throws(
    () => order(f, "bitcoin", "bitcoin-btc"),
    (e) => e.code === "PRICE_UNAVAILABLE",
  );
  f.book.recordAsset("BTC", "100000");
  f.advance(121000);
  assert.throws(
    () => order(f, "bitcoin", "bitcoin-btc"),
    (e) => e.code === "PRICE_STALE",
  );
  assert.throws(
    () =>
      f.book.quote({
        tokenId: "unknown-usdt",
        decimals: 6,
        fiatAmount: "10.00",
        currency: "USD",
        mode: "live",
      }),
    (e) => e.code === "PRICE_ASSET_UNKNOWN",
  );
  f.close();
});
test("BTC dust is rejected before fingerprint; tiny native amounts round upward without zero", () => {
  const f = fixture();
  assert.throws(
    () => order(f, "bitcoin", "bitcoin-btc", { fiat_amount: "0.01" }),
    (e) => e.code === "BTC_DUST_AMOUNT",
  );
  assert.throws(
    () => order(f, "bitcoin", "bitcoin-btc", { fiat_amount: "0.54" }),
    (e) => e.code === "BTC_DUST_AMOUNT",
  );
  const btc = order(f, "bitcoin", "bitcoin-btc", { fiat_amount: "0.55" });
  assert.ok(parseFixed(btc.payable_amount, 8) >= 546n);
  assert.equal(btc.token_decimals, 8);
  const eth = order(f, "ethereum", "ethereum-eth", { fiat_amount: "0.01" });
  assert.ok(parseFixed(eth.payable_amount, 18) > 0n);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM orders").n, 2);
  f.close();
});
test("fingerprint bound includes conversion rounding and never raises tiny BTC to bypass dust", () => {
  const f = fixture();
  for (const c of registry) {
    const t = c.tokens[0],
      o = order(f, c.id, t.id);
    assert.ok(parseFixed(o.pricing.fingerprint_usd) <= parseFixed("0.01"));
    assert.ok(
      parseFixed(o.pricing.fingerprint_usd) <=
        parseFixed(o.pricing.fingerprint_limit_usd),
    );
    assert.ok(parseFixed(o.pricing.usd_value) > 10n * USD_SCALE);
    assert.equal(o.token_symbol, t.symbol);
    assert.equal(o.token_decimals, t.decimals);
  }
  f.book.recordAsset("BTC", "900000");
  assert.throws(
    () => order(f, "bitcoin", "bitcoin-btc", { fiat_amount: "10.00" }),
    (e) => e.code === "AMOUNT_POOL_EXHAUSTED",
  );
  f.close();
});
test("BNB live quotes allocate six-decimal amounts before reserving unique payment quantities", () => {
  const f = fixture();
  f.book.recordAsset("BNB", "715.62");
  const quote = f.book.quote({ tokenId: "bsc-bnb", decimals: 18, fiatAmount: "1.00", currency: "USD", mode: "live" });
  assert.equal(quote.amount, 1398000000000000n);
  assert.equal(quote.step, 1000000000000n);
  assert.equal(quote.snapshot.payment_decimals, 6);
  assert.equal(quote.snapshot.rounding_quantum_atomic, "1000000000000");
  assert.equal(quote.snapshot.token_decimals, 18);
  assert.ok(quote.usdValue(quote.amount) >= quote.usdTarget);
  assert.equal(roundUpBnbPayment(1397529415052683n), 1398000000000000n);
  const first = order(f, "bsc", "bsc-bnb", { fiat_amount: "1.00" });
  const second = order(f, "bsc", "bsc-bnb", { fiat_amount: "1.00" });
  assert.equal(first.payable_amount, "0.001399");
  assert.equal(second.payable_amount, "0.0014");
  assert.equal(parseFixed(first.payable_amount), 1399000000000000n);
  assert.equal(parseFixed(second.payable_amount), 1400000000000000n);
  for (const o of [first, second]) {
    assert.match(o.payable_amount, /^\d+\.\d{1,6}$/);
    const raw = f.store.ownedOrder(f.m, o.order_id);
    assert.equal(BigInt(raw.payable_atomic) % BNB_PAYMENT_QUANTUM, 0n);
    const reserved = f.store.orderQuote(raw);
    assert.equal(reserved.payable_atomic, raw.payable_atomic);
    assert.ok(parseFixed(o.pricing.fingerprint_usd) <= parseFixed(o.pricing.fingerprint_limit_usd));
  }
  settle(f, first);
  assert.equal(f.store.ownedOrder(f.m, first.order_id).status, "paid");
  assert.equal(f.store.ownedOrder(f.m, second.order_id).status, "pending");
  f.close();
});
test("BNB conversion rounding consumes the existing budget and rejects unusable payment precision", () => {
  const f = fixture();
  f.book.recordAsset("BNB", "715.62");
  const quote = f.book.quote({ tokenId: "bsc-bnb", decimals: 18, fiatAmount: "0.10", currency: "USD", mode: "live" });
  assert.equal(quote.amount % BNB_PAYMENT_QUANTUM, 0n);
  assert.equal(quote.step % BNB_PAYMENT_QUANTUM, 0n);
  assert.equal(quote.maxDelta % BNB_PAYMENT_QUANTUM, 0n);
  assert.ok(quote.step >= BNB_PAYMENT_QUANTUM);
  assert.ok(quote.usdValue(quote.amount + quote.maxDelta) - quote.usdTarget <= quote.budget);
  assert.ok(quote.usdValue(quote.amount + quote.maxDelta + BNB_PAYMENT_QUANTUM) - quote.usdTarget > quote.budget);
  assert.throws(() => order(f, "bsc", "bsc-bnb", { fiat_amount: "0.01" }), e => e.code === "PRICE_AMOUNT_TOO_SMALL");
  f.book.recordAsset("BNB", "1000000");
  assert.throws(() => order(f, "bsc", "bsc-bnb", { fiat_amount: "0.01" }), e => e.code === "PRICE_AMOUNT_TOO_SMALL");
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM orders").n, 0);
  assert.throws(() => f.book.quote({ tokenId: "bsc-bnb", decimals: 8, fiatAmount: "1.00", currency: "USD", mode: "live" }), e => e.code === "INVALID_PRICE_CONFIG");
  const eth = f.book.quote({ tokenId: "ethereum-eth", decimals: 18, fiatAmount: "1.00", currency: "USD", mode: "live" });
  assert.equal(eth.snapshot.payment_decimals, undefined);
  assert.equal(eth.snapshot.rounding_quantum_atomic, undefined);
  f.close();
});
test("fee, fiat conversion and USD value are locked and settlement ignores later market movements", () => {
  const f = fixture();
  f.store.updateProjectSettings(f.m, f.p.id, {
    fee_enabled: true,
    fee_percent: "1.50",
  });
  const o = order(f, "ethereum", "ethereum-eth", {
    fiat_amount: "7.00",
    fiat_currency: "CNY",
  });
  assert.equal(o.fee_amount, "0.11");
  assert.equal(o.fiat_total, "7.11");
  assert.equal(o.pricing.fiat_usd_rate, "0.14");
  assert.equal(o.payable_amount, "0.000497750000000000");
  const locked = f.store.orderUsdAtomic(f.store.ownedOrder(f.m, o.order_id));
  assert.equal(locked, parseFixed("0.9955"));
  f.book.recordAsset("ETH", "4000");
  f.store.updateProjectSettings(f.m, f.p.id, { fee_percent: "9.00" });
  const current = f.store.orderView(f.store.ownedOrder(f.m, o.order_id));
  assert.equal(current.pricing.token_usd_price, "2000");
  assert.equal(current.payable_amount, o.payable_amount);
  settle(f, o);
  assert.equal(
    f.store.orderUsdAtomic(f.store.ownedOrder(f.m, o.order_id)),
    locked,
  );
  f.close();
});
test("volatile selections cannot extend payment window; BTC starts with 20 minutes and late mining requires review", () => {
  const f = fixture();
  const allowed = registry.map((c) => ({
    chain: c.id,
    token_id: c.tokens[0].id,
  }));
  const o = f.store.createOrder(f.m, {
    project_id: f.p.id,
    fiat_amount: "10.00",
    allowed_methods: allowed,
  });
  const btc = f.store.selectMethod(
    f.store.ownedOrder(f.m, o.order_id),
    "bitcoin",
    "bitcoin-btc",
  );
  assert.ok(
    Date.parse(btc.expires_at) - Date.parse(btc.payment_started_at) >= 1199000,
  );
  const eth = f.store.selectMethod(
    f.store.ownedOrder(f.m, o.order_id),
    "ethereum",
    "ethereum-eth",
  );
  assert.ok(
    Date.parse(eth.expires_at) - Date.parse(eth.payment_started_at) <= 600100,
  );
  assert.ok(Date.parse(eth.expires_at) <= Date.parse(btc.expires_at));
  assert.throws(
    () =>
      f.store.selectMethod(
        f.store.ownedOrder(f.m, o.order_id),
        "bitcoin",
        "bitcoin-btc",
      ),
    (e) => e.code === "BTC_WINDOW_TOO_SHORT",
  );
  const another = order(f, "bitcoin", "bitcoin-btc");
  const raw = f.store.ownedOrder(f.m, another.order_id);
  f.store.ingest({
    chain: raw.chain,
    token_id: raw.token_id,
    tx_hash: "late-btc",
    event_index: 0,
    to_address: raw.pay_address,
    amount_atomic: raw.payable_atomic,
    block_height: 100,
    block_hash: "late-block",
    block_time: new Date(Date.parse(raw.expires_at) + 1000).toISOString(),
    confirmations: 6,
    confirmed: true,
    removed: false,
  });
  assert.equal(f.store.ownedOrder(f.m, another.order_id).status, "pending");
  assert.equal(
    f.store.get("SELECT reason FROM transfers WHERE tx_hash=?", "late-btc")
      .reason,
    "outside_order_window",
  );
  f.close();
});
test("native coin GMV reserves and records locked USD including fee and fingerprint, not token units", () => {
  const f = fixture();
  const billing = initializeBilling(f.store);
  const limits = {
    ...billing.plan("free").limits,
    monthly_gmv: 20,
    monthly_gmv_soft: 15,
  };
  f.store.run(
    "UPDATE billing_plans SET limits_json=? WHERE id=?",
    JSON.stringify(limits),
    "free",
  );
  const a = order(f, "bitcoin", "bitcoin-btc", {
    metadata: { kind: "platform_subscription" },
  });
  assert.throws(
    () => order(f, "ethereum", "ethereum-eth"),
    (e) => e.code === "BILLING_GMV_LIMIT",
  );
  f.book.recordAsset("BTC", "200000");
  settle(f, a);
  assert.equal(billing.usage(f.m).monthly_gmv.used, a.pricing.usd_value);
  assert.ok(parseFixed(billing.usage(f.m).monthly_gmv.used) > 10n * USD_SCALE);
  assert.throws(
    () => order(f, "ethereum", "ethereum-eth"),
    (e) => e.code === "BILLING_GMV_LIMIT",
  );
  f.close();
});
test("unknown historical native valuation blocks new business rather than silently counting one dollar per coin", () => {
  const f = fixture();
  const o = order(f, "bitcoin", "bitcoin-btc");
  settle(f, o);
  f.store.run("UPDATE amount_reservations SET pricing_json=NULL");
  const billing = initializeBilling(f.store);
  assert.equal(billing.usage(f.m).monthly_gmv.valuation_incomplete, true);
  assert.throws(
    () => order(f, "ethereum", "ethereum-eth"),
    (e) => e.code === "BILLING_VALUATION_MISSING",
  );
  f.close();
});
test("demo prices are explicitly fixed and do not call an external service", () => {
  const book = new PriceBook({
    fetchImpl: () => {
      throw Error("must not fetch");
    },
  });
  const quote = book.quote({
    tokenId: "bitcoin-btc",
    decimals: 8,
    fiatAmount: "10.00",
    currency: "USD",
    mode: "demo",
  });
  assert.equal(quote.snapshot.price_source, "demo_fixed");
  assert.equal(quote.snapshot.is_demo, true);
  assert.equal(quote.snapshot.token_usd_price, "50000");
  assert.equal(quote.amount, 20000n);
  assert.equal(quote.snapshot.price_valid_until, null);
});
