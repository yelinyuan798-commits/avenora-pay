let projectScope = "";
export const setProjectScope = (value) => {
  projectScope = value || "";
};
const scopedPaths = new Set([
  "/api/dashboard",
  "/api/orders",
  "/api/addresses",
  "/api/keys",
  "/api/products",
  "/api/transactions",
  "/api/webhooks",
  "/api/payment-links",
  "/api/refunds",
]);
export async function api(path, options = {}) {
  const requestScope = projectScope;
  const url = new URL(path, location.origin);
  const scoped =
    (!options.method || options.method === "GET") &&
    requestScope &&
    scopedPaths.has(url.pathname);
  if (scoped && !url.searchParams.has("project_id"))
    url.searchParams.set("project_id", requestScope);
  const response = await fetch(url.pathname + url.search, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "AvenoraPay",
      ...options.headers,
    },
    ...options,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      result.error?.message ||
        result.message ||
        `请求未完成（${response.status}）`,
    );
    error.code = result.error?.code;
    error.status = response.status;
    throw error;
  }
  if (scoped) {
    for (const field of [
      "addresses",
      "keys",
      "products",
      "transactions",
      "deliveries",
      "endpoints",
      "links",
      "refunds",
    ]) {
      if (Array.isArray(result[field]))
        result[field] = result[field].filter(
          (item) => !item.project_id || item.project_id === requestScope,
        );
    }
  }
  return result;
}
export const mutate = (path, body = {}, method = "POST") =>
  api(path, { method, body });
