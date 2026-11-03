import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  useId,
} from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  CreditCard,
  ExternalLink,
  FileText,
  Filter,
  Globe2,
  KeyRound,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Package,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  TriangleAlert,
  Wallet,
  Webhook,
  X,
  XCircle,
  Zap,
  Layers,
  FolderKanban,
  LockKeyhole,
  Mail,
  UserRound,
  Eye,
  EyeOff,
  Send,
} from "lucide-react";
import QRCode from "qrcode";
import { downloadCsv } from "./csv.js";
import { displayAmount, tokenSymbol, pricingSourceLabel } from "./money.js";
import { api, mutate, setProjectScope } from "./api.js";

const Context = createContext(null);
const useApp = () => useContext(Context);
const TITLES = {
  dashboard: "概览",
  projects: "项目",
  orders: "订单",
  addresses: "收款地址",
  keys: "API 密钥",
  webhooks: "Webhook",
  transactions: "未匹配款",
  products: "商品与发货",
  settings: "账户设置",
  "payment-links": "收款链接",
  refunds: "退款",
  "project-settings": "项目设置",
  usage: "套餐与用量",
  billing: "账单历史",
  "platform-plans": "套餐管理",
  "platform-merchants": "商户管理",
  "platform-invoices": "订阅账单",
};
const NAV_GROUPS = [
  [null, [["dashboard", LayoutDashboard]]],
  [
    "收款",
    [
      ["orders", CreditCard],
      ["payment-links", Link2],
      ["refunds", ArrowDownLeft],
      ["transactions", Activity],
    ],
  ],
  [
    "配置",
    [
      ["addresses", Wallet],
      ["webhooks", Webhook],
      ["keys", KeyRound],
      ["project-settings", Settings],
    ],
  ],
  [
    "账户",
    [
      ["projects", FolderKanban],
      ["usage", Layers],
      ["billing", FileText],
      ["products", Package],
      ["settings", UserRound],
    ],
  ],
];
const NAV = [
  ["dashboard", LayoutDashboard],
  ["projects", FolderKanban],
  ["orders", CreditCard],
  ["addresses", Wallet],
  ["keys", KeyRound],
  ["webhooks", Webhook],
  ["transactions", Activity],
  ["products", Package],
  ["settings", Settings],
];
const CHAIN_NAMES = {
  bitcoin: "Bitcoin",
  tron: "Tron",
  ethereum: "Ethereum",
  bsc: "BSC",
  polygon: "Polygon",
  base: "Base",
  arbitrum: "Arbitrum",
  solana: "Solana",
  aptos: "Aptos",
  plasma: "Plasma",
  "x-layer": "X Layer",
};
const CHAIN_COLORS = {
  bitcoin: "#f7931a",
  tron: "#ef4444",
  ethereum: "#6f7bba",
  bsc: "#f3ba2f",
  polygon: "#8b5cf6",
  base: "#2f64ed",
  arbitrum: "#338bce",
  solana: "#1b1f28",
  aptos: "#151b24",
  plasma: "#15765c",
  "x-layer": "#30343b",
};
const ASSETS = [
  { symbol: "BTC", name: "Bitcoin", mark: "₿", color: "#f7931a" },
  { symbol: "ETH", name: "Ethereum", mark: "◆", color: "#6978ad" },
  { symbol: "BNB", name: "BNB", mark: "◇", color: "#d4a516" },
  { symbol: "SOL", name: "Solana", mark: "≋", color: "#252b39" },
  { symbol: "TRX", name: "TRON", mark: "▽", color: "#e94d56" },
  { symbol: "USDT", name: "Tether", mark: "₮", color: "#26a17b" },
  { symbol: "USDC", name: "USD Coin", mark: "$", color: "#2775ca" },
];
const STATUS = {
  pending: ["等待付款", "amber"],
  awaiting_payment: ["待选择方式", "gray"],
  confirming: ["链上确认中", "blue"],
  paid: ["已支付", "green"],
  expired: ["已过期", "gray"],
  canceled: ["已取消", "gray"],
  delivered: ["已投递", "green"],
  success: ["已投递", "green"],
  succeeded: ["已投递", "green"],
  queued: ["等待投递", "blue"],
  retrying: ["等待重试", "amber"],
  failed: ["投递失败", "red"],
  dead: ["死信", "red"],
  dead_letter: ["死信", "red"],
  unmatched: ["未匹配", "amber"],
  unconfigured: ["未配置接收端", "gray"],
  recorded: ["已登记", "blue"],
  voided: ["已作废", "gray"],
  delivery_pending: ["等待投递", "amber"],
};
function go(path) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  requestAnimationFrame(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
    else window.scrollTo(0, 0);
  });
}
function Link({ to, children, className = "", ...props }) {
  return (
    <a
      href={to}
      className={className}
      {...props}
      onClick={(e) => {
        props.onClick?.(e);
        if (
          !e.defaultPrevented &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.shiftKey &&
          (!props.target || props.target === "_self")
        ) {
          e.preventDefault();
          go(to);
        }
      }}
    >
      {children}
    </a>
  );
}
function Logo({ small = false }) {
  return (
    <Link to="/" className="brand">
      <span className="brand-icon">
        <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
          <path
            d="M5 26 13.6 6.9a2.65 2.65 0 0 1 4.8 0L27 26M9 22c4-6 10-6 14 0"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {!small && <span>Avenora Pay</span>}
    </Link>
  );
}
function ChainIcon({ chain, size = 25 }) {
  return (
    <span
      className="chain-icon"
      style={{
        background: CHAIN_COLORS[chain] || "#747b8a",
        width: size,
        height: size,
        fontSize: size * 0.45,
      }}
    >
      {chain === "bitcoin"
        ? "₿"
        : chain === "ethereum"
          ? "◆"
          : chain === "bsc"
            ? "◇"
            : chain === "tron"
              ? "▽"
              : chain === "solana"
                ? "≋"
                : chain === "base"
                  ? "▬"
                  : chain?.[0]?.toUpperCase() || "◈"}
    </span>
  );
}
function AssetIcon({ asset, size = 25 }) {
  return (
    <span
      className="chain-icon"
      style={{
        background: asset.color,
        width: size,
        height: size,
        fontSize: size * 0.5,
      }}
    >
      {asset.mark}
    </span>
  );
}
function PriceSnapshot({ order }) {
  const pricing = order?.pricing;
  if (!pricing?.token_usd_price) return null;
  return (
    <div className="price-snapshot">
      <div>
        <span>本单报价</span>
        <b>
          1 {tokenSymbol(order)} = {displayAmount(pricing.token_usd_price)} USD
        </b>
      </div>
      <p>{pricingSourceLabel(pricing)}</p>
      {pricing.quoted_at && <small>锁价时间：{date(pricing.quoted_at)}</small>}
      {order.status === "pending" && order.expires_at && (
        <small>付款截止：{date(order.expires_at)}，到期请重新创建订单。</small>
      )}
    </div>
  );
}
function Badge({ status, children }) {
  const data = STATUS[status] || [status, "gray"];
  return (
    <span className={`badge ${data[1]}`}>
      <span />
      {children || data[0]}
    </span>
  );
}
function Money({ value, currency = "USD" }) {
  return (
    <>
      {currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency + " "}
      {Number(value || 0).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}
    </>
  );
}
const date = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
const clip = (value, n = 8) =>
  value && value.length > n * 2 + 3
    ? `${value.slice(0, n)}…${value.slice(-n)}`
    : value || "—";
function CopyButton({ value, label }) {
  const { notify } = useApp();
  return (
    <button
      type="button"
      className="copy-button"
      title={label || "复制"}
      aria-label={label || "复制"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value || "");
          notify("已复制");
        } catch {
          notify("无法访问剪贴板，请手动复制", "error");
        }
      }}
    >
      <Copy size={14} />
    </button>
  );
}
function Spinner() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={24} />
      <span>正在加载</span>
    </div>
  );
}
function Empty({
  icon: Icon = FileText,
  title = "暂时没有记录",
  description = "新记录会出现在这里。",
  action,
}) {
  return (
    <div className="empty">
      <span>
        <Icon size={25} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function Modal({ title, description, onClose, children, wide = false }) {
  useEffect(() => {
    const fn = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", fn);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", fn);
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function Field({ label, children, help }) {
  const id = useId();
  const direct =
    React.isValidElement(children) &&
    ["input", "select", "textarea"].includes(children.type);
  return (
    <div className="field">
      <label htmlFor={direct ? id : undefined}>{label}</label>
      {direct
        ? React.cloneElement(children, {
            id,
            "aria-label": children.props["aria-label"] || label,
          })
        : children}
      {help && <small>{help}</small>}
    </div>
  );
}
function FormFooter({ busy, onClose, text = "保存" }) {
  return (
    <div className="form-footer">
      <button type="button" className="button secondary" onClick={onClose}>
        取消
      </button>
      <button className="button primary" disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={16} /> : null}
        {busy ? "处理中…" : text}
      </button>
    </div>
  );
}
function InlineError({ error }) {
  return error ? (
    <div className="inline-error" role="alert">
      <TriangleAlert size={16} />
      {error}
    </div>
  ) : null;
}
function ProjectSelect({
  projects,
  value,
  onChange,
  required = true,
  disabled = false,
}) {
  return (
    <select
      disabled={disabled}
      aria-label="所属项目"
      value={value}
      required={required}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">选择项目</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
function useLoad(loader, deps = []) {
  const scope = useApp()?.activeProjectId;
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    loader()
      .then((v) => active && setData(v))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [...deps, version, scope]);
  return {
    data,
    loading,
    error,
    reload: () => setVersion((v) => v + 1),
    setData,
  };
}
function ResourceError({ error, onRetry }) {
  return (
    <div className="resource-error">
      <TriangleAlert size={24} />
      <h3>暂时无法加载</h3>
      <p>{error}</p>
      <button className="button secondary" onClick={onRetry}>
        <RefreshCw size={15} />
        重试
      </button>
    </div>
  );
}
function QR({ value, demo = false, size = 148 }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(
      demo ? "AVENORA-PAY-DEMO-NOT-A-PAYMENT" : value || "AVENORA-PAY",
      { width: size, margin: 1, color: { dark: "#101725", light: "#ffffff" } },
    )
      .then(setSrc)
      .catch(() => setSrc(""));
  }, [value, demo, size]);
  return src ? (
    <img
      className={`qr ${demo ? "demo-qr" : ""}`}
      src={src}
      alt={demo ? "演示二维码，不能用于支付" : "收款地址二维码"}
      width={size}
      height={size}
    />
  ) : (
    <div style={{ width: size, height: size }} />
  );
}
function checkoutPath(order) {
  try {
    return new URL(order.checkout_url, location.origin).pathname;
  } catch {
    return `/checkout/${order.checkout_token}`;
  }
}

export default function App() {
  const [path, setPath] = useState(location.pathname),
    [auth, setAuth] = useState({ user: null, mode: "demo", loading: true }),
    [toast, setToast] = useState(null),
    [registry, setRegistry] = useState({ chains: [], currencies: ["USD"] }),
    [activeProjectId, setActiveProjectId] = useState(""),
    [accountInfo, setAccountInfo] = useState(null),
    [demoBusy, setDemoBusy] = useState(false);
  const demoPending = useRef(false);
  useEffect(() => {
    const fn = () => setPath(location.pathname);
    addEventListener("popstate", fn);
    return () => removeEventListener("popstate", fn);
  }, []);
  const refreshAuth = async () => {
    try {
      const v = await api("/api/auth/me");
      setAuth({ ...v, loading: false });
      return v;
    } catch {
      setAuth({ user: null, mode: "demo", loading: false });
    }
  };
  useEffect(() => {
    refreshAuth();
    api("/api/registry")
      .then(setRegistry)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 4200);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const notify = (message, type = "success") => setToast({ message, type });
  const demo = async () => {
    if (demoPending.current) return;
    demoPending.current = true;
    setDemoBusy(true);
    try {
      await mutate("/api/auth/demo");
      await refreshAuth();
      go("/merchant/dashboard");
    } catch (e) {
      notify(e.message, "error");
    } finally {
      demoPending.current = false;
      setDemoBusy(false);
    }
  };
  useEffect(() => {
    setActiveProjectId("");
    setProjectScope("");
    if (auth.user)
      api("/api/subscription")
        .then(setAccountInfo)
        .catch(() => setAccountInfo(null));
    else setAccountInfo(null);
  }, [auth.user?.id]);
  const changeProject = (value) => {
    setProjectScope(value);
    setActiveProjectId(value);
  };
  const ctx = {
    ...auth,
    refreshAuth,
    notify,
    demo,
    demoBusy,
    registry,
    path,
    activeProjectId,
    changeProject,
    isAdmin: accountInfo?.is_admin === true,
  };
  let content;
  if (path.startsWith("/pay/"))
    content = (
      <PaymentLinkPage id={decodeURIComponent(path.split("/")[2] || "")} />
    );
  else if (path.startsWith("/checkout/"))
    content = <Checkout token={decodeURIComponent(path.split("/")[2] || "")} />;
  else if (path === "/merchant/login" || path === "/merchant/register")
    content = <AuthPage register={path.endsWith("register")} />;
  else if (path.startsWith("/merchant/"))
    content = <MerchantShell page={path.split("/")[2] || "dashboard"} />;
  else if (path === "/pricing") content = <Pricing />;
  else if (path === "/docs") content = <Docs />;
  else if (["/about", "/privacy", "/terms"].includes(path))
    content = <About page={path} />;
  else if (path === "/") content = <Landing />;
  else
    content = (
      <>
        <PublicNav />
        <div className="not-found">
          <h1>页面不存在</h1>
          <Link to="/" className="button primary">
            返回首页
          </Link>
        </div>
      </>
    );
  return (
    <Context.Provider value={ctx}>
      {content}
      {toast && (
        <div role="status" className={`toast ${toast.type}`}>
          <span>
            {toast.type === "error" ? (
              <TriangleAlert size={18} />
            ) : (
              <CheckCircle2 size={18} />
            )}
          </span>
          {toast.message}
          <button onClick={() => setToast(null)} aria-label="关闭通知">
            <X size={15} />
          </button>
        </div>
      )}
    </Context.Provider>
  );
}

function PublicNav() {
  const { user, public_demo: publicDemo, demo, demoBusy } = useApp();
  const [mobile, setMobile] = useState(false);
  return (
    <header className="public-nav">
      <div className="public-nav-inner">
        <Logo />
        <nav className={mobile ? "open" : ""}>
          <Link to="/" onClick={() => setMobile(false)}>
            首页
          </Link>
          <Link to="/pricing" onClick={() => setMobile(false)}>
            定价
          </Link>
          <a href="/#chains" onClick={() => setMobile(false)}>
            支持的链
          </a>
          <Link to="/docs" onClick={() => setMobile(false)}>
            文档
          </Link>
          <Link to="/about" onClick={() => setMobile(false)}>
            关于
          </Link>
        </nav>
        <div className="nav-actions">
          <span className="language">
            <Globe2 size={15} />
            中文
          </span>
          {user ? (
            <Link to="/merchant/dashboard" className="button primary small">
              商户后台
              <ArrowRight size={14} />
            </Link>
          ) : publicDemo ? (
            <button
              className="button primary small"
              onClick={demo}
              disabled={demoBusy}
            >
              {demoBusy ? "正在准备…" : "体验演示"}
              <ArrowRight size={14} />
            </button>
          ) : (
            <>
              <Link to="/merchant/login" className="login-link">
                登录
              </Link>
              <Link to="/merchant/register" className="button primary small">
                注册
              </Link>
            </>
          )}
          <button
            className="icon-button mobile-menu"
            onClick={() => setMobile(!mobile)}
            aria-label="切换导航"
          >
            <Menu size={21} />
          </button>
        </div>
      </div>
    </header>
  );
}
function PublicFooter() {
  return (
    <footer className="public-footer">
      <div className="footer-grid">
        <div>
          <Logo />
          <p>加密货币收款，直达自有钱包。</p>
          <span className="lab-disclosure">多币种收款 · 非托管支付网关</span>
        </div>
        {[
          [
            "产品",
            [
              ["定价", "/pricing"],
              ["商户后台", "/merchant/dashboard"],
            ],
          ],
          [
            "资源",
            [
              ["接入文档", "/docs"],
              ["支持的链", "/#chains"],
            ],
          ],
          [
            "关于",
            [
              ["项目说明", "/about"],
              ["隐私说明", "/privacy"],
            ],
          ],
        ].map(([title, links]) => (
          <div key={title}>
            <b>{title}</b>
            {links.map(([label, to]) => (
              <Link key={to} to={to}>
                {label}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className="footer-bottom">
        © {new Date().getFullYear()} Avenora Pay
        <span>
          <ShieldCheck size={13} />
          非托管架构 · 不接触私钥
        </span>
      </div>
    </footer>
  );
}
function Landing() {
  const { demo, demoBusy, registry, public_demo: publicDemo } = useApp();
  const chains = registry.chains || [];
  return (
    <>
      <PublicNav />
      <main>
        <section className="hero">
          <div className="hero-dots" />
          <div className="hero-inner">
            <div className="hero-copy">
              <span className="eyebrow-pill">
                <i />
                非托管 · 资金不经平台
              </span>
              <h1>
                加密货币收款，直达
                <br />
                <em>自有钱包</em>
              </h1>
              <p>
                客户付款直接进入你的钱包。识别到账、链上确认，
                <br className="desktop-break" />
                再把支付结果可靠地送达你的业务。
              </p>
              <div className="hero-actions">
                <button
                  className="button primary large"
                  onClick={demo}
                  disabled={demoBusy}
                >
                  {demoBusy ? "正在准备演示空间…" : "体验商户工作台"}
                  <ArrowRight size={17} />
                </button>
                <Link className="button secondary large" to="/docs">
                  查看接入文档
                </Link>
              </div>
              <div className="hero-checks">
                <span>
                  <Check size={16} />
                  不碰私钥与资金
                </span>
                <span>
                  <Check size={16} />
                  主流币与稳定币
                </span>
                <span>
                  <Check size={16} />
                  可自行部署
                </span>
              </div>
              <span className="hero-note">
                {publicDemo
                  ? "公开演示 · 无需注册 · 请勿输入真实资料或转账"
                  : "Avenora Pay · 演示空间不处理真实转账"}
              </span>
            </div>
            <div className="hero-visual">
              <div className="hero-checkout">
                <div className="checkout-card-top">
                  <span className="store-avatar">A</span>
                  <div>
                    <b>示例商城</b>
                    <small>#AVN-10086</small>
                  </div>
                  <Badge status="paid" />
                </div>
                <div className="hero-amount">
                  <span className="network-pill">
                    <ChainIcon chain="tron" size={15} />
                    网络 TRON
                  </span>
                  <small>应付金额</small>
                  <strong>
                    <span className="token-symbol">₮</span>39.9120<em>USDT</em>
                  </strong>
                  <small>≈ 39.90 USD</small>
                </div>
                <div className="hero-qr">
                  <QR demo size={84} />
                  <div>
                    <small>收款地址</small>
                    <code>DEMO · 演示地址</code>
                    <span>剩余 14:52</span>
                  </div>
                </div>
                <div className="confirmation-bars">
                  {Array.from({ length: 12 }, (_, i) => (
                    <i key={i} />
                  ))}
                </div>
              </div>
              <div className="wallet-float">
                <div>
                  <Wallet size={15} />
                  <b>你的钱包</b>
                </div>
                <small>演示收款记录</small>
                <strong>+39.9120 USDT</strong>
              </div>
              <div className="webhook-float">
                <Webhook size={18} />
                <div>
                  <b>
                    <CheckCircle2 size={15} />
                    order.paid · 200 OK
                  </b>
                  <small>已通知业务系统 · 流程示意</small>
                </div>
              </div>
            </div>
          </div>
        </section>
        <div className="chain-strip asset-strip">
          <span>主流币与稳定币</span>
          {ASSETS.map((asset) => (
            <span className="chain-chip" key={asset.symbol}>
              <AssetIcon asset={asset} size={25} />
              {asset.symbol}
            </span>
          ))}
        </div>
        <section className="section lifecycle">
          <span className="section-kicker">订单生命周期</span>
          <h2>从订单到履约，资金始终直达你的地址</h2>
          <p className="section-description">
            一次连接，串起收款、确认和自动发货。
          </p>
          <div className="steps-grid">
            {[
              [
                CreditCard,
                "生成付款指纹",
                "为订单分配精确金额，区分同地址收到的多笔转账。",
                "9.90 USD → 9.9037 USDT",
              ],
              [
                Wallet,
                "客户转入你的地址",
                "付款在客户与商户钱包之间完成，网关负责观察。",
                "customer → your wallet",
              ],
              [
                Layers,
                "等待链上确认",
                "校验网络、代币、地址与金额，达到确认数再结算。",
                "confirming → paid",
              ],
              [
                Webhook,
                "签名回调，自动履约",
                "把到账事件送达业务系统，失败可重试、可追溯。",
                "order.paid → fulfilled",
              ],
            ].map(([Icon, title, description, code], i) => (
              <article className="step-card" key={title}>
                <div>
                  <span className="step-icon">
                    <Icon size={22} />
                  </span>
                  <small>0{i + 1}</small>
                </div>
                <h3>{title}</h3>
                <p>{description}</p>
                <code>{code}</code>
              </article>
            ))}
          </div>
          <p className="section-footnote">
            平台只处理订单、交易回执和通知记录，不持有商户资产。
          </p>
        </section>
        <section className="chain-section" id="chains">
          <div className="section">
            <span className="section-kicker">一个工作台，多条网络</span>
            <h2>支持的链与币</h2>
            <p className="section-description">
              {chains.length ? `${chains.length} 条网络注册表 · ` : ""}
              实际可收款方式取决于节点、币种与报价配置
            </p>
            <div className="chain-grid">
              {chains.map((chain) => (
                <div key={chain.id}>
                  <ChainIcon chain={chain.id} size={38} />
                  <b>{chain.name || CHAIN_NAMES[chain.id] || chain.id}</b>
                  <small>
                    {(chain.tokens || [])
                      .map((token) => token.symbol)
                      .join(" · ")}
                  </small>
                </div>
              ))}
            </div>
            <div className="supported-assets">
              {ASSETS.map((asset) => (
                <span key={asset.symbol}>
                  <AssetIcon asset={asset} size={20} />
                  <b>{asset.symbol}</b>
                  <small>{asset.name}</small>
                </span>
              ))}
            </div>
            <p className="section-footnote">
              币种与网络需同时匹配。主流币按订单报价锁定金额；这里不展示实时行情。
            </p>
          </div>
        </section>
        <section className="section custody">
          <div>
            <span className="section-kicker">非托管设计</span>
            <h2>
              收款属于你，
              <br />
              控制权也属于你。
            </h2>
            <p>
              收款地址由商户管理，系统没有提币能力。每一次支付都可以追溯到链上回执。
            </p>
            <Link to="/docs" className="text-link">
              了解工作原理
              <ArrowRight size={15} />
            </Link>
          </div>
          <div className="comparison">
            <div className="comparison-row header">
              <span>收款环节</span>
              <span>托管式网关</span>
              <b>Avenora Pay</b>
            </div>
            {[
              ["资金去向", "平台账户", "商户自有钱包"],
              ["私钥管理", "由平台保管", "平台不接触"],
              ["到账后提现", "需再次申请", "无需提现"],
              ["核对依据", "平台内部余额", "链上回执与订单"],
            ].map((r) => (
              <div className="comparison-row" key={r[0]}>
                <b>{r[0]}</b>
                <span>{r[1]}</span>
                <span>
                  <Check size={15} />
                  {r[2]}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="developer-section">
          <div className="section developer-grid">
            <div>
              <span className="section-kicker">开发者</span>
              <h2>
                API 建单，
                <br />
                Webhook 履约。
              </h2>
              <p>
                兼容 DujiaoPay 的 HMAC 请求签名与事件格式，连接你已有的商城。
              </p>
              <Link to="/docs" className="text-link">
                阅读接入文档
                <ArrowRight size={15} />
              </Link>
            </div>
            <div className="code-card">
              <div>
                <span />
                <span />
                <span />
                <small>服务端建单与到账事件</small>
              </div>
              <pre>{`POST /v1/orders\nDJP-Key-ID: <your_key_id>\nDJP-Signature: <hmac_sha256>\nIdempotency-Key: order_10086\n\n{\n  "chain": "bsc",\n  "token_id": "bsc-usdt",\n  "fiat_amount": "9.90",\n  "fiat_currency": "USD"\n}\n\n// 签名回调 → 你的服务端\n{ "event_type": "order.paid" }`}</pre>
            </div>
          </div>
        </section>
        <section className="section faq-section">
          <span className="section-kicker">常见问题</span>
          <h2>接入之前，你可能想了解</h2>
          <div className="faq-list">
            {[
              [
                "Avenora Pay 是什么？",
                "Avenora Pay 是独立运行的非托管支付网关，支持主流加密货币与稳定币收款，连接订单、链上确认和自动发货。商户账户与资金由当前部署独立管理。",
              ],
              [
                "如何体验完整支付流程？",
                "进入演示工作台，创建一笔订单，查看收银台，再在订单详情中模拟链上确认。演示订单可验证通知与自动发货，不应实际转账。",
              ],
              [
                "需要提供钱包私钥吗？",
                "不需要。网关读取区块链公开交易，根据网络、币种、收款地址及精确金额识别付款。",
              ],
              [
                "实际收款需要配置什么？",
                "需要配置链上节点、收款币种、商户公开地址，以及真实环境域名。主流币还需要可用的报价源；只有实际启用且报价有效的方式能创建真实收款单。",
              ],
              [
                "到账后如何自动发货？",
                "订单达到确认要求后，系统生成签名事件。已有商城可以验证事件后发货；本地商品模块也能从库存中原子分配一份内容，防止重复发货。",
              ],
            ].map(([q, a]) => (
              <details key={q}>
                <summary>
                  {q}
                  <Plus size={17} />
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="cta-section">
          <span className="eyebrow-pill">
            <i />
            从一笔测试订单开始
          </span>
          <h2>把加密货币收款接到你的业务里。</h2>
          <p>创建项目、配置地址，让订单的每个环节都有记录。</p>
          <button
            className="button primary large"
            onClick={demo}
            disabled={demoBusy}
          >
            打开演示工作台
            <ArrowRight size={16} />
          </button>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}

function AuthPage({ register }) {
  const {
    refreshAuth,
    notify,
    demo,
    demoBusy,
    public_demo: publicDemo,
  } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [show, setShow] = useState(false),
    [otpRequired, setOtpRequired] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await mutate(
        register ? "/api/auth/register" : "/api/auth/login",
        Object.fromEntries(f),
      );
      await refreshAuth();
      go("/merchant/dashboard");
    } catch (e) {
      if (e.code === "TOTP_REQUIRED") setOtpRequired(true);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <Link to="/" className="auth-back">
        <ArrowDownLeft size={16} />
        返回首页
      </Link>
      <aside className="auth-aside">
        <Logo />
        <div>
          <span className="eyebrow-pill">非托管 · 多链支付</span>
          <h1>
            每一笔收款，
            <br />
            清晰可见。
          </h1>
          <p>
            让资金直达你的钱包，
            <br />
            让订单自动完成下一步。
          </p>
          <div className="auth-illustration">
            <span>
              <Wallet size={30} />
            </span>
            <i />
            <span>
              <ShieldCheck size={30} />
            </span>
            <i />
            <span>
              <Package size={30} />
            </span>
          </div>
        </div>
        <small>Avenora Pay · 安全连接你的收款业务</small>
      </aside>
      <main className="auth-main">
        <div className="auth-form">
          <div className="auth-mobile-logo">
            <Logo />
          </div>
          {publicDemo ? (
            <>
              <span className="auth-symbol">
                <Sparkles size={23} />
              </span>
              <h2>无需注册，直接体验</h2>
              <p>
                为你准备独立的演示空间，体验多币收款、订阅和自动发货。所有付款均为模拟。
              </p>
              <button
                className="button primary full"
                onClick={demo}
                disabled={demoBusy}
              >
                {demoBusy ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <ArrowRight size={17} />
                )}
                {demoBusy ? "正在准备…" : "进入演示工作台"}
              </button>
              <p className="auth-footnote">
                <ShieldCheck size={13} />
                公开演示不开放真实账户注册，请勿输入真实资料或转账。
              </p>
            </>
          ) : (
            <>
              <span className="auth-symbol">
                <LockKeyhole size={23} />
              </span>
              <h2>{register ? "创建商户账户" : "欢迎回来"}</h2>
              <p>
                {register
                  ? "开始管理你的项目、收款与订单。"
                  : "登录商户后台，查看收款进展。"}
              </p>
              <form onSubmit={submit}>
                <InlineError error={error} />
                {register && (
                  <Field label="商户名称">
                    <input
                      name="name"
                      required
                      maxLength={80}
                      autoComplete="organization"
                      placeholder="你的商户名称"
                    />
                  </Field>
                )}
                <Field label="邮箱地址">
                  <input
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </Field>
                <Field
                  label="密码"
                  help={
                    register ? "使用至少 12 位字符，建议包含字母与数字。" : null
                  }
                >
                  <div className="password-field">
                    <input
                      name="password"
                      type={show ? "text" : "password"}
                      required
                      minLength={register ? 12 : 1}
                      autoComplete={
                        register ? "new-password" : "current-password"
                      }
                      placeholder={register ? "设置登录密码" : "输入密码"}
                    />
                    <button
                      type="button"
                      onClick={() => setShow(!show)}
                      aria-label={show ? "隐藏密码" : "显示密码"}
                    >
                      {show ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </Field>
                {otpRequired && (
                  <Field label="两步验证码或恢复码">
                    <input
                      name="otp"
                      required
                      autoComplete="one-time-code"
                      placeholder="输入验证器中的验证码"
                    />
                  </Field>
                )}
                <button className="button primary full" disabled={busy}>
                  {busy ? <LoaderCircle size={17} className="spin" /> : null}
                  {register ? "创建账户" : "登录"}
                  <ArrowRight size={16} />
                </button>
              </form>
              <p className="auth-switch">
                {register ? "已有账户？" : "还没有账户？"}
                <Link to={register ? "/merchant/login" : "/merchant/register"}>
                  {register ? "立即登录" : "创建商户账户"}
                </Link>
              </p>
              <div className="or-divider">
                <span>或者先了解产品</span>
              </div>
              <button
                className="button secondary full"
                onClick={demo}
                disabled={demoBusy}
              >
                <Sparkles size={16} />
                进入独立演示空间
              </button>
              <p className="auth-footnote">
                <ShieldCheck size={13} />
                演示空间不处理真实付款
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function MerchantShell({ page }) {
  const { user, loading, mode, refreshAuth, notify, isAdmin, activeProjectId } =
    useApp();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!loading && !user) go("/merchant/login");
  }, [loading, user]);
  useEffect(() => setOpen(false), [page]);
  if (loading || !user) return <Spinner />;
  const Page =
    {
      dashboard: Dashboard,
      projects: Projects,
      orders: Orders,
      addresses: Addresses,
      keys: Keys,
      webhooks: Webhooks,
      transactions: Transactions,
      products: Products,
      settings: AccountSettings,
      "payment-links": PaymentLinks,
      refunds: Refunds,
      "project-settings": ProjectSettings,
      usage: Usage,
      billing: Billing,
      "platform-plans": PlatformPlans,
      "platform-merchants": PlatformMerchants,
      "platform-invoices": PlatformInvoices,
    }[page] || Dashboard;
  return (
    <div className="merchant-layout">
      {open && <div className="sidebar-shade" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-brand">
          <Logo />
          <button
            className="mobile-menu icon-button"
            onClick={() => setOpen(false)}
            aria-label="关闭导航"
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace-switch">
          <span className="workspace-avatar">
            {(user.name || user.email || "M")[0].toUpperCase()}
          </span>
          <div>
            <b>{user.name || "我的商户"}</b>
            <small>{mode === "demo" ? "演示工作空间" : "商户工作空间"}</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <nav className="sidebar-nav">
          {NAV_GROUPS.map(([group, items], i) => (
            <div key={group || i}>
              {group && <div className="nav-group-label">{group}</div>}
              {items.map(([id, Icon]) => (
                <Link
                  key={id}
                  to={`/merchant/${id}`}
                  className={page === id ? "active" : ""}
                >
                  <Icon size={18} />
                  <span>{TITLES[id]}</span>
                  {page === id && <i />}
                </Link>
              ))}
            </div>
          ))}
          {isAdmin && (
            <div>
              <div className="nav-group-label">平台管理</div>
              {[
                ["platform-plans", "套餐管理", Layers],
                ["platform-merchants", "商户管理", UserRound],
                ["platform-invoices", "订阅账单", FileText],
              ].map(([id, title, Icon]) => (
                <Link
                  key={id}
                  to={`/merchant/${id}`}
                  className={page === id ? "active" : ""}
                >
                  <Icon size={18} />
                  <span>{title}</span>
                </Link>
              ))}
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <span>
              <BookOpen size={17} />
              接入指南
            </span>
            <p>几步连接你的商城</p>
            <Link to="/docs">
              查看文档
              <ArrowUpRight size={14} />
            </Link>
          </div>
          <button
            className="account-row"
            onClick={async () => {
              try {
                await mutate("/api/auth/logout");
                await refreshAuth();
                go("/merchant/login");
              } catch (e) {
                notify(e.message, "error");
              }
            }}
          >
            <span className="account-avatar">{(user.name || "M")[0]}</span>
            <div>
              <b>{user.name || "商户"}</b>
              <small>{user.email}</small>
            </div>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="merchant-main">
        <header className="merchant-header">
          <div>
            <button
              className="icon-button mobile-menu"
              onClick={() => setOpen(true)}
              aria-label="打开导航"
            >
              <Menu size={21} />
            </button>
            <span className="header-workspace">工作空间</span>
            <ChevronRight size={14} />
            <b>{TITLES[page] || "总览"}</b>
          </div>
          <div>
            <HeaderProjects />
            <span
              className={`environment-pill ${mode === "demo" ? "demo" : ""}`}
            >
              <i />
              {mode === "demo" ? "演示环境" : "真实环境"}
            </span>
            <Link to="/docs" className="icon-button" title="文档">
              <CircleHelp size={18} />
            </Link>
            <Link to="/merchant/settings" className="header-avatar">
              {(user.name || "M")[0]}
            </Link>
          </div>
        </header>
        <main className="page-content">
          {mode === "demo" && (
            <div className="demo-banner">
              <Sparkles size={16} />
              <span>
                你正在体验演示环境。订单和链上交易均为模拟数据，请勿实际转账。
              </span>
              <Link to="/docs#deployment">
                部署说明
                <ArrowUpRight size={13} />
              </Link>
            </div>
          )}
          <Page key={activeProjectId || "all"} />
        </main>
        <footer className="workspace-footer">
          <span>Avenora Pay · 非托管收款</span>
          <span>
            <ShieldCheck size={13} />
            资金直达商户钱包
          </span>
        </footer>
      </div>
    </div>
  );
}
function PageHeading({ title, description, children }) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}
function OrderTable({ orders = [], onSelect, compact = false }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>订单</th>
            <th>金额</th>
            <th>支付网络</th>
            <th>状态</th>
            {!compact && <th>项目</th>}
            <th>创建时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.order_id || o.id}>
              <td>
                <button
                  className="table-order-id"
                  onClick={() => onSelect?.(o)}
                >
                  {o.merchant_order_id || clip(o.order_id || o.id, 7)}
                </button>
                <small className="cell-sub">
                  {clip(o.order_id || o.id, 9)}
                </small>
              </td>
              <td>
                <b className="money">
                  <Money value={o.fiat_amount} currency={o.fiat_currency} />
                </b>
                <small className="cell-sub">
                  {o.payable_amount
                    ? `${displayAmount(o.payable_amount)} ${tokenSymbol(o)}`
                    : "待选择支付方式"}
                </small>
              </td>
              <td>
                {o.chain ? (
                  <span className="chain-cell">
                    <ChainIcon chain={o.chain} size={20} />
                    {CHAIN_NAMES[o.chain] || o.chain}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td>
                <Badge status={o.status} />
              </td>
              {!compact && <td>{o.project_name || clip(o.project_id, 5)}</td>}
              <td className="muted nowrap">{date(o.created_at)}</td>
              <td>
                <button
                  className="icon-button"
                  onClick={() => onSelect?.(o)}
                  aria-label="查看订单"
                >
                  <ChevronRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Dashboard() {
  const { data, loading, error, reload } = useLoad(() => api("/api/dashboard"));
  const [create, setCreate] = useState(false),
    [detail, setDetail] = useState(null);
  const stats = data?.stats || {},
    chart = data?.chart || [];
  const total = stats.total_orders;
  const paid = Number(stats.paid_orders || 0);
  const pending = Number(stats.pending_orders || 0);
  const remainder =
    typeof total === "number" ? Math.max(0, total - paid - pending) : 0;
  const sum = Number(total) || paid + pending + remainder || 1;
  function Trend({ field = "amount", currency = false }) {
    const values = chart.map((x) => Number(x[field]) || 0),
      max = Math.max(1, ...values);
    const points = values.map(
      (v, i) =>
        `${(i / (chart.length - 1 || 1)) * 680 + 4},${180 - (v / max) * 140}`,
    );
    if (field === "orders" && !chart.some((x) => x.orders !== undefined))
      return (
        <div className="chart-empty-note">当前接口暂未返回每日订单数量</div>
      );
    return (
      <div className="chart-wrap">
        <div className="chart-y">
          <span>
            {currency ? "$" : ""}
            {max.toFixed(0)}
          </span>
          <span>
            {currency ? "$" : ""}
            {Math.floor(max / 2)}
          </span>
          <span>{currency ? "$" : ""}0</span>
        </div>
        <div className="chart-content">
          <svg
            viewBox="0 0 688 200"
            preserveAspectRatio="none"
            role="img"
            aria-label={
              currency ? "最近七日到账金额趋势" : "最近七日订单数量趋势"
            }
          >
            <defs>
              <linearGradient id={`fill-${field}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7764f1" stopOpacity=".18" />
                <stop offset="100%" stopColor="#7764f1" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[40, 110, 180].map((y) => (
              <line
                key={y}
                x1="0"
                y1={y}
                x2="688"
                y2={y}
                stroke="#edf0f5"
                strokeDasharray="4 4"
              />
            ))}
            {points.length > 0 && (
              <>
                <polygon
                  points={`4,180 ${points.join(" ")} 684,180`}
                  fill={`url(#fill-${field})`}
                />
                <polyline
                  points={points.join(" ")}
                  stroke="#6952e4"
                  strokeWidth="2.5"
                  fill="none"
                  strokeLinejoin="round"
                />
                {values.map((v, i) => (
                  <circle
                    key={i}
                    cx={(i / (chart.length - 1 || 1)) * 680 + 4}
                    cy={180 - (v / max) * 140}
                    r="3"
                    fill="white"
                    stroke="#6952e4"
                    strokeWidth="1.7"
                  >
                    <title>
                      {chart[i].date}: {currency ? "$" : ""}
                      {v}
                    </title>
                  </circle>
                ))}
              </>
            )}
          </svg>
          <div className="chart-labels">
            {chart.map((p, i) => (
              <span key={i}>{p.date?.slice(5)}</span>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <>
      <PageHeading
        title="概览"
        description="查看当前工作空间的收款数据与订单变化。"
      >
        <span className="period-pill">最近 7 天</span>
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          刷新
        </button>
        <button className="button primary" onClick={() => setCreate(true)}>
          <Plus size={16} />
          创建订单
        </button>
      </PageHeading>
      {error ? (
        <ResourceError error={error} onRetry={reload} />
      ) : loading ? (
        <Spinner />
      ) : (
        <>
          <section className="summary-volume">
            <div>
              <small>
                <Wallet size={15} />
                累计收款
              </small>
              <strong>
                <Money
                  value={stats.total_volume}
                  currency={stats.currency || "USD"}
                />
                <span className="currency-label">
                  {stats.currency || "USD"}
                </span>
              </strong>
              <p>
                按计价法币分别统计 · 当前展示 {stats.currency || "USD"}{" "}
                已支付订单
              </p>
            </div>
            <span>已确认到账</span>
          </section>
          <div className="stats-grid">
            {[
              [CreditCard, "订单数", total ?? "—", "当前商户全部订单"],
              [CheckCircle2, "已支付", paid, "完成链上确认"],
              [Clock3, "待支付", pending, "待付款与确认中的订单"],
              [
                Activity,
                "转化率",
                `${Number(stats.success_rate || 0).toFixed(1)}%`,
                "已支付 / 全部订单",
              ],
            ].map(([Icon, label, value, sub]) => (
              <article className="stat-card" key={label}>
                <div>
                  <span>{label}</span>
                  <Icon size={19} />
                </div>
                <strong>{value}</strong>
                <small>{sub}</small>
              </article>
            ))}
          </div>
          <div className="unmatched-summary">
            <TriangleAlert size={20} />
            <div>
              <b>
                未匹配转账
                {stats.unmatched_count !== undefined
                  ? ` · ${stats.unmatched_count} 笔`
                  : ""}
              </b>
              <p>核对尚未关联订单的链上付款。</p>
            </div>
            <Link to="/merchant/transactions">
              查看详情
              <ArrowRight size={14} />
            </Link>
          </div>
          <div className="dashboard-charts original-charts">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>订单趋势</h2>
                  <p>最近 7 天每日创建的订单</p>
                </div>
                <CreditCard size={17} />
              </div>
              <Trend field="orders" />
            </section>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>订单状态分布</h2>
                  <p>当前商户全部订单</p>
                </div>
              </div>
              <div className="status-chart">
                <div
                  className="donut-chart"
                  style={{
                    background: `conic-gradient(#8b74e8 0% ${(paid / sum) * 100}%,#ceb9eb ${(paid / sum) * 100}% ${((paid + pending) / sum) * 100}%,#e9e5f1 ${((paid + pending) / sum) * 100}% 100%)`,
                  }}
                >
                  <div>
                    <strong>{total ?? "—"}</strong>
                    <small>订单总数</small>
                  </div>
                </div>
                <ul>
                  {[
                    ["已支付", paid, "#8b74e8"],
                    ["待支付", pending, "#ceb9eb"],
                    ["其他", remainder, "#e9e5f1"],
                  ].map(([label, value, color]) => (
                    <li key={label}>
                      <i style={{ background: color }} />
                      {label}
                      <b>{value}</b>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          </div>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>到账金额趋势</h2>
                <p>最近 7 天 · USD 已支付订单金额</p>
              </div>
              <span className="period-pill">USD</span>
            </div>
            <Trend currency />
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>最近订单</h2>
                <p>最新创建的收款订单</p>
              </div>
              <Link to="/merchant/orders" className="text-link">
                查看全部
                <ArrowRight size={14} />
              </Link>
            </div>
            {data.recent_orders?.length ? (
              <OrderTable
                orders={data.recent_orders}
                onSelect={setDetail}
                compact
              />
            ) : (
              <Empty
                title="创建第一笔订单"
                description="配置项目和收款方式后，就可以开始测试收款。"
                action={
                  <button
                    className="button primary"
                    onClick={() => setCreate(true)}
                  >
                    创建订单
                  </button>
                }
              />
            )}
          </section>
        </>
      )}
      {create && (
        <CreateOrder
          onClose={() => setCreate(false)}
          onDone={(o) => {
            setCreate(false);
            reload();
            setDetail(o);
          }}
        />
      )}
      {detail && (
        <OrderDetail
          order={detail}
          onClose={() => setDetail(null)}
          onUpdate={reload}
        />
      )}
    </>
  );
}

function CreateOrder({ onClose, onDone, product }) {
  const { registry, activeProjectId } = useApp();
  const {
    data,
    loading,
    error: loadError,
  } = useLoad(async () => {
    const [p, s] = await Promise.all([
      api("/api/projects"),
      api("/api/products"),
    ]);
    return { ...p, ...s };
  });
  const [project, setProject] = useState(
      product?.project_id || activeProjectId || "",
    ),
    [chain, setChain] = useState("bsc"),
    [token, setToken] = useState("bsc-usdt"),
    [amount, setAmount] = useState(product?.price || "9.90"),
    [currency, setCurrency] = useState(product?.currency || "USD"),
    [selectedProduct, setSelectedProduct] = useState(product?.id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!project && data?.projects?.length) setProject(data.projects[0].id);
  }, [data]);
  const chains = registry.chains || [];
  const activeChain = chains.find((c) => c.id === chain);
  const products = (data?.products || []).filter(
    (p) => p.project_id === project,
  );
  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      const r = await mutate("/api/orders", {
        project_id: project,
        fiat_amount: String(amount),
        fiat_currency: currency,
        ...(chain ? { chain, token_id: token } : {}),
        ...(f.get("merchant_order_id")
          ? { merchant_order_id: f.get("merchant_order_id") }
          : {}),
        ...(selectedProduct ? { product_id: selectedProduct } : {}),
      });
      onDone(r.order || r);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="创建收款订单"
      description="为订单分配收款地址与精确应付金额。"
      onClose={onClose}
    >
      {loading ? (
        <Spinner />
      ) : (
        <form onSubmit={submit}>
          <InlineError error={error || loadError} />
          <Field label="所属项目">
            <ProjectSelect
              projects={data?.projects || []}
              value={project}
              onChange={(v) => {
                setProject(v);
                setSelectedProduct("");
              }}
            />
          </Field>
          {!data?.projects?.length && (
            <p className="field-hint">请先在项目管理中创建项目。</p>
          )}
          <Field label="关联商品（可选）">
            <select
              value={selectedProduct}
              onChange={(e) => {
                setSelectedProduct(e.target.value);
                const p = products.find((x) => x.id === e.target.value);
                if (p) {
                  setAmount(String(p.price));
                  setCurrency(p.currency);
                }
              }}
            >
              <option value="">仅收款，不关联商品</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · 库存 {p.stock}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-row">
            <Field label="订单金额">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                inputMode="decimal"
                pattern="[0-9]+(\.[0-9]{1,8})?"
                placeholder="9.90"
                readOnly={Boolean(selectedProduct)}
              />
            </Field>
            <Field label="计价币种">
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                disabled={Boolean(selectedProduct)}
              >
                {(registry.currencies?.length
                  ? registry.currencies
                  : ["USD"]
                ).map((c) => (
                  <option
                    key={typeof c === "string" ? c : c.code}
                    value={typeof c === "string" ? c : c.code}
                  >
                    {typeof c === "string" ? c : c.code}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="支付网络">
              <select
                value={chain}
                onChange={(e) => {
                  setChain(e.target.value);
                  setToken(
                    chains.find((c) => c.id === e.target.value)?.tokens?.[0]
                      ?.id || "",
                  );
                }}
              >
                <option value="">由付款人选择</option>
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || CHAIN_NAMES[c.id]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="收款币种">
              <select
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={!chain}
              >
                {(activeChain?.tokens || []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {token === "bitcoin-btc" && chain === "bitcoin" && (
            <p className="field-hint">
              BTC 使用 Bitcoin 主网，订单至少 546 satoshi（0.00000546
              BTC）。选定后锁价，付款需在 20 分钟窗口内入区块，随后等待 6
              次确认。
            </p>
          )}
          <Field
            label="商户订单号（可选）"
            help="留空则由系统生成。相同项目内需保持唯一。"
          >
            <input
              name="merchant_order_id"
              maxLength={128}
              placeholder="例如 SHOP-20261102-001"
            />
          </Field>
          <FormFooter busy={busy} onClose={onClose} text="创建订单" />
        </form>
      )}
    </Modal>
  );
}
function OrderDetail({ order: initial, onClose, onUpdate }) {
  const { mode, notify } = useApp();
  const [order, setOrder] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refund, setRefund] = useState(false);
  const id = order.order_id || order.id;
  async function action(name, body = {}) {
    setBusy(true);
    setError("");
    try {
      const r = await mutate(
        `/api/orders/${encodeURIComponent(id)}/${name}`,
        body,
      );
      if (r.order || r.order_id) setOrder(r.order || r);
      else {
        const l = await api("/api/orders");
        setOrder(l.orders?.find((o) => (o.order_id || o.id) === id) || order);
      }
      onUpdate?.();
      notify(name === "simulate" ? "演示交易已处理" : "订单已取消");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const demo = order.mode === "demo" || mode === "demo";
  return (
    <Modal title="订单详情" description={id} onClose={onClose} wide>
      <InlineError error={error} />
      <div className="order-detail-top">
        <div>
          <small>订单金额</small>
          <strong>
            <Money value={order.fiat_amount} currency={order.fiat_currency} />
          </strong>
        </div>
        <Badge status={order.status} />
      </div>
      <div className="detail-grid">
        {[
          ["商户订单号", order.merchant_order_id],
          ["所属项目", order.project_name || order.project_id],
          ["支付网络", CHAIN_NAMES[order.chain] || order.chain || "待选择"],
          [
            "应付金额",
            order.payable_amount
              ? `${displayAmount(order.payable_amount)} ${tokenSymbol(order)}`
              : "待选择",
          ],
          ["收款地址", order.pay_address],
          ["创建时间", date(order.created_at)],
          [
            "确认进度",
            `${order.confirmations || 0} / ${order.required_confirmations || "—"}`,
          ],
          ["交易哈希", order.tx_hash],
        ].map(([label, val]) => (
          <div key={label}>
            <small>{label}</small>
            <span title={String(val || "")}>
              {val || "—"}
              {["收款地址", "交易哈希"].includes(label) && val && (
                <CopyButton value={val} />
              )}
            </span>
          </div>
        ))}
      </div>
      <PriceSnapshot order={order} />
      {order.status === "paid" && order.delivery && (
        <div className="delivery-box">
          <h3>
            <Package size={18} />
            已自动发货
          </h3>
          <pre>
            {typeof order.delivery === "string"
              ? order.delivery
              : order.delivery.content ||
                order.delivery.item ||
                JSON.stringify(order.delivery, null, 2)}
          </pre>
          <CopyButton
            value={
              typeof order.delivery === "string"
                ? order.delivery
                : order.delivery.content || order.delivery.item || ""
            }
            label="复制发货内容"
          />
        </div>
      )}
      <div className="order-timeline">
        <span className="done">
          <CheckCircle2 size={17} />
          创建订单
        </span>
        <i />
        <span
          className={
            ["confirming", "paid"].includes(order.status) ? "done" : ""
          }
        >
          <Radio size={17} />
          识别转账
        </span>
        <i />
        <span className={order.status === "paid" ? "done" : ""}>
          <ShieldCheck size={17} />
          确认到账
        </span>
        <i />
        <span className={order.delivery ? "done" : ""}>
          <Package size={17} />
          业务履约
        </span>
      </div>
      <div className="order-actions">
        {order.status === "paid" && (
          <button className="button secondary" onClick={() => setRefund(true)}>
            <ArrowDownLeft size={15} />
            记录退款
          </button>
        )}
        {order.checkout_url || order.checkout_token ? (
          <Link className="button primary" to={checkoutPath(order)}>
            <ExternalLink size={15} />
            打开收银台
          </Link>
        ) : null}
        {demo && ["pending", "confirming"].includes(order.status) && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              action("simulate", {
                confirmations: order.required_confirmations || 20,
              })
            }
          >
            <Zap size={15} />
            模拟确认到账
          </button>
        )}
        {demo && order.status === "pending" && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => action("simulate", { confirmations: 1 })}
          >
            模拟 1 次确认
          </button>
        )}
        {order.status === "pending" && (
          <button
            className="button danger-soft"
            disabled={busy}
            onClick={() => action("cancel")}
          >
            取消订单
          </button>
        )}
      </div>
      {demo && (
        <p className="field-hint">
          模拟操作仅影响当前演示订单，不代表真实链上付款。
        </p>
      )}
      {refund && <RefundForm order={order} onClose={() => setRefund(false)} />}
    </Modal>
  );
}
function Orders() {
  const { notify } = useApp();
  const [status, setStatus] = useState(""),
    [query, setQuery] = useState(""),
    [create, setCreate] = useState(false),
    [detail, setDetail] = useState(null);
  const { data, loading, error, reload } = useLoad(
    () =>
      api(
        `/api/orders?status=${encodeURIComponent(status)}&q=${encodeURIComponent(query)}`,
      ),
    [status, query],
  );
  return (
    <>
      <PageHeading title="订单" description="跟踪每笔收款，从创建到确认完成。">
        <button
          className="button secondary"
          disabled={loading || !data?.orders?.length}
          title="仅导出当前筛选已加载的记录，不包含未加载数据"
          onClick={() => {
            const rows = data.orders;
            downloadCsv(
              `订单-当前筛选-${new Date().toLocaleDateString("sv-SE")}.csv`,
              [
                "订单ID",
                "商户订单号",
                "项目",
                "计价金额",
                "计价币种",
                "网络",
                "代币",
                "应付金额",
                "状态",
                "交易哈希",
                "创建时间",
              ],
              rows.map((o) => [
                o.order_id,
                o.merchant_order_id,
                o.project_name || o.project_id,
                o.fiat_amount,
                o.fiat_currency,
                o.chain,
                o.token_id,
                o.payable_amount,
                o.status,
                o.tx_hash,
                o.created_at,
              ]),
            );
            notify(`已导出当前加载的 ${rows.length} 笔订单`);
          }}
        >
          <FileText size={15} />
          导出当前筛选 CSV
        </button>
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          刷新
        </button>
        <button className="button primary" onClick={() => setCreate(true)}>
          <Plus size={16} />
          创建订单
        </button>
      </PageHeading>
      <section className="panel">
        <div className="list-toolbar">
          <div className="tabs">
            {[
              ["", "全部订单"],
              ["pending", "待付款"],
              ["confirming", "确认中"],
              ["paid", "已支付"],
              ["expired", "已过期"],
              ["canceled", "已取消"],
            ].map(([v, l]) => (
              <button
                key={v}
                className={status === v ? "active" : ""}
                onClick={() => setStatus(v)}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="搜索订单"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索订单号"
            />
          </div>
        </div>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : data?.orders?.length ? (
          <>
            <OrderTable orders={data.orders} onSelect={setDetail} />
            <div className="table-footer">
              共 {data.total ?? data.orders.length} 笔订单
              <span>
                按创建时间倒序 · 导出仅含当前加载的 {data.orders.length} 条记录
              </span>
            </div>
          </>
        ) : (
          <Empty
            icon={CreditCard}
            title={query ? "没有找到匹配订单" : "暂无订单"}
            description={
              query
                ? "试试其他订单号或切换状态筛选。"
                : "创建订单后，你可以在这里查看收款进展。"
            }
          />
        )}
      </section>
      {create && (
        <CreateOrder
          onClose={() => setCreate(false)}
          onDone={(o) => {
            setCreate(false);
            setDetail(o);
            reload();
          }}
        />
      )}
      {detail && (
        <OrderDetail
          order={detail}
          onClose={() => setDetail(null)}
          onUpdate={reload}
        />
      )}
    </>
  );
}

function Projects() {
  const { notify } = useApp();
  const { data, loading, error, reload } = useLoad(() => api("/api/projects"));
  const [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const f = Object.fromEntries(new FormData(e.currentTarget));
      await mutate(
        editing.id ? `/api/projects/${editing.id}` : "/api/projects",
        f,
        editing.id ? "PATCH" : "POST",
      );
      setEditing(null);
      notify(editing.id ? "项目已更新" : "项目已创建");
      reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="项目管理"
        description="用项目隔离不同业务的收款地址、API 密钥和订单。"
      >
        <button
          className="button primary"
          onClick={() => {
            setEditing({});
            setFormError("");
          }}
        >
          <Plus size={16} />
          创建项目
        </button>
      </PageHeading>
      {loading ? (
        <Spinner />
      ) : error ? (
        <ResourceError error={error} onRetry={reload} />
      ) : data?.projects?.length ? (
        <div className="project-grid">
          {data.projects.map((p) => (
            <article className="project-card" key={p.id}>
              <div className="project-card-top">
                <span className="project-symbol">
                  <FolderKanban size={24} />
                </span>
                <button
                  className="icon-button"
                  onClick={() => {
                    setEditing(p);
                    setFormError("");
                  }}
                  aria-label={`编辑 ${p.name}`}
                >
                  <MoreHorizontal size={20} />
                </button>
              </div>
              <h2>{p.name}</h2>
              <p>{p.description || "暂无项目描述"}</p>
              <div className="project-id">
                <code>{p.id}</code>
                <CopyButton value={p.id} />
              </div>
              <div className="project-meta">
                <span>
                  <Clock3 size={13} />
                  {date(p.created_at)}
                </span>
                <Badge status="paid">已启用</Badge>
              </div>
              <div className="project-card-actions">
                <Link to="/merchant/addresses">
                  收款地址
                  <ChevronRight size={14} />
                </Link>
                <Link to="/merchant/keys">
                  API Keys
                  <ChevronRight size={14} />
                </Link>
              </div>
            </article>
          ))}
          <button className="new-project-tile" onClick={() => setEditing({})}>
            <span>
              <Plus size={24} />
            </span>
            <b>创建新项目</b>
            <p>连接一个新的业务</p>
          </button>
        </div>
      ) : (
        <section className="panel">
          <Empty
            icon={FolderKanban}
            title="创建你的第一个项目"
            description="每个项目都有独立的收款与集成配置。"
            action={
              <button className="button primary" onClick={() => setEditing({})}>
                创建项目
              </button>
            }
          />
        </section>
      )}
      {editing && (
        <Modal
          title={editing.id ? "编辑项目" : "创建项目"}
          description="项目名称会用于识别你的业务。"
          onClose={() => setEditing(null)}
        >
          <form onSubmit={submit}>
            <InlineError error={formError} />
            <Field label="项目名称">
              <input
                name="name"
                defaultValue={editing.name || ""}
                required
                maxLength={80}
                placeholder="例如：我的数字商品店"
              />
            </Field>
            <Field label="项目描述">
              <textarea
                name="description"
                defaultValue={editing.description || ""}
                rows={3}
                maxLength={300}
                placeholder="这个项目用来做什么？"
              />
            </Field>
            <FormFooter
              busy={busy}
              onClose={() => setEditing(null)}
              text={editing.id ? "保存修改" : "创建项目"}
            />
          </form>
        </Modal>
      )}
      <div className="info-note">
        <Layers size={19} />
        <div>
          <b>一个项目，对应一条清晰的业务链路</b>
          <p>
            同一商户可以创建多个项目，分别配置 API Key
            与回调地址。订单数据按项目隔离。
          </p>
        </div>
      </div>
    </>
  );
}

function Addresses() {
  const { registry, mode, notify } = useApp();
  const { data, loading, error, reload } = useLoad(async () => {
    const [a, p] = await Promise.all([
      api("/api/addresses"),
      api("/api/projects"),
    ]);
    return { ...a, ...p };
  });
  const [adding, setAdding] = useState(false),
    [project, setProject] = useState(""),
    [chain, setChain] = useState("bsc"),
    [selectedTokens, setSelectedTokens] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const f = Object.fromEntries(new FormData(e.currentTarget));
      const tokenIds =
        selectedTokens ??
        (registry.chains.find((c) => c.id === chain)?.tokens || []).map(
          (t) => t.id,
        );
      if (!tokenIds.length) throw new Error("请选择至少一种收款币种。");
      await mutate("/api/addresses", {
        ...f,
        project_id: project,
        chain,
        token_ids: tokenIds,
      });
      setAdding(false);
      notify("收款地址已添加");
      reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(a) {
    try {
      await mutate(`/api/addresses/${a.id}`, { enabled: !a.enabled }, "PATCH");
      notify(a.enabled ? "地址已停用" : "地址已启用");
      reload();
    } catch (e) {
      notify(e.message, "error");
    }
  }
  const chains = registry.chains || [];
  return (
    <>
      <PageHeading
        title="收款地址"
        description="客户付款直接转入这里配置的钱包地址。"
      >
        <button
          className="button primary"
          onClick={() => {
            setAdding(true);
            setProject(data?.projects?.[0]?.id || "");
            setSelectedTokens(null);
            setFormError("");
          }}
        >
          <Plus size={16} />
          添加地址
        </button>
      </PageHeading>
      <div className="info-note compact">
        <ShieldCheck size={19} />
        <p>仅添加公开收款地址。平台不需要钱包私钥或助记词。</p>
      </div>
      <section className="panel">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : data?.addresses?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>网络 / 标签</th>
                  <th>钱包地址</th>
                  <th>接收币种</th>
                  <th>所属项目</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.addresses.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className="chain-cell">
                        <ChainIcon chain={a.chain} size={27} />
                        <span>
                          <b>{CHAIN_NAMES[a.chain] || a.chain}</b>
                          <small className="cell-sub">
                            {a.label || "收款地址"}
                          </small>
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="address-code">
                        <code title={a.address}>{clip(a.address, 13)}</code>
                        <CopyButton value={a.address} />
                      </span>
                    </td>
                    <td>
                      <span className="address-assets">
                        {(a.token_ids || [])
                          .map((id) => tokenSymbol({ token_id: id }))
                          .join(" · ") || "—"}
                      </span>
                    </td>
                    <td>
                      {a.project_name ||
                        data.projects?.find((p) => p.id === a.project_id)
                          ?.name ||
                        clip(a.project_id, 6)}
                    </td>
                    <td>
                      <Badge status={a.enabled ? "paid" : "expired"}>
                        {a.enabled ? "启用中" : "已停用"}
                      </Badge>
                    </td>
                    <td>
                      <button className="table-link" onClick={() => toggle(a)}>
                        {a.enabled ? "停用" : "启用"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={Wallet}
            title="添加第一个收款地址"
            description="地址启用后，项目才能分配对应网络的收款订单。"
          />
        )}
      </section>
      <section className="panel network-registry">
        <div className="panel-heading">
          <div>
            <h2>链配置状态</h2>
            <p>真实收款还需要服务器配置相应节点与代币。</p>
          </div>
        </div>
        <div className="registry-grid">
          {chains.map((c) => (
            <div key={c.id}>
              <ChainIcon chain={c.id} size={29} />
              <div>
                <b>{c.name || CHAIN_NAMES[c.id]}</b>
                <small>{c.confirmations} 次确认</small>
              </div>
              <span className={c.configured ? "network-ready" : "network-off"}>
                <i />
                {mode === "demo" ? "演示" : c.configured ? "已配置" : "未配置"}
              </span>
            </div>
          ))}
        </div>
      </section>
      {adding && (
        <Modal
          title="添加收款地址"
          description={
            mode === "demo"
              ? "演示环境只接受以 demo: 开头的测试标记。"
              : "核对网络后，填写你的公开收款地址。"
          }
          onClose={() => setAdding(false)}
        >
          <form onSubmit={submit}>
            <InlineError error={formError} />
            <Field label="所属项目">
              <ProjectSelect
                projects={data?.projects || []}
                value={project}
                onChange={setProject}
              />
            </Field>
            <Field label="网络">
              <select
                value={chain}
                onChange={(e) => {
                  setChain(e.target.value);
                  setSelectedTokens(null);
                }}
              >
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || CHAIN_NAMES[c.id]}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="接收币种"
              help="只为选中的币种分配此地址；实际收款仍取决于服务器配置。"
            >
              <div className="token-checks">
                {(chains.find((c) => c.id === chain)?.tokens || []).map((t) => (
                  <label key={t.id}>
                    <input
                      type="checkbox"
                      checked={
                        selectedTokens === null || selectedTokens.includes(t.id)
                      }
                      onChange={(e) => {
                        const all = (
                          chains.find((c) => c.id === chain)?.tokens || []
                        ).map((token) => token.id);
                        const current = selectedTokens ?? all;
                        setSelectedTokens(
                          e.target.checked
                            ? [...current, t.id]
                            : current.filter((id) => id !== t.id),
                        );
                      }}
                    />
                    <b>{t.symbol}</b>
                    <small>{t.decimals} 位精度</small>
                  </label>
                ))}
              </div>
            </Field>
            <Field
              label={mode === "demo" ? "演示地址标记" : "钱包收款地址"}
              help={
                mode !== "demo" && chain === "bitcoin"
                  ? "Bitcoin 主网地址（1…、3… 或 bc1…），不支持测试网地址。"
                  : undefined
              }
            >
              <input
                name="address"
                required
                maxLength={200}
                placeholder={
                  mode === "demo"
                    ? "demo:my-wallet"
                    : chain === "bitcoin"
                      ? "输入你的 Bitcoin 主网收款地址"
                      : "输入该网络的收款地址"
                }
                spellCheck="false"
                autoComplete="off"
              />
            </Field>
            <Field label="地址标签（可选）">
              <input
                name="label"
                maxLength={80}
                placeholder="例如：商城主钱包"
              />
            </Field>
            <FormFooter
              busy={busy}
              onClose={() => setAdding(false)}
              text="添加地址"
            />
          </form>
        </Modal>
      )}
    </>
  );
}

function Keys() {
  const { notify } = useApp();
  const { data, loading, error, reload } = useLoad(async () => {
    const [k, p] = await Promise.all([api("/api/keys"), api("/api/projects")]);
    return { ...k, ...p };
  });
  const [adding, setAdding] = useState(false),
    [project, setProject] = useState(""),
    [secret, setSecret] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState(""),
    [revoke, setRevoke] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const name = new FormData(e.currentTarget).get("name");
      const r = await mutate("/api/keys", { project_id: project, name });
      setSecret(r);
      setAdding(false);
      reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="API Keys"
        description="为服务端请求创建项目级凭据，密钥仅在创建时显示。"
      >
        <button
          className="button primary"
          onClick={() => {
            setAdding(true);
            setProject(data?.projects?.[0]?.id || "");
            setFormError("");
          }}
        >
          <Plus size={16} />
          创建 API Key
        </button>
      </PageHeading>
      <div className="info-note compact">
        <KeyRound size={19} />
        <p>
          API Secret 只保存在你的服务端。不要放入网页、移动端应用或公开代码库。
        </p>
      </div>
      <section className="panel">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : data?.keys?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>名称 / Key ID</th>
                  <th>所属项目</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id || k.key_id}>
                    <td>
                      <b>{k.name || "API Key"}</b>
                      <small className="cell-sub">
                        <code>{clip(k.key_id || k.id, 12)}</code>
                        <CopyButton value={k.key_id || k.id} />
                      </small>
                    </td>
                    <td>
                      {data.projects?.find((p) => p.id === k.project_id)
                        ?.name || clip(k.project_id, 6)}
                    </td>
                    <td>
                      <Badge status={k.revoked ? "expired" : "paid"}>
                        {k.revoked ? "已撤销" : "有效"}
                      </Badge>
                    </td>
                    <td className="muted">{date(k.created_at)}</td>
                    <td>
                      {!k.revoked && (
                        <button
                          className="table-link danger-text"
                          onClick={() => setRevoke(k)}
                        >
                          撤销
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={KeyRound}
            title="创建项目的第一把 API Key"
            description="通过 HMAC 签名安全地创建与查询订单。"
          />
        )}
      </section>
      {adding && (
        <Modal title="创建 API Key" onClose={() => setAdding(false)}>
          <form onSubmit={submit}>
            <InlineError error={formError} />
            <Field label="所属项目">
              <ProjectSelect
                projects={data?.projects || []}
                value={project}
                onChange={setProject}
              />
            </Field>
            <Field label="密钥名称">
              <input
                name="name"
                required
                maxLength={80}
                placeholder="例如：商城服务端"
              />
            </Field>
            <FormFooter
              busy={busy}
              onClose={() => setAdding(false)}
              text="创建密钥"
            />
          </form>
        </Modal>
      )}
      {secret && (
        <Modal
          title="API Key 已创建"
          description="请现在妥善保存 Secret。关闭后无法再次查看。"
          onClose={() => setSecret(null)}
        >
          <div className="secret-box">
            <small>Key ID</small>
            <code>{secret.key_id}</code>
            <CopyButton value={secret.key_id} />
          </div>
          <div className="secret-box">
            <small>Secret · 仅显示一次</small>
            <code>{secret.secret}</code>
            <CopyButton value={secret.secret} />
          </div>
          <button
            className="button primary full"
            onClick={() => setSecret(null)}
          >
            我已保存
          </button>
        </Modal>
      )}
      {revoke && (
        <Modal
          title="撤销 API Key"
          description="使用这把密钥的服务将无法继续请求 API。可重新创建一把密钥恢复接入。"
          onClose={() => setRevoke(null)}
        >
          <p className="revoke-name">
            {revoke.name || revoke.key_prefix || revoke.key_id}
          </p>
          <div className="form-footer">
            <button
              className="button secondary"
              onClick={() => setRevoke(null)}
            >
              保留密钥
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await mutate(
                    `/api/keys/${revoke.id || revoke.key_id}`,
                    {},
                    "DELETE",
                  );
                  setRevoke(null);
                  notify("密钥已撤销");
                  reload();
                } catch (e) {
                  notify(e.message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认撤销
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Webhooks() {
  const { notify } = useApp();
  const { data, loading, error, reload } = useLoad(async () => {
    const [w, p] = await Promise.all([
      api("/api/webhooks"),
      api("/api/projects"),
    ]);
    return { ...w, ...p };
  });
  const [adding, setAdding] = useState(false),
    [project, setProject] = useState(""),
    [secret, setSecret] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState(""),
    [selected, setSelected] = useState(null),
    [testing, setTesting] = useState(false),
    [editingEndpoint, setEditingEndpoint] = useState(null),
    [rotating, setRotating] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const r = await mutate(
        editingEndpoint
          ? `/api/webhooks/${editingEndpoint.id}`
          : "/api/webhooks",
        { project_id: project, url: new FormData(e.currentTarget).get("url") },
        editingEndpoint ? "PATCH" : "POST",
      );
      setAdding(false);
      if (editingEndpoint) notify("接收端已更新");
      else setSecret(r);
      setEditingEndpoint(null);
      reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function test(e) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      await mutate("/api/webhooks/test", { project_id: project });
      setTesting(false);
      notify("测试事件已创建");
      reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Webhook 投递"
        description="查看事件的投递记录，定位失败并重新投递。"
      >
        <button
          className="button secondary"
          onClick={() => {
            setTesting(true);
            setProject(data?.projects?.[0]?.id || "");
            setFormError("");
          }}
        >
          <Send size={15} />
          测试事件
        </button>
        <button
          className="button primary"
          onClick={() => {
            setEditingEndpoint(null);
            setAdding(true);
            setProject(data?.projects?.[0]?.id || "");
            setFormError("");
          }}
        >
          <Plus size={16} />
          添加接收端
        </button>
      </PageHeading>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>接收端</h2>
            <p>事件发送到项目指定的服务端地址。</p>
          </div>
        </div>
        {loading ? (
          <Spinner />
        ) : data?.endpoints?.length ? (
          <div className="endpoint-list">
            {data.endpoints.map((w) => (
              <div key={w.id}>
                <span className="endpoint-icon">
                  <Webhook size={21} />
                </span>
                <div>
                  <b>{w.url}</b>
                  <p>
                    {data.projects?.find((p) => p.id === w.project_id)?.name ||
                      clip(w.project_id, 7)}
                  </p>
                </div>
                <Badge status={w.enabled === false ? "expired" : "paid"}>
                  {w.enabled === false ? "停用" : "已启用"}
                </Badge>
                <div className="endpoint-actions">
                  <button
                    className="table-link"
                    onClick={() => {
                      setEditingEndpoint(w);
                      setAdding(true);
                      setProject(w.project_id);
                      setFormError("");
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="table-link"
                    onClick={async () => {
                      try {
                        await mutate(
                          `/api/webhooks/${w.id}`,
                          { enabled: w.enabled === false },
                          "PATCH",
                        );
                        notify(
                          w.enabled === false ? "接收端已启用" : "接收端已停用",
                        );
                        reload();
                      } catch (e) {
                        notify(e.message, "error");
                      }
                    }}
                  >
                    {w.enabled === false ? "启用" : "停用"}
                  </button>
                  <button className="table-link" onClick={() => setRotating(w)}>
                    轮换密钥
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={Webhook}
            title="尚未配置接收端"
            description="添加 HTTPS 地址，接收经过签名的订单事件。"
          />
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>投递记录</h2>
            <p>失败的投递会按重试策略再次尝试。</p>
          </div>
          <button
            className="icon-button"
            onClick={reload}
            aria-label="刷新投递记录"
          >
            <RefreshCw size={17} />
          </button>
        </div>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : data?.deliveries?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>事件</th>
                  <th>状态</th>
                  <th>尝试次数</th>
                  <th>响应</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <button
                        className="table-order-id"
                        onClick={() => setSelected(w)}
                      >
                        {w.event_type || w.type || "事件"}
                      </button>
                      <small className="cell-sub">
                        {clip(w.event_id || w.id, 9)}
                      </small>
                    </td>
                    <td>
                      <Badge
                        status={
                          w.status === "pending" ? "delivery_pending" : w.status
                        }
                      />
                    </td>
                    <td>{w.attempts ?? w.attempt_count ?? 0}</td>
                    <td>
                      {w.response_status ||
                        w.last_status ||
                        w.last_status_code ||
                        "—"}
                    </td>
                    <td className="muted">{date(w.created_at)}</td>
                    <td>
                      {!["delivered", "success", "succeeded"].includes(
                        w.status,
                      ) && (
                        <button
                          className="table-link"
                          onClick={async () => {
                            try {
                              await mutate(`/api/webhooks/${w.id}/retry`);
                              notify("已安排重新投递");
                              reload();
                            } catch (e) {
                              notify(e.message, "error");
                            }
                          }}
                        >
                          重新投递
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={Webhook}
            title="暂无投递记录"
            description="创建订单或发送测试事件后，投递记录会显示在这里。"
          />
        )}
      </section>
      {adding && (
        <Modal
          title={
            editingEndpoint ? "编辑 Webhook 接收端" : "添加 Webhook 接收端"
          }
          description="平台会对原始消息体进行 HMAC 签名。"
          onClose={() => setAdding(false)}
        >
          <form onSubmit={submit}>
            <InlineError error={formError} />
            <Field label="所属项目">
              <ProjectSelect
                disabled={Boolean(editingEndpoint)}
                projects={data?.projects || []}
                value={project}
                onChange={setProject}
              />
            </Field>
            <Field label="接收地址">
              <input
                name="url"
                type="url"
                defaultValue={editingEndpoint?.url || ""}
                required
                placeholder="https://shop.example.com/api/payment/webhook"
              />
            </Field>
            <FormFooter
              busy={busy}
              onClose={() => setAdding(false)}
              text={editingEndpoint ? "保存修改" : "添加接收端"}
            />
          </form>
        </Modal>
      )}
      {testing && (
        <Modal
          title="发送测试事件"
          description="向指定项目的接收端发送 webhook.test 事件。"
          onClose={() => setTesting(false)}
        >
          <form onSubmit={test}>
            <InlineError error={formError} />
            <Field label="所属项目">
              <ProjectSelect
                projects={data?.projects || []}
                value={project}
                onChange={setProject}
              />
            </Field>
            <FormFooter
              busy={busy}
              onClose={() => setTesting(false)}
              text="发送测试"
            />
          </form>
        </Modal>
      )}
      {secret && (
        <Modal
          title="接收端已创建"
          description="请保存签名密钥，用于服务端验证收到的消息。"
          onClose={() => setSecret(null)}
        >
          <div className="secret-box">
            <small>Webhook Secret · 仅显示一次</small>
            <code>{secret.secret}</code>
            <CopyButton value={secret.secret} />
          </div>
          <button
            className="button primary full"
            onClick={() => setSecret(null)}
          >
            我已保存
          </button>
        </Modal>
      )}
      {rotating && (
        <Modal
          title="轮换 Webhook 签名密钥"
          description="轮换后，接收端需要使用新密钥验证后续消息。请同步更新你的业务服务配置。"
          onClose={() => setRotating(null)}
        >
          <div className="secret-box">
            <small>接收地址</small>
            <code>{rotating.url}</code>
          </div>
          <div className="form-footer">
            <button
              className="button secondary"
              onClick={() => setRotating(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await mutate(`/api/webhooks/${rotating.id}/rotate`);
                  setRotating(null);
                  setSecret(r);
                  notify("密钥已轮换，请保存新密钥");
                } catch (e) {
                  notify(e.message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认轮换
            </button>
          </div>
        </Modal>
      )}
      {selected && (
        <Modal
          title="事件详情"
          description={selected.event_id || selected.id}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="detail-grid">
            <div>
              <small>事件类型</small>
              <span>{selected.event_type}</span>
            </div>
            <div>
              <small>当前状态</small>
              <Badge status={selected.status} />
            </div>
            <div>
              <small>投递次数</small>
              <span>{selected.attempts || selected.attempt_count || 0}</span>
            </div>
            <div>
              <small>最后一次错误</small>
              <span>{selected.last_error || "无"}</span>
            </div>
          </div>
          <pre className="json-preview">
            {typeof selected.payload === "string"
              ? selected.payload
              : JSON.stringify(
                  selected.payload ||
                    selected.body || {
                      event_id: selected.event_id,
                      event_type: selected.event_type,
                      status: selected.status,
                    },
                  null,
                  2,
                )}
          </pre>
        </Modal>
      )}
    </>
  );
}

function Transactions() {
  const { notify } = useApp();
  const { data, loading, error, reload } = useLoad(() =>
    api("/api/transactions"),
  );
  const [filter, setFilter] = useState("unmatched"),
    [claim, setClaim] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  const rows = (data?.transactions || []).filter(
    (t) => filter === "all" || (!t.order_id && !t.matched_order_id),
  );
  return (
    <>
      <PageHeading
        title="链上交易"
        description="查看监听到的转账与订单匹配结果。"
      >
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          刷新
        </button>
      </PageHeading>
      <section className="panel">
        <div className="list-toolbar">
          <div className="tabs">
            <button
              className={filter === "all" ? "active" : ""}
              onClick={() => setFilter("all")}
            >
              全部交易
            </button>
            <button
              className={filter === "unmatched" ? "active" : ""}
              onClick={() => setFilter("unmatched")}
            >
              未匹配转账
            </button>
          </div>
          <span className="muted text-small">交易记录不代表平台托管资产</span>
        </div>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>交易哈希</th>
                  <th>网络 / 币种</th>
                  <th>转入地址</th>
                  <th>金额</th>
                  <th>确认数</th>
                  <th>匹配结果</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span className="address-code">
                        <code title={t.tx_hash}>{clip(t.tx_hash, 8)}</code>
                        <CopyButton value={t.tx_hash} />
                      </span>
                      <small className="cell-sub">
                        {date(t.block_time || t.created_at)}
                      </small>
                    </td>
                    <td>
                      <span className="chain-cell">
                        <ChainIcon chain={t.chain} size={23} />
                        <span>
                          <b>{tokenSymbol(t) || "—"}</b>
                          <small className="cell-sub">
                            {CHAIN_NAMES[t.chain] || t.chain}
                          </small>
                        </span>
                      </span>
                    </td>
                    <td>
                      <code title={t.to_address}>{clip(t.to_address, 7)}</code>
                    </td>
                    <td className="money">
                      {t.amount ||
                        t.amount_decimal ||
                        t.settled_amount ||
                        t.amount_atomic ||
                        "—"}
                      {!t.amount &&
                        !t.amount_decimal &&
                        !t.settled_amount &&
                        t.amount_atomic && (
                          <small className="cell-sub">最小单位</small>
                        )}
                    </td>
                    <td>{t.confirmations || 0}</td>
                    <td>
                      <Badge
                        status={
                          t.order_id || t.matched_order_id
                            ? "paid"
                            : "unmatched"
                        }
                      >
                        {t.order_id || t.matched_order_id ? "已匹配" : "未匹配"}
                      </Badge>
                      {t.reason === "ambiguous_amount" && (
                        <small className="cell-sub transaction-match-reason">
                          金额对应多笔订单，待人工核对
                        </small>
                      )}
                    </td>
                    <td>
                      {!t.order_id && !t.matched_order_id && (
                        <button
                          className="table-link"
                          onClick={() => {
                            setClaim(t);
                            setFormError("");
                          }}
                        >
                          认领
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={Activity}
            title={
              filter === "unmatched" ? "没有待处理的未匹配转账" : "暂无链上交易"
            }
            description="监听到的转账会在这里显示。"
          />
        )}
      </section>
      {claim && (
        <Modal
          title="认领未匹配转账"
          description="系统会检查项目归属、确认数和订单匹配条件后再处理。"
          onClose={() => setClaim(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setFormError("");
              try {
                await mutate(`/api/transactions/${claim.id}/claim`, {
                  order_id: new FormData(e.currentTarget).get("order_id"),
                });
                setClaim(null);
                notify("转账已认领");
                reload();
              } catch (e) {
                setFormError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <InlineError error={formError} />
            <div className="secret-box">
              <small>交易哈希</small>
              <code>{claim.tx_hash}</code>
            </div>
            <Field label="目标订单 ID">
              <input name="order_id" required placeholder="do_..." />
            </Field>
            <FormFooter
              busy={busy}
              onClose={() => setClaim(null)}
              text="校验并认领"
            />
          </form>
        </Modal>
      )}
    </>
  );
}

function Products() {
  const { notify } = useApp();
  const { data, loading, error, reload } = useLoad(async () => {
    const [p, j] = await Promise.all([
      api("/api/products"),
      api("/api/projects"),
    ]);
    return { ...p, ...j };
  });
  const [adding, setAdding] = useState(false),
    [project, setProject] = useState(""),
    [stock, setStock] = useState(null),
    [orderProduct, setOrderProduct] = useState(null),
    [detail, setDetail] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  return (
    <>
      <PageHeading
        title="商品与发货"
        description="管理数字商品库存，支付确认后自动分配一份内容。"
      >
        <button
          className="button primary"
          onClick={() => {
            setAdding(true);
            setProject(data?.projects?.[0]?.id || "");
            setFormError("");
          }}
        >
          <Plus size={16} />
          创建商品
        </button>
      </PageHeading>
      <div className="fulfillment-flow">
        <span>
          <ShoppingBag size={18} />
          客户下单
        </span>
        <ChevronRight size={16} />
        <span>
          <ShieldCheck size={18} />
          确认支付
        </span>
        <ChevronRight size={16} />
        <span>
          <Package size={18} />
          分配库存
        </span>
        <ChevronRight size={16} />
        <span>
          <CheckCircle2 size={18} />
          自动交付
        </span>
      </div>
      <section className="panel">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : data?.products?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>商品</th>
                  <th>所属项目</th>
                  <th>售价</th>
                  <th>可用库存</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="product-cell">
                        <span>
                          <Package size={20} />
                        </span>
                        <div>
                          <b>{p.name}</b>
                          <small className="cell-sub">{clip(p.id, 9)}</small>
                        </div>
                      </span>
                    </td>
                    <td>
                      {data.projects?.find((j) => j.id === p.project_id)
                        ?.name || clip(p.project_id, 6)}
                    </td>
                    <td className="money">
                      <Money value={p.price} currency={p.currency} />
                    </td>
                    <td>
                      <span
                        className={`stock-value ${Number(p.stock) === 0 ? "out" : ""}`}
                      >
                        {p.stock ?? 0} 份
                      </span>
                    </td>
                    <td>
                      <div className="table-actions">
                        <button
                          className="table-link"
                          onClick={() => {
                            setStock(p);
                            setFormError("");
                          }}
                        >
                          导入库存
                        </button>
                        <button
                          className="table-link"
                          onClick={() => setOrderProduct(p)}
                        >
                          创建订单
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={Package}
            title="准备第一件数字商品"
            description="创建商品并导入内容，即可验证自动发货。"
          />
        )}
      </section>
      <div className="info-note">
        <Package size={21} />
        <div>
          <b>每份库存只分配给一笔订单</b>
          <p>
            自动发货依赖服务端确认到账，重复通知不会重复扣减库存。买家可在已付款订单的收银台查看交付内容。
          </p>
        </div>
      </div>
      {adding && (
        <Modal title="创建商品" onClose={() => setAdding(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setFormError("");
              try {
                await mutate("/api/products", {
                  ...Object.fromEntries(new FormData(e.currentTarget)),
                  project_id: project,
                });
                setAdding(false);
                notify("商品已创建，请导入库存");
                reload();
              } catch (e) {
                setFormError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <InlineError error={formError} />
            <Field label="所属项目">
              <ProjectSelect
                projects={data?.projects || []}
                value={project}
                onChange={setProject}
              />
            </Field>
            <Field label="商品名称">
              <input
                name="name"
                required
                maxLength={120}
                placeholder="例如：数字模板下载码"
              />
            </Field>
            <div className="form-row">
              <Field label="售价">
                <input
                  name="price"
                  required
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]{1,8})?"
                  placeholder="9.90"
                />
              </Field>
              <Field label="计价币种">
                <select name="currency">
                  <option>USD</option>
                </select>
              </Field>
            </div>
            <FormFooter
              busy={busy}
              onClose={() => setAdding(false)}
              text="创建商品"
            />
          </form>
        </Modal>
      )}
      {stock && (
        <Modal
          title={`导入库存 · ${stock.name}`}
          description="每行是一份独立的数字内容或兑换码，按份发货。"
          onClose={() => setStock(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setFormError("");
              try {
                const items = String(new FormData(e.currentTarget).get("items"))
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean);
                if (!items.length) throw new Error("请至少输入一份内容");
                await mutate(`/api/products/${stock.id}/inventory`, { items });
                setStock(null);
                notify(`已导入 ${items.length} 份库存`);
                reload();
              } catch (e) {
                setFormError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <InlineError error={formError} />
            <Field label="库存内容">
              <textarea
                name="items"
                className="inventory-input"
                rows={9}
                required
                placeholder={"DEMO-CODE-001\nDEMO-CODE-002\nDEMO-CODE-003"}
              />
            </Field>
            <FormFooter
              busy={busy}
              onClose={() => setStock(null)}
              text="导入库存"
            />
          </form>
        </Modal>
      )}
      {orderProduct && (
        <CreateOrder
          product={orderProduct}
          onClose={() => setOrderProduct(null)}
          onDone={(o) => {
            setOrderProduct(null);
            setDetail(o);
            reload();
          }}
        />
      )}
      {detail && (
        <OrderDetail
          order={detail}
          onClose={() => setDetail(null)}
          onUpdate={reload}
        />
      )}
    </>
  );
}

function AccountSettings() {
  const { notify, refreshAuth } = useApp();
  const { data, loading, error, reload } = useLoad(() => api("/api/settings"));
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeading
        title="账户设置"
        description="管理商户资料与当前运行环境。"
      />
      {loading ? (
        <Spinner />
      ) : error ? (
        <ResourceError error={error} onRetry={reload} />
      ) : (
        <div className="settings-layout">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>基本资料</h2>
                <p>你的商户显示名称。</p>
              </div>
              <UserRound size={19} />
            </div>
            <form
              className="settings-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await mutate(
                    "/api/settings",
                    { name: new FormData(e.currentTarget).get("name") },
                    "PATCH",
                  );
                  await refreshAuth();
                  reload();
                  notify("资料已更新");
                } catch (e) {
                  notify(e.message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="商户名称">
                <input
                  name="name"
                  defaultValue={data.name}
                  maxLength={80}
                  required
                />
              </Field>
              <Field label="登录邮箱">
                <input value={data.email || ""} disabled readOnly />
              </Field>
              <Field label="商户 ID" help="用于平台管理员配置和问题排查。">
                <div className="table-actions">
                  <input value={data.id || ""} readOnly />
                  <CopyButton value={data.id || ""} label="复制商户 ID" />
                </div>
              </Field>
              <button className="button primary" disabled={busy}>
                {busy ? "保存中…" : "保存修改"}
              </button>
            </form>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>运行环境</h2>
                <p>收款服务的基础信息。</p>
              </div>
              <ShieldCheck size={19} />
            </div>
            <div className="settings-environment">
              <div>
                <span>当前模式</span>
                <Badge status={data.mode === "demo" ? "pending" : "paid"}>
                  {data.mode === "demo" ? "演示环境" : "真实环境"}
                </Badge>
              </div>
              <div>
                <span>资金托管</span>
                <b>非托管</b>
              </div>
              <div>
                <span>钱包私钥</span>
                <b>不收集、不存储</b>
              </div>
              <div>
                <span>协议</span>
                <b>HMAC-SHA256</b>
              </div>
              <Link to="/docs#deployment" className="text-link">
                查看部署与配置说明
                <ArrowUpRight size={14} />
              </Link>
            </div>
          </section>
        </div>
      )}
      <AccountSecurity />
    </>
  );
}

function Checkout({ token }) {
  const { user, mode, notify, public_demo: publicDemo } = useApp();
  const invoiceId = new URLSearchParams(location.search).get("invoice");
  const [data, setData] = useState(null),
    [invoice, setInvoice] = useState(null),
    [methods, setMethods] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [clock, setClock] = useState(Date.now());
  async function load() {
    try {
      const r = await api(`/checkout/${encodeURIComponent(token)}/state`);
      const state = r.order || r;
      setData({
        ...state,
        _clockOffset: state.server_time
          ? new Date(state.server_time).getTime() - Date.now()
          : 0,
      });
      setError("");
      if (user && invoiceId) {
        try {
          const billing = await api("/api/billing");
          const owned = (billing.invoices || []).find(
            (item) =>
              item.id === invoiceId &&
              item.order_id === state.order_id &&
              item.checkout_url &&
              checkoutPath(item) === `/checkout/${token}`,
          );
          setInvoice(owned || null);
        } catch {
          setInvoice(null);
        }
      } else {
        setInvoice(null);
      }
      if (
        state.status === "awaiting_payment" ||
        (state.status === "pending" && !state.chain)
      ) {
        const m = await api(`/checkout/${encodeURIComponent(token)}/methods`);
        setMethods(m.methods || m.allowed_methods || []);
      }
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    const poll = setInterval(load, 5000),
      timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(timer);
    };
  }, [token, invoiceId, user?.id]);
  const isDemo = data?.mode === "demo" || publicDemo;
  const subscriptionActivated =
    invoice?.status === "paid" && Boolean(invoice?.activated_at);
  const end = data?.expires_at || data?.selection_deadline;
  const remaining = end
    ? Math.max(
        0,
        Math.floor(
          (new Date(end).getTime() - (clock + (data?._clockOffset || 0))) /
            1000,
        ),
      )
    : 0;
  const time = `${Math.floor(remaining / 60)
    .toString()
    .padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`;
  const isBscUsdt = data?.chain === "bsc" && tokenSymbol(data) === "USDT";
  // The server supplies the exact lower bound; never derive it by rounding the quote.
  const tolerance = data?.payment_tolerance;
  const paymentTolerance =
    tolerance?.enabled === true &&
    tolerance.kind === "fingerprint_only" &&
    tolerance.requires_unique_order === true &&
    typeof tolerance.minimum_amount === "string" &&
    /^\d+(?:\.\d+)?$/.test(tolerance.minimum_amount)
      ? tolerance
      : null;
  const receivedAmount =
    typeof data?.received_amount === "string" && data.received_amount !== ""
      ? data.received_amount
      : null;
  const paymentWindowClosed =
    (["pending", "awaiting_payment"].includes(data?.status) &&
      Boolean(end) &&
      remaining === 0) ||
    (data?.status === "pending" &&
      Boolean(data?.chain) &&
      data?.payable === false);
  const needsMethod =
    data?.status === "awaiting_payment" ||
    (data?.status === "pending" && !data?.chain);
  return (
    <div className="checkout-page checkout-page-refined">
      <header>
        <Logo />
        <span>
          <ShieldCheck size={15} />
          {invoice ? "订阅收银台" : "安全收银台"}
        </span>
      </header>
      <main className="checkout-main">
        {!data ? (
          error ? (
            <ResourceError error={error} onRetry={load} />
          ) : (
            <Spinner />
          )
        ) : (
          <>
            <div className="checkout-merchant">
              <span className="store-avatar">
                {data.brand?.logo_data_url ? (
                  <img
                    className="brand-logo-image"
                    src={data.brand.logo_data_url}
                    alt="商户 Logo"
                  />
                ) : (
                  (data.brand?.display_name || data.project_name || "A")[0]
                )}
              </span>
              <div>
                <b>
                  {invoice
                    ? "Avenora Pay 套餐订阅"
                    : data.brand?.display_name ||
                      data.project_name ||
                      "商户收款"}
                </b>
                <small>
                  {invoice
                    ? `${invoice.plan_name || invoice.plan_id} · 订阅付款`
                    : data.product_name || "订单收款"}
                </small>
              </div>
            </div>
            {isDemo && (
              <div className="checkout-demo">
                <TriangleAlert size={17} />
                <div>
                  <b>演示订单，请勿实际转账</b>
                  <span>
                    {invoice
                      ? "此页用于验证订阅付款与套餐开通流程。"
                      : "此页用于验证收款与自动发货流程。"}
                  </span>
                </div>
              </div>
            )}
            <section className="checkout-panel">
              <div className="checkout-panel-head">
                {data.chain ? (
                  <span className="network-pill">
                    <ChainIcon chain={data.chain} size={20} />
                    <span className="checkout-network-name">
                      {isBscUsdt
                        ? "USDT-BEP20 · BNB Smart Chain（BSC）"
                        : CHAIN_NAMES[data.chain] || data.chain}
                    </span>
                    {!isBscUsdt && (
                      <span className="checkout-network-caption">网络</span>
                    )}
                  </span>
                ) : (
                  <div className="checkout-fiat-heading">
                    <small>{invoice ? "订阅金额" : "订单金额"}</small>
                    <h1>
                      <Money
                        value={data.fiat_total || data.fiat_amount}
                        currency={data.fiat_currency}
                      />
                    </h1>
                  </div>
                )}
                <Badge
                  status={
                    paymentWindowClosed
                      ? "expired"
                      : data.status === "review"
                        ? "recorded"
                        : data.status
                  }
                >
                  {paymentWindowClosed
                    ? "已到付款截止"
                    : data.status === "review"
                      ? "付款待核对"
                      : undefined}
                </Badge>
              </div>
              <InlineError error={error} />
              {needsMethod && !paymentWindowClosed ? (
                <div className="method-selection">
                  <h2>选择支付网络与币种</h2>
                  <p>
                    先确认网络与币种。选择后锁定本单报价，生成完整应付金额和收款地址。
                  </p>
                  {methods.map((m, i) => (
                    <button
                      key={m.token_id || i}
                      className="payment-method"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await mutate(
                            `/checkout/${encodeURIComponent(token)}/select`,
                            { chain: m.chain, token_id: m.token_id },
                          );
                          await load();
                        } catch (e) {
                          setError(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <ChainIcon chain={m.chain} size={32} />
                      <span>
                        <b>{tokenSymbol(m)}</b>
                        <small>网络：{CHAIN_NAMES[m.chain] || m.chain}</small>
                      </span>
                      <ChevronRight size={18} />
                    </button>
                  ))}
                  {!methods.length && (
                    <Empty
                      title="暂时没有可用支付方式"
                      description="请联系商户配置收款网络和地址。"
                    />
                  )}
                </div>
              ) : data.status === "paid" ? (
                <div className="checkout-success">
                  <span>
                    <Check size={34} />
                  </span>
                  <h2>
                    {invoice
                      ? subscriptionActivated
                        ? "订阅已开通"
                        : "订阅正在开通"
                      : "支付已确认"}
                  </h2>
                  <p>
                    {invoice
                      ? subscriptionActivated
                        ? `${invoice.plan_name || "所选套餐"}已生效，可返回工作台查看订阅期限与额度。`
                        : "已确认收款，正在核对账单并更新订阅状态。"
                      : isDemo
                        ? "演示到账已完成，以下是本次流程的结果。"
                        : data.paid_source === "manual"
                          ? "商户已人工核对并确认订单，以下是本次处理结果。"
                          : "感谢付款，收款结果已通知商户。"}
                  </p>
                  {receivedAmount !== null && (
                    <div className="checkout-received-amount">
                      <span>实际到账</span>
                      <strong>
                        {displayAmount(receivedAmount)} {tokenSymbol(data)}
                      </strong>
                    </div>
                  )}
                  {invoice ? (
                    <div className="checkout-subscription-result">
                      <div className="checkout-receipt">
                        <CheckCircle2 size={17} />
                        {subscriptionActivated
                          ? "套餐权益已由服务端确认开通。"
                          : "确认结果会自动更新，无需重复付款。"}
                      </div>
                      <Link
                        to="/merchant/usage"
                        className="button primary full"
                      >
                        返回套餐与用量
                        <ArrowRight size={15} />
                      </Link>
                    </div>
                  ) : data.delivery ? (
                    <div className="checkout-delivery">
                      <div>
                        <Package size={18} />
                        <b>你的商品已送达</b>
                        <CopyButton
                          value={
                            typeof data.delivery === "string"
                              ? data.delivery
                              : data.delivery.content ||
                                data.delivery.item ||
                                ""
                          }
                        />
                      </div>
                      <pre>
                        {typeof data.delivery === "string"
                          ? data.delivery
                          : data.delivery.content ||
                            data.delivery.item ||
                            JSON.stringify(data.delivery, null, 2)}
                      </pre>
                    </div>
                  ) : (
                    <div className="checkout-receipt">
                      <CheckCircle2 size={17} />
                      订单已支付，可向商户查询交付结果。
                    </div>
                  )}
                  {data.tx_hash && (
                    <div className="checkout-tx">
                      <small>交易哈希</small>
                      <code>{clip(data.tx_hash, 16)}</code>
                      <CopyButton value={data.tx_hash} />
                    </div>
                  )}
                </div>
              ) : data.status === "confirming" ? (
                <div className="checkout-closed checkout-confirming">
                  <span>
                    <Radio size={30} />
                  </span>
                  <h2>正在等待链上确认</h2>
                  <p>
                    已检测到付款，请勿重复转账。达到所需确认数后，本页会自动更新结果。
                  </p>
                  <div className="checkout-progress">
                    <div>
                      <span>链上确认进度</span>
                      <b>
                        {data.confirmations || 0} /{" "}
                        {data.required_confirmations || "—"}
                      </b>
                    </div>
                    <div className="progress-track">
                      <i
                        style={{
                          width: `${Math.min(100, ((data.confirmations || 0) / (data.required_confirmations || 1)) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  {data.chain === "bitcoin" && (
                    <p>
                      交易已进入区块，继续等待{" "}
                      {data.required_confirmations || 6}{" "}
                      次确认；确认过程可以超过付款窗口，无需再次付款。
                    </p>
                  )}
                  {data.tx_hash && (
                    <div className="checkout-tx">
                      <small>交易哈希</small>
                      <code>{clip(data.tx_hash, 16)}</code>
                      <CopyButton value={data.tx_hash} label="复制交易哈希" />
                    </div>
                  )}
                </div>
              ) : data.status === "review" ? (
                <div className="checkout-closed checkout-review">
                  <span>
                    <Clock3 size={30} />
                  </span>
                  <h2>付款待核对</h2>
                  <p>
                    已收到付款记录，请勿重复转账。商户正在核对处理，本页会自动更新结果。
                  </p>
                  {data.tx_hash && (
                    <div className="checkout-tx">
                      <small>交易哈希</small>
                      <code>{clip(data.tx_hash, 16)}</code>
                      <CopyButton value={data.tx_hash} label="复制交易哈希" />
                    </div>
                  )}
                </div>
              ) : paymentWindowClosed ||
                ["expired", "canceled"].includes(data.status) ? (
                <div className="checkout-closed">
                  <span>
                    <Clock3 size={30} />
                  </span>
                  <h2>
                    {paymentWindowClosed
                      ? "已到付款截止，请勿转账"
                      : data.status === "expired"
                        ? "订单已过期"
                        : "订单已取消"}
                  </h2>
                  <p>
                    {paymentWindowClosed
                      ? "请勿继续向此订单转账。若已付款，请保留交易哈希并联系商户核对；本页会自动更新处理状态。"
                      : invoice
                        ? "请返回套餐页面重新创建订阅账单，不要继续向此订单转账。"
                        : "请返回商户页面重新创建订单，不要继续向此订单转账。"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="checkout-amount-box">
                    <small>
                      {paymentTolerance ? "订单应付金额" : "必须实际到账"}
                    </small>
                    <h1 className="checkout-payable">
                      <span className="exact-token-amount">
                        {displayAmount(data.payable_amount)}
                      </span>
                      <span className="checkout-payable-unit">
                        <em>{tokenSymbol(data)}</em>
                        <CopyButton
                          value={data.payable_amount}
                          label="复制完整应付金额"
                        />
                      </span>
                    </h1>
                    {paymentTolerance && (
                      <div className="checkout-minimum-amount">
                        <span>允许省略识别尾数，最低到账</span>
                        <strong>
                          {displayAmount(paymentTolerance.minimum_amount)}{" "}
                          {tokenSymbol(data)}
                        </strong>
                      </div>
                    )}
                    {!paymentTolerance && isBscUsdt && (
                      <p className="checkout-exact-match">
                        实际到账金额必须与上方绿色数字完全一致
                      </p>
                    )}
                    {paymentTolerance ? (
                      <div className="checkout-arrival-note">
                        <b>仅可省略本单的小额识别尾数</b>
                        <p>
                          订单本金和商户手续费仍须足额到账。建议按完整应付金额支付，便于识别订单。
                        </p>
                        <p>
                          {
                            "提币时请核对“预计到账”：如平台从转出金额中扣除手续费，扣费后的实际到账金额不能低于 "
                          }
                          <strong>
                            {displayAmount(paymentTolerance.minimum_amount)}{" "}
                            {tokenSymbol(data)}
                          </strong>
                          {"，也不要超过订单应付金额。"}
                        </p>
                        <p>若该到账金额对应多笔订单，需由商户核对处理。</p>
                        {data.chain === "bsc" && (
                          <p>
                            使用普通 BSC 链上钱包转账时，Gas 用 BNB 另付，请预留
                            BNB。
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="checkout-arrival-note">
                        <b>不要多转，也不要少转</b>
                        {isBscUsdt ? (
                          <p>
                            {"扣除交易所提现手续费后，收款地址必须实际收到 "}
                            <strong>
                              {displayAmount(data.payable_amount)} USDT
                            </strong>
                            {
                              "，“预计到账”须与上方金额完全一致。若手续费从提现数量中扣除，请增加发送数量；例如使用币安提现，若本次从发送数量中扣除 0.1 USDT，就在应到账数量上多发送 0.1 USDT，具体以本次提现页面显示的实际手续费为准。链上钱包的Gas使用BNB单独支付，不会从USDT金额中扣除。"
                            }
                          </p>
                        ) : (
                          <>
                            <p>
                              {"本单收款地址必须实际收到 "}
                              <strong>
                                {displayAmount(data.payable_amount)}{" "}
                                {tokenSymbol(data)}
                              </strong>
                              {"，到账数量须完全一致。"}
                            </p>
                            <p>
                              {
                                "交易所提现时，确认“预计到账”与应付数量一致；若手续费从提现数量中扣除，请增加发送数量，让扣费后的到账数量准确匹配。"
                              }
                            </p>
                            {data.chain === "bsc" && (
                              <p>
                                {
                                  "使用普通 BSC 链上钱包转账时，Gas 用 BNB 另付，请预留 BNB，不要从应付 "
                                }
                                {tokenSymbol(data)}
                                {" 中扣减。"}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="checkout-qr-block">
                    <QR value={data.pay_address} demo={isDemo} size={164} />
                    <span>
                      {isDemo
                        ? "演示二维码，不可用于转账"
                        : "二维码仅包含收款地址，请完整复制应付金额"}
                    </span>
                  </div>
                  <div className="checkout-address">
                    <small>收款地址</small>
                    <div>
                      <code>{data.pay_address}</code>
                      <CopyButton
                        value={data.pay_address}
                        label="复制完整收款地址"
                      />
                    </div>
                  </div>
                  <div className="checkout-progress">
                    <div>
                      <span>
                        {data.status === "confirming" ? (
                          <>
                            <Radio size={15} />
                            正在等待链上确认
                          </>
                        ) : (
                          <>
                            <Clock3 size={15} />
                            等待付款
                          </>
                        )}
                      </span>
                      <b>
                        {data.status === "confirming"
                          ? `${data.confirmations || 0} / ${data.required_confirmations || "—"}`
                          : time}
                      </b>
                    </div>
                    <div className="progress-track">
                      <i
                        style={{
                          width: `${data.status === "confirming" ? Math.min(100, ((data.confirmations || 0) / (data.required_confirmations || 1)) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    {data.expires_at && (
                      <p className="checkout-deadline">
                        {data.status === "confirming"
                          ? "本单付款截止"
                          : "付款截止"}
                        ：
                        {new Date(data.expires_at).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: false,
                        })}
                      </p>
                    )}
                  </div>
                  <div className="checkout-instructions">
                    {isBscUsdt ? (
                      <p>
                        <b>必须使用BSC链上转账：</b>
                        {
                          "请选择“区块链提现/链上提现”与BNB Smart Chain（BEP20）。不要使用Binance Pay、交易所内部转账、内部划转或其他网络；这类付款不会产生可扫描的BSC交易哈希，系统无法自动发货。付款记录中必须能够查看以0x开头的链上TxID。"
                        }
                      </p>
                    ) : (
                      <>
                        <p>
                          <b>币种和网络必须选对</b>
                        </p>
                        <p>
                          {"本单网络："}
                          {CHAIN_NAMES[data.chain] || data.chain}
                          {
                            "。请核对币种、网络及本单收款地址，不要跨链转账，也不要复用旧订单地址。"
                          }
                        </p>
                        <p className="checkout-method-title">
                          <b>选择链上转账或区块链提现</b>
                        </p>
                        <p>
                          {
                            "请选择“链上转账 / 区块链提现”。不要使用 Binance Pay、UID/邮箱转账、交易所内部转账或内部划转。"
                          }
                        </p>
                        <p>
                          {
                            "付款后保留可在对应区块链浏览器查询的交易哈希（TxID）；内部转账无法通过链上记录自动确认。"
                          }
                        </p>
                      </>
                    )}
                    {[
                      "ethereum-eth",
                      "base-eth",
                      "arbitrum-eth",
                      "bsc-bnb",
                    ].includes(data.token_id) && (
                      <p>请使用钱包直接转账，暂不支持合约内部转账。</p>
                    )}
                    {data.chain === "bitcoin" && (
                      <p>
                        请在付款截止前让交易进入区块；入区块后继续等待{" "}
                        {data.required_confirmations || 6}{" "}
                        次确认，确认过程可以超过付款窗口。
                      </p>
                    )}
                  </div>
                </>
              )}
              <details className="checkout-details">
                <summary>
                  <span>订单明细</span>
                  <span className="checkout-details-total">
                    <Money
                      value={data.fiat_total || data.fiat_amount}
                      currency={data.fiat_currency}
                    />
                    <ChevronDown size={15} />
                  </span>
                </summary>
                <div className="checkout-details-content">
                  <dl>
                    <div>
                      <dt>订单号</dt>
                      <dd className="checkout-detail-id">
                        <code>{data.order_id}</code>
                        <CopyButton value={data.order_id} label="复制订单号" />
                      </dd>
                    </div>
                    <div>
                      <dt>{invoice ? "订阅金额" : "商品金额"}</dt>
                      <dd>
                        <Money
                          value={data.fiat_amount}
                          currency={data.fiat_currency}
                        />
                      </dd>
                    </div>
                    {Number(data.fee_amount) > 0 && (
                      <div>
                        <dt>商户手续费（{data.fee_percent}%）</dt>
                        <dd>
                          <Money
                            value={data.fee_amount}
                            currency={data.fiat_currency}
                          />
                        </dd>
                      </div>
                    )}
                    {data.payable_amount && (
                      <div>
                        <dt>完整应付金额</dt>
                        <dd>
                          {displayAmount(data.payable_amount)}{" "}
                          {tokenSymbol(data)}
                        </dd>
                      </div>
                    )}
                    {paymentTolerance && (
                      <div>
                        <dt>最低到账金额</dt>
                        <dd>
                          {displayAmount(paymentTolerance.minimum_amount)}{" "}
                          {tokenSymbol(data)}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <PriceSnapshot order={data} />
                </div>
              </details>
            </section>
            {isDemo &&
              user &&
              !paymentWindowClosed &&
              ["pending", "confirming"].includes(data.status) && (
                <div className="checkout-simulate">
                  <p>演示控制 · 仅当前商户可操作</p>
                  <button
                    className="button primary full"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await mutate(
                          invoice
                            ? `/api/billing/invoices/${encodeURIComponent(invoice.id)}/simulate`
                            : `/api/orders/${data.order_id}/simulate`,
                          { confirmations: data.required_confirmations || 20 },
                        );
                        await load();
                        notify(
                          invoice ? "演示订阅付款已处理" : "演示到账已处理",
                        );
                      } catch (e) {
                        setError(e.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Zap size={16} />
                    {busy
                      ? "处理中…"
                      : invoice
                        ? "模拟付款并开通订阅"
                        : "模拟确认到账并发货"}
                  </button>
                </div>
              )}
            {data.brand?.support_email && (
              <a
                href={`mailto:${data.brand.support_email}`}
                className="checkout-return"
              >
                <Mail size={13} />
                联系商户：{data.brand.support_email}
              </a>
            )}
            <Link
              to={invoice ? "/merchant/usage" : user ? "/merchant/orders" : "/"}
              className="checkout-return"
            >
              {invoice ? "返回套餐与用量" : user ? "返回订单管理" : "返回首页"}
              <ArrowRight size={14} />
            </Link>
          </>
        )}
      </main>
      <footer>
        <LockKeyhole size={12} />由 Avenora Pay 提供 · 资金直达商户钱包
      </footer>
    </div>
  );
}

function Pricing() {
  const { user, public_demo: publicDemo, demo } = useApp();
  const { data, loading, error, reload } = useLoad(() => api("/plans"));
  return (
    <>
      <PublicNav />
      <main className="pricing-page">
        <div className="public-page-heading">
          <span className="section-kicker">成本透明</span>
          <h1>
            适合每个业务阶段的
            <br />
            加密货币收款方案。
          </h1>
          <p>资金直达商户钱包。按月订阅，使用当前平台提供的收款与集成服务。</p>
        </div>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : (
          <div className="pricing-grid">
            {(data?.plans || []).map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                onChoose={() =>
                  user
                    ? go("/merchant/usage")
                    : publicDemo
                      ? demo()
                      : go("/merchant/register")
                }
                buttonText={p.id === "free" ? "免费开始" : "查看套餐详情"}
              />
            ))}
          </div>
        )}
        <div className="pricing-bottom">
          <ShieldCheck size={22} />
          <div>
            <h3>费用与到账信息均可核对</h3>
            <p>
              订阅金额、收款方式和支付状态以平台创建的账单为准。未启用收费时不会创建真实付款要求。
            </p>
          </div>
          <Link to="/docs" className="button secondary">
            了解接入方式
            <ArrowRight size={14} />
          </Link>
        </div>
      </main>
      <PublicFooter />
    </>
  );
}

function Docs() {
  const sections = [
    ["overview", "概述"],
    ["credentials", "API 凭据"],
    ["signing", "请求签名"],
    ["orders", "创建订单"],
    ["checkout", "收银台"],
    ["webhook", "Webhook 验签"],
    ["fulfillment", "自动发货"],
    ["deployment", "部署与运行"],
  ];
  return (
    <>
      <PublicNav />
      <main className="docs-page">
        <div className="public-page-heading">
          <span className="section-kicker">开发者</span>
          <h1>接入文档</h1>
          <p>兼容 DujiaoPay 的签名 API，连接你的收款与履约流程。</p>
        </div>
        <div className="docs-layout">
          <aside>
            <b>目录</b>
            {sections.map(([id, label]) => (
              <a href={`#${id}`} key={id}>
                {label}
              </a>
            ))}
          </aside>
          <article>
            <section id="overview">
              <h2>概述</h2>
              <p>
                Avenora Pay
                是独立构建的非托管支付网关。客户将资金直接转入商户地址，网关校验链上交易并通知业务系统。它不保管私钥，也不执行转账。
              </p>
              <div className="doc-callout">
                <Sparkles size={18} />
                <p>
                  演示环境的地址、交易、确认与固定报价均为测试数据。真实收款仅在节点、币种、报价源与收款地址就绪后启用。
                </p>
              </div>
            </section>
            <section id="credentials">
              <h2>API 凭据</h2>
              <p>
                进入「项目管理」创建项目，在「API
                Keys」生成一组项目级凭据。Secret
                只显示一次，请保存在业务服务端。
              </p>
              <table>
                <tbody>
                  <tr>
                    <th>字段</th>
                    <th>用途</th>
                  </tr>
                  <tr>
                    <td>
                      <code>key_id</code>
                    </td>
                    <td>请求头 DJP-Key-ID</td>
                  </tr>
                  <tr>
                    <td>
                      <code>secret</code>
                    </td>
                    <td>计算 HMAC-SHA256</td>
                  </tr>
                </tbody>
              </table>
            </section>
            <section id="signing">
              <h2>请求签名</h2>
              <p>
                每次请求附带 DJP-Key-ID、DJP-Timestamp、DJP-Nonce 与
                DJP-Signature。Nonce 每次随机生成，时间戳使用 Unix 秒。
              </p>
              <pre>{`const canonical = [\n  method.toUpperCase(),\n  path,\n  canonicalQuery,\n  sha256Hex(rawBody),\n  timestamp,\n  nonce\n].join("\\n");\n\nconst signature = crypto.createHmac("sha256", secret)\n  .update(canonical).digest("hex");`}</pre>
              <p>
                查询参数按键、值分别排序，再进行 URL 编码，以 &amp;
                连接。服务端拒绝重复 Nonce、过期时间戳及无效签名。可先请求{" "}
                <code>GET /v1/whoami</code> 验证集成。
              </p>
            </section>
            <section id="orders">
              <h2>创建订单</h2>
              <span className="endpoint-label">
                <b>POST</b>/v1/orders
              </span>
              <p>金额使用十进制字符串；传入 Idempotency-Key 可防止重复建单。</p>
              <pre>{`{\n  "chain": "bsc",\n  "token_id": "bsc-usdt",\n  "fiat_currency": "USD",\n  "fiat_amount": "9.90",\n  "merchant_order_id": "SHOP-10086"\n}`}</pre>
              <p>
                响应提供 order_id、pay_address、payable_amount、expires_at 和
                checkout_url。应付金额包含区分订单的小数尾数，付款时必须完整保留。省略
                chain 和 token_id 可由付款人在收银台选择。
              </p>
              <div className="doc-state-flow">
                awaiting_payment <ArrowRight size={14} />
                pending <ArrowRight size={14} />
                confirming <ArrowRight size={14} />
                paid
              </div>
              <p>
                查询：<code>GET /v1/orders/:id</code>；列表：
                <code>GET /v1/orders</code>；取消待付款订单：
                <code>POST /v1/orders/:id/cancel</code>。
              </p>
            </section>
            <section id="checkout">
              <h2>收银台</h2>
              <p>
                把客户引导到建单返回的
                checkout_url。付款页展示网络、精确金额、地址、二维码和剩余时间，并每
                5 秒查询状态。
              </p>
              <pre>{`GET  /checkout/{token}/state\nGET  /checkout/{token}/methods\nPOST /checkout/{token}/select`}</pre>
              <p>
                收银台只展示公开付款信息，不暴露项目密钥或内部元数据。页面跳转不作为支付证明，业务端应校验签名事件或通过服务端查单。
              </p>
              <p>
                支持 BTC、ETH、BNB、SOL、TRX、USDT 与
                USDC。币种和网络是两个独立字段，例如 ETH 可在 Ethereum、Base 或
                Arbitrum 网络收款；具体可用组合以注册表与项目配置为准。
              </p>
              <p>
                主流币金额按本单价格快照锁定，金额字符串必须完整保留，不能用浮点运算截短小数。BTC
                最低收款为 546 satoshi，须在 20 分钟付款窗口内入区块，再等待 6
                次确认；其他主流币的初始付款窗口为 10
                分钟。已入账的确认过程可超过窗口。
              </p>
              <p>
                ETH 与 BNB
                仅支持钱包直接转账，暂不识别合约内部转账。二维码包含收款地址，应付金额需要按页面完整复制。
              </p>
            </section>
            <section id="webhook">
              <h2>Webhook 验签</h2>
              <p>
                在「Webhook
                投递」添加接收地址并保存签名密钥。使用原始请求体进行验签，同时校验时间戳并按事件
                ID 去重。
              </p>
              <pre>{`DJP-Webhook-ID: evt_...\nDJP-Webhook-Timestamp: 1750000000\nDJP-Webhook-Signature: <hex_signature>\n\nHMAC_SHA256(secret, timestamp + "." + rawBody)`}</pre>
              <p>
                事件信封使用
                event_id、event_type、event_version、created_at、data。支付完成事件为
                order.paid。接收端尽快落库后返回 2xx，失败会自动重试。
              </p>
              <pre>{`{\n  "event_id": "evt_...",\n  "event_type": "order.paid",\n  "event_version": "v1",\n  "data": {\n    "order_id": "do_...",\n    "merchant_order_id": "SHOP-10086",\n    "status": "paid"\n  }\n}`}</pre>
            </section>
            <section id="fulfillment">
              <h2>自动发货</h2>
              <p>
                已有商城可接收并验证 order.paid
                事件，再完成履约。本地「商品与发货」模块支持导入数字内容库存：创建关联商品订单，确认支付后自动分配一份内容，买家在收银台查看。
              </p>
              <p>
                订单、库存分配与发货结果使用服务端事务，重复到账处理不会重复发货。库存不足时不会伪造交付成功。
              </p>
            </section>
            <section id="deployment">
              <h2>部署与运行</h2>
              <p>
                这是可自行部署的独立应用。服务器需要 Node.js 24
                或更新版本，持久化数据库与加密密钥；生产环境通过 HTTPS
                反向代理提供访问。
              </p>
              <ol>
                <li>先在演示空间验证完整订单与发货流程。</li>
                <li>按项目随附部署文档配置链上节点、代币合约和确认策略。</li>
                <li>创建真实商户、项目和收款地址，配置 API 与 Webhook。</li>
                <li>完成独立的真实环境验收后，再向客户开放。</li>
              </ol>
              <div className="doc-callout">
                <BookOpen size={18} />
                <p>
                  具体可用链、配置字段和当前验证范围，以本项目随附文档与运行状态为准。未配置的网络不会接受真实收款订单。
                </p>
              </div>
            </section>
          </article>
        </div>
      </main>
      <PublicFooter />
    </>
  );
}
function About({ page }) {
  const privacy = page === "/privacy",
    terms = page === "/terms";
  return (
    <>
      <PublicNav />
      <main className="about-page">
        <span className="section-kicker">Avenora Pay</span>
        <h1>
          {privacy ? "隐私说明" : terms ? "使用说明" : "独立构建，公开可核对。"}
        </h1>
        <p className="about-lead">
          {privacy
            ? "这套服务只处理收款业务所需的信息。"
            : "让主流币与稳定币收款直达商户钱包，连接支付确认与自动履约。"}
        </p>
        <section className="panel prose-panel">
          {privacy ? (
            <>
              <h2>存储哪些信息</h2>
              <p>
                应用保存账户、项目、收款地址、订单、链上交易回执、API
                凭据、投递记录与商品库存。密码以加盐哈希保存，服务端凭据加密存储。实际数据位于部署者管理的数据库。
              </p>
              <h2>不需要哪些信息</h2>
              <p>
                平台不需要钱包私钥或助记词。它不持有商户资金，也没有提币功能。
              </p>
              <h2>外部连接</h2>
              <p>
                实际运行时，服务端会查询配置的链上节点，并向商户配置的 Webhook
                接收端发送签名事件。演示环境的记录不能视为真实付款。
              </p>
            </>
          ) : (
            <>
              <h2>项目定位</h2>
              <p>
                Avenora Pay 是独立开发与运行的非托管支付平台。支付接口兼容
                DujiaoPay
                的签名协议，与其官方没有隶属或授权关系，也不连接其商户账户。
              </p>
              <h2>付款与履约</h2>
              <p>
                付款直达商户钱包。应用识别并核对转账、等待确认、记录订单，再通过签名通知或内部库存模块完成交付。
              </p>
              <h2>当前运行方式</h2>
              <p>
                演示空间用于验证产品流程。真实收款需要单独配置节点、币种、报价源和收款地址；本地演示的成功结果不等于主网支付已经验收。
              </p>
              <div className="about-links">
                <Link to="/docs" className="button primary">
                  查看接口文档
                  <ArrowRight size={15} />
                </Link>
                <a
                  href="https://www.dujiaopay.com/"
                  className="button secondary"
                  target="_blank"
                  rel="noreferrer"
                >
                  兼容协议参考来源
                  <ExternalLink size={15} />
                </a>
              </div>
            </>
          )}
        </section>
      </main>
      <PublicFooter />
    </>
  );
}

function PaymentLinks() {
  const { notify } = useApp();
  const { data, loading, error, reload } = useLoad(async () => {
    const [l, p] = await Promise.all([
      api("/api/payment-links"),
      api("/api/projects"),
    ]);
    return { ...l, ...p };
  });
  const [editing, setEditing] = useState(null),
    [project, setProject] = useState(""),
    [amountMode, setAmountMode] = useState("fixed"),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  function edit(l = {}) {
    setEditing(l);
    setProject(l.project_id || data?.projects?.[0]?.id || "");
    setAmountMode(l.amount_mode || "fixed");
    setFormError("");
  }
  return (
    <>
      <PageHeading
        title="收款链接"
        description="创建可以分享的收款页，让客户自主发起付款。"
      >
        <button className="button primary" onClick={() => edit()}>
          <Plus size={16} />
          创建收款链接
        </button>
      </PageHeading>
      <section className="panel">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : data?.links?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>金额</th>
                  <th>状态</th>
                  <th>统计</th>
                  <th>创建时间</th>
                  <th>分享</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.links.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <b>{l.name}</b>
                      <small className="cell-sub">{l.title}</small>
                    </td>
                    <td>
                      {l.amount_mode === "fixed" ? (
                        <Money value={l.amount} currency={l.currency} />
                      ) : (
                        <span className="muted">买家输入 · {l.currency}</span>
                      )}
                    </td>
                    <td>
                      <Badge status={l.enabled ? "paid" : "expired"}>
                        {l.enabled ? "启用中" : "已停用"}
                      </Badge>
                    </td>
                    <td>
                      {l.order_count || 0} 单
                      <small className="cell-sub">
                        已支付 {l.paid_count || 0}
                      </small>
                    </td>
                    <td className="muted">{date(l.created_at)}</td>
                    <td>
                      <div className="table-actions">
                        <Link
                          to={l.url || `/pay/${l.id}`}
                          className="table-link"
                        >
                          预览
                        </Link>
                        <CopyButton
                          value={
                            new URL(l.url || `/pay/${l.id}`, location.origin)
                              .href
                          }
                          label="复制收款链接"
                        />
                      </div>
                    </td>
                    <td>
                      <div className="table-actions">
                        <button className="table-link" onClick={() => edit(l)}>
                          编辑
                        </button>
                        <button
                          className="table-link"
                          onClick={async () => {
                            try {
                              await mutate(
                                `/api/payment-links/${l.id}`,
                                { enabled: !l.enabled },
                                "PATCH",
                              );
                              notify(l.enabled ? "链接已停用" : "链接已启用");
                              reload();
                            } catch (e) {
                              notify(e.message, "error");
                            }
                          }}
                        >
                          {l.enabled ? "停用" : "启用"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={Link2}
            title="暂无收款链接"
            description="创建链接并分享给客户，支持固定金额或由买家填写金额。"
            action={
              <button className="button primary" onClick={() => edit()}>
                创建收款链接
              </button>
            }
          />
        )}
      </section>
      {editing && (
        <Modal
          title={editing.id ? "编辑收款链接" : "创建收款链接"}
          description="链接中的买家标题和说明会展示在公开付款页。"
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setFormError("");
              try {
                const f = Object.fromEntries(new FormData(e.currentTarget));
                await mutate(
                  editing.id
                    ? `/api/payment-links/${editing.id}`
                    : "/api/payment-links",
                  {
                    ...f,
                    project_id: project,
                    amount_mode: amountMode,
                    amount: amountMode === "fixed" ? f.amount : null,
                  },
                  editing.id ? "PATCH" : "POST",
                );
                setEditing(null);
                notify("收款链接已保存");
                reload();
              } catch (e) {
                setFormError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <InlineError error={formError} />
            <Field label="所属项目">
              <ProjectSelect
                projects={data?.projects || []}
                value={project}
                onChange={setProject}
              />
            </Field>
            <Field label="内部名称">
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={editing.name || ""}
                placeholder="仅用于商户后台识别"
              />
            </Field>
            <Field label="买家标题">
              <input
                name="title"
                required
                maxLength={120}
                defaultValue={editing.title || ""}
                placeholder="例如：数字创作服务"
              />
            </Field>
            <Field label="买家说明">
              <textarea
                name="description"
                rows={2}
                maxLength={500}
                defaultValue={editing.description || ""}
                placeholder="说明付款用途或交付方式"
              />
            </Field>
            <Field label="金额模式">
              <div className="segmented">
                <button
                  type="button"
                  className={amountMode === "fixed" ? "active" : ""}
                  onClick={() => setAmountMode("fixed")}
                >
                  固定金额
                </button>
                <button
                  type="button"
                  className={amountMode === "custom" ? "active" : ""}
                  onClick={() => setAmountMode("custom")}
                >
                  买家输入金额
                </button>
              </div>
            </Field>
            <div className="form-row">
              {amountMode === "fixed" && (
                <Field label="金额">
                  <input
                    name="amount"
                    inputMode="decimal"
                    required
                    pattern="[0-9]+(\.[0-9]{1,8})?"
                    defaultValue={editing.amount || ""}
                    placeholder="9.90"
                  />
                </Field>
              )}
              <Field label="计价币种">
                <select
                  name="currency"
                  defaultValue={editing.currency || "USD"}
                >
                  <option>USD</option>
                  <option>CNY</option>
                  <option>EUR</option>
                  <option>USDT</option>
                  <option>USDC</option>
                </select>
              </Field>
            </div>
            <FormFooter
              busy={busy}
              onClose={() => setEditing(null)}
              text="保存收款链接"
            />
          </form>
        </Modal>
      )}
    </>
  );
}

function PaymentLinkPage({ id }) {
  const { data, loading, error, reload } = useLoad(
    () => api(`/pay/${encodeURIComponent(id)}/state`),
    [id],
  );
  const [busy, setBusy] = useState(false),
    [formError, setFormError] = useState(""),
    [amount, setAmount] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID());
  return (
    <div className="checkout-page">
      <header>
        <Logo />
        <span>
          <ShieldCheck size={15} />
          安全收款链接
        </span>
      </header>
      <main className="checkout-main">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : (
          <>
            <div className="checkout-merchant">
              <span className="store-avatar">
                {(data.merchant_name || "D")[0]}
              </span>
              <div>
                <b>{data.merchant_name || "商户收款"}</b>
                <small>公开收款链接</small>
              </div>
            </div>
            {data.mode === "demo" && (
              <div className="checkout-demo">
                <TriangleAlert size={17} />
                <div>
                  <b>演示链接，请勿实际转账</b>
                  <span>用于测试自主建单与收银台流程。</span>
                </div>
              </div>
            )}
            <section className="checkout-panel public-pay-panel">
              <span className="pay-link-icon">
                <Link2 size={24} />
              </span>
              <h1>{data.title}</h1>
              <p>{data.description || "请选择金额并继续前往收银台。"}</p>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setFormError("");
                  try {
                    const r = await mutate(
                      `/pay/${encodeURIComponent(id)}/orders`,
                      {
                        ...(data.amount_mode === "custom" ? { amount } : {}),
                        idempotency_key: key,
                      },
                    );
                    go(checkoutPath(r.order || r));
                  } catch (e) {
                    setFormError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <InlineError error={formError} />
                {data.amount_mode === "fixed" ? (
                  <div className="public-pay-amount">
                    <small>付款金额</small>
                    <strong>
                      <Money value={data.amount} currency={data.currency} />
                    </strong>
                  </div>
                ) : (
                  <Field label={`付款金额（${data.currency}）`}>
                    <input
                      required
                      inputMode="decimal"
                      pattern="[0-9]+(\.[0-9]{1,8})?"
                      placeholder="输入付款金额"
                      value={amount}
                      onChange={(e) => {
                        setAmount(e.target.value);
                        setKey(crypto.randomUUID());
                      }}
                    />
                  </Field>
                )}
                <button
                  className="button primary full"
                  disabled={busy || data.available === false}
                >
                  {busy ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Wallet size={16} />
                  )}
                  继续付款
                  <ArrowRight size={15} />
                </button>
                {data.available === false && (
                  <p className="field-hint">
                    商户尚未配置可用收款方式，请稍后再试。
                  </p>
                )}
              </form>
              <div className="pay-link-secure">
                <ShieldCheck size={13} />
                资金直达商户自有钱包
              </div>
            </section>
          </>
        )}
      </main>
      <footer>由 Avenora Pay 提供 · 非托管收款</footer>
    </div>
  );
}

function RefundForm({ order, onClose, onDone }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { notify } = useApp();
  return (
    <Modal
      title="记录退款"
      description="仅登记已经在外部完成的退款，不会转出任何资产。"
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await mutate("/api/refunds", {
              ...Object.fromEntries(new FormData(e.currentTarget)),
              order_id: order.order_id || order.id,
            });
            notify("退款记录已保存（未经链上核验）");
            onDone?.();
            onClose();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <InlineError error={error} />
        <div className="secret-box">
          <small>已付款订单</small>
          <code>{order.merchant_order_id || order.order_id}</code>
        </div>
        <Field
          label={`退款金额（${tokenSymbol(order) || "链上币种"}）`}
          help="填写已实际退回的链上币量，不是法币计价金额。"
        >
          <input
            name="amount"
            required
            inputMode="decimal"
            pattern="[0-9]+(\.[0-9]{1,18})?"
            placeholder="例如 9.9001"
          />
        </Field>
        <Field label="退款交易哈希">
          <input
            name="tx_hash"
            required
            autoComplete="off"
            spellCheck="false"
            placeholder="外部退款交易的哈希"
          />
        </Field>
        <Field label="备注">
          <textarea name="note" rows={2} maxLength={500} />
        </Field>
        <div className="field-hint">
          本记录不代表平台已核验退款到账。请先自行确认外部退款结果。
        </div>
        <FormFooter busy={busy} onClose={onClose} text="登记退款" />
      </form>
    </Modal>
  );
}
function Refunds() {
  const { notify } = useApp();
  const { data, loading, error, reload } = useLoad(() => api("/api/refunds"));
  const [voiding, setVoiding] = useState(null),
    [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeading
        title="退款"
        description="仅记录商户自行完成的外部退款，平台不发起转账。"
      >
        <button
          className="button secondary"
          disabled={loading || !data?.refunds?.length}
          title="仅导出当前项目下已加载的退款记录"
          onClick={() => {
            const rows = data.refunds;
            downloadCsv(
              `退款-当前筛选-${new Date().toLocaleDateString("sv-SE")}.csv`,
              [
                "退款ID",
                "订单ID",
                "商户订单号",
                "网络",
                "代币",
                "退款金额",
                "状态",
                "核验状态",
                "退款交易哈希",
                "备注",
                "创建时间",
              ],
              rows.map((r) => [
                r.id,
                r.order_id,
                r.merchant_order_id,
                r.chain,
                r.token_id,
                r.amount,
                r.status,
                r.verification_status,
                r.tx_hash,
                r.note,
                r.created_at,
              ]),
            );
            notify(`已导出当前加载的 ${rows.length} 条退款记录`);
          }}
        >
          <FileText size={15} />
          导出当前筛选 CSV
        </button>
        <Link to="/merchant/orders" className="button secondary">
          前往已付款订单
          <ArrowRight size={15} />
        </Link>
      </PageHeading>
      <div className="info-note compact">
        <CircleHelp size={18} />
        <p>
          在已支付订单详情中选择「记录退款」。记录不会改变原支付状态，作废也不会撤回链上转账。
        </p>
      </div>
      <section className="panel">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : data?.refunds?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>订单号 / 商户订单号</th>
                  <th>代币</th>
                  <th>退款金额</th>
                  <th>状态</th>
                  <th>退款交易</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.refunds.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <code>{clip(r.order_id, 9)}</code>
                      <small className="cell-sub">
                        {r.merchant_order_id || "—"}
                      </small>
                    </td>
                    <td>
                      <span className="chain-cell">
                        <ChainIcon chain={r.chain} size={22} />
                        <span>
                          <b>{tokenSymbol(r)}</b>
                          <small className="cell-sub">
                            {CHAIN_NAMES[r.chain] || r.chain}
                          </small>
                        </span>
                      </span>
                    </td>
                    <td className="money">{displayAmount(r.amount)}</td>
                    <td>
                      <Badge status={r.status} />
                      <small className="cell-sub">未核验外部转账</small>
                    </td>
                    <td>
                      <span className="address-code">
                        <code title={r.tx_hash}>{clip(r.tx_hash, 8)}</code>
                        <CopyButton value={r.tx_hash} />
                      </span>
                    </td>
                    <td className="muted">{date(r.created_at)}</td>
                    <td>
                      {r.status === "recorded" && (
                        <button
                          className="table-link danger-text"
                          onClick={() => setVoiding(r)}
                        >
                          作废记录
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={ArrowDownLeft}
            title="暂无退款记录"
            description="在已支付订单的详情页登记已经完成的退款。"
          />
        )}
      </section>
      {Boolean(data?.refunds?.length) && (
        <p className="export-scope-note">
          导出仅包含当前项目筛选下已加载的 {data.refunds.length}{" "}
          条退款记录，不包含未加载的数据。
        </p>
      )}
      {voiding && (
        <Modal
          title="作废退款记录"
          description="这会将记录标为作废，保留原始记录以便核对，不会执行任何转账。"
          onClose={() => setVoiding(null)}
        >
          <div className="secret-box">
            <small>退款金额</small>
            <code>
              {displayAmount(voiding.amount)} {tokenSymbol(voiding)} ·{" "}
              {CHAIN_NAMES[voiding.chain] || voiding.chain}
            </code>
          </div>
          <div className="form-footer">
            <button
              className="button secondary"
              onClick={() => setVoiding(null)}
            >
              保留记录
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await mutate(`/api/refunds/${voiding.id}/void`);
                  setVoiding(null);
                  notify("退款记录已作废");
                  reload();
                } catch (e) {
                  notify(e.message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认作废
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

const LIMIT_LABELS = {
  projects: "项目",
  addresses: "收款地址",
  addresses_per_project: "单项目地址",
  api_keys: "API 密钥",
  endpoints: "Webhook 接收端",
  payment_links: "收款链接",
  products: "商品",
  monthly_paid: "本月已支付订单",
  monthly_paid_soft: "本月订单提醒阈值",
  monthly_gmv: "本月计费金额（USD）",
  monthly_gmv_soft: "计费金额提醒阈值（USD）",
  active_orders: "同时待处理订单",
  api_requests: "API 请求 / 分钟",
};
function PlanCard({
  plan,
  current = false,
  disabled = false,
  busy = false,
  onChoose,
  buttonText,
}) {
  return (
    <article className={`pricing-card ${plan.id === "pro" ? "featured" : ""}`}>
      {plan.id === "pro" && <span className="recommended">专业业务</span>}
      <small>{plan.id.toUpperCase()}</small>
      <h2>{plan.name}</h2>
      <div className="plan-price">
        <Money value={plan.price} currency={plan.currency} />
        <span>/ 月</span>
      </div>
      <p>{current ? "当前生效套餐" : "按月付费，支付确认后开通"}</p>
      <button
        className={`button ${plan.id === "pro" ? "primary" : "secondary"} full`}
        disabled={disabled || busy}
        onClick={onChoose}
      >
        {busy ? <LoaderCircle size={14} className="spin" /> : null}
        {buttonText ||
          (current
            ? "续费当前套餐"
            : plan.id === "free"
              ? "免费计划"
              : "选择套餐")}
        <ArrowRight size={14} />
      </button>
      <ul>
        {[
          "projects",
          "addresses",
          "addresses_per_project",
          "api_keys",
          "endpoints",
          "payment_links",
          "monthly_paid",
          "monthly_gmv",
          "api_requests",
        ]
          .filter((k) => plan.limits?.[k] !== undefined)
          .map((k) => (
            <li key={k}>
              <Check size={14} />
              {LIMIT_LABELS[k]}
              <b>{Number(plan.limits[k]).toLocaleString()}</b>
            </li>
          ))}
      </ul>
    </article>
  );
}
function invoicePath(invoice) {
  return invoice.checkout_url
    ? `${checkoutPath(invoice)}?invoice=${encodeURIComponent(invoice.id)}`
    : null;
}
function Usage() {
  const { notify, public_demo: publicDemo } = useApp();
  const { data, loading, error, reload } = useLoad(() =>
    api("/api/subscription"),
  );
  const [buying, setBuying] = useState(null);
  async function buy(p) {
    if (
      ["active", "grace"].includes(data?.subscription?.status) &&
      data.subscription.effective_plan_id !== p.id
    ) {
      notify("当前套餐生效期间可续费同档套餐，到期后可更换档位。", "error");
      return;
    }
    setBuying(p.id);
    try {
      const r = await mutate("/api/billing/checkout", {
        plan_id: p.id,
        idempotency_key: crypto.randomUUID(),
      });
      go(
        invoicePath({
          ...r.invoice,
          checkout_url: r.checkout_url || r.invoice?.checkout_url,
        }),
      );
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setBuying(null);
    }
  }
  return (
    <>
      <PageHeading
        title="套餐与用量"
        description="查看当前订阅、资源用量，并选择适合的套餐。"
      >
        <Link to="/merchant/billing" className="button secondary">
          <FileText size={15} />
          账单历史
        </Link>
      </PageHeading>
      {loading ? (
        <Spinner />
      ) : error ? (
        <ResourceError error={error} onRetry={reload} />
      ) : (
        <>
          <section className="panel subscription-card">
            <div className="subscription-heading">
              <span className="plan-overview-icon">
                <Layers size={25} />
              </span>
              <div>
                <small>当前套餐</small>
                <h2>{data.plan?.name || "免费计划"}</h2>
              </div>
              <Badge
                status={
                  data.subscription?.status === "active"
                    ? "paid"
                    : data.subscription?.status === "grace"
                      ? "pending"
                      : data.subscription?.status === "expired"
                        ? "expired"
                        : "pending"
                }
              >
                {data.subscription?.status === "active"
                  ? "生效中"
                  : data.subscription?.status === "grace"
                    ? "宽限期"
                    : data.subscription?.status === "expired"
                      ? "已到期"
                      : "免费计划"}
              </Badge>
            </div>
            <div className="subscription-meta">
              <div>
                <small>计费周期</small>
                <b>按月</b>
              </div>
              <div>
                <small>开始时间</small>
                <b>{date(data.subscription?.starts_at)}</b>
              </div>
              <div>
                <small>到期时间</small>
                <b>{date(data.subscription?.expires_at)}</b>
              </div>
              <div>
                <small>宽限截止</small>
                <b>{date(data.subscription?.grace_until)}</b>
              </div>
              <div>
                <small>开通方式</small>
                <b>
                  {data.subscription?.source === "payment"
                    ? "付款开通"
                    : data.subscription?.source === "admin_grant"
                      ? "平台赠送"
                      : data.subscription?.source === "demo_payment"
                        ? "演示付款"
                        : data.subscription?.source === "default"
                          ? "默认免费"
                          : "平台开通"}
                </b>
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>本期用量</h2>
                <p>
                  实际资源用量与当前生效套餐上限。提醒阈值用于提示，硬上限用于控制额度。
                </p>
              </div>
              <button
                className="icon-button"
                onClick={reload}
                aria-label="刷新用量"
              >
                <RefreshCw size={16} />
              </button>
            </div>
            <div className="quota-grid">
              {Object.entries(data.usage || {}).map(([key, u]) => (
                <div key={key}>
                  <div>
                    <span>{LIMIT_LABELS[key] || key}</span>
                    <b>
                      {Number(u.used || 0).toLocaleString()}{" "}
                      <small>/ {Number(u.limit || 0).toLocaleString()}</small>
                    </b>
                  </div>
                  <div
                    className={`quota-track ${u.used >= u.limit ? "full" : ""}`}
                  >
                    <i
                      style={{
                        width: `${u.limit > 0 ? Math.min(100, (u.used / u.limit) * 100) : u.used > 0 ? 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {data.billing_mode === "demo" && (
              <p className="gmv-note">
                演示空间不执行真实额度限制，示例数据可能高于免费计划额度。
                {publicDemo &&
                  "公开演示另有每空间 100 笔订单、1000 条库存等体验上限。"}
              </p>
            )}
            <p className="gmv-note">
              计费用量按订单锁定的 USD
              报价折算，包含付款尾数；稳定币采用配置的计价规则。仅用于套餐额度，不是实时资产估值。
            </p>
          </section>
          <div className="section-heading-row">
            <div>
              <h2>选择套餐</h2>
              <p>
                {data.billing_mode === "demo"
                  ? "当前为演示订阅，只验证计费流程，不会实际转账。"
                  : "订阅款进入平台运营方的收款地址，支付确认后自动生效。"}
              </p>
            </div>
          </div>
          {!data.billing_enabled && (
            <div className="info-note compact">
              <CircleHelp size={17} />
              <p>{data.billing_unavailable_reason || "平台暂未启用订阅收费"}</p>
            </div>
          )}
          {["active", "grace"].includes(data.subscription?.status) && (
            <div className="info-note compact">
              <Clock3 size={17} />
              <p>
                当前套餐有效期及宽限期内支持同档续费；更换档位需等待当前订阅结束。
              </p>
            </div>
          )}
          <div className="pricing-grid merchant-pricing">
            {(data.plans || []).map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                current={data.subscription?.effective_plan_id === p.id}
                disabled={
                  p.id === "free" ||
                  !data.billing_enabled ||
                  Boolean(buying) ||
                  (["active", "grace"].includes(data.subscription?.status) &&
                    data.subscription.effective_plan_id !== p.id)
                }
                busy={buying === p.id}
                onChoose={() => buy(p)}
                buttonText={
                  p.id === "free"
                    ? "默认免费计划"
                    : !data.billing_enabled
                      ? "尚未开启收费"
                      : ["active", "grace"].includes(
                            data.subscription?.status,
                          ) && data.subscription.effective_plan_id !== p.id
                        ? "订阅结束后可换档"
                        : ["active", "grace"].includes(
                              data.subscription?.status,
                            ) && data.subscription.effective_plan_id === p.id
                          ? "续费当前套餐"
                          : data.billing_mode === "demo"
                            ? "体验订阅支付"
                            : undefined
                }
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
function InvoiceTable({ invoices = [], admin = false, reload }) {
  const { notify } = useApp();
  const [busy, setBusy] = useState(null);
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>账单</th>
            {admin && <th>商户</th>}
            <th>套餐</th>
            <th>金额</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td>
                <code>{clip(i.id, 9)}</code>
                <small className="cell-sub">
                  {i.mode === "demo" ? "演示账单" : "订阅账单"}
                </small>
              </td>
              {admin && <td>{i.merchant_name || clip(i.merchant_id, 8)}</td>}
              <td>{i.plan_name || i.plan_id}</td>
              <td className="money">
                <Money value={i.amount} currency={i.currency} />
              </td>
              <td>
                <Badge status={i.status} />
                {i.status === "paid" && (
                  <small className="cell-sub">{date(i.paid_at)}</small>
                )}
              </td>
              <td className="muted">{date(i.created_at)}</td>
              <td>
                <div className="table-actions">
                  {i.checkout_url && (
                    <Link to={invoicePath(i)} className="table-link">
                      {i.status === "pending" ? "前往付款" : "查看回执"}
                    </Link>
                  )}
                  {!admin && i.mode === "demo" && i.status === "pending" && (
                    <button
                      className="table-link"
                      disabled={busy === i.id}
                      onClick={async () => {
                        setBusy(i.id);
                        try {
                          await mutate(
                            `/api/billing/invoices/${i.id}/simulate`,
                          );
                          notify("演示订阅付款已确认");
                          reload?.();
                        } catch (e) {
                          notify(e.message, "error");
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      模拟付款
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Billing() {
  const { data, loading, error, reload } = useLoad(() => api("/api/billing"));
  return (
    <>
      <PageHeading title="账单历史" description="查看套餐订阅账单与支付结果。">
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          刷新
        </button>
        <Link to="/merchant/usage" className="button primary">
          查看套餐
          <ArrowRight size={15} />
        </Link>
      </PageHeading>
      <section className="panel">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : data?.invoices?.length ? (
          <InvoiceTable invoices={data.invoices} reload={reload} />
        ) : (
          <Empty
            icon={FileText}
            title="暂无账单"
            description="选择付费套餐后，订阅账单会出现在这里。"
          />
        )}
      </section>
    </>
  );
}
function PlatformPlans() {
  const { notify } = useApp();
  const { data, loading, error, reload } = useLoad(() =>
    api("/api/platform/plans"),
  );
  const [edit, setEdit] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  return (
    <>
      <PageHeading
        title="套餐管理"
        description="设置平台对外提供的套餐价格、额度与开放状态。"
      />
      <section className="panel">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>套餐</th>
                  <th>月费</th>
                  <th>状态</th>
                  <th>项目 / 地址</th>
                  <th>本月订单上限</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data?.plans?.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.name}</b>
                      <small className="cell-sub">{p.id}</small>
                    </td>
                    <td>
                      <Money value={p.price} currency={p.currency} />
                    </td>
                    <td>
                      <Badge status={p.enabled ? "paid" : "expired"}>
                        {p.enabled ? "开放中" : "已关闭"}
                      </Badge>
                    </td>
                    <td>
                      {p.limits?.projects} / {p.limits?.addresses}
                    </td>
                    <td>
                      {Number(p.limits?.monthly_paid || 0).toLocaleString()}
                    </td>
                    <td>
                      <button
                        className="table-link"
                        onClick={() => {
                          setEdit(p);
                          setFormError("");
                        }}
                      >
                        编辑套餐
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {edit && (
        <Modal
          title={`编辑套餐 · ${edit.name}`}
          description="价格与额度由服务端校验，保存后用于后续订阅与额度检查。"
          onClose={() => setEdit(null)}
          wide
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setFormError("");
              try {
                const f = Object.fromEntries(new FormData(e.currentTarget));
                const limits = Object.fromEntries(
                  Object.keys(edit.limits || {}).map((k) => [
                    k,
                    Number(f[`limit_${k}`]),
                  ]),
                );
                await mutate(
                  "/api/platform/plans",
                  {
                    id: edit.id,
                    name: f.name,
                    price: f.price,
                    enabled: f.enabled === "on",
                    limits,
                  },
                  "PATCH",
                );
                setEdit(null);
                notify("套餐已更新");
                reload();
              } catch (e) {
                setFormError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <InlineError error={formError} />
            <div className="form-row">
              <Field label="套餐名称">
                <input name="name" required defaultValue={edit.name} />
              </Field>
              <Field label="每月价格（USD）">
                <input
                  name="price"
                  inputMode="decimal"
                  required
                  pattern="[0-9]+(\.[0-9]{1,2})?"
                  defaultValue={edit.price}
                />
              </Field>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={edit.enabled}
              />
              对商户开放此套餐
            </label>
            <div className="admin-limit-grid">
              {Object.entries(edit.limits || {}).map(([k, v]) => (
                <Field key={k} label={LIMIT_LABELS[k] || k}>
                  <input
                    type="number"
                    min="0"
                    max="10000000"
                    step="1"
                    required
                    name={`limit_${k}`}
                    defaultValue={v}
                  />
                </Field>
              ))}
            </div>
            <FormFooter
              busy={busy}
              onClose={() => setEdit(null)}
              text="保存套餐"
            />
          </form>
        </Modal>
      )}
    </>
  );
}
function PlatformMerchants() {
  const { notify } = useApp();
  const { data, loading, error, reload } = useLoad(async () => {
    const [m, p] = await Promise.all([
      api("/api/platform/merchants"),
      api("/api/platform/plans"),
    ]);
    return { ...m, ...p };
  });
  const [grant, setGrant] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState(""),
    [query, setQuery] = useState("");
  const merchants = (data?.merchants || []).filter((m) =>
    `${m.name} ${m.email}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        title="商户管理"
        description="查看商户账户、订阅状态与使用情况。"
      >
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          刷新
        </button>
      </PageHeading>
      <section className="panel">
        <div className="list-toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="搜索商户"
              placeholder="搜索名称或邮箱"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="muted text-small">{merchants.length} 个商户</span>
        </div>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : merchants.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>商户</th>
                  <th>环境</th>
                  <th>套餐</th>
                  <th>到期时间</th>
                  <th>项目 / 地址 / 月订单</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {merchants.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <b>{m.name}</b>
                      <small className="cell-sub">{m.email}</small>
                    </td>
                    <td>
                      <Badge status={m.mode === "demo" ? "pending" : "paid"}>
                        {m.mode === "demo" ? "演示" : "真实"}
                      </Badge>
                    </td>
                    <td>
                      {m.plan?.name ||
                        m.subscription?.effective_plan_id ||
                        "免费"}
                    </td>
                    <td>{date(m.subscription?.expires_at)}</td>
                    <td>
                      {m.usage?.projects?.used || 0} /{" "}
                      {m.usage?.addresses?.used || 0} /{" "}
                      {m.usage?.monthly_paid?.used || 0}
                    </td>
                    <td>
                      <button
                        className="table-link"
                        onClick={() => {
                          setGrant(m);
                          setFormError("");
                        }}
                      >
                        赠送套餐
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={UserRound} title="没有匹配的商户" />
        )}
      </section>
      {grant && (
        <Modal
          title={`赠送套餐 · ${grant.name}`}
          description="这是一笔管理员赠送，不会生成已付款账单或发起资金转账。"
          onClose={() => setGrant(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setFormError("");
              try {
                const f = Object.fromEntries(new FormData(e.currentTarget));
                await mutate(`/api/platform/merchants/${grant.id}/grant`, {
                  ...f,
                  days: Number(f.days),
                });
                setGrant(null);
                notify("赠送已记录");
                reload();
              } catch (e) {
                setFormError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <InlineError error={formError} />
            <Field label="赠送套餐">
              <select name="plan_id" required>
                {data?.plans
                  ?.filter((p) => p.id !== "free")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="天数">
              <input
                type="number"
                name="days"
                min="1"
                max="366"
                step="1"
                required
                defaultValue="30"
              />
            </Field>
            <Field label="赠送原因">
              <textarea
                name="reason"
                required
                rows={3}
                maxLength={500}
                placeholder="记录赠送原因，便于后续核对"
              />
            </Field>
            <FormFooter
              busy={busy}
              onClose={() => setGrant(null)}
              text="确认赠送"
            />
          </form>
        </Modal>
      )}
    </>
  );
}
function PlatformInvoices() {
  const { data, loading, error, reload } = useLoad(() =>
    api("/api/platform/invoices"),
  );
  return (
    <>
      <PageHeading
        title="订阅账单"
        description="查看平台所有商户的订阅付款记录。"
      >
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          刷新
        </button>
      </PageHeading>
      <section className="panel">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : data?.invoices?.length ? (
          <InvoiceTable invoices={data.invoices} admin reload={reload} />
        ) : (
          <Empty icon={FileText} title="暂无订阅账单" />
        )}
      </section>
    </>
  );
}

function ProjectSettings() {
  const { notify, activeProjectId } = useApp();
  const {
    data: projectsData,
    loading: projectsLoading,
    error: projectsError,
    reload: reloadProjects,
  } = useLoad(() => api("/api/projects"));
  const [project, setProject] = useState(activeProjectId || ""),
    [settings, setSettings] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [feeEnabled, setFeeEnabled] = useState(false),
    [feePercent, setFeePercent] = useState("0.00"),
    [logo, setLogo] = useState(null);
  useEffect(() => {
    if (!project && projectsData?.projects?.length)
      setProject(projectsData.projects[0].id);
  }, [projectsData]);
  useEffect(() => {
    if (!project) return;
    let active = true;
    setLoading(true);
    setError("");
    api(`/api/project-settings/${project}`)
      .then((s) => {
        if (!active) return;
        setSettings(s);
        setFeeEnabled(s.fee_enabled);
        setFeePercent(s.fee_percent);
        setLogo(s.logo_data_url);
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [project]);
  const p = projectsData?.projects?.find((x) => x.id === project);
  async function save(body) {
    setBusy(true);
    setError("");
    try {
      const r = await mutate(`/api/project-settings/${project}`, body, "PATCH");
      setSettings(r);
      notify("项目设置已保存");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="项目设置"
        description="管理收银台展示信息与商户手续费。"
      >
        <div className="project-page-select">
          <ProjectSelect
            projects={projectsData?.projects || []}
            value={project}
            onChange={setProject}
          />
        </div>
      </PageHeading>
      {projectsLoading || loading ? (
        <Spinner />
      ) : projectsError ? (
        <ResourceError error={projectsError} onRetry={reloadProjects} />
      ) : !project ? (
        <section className="panel">
          <Empty
            icon={FolderKanban}
            title="请先创建项目"
            action={
              <Link className="button primary" to="/merchant/projects">
                前往项目管理
              </Link>
            }
          />
        </section>
      ) : (
        <>
          <InlineError error={error} />
          {settings && (
            <>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>基础设置</h2>
                    <p>这些信息会展示在面向买家的收银台。</p>
                  </div>
                </div>
                <form
                  className="project-settings-form"
                  key={project}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = Object.fromEntries(new FormData(e.currentTarget));
                    setBusy(true);
                    setError("");
                    try {
                      if (f.name !== p.name) {
                        await mutate(
                          `/api/projects/${project}`,
                          { name: f.name },
                          "PATCH",
                        );
                        reloadProjects();
                      }
                      const r = await mutate(
                        `/api/project-settings/${project}`,
                        {
                          display_name: f.display_name,
                          support_email: f.support_email,
                          logo_data_url: logo,
                        },
                        "PATCH",
                      );
                      setSettings(r);
                      notify("基础设置已保存");
                    } catch (e) {
                      setError(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Field label="项目名称">
                    <input
                      name="name"
                      defaultValue={p?.name || ""}
                      required
                      maxLength={80}
                    />
                  </Field>
                  <Field label="收银台展示名">
                    <input
                      name="display_name"
                      defaultValue={settings.display_name || p?.name || ""}
                      required
                      maxLength={120}
                    />
                  </Field>
                  <Field label="收银台 Logo">
                    <div className="logo-upload">
                      <span className="logo-preview">
                        {logo ? (
                          <img src={logo} alt="收银台 Logo 预览" />
                        ) : (
                          <ShoppingBag size={24} />
                        )}
                      </span>
                      <div>
                        <label className="button secondary small upload-label">
                          上传图片
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              if (
                                ![
                                  "image/png",
                                  "image/jpeg",
                                  "image/webp",
                                ].includes(file.type) ||
                                file.size > 256 * 1024
                              ) {
                                notify(
                                  "请选择 256KB 以内的 PNG、JPEG 或 WebP 图片",
                                  "error",
                                );
                                return;
                              }
                              const reader = new FileReader();
                              reader.onload = () =>
                                setLogo(String(reader.result));
                              reader.onerror = () =>
                                notify("图片读取失败", "error");
                              reader.readAsDataURL(file);
                            }}
                          />
                        </label>
                        {logo && (
                          <button
                            type="button"
                            className="table-link"
                            onClick={() => setLogo(null)}
                          >
                            移除图片
                          </button>
                        )}
                        <p>PNG / JPEG / WebP · 最大 256KB</p>
                      </div>
                    </div>
                  </Field>
                  <Field label="支持邮箱">
                    <input
                      name="support_email"
                      type="email"
                      defaultValue={settings.support_email || ""}
                      placeholder="support@example.com"
                    />
                  </Field>
                  <button className="button primary" disabled={busy}>
                    {busy ? "保存中…" : "保存设置"}
                  </button>
                </form>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>商户手续费</h2>
                    <p>按订单金额增加一定比例，由付款方支付。</p>
                  </div>
                </div>
                <form
                  className="project-settings-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save({ fee_enabled: feeEnabled, fee_percent: feePercent });
                  }}
                >
                  <div className="toggle-field">
                    <div>
                      <b>启用自定义手续费</b>
                      <small>保存后对新创建的订单生效。</small>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={feeEnabled}
                      aria-label="启用自定义手续费"
                      className={`switch ${feeEnabled ? "on" : ""}`}
                      onClick={() => setFeeEnabled(!feeEnabled)}
                    >
                      <i />
                    </button>
                  </div>
                  <Field
                    label="手续费率（%）"
                    help="支持 0–10%，最多两位小数。"
                  >
                    <input
                      required
                      value={feePercent}
                      onChange={(e) => setFeePercent(e.target.value)}
                      type="number"
                      min="0"
                      max="10"
                      step="0.01"
                      disabled={!feeEnabled}
                    />
                  </Field>
                  <div className="fee-preview">
                    <b>金额示例</b>
                    <div>
                      <span>基础金额</span>
                      <span>$100.00</span>
                    </div>
                    <div>
                      <span>手续费（{feeEnabled ? feePercent : "0"}%）</span>
                      <span>
                        ${(feeEnabled ? Number(feePercent) || 0 : 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="fee-total">
                      <span>合计</span>
                      <b>
                        $
                        {(
                          100 + (feeEnabled ? Number(feePercent) || 0 : 0)
                        ).toFixed(2)}
                      </b>
                    </div>
                  </div>
                  <button className="button primary" disabled={busy}>
                    {busy ? "保存中…" : "保存手续费设置"}
                  </button>
                </form>
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}

function HeaderProjects() {
  const { activeProjectId, changeProject } = useApp();
  const { data } = useLoad(() => api("/api/projects"));
  return (
    <select
      className="header-project-select"
      aria-label="切换当前项目"
      value={activeProjectId}
      onChange={(e) => changeProject(e.target.value)}
    >
      <option value="">全部项目</option>
      {data?.projects?.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
function AccountSecurity() {
  const { mode, notify, refreshAuth } = useApp();
  const { data, loading, error, reload } = useLoad(() => api("/api/security"));
  const [dialog, setDialog] = useState(null),
    [setup, setSetup] = useState(null),
    [recovery, setRecovery] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  const reset = () => {
    setDialog(null);
    setSetup(null);
    setRecovery(null);
    setFormError("");
  };
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (dialog === "enable" && !setup) {
        setSetup(await mutate("/api/security/totp/start", f));
      } else if (dialog === "enable" && setup) {
        const r = await mutate("/api/security/totp/confirm", f);
        setSetup(null);
        setRecovery(r.recovery_codes || []);
        setDialog("recovery");
        reload();
        notify("两步验证已开启");
      } else if (dialog === "disable") {
        await mutate("/api/security/totp/disable", f);
        reset();
        await refreshAuth();
        go("/merchant/login");
        notify("两步验证已关闭，请重新登录");
      } else {
        await mutate("/api/security/password", f);
        reset();
        await refreshAuth();
        go("/merchant/login");
        notify("密码已更新，请重新登录");
      }
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>账户安全</h2>
            <p>保护商户账户的登录与敏感操作。</p>
          </div>
          <LockKeyhole size={19} />
        </div>
        {loading ? (
          <Spinner />
        ) : error ? (
          <ResourceError error={error} onRetry={reload} />
        ) : (
          <div className="security-list">
            <div>
              <span className="security-icon">
                <KeyRound size={21} />
              </span>
              <div>
                <b>登录密码</b>
                <p>修改后会结束此账户的所有登录会话。</p>
              </div>
              <button
                className="button secondary small"
                disabled={mode === "demo"}
                onClick={() => {
                  setDialog("password");
                  setFormError("");
                }}
              >
                修改密码
              </button>
            </div>
            <div>
              <span className="security-icon">
                <ShieldCheck size={21} />
              </span>
              <div>
                <b>
                  两步验证{" "}
                  <Badge status={data?.totp_enabled ? "paid" : "expired"}>
                    {data?.totp_enabled ? "已开启" : "未开启"}
                  </Badge>
                </b>
                <p>
                  {data?.totp_enabled
                    ? `使用验证器登录，剩余 ${data.recovery_codes_remaining || 0} 个恢复码。`
                    : "启用后，登录时还需要验证器中的一次性验证码。"}
                </p>
              </div>
              <button
                className="button secondary small"
                disabled={mode === "demo"}
                onClick={() => {
                  setDialog(data?.totp_enabled ? "disable" : "enable");
                  setFormError("");
                  setSetup(null);
                }}
              >
                {data?.totp_enabled ? "关闭" : "开启"}
              </button>
            </div>
            {mode === "demo" && (
              <p className="security-demo-note">
                演示空间不提供密码和两步验证修改。创建你自己的本地商户账户后即可使用。
              </p>
            )}
          </div>
        )}
      </section>
      {dialog && (
        <Modal
          title={
            dialog === "password"
              ? "修改登录密码"
              : dialog === "disable"
                ? "关闭两步验证"
                : dialog === "recovery"
                  ? "保存恢复码"
                  : "开启两步验证"
          }
          description={
            dialog === "recovery"
              ? "恢复码只展示一次。请保存到安全位置，每个恢复码只能使用一次。"
              : dialog === "enable"
                ? "在验证器中添加此账户，再输入生成的验证码完成设置。"
                : "请验证当前账户，完成后需要重新登录。"
          }
          onClose={reset}
        >
          {dialog === "recovery" ? (
            <>
              <div className="recovery-codes">
                {recovery?.map((c) => (
                  <code key={c}>{c}</code>
                ))}
              </div>
              <button
                className="button secondary full"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(recovery.join("\n"));
                    notify("恢复码已复制");
                  } catch {
                    notify("无法访问剪贴板，请手动保存", "error");
                  }
                }}
              >
                <Copy size={15} />
                复制恢复码
              </button>
              <button
                className="button primary full recovery-done"
                onClick={reset}
              >
                我已妥善保存
              </button>
            </>
          ) : (
            <form onSubmit={submit}>
              <InlineError error={formError} />
              {!setup ? (
                <Field label="当前密码">
                  <input
                    type="password"
                    name="current_password"
                    required
                    autoComplete="current-password"
                  />
                </Field>
              ) : (
                <div className="totp-setup">
                  <QR value={setup.otpauth_url} size={180} />
                  <small>无法扫描时，可在验证器中手动添加密钥：</small>
                  <div className="secret-box">
                    <code>{setup.secret}</code>
                    <CopyButton value={setup.secret} />
                  </div>
                </div>
              )}
              {dialog === "password" && (
                <Field label="新密码" help="至少 12 位字符。">
                  <input
                    type="password"
                    name="new_password"
                    minLength={12}
                    required
                    autoComplete="new-password"
                  />
                </Field>
              )}
              {(setup ||
                dialog === "disable" ||
                (dialog === "password" && data?.totp_enabled)) && (
                <Field label="两步验证码或恢复码">
                  <input
                    name="otp"
                    required
                    autoComplete="one-time-code"
                    placeholder="输入验证码"
                  />
                </Field>
              )}
              <FormFooter
                busy={busy}
                onClose={reset}
                text={
                  dialog === "enable"
                    ? setup
                      ? "确认开启"
                      : "生成设置二维码"
                    : dialog === "disable"
                      ? "关闭两步验证"
                      : "保存新密码"
                }
              />
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
