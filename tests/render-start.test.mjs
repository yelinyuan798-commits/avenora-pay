import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRenderEnvironment } from "../server/render-start.mjs";
import { signedHeaders } from "../scripts/sdk.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("../server/render-start.mjs", import.meta.url));
const fixtureKey = Buffer.alloc(32, 83);
const deployment = {
  AVENORA_MASTER_KEY_BASE64: fixtureKey.toString("base64"),
  RENDER_EXTERNAL_URL: "https://avenora-fixture.onrender.com",
};

test("Render generated secret is decoded exactly and environment preparation is pure and stable", () => {
  const env = Object.freeze({ ...deployment, PORT: "10000", DATA_DIR: "/var/data" });
  const prepared = prepareRenderEnvironment(env);
  assert.notEqual(prepared, env);
  assert.equal(prepared.MASTER_KEY, fixtureKey.toString("hex"));
  assert.equal(prepared.PUBLIC_BASE_URL, deployment.RENDER_EXTERNAL_URL);
  assert.equal(prepared.PORT, env.PORT);
  assert.equal(prepared.DATA_DIR, env.DATA_DIR);
  assert.equal(env.MASTER_KEY, undefined);
  assert.equal(env.PUBLIC_BASE_URL, undefined);
  assert.deepEqual(prepareRenderEnvironment(env), prepared);
});

test("Render entry refuses missing, malformed, noncanonical and wrong-sized generated secrets", () => {
  const noncanonicalPadBits = "A".repeat(42) + "B=";
  for (const value of [undefined, "", "not-a-secret", Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"), deployment.AVENORA_MASTER_KEY_BASE64.slice(0, -1),
    deployment.AVENORA_MASTER_KEY_BASE64 + "=", deployment.AVENORA_MASTER_KEY_BASE64 + "\n",
    Buffer.alloc(32, 255).toString("base64url"), noncanonicalPadBits]) {
    assert.throws(() => prepareRenderEnvironment({ ...deployment, AVENORA_MASTER_KEY_BASE64: value }),
      /AVENORA_MASTER_KEY_BASE64 must be canonical base64 for exactly 32 bytes/);
  }
});

test("explicit hex master key takes precedence and invalid explicit keys fail instead of being replaced", () => {
  const manual = "AB".repeat(32);
  assert.equal(prepareRenderEnvironment({ ...deployment, MASTER_KEY: manual,
    AVENORA_MASTER_KEY_BASE64: "invalid-but-unused" }).MASTER_KEY, manual);
  for (const MASTER_KEY of ["", "x".repeat(64), "ab".repeat(31), "ab".repeat(33), manual + "\n", null])
    assert.throws(() => prepareRenderEnvironment({ ...deployment, MASTER_KEY }),
      /MASTER_KEY must contain 64 hex characters/);
});

test("explicit HTTPS origin takes precedence; unsafe or non-origin deployment URLs are refused", () => {
  for (const PUBLIC_BASE_URL of ["https://payments.example.com", "https://payments.example.com/", "https://payments.example.com:8443"])
    assert.equal(prepareRenderEnvironment({ ...deployment, PUBLIC_BASE_URL,
      RENDER_EXTERNAL_URL: "http://ignored.invalid" }).PUBLIC_BASE_URL, PUBLIC_BASE_URL);
  for (const invalid of [undefined, "", "http://payments.example.com", "//payments.example.com",
    "https://user:pass@payments.example.com", "https://payments.example.com/checkout", "https://payments.example.com/a/..",
    "https://payments.example.com?", "https://payments.example.com?query=1", "https://payments.example.com#",
    "https://payments.example.com#fragment", "https://payments.example.com\\other", "https://pay\nments.example.com",
    " https://payments.example.com", "https://payments.example.com "]) {
    assert.throws(() => prepareRenderEnvironment({ ...deployment, RENDER_EXTERNAL_URL: invalid }), /HTTPS site origin/);
    if (invalid !== undefined)
      assert.throws(() => prepareRenderEnvironment({ ...deployment, PUBLIC_BASE_URL: invalid }), /HTTPS site origin/);
  }
});

test("importing the Render entry neither starts the service nor rewrites process environment", async () => {
  const source = `process.env.MASTER_KEY='invalid-on-purpose';
    process.env.PUBLIC_BASE_URL='http://invalid-on-purpose';
    await import(${JSON.stringify(new URL("../server/render-start.mjs", import.meta.url).href)});
    if(process.env.MASTER_KEY!=='invalid-on-purpose'||process.env.PUBLIC_BASE_URL!=='http://invalid-on-purpose') process.exit(2);`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], { timeout: 5000 });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

// 测试用监听观察器让操作系统直接分配端口，避免“预占再释放”造成端口竞争。
const observeListener = `import { Server } from 'node:net';
const listen=Server.prototype.listen;
Server.prototype.listen=function(...args){
  this.once('listening',()=>{const a=this.address();if(a&&process.send)process.send({port:a.port});});
  return Reflect.apply(listen,this,args);
};
globalThis.fetch=async()=>{throw Error('Network access is disabled in the deployment smoke test');};`;

function launch(env) {
  const child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(observeListener), entry], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Render entry did not start: " + output)), 10000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", () => { clearTimeout(timeout); reject(new Error("Render entry exited before listening: " + output)); });
    child.once("message", message => {
      clearTimeout(timeout);
      if (!Number.isInteger(message.port) || message.port < 1) reject(new Error("Missing assigned service port"));
      else resolve(`http://127.0.0.1:${message.port}`);
    });
  });
  let stopping;
  return { ready, logs: () => output, stop() {
    return stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { return await closed; } finally { clearTimeout(timeout); }
    })();
  } };
}

test("Render entry boots live, preserves encrypted credentials across restart and refuses unconfigured collection", { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "avenora-render-"));
  const instances = [];
  t.after(async () => {
    for (const instance of instances) await instance.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "chains.json");
  await writeFile(configPath, JSON.stringify({ chains: {}, pricing: { enabled: false } }), { mode: 0o600 });
  const env = { ...process.env, ...deployment, NODE_ENV: "production", APP_MODE: "live",
    HOST: "127.0.0.1", PORT: "0", DATA_DIR: directory, CHAIN_CONFIG_PATH: configPath };
  for (const name of ["MASTER_KEY", "PUBLIC_BASE_URL", "TRUST_PROXY", "NODE_OPTIONS"])
    delete env[name];
  const first = launch(env);
  instances.push(first);
  let base = await first.ready;
  let cookie;
  async function request(route, body) {
    const response = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Origin: deployment.RENDER_EXTERNAL_URL, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { response, data: await response.json() };
  }
  const account = { email: "render-test@example.com", password: "Deployment-test-" + randomBytes(12).toString("hex"), name: "Render test" };
  const registered = await request("/api/auth/register", account);
  assert.equal(registered.response.status, 201);
  assert.equal(registered.data.mode, "live");
  const setCookie = registered.response.headers.get("set-cookie");
  assert.match(setCookie, /; Secure(?:;|$)/);
  assert.match(setCookie, /; HttpOnly(?:;|$)/);
  assert.match(setCookie, /; SameSite=Strict(?:;|$)/);
  cookie = setCookie.split(";")[0];
  const created = await request("/api/projects", { name: "Persistent project" });
  assert.equal(created.response.status, 201);
  const project = created.data;
  const keyResult = await request("/api/keys", { project_id: project.id, name: "Persistent signing key" });
  assert.equal(keyResult.response.status, 201);
  const key = keyResult.data;
  const identity = async () => {
    const response = await fetch(base + "/v1/whoami", {
      headers: signedHeaders({ keyId: key.key_id, secret: key.secret, method: "GET", path: "/v1/whoami" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await identity()).merchant_id, registered.data.user.id);
  assert.deepEqual(await first.stop(), { code: 0, signal: null });
  const second = launch(env);
  instances.push(second);
  base = await second.ready;
  assert.equal((await request("/api/auth/me")).data.user.id, registered.data.user.id);
  assert.equal((await identity()).project_id, project.id);
  const methods = await request("/api/registry");
  assert.ok(methods.data.chains.length > 0);
  assert.ok(methods.data.chains.every(chain => chain.configured === false));
  const order = await request("/api/orders", { project_id: project.id, fiat_amount: "1.00", fiat_currency: "USD", merchant_order_id: "unconfigured-test" });
  assert.equal(order.response.status, 400);
  assert.equal(order.data.error.code, "PAYMENT_UNCONFIGURED");
  for (const instance of instances) {
    assert.ok(!instance.logs().includes(deployment.AVENORA_MASTER_KEY_BASE64));
    assert.ok(!instance.logs().includes(fixtureKey.toString("hex")));
    assert.ok(!instance.logs().includes("Network access is disabled"));
  }
});
