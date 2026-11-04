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
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_jobs(
      chain TEXT NOT NULL,block_height INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,
      last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(chain,block_height)
    );
    CREATE INDEX IF NOT EXISTS recovery_jobs_due ON recovery_jobs(chain,next_attempt);
    CREATE TABLE IF NOT EXISTS reorg_scan_jobs(
      chain TEXT PRIMARY KEY,from_block INTEGER NOT NULL,to_block INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,
      last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
  `);
  const automaticRecovery = () =>
    store.config?.payments?.automaticRecovery === true;
  const errorMessage = (error, fallback, replacement = "[node]") =>
    String(error?.message || fallback)
      .replace(/https?:\/\/\S+/g, replacement)
      .slice(0, 300);
  const recoveryBatchSize = () => {
    const configured = Number(store.config?.payments?.recoveryBatchSize);
    return Number.isSafeInteger(configured) && configured > 0
      ? Math.min(50, configured)
      : 5;
  };
  function recoveryBlocks(chain) {
    const hasReferences = store.get(
      "SELECT 1 FROM pragma_table_info('transfers') WHERE name='payment_reference'",
    );
    const references = automaticRecovery() && hasReferences;
    // Only the core may decide to settle an order. These predicates find blocks
    // worth verifying again; they never turn a stored transfer into proof of payment.
    const referenceCandidate = references ? ` OR EXISTS (
      SELECT 1 FROM amount_reservations q JOIN orders d ON d.order_id=q.order_id
      WHERE q.payment_reference=t.payment_reference
        AND q.chain=t.chain AND q.token_id=t.token_id
        AND q.pay_address=t.to_address AND q.payable_atomic=t.amount_atomic
        AND d.merchant_id=t.merchant_id AND d.project_id=t.project_id
        AND d.mode='live' AND d.chain=t.chain AND d.token_id=t.token_id
        AND d.pay_address=t.to_address AND d.payable_atomic=t.amount_atomic
        AND d.payment_mode='reference' AND d.payment_reference=q.payment_reference
        AND d.status IN ('pending','expired','confirming','review')
        AND (t.reason IS NULL OR t.reason NOT IN ('duplicate_payment','superseded_payment_method','reorg_after_payment'))
        AND (t.order_id IS NULL OR t.order_id=d.order_id)
        AND (d.transfer_id IS NULL OR d.transfer_id=t.id)
        AND unixepoch(t.block_time)>=unixepoch(COALESCE(q.created_at,d.payment_started_at,d.created_at))
        AND julianday(t.block_time)<=julianday(d.expires_at)
    )` : "";
    return store.all(`
      SELECT DISTINCT t.block_height FROM transfers t
      LEFT JOIN orders o ON o.transfer_id=t.id
      WHERE t.chain=? AND t.mode='live' AND t.removed=0
        ${hasReferences ? "AND COALESCE(t.payment_reference_invalid,0)=0" : ""} AND (
        (t.confirmed=0 AND (o.order_id IS NULL OR o.status NOT IN ('paid','expired','canceled')))
        OR o.status IN ('confirming','review')${referenceCandidate}
      ) ORDER BY t.block_height`, chain);
  }
  function syncRecoveryJobs(chain) {
    const needed = new Set(recoveryBlocks(chain).map((row) => row.block_height));
    const now = Date.now(), stamp = nowISO();
    for (const height of needed)
      store.run(
        "INSERT OR IGNORE INTO recovery_jobs(chain,block_height,next_attempt,created_at,updated_at) VALUES(?,?,?,?,?)",
        chain, height, now, stamp, stamp,
      );
    for (const job of store.all("SELECT block_height FROM recovery_jobs WHERE chain=?", chain))
      if (!needed.has(job.block_height))
        store.run("DELETE FROM recovery_jobs WHERE chain=? AND block_height=?", chain, job.block_height);
    return needed;
  }
  function applyScan(chain, result) {
    if (result.blocks?.length) {
      const canonical = new Map(result.blocks.map((b) => [b.height, b.hash]));
      const heights = [...canonical.keys()];
      const existing = store.all(
        "SELECT * FROM transfers WHERE chain=? AND mode='live' AND removed=0 AND block_height BETWEEN ? AND ?",
        chain, Math.min(...heights), Math.max(...heights),
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
  async function recover(chain, addresses, config, due) {
    for (const job of due) {
      try {
        const result = await scanChain({
          chain, addresses, fromBlock: job.block_height,
          toBlock: job.block_height, config,
        });
        applyScan(chain, result);
        if (!syncRecoveryJobs(chain).has(job.block_height)) continue;
        // Waiting confirmations / stock return to the tail of the queue, so a
        // large backlog and an unavailable product cannot starve other blocks.
        store.run(
          "UPDATE recovery_jobs SET attempts=0,next_attempt=?,last_error=NULL,updated_at=? WHERE chain=? AND block_height=?",
          Date.now() + Math.max(1000, intervalMs), nowISO(), chain, job.block_height,
        );
      } catch (error) {
        const attempts = job.attempts + 1;
        const delay = Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7));
        store.run(
          "UPDATE recovery_jobs SET attempts=?,next_attempt=?,last_error=?,updated_at=? WHERE chain=? AND block_height=?",
          attempts, Date.now() + delay, errorMessage(error, "历史区块复查失败"),
          nowISO(), chain, job.block_height,
        );
      }
    }
  }
  async function sweepCanonical(chain, config, addresses, cursor, head) {
    if (!["evm", "bitcoin"].includes(chain.family) || cursor === null) return;
    const window = Math.max(Number(chain.confirmations || 1), Number(config.confirmations || 0)) + 2;
    const end = Math.min(cursor, Number(head));
    const start = Math.max(Number(config.startBlock), end - window + 1);
    if (end < start) return;
    const sweep = store.get("SELECT cursor FROM reorg_cursors WHERE chain=?", chain.id);
    const from = sweep && sweep.cursor >= start && sweep.cursor <= end ? sweep.cursor : start;
    const stamp = nowISO();
    // Failure must not discard a formerly empty block that can gain a payment
    // through reorg. While the forward cursor advances, extend this persisted
    // interval; never move its unfinished beginning to the newer recent window.
    store.run(
      "INSERT INTO reorg_scan_jobs(chain,from_block,to_block,next_attempt,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(chain) DO UPDATE SET to_block=MAX(to_block,excluded.to_block),updated_at=excluded.updated_at",
      chain.id, from, end, Date.now(), stamp, stamp,
    );
    const job = store.get("SELECT * FROM reorg_scan_jobs WHERE chain=?", chain.id);
    if (job.next_attempt > Date.now()) return;
    try {
      const rescanned = await scanChain({
        chain: chain.id, addresses, fromBlock: job.from_block, toBlock: job.to_block,
        config: { ...config, batchSize: Math.min(500, Math.max(window, Number(config.batchSize) || 100)) },
      });
      applyScan(chain.id, rescanned);
      const next = Math.max(job.from_block, Number(rescanned.cursor) + 1);
      store.run(
        "UPDATE reorg_scan_jobs SET from_block=MAX(from_block,?),attempts=0,next_attempt=?,last_error=NULL,updated_at=? WHERE chain=?",
        next, Date.now() + Math.max(1000, intervalMs), nowISO(), chain.id,
      );
      store.run("DELETE FROM reorg_scan_jobs WHERE chain=? AND from_block>to_block", chain.id);
      const unfinished = store.get("SELECT from_block FROM reorg_scan_jobs WHERE chain=?", chain.id);
      store.run(
        "INSERT INTO reorg_cursors VALUES(?,?) ON CONFLICT(chain) DO UPDATE SET cursor=excluded.cursor",
        chain.id, unfinished?.from_block ?? start,
      );
    } catch (error) {
      const attempts = job.attempts + 1;
      store.run(
        "UPDATE reorg_scan_jobs SET attempts=?,next_attempt=?,last_error=?,updated_at=? WHERE chain=?",
        attempts, Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7)),
        errorMessage(error, "近期区块复查失败"), nowISO(), chain.id,
      );
    }
  }
  async function scan() {
    const contexts = [];
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
      syncRecoveryJobs(chain.id);
      contexts.push({ chain, config, addresses });
    }
    if (!contexts.length) return;
    // One shared budget covers every chain. Selecting globally before processing
    // any chain prevents an early, busy chain from monopolizing all retries.
    const due = store.all(
      `SELECT * FROM recovery_jobs WHERE chain IN (${contexts.map(() => "?").join(",")}) AND next_attempt<=? ORDER BY next_attempt,created_at,chain,block_height LIMIT ?`,
      ...contexts.map(({ chain }) => chain.id), Date.now(), recoveryBatchSize(),
    );
    for (const { chain, config, addresses } of contexts) {
      const saved = store.get("SELECT * FROM cursors WHERE chain=?", chain.id);
      const cursor =
        saved && Number(saved.cursor) >= 0 ? Number(saved.cursor) : null;
      // A bounded first pass preserves prompt confirmation of existing payments.
      // Each old block has its own persisted retry state and cannot mask the
      // forward scanner's health or prevent it from processing new transfers.
      await recover(chain.id, addresses, config, due.filter((job) => job.chain === chain.id));
      let result;
      try {
        result = await scanChain({
          chain: chain.id,
          addresses,
          fromBlock: cursor === null ? config.startBlock : cursor + 1,
          config,
        });
        applyScan(chain.id, result);
        const next = Math.max(cursor ?? -1, Number(result.cursor));
        store.run(
          "INSERT INTO cursors VALUES(?,?,?,?,?) ON CONFLICT(chain) DO UPDATE SET cursor=excluded.cursor,head=excluded.head,last_success=excluded.last_success,last_error=NULL",
          chain.id, String(next), String(result.head), nowISO(), null,
        );
      } catch (e) {
        store.run(
          "INSERT INTO cursors VALUES(?,?,?,?,?) ON CONFLICT(chain) DO UPDATE SET last_error=excluded.last_error",
          chain.id, saved?.cursor || "-1", saved?.head || null,
          saved?.last_success || null, errorMessage(e, "节点扫描失败"),
        );
        continue;
      }
      await sweepCanonical(chain, config, addresses, cursor, result.head);
      // Persist transfers discovered by this forward/sweep pass for the next
      // iteration, and drop jobs settled by either of those scans.
      syncRecoveryJobs(chain.id);
    }
  }
  async function deliver() {
    const deliveries = store.all(
      `SELECT * FROM deliveries WHERE status IN ('pending','retry'${automaticRecovery() ? ",'dead'" : ""}) AND next_attempt<=? ORDER BY next_attempt,created_at,id LIMIT 30`,
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
          attempts >= 8 && !automaticRecovery() ? "dead" : "retry",
          attempts,
          Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7)),
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
