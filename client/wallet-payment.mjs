// Explicit token/precision allowlist matching the application's EVM registry.
const NETWORKS = {
  "0x1": { name: "Ethereum", tokens: { USDT: 6, USDC: 6 } },
  "0x38": { name: "BNB Smart Chain", tokens: { USDT: 18, USDC: 18 } },
  "0x89": { name: "Polygon", tokens: { USDC: 6, USDT0: 6 } },
  "0x2105": { name: "Base", tokens: { USDC: 6 } },
  "0xa4b1": { name: "Arbitrum", tokens: { USDC: 6, USDT0: 6 } },
  "0x2611": { name: "Plasma", tokens: { USDT0: 6 } },
  "0xc4": { name: "X Layer", tokens: { USDT0: 6 } },
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAGIC = "4156454e4f52415f5041595f5245465f5631".padEnd(64, "0");

export class WalletPaymentError extends Error {
  constructor(code, message, mayHaveSubmitted = false) {
    super(message);
    this.name = "WalletPaymentError";
    this.code = code;
    this.mayHaveSubmitted = mayHaveSubmitted;
  }
}
const fail = (code, message, uncertain = false) => {
  throw new WalletPaymentError(code, message, uncertain);
};
export const isTransactionHash = (value) =>
  typeof value === "string" && HASH.test(value);

// Validate the server's exact transaction; never manufacture or round a payment amount.
export function validateWalletPayment(
  payment,
  now = Date.now(),
  expected = {},
) {
  const network = Object.hasOwn(NETWORKS, payment?.chain_id)
    ? NETWORKS[payment.chain_id]
    : null;
  const decimals = network?.tokens?.[payment?.token_symbol];
  if (
    !network ||
    !Number.isInteger(decimals) ||
    payment.token_decimals !== decimals
  )
    fail("INVALID_PAYMENT", "钱包付款信息不完整或网络不受支持，请刷新订单。");
  const amountPattern = new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);
  const scale = 10n ** BigInt(decimals);
  if (
    (expected.chainId !== undefined && expected.chainId !== payment.chain_id) ||
    (expected.symbol !== undefined &&
      expected.symbol !== payment.token_symbol) ||
    (expected.decimals !== undefined && expected.decimals !== decimals)
  )
    fail("INVALID_PAYMENT", "钱包网络或币种与当前订单不一致，请刷新订单。");
  if (
    payment.value !== "0x0" ||
    !ADDRESS.test(payment.to || "") ||
    !ADDRESS.test(payment.recipient || "")
  )
    fail("INVALID_PAYMENT", "付款目标或金额校验失败，请刷新订单。");
  if (
    !/^\d+$/.test(payment.amount_atomic || "") ||
    typeof payment.amount_atomic !== "string" ||
    !amountPattern.test(payment.amount || "") ||
    typeof payment.amount !== "string"
  )
    fail("INVALID_PAYMENT", "付款金额格式无效，请刷新订单。");
  const atomic = BigInt(payment.amount_atomic);
  const [whole, fraction = ""] = payment.amount.split(".");
  if (
    atomic <= 0n ||
    atomic >= 2n ** 256n ||
    BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0")) !== atomic
  )
    fail("INVALID_PAYMENT", "付款金额不一致，请刷新订单。");
  if (expected.amount !== undefined) {
    if (
      typeof expected.amount !== "string" ||
      !amountPattern.test(expected.amount)
    )
      fail("INVALID_PAYMENT", "订单显示金额无效，请刷新订单。");
    const [expectedWhole, expectedFraction = ""] = expected.amount.split(".");
    if (
      BigInt(expectedWhole) * scale +
        BigInt(expectedFraction.padEnd(decimals, "0")) !==
      atomic
    )
      fail("INVALID_PAYMENT", "钱包付款金额与当前订单不一致，请刷新订单。");
  }
  if (
    expected.recipient !== undefined &&
    (typeof expected.recipient !== "string" ||
      expected.recipient.toLowerCase() !== payment.recipient.toLowerCase())
  )
    fail("INVALID_PAYMENT", "钱包收款地址与当前订单不一致，请刷新订单。");
  if (
    !HASH.test(payment.reference || "") ||
    /^0x0{64}$/i.test(payment.reference)
  )
    fail("INVALID_PAYMENT", "订单付款信息无效，请刷新订单。");
  const expectedData =
    "0xa9059cbb" +
    payment.recipient.slice(2).toLowerCase().padStart(64, "0") +
    atomic.toString(16).padStart(64, "0") +
    MAGIC +
    payment.reference.slice(2).toLowerCase();
  if (
    typeof payment.data !== "string" ||
    payment.data.length !== 266 ||
    payment.data.toLowerCase() !== expectedData
  )
    fail("INVALID_PAYMENT", "付款内容与订单不一致，请刷新订单。");
  const expires = Date.parse(payment.expires_at);
  if (!Number.isFinite(expires) || !Number.isFinite(now) || expires <= now)
    fail("PAYMENT_EXPIRED", "已到付款截止，请勿继续付款。");
  return { to: payment.to, data: payment.data, value: "0x0" };
}

// Only a submitted transaction hash is returned. Settlement always belongs to the server.
export async function sendWalletPayment(
  provider,
  payment,
  {
    now = () => Date.now(),
    onStage = () => {},
    expected = {},
    requestTimeoutMs = 120000,
  } = {},
) {
  const transaction = validateWalletPayment(payment, now(), expected);
  if (!provider || typeof provider.request !== "function")
    fail(
      "NO_PROVIDER",
      "未检测到浏览器钱包，请使用 MetaMask、OKX 等支持浏览器钱包的环境打开本页。",
    );
  const targetChain = payment.chain_id;
  const networkName = NETWORKS[targetChain].name;
  const timeoutMs =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : 120000;
  // A timed-out wallet request cannot be cancelled; an uncertain send must never be retried automatically.
  const request = (args) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error("Wallet request timed out"), {
              code: "WALLET_TIMEOUT",
            }),
          ),
        timeoutMs,
      );
      Promise.resolve()
        .then(() => provider.request(args))
        .then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
    });
  let sending = false;
  try {
    onStage("connecting");
    const accounts = await request({ method: "eth_requestAccounts" });
    const from = Array.isArray(accounts) ? accounts[0] : null;
    if (!ADDRESS.test(from || ""))
      fail("NO_ACCOUNT", "钱包尚未连接账户，请连接后重试。");
    let chain = await request({ method: "eth_chainId" });
    if (String(chain).toLowerCase() !== targetChain) {
      onStage("switching");
      await request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChain }],
      });
      chain = await request({ method: "eth_chainId" });
      if (String(chain).toLowerCase() !== targetChain)
        fail("WRONG_CHAIN", `钱包尚未切换至 ${networkName}，请切换后重试。`);
    }
    const currentAccounts = await request({ method: "eth_accounts" });
    if (
      !Array.isArray(currentAccounts) ||
      !ADDRESS.test(currentAccounts[0] || "") ||
      currentAccounts[0].toLowerCase() !== from.toLowerCase()
    )
      fail(
        "ACCOUNT_CHANGED",
        "钱包账户发生变化，请核对当前账户后重新发起付款。",
      );
    if (
      String(await request({ method: "eth_chainId" })).toLowerCase() !==
      targetChain
    )
      fail("WRONG_CHAIN", `钱包网络发生变化，请切换至 ${networkName} 后重试。`);
    validateWalletPayment(payment, now(), expected);
    onStage("confirming");
    sending = true;
    const hash = await request({
      method: "eth_sendTransaction",
      params: [{ from, ...transaction }],
    });
    if (!isTransactionHash(hash))
      fail(
        "SUBMISSION_UNKNOWN",
        "钱包未返回有效交易结果，请先查看钱包记录，勿重复付款。",
        true,
      );
    return { status: "submitted", tx_hash: hash };
  } catch (error) {
    if (error instanceof WalletPaymentError) throw error;
    const code = error?.code ?? error?.data?.originalError?.code;
    if (code === 4001 || code === "4001")
      fail("USER_REJECTED", "你已取消钱包操作，可以在准备好后重试。");
    if (sending)
      fail(
        "SUBMISSION_UNKNOWN",
        "钱包付款结果暂不明确，请先查看钱包交易记录，勿重复付款。",
        true,
      );
    if (code === 4902 || code === "4902")
      fail(
        "NETWORK_UNAVAILABLE",
        `钱包尚未添加 ${networkName}，请在钱包中添加并切换后重试。`,
      );
    if (code === -32002 || code === "-32002")
      fail("REQUEST_PENDING", "钱包中已有请求等待确认，请先处理钱包内的请求。");
    fail(
      "WALLET_UNAVAILABLE",
      "暂时无法连接或切换钱包，请检查钱包状态后重试。",
    );
  }
}
