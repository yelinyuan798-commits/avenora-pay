import { createHmac } from "node:crypto";
import { nowISO } from "./core.mjs";
import { safeWebhookPost } from "./net.mjs";

export function createWorker({
  store,
  scanChain,
  post = safeWebhookPost,
  intervalMs = 12000,
} = {}) {
  let busy = false,
    stopped = false,
    timer;
  function applyScan(chain, result) {
    if (result.blocks?.length) {
      const canonical = new Map(result.blocks.map((b) => [b.height, b.hash]));
      const existing = store.all(
        "SELECT * FROM transfers WHERE chain=? AND mode='live' AND removed=0",
        chain,
      );
      for (const tx of existing) {
        const blockHash = canonical.get(tx.block_height);
        if (blockHash && blockHash !== tx.block_hash)
          store.ingest(
            { ...tx, confirmed: false, removed: true },
            { mode: "live" },
          );
      }
    }
    for (const tx of result.transactions) store.ingest(tx, { mode: "live" });
    const definition = store.registry.find((c) => c.id === chain);
    const required = Math.max(
      Number(definition?.confirmations || 1),
      Number(store.chainConfig(chain)?.confirmations || 0),
    );
    const finalized = (result.blocks || [])
      .filter(
        (b) =>
          !["evm", "bitcoin"].includes(definition?.family) ||
          b.height <= Number(result.head) - required + 1,
      )
      .map((b) => b.time)
      .filter(Boolean)
      .sort();
    if (finalized.length)
      store.run(
        "INSERT INTO scanner_watermarks VALUES(?,?) ON CONFLICT(chain) DO UPDATE SET block_time=MAX(block_time,excluded.block_time)",
        chain,
        finalized.at(-1),
      );
  }
  async function scan() {
    for (const chain of store.registry) {
      const config = store.chainConfig(chain.id);
      if (
        !config ||
        !chain.tokens.some((t) => store.configured(chain.id, t.id))
      )
        continue;
      const addresses = store
        .all(
          "SELECT address FROM addresses WHERE chain=? AND mode='live'",
          chain.id,
        )
        .map((a) => a.address);
      if (!addresses.length) continue;
      const saved = store.get("SELECT * FROM cursors WHERE chain=?", chain.id);
      const cursor =
        saved && Number(saved.cursor) >= 0 ? Number(saved.cursor) : null;
      try {
        // Re-check only blocks containing unsettled transfers, independently of the forward cursor.
        const pending = store.all(
          "SELECT DISTINCT t.block_height FROM transfers t LEFT JOIN orders o ON o.transfer_id=t.id WHERE t.chain=? AND t.mode='live' AND t.removed=0 AND (t.confirmed=0 OR o.status IN ('confirming','review')) ORDER BY t.block_height LIMIT 50",
          chain.id,
        );
        for (const row of pending) {
          const result = await scanChain({
            chain: chain.id,
            addresses,
            fromBlock: row.block_height,
            toBlock: row.block_height,
            config,
          });
          applyScan(chain.id, result);
        }
        const result = await scanChain({
          chain: chain.id,
          addresses,
          fromBlock: cursor === null ? config.startBlock : cursor + 1,
          config,
        });
        applyScan(chain.id, result);
        // Sweep the recent canonical EVM / Bitcoin window, including formerly empty blocks, on its own cursor.
        if (["evm", "bitcoin"].includes(chain.family) && cursor !== null) {
          const window =
            Math.max(
              Number(chain.confirmations || 1),
              Number(config.confirmations || 0),
            ) + 2;
          const end = Math.min(cursor, Number(result.head));
          const start = Math.max(Number(config.startBlock), end - window + 1);
          if (end >= start) {
            const sweep = store.get(
              "SELECT cursor FROM reorg_cursors WHERE chain=?",
              chain.id,
            );
            const from =
              sweep && sweep.cursor >= start && sweep.cursor <= end
                ? sweep.cursor
                : start;
            const rescanned = await scanChain({
              chain: chain.id,
              addresses,
              fromBlock: from,
              toBlock: end,
              config: { ...config, batchSize: Math.min(500, window) },
            });
            applyScan(chain.id, rescanned);
            store.run(
              "INSERT INTO reorg_cursors VALUES(?,?) ON CONFLICT(chain) DO UPDATE SET cursor=excluded.cursor",
              chain.id,
              Number(rescanned.cursor) >= end
                ? start
                : Number(rescanned.cursor) + 1,
            );
          }
        }
        const next = Math.max(cursor ?? -1, Number(result.cursor));
        store.run(
          "INSERT INTO cursors VALUES(?,?,?,?,?) ON CONFLICT(chain) DO UPDATE SET cursor=excluded.cursor,head=excluded.head,last_success=excluded.last_success,last_error=NULL",
          chain.id,
          String(next),
          String(result.head),
          nowISO(),
          null,
        );
      } catch (e) {
        const message = String(e.message || "节点扫描失败")
          .replace(/https?:\/\/\S+/g, "[node]")
          .slice(0, 300);
        store.run(
          "INSERT INTO cursors VALUES(?,?,?,?,?) ON CONFLICT(chain) DO UPDATE SET last_error=excluded.last_error",
          chain.id,
          saved?.cursor || "-1",
          saved?.head || null,
          saved?.last_success || null,
          message,
        );
      }
    }
  }
  async function deliver() {
    const deliveries = store.all(
      "SELECT * FROM deliveries WHERE status IN ('pending','retry') AND next_attempt<=? ORDER BY created_at LIMIT 30",
      Date.now(),
    );
    for (const item of deliveries) {
      const ep = store.get(
        "SELECT * FROM endpoints WHERE id=?",
        item.endpoint_id,
      );
      if (!ep) {
        store.run(
          "UPDATE deliveries SET status='unconfigured' WHERE id=?",
          item.id,
        );
        continue;
      }
      if(store.get("SELECT enabled FROM endpoint_state WHERE endpoint_id=?",ep.id)?.enabled===0){store.run("UPDATE deliveries SET status='paused' WHERE id=?",item.id);continue;}
      const merchant = store.merchant(item.merchant_id);
      try {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac("sha256", store.decrypt(ep.secret))
          .update(timestamp + "." + item.payload)
          .digest("hex");
        if (merchant.mode !== "demo") {
          const result = await post(ep.url, {
            body: item.payload,
            headers: {
              "DJP-Webhook-ID": item.event_id,
              "DJP-Webhook-Timestamp": timestamp,
              "DJP-Webhook-Signature": signature,
              "User-Agent": "AvenoraPay-Webhooks/1.0",
            },
          });
          if (result.status < 200 || result.status >= 300)
            throw Error("HTTP " + result.status);
        }
        store.run(
          "UPDATE deliveries SET status='delivered',attempts=attempts+1,last_error=NULL,delivered_at=? WHERE id=?",
          nowISO(),
          item.id,
        );
      } catch (e) {
        const attempts = item.attempts + 1;
        store.run(
          "UPDATE deliveries SET status=?,attempts=?,next_attempt=?,last_error=? WHERE id=?",
          attempts >= 8 ? "dead" : "retry",
          attempts,
          Date.now() + Math.min(3600000, 30000 * 2 ** (attempts - 1)),
          String(e.message || "投递失败")
            .replace(/https?:\/\/\S+/g, "[endpoint]")
            .slice(0, 300),
          item.id,
        );
      }
    }
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      await scan();
      store.expire();
      await deliver();
    } catch (e) {
      console.error(
        "Worker iteration failed:",
        String(e.message).replace(/https?:\/\/\S+/g, "[url]"),
      );
    } finally {
      busy = false;
    }
  }
  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref();
    void tick();
  }
  function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
  }
  return { tick, scan, deliver, start, stop };
}
