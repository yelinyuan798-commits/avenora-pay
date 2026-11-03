// Prices are server-owned: only fixed Coinbase HTTPS endpoints populate the live cache.
export const USD_SCALE = 10n ** 18n;
const ASSETS = ["BTC", "ETH", "BNB", "SOL", "TRX", "USDT", "USDC"];
const TOKEN_ASSETS = {
  "bitcoin-btc": "BTC",
  "ethereum-eth": "ETH",
  "base-eth": "ETH",
  "arbitrum-eth": "ETH",
  "bsc-bnb": "BNB",
  "solana-sol": "SOL",
  "tron-trx": "TRX",
  "tron-usdt": "USDT",
  "ethereum-usdt": "USDT",
  "ethereum-usdc": "USDC",
  "bsc-usdt": "USDT",
  "bsc-usdc": "USDC",
  "polygon-usdc": "USDC",
  "polygon-usdt0": "USDT",
  "base-usdc": "USDC",
  "arbitrum-usdc": "USDC",
  "arbitrum-usdt0": "USDT",
  "plasma-usdt0": "USDT",
  "x-layer-usdt0": "USDT",
  "solana-usdc": "USDC",
  "solana-usdt": "USDT",
  "aptos-usdc": "USDC",
  "aptos-usdt": "USDT",
};
const DEMO_PRICES = {
  BTC: "50000",
  ETH: "2500",
  BNB: "500",
  SOL: "100",
  TRX: "0.25",
  USDT: "1",
  USDC: "1",
};
export class PricingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 503;
  }
}
const reject = (code, message) => {
  throw new PricingError(code, message);
};
export const ceilDivide = (a, b) => {
  if (b <= 0n) reject("INVALID_PRICE", "报价分母无效");
  return (a + b - 1n) / b;
};
export function parseFixed(value, decimals = 18) {
  if (typeof value !== "string" || !/^\d{1,16}(\.\d{1,18})?$/.test(value))
    reject("INVALID_PRICE", "报价必须是有效的十进制字符串");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) reject("INVALID_PRICE", "报价精度超过限制");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}
export function fixed(value, decimals = 18) {
  const text = BigInt(value)
    .toString()
    .padStart(decimals + 1, "0");
  return decimals
    ? text.slice(0, -decimals) + "." + text.slice(-decimals)
    : text;
}
export const compact = (value) =>
  value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
export function assetForToken(tokenId) {
  const asset = TOKEN_ASSETS[tokenId];
  if (!asset) reject("PRICE_ASSET_UNKNOWN", "此代币尚未配置可信报价资产");
  return asset;
}
export function isKnownStable(tokenId) {
  return ["USDT", "USDC"].includes(TOKEN_ASSETS[tokenId]);
}
function validPositive(value) {
  const n = parseFixed(value);
  if (n <= 0n || n > 10n ** 30n)
    reject("INVALID_PRICE", "行情报价超出有效范围");
  return n;
}

export class PriceBook {
  constructor({
    db,
    config = {},
    fetchImpl = fetch,
    now = () => Date.now(),
  } = {}) {
    this.db = db;
    this.configSource = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = new Map();
    this.running = null;
    this.timer = null;
    this.stopped = false;
    this.lastError = null;
    db?.exec(
      "CREATE TABLE IF NOT EXISTS market_prices(cache_key TEXT PRIMARY KEY,numerator TEXT NOT NULL,denominator TEXT NOT NULL,observed_at TEXT NOT NULL,source TEXT NOT NULL)",
    );
    if (db)
      for (const row of db.prepare("SELECT * FROM market_prices").all())
        this.cache.set(row.cache_key, row);
  }
  config() {
    return typeof this.configSource === "function"
      ? this.configSource()
      : this.configSource;
  }
  maxAgeMs() {
    const value = this.config().maxAgeSeconds ?? 120;
    if (!Number.isInteger(value) || value < 30 || value > 300)
      reject("INVALID_PRICE_CONFIG", "行情最大年龄须为30–300秒");
    return value * 1000;
  }
  put(
    key,
    numerator,
    denominator,
    {
      observedAt = new Date(this.now()).toISOString(),
      source = "coinbase_spot",
    } = {},
  ) {
    if (
      numerator <= 0n ||
      denominator <= 0n ||
      !Number.isFinite(Date.parse(observedAt)) ||
      Date.parse(observedAt) > this.now() + 30000
    )
      reject("INVALID_PRICE", "行情时间或数值无效");
    const row = {
      cache_key: key,
      numerator: String(numerator),
      denominator: String(denominator),
      observed_at: new Date(observedAt).toISOString(),
      source,
    };
    this.cache.set(key, row);
    this.db
      ?.prepare(
        "INSERT INTO market_prices VALUES(?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET numerator=excluded.numerator,denominator=excluded.denominator,observed_at=excluded.observed_at,source=excluded.source",
      )
      .run(...Object.values(row));
    return row;
  }
  // Trusted internal fixture/refresh hook; never exposed as a customer HTTP endpoint.
  recordAsset(asset, value, options) {
    if (!ASSETS.includes(asset))
      reject("PRICE_ASSET_UNKNOWN", "不支持此报价资产");
    return this.put("asset:" + asset, validPositive(value), USD_SCALE, options);
  }
  recordFiatUsd(currency, value, options) {
    if (!["CNY", "EUR"].includes(currency))
      reject("PRICE_ASSET_UNKNOWN", "不支持此法币报价");
    return this.put(
      "fiat:" + currency,
      validPositive(value),
      USD_SCALE,
      options,
    );
  }
  cached(key) {
    const row = this.cache.get(key);
    if (!row)
      reject("PRICE_UNAVAILABLE", "收款行情尚未就绪，请稍后选择支付方式");
    if (
      this.now() - Date.parse(row.observed_at) > this.maxAgeMs() ||
      Date.parse(row.observed_at) > this.now() + 30000
    )
      reject("PRICE_STALE", "行情已过期，暂时不能创建新报价");
    return { ...row, n: BigInt(row.numerator), d: BigInt(row.denominator) };
  }
  asset(asset, mode) {
    if (mode !== "demo" && this.config().enabled === false)
      reject("PRICE_DISABLED", "平台暂未启用实时报价");
    if (!ASSETS.includes(asset))
      reject("PRICE_ASSET_UNKNOWN", "不支持此报价资产");
    if (mode === "demo")
      return {
        n: parseFixed(DEMO_PRICES[asset]),
        d: USD_SCALE,
        source: "demo_fixed",
        observed_at: new Date(this.now()).toISOString(),
        static: true,
      };
    if (
      ["USDT", "USDC"].includes(asset) &&
      this.config().stablePolicy === "parity"
    )
      return {
        n: USD_SCALE,
        d: USD_SCALE,
        source: "configured_stable_parity",
        observed_at: new Date(this.now()).toISOString(),
        static: true,
      };
    return this.cached("asset:" + asset);
  }
  fiat(currency, mode) {
    if (currency === "USD")
      return {
        n: 1n,
        d: 1n,
        source: "usd_unit",
        observed_at: new Date(this.now()).toISOString(),
        static: true,
      };
    if (["USDT", "USDC"].includes(currency)) return this.asset(currency, mode);
    if (mode === "demo" && ["CNY", "EUR"].includes(currency))
      return {
        n: parseFixed(currency === "CNY" ? "0.13888888" : "1.08"),
        d: USD_SCALE,
        source: "demo_fixed",
        observed_at: new Date(this.now()).toISOString(),
        static: true,
      };
    if (!["CNY", "EUR"].includes(currency))
      reject("PRICE_ASSET_UNKNOWN", "法币换算未支持");
    return this.cached("fiat:" + currency);
  }
  quote({ tokenId, decimals, fiatAmount, currency, mode }) {
    if (mode !== "demo" && this.config().enabled === false)
      reject("PRICE_DISABLED", "平台暂未启用实时报价");
    const asset = assetForToken(tokenId);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30)
      reject("INVALID_PRICE_CONFIG", "代币精度无效");
    const price = this.asset(asset, mode),
      fx = this.fiat(currency, mode),
      cents = parseFixed(fiatAmount, 2),
      units = 10n ** BigInt(decimals);
    const amount = ceilDivide(
      cents * fx.n * price.d * units,
      100n * fx.d * price.n,
    );
    const usdTarget = ceilDivide(cents * fx.n * USD_SCALE, 100n * fx.d);
    if (amount <= 0n) reject("PRICE_AMOUNT_TOO_SMALL", "付款金额过小");
    if (asset === "BTC" && amount < 546n)
      reject(
        "BTC_DUST_AMOUNT",
        "BTC应付金额低于546聪的最小收款值，请提高订单金额或选择其他币种",
      );
    const maxUsd = validPositive(this.config().fingerprintMaxUsd ?? "0.01");
    if (maxUsd > parseFixed("0.01"))
      reject("INVALID_PRICE_CONFIG", "支付尾差上限不可超过0.01美元");
    const budget = usdTarget / 100n < maxUsd ? usdTarget / 100n : maxUsd;
    const maxDelta = (budget * units * price.d) / (price.n * USD_SCALE);
    let step = ceilDivide(
      parseFixed("0.0001") * units * price.d,
      price.n * USD_SCALE,
    );
    while (step > maxDelta && step > 1n) step = step / 10n || 1n;
    if (maxDelta < 1n)
      reject(
        "PRICE_AMOUNT_TOO_SMALL",
        "该金额无法在尾差限制内分配唯一付款数量",
      );
    const priced = [price, fx].filter((x) => !x.static);
    const oldest = priced.length
      ? Math.min(...priced.map((x) => Date.parse(x.observed_at)))
      : this.now();
    const snapshot = {
      token_symbol: asset,
      token_decimals: decimals,
      token_usd_price: compact(fixed(ceilDivide(price.n * USD_SCALE, price.d))),
      fiat_usd_rate: compact(fixed(ceilDivide(fx.n * USD_SCALE, fx.d))),
      quoted_at: new Date(this.now()).toISOString(),
      price_observed_at: new Date(oldest).toISOString(),
      price_source: mode === "demo" ? "demo_fixed" : price.source,
      is_demo: mode === "demo",
      price_valid_until: priced.length
        ? new Date(oldest + this.maxAgeMs()).toISOString()
        : null,
      price_numerator: String(price.n),
      price_denominator: String(price.d),
      fiat_numerator: String(fx.n),
      fiat_denominator: String(fx.d),
      usd_target_atomic: String(usdTarget),
      fingerprint_limit_usd: fixed(budget),
    };
    return {
      amount,
      decimals,
      asset,
      volatile: !["USDT", "USDC"].includes(asset),
      step,
      maxDelta,
      budget,
      usdTarget,
      rate: compact(fixed((fx.n * price.d * USD_SCALE) / (fx.d * price.n))),
      snapshot,
      usdValue: (value) =>
        ceilDivide(value * price.n * USD_SCALE, units * price.d),
    };
  }
  async json(url) {
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "AvenoraPay-Quotes/1.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("行情服务返回HTTP " + response.status);
    const text = await response.text();
    if (text.length > 256 * 1024) throw new Error("行情响应过大");
    const date = Date.parse(response.headers?.get?.("date") || "");
    return {
      data: JSON.parse(text),
      observedAt: new Date(
        Number.isFinite(date) ? Math.min(this.now(), date) : this.now(),
      ).toISOString(),
    };
  }
  async refresh() {
    if (this.running) return this.running;
    if (this.stopped) return;
    this.running = (async () => {
      const failures = [];
      await Promise.all(
        ASSETS.map(async (asset) => {
          try {
            const result = await this.json(
              `https://api.coinbase.com/v2/prices/${asset}-USD/spot`,
            );
            const row = result.data?.data;
            if (row?.base !== asset || row.currency !== "USD")
              throw new Error("行情资产不匹配");
            this.recordAsset(asset, row.amount, {
              observedAt: result.observedAt,
              source: "coinbase_spot",
            });
          } catch (e) {
            failures.push(asset + ":" + String(e.message).slice(0, 120));
          }
        }),
      );
      try {
        const result = await this.json(
          "https://api.coinbase.com/v2/exchange-rates?currency=USD",
        );
        if (result.data?.data?.currency !== "USD")
          throw new Error("法币基准不匹配");
        for (const currency of ["CNY", "EUR"])
          this.put(
            "fiat:" + currency,
            USD_SCALE,
            validPositive(result.data.data.rates[currency]),
            { observedAt: result.observedAt, source: "coinbase_fx" },
          );
      } catch (e) {
        failures.push("FX:" + String(e.message).slice(0, 120));
      }
      this.lastError = failures.length ? failures.join("; ") : null;
      return { updated_at: new Date(this.now()).toISOString(), failures };
    })();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    const seconds = this.config().refreshSeconds ?? 60;
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 120)
      reject("INVALID_PRICE_CONFIG", "行情刷新间隔须为30–120秒");
    this.timer = setInterval(() => void this.refresh(), seconds * 1000);
    this.timer.unref();
    void this.refresh();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }
  status() {
    return {
      source: "coinbase_spot",
      last_error: this.lastError,
      assets: ASSETS.map((asset) => {
        try {
          const p = this.asset(asset, "live");
          return {
            symbol: asset,
            ready: true,
            observed_at: p.observed_at,
            source: p.source,
          };
        } catch (e) {
          return { symbol: asset, ready: false, reason: e.code };
        }
      }),
    };
  }
}
