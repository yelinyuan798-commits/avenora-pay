import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PriceBook, PricingError, isKnownStable, assetForToken, ceilDivide, USD_SCALE } from "./pricing.mjs";

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const fail = (code, message, status = 400) => {
  throw new AppError(code, message, status);
};
export const uid = (prefix = "") => prefix + randomUUID().replaceAll("-", "");
export const nowISO = () => new Date().toISOString();
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function decimalAtomic(value, decimals = 2) {
  const s = String(value);
  if (!/^\d{1,16}(\.\d+)?$/.test(s))
    fail("INVALID_AMOUNT", "请输入有效的正数金额");
  const [whole, f = ""] = s.split(".");
  if (f.length > decimals)
    fail("INVALID_AMOUNT", `最多支持 ${decimals} 位小数`);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((f + "0".repeat(decimals)).slice(0, decimals) || 0)
  );
}
export function formatAtomic(value, decimals = 2) {
  const s = BigInt(value)
    .toString()
    .padStart(decimals + 1, "0");
  return decimals ? s.slice(0, -decimals) + "." + s.slice(-decimals) : s;
}
const compactTokenAmount = (value, decimals) => {
  const [whole, fraction = ""] = formatAtomic(value, decimals).split(".");
  return whole + "." + (fraction.replace(/0+$/, "") || "0");
};
const snapshotInteger = (value) => {
  if (typeof value !== "string" || !/^[1-9]\d{0,79}$/.test(value))
    throw Error("Invalid locked price");
  return BigInt(value);
};
export function passwordHash(password) {
  if (
    typeof password !== "string" ||
    password.length < 10 ||
    password.length > 256
  )
    fail("WEAK_PASSWORD", "密码需要 10–256 个字符");
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function passwordValid(password, stored) {
  try {
    const [salt, value] = stored.split(":");
    const expected = Buffer.from(value, "hex");
    return timingSafeEqual(scryptSync(String(password), salt, 64), expected);
  } catch {
    return false;
  }
}
export function signRequest(
  secret,
  method,
  pathname,
  query,
  body,
  timestamp,
  nonce,
) {
  const entries = [...new URLSearchParams(query).entries()].sort(
    ([ka, va], [kb, vb]) =>
      ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0,
  );
  const q = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return createHmac("sha256", secret)
    .update(
      [
        method.toUpperCase(),
        pathname,
        q,
        hash(body),
        String(timestamp),
        nonce,
      ].join("\n"),
    )
    .digest("hex");
}
export function equalHex(a, b) {
  try {
    const x = Buffer.from(a, "hex"),
      y = Buffer.from(b, "hex");
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
  } catch {
    return false;
  }
}
const clean = (v, n = 200) =>
  String(v ?? "")
    .trim()
    .slice(0, n);
export const chainAddress = (chain, address) =>
  [
    "bsc",
    "ethereum",
    "polygon",
    "base",
    "arbitrum",
    "plasma",
    "x-layer",
  ].includes(chain)
    ? String(address).toLowerCase()
    : String(address);

export class Store {
  constructor({
    filename = ":memory:",
    masterKey,
    registry = [],
    config = {},
    validateAddress = () => true,
    configuredTokens,
    normalizeAddress = chainAddress,
    priceBook,
  } = {}) {
    if (filename !== ":memory:")
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    this.registry = registry;
    this.config = config;
    this.validateAddress = validateAddress;
    this.configuredTokens = configuredTokens;
    this.normalizeAddress = normalizeAddress;
    if (masterKey) this.masterKey = Buffer.from(masterKey);
    else if (filename === ":memory:") this.masterKey = randomBytes(32);
    else {
      const kp = path.join(path.dirname(filename), "master.key");
      if (!fs.existsSync(kp))
        fs.writeFileSync(kp, randomBytes(32), { mode: 0o600, flag: "wx" });
      this.masterKey = fs.readFileSync(kp);
    }
    if (this.masterKey.length !== 32)
      throw Error("Master key must contain 32 bytes");
    this.db.exec(`
  CREATE TABLE IF NOT EXISTS merchants(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,mode TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',webhook_url TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS addresses(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,label TEXT NOT NULL,token_ids TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,mode TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(chain,address));
  CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,key_id TEXT UNIQUE NOT NULL,name TEXT NOT NULL,secret TEXT NOT NULL,key_prefix TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS idempotency(project_id TEXT NOT NULL,idem_key TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(project_id,idem_key));
  CREATE TABLE IF NOT EXISTS nonces(key_id TEXT NOT NULL,nonce TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(key_id,nonce));
  CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,name TEXT NOT NULL,price TEXT NOT NULL,currency TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS inventory(id TEXT PRIMARY KEY,product_id TEXT NOT NULL,merchant_id TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,order_id TEXT UNIQUE,created_at TEXT NOT NULL,UNIQUE(product_id,content_hash));
  CREATE TABLE IF NOT EXISTS orders(order_id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,merchant_order_id TEXT NOT NULL,fiat_amount TEXT NOT NULL,fiat_currency TEXT NOT NULL,status TEXT NOT NULL,chain TEXT,token_id TEXT,pay_address TEXT,payable_atomic TEXT,payable_amount TEXT,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,confirmations INTEGER NOT NULL DEFAULT 0,required_confirmations INTEGER NOT NULL DEFAULT 0,tx_hash TEXT,transfer_id TEXT UNIQUE,checkout_token TEXT UNIQUE NOT NULL,product_id TEXT,delivery TEXT,mode TEXT NOT NULL,request_hash TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}',UNIQUE(project_id,merchant_order_id),UNIQUE(chain,token_id,pay_address,payable_atomic));
  CREATE TABLE IF NOT EXISTS project_settings(project_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,support_email TEXT NOT NULL DEFAULT '',logo_data_url TEXT,fee_enabled INTEGER NOT NULL DEFAULT 0,fee_percent TEXT NOT NULL DEFAULT '0.00');
  CREATE TABLE IF NOT EXISTS order_pricing(order_id TEXT PRIMARY KEY,fee_percent TEXT NOT NULL,fee_amount TEXT NOT NULL,fiat_total TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS amount_reservations(chain TEXT NOT NULL,token_id TEXT NOT NULL,pay_address TEXT NOT NULL,payable_atomic TEXT NOT NULL,order_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(chain,token_id,pay_address,payable_atomic));
  CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,chain TEXT NOT NULL,token_id TEXT NOT NULL,tx_hash TEXT NOT NULL,event_index INTEGER NOT NULL,to_address TEXT NOT NULL,from_address TEXT,amount_atomic TEXT NOT NULL,block_height INTEGER NOT NULL,block_hash TEXT NOT NULL,block_time TEXT NOT NULL,confirmations INTEGER NOT NULL,confirmed INTEGER NOT NULL,removed INTEGER NOT NULL,order_id TEXT,mode TEXT NOT NULL,reason TEXT,UNIQUE(chain,tx_hash,event_index));
  CREATE TABLE IF NOT EXISTS endpoints(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS endpoint_state(endpoint_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,endpoint_id TEXT,event_id TEXT NOT NULL,event_type TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,last_error TEXT,created_at TEXT NOT NULL,delivered_at TEXT);
  CREATE TABLE IF NOT EXISTS reorg_cursors(chain TEXT PRIMARY KEY,cursor INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS scanner_watermarks(chain TEXT PRIMARY KEY,block_time TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cursors(chain TEXT PRIMARY KEY,cursor TEXT NOT NULL,head TEXT,last_success TEXT,last_error TEXT);
  CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,merchant_id TEXT,action TEXT NOT NULL,subject TEXT,created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS orders_merchant ON orders(merchant_id,created_at);
  CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status,next_attempt);
  `);
    const endpointSchema = this.get(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='endpoints'",
    ).sql;
    const deliverySchema = this.get(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='deliveries'",
    ).sql;
    this.transaction(() => {
      if (/project_id TEXT NOT NULL UNIQUE/.test(endpointSchema)) {
        this.db.exec(
          "ALTER TABLE endpoints RENAME TO endpoints_legacy; CREATE TABLE endpoints(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,created_at TEXT NOT NULL); INSERT INTO endpoints SELECT * FROM endpoints_legacy; DROP TABLE endpoints_legacy;",
        );
      }
      if (/event_id TEXT NOT NULL UNIQUE/.test(deliverySchema)) {
        this.db.exec(
          "ALTER TABLE deliveries RENAME TO deliveries_legacy; CREATE TABLE deliveries(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,project_id TEXT NOT NULL,endpoint_id TEXT,event_id TEXT NOT NULL,event_type TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,last_error TEXT,created_at TEXT NOT NULL,delivered_at TEXT); INSERT INTO deliveries SELECT * FROM deliveries_legacy; DROP TABLE deliveries_legacy;",
        );
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS delivery_endpoint_event ON deliveries(event_id,endpoint_id); CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status,next_attempt);",
      );
    });
    const columns = new Set(
      this.all("PRAGMA table_info(orders)").map((c) => c.name),
    );
    if (!columns.has("selection_deadline"))
      this.db.exec("ALTER TABLE orders ADD COLUMN selection_deadline TEXT");
    if (!columns.has("payment_started_at"))
      this.db.exec("ALTER TABLE orders ADD COLUMN payment_started_at TEXT");
    if (!columns.has("paid_source"))
      this.db.exec("ALTER TABLE orders ADD COLUMN paid_source TEXT");
    this.db.exec(
      "UPDATE orders SET selection_deadline=expires_at,status=CASE WHEN status='pending' THEN 'awaiting_payment' ELSE status END WHERE chain IS NULL AND selection_deadline IS NULL",
    );
    this.db.exec(
      "UPDATE orders SET payment_started_at=created_at WHERE chain IS NOT NULL AND payment_started_at IS NULL",
    );
    const quoteColumns = new Set(
      this.all("PRAGMA table_info(amount_reservations)").map((c) => c.name),
    );
    if (!quoteColumns.has("rate"))
      this.db.exec("ALTER TABLE amount_reservations ADD COLUMN rate TEXT");
    this.db.exec(
      "INSERT OR IGNORE INTO amount_reservations(chain,token_id,pay_address,payable_atomic,order_id,created_at) SELECT chain,token_id,pay_address,payable_atomic,order_id,COALESCE(payment_started_at,created_at) FROM orders WHERE chain IS NOT NULL",
    );
    if (!quoteColumns.has("pricing_json"))
      this.db.exec(
        "ALTER TABLE amount_reservations ADD COLUMN pricing_json TEXT",
      );
    this.priceBook =
      priceBook ||
      new PriceBook({ db: this.db, config: () => this.config.pricing || {} });
  }
  close() {
    this.db.close();
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  transaction(fn) {
    const depth = this.transactionDepth || 0;
    this.transactionDepth = depth + 1;
    const savepoint = "nested_" + depth;
    this.db.exec(depth ? "SAVEPOINT " + savepoint : "BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec(depth ? "RELEASE " + savepoint : "COMMIT");
      return value;
    } catch (e) {
      this.db.exec(depth ? "ROLLBACK TO " + savepoint : "ROLLBACK");
      if (depth) this.db.exec("RELEASE " + savepoint);
      throw e;
    } finally {
      this.transactionDepth = depth;
    }
  }
  callHook(name, ...args) {
    const result = this[name]?.(...args);
    if (result && typeof result.then === "function")
      throw new Error(name + " hook must be synchronous");
    return result;
  }
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const data = Buffer.concat([
      cipher.update(String(value), "utf8"),
      cipher.final(),
    ]);
    return [
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      data.toString("base64"),
    ].join(".");
  }
  decrypt(value) {
    const [iv, tag, data] = value
      .split(".")
      .map((x) => Buffer.from(x, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", this.masterKey, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString(
      "utf8",
    );
  }
  audit(merchant, action, subject) {
    this.run(
      "INSERT INTO audit VALUES(?,?,?,?,?)",
      uid("a_"),
      merchant,
      action,
      subject,
      nowISO(),
    );
  }
  merchant(id) {
    const m = this.get("SELECT * FROM merchants WHERE id=?", id);
    if (!m) fail("UNAUTHORIZED", "请先登录", 401);
    return m;
  }
  publicMerchant(m) {
    return { id: m.id, email: m.email, name: m.name };
  }
  register({ email, password, name }, mode = "live") {
    email = clean(email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      fail("INVALID_EMAIL", "请输入有效邮箱");
    const encoded = passwordHash(password);
    if (this.get("SELECT id FROM merchants WHERE email=?", email))
      fail("EMAIL_EXISTS", "邮箱已注册", 409);
    const m = {
      id: uid("m_"),
      email,
      name: clean(name, 80) || email.split("@")[0],
      password: encoded,
      mode,
      created_at: nowISO(),
    };
    this.run("INSERT INTO merchants VALUES(?,?,?,?,?,?)", ...Object.values(m));
    return m;
  }
  login({ email, password, otp }) {
    const m = this.get(
      "SELECT * FROM merchants WHERE email=?",
      clean(email).toLowerCase(),
    );
    if (!m || !passwordValid(password, m.password))
      fail("INVALID_CREDENTIALS", "邮箱或密码不正确", 401);
    this.callHook("verifySecondFactor", m, otp);
    return m;
  }
  session(m) {
    const token = randomBytes(32).toString("base64url");
    this.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(token),
      m.id,
      Date.now() + 7 * 86400000,
    );
    return token;
  }
  sessionMerchant(token) {
    if (!token) return null;
    const session = this.get(
      "SELECT merchant_id FROM sessions WHERE token_hash=? AND expires_at>?",
      hash(token),
      Date.now(),
    );
    return session ? this.merchant(session.merchant_id) : null;
  }
  project(merchant, id) {
    const p = this.get(
      "SELECT * FROM projects WHERE id=? AND merchant_id=?",
      id,
      merchant.id,
    );
    if (!p) fail("NOT_FOUND", "项目不存在", 404);
    return p;
  }
  createProject(merchant, { name, description = "" }) {
    if (!clean(name)) fail("INVALID_PROJECT", "请填写项目名称");
    this.callHook("enforceLimits", merchant, "projects");
    const p = {
      id: uid("prj_"),
      merchant_id: merchant.id,
      name: clean(name, 80),
      description: clean(description, 1000),
      webhook_url: "",
      created_at: nowISO(),
    };
    this.run("INSERT INTO projects VALUES(?,?,?,?,?,?)", ...Object.values(p));
    return p;
  }
  chainConfig(chain) {
    return (this.config.chains || this.config)[chain] || null;
  }
  tokenSpec(chain, tokenId) {
    const r = this.registry.find((x) => x.id === chain);
    const t = r?.tokens?.find((x) => x.id === tokenId);
    if (!r || !t) fail("UNSUPPORTED_METHOD", "此网络或币种尚未支持");
    return { chain: r, token: t };
  }
  configured(chain, tokenId) {
    const c = this.chainConfig(chain);
    if (!c || !Number.isSafeInteger(c.startBlock) || c.startBlock < 0)
      return false;
    if (this.configuredTokens) {
      try {
        return this.configuredTokens(chain, c).some(
          (t) => (typeof t === "string" ? t : t.id) === tokenId,
        );
      } catch {
        return false;
      }
    }
    if (!c || !c.rpcUrl || c.enabled === false) return false;
    const tokens = Array.isArray(c.tokens)
      ? c.tokens
      : Object.entries(c.tokens || {}).map(([id, t]) => ({ id, ...t }));
    return !!tokens.find(
      (t) =>
        (t.id === tokenId || t.token_id === tokenId) &&
        Number.isInteger(t.decimals) &&
        t.decimals >= 4 &&
        (t.contract || t.mint || t.metadata || t.native || t.kind === "native"),
    );
  }
  addAddress(m, { project_id, chain, address, label = "", token_ids }) {
    this.project(m, project_id);
    this.callHook("enforceLimits", m, "addresses", project_id);
    const reg = this.registry.find((x) => x.id === chain);
    if (!reg) fail("UNSUPPORTED_CHAIN", "网络不支持");
    if (m.mode !== "demo" && !this.validateAddress(chain, address))
      fail("INVALID_ADDRESS", "收款地址格式不正确");
    if (m.mode === "demo" && !String(address).startsWith("demo:"))
      fail("DEMO_ONLY", "演示空间只接受 demo: 开头的合成地址");
    address =
      m.mode === "demo"
        ? chainAddress(chain, clean(address, 160))
        : this.normalizeAddress(chain, clean(address, 160));
    if (
      this.get(
        "SELECT id FROM addresses WHERE chain=? AND address=?",
        chain,
        address,
      )
    )
      fail("ADDRESS_EXISTS", "该地址已绑定，不能跨项目或商户重复绑定", 409);
    token_ids = token_ids?.length ? token_ids : reg.tokens.map((x) => x.id);
    for (const id of token_ids) this.tokenSpec(chain, id);
    const a = {
      id: uid("addr_"),
      merchant_id: m.id,
      project_id,
      chain,
      address,
      label: clean(label, 80),
      token_ids: JSON.stringify(token_ids),
      enabled: 1,
      mode: m.mode,
      created_at: nowISO(),
    };
    this.run(
      "INSERT INTO addresses VALUES(?,?,?,?,?,?,?,?,?,?)",
      ...Object.values(a),
    );
    return { ...a, token_ids };
  }
  createKey(m, { project_id, name }) {
    this.project(m, project_id);
    this.callHook("enforceLimits", m, "api_keys", project_id);
    const secret = randomBytes(32).toString("hex");
    const key_id = uid("djp_");
    const id = uid("key_");
    this.run(
      "INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      m.id,
      project_id,
      key_id,
      clean(name, 80) || "默认密钥",
      this.encrypt(secret),
      key_id.slice(0, 13),
      0,
      nowISO(),
    );
    return { id, key_id, secret, key_prefix: key_id.slice(0, 13) };
  }
  authenticateApi({ headers, method, pathname, query, body }) {
    const keyId = headers["djp-key-id"],
      timestamp = headers["djp-timestamp"],
      nonce = headers["djp-nonce"],
      signature = headers["djp-signature"];
    if (
      !keyId ||
      !/^\d{10}$/.test(timestamp || "") ||
      !nonce ||
      nonce.length < 16 ||
      nonce.length > 160 ||
      !/^[a-f\d]{64}$/i.test(signature || "")
    )
      fail("INVALID_SIGNATURE", "请求签名无效", 401);
    const sec = Number(timestamp);
    if (Math.abs(Date.now() / 1000 - sec) > 300)
      fail("TIMESTAMP_EXPIRED", "请求时间超过允许范围", 401);
    const key = this.get(
      "SELECT * FROM api_keys WHERE key_id=? AND revoked=0",
      keyId,
    );
    if (
      !key ||
      !equalHex(
        signature,
        signRequest(
          key ? this.decrypt(key.secret) : "",
          method,
          pathname,
          query,
          body,
          timestamp,
          nonce,
        ),
      )
    )
      fail("INVALID_SIGNATURE", "请求签名无效", 401);
    this.transaction(() => {
      this.run("DELETE FROM nonces WHERE created_at<?", Date.now() - 600000);
      if (
        this.get(
          "SELECT nonce FROM nonces WHERE key_id=? AND nonce=?",
          keyId,
          nonce,
        )
      )
        fail("NONCE_REPLAY", "请求已使用，请更换随机数", 409);
      this.run("INSERT INTO nonces VALUES(?,?,?)", keyId, nonce, Date.now());
      this.callHook(
        "enforceLimits",
        this.merchant(key.merchant_id),
        "api_requests",
        key.project_id,
      );
    });
    return {
      merchant: this.merchant(key.merchant_id),
      project: this.get("SELECT * FROM projects WHERE id=?", key.project_id),
      key,
    };
  }
  projectSettings(m, projectId) {
    const p = this.project(m, projectId);
    const settings = this.get(
      "SELECT * FROM project_settings WHERE project_id=?",
      projectId,
    );
    return settings
      ? { ...settings, fee_enabled: !!settings.fee_enabled }
      : {
          project_id: projectId,
          display_name: p.name,
          support_email: "",
          logo_data_url: null,
          fee_enabled: false,
          fee_percent: "0.00",
        };
  }
  updateProjectSettings(m, projectId, input) {
    const current = this.projectSettings(m, projectId);
    const display_name = clean(input.display_name ?? current.display_name, 120);
    if (!display_name) fail("INVALID_NAME", "展示名称不能为空");
    const support_email = clean(
      input.support_email ?? current.support_email,
      200,
    ).toLowerCase();
    if (support_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support_email))
      fail("INVALID_EMAIL", "客服邮箱格式无效");
    const fee_enabled = input.fee_enabled ?? current.fee_enabled;
    if (typeof fee_enabled !== "boolean")
      fail("INVALID_FEE", "手续费开关须为布尔值");
    const fee = decimalAtomic(input.fee_percent ?? current.fee_percent, 2);
    if (fee > 1000n)
      fail("INVALID_FEE", "手续费比例须在0–10%以内，最多两位小数");
    const logo_data_url =
      input.logo_data_url === undefined
        ? current.logo_data_url
        : input.logo_data_url || null;
    if (logo_data_url) {
      if (typeof logo_data_url !== "string" || logo_data_url.length > 360000)
        fail("INVALID_LOGO", "Logo须为256KB以内的PNG/JPEG/WebP图片");
      const match =
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
          logo_data_url,
        );
      if (!match) fail("INVALID_LOGO", "Logo格式无效");
      const data = Buffer.from(match[2], "base64");
      if (data.length > 256 * 1024 || data.length < 12)
        fail("INVALID_LOGO", "Logo图片大小无效");
      const valid =
        match[1] === "png"
          ? data
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : match[1] === "jpeg"
            ? data[0] === 255 && data[1] === 216 && data[2] === 255
            : data.subarray(0, 4).toString() === "RIFF" &&
              data.subarray(8, 12).toString() === "WEBP";
      if (!valid) fail("INVALID_LOGO", "Logo内容与图片类型不符");
    }
    this.run(
      "INSERT INTO project_settings VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET display_name=excluded.display_name,support_email=excluded.support_email,logo_data_url=excluded.logo_data_url,fee_enabled=excluded.fee_enabled,fee_percent=excluded.fee_percent",
      projectId,
      display_name,
      support_email,
      logo_data_url,
      fee_enabled ? 1 : 0,
      formatAtomic(fee),
    );
    return this.projectSettings(m, projectId);
  }
  createProduct(m, { project_id, name, price, currency = "USD" }) {
    this.project(m, project_id);
    this.callHook("enforceLimits", m, "products", project_id);
    if (!clean(name)) fail("INVALID_PRODUCT", "请填写商品名称");
    const amount = decimalAtomic(price);
    if (amount <= 0n) fail("INVALID_AMOUNT", "价格必须大于零");
    currency = clean(currency).toUpperCase();
    if (!["USD", "CNY", "EUR", "USDT", "USDC"].includes(currency))
      fail("INVALID_CURRENCY", "币种不支持");
    const p = {
      id: uid("prod_"),
      merchant_id: m.id,
      project_id,
      name: clean(name, 120),
      price: formatAtomic(amount),
      currency,
      created_at: nowISO(),
    };
    this.run("INSERT INTO products VALUES(?,?,?,?,?,?,?)", ...Object.values(p));
    return { ...p, stock: 0 };
  }
  importInventory(m, productId, items) {
    const p = this.get(
      "SELECT * FROM products WHERE id=? AND merchant_id=?",
      productId,
      m.id,
    );
    if (!p) fail("NOT_FOUND", "商品不存在", 404);
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > 1000 ||
      items.some((x) => typeof x !== "string" || !x.trim() || x.length > 10000)
    )
      fail("INVALID_INVENTORY", "每次导入 1–1000 条，每条不超过 10000 字");
    return this.transaction(() => {
      let count = 0;
      for (const item of items) {
        const content = item.trim();
        const result = this.run(
          "INSERT OR IGNORE INTO inventory VALUES(?,?,?,?,?,?,?)",
          uid("inv_"),
          p.id,
          m.id,
          this.encrypt(content),
          hash(content),
          null,
          nowISO(),
        );
        count += Number(result.changes);
      }
      return { imported: count, duplicates: items.length - count };
    });
  }
  amountFor(m, fiatAmount, currency, chain, tokenId) {
    const { token } = this.tokenSpec(chain, tokenId);
    const cfg = this.chainConfig(chain);
    const entries = Array.isArray(cfg?.tokens)
      ? cfg.tokens
      : Object.entries(cfg?.tokens || {}).map(([id, t]) => ({ id, ...t }));
    const configured = entries.find(
      (t) => t.id === tokenId || t.token_id === tokenId,
    );
    const decimals = m.mode === "demo" ? token.decimals : configured?.decimals;
    try {
      return this.priceBook.quote({
        tokenId,
        decimals,
        fiatAmount,
        currency,
        mode: m.mode,
      });
    } catch (e) {
      if (e instanceof PricingError)
        fail(
          e.code,
          e.message,
          e.code === "BTC_DUST_AMOUNT" || e.code === "PRICE_AMOUNT_TOO_SMALL"
            ? 400
            : 503,
        );
      throw e;
    }
  }
  orderQuote(order) {
    if (!order?.chain) return null;
    return this.get(
      "SELECT * FROM amount_reservations WHERE chain=? AND token_id=? AND pay_address=? AND payable_atomic=? AND order_id=?",
      order.chain, order.token_id, order.pay_address, order.payable_atomic, order.order_id,
    );
  }
  fingerprintBounds(order, quote = this.orderQuote(order), { force = false } = {}) {
    if ((!force && this.config.payments?.allowFingerprintUnderpayment !== true) ||
        !isKnownStable(quote?.token_id || order?.token_id)) return null;
    // Only immutable server-created quote data can establish the principal + fee floor.
    // Missing/malformed historical data grants no underpayment tolerance.
    try {
      if (!quote?.pricing_json || quote.order_id !== order.order_id) return null;
      const s = JSON.parse(quote.pricing_json);
      const { token } = this.tokenSpec(quote.chain, quote.token_id);
      const decimals = s.token_decimals;
      if (!Number.isInteger(decimals) || decimals < 1 || decimals > 30 ||
          decimals !== token.decimals || s.token_symbol !== assetForToken(quote.token_id) ||
          !(order.mode === "demo" ? s.price_source === "demo_fixed" :
            ["coinbase_spot", "configured_stable_parity"].includes(s.price_source))) return null;
      const pricing = this.get("SELECT fiat_total FROM order_pricing WHERE order_id=?", order.order_id);
      if (!pricing) return null;
      const cents = decimalAtomic(pricing.fiat_total, 2);
      const pn = snapshotInteger(s.price_numerator), pd = snapshotInteger(s.price_denominator);
      const fn = snapshotInteger(s.fiat_numerator), fd = snapshotInteger(s.fiat_denominator);
      const units = 10n ** BigInt(decimals);
      const minimum = ceilDivide(cents * fn * pd * units, 100n * fd * pn);
      const target = ceilDivide(cents * fn * USD_SCALE, 100n * fd);
      const maximum = snapshotInteger(quote.payable_atomic);
      if (cents <= 0n || minimum <= 0n || minimum > maximum ||
          s.usd_target_atomic !== target.toString() ||
          (s.base_payable_atomic !== undefined && s.base_payable_atomic !== minimum.toString())) return null;
      const savedLimit = decimalAtomic(s.fingerprint_limit_usd, 18);
      const budget = [target / 100n, USD_SCALE / 100n, savedLimit].reduce((a, b) => a < b ? a : b);
      const value = ceilDivide(maximum * pn * USD_SCALE, units * pd);
      if (budget < 0n || value < target || value - target > budget ||
          (s.usd_atomic !== undefined && s.usd_atomic !== value.toString())) return null;
      return { minimum, maximum, decimals };
    } catch {
      return null;
    }
  }
  paymentAmountMatches(order, amount, quote = this.orderQuote(order), { force = false } = {}) {
    const maximum = quote?.payable_atomic || order.payable_atomic;
    if (String(amount) === maximum) return true;
    if (!/^\d+$/.test(String(amount))) return false;
    const bounds = this.fingerprintBounds(order, quote, { force });
    return !!bounds && BigInt(amount) >= bounds.minimum && BigInt(amount) <= bounds.maximum;
  }
  linkedTransfer(order) {
    if (!order.transfer_id) return null;
    const tx = this.get("SELECT * FROM transfers WHERE id=?", order.transfer_id);
    return tx && tx.order_id === order.order_id && tx.merchant_id === order.merchant_id &&
      tx.project_id === order.project_id && tx.mode === order.mode && tx.chain === order.chain &&
      tx.token_id === order.token_id && tx.to_address === order.pay_address ? tx : null;
  }
  receivedAmount(order) {
    const tx = this.linkedTransfer(order);
    if (!tx) return null;
    return compactTokenAmount(BigInt(tx.amount_atomic), this.tokenSpec(order.chain, order.token_id).token.decimals);
  }
  orderUsdAtomic(order) {
    if (!order.payable_amount || !order.chain)
      fail("PRICE_SNAPSHOT_MISSING", "订单尚无已锁定美元计价值", 409);
    const received = order.status === "paid" ? this.linkedTransfer(order) : null;
    const reservation = this.get(
      "SELECT pricing_json FROM amount_reservations WHERE chain=? AND token_id=? AND pay_address=? AND payable_atomic=?",
      order.chain,
      order.token_id,
      order.pay_address,
      order.payable_atomic,
    );
    if (reservation?.pricing_json) {
      const snapshot = JSON.parse(reservation.pricing_json);
      if (!/^\d+$/.test(snapshot.usd_atomic || ""))
        fail("PRICE_SNAPSHOT_MISSING", "订单计价快照无效", 409);
      if (received && received.amount_atomic !== order.payable_atomic) {
        try {
          const decimals = this.tokenSpec(order.chain, order.token_id).token.decimals;
          if (snapshot.token_decimals !== decimals) throw Error("Invalid decimals");
          return ceilDivide(BigInt(received.amount_atomic) * snapshotInteger(snapshot.price_numerator) * USD_SCALE,
            10n ** BigInt(decimals) * snapshotInteger(snapshot.price_denominator));
        } catch {
          fail("PRICE_SNAPSHOT_MISSING", "实收金额缺少可信锁价，需管理员核对", 409);
        }
      }
      return BigInt(snapshot.usd_atomic);
    }
    if (received && received.amount_atomic !== order.payable_atomic)
      fail("PRICE_SNAPSHOT_MISSING", "实收金额缺少可信锁价，需管理员核对", 409);
    if (isKnownStable(order.token_id))
      return decimalAtomic(order.payable_amount, 18);
    fail(
      "PRICE_SNAPSHOT_MISSING",
      "历史非稳定币订单缺少可信美元快照，需管理员核对",
      409,
    );
  }
  createOrder(m, input, { skipLimits = false } = {}) {
    if (!!input.chain != !!input.token_id)
      fail("INVALID_METHOD", "chain 与 token_id 须同时指定");
    if (
      input.allowed_methods !== undefined &&
      (!Array.isArray(input.allowed_methods) ||
        input.allowed_methods.length > 30)
    )
      fail("INVALID_METHODS", "allowed_methods须为不超过30项的数组");
    for (const method of input.allowed_methods || [])
      this.tokenSpec(method.chain, method.token_id);
    const project = this.project(m, input.project_id);
    let product;
    if (input.product_id) {
      product = this.get(
        "SELECT * FROM products WHERE id=? AND merchant_id=? AND project_id=?",
        input.product_id,
        m.id,
        project.id,
      );
      if (!product) fail("NOT_FOUND", "商品不存在", 404);
      input = {
        ...input,
        fiat_amount: product.price,
        fiat_currency: product.currency,
      };
      if (
        !this.get(
          "SELECT id FROM inventory WHERE product_id=? AND order_id IS NULL",
          product.id,
        )
      )
        fail("OUT_OF_STOCK", "商品库存不足", 409);
    }
    const fiat = decimalAtomic(input.fiat_amount, 2);
    if (fiat <= 0n || fiat > 10000000000n)
      fail("INVALID_AMOUNT", "金额必须大于零且不超过一亿");
    const currency = clean(input.fiat_currency || "USD").toUpperCase();
    if (!["USD", "CNY", "EUR", "USDT", "USDC"].includes(currency))
      fail("INVALID_CURRENCY", "币种不支持");
    const merchantOrder = clean(input.merchant_order_id, 100) || uid("MO");
    const request_hash = hash(
      JSON.stringify({
        amount: formatAtomic(fiat),
        currency,
        chain: input.chain || null,
        token_id: input.token_id || null,
        product_id: product?.id || null,
        allowed_methods: input.allowed_methods || [],
      }),
    );
    const previous = this.get(
      "SELECT * FROM orders WHERE project_id=? AND merchant_order_id=?",
      project.id,
      merchantOrder,
    );
    if (previous) {
      if (previous.request_hash !== request_hash)
        fail("IDEMPOTENCY_CONFLICT", "相同商户订单号对应的参数不一致", 409);
      return this.orderView(previous);
    }
    if (m.mode !== "demo" && !this.availableMethods(m, project.id).length)
      fail("PAYMENT_UNCONFIGURED", "请先配置收款地址、代币和链节点");
    const order = {
      order_id: uid("ord_"),
      merchant_id: m.id,
      project_id: project.id,
      merchant_order_id: merchantOrder,
      fiat_amount: formatAtomic(fiat),
      fiat_currency: currency,
      status: "awaiting_payment",
      chain: null,
      token_id: null,
      pay_address: null,
      payable_atomic: null,
      payable_amount: null,
      created_at: nowISO(),
      expires_at: new Date(
        Date.now() + Number(this.config.selectionTtlMinutes || 30) * 60000,
      ).toISOString(),
      confirmations: 0,
      required_confirmations: 0,
      tx_hash: null,
      transfer_id: null,
      checkout_token: randomBytes(32).toString("base64url"),
      product_id: product?.id || null,
      delivery: null,
      mode: m.mode,
      request_hash,
      metadata: JSON.stringify({
        merchant: input.metadata || {},
        fixed_method: !!input.chain && !input.allowed_methods?.length,
        allowed_methods: Array.isArray(input.allowed_methods)
          ? input.allowed_methods
          : [],
      }),
      selection_deadline: new Date(
        Date.now() + Number(this.config.selectionTtlMinutes || 30) * 60000,
      ).toISOString(),
      payment_started_at: null,
      paid_source: null,
    };
    return this.transaction(() => {
      if (!skipLimits) this.callHook("enforceLimits", m, "orders", project.id);
      this.run(
        `INSERT INTO orders (${Object.keys(order).join(",")}) VALUES(${Object.keys(
          order,
        )
          .map(() => "?")
          .join(",")})`,
        ...Object.values(order),
      );
      const settings = this.projectSettings(m, project.id);
      const feeBasis = settings.fee_enabled
        ? decimalAtomic(settings.fee_percent, 2)
        : 0n;
      const feeAmount = (fiat * feeBasis + 9999n) / 10000n;
      this.run(
        "INSERT INTO order_pricing VALUES(?,?,?,?,?)",
        order.order_id,
        formatAtomic(feeBasis),
        formatAtomic(feeAmount),
        formatAtomic(fiat + feeAmount),
        nowISO(),
      );
      if (input.chain || input.token_id)
        this.selectMethod(order, input.chain, input.token_id, {
          emitEvent: false,
        });
      this.enqueue(
        this.get("SELECT * FROM orders WHERE order_id=?", order.order_id),
        "order.created",
      );
      return this.orderView(
        this.get("SELECT * FROM orders WHERE order_id=?", order.order_id),
      );
    });
  }
  availableMethods(m, projectId) {
    return this.all(
      "SELECT * FROM addresses WHERE project_id=? AND merchant_id=? AND enabled=1 AND mode=?",
      projectId,
      m.id,
      m.mode,
    )
      .flatMap((a) =>
        JSON.parse(a.token_ids)
          .filter((id) => m.mode === "demo" || this.configured(a.chain, id))
          .map((id) => ({ chain: a.chain, token_id: id })),
      )
      .filter(
        (x, i, a) =>
          a.findIndex(
            (y) => y.chain === x.chain && y.token_id === x.token_id,
          ) === i,
      );
  }
  selectMethod(order, chain, tokenId, { emitEvent = true } = {}) {
    return this.transaction(() =>
      this._selectMethod(
        this.get("SELECT * FROM orders WHERE order_id=?", order.order_id),
        chain,
        tokenId,
        emitEvent,
      ),
    );
  }
  _selectMethod(order, chain, tokenId, emitEvent) {
    if (!order || !["awaiting_payment", "pending"].includes(order.status))
      fail("ORDER_NOT_PAYABLE", "订单已无法支付", 409);
    const deadline = order.chain
      ? order.expires_at
      : order.selection_deadline || order.expires_at;
    if (Date.parse(deadline) <= Date.now())
      fail("ORDER_NOT_PAYABLE", "订单支付期限已结束", 409);
    const metadata = JSON.parse(order.metadata);
    const allowed = metadata.allowed_methods || [];
    if (order.chain === chain && order.token_id === tokenId)
      return this.orderView(order);
    const fixed = metadata.fixed_method ?? (!!order.chain && !allowed.length);
    if (order.chain && fixed)
      fail("METHOD_LOCKED", "此订单已指定固定支付方式", 409);
    if (
      allowed.length &&
      !allowed.some((x) => x.chain === chain && x.token_id === tokenId)
    )
      fail("METHOD_NOT_ALLOWED", "该订单不支持此支付方式");
    const m = this.merchant(order.merchant_id);
    const { chain: network } = this.tokenSpec(chain, tokenId);
    if (m.mode !== "demo" && !this.configured(chain, tokenId))
      fail("PAYMENT_UNCONFIGURED", "该网络和代币尚未配置收款节点");
    const addresses = this.all(
      "SELECT * FROM addresses WHERE merchant_id=? AND project_id=? AND chain=? AND enabled=1 AND mode=?",
      m.id,
      order.project_id,
      chain,
      m.mode,
    ).filter((a) => JSON.parse(a.token_ids).includes(tokenId));
    if (!addresses.length) fail("NO_ADDRESS", "项目尚未配置此网络的收款地址");
    const pricing = this.get(
      "SELECT * FROM order_pricing WHERE order_id=?",
      order.order_id,
    );
    const quoteData = this.amountFor(
      m,
      pricing?.fiat_total || order.fiat_amount,
      order.fiat_currency,
      chain,
      tokenId,
    );
    const { amount, decimals, rate, step } = quoteData;
    const base = amount;
    let allocated, address;
    for (const candidateAddress of addresses) {
      for (let i = 1; i <= 9999; i++) {
        const candidate = base + BigInt(i) * step;
        if (
          candidate - base > quoteData.maxDelta ||
          quoteData.usdValue(candidate) - quoteData.usdTarget > quoteData.budget
        )
          break;
        if (
          !this.get(
            "SELECT order_id FROM amount_reservations WHERE chain=? AND token_id=? AND pay_address=? AND payable_atomic=?",
            chain,
            tokenId,
            candidateAddress.address,
            candidate.toString(),
          )
        ) {
          allocated = candidate;
          address = candidateAddress;
          break;
        }
      }
      if (address) break;
    }
    if (allocated === undefined)
      fail("AMOUNT_POOL_EXHAUSTED", "当前金额可用尾数耗尽，请增加新收款地址");
    const usdAtomic = quoteData.usdValue(allocated);
    const snapshot = {
      ...quoteData.snapshot,
      usd_atomic: String(usdAtomic),
      usd_value: formatAtomic(usdAtomic, 18),
      fingerprint_usd: formatAtomic(usdAtomic - quoteData.usdTarget, 18),
    };
    this.callHook("enforceQuoteLimit", m, order, {
      usd_atomic: String(usdAtomic),
      payable_amount: formatAtomic(allocated, decimals),
      decimals,
    });
    const selectedAt = nowISO();
    const configuredMinutes = Number(this.config.paymentTtlMinutes || 20);
    const windowMinutes =
      quoteData.asset === "BTC"
        ? Math.max(20, configuredMinutes)
        : quoteData.volatile
          ? Math.min(10, configuredMinutes)
          : configuredMinutes;
    const proposedExpiry = Date.now() + windowMinutes * 60000;
    if (
      order.payment_started_at &&
      quoteData.asset === "BTC" &&
      Date.parse(order.expires_at) - Date.now() < 20 * 60000
    )
      fail(
        "BTC_WINDOW_TOO_SHORT",
        "剩余付款时间不足20分钟，请新建BTC订单；改选不会延长原订单期限",
        409,
      );
    const expiresAt = new Date(
      order.payment_started_at
        ? Math.min(Date.parse(order.expires_at), proposedExpiry)
        : proposedExpiry,
    ).toISOString();
    const required = Math.max(
      Number(network.confirmations || 1),
      Number(this.chainConfig(chain)?.confirmations || 0),
    );
    this.run(
      "INSERT INTO amount_reservations(chain,token_id,pay_address,payable_atomic,order_id,created_at,rate,pricing_json) VALUES(?,?,?,?,?,?,?,?)",
      chain,
      tokenId,
      address.address,
      allocated.toString(),
      order.order_id,
      selectedAt,
      rate,
      JSON.stringify(snapshot),
    );
    this.run(
      "UPDATE orders SET status='pending',chain=?,token_id=?,pay_address=?,payable_atomic=?,payable_amount=?,required_confirmations=?,expires_at=?,payment_started_at=COALESCE(payment_started_at,?) WHERE order_id=?",
      chain,
      tokenId,
      address.address,
      allocated.toString(),
      formatAtomic(allocated, decimals),
      required,
      expiresAt,
      selectedAt,
      order.order_id,
    );
    const updated = this.get(
      "SELECT * FROM orders WHERE order_id=?",
      order.order_id,
    );
    if (emitEvent) this.enqueue(updated, "order.method_selected");
    return this.orderView(updated);
  }
  orderView(o, { publicView = false } = {}) {
    if (!o) return null;
    const p = this.get("SELECT name FROM projects WHERE id=?", o.project_id);
    const product = o.product_id
      ? this.get("SELECT name FROM products WHERE id=?", o.product_id)
      : null;
    const pricing = this.get(
      "SELECT * FROM order_pricing WHERE order_id=?",
      o.order_id,
    );
    const quote = o.chain
      ? this.get(
          "SELECT * FROM amount_reservations WHERE chain=? AND token_id=? AND pay_address=? AND payable_atomic=?",
          o.chain,
          o.token_id,
          o.pay_address,
          o.payable_atomic,
        )
      : null;
    const brand = this.projectSettings(
      this.merchant(o.merchant_id),
      o.project_id,
    );
    let quoteSnapshot = null;
    try { quoteSnapshot = quote?.pricing_json ? JSON.parse(quote.pricing_json) : null; } catch {}
    const bounds = this.fingerprintBounds(o, quote);
    const spec =
      o.chain && o.token_id ? this.tokenSpec(o.chain, o.token_id).token : null;
    const publicPricing = quoteSnapshot
      ? Object.fromEntries(
          [
            "token_usd_price",
            "fiat_usd_rate",
            "quoted_at",
            "price_observed_at",
            "price_source",
            "is_demo",
            "usd_value",
            "fingerprint_usd",
            "price_valid_until",
            "fingerprint_limit_usd",
          ].map((key) => [key, quoteSnapshot[key]]),
        )
      : null;
    const view = {
      token_symbol: spec?.symbol || null,
      token_decimals: spec?.decimals ?? null,
      pricing: publicPricing,
      fee_percent: pricing?.fee_percent || "0.00",
      fee_amount: pricing?.fee_amount || "0.00",
      fiat_total: pricing?.fiat_total || o.fiat_amount,
      exchange_rate: quote?.rate || null,
      brand: {
        display_name: brand.display_name,
        support_email: brand.support_email,
        logo_data_url: brand.logo_data_url,
      },
      order_id: o.order_id,
      merchant_order_id: o.merchant_order_id,
      fiat_amount: o.fiat_amount,
      fiat_currency: o.fiat_currency,
      status:
        o.status === "pending" && !o.chain ? "awaiting_payment" : o.status,
      chain: o.chain,
      token_id: o.token_id,
      pay_address: o.pay_address,
      payable_amount: o.payable_amount,
      payment_tolerance: bounds ? {
        enabled: true,
        kind: "fingerprint_only",
        minimum_amount: compactTokenAmount(bounds.minimum, bounds.decimals),
        maximum_amount: o.payable_amount,
        maximum_shortfall: compactTokenAmount(bounds.maximum - bounds.minimum, bounds.decimals),
        requires_unique_order: true,
      } : null,
      received_amount: this.receivedAmount(o),
      created_at: o.created_at,
      expires_at: o.chain ? o.expires_at : null,
      selection_deadline: o.selection_deadline,
      payment_started_at: o.payment_started_at,
      can_change_method:
        ["awaiting_payment", "pending"].includes(o.status) &&
        !JSON.parse(o.metadata).fixed_method,
      confirmations: o.confirmations,
      required_confirmations: o.required_confirmations,
      tx_hash: o.tx_hash,
      paid_source: o.paid_source || null,
      mode: o.mode,
      product_name: product?.name || null,
      delivery:
        o.status === "paid" && o.delivery ? this.decrypt(o.delivery) : null,
    };
    if (publicView)
      Object.assign(view, {
        server_time: nowISO(),
        payable:
          o.status === "pending" &&
          !!o.chain &&
          Date.parse(o.expires_at) > Date.now(),
      });
    if (!publicView)
      Object.assign(view, {
        project_id: o.project_id,
        project_name: p?.name,
        checkout_token: o.checkout_token,
        checkout_url: "/checkout/" + o.checkout_token,
      });
    return view;
  }
  ownedOrder(m, id, projectId) {
    const o = this.get(
      "SELECT * FROM orders WHERE order_id=? AND merchant_id=?",
      id,
      m.id,
    );
    if (!o || (projectId && o.project_id !== projectId))
      fail("NOT_FOUND", "订单不存在", 404);
    return o;
  }
  checkout(token) {
    const o = this.get("SELECT * FROM orders WHERE checkout_token=?", token);
    if (!o) fail("NOT_FOUND", "收银台不存在", 404);
    return o;
  }
  cancel(m, id, projectId) {
    return this.transaction(() => {
      const o = this.ownedOrder(m, id, projectId);
      if (!["pending", "awaiting_payment"].includes(o.status))
        fail("ORDER_NOT_CANCELABLE", "已有到账记录或订单已结束，无法取消", 409);
      this.run("UPDATE orders SET status='canceled' WHERE order_id=?", id);
      this.enqueue(
        this.get("SELECT * FROM orders WHERE order_id=?", id),
        "order.canceled",
      );
      return this.orderView(
        this.get("SELECT * FROM orders WHERE order_id=?", id),
      );
    });
  }
  activeEndpoints(projectId) {
    return this.all(
      "SELECT e.* FROM endpoints e LEFT JOIN endpoint_state s ON s.endpoint_id=e.id WHERE e.project_id=? AND COALESCE(s.enabled,1)=1",
      projectId,
    );
  }
  enqueueEvent({
    merchant_id,
    project_id,
    event_id = uid("evt_"),
    event_type,
    payload,
    endpoint_id,
  }) {
    const endpoints = this.activeEndpoints(project_id).filter(
      (e) => !endpoint_id || e.id === endpoint_id,
    );
    if (endpoint_id && !endpoints.length)
      fail("ENDPOINT_REQUIRED", "指定回调端点不存在或未启用");
    const body =
      typeof payload === "string"
        ? payload
        : JSON.stringify(
            payload || {
              event_id,
              event_type,
              event_version: "v1",
              created_at: nowISO(),
              data: {},
            },
          );
    const ids = [];
    for (const endpoint of endpoints.length ? endpoints : [null]) {
      const id = uid("wh_");
      this.run(
        "INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        merchant_id,
        project_id,
        endpoint?.id || null,
        event_id,
        event_type,
        body,
        endpoint ? "pending" : "unconfigured",
        0,
        Date.now(),
        null,
        nowISO(),
        null,
      );
      ids.push(id);
    }
    return { event_id, ids };
  }
  enqueue(o, eventType) {
    const event_id = uid("evt_");
    const payload = {
      event_id,
      event_type: eventType,
      event_version: "v1",
      created_at: nowISO(),
      data: {
        order_id: o.order_id,
        merchant_order_id: o.merchant_order_id,
        fiat_currency: o.fiat_currency,
        fiat_amount: o.fiat_amount,
        tx_id: o.tx_hash || null,
        paid_at: eventType === "order.paid" ? nowISO() : null,
        paid_source: o.paid_source || null,
        status:
          o.status === "pending" && !o.chain ? "awaiting_payment" : o.status,
        chain: o.chain,
        token_id: o.token_id,
        pay_address: o.pay_address,
        payable_amount: o.payable_amount,
        confirmations: o.confirmations,
        required_confirmations: o.required_confirmations,
        expires_at: o.chain ? o.expires_at : null,
        selection_deadline: o.selection_deadline,
      },
    };
    if (eventType === "order.paid") {
      const received = this.linkedTransfer(o);
      if (received) {
        const decimals = this.tokenSpec(o.chain, o.token_id).token.decimals;
        payload.data.received_amount = compactTokenAmount(BigInt(received.amount_atomic), decimals);
        const waived = BigInt(o.payable_atomic) - BigInt(received.amount_atomic);
        if (waived > 0n) payload.data.waived_fingerprint_amount = compactTokenAmount(waived, decimals);
      }
    }
    return this.enqueueEvent({
      merchant_id: o.merchant_id,
      project_id: o.project_id,
      event_id,
      event_type: eventType,
      payload,
    });
  }
  settle(o, transfer, { source = "chain" } = {}) {
    if (o.status === "paid") return;
    let delivery = null;
    if (o.product_id) {
      const item = this.get(
        "SELECT * FROM inventory WHERE product_id=? AND order_id IS NULL ORDER BY created_at LIMIT 1",
        o.product_id,
      );
      if (!item) {
        this.run(
          "UPDATE orders SET status='review',tx_hash=?,transfer_id=?,confirmations=?,paid_source=? WHERE order_id=?",
          transfer.tx_hash,
          transfer.id,
          transfer.confirmations,
          source,
          o.order_id,
        );
        this.run(
          "UPDATE transfers SET order_id=?,reason='stock_unavailable' WHERE id=?",
          o.order_id,
          transfer.id,
        );
        return;
      }
      this.run(
        "UPDATE inventory SET order_id=? WHERE id=? AND order_id IS NULL",
        o.order_id,
        item.id,
      );
      delivery = item.content;
    }
    this.run(
      "UPDATE orders SET status='paid',tx_hash=?,transfer_id=?,confirmations=?,delivery=?,paid_source=? WHERE order_id=?",
      transfer.tx_hash,
      transfer.id,
      transfer.confirmations,
      delivery,
      source,
      o.order_id,
    );
    this.run(
      "UPDATE transfers SET order_id=?,reason=NULL WHERE id=?",
      o.order_id,
      transfer.id,
    );
    const paidOrder = this.get(
      "SELECT * FROM orders WHERE order_id=?",
      o.order_id,
    );
    this.callHook("afterPaid", paidOrder);
    this.enqueue(paidOrder, "order.paid");
  }
  ingest(tx, { mode = "live" } = {}) {
    return this.transaction(() => {
      const normalized =
        mode === "demo"
          ? chainAddress(tx.chain, tx.to_address)
          : this.normalizeAddress(tx.chain, tx.to_address);
      const addr = this.get(
        "SELECT * FROM addresses WHERE chain=? AND address=? AND mode=?",
        tx.chain,
        normalized,
        mode,
      );
      if (!addr) return { ignored: true };
      if (!JSON.parse(addr.token_ids).includes(tx.token_id))
        return { ignored: true };
      if (
        !/^\d+$/.test(String(tx.amount_atomic)) ||
        !Number.isSafeInteger(tx.block_height) ||
        !Number.isInteger(tx.event_index) ||
        !Number.isInteger(tx.confirmations) ||
        !tx.block_hash ||
        !tx.tx_hash ||
        !Number.isFinite(Date.parse(tx.block_time))
      )
        fail("INVALID_TRANSFER", "无效链上记录");
      const id = hash([tx.chain, tx.tx_hash, tx.event_index].join(":"));
      const previous = this.get("SELECT * FROM transfers WHERE id=?", id);
      if (
        previous &&
        (previous.amount_atomic !== String(tx.amount_atomic) ||
          previous.to_address !== normalized ||
          previous.token_id !== tx.token_id || previous.mode !== mode ||
          previous.merchant_id !== addr.merchant_id || previous.project_id !== addr.project_id)
      )
        fail("TRANSFER_CONFLICT", "交易记录发生冲突", 409);
      const row = {
        id,
        merchant_id: addr.merchant_id,
        project_id: addr.project_id,
        chain: tx.chain,
        token_id: tx.token_id,
        tx_hash: tx.tx_hash,
        event_index: tx.event_index,
        to_address: normalized,
        from_address: tx.from_address || "",
        amount_atomic: String(tx.amount_atomic),
        block_height: tx.block_height,
        block_hash: tx.block_hash,
        block_time: new Date(tx.block_time).toISOString(),
        confirmations: tx.confirmations,
        confirmed: tx.confirmed ? 1 : 0,
        removed: tx.removed ? 1 : 0,
        order_id: previous?.order_id || null,
        mode,
        reason: null,
      };
      this.run(
        `INSERT INTO transfers VALUES(${Object.keys(row)
          .map(() => "?")
          .join(
            ",",
          )}) ON CONFLICT(id) DO UPDATE SET confirmations=excluded.confirmations,confirmed=excluded.confirmed,removed=excluded.removed,block_hash=excluded.block_hash,block_height=excluded.block_height,block_time=excluded.block_time`,
        ...Object.values(row),
      );
      // Bindings survive reorgs. Unclaimed ambiguities cannot resolve themselves on replay.
      let o = previous?.order_id
        ? this.get("SELECT * FROM orders WHERE order_id=?", previous.order_id)
        : null;
      if (previous?.order_id && !o) fail("TRANSFER_CONFLICT", "已绑定交易的订单不存在", 409);
      if (!o && previous?.reason === "ambiguous_amount") return { matched: false };
      const tolerant = this.config.payments?.allowFingerprintUnderpayment === true && isKnownStable(tx.token_id);
      if (!o && tolerant) {
        const candidates = new Map();
        const reservations = this.all(
          "SELECT r.* FROM amount_reservations r JOIN orders o ON o.order_id=r.order_id WHERE r.chain=? AND r.token_id=? AND r.pay_address=? AND o.merchant_id=? AND o.project_id=? AND o.mode=?",
          tx.chain, tx.token_id, normalized, addr.merchant_id, addr.project_id, mode,
        );
        for (const quote of reservations) {
          const candidate = this.get("SELECT * FROM orders WHERE order_id=?", quote.order_id);
          const created = Date.parse(quote.created_at || candidate.payment_started_at || candidate.created_at);
          // Same-second uncertainty is still an attribution blocker. It must not
          // disappear and let another order's exact amount win the ambiguity check.
          // Actual underpayment settlement below uses the stricter millisecond start.
          const start = Math.floor(created / 1000) * 1000;
          if (!Number.isFinite(start) || Date.parse(row.block_time) < start ||
              !this.paymentAmountMatches(candidate, row.amount_atomic, quote)) continue;
          const current = candidate.chain === quote.chain && candidate.token_id === quote.token_id &&
            candidate.pay_address === quote.pay_address && candidate.payable_atomic === quote.payable_atomic;
          // Historical quotes remain blockers for late/repeated payments, never payable replacements.
          if (!candidates.has(candidate.order_id) || current)
            candidates.set(candidate.order_id, { order: candidate, current });
        }
        if (candidates.size > 1) {
          this.run("UPDATE transfers SET reason='ambiguous_amount' WHERE id=?", id);
          return { matched: false };
        }
        if (candidates.size === 1) {
          const candidate = [...candidates.values()][0];
          if (!candidate.current) {
            this.run("UPDATE transfers SET reason='superseded_payment_method' WHERE id=?", id);
            return { matched: false };
          }
          o = candidate.order;
        }
      }
      if (!o) o = this.get(
        "SELECT * FROM orders WHERE chain=? AND token_id=? AND pay_address=? AND payable_atomic=? AND mode=?",
        tx.chain, tx.token_id, normalized, String(tx.amount_atomic), mode,
      );
      if (!o) {
        const reserved = this.get(
          "SELECT order_id FROM amount_reservations WHERE chain=? AND token_id=? AND pay_address=? AND payable_atomic=?",
          tx.chain,
          tx.token_id,
          normalized,
          String(tx.amount_atomic),
        );
        this.run(
          "UPDATE transfers SET reason=? WHERE id=?",
          reserved ? "superseded_payment_method" : "unmatched_amount",
          id,
        );
        return { matched: false };
      }
      if (
        o.merchant_id !== addr.merchant_id ||
        o.project_id !== addr.project_id || o.mode !== mode
      )
        fail("TENANT_MISMATCH", "交易归属不符");
      if (o.chain !== tx.chain || o.token_id !== tx.token_id || o.pay_address !== normalized) {
        this.run("UPDATE transfers SET reason='superseded_payment_method' WHERE id=?", id);
        return { matched: false };
      }
      if (o.status === "paid") {
        if (tx.removed)
          this.run(
            "UPDATE transfers SET reason='reorg_after_payment' WHERE id=?",
            id,
          );
        if (tolerant && o.transfer_id !== id) {
          this.run("UPDATE transfers SET reason='duplicate_payment' WHERE id=?", id);
          return { matched: false };
        }
        return { matched: true, order: this.orderView(o) };
      }
      if (tx.removed) {
        this.run("UPDATE transfers SET reason='removed_block' WHERE id=?", id);
        if (o.transfer_id === id)
          this.run(
            "UPDATE orders SET status='pending',confirmations=0,tx_hash=NULL,transfer_id=NULL WHERE order_id=?",
            o.order_id,
          );
        return { matched: false };
      }
      const quote = this.orderQuote(o);
      if (o.status === "expired") {
        this.run(
          "UPDATE transfers SET reason='expired_order_requires_review' WHERE id=?",
          id,
        );
        return { matched: false };
      }
      const blockTime = Date.parse(tx.block_time);
      const quoteStart = Date.parse(quote?.created_at || o.payment_started_at || o.created_at);
      const minimumTime = row.amount_atomic !== o.payable_atomic && o.paid_source !== "manual"
        ? quoteStart : Math.floor(quoteStart / 1000) * 1000;
      if (
        blockTime < minimumTime ||
        blockTime > Date.parse(o.expires_at) ||
        ["canceled"].includes(o.status)
      ) {
        this.run(
          "UPDATE transfers SET reason='outside_order_window' WHERE id=?",
          id,
        );
        return { matched: false };
      }
      if (previous?.order_id && previous.order_id !== o.order_id)
        fail("TRANSFER_ALREADY_USED", "此交易已被认领");
      if (!this.paymentAmountMatches(o, row.amount_atomic, quote, { force: previous?.order_id === o.order_id })) {
        this.run("UPDATE transfers SET reason='unmatched_amount' WHERE id=?", id);
        return { matched: false };
      }
      if (o.transfer_id && o.transfer_id !== id) {
        this.run(
          "UPDATE transfers SET reason='duplicate_payment' WHERE id=?",
          id,
        );
        return { matched: false };
      }
      this.run("UPDATE transfers SET order_id=? WHERE id=?", o.order_id, id);
      if (tx.confirmed && tx.confirmations >= o.required_confirmations)
        this.settle(o, row, { source: o.paid_source === "manual" ? "manual" : "chain" });
      else {
        this.run(
          "UPDATE orders SET status='confirming',confirmations=?,tx_hash=?,transfer_id=? WHERE order_id=?",
          tx.confirmations,
          tx.tx_hash,
          id,
          o.order_id,
        );
        if (o.status !== "confirming")
          this.enqueue(
            this.get("SELECT * FROM orders WHERE order_id=?", o.order_id),
            "order.confirming",
          );
      }
      return {
        matched: true,
        order: this.orderView(
          this.get("SELECT * FROM orders WHERE order_id=?", o.order_id),
        ),
      };
    });
  }
  simulate(m, id, confirmations) {
    const o = this.ownedOrder(m, id);
    if (m.mode !== "demo" || o.mode !== "demo")
      fail("DEMO_ONLY", "仅演示订单可模拟付款", 403);
    if (!o.chain) fail("METHOD_REQUIRED", "请先选择支付方式");
    confirmations =
      confirmations === undefined
        ? o.required_confirmations
        : Number(confirmations);
    if (
      !Number.isInteger(confirmations) ||
      confirmations < 0 ||
      confirmations > 10000
    )
      fail("INVALID_CONFIRMATIONS", "确认数无效");
    const transfer = o.transfer_id
      ? this.get("SELECT * FROM transfers WHERE id=?", o.transfer_id)
      : null;
    return this.ingest(
      {
        chain: o.chain,
        token_id: o.token_id,
        tx_hash: transfer?.tx_hash || "demo_" + hash(o.order_id),
        event_index: 0,
        to_address: o.pay_address,
        from_address: "demo:sender",
        amount_atomic: transfer?.amount_atomic || o.payable_atomic,
        block_height: 123456,
        block_hash: "demo_block",
        block_time: transfer?.block_time || nowISO(),
        confirmations,
        confirmed: confirmations >= o.required_confirmations,
        removed: false,
      },
      { mode: "demo" },
    ).order;
  }
  claim(m, transactionId, orderId) {
    return this.transaction(() => {
      const tx = this.get(
        "SELECT * FROM transfers WHERE id=? AND merchant_id=?",
        transactionId,
        m.id,
      );
      const o = this.ownedOrder(m, orderId);
      if (!tx) fail("NOT_FOUND", "交易不存在", 404);
      const quote = this.orderQuote(o);
      if (
        tx.project_id !== o.project_id ||
        tx.mode !== o.mode ||
        tx.chain !== o.chain ||
        tx.token_id !== o.token_id ||
        tx.to_address !== o.pay_address ||
        !this.paymentAmountMatches(o, tx.amount_atomic, quote, { force: tx.order_id === o.order_id }) ||
        tx.removed ||
        !tx.confirmed ||
        tx.confirmations < o.required_confirmations ||
        Date.parse(tx.block_time) <
          Math.floor(
            Date.parse(
              quote?.created_at || o.payment_started_at || o.created_at,
            ) / 1000,
          ) *
            1000 ||
        Date.parse(tx.block_time) > Date.parse(o.expires_at) ||
        o.status === "canceled"
      )
        fail(
          "CLAIM_REJECTED",
          "交易须满足同项目、正确币种/地址/金额/时间窗口和足够链确认",
        );
      if (tx.order_id && tx.order_id !== o.order_id)
        fail("CLAIM_REJECTED", "交易已关联其他订单");
      if (o.transfer_id && o.transfer_id !== tx.id)
        fail("CLAIM_REJECTED", "订单已关联其他交易");
      this.settle(o, tx, { source: "manual" });
      this.audit(m.id, "merchant_claim", transactionId);
      return this.orderView(
        this.get("SELECT * FROM orders WHERE order_id=?", o.order_id),
      );
    });
  }
  expire() {
    return this.transaction(() => {
      const rows = this.all(
        "SELECT * FROM orders WHERE (status='pending' AND expires_at<?) OR (status='awaiting_payment' AND selection_deadline<?)",
        nowISO(),
        nowISO(),
      );
      for (const o of rows) {
        if (o.mode === "live" && o.chain) {
          const watermark = this.get(
            "SELECT block_time FROM scanner_watermarks WHERE chain=?",
            o.chain,
          );
          const health = this.get(
            "SELECT last_error FROM cursors WHERE chain=?",
            o.chain,
          );
          if (
            !watermark ||
            watermark.block_time < o.expires_at ||
            health?.last_error
          )
            continue;
        }
        this.run(
          "UPDATE orders SET status='expired' WHERE order_id=?",
          o.order_id,
        );
        this.enqueue({ ...o, status: "expired" }, "order.expired");
      }
      return rows.length;
    });
  }
  demoMerchant() {
    const m = this.register(
      {
        email: uid("demo-") + "@example.test",
        password: randomBytes(32).toString("hex"),
        name: "演示商户",
      },
      "demo",
    );
    const p = this.createProject(m, {
      name: "数字商品商店",
      description: "隔离演示项目，所有地址和交易均为合成数据",
    });
    for (const chain of this.registry) {
      this.addAddress(m, {
        project_id: p.id,
        chain: chain.id,
        address: `demo:${m.id}:${chain.id}`,
        label: "演示收款地址",
      });
    }
    const product = this.createProduct(m, {
      project_id: p.id,
      name: "数字创作素材包",
      price: "9.90",
      currency: "USD",
    });
    this.importInventory(
      m,
      product.id,
      Array.from(
        { length: 40 },
        (_, i) => `DEMO-LICENSE-${m.id.slice(-6)}-${i + 1} · 此为演示交付内容`,
      ),
    );
    for (let i = 0; i < 6; i++) {
      const chain = this.registry[0];
      const token =
        chain.tokens.find((t) => t.symbol === "USDT") || chain.tokens[0];
      const order = this.createOrder(m, {
        project_id: p.id,
        fiat_amount: String([9.9, 29, 19, 49.9, 9.9, 15][i]),
        fiat_currency: "USD",
        chain: chain.id,
        token_id: token.id,
        product_id: i === 0 ? product.id : undefined,
        merchant_order_id: `DEMO-${String(i + 1).padStart(4, "0")}`,
      });
      if (i < 4) this.simulate(m, order.order_id);
      if (i === 4) this.simulate(m, order.order_id, 2);
    }
    return m;
  }
}
