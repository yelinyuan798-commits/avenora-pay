import fs from "node:fs";
import path from "node:path";
import { Store } from "./core.mjs";
import { createApp } from "./app.mjs";
import { createWorker } from "./worker.mjs";
import {
  registry,
  validateAddress,
  configuredTokens,
  normalizeAddress,
  scanChain,
} from "./chains.mjs";

const production = process.env.NODE_ENV === "production";
const mode = process.env.APP_MODE || (production ? "live" : "demo");
if (!["live", "demo"].includes(mode))
  throw Error("APP_MODE must be live or demo");
const configuredKey = process.env.MASTER_KEY;
if (production && (!configuredKey || !/^[a-f\d]{64}$/i.test(configuredKey)))
  throw Error("Production requires MASTER_KEY containing 64 hex characters");
if (configuredKey && !/^[a-f\d]{64}$/i.test(configuredKey))
  throw Error("MASTER_KEY must contain 64 hex characters");
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
if (
  production &&
  (!publicBaseUrl || new URL(publicBaseUrl).protocol !== "https:")
)
  throw Error("Production requires an HTTPS PUBLIC_BASE_URL");
const dataDir = path.resolve(process.env.DATA_DIR || "data");
let config = {};
if (process.env.CHAIN_CONFIG_PATH)
  config = JSON.parse(fs.readFileSync(process.env.CHAIN_CONFIG_PATH, "utf8"));
const store = new Store({
  filename: path.join(dataDir, "payment.sqlite"),
  masterKey: configuredKey ? Buffer.from(configuredKey, "hex") : undefined,
  registry,
  config,
  validateAddress,
  configuredTokens,
  normalizeAddress,
});
const app = createApp({
  store,
  mode,
  publicBaseUrl,
  production,
  trustProxy: process.env.TRUST_PROXY || false,
});
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const worker = createWorker({ store, scanChain });
const server = app.listen(port, host, () => {
  console.log(`Payment platform listening at http://${host}:${port} (${mode})`);
  worker.start();
  if (
    config.pricing?.enabled !== false &&
    (mode === "live" || config.pricing?.refreshInDemo === true)
  )
    store.priceBook.start();
});
const shutdown = () => {
  worker.stop();
  store.priceBook.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
