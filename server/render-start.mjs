import path from "node:path";
import { pathToFileURL } from "node:url";

// Render 入口只转换已持久保存的部署参数，不生成或轮换主密钥。
export function prepareRenderEnvironment(env) {
  const prepared = { ...env };
  if (env.MASTER_KEY !== undefined) {
    if (typeof env.MASTER_KEY !== "string" || !/^[a-f\d]{64}$/i.test(env.MASTER_KEY))
      throw new Error("MASTER_KEY must contain 64 hex characters");
  } else {
    const encoded = env.AVENORA_MASTER_KEY_BASE64;
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encoded))
      throw new Error("AVENORA_MASTER_KEY_BASE64 must be canonical base64 for exactly 32 bytes");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== 32 || bytes.toString("base64") !== encoded)
      throw new Error("AVENORA_MASTER_KEY_BASE64 must be canonical base64 for exactly 32 bytes");
    prepared.MASTER_KEY = bytes.toString("hex");
  }

  const publicUrl = env.PUBLIC_BASE_URL ?? env.RENDER_EXTERNAL_URL;
  let url;
  try {
    if (typeof publicUrl !== "string" || /\s/.test(publicUrl) ||
        !/^https:\/\/[^/?#\\]+\/?$/.test(publicUrl)) throw new Error();
    url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) throw new Error();
  } catch {
    throw new Error("PUBLIC_BASE_URL or RENDER_EXTERNAL_URL must be an HTTPS site origin without credentials, path, query or fragment");
  }
  prepared.PUBLIC_BASE_URL = publicUrl;
  return prepared;
}

// 被测试或其他模块导入时不启动服务，也不修改进程环境。
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  Object.assign(process.env, prepareRenderEnvironment(process.env));
  await import("./index.mjs");
}
