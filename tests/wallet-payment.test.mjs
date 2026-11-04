import test from "node:test";
import assert from "node:assert/strict";
import {
  sendWalletPayment,
  validateWalletPayment,
} from "../client/wallet-payment.mjs";

const account = "0x" + "11".repeat(20);
const recipient = "0x" + "22".repeat(20);
const contract = "0x" + "33".repeat(20);
const hash = "0x" + "44".repeat(32);
const reference = "0x" + "55".repeat(32);
const time = Date.parse("2030-01-01T00:00:00Z");
const magic = Buffer.from("AVENORA_PAY_REF_V1").toString("hex").padEnd(64, "0");
function payment(overrides = {}) {
  const amount = "1000000000000000000";
  return {
    chain_id: "0x38",
    to: contract,
    recipient,
    token_symbol: "USDT",
    token_decimals: 18,
    amount: "1.0",
    amount_atomic: amount,
    reference,
    value: "0x0",
    data:
      "0xa9059cbb" +
      recipient.slice(2).padStart(64, "0") +
      BigInt(amount).toString(16).padStart(64, "0") +
      magic +
      reference.slice(2),
    expires_at: "2030-01-01T00:10:00Z",
    ...overrides,
  };
}
function wallet(overrides = {}) {
  const calls = [];
  let chain = overrides.chain || "0x38";
  return {
    calls,
    async request(call) {
      calls.push(call);
      if (overrides.request) {
        const result = await overrides.request(call, calls.length);
        if (result !== undefined) return result;
      }
      if (
        call.method === "eth_requestAccounts" ||
        call.method === "eth_accounts"
      )
        return [account];
      if (call.method === "eth_chainId") return chain;
      if (call.method === "wallet_switchEthereumChain") {
        chain = overrides.stuck ? chain : call.params[0].chainId;
        return null;
      }
      if (call.method === "eth_sendTransaction") return hash;
      throw new Error("Unexpected wallet call: " + call.method);
    },
  };
}
const options = { now: () => time };
const sent = (provider) =>
  provider.calls.filter((call) => call.method === "eth_sendTransaction");

test("BSC transfer uses only validated server payload and a connected account, returns submitted not paid", async () => {
  const provider = wallet();
  const p = payment({ from: recipient, gas: "0x1", privateKey: "ignored" });
  const stages = [];
  const result = await sendWalletPayment(provider, p, {
    ...options,
    onStage: (s) => stages.push(s),
  });
  assert.deepEqual(sent(provider), [
    {
      method: "eth_sendTransaction",
      params: [{ from: account, to: p.to, data: p.data, value: "0x0" }],
    },
  ]);
  assert.deepEqual(result, { status: "submitted", tx_hash: hash });
  assert.equal(result.paid, undefined);
  assert.deepEqual(stages, ["connecting", "confirming"]);
  assert.equal(
    provider.calls.some((call) => /approve|sign|sendRaw/i.test(call.method)),
    false,
  );
});

test("switches wrong network and verifies it again before sending", async () => {
  const provider = wallet({ chain: "0x1" });
  await sendWalletPayment(provider, payment(), options);
  assert.deepEqual(
    provider.calls.find((call) => call.method === "wallet_switchEthereumChain")
      .params,
    [{ chainId: "0x38" }],
  );
  assert.equal(sent(provider).length, 1);
  assert.equal(
    provider.calls.filter((call) => call.method === "eth_chainId").length,
    3,
  );
});

test("failed network switch never sends a transaction", async () => {
  const provider = wallet({ chain: "0x1", stuck: true });
  await assert.rejects(sendWalletPayment(provider, payment(), options), {
    code: "WRONG_CHAIN",
  });
  assert.equal(sent(provider).length, 0);
});

test("network or account changing during preparation prevents sending", async () => {
  const changedAccount = wallet({
    request: (call) =>
      call.method === "eth_accounts" ? [recipient] : undefined,
  });
  await assert.rejects(sendWalletPayment(changedAccount, payment(), options), {
    code: "ACCOUNT_CHANGED",
  });
  assert.equal(sent(changedAccount).length, 0);
  let reads = 0;
  const changedChain = wallet({
    request: (call) =>
      call.method === "eth_chainId"
        ? ++reads === 1
          ? "0x38"
          : "0x1"
        : undefined,
  });
  await assert.rejects(sendWalletPayment(changedChain, payment(), options), {
    code: "WRONG_CHAIN",
  });
  assert.equal(sent(changedChain).length, 0);
});

test("wallet rejection at connect, switch, or send is retryable and never treated as paid", async () => {
  for (const method of [
    "eth_requestAccounts",
    "wallet_switchEthereumChain",
    "eth_sendTransaction",
  ]) {
    const provider = wallet({
      chain: method === "wallet_switchEthereumChain" ? "0x1" : "0x38",
      request: (call) => {
        if (call.method === method)
          throw Object.assign(new Error("rejected"), { code: 4001 });
      },
    });
    await assert.rejects(
      sendWalletPayment(provider, payment(), options),
      (e) => e.code === "USER_REJECTED" && e.mayHaveSubmitted === false,
    );
  }
});

test("invalid or unsafe payload is blocked before the wallet is contacted", async () => {
  for (const patch of [
    { value: "0x1" },
    { value: "0x00" },
    { chain_id: "0x1" },
    { token_decimals: 6 },
    { token_symbol: "BNB" },
    { to: "bad" },
    { amount: "1.000000000000000001" },
    { amount_atomic: "1" },
    { amount_atomic: 1000000000000000000 },
    { data: payment().data.replace("a9059cbb", "095ea7b3") },
    { data: payment().data.slice(0, -2) + "66" },
    { data: payment().data + "00" },
    { recipient: account },
    { reference: "0x" + "00".repeat(32) },
  ]) {
    const provider = wallet();
    await assert.rejects(sendWalletPayment(provider, payment(patch), options), {
      code: "INVALID_PAYMENT",
    });
    assert.equal(provider.calls.length, 0);
  }
});

test("keeps all atomic precision without converting token amounts through Number", () => {
  const atomic = "123456789012345678901234567890123456";
  const p = payment({
    amount: "123456789012345678.901234567890123456",
    amount_atomic: atomic,
  });
  p.data =
    "0xa9059cbb" +
    recipient.slice(2).padStart(64, "0") +
    BigInt(atomic).toString(16).padStart(64, "0") +
    magic +
    reference.slice(2);
  assert.equal(validateWalletPayment(p, time).data, p.data);
});

test("payment expiring during wallet setup cannot be sent", async () => {
  const provider = wallet();
  let checks = 0;
  await assert.rejects(
    sendWalletPayment(provider, payment(), {
      now: () => (++checks === 1 ? time : time + 11 * 60000),
    }),
    { code: "PAYMENT_EXPIRED" },
  );
  assert.equal(sent(provider).length, 0);
});

test("a missing provider or unauthorized account cannot initiate payment", async () => {
  await assert.rejects(sendWalletPayment(null, payment(), options), {
    code: "NO_PROVIDER",
  });
  const provider = wallet({
    request: (call) => (call.method === "eth_requestAccounts" ? [] : undefined),
  });
  await assert.rejects(sendWalletPayment(provider, payment(), options), {
    code: "NO_ACCOUNT",
  });
  assert.equal(sent(provider).length, 0);
});

test("unknown submission errors and invalid hashes require checking wallet, not automatic retry", async () => {
  for (const output of [null, "0x1234", { status: "paid" }]) {
    const provider = wallet({
      request: (call) =>
        call.method === "eth_sendTransaction" ? output : undefined,
    });
    await assert.rejects(
      sendWalletPayment(provider, payment(), options),
      (e) => e.code === "SUBMISSION_UNKNOWN" && e.mayHaveSubmitted === true,
    );
    assert.equal(sent(provider).length, 1);
  }
  const provider = wallet({
    request: (call) => {
      if (call.method === "eth_sendTransaction")
        throw new Error("Disconnected");
    },
  });
  await assert.rejects(
    sendWalletPayment(provider, payment(), options),
    (e) => e.code === "SUBMISSION_UNKNOWN" && e.mayHaveSubmitted === true,
  );
  assert.equal(sent(provider).length, 1);
});

test("wallet payload must match the displayed order amount and recipient", async () => {
  for (const expected of [
    { amount: "2.0", recipient },
    { amount: "1", recipient: account },
  ]) {
    const provider = wallet();
    await assert.rejects(
      sendWalletPayment(provider, payment(), { ...options, expected }),
      { code: "INVALID_PAYMENT" },
    );
    assert.equal(provider.calls.length, 0);
  }
  const provider = wallet();
  await sendWalletPayment(provider, payment(), {
    ...options,
    expected: { amount: "1.000000000000000000", recipient },
  });
  assert.equal(sent(provider).length, 1);
});

test("explicitly known Ethereum USDC method uses six decimals and its own chain ID", async () => {
  const atomic = "1000000";
  const p = payment({
    chain_id: "0x1",
    token_symbol: "USDC",
    token_decimals: 6,
    amount_atomic: atomic,
  });
  p.data =
    "0xa9059cbb" +
    recipient.slice(2).padStart(64, "0") +
    BigInt(atomic).toString(16).padStart(64, "0") +
    magic +
    reference.slice(2);
  const provider = wallet();
  await sendWalletPayment(provider, p, {
    ...options,
    expected: { chainId: "0x1", symbol: "USDC", decimals: 6 },
  });
  assert.deepEqual(
    provider.calls.find((call) => call.method === "wallet_switchEthereumChain")
      .params,
    [{ chainId: "0x1" }],
  );
  assert.equal(sent(provider)[0].params[0].data, p.data);
  for (const bad of [
    { chain_id: "0x123456" },
    { chain_id: "__proto__" },
    { token_symbol: "USDT0" },
    { token_decimals: 18 },
  ]) {
    const invalidProvider = wallet();
    await assert.rejects(
      sendWalletPayment(invalidProvider, { ...p, ...bad }, options),
      { code: "INVALID_PAYMENT" },
    );
    assert.equal(invalidProvider.calls.length, 0);
  }
});

test("send timeout is an unknown result, never retried or marked paid", async () => {
  const provider = wallet({
    request: (call) =>
      call.method === "eth_sendTransaction" ? new Promise(() => {}) : undefined,
  });
  await assert.rejects(
    sendWalletPayment(provider, payment(), {
      ...options,
      requestTimeoutMs: 10,
    }),
    (error) => error.code === "SUBMISSION_UNKNOWN" && error.mayHaveSubmitted,
  );
  assert.equal(sent(provider).length, 1);
});
