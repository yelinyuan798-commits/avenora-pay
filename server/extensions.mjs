import { decimalAtomic, formatAtomic, fail, hash, uid, nowISO } from './core.mjs';

const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
const requireMerchant = req => req.merchant || fail('UNAUTHORIZED', '请先登录', 401);
const currencies = new Set(['USD', 'CNY', 'EUR', 'USDT', 'USDC']);
const text = (value, max, label, { required = false } = {}) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('INVALID_ARGUMENT', `${label}格式不正确`);
  return value.trim();
};
const amountValue = (value, decimals = 2, maximum = 10000000000n) => {
  if (typeof value !== 'string') fail('INVALID_AMOUNT', '金额必须为十进制字符串');
  const atomic = decimalAtomic(value, decimals);
  if (atomic <= 0n || atomic > maximum) fail('INVALID_AMOUNT', '金额必须大于零且不超过允许上限');
  return { atomic, amount: formatAtomic(atomic, decimals) };
};

export function registerExtensions(app, { store }) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS payment_links (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, project_id TEXT NOT NULL,
      name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      amount_mode TEXT NOT NULL CHECK(amount_mode IN ('fixed','custom')),
      amount TEXT, currency TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payment_links_merchant ON payment_links(merchant_id, created_at);
    CREATE TABLE IF NOT EXISTS payment_link_orders (
      link_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      order_id TEXT NOT NULL UNIQUE, response TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(link_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS refund_records (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, project_id TEXT NOT NULL,
      order_id TEXT NOT NULL, chain TEXT NOT NULL, token_id TEXT NOT NULL,
      amount TEXT NOT NULL, amount_atomic TEXT NOT NULL, tx_hash TEXT NOT NULL,
      note TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('recorded','voided')),
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      created_at TEXT NOT NULL, voided_at TEXT,
      UNIQUE(order_id,tx_hash)
    );
    CREATE INDEX IF NOT EXISTS refund_records_merchant ON refund_records(merchant_id,created_at);
  `);

  function ownedLink(merchant, id) {
    return store.get('SELECT * FROM payment_links WHERE id=? AND merchant_id=?', id, merchant.id) || fail('NOT_FOUND', '收款链接不存在', 404);
  }
  function publicLink(id) {
    return store.get('SELECT * FROM payment_links WHERE id=? AND enabled=1', id) || fail('NOT_FOUND', '收款链接不存在或已停用', 404);
  }
  function linkView(link) {
    const counts = store.get(`SELECT COUNT(*) AS order_count,
      COALESCE(SUM(CASE WHEN o.status='paid' THEN 1 ELSE 0 END),0) AS paid_count
      FROM payment_link_orders l JOIN orders o ON o.order_id=l.order_id WHERE l.link_id=?`, link.id);
    const { merchant_id: ignored, ...rest } = link;
    return { ...rest, enabled: !!link.enabled, url: `/pay/${link.id}`, ...counts };
  }
  function linkFields(body, previous) {
    const source = { name: '', title: '', description: '', amount_mode: 'fixed', amount: null, currency: 'USD', enabled: true, ...previous, ...body };
    const name = text(source.name, 80, '名称', { required: true });
    const title = text(source.title || name, 120, '标题', { required: true });
    const description = text(source.description, 1500, '说明');
    if (!['fixed', 'custom'].includes(source.amount_mode)) fail('INVALID_AMOUNT_MODE', '金额模式不支持');
    if (typeof source.currency !== 'string' || !currencies.has(source.currency.toUpperCase())) fail('INVALID_CURRENCY', '计价币种不支持');
    if (typeof source.enabled !== 'boolean') fail('INVALID_ENABLED', '启用状态必须为布尔值');
    return { name, title, description, amount_mode: source.amount_mode, amount: source.amount_mode === 'fixed' ? amountValue(source.amount).amount : null, currency: source.currency.toUpperCase(), enabled: source.enabled ? 1 : 0 };
  }
  function refundView(refund) {
    const order = store.get('SELECT merchant_order_id FROM orders WHERE order_id=?', refund.order_id);
    const { merchant_id: ignored, amount_atomic: internal, ...rest } = refund;
    return { ...rest, merchant_order_id: order?.merchant_order_id || null, token_symbol: store.tokenSpec(refund.chain, refund.token_id).token.symbol };
  }
  function refundEvent(refund, order) {
    const eventId = uid('evt_'), createdAt = nowISO();
    const payload = { event_id: eventId, event_type: 'refund.recorded', event_version: 'v1', created_at: createdAt, data: {
      refund_id: refund.id, order_id: order.order_id, merchant_order_id: order.merchant_order_id,
      status: refund.status, verification_status: refund.verification_status,
      chain: refund.chain, token_id: refund.token_id, amount: refund.amount, tx_hash: refund.tx_hash,
      recorded_at: refund.created_at, voided_at: refund.voided_at,
    } };
    store.enqueueEvent({ merchant_id: order.merchant_id, project_id: order.project_id, event_id: eventId, event_type: 'refund.recorded', payload });
  }

  app.get('/api/payment-links', wrap((req, res) => {
    const merchant = requireMerchant(req);
    res.json({ links: store.all('SELECT * FROM payment_links WHERE merchant_id=? ORDER BY created_at DESC', merchant.id).map(linkView) });
  }));
  app.post('/api/payment-links', wrap((req, res) => {
    const merchant = requireMerchant(req), project = store.project(merchant, req.body.project_id);
    const values = linkFields(req.body);
    store.callHook('enforceLimits', merchant, 'payment_links', project.id);
    const link = { id: uid('pl_'), merchant_id: merchant.id, project_id: project.id, ...values, created_at: nowISO() };
    store.run('INSERT INTO payment_links(id,merchant_id,project_id,name,title,description,amount_mode,amount,currency,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ...Object.values(link));
    store.audit(merchant.id, 'payment_link.create', link.id);
    res.status(201).json(linkView(link));
  }));
  app.patch('/api/payment-links/:id', wrap((req, res) => {
    const merchant = requireMerchant(req), previous = ownedLink(merchant, req.params.id);
    if (Object.hasOwn(req.body, 'project_id') && req.body.project_id !== previous.project_id) fail('PROJECT_LOCKED', '已有收款链接不能切换项目');
    const values = linkFields(req.body, { ...previous, enabled: !!previous.enabled });
    store.run('UPDATE payment_links SET name=?,title=?,description=?,amount_mode=?,amount=?,currency=?,enabled=? WHERE id=? AND merchant_id=?', ...Object.values(values), previous.id, merchant.id);
    store.audit(merchant.id, 'payment_link.update', previous.id);
    res.json(linkView(ownedLink(merchant, previous.id)));
  }));
  app.get('/pay/:id/state', wrap((req, res) => {
    const link = publicLink(req.params.id), merchant = store.merchant(link.merchant_id);
    res.json({ id: link.id, title: link.title, description: link.description, amount_mode: link.amount_mode, amount: link.amount, currency: link.currency, mode: merchant.mode, merchant_name: merchant.name, available: store.availableMethods(merchant, link.project_id).length > 0 });
  }));
  app.post('/pay/:id/orders', wrap((req, res) => {
    const result = store.transaction(() => {
      const link = publicLink(req.params.id), merchant = store.merchant(link.merchant_id);
      // Only custom-amount links take a price from the caller. Project, currency and recipient remain server-owned.
      const amount = link.amount_mode === 'fixed' ? link.amount : amountValue(req.body.amount).amount;
      const suppliedKey = req.body.idempotency_key ?? req.headers['idempotency-key'];
      if (suppliedKey !== undefined && (typeof suppliedKey !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(suppliedKey))) fail('INVALID_IDEMPOTENCY_KEY', '请求编号需为16–128位随机字母、数字或连接符');
      const requestKey = hash(suppliedKey || uid('request_'));
      const digest = hash(JSON.stringify({ amount, currency: link.currency }));
      const existing = store.get('SELECT * FROM payment_link_orders WHERE link_id=? AND request_key=?', link.id, requestKey);
      if (existing) {
        if (existing.request_hash !== digest) fail('IDEMPOTENCY_CONFLICT', '该请求编号已用于其他金额', 409);
        return JSON.parse(existing.response);
      }
      const order = store.createOrder(merchant, { project_id: link.project_id, fiat_amount: amount, fiat_currency: link.currency, merchant_order_id: 'LINK-' + hash(link.id + ':' + requestKey).slice(0, 40), metadata: { source_link: link.id } });
      const publicResponse = { order_id: order.order_id, checkout_token: order.checkout_token, checkout_url: order.checkout_url, status: order.chain ? order.status : 'awaiting_payment', fiat_amount: order.fiat_amount, fiat_currency: order.fiat_currency };
      store.run('INSERT INTO payment_link_orders VALUES(?,?,?,?,?,?)', link.id, requestKey, digest, order.order_id, JSON.stringify(publicResponse), nowISO());
      return publicResponse;
    });
    res.status(201).json(result);
  }));

  app.get('/api/refunds', wrap((req, res) => {
    const merchant = requireMerchant(req);
    res.json({ refunds: store.all('SELECT * FROM refund_records WHERE merchant_id=? ORDER BY created_at DESC', merchant.id).map(refundView) });
  }));
  app.post('/api/refunds', wrap((req, res) => {
    const merchant = requireMerchant(req);
    const result = store.transaction(() => {
      const order = store.ownedOrder(merchant, req.body.order_id);
      if (order.status !== 'paid') fail('ORDER_NOT_PAID', '只能为已支付订单登记退款', 409);
      const decimals = store.tokenSpec(order.chain, order.token_id).token.decimals;
      const { amount, atomic } = amountValue(req.body.amount, decimals, BigInt(order.payable_atomic));
      const txHash = text(req.body.tx_hash, 160, '退款交易哈希', { required: true });
      // This is a reconciliation record, not proof that an on-chain refund happened.
      if (!/^[a-zA-Z0-9:_-]{6,160}$/.test(txHash)) fail('INVALID_TX_HASH', '请填写退款交易哈希，不要填写网址');
      const canonicalHash = ['ethereum', 'bsc', 'polygon', 'base', 'arbitrum', 'plasma', 'x-layer', 'aptos', 'tron'].includes(order.chain) ? txHash.toLowerCase() : txHash;
      const note = text(req.body.note ?? '', 2000, '备注');
      const previous = store.get('SELECT * FROM refund_records WHERE order_id=? AND tx_hash=?', order.order_id, canonicalHash);
      if (previous) {
        if (previous.amount_atomic !== atomic.toString() || previous.note !== note) fail('IDEMPOTENCY_CONFLICT', '该退款交易已登记，金额或备注不一致', 409);
        return previous;
      }
      const total = store.all("SELECT amount_atomic FROM refund_records WHERE order_id=? AND status='recorded'", order.order_id).reduce((sum, row) => sum + BigInt(row.amount_atomic), 0n);
      if (total + atomic > BigInt(order.payable_atomic)) fail('REFUND_EXCEEDS_PAYMENT', '累计有效退款金额不能超过订单实际应付金额', 409);
      const refund = { id: uid('rf_'), merchant_id: merchant.id, project_id: order.project_id, order_id: order.order_id, chain: order.chain, token_id: order.token_id, amount, amount_atomic: atomic.toString(), tx_hash: canonicalHash, note, status: 'recorded', verification_status: 'unverified', created_at: nowISO(), voided_at: null };
      store.run('INSERT INTO refund_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...Object.values(refund));
      refundEvent(refund, order);
      store.audit(merchant.id, 'refund.record', refund.id);
      return refund;
    });
    res.status(201).json(refundView(result));
  }));
  app.post('/api/refunds/:id/void', wrap((req, res) => {
    const merchant = requireMerchant(req);
    const result = store.transaction(() => {
      const refund = store.get('SELECT * FROM refund_records WHERE id=? AND merchant_id=?', req.params.id, merchant.id);
      if (!refund) fail('NOT_FOUND', '退款记录不存在', 404);
      if (refund.status === 'voided') return refund;
      const order = store.ownedOrder(merchant, refund.order_id);
      const updated = { ...refund, status: 'voided', voided_at: nowISO() };
      store.run("UPDATE refund_records SET status='voided',voided_at=? WHERE id=? AND merchant_id=?", updated.voided_at, refund.id, merchant.id);
      refundEvent(updated, order);
      store.audit(merchant.id, 'refund.void', refund.id);
      return updated;
    });
    res.json(refundView(result));
  }));
}
