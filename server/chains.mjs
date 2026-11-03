import { createHash, timingSafeEqual } from 'node:crypto';

// All amounts remain integers. A token's display name is never proof of identity.
const token = (chain, symbol, decimals = 6) => ({ id: `${chain}-${symbol.toLowerCase()}`, symbol, decimals, kind: 'token', priceAsset: symbol === 'USDT0' ? 'USDT' : symbol });
const native = (chain, symbol, decimals) => ({ id: `${chain}-${symbol.toLowerCase()}`, symbol, decimals, kind: 'native', priceAsset: symbol });
export const BITCOIN_MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
export const registry = [
  { id: 'bitcoin', name: 'Bitcoin', family: 'bitcoin', confirmations: 6, tokens: [native('bitcoin', 'BTC', 8)] },
  { id: 'tron', name: 'Tron', family: 'tron', confirmations: 19, tokens: [token('tron', 'USDT'), native('tron', 'TRX', 6)] },
  { id: 'ethereum', name: 'Ethereum', family: 'evm', chainId: 1, confirmations: 20, tokens: [token('ethereum', 'USDT'), token('ethereum', 'USDC'), native('ethereum', 'ETH', 18)] },
  { id: 'bsc', name: 'BSC', family: 'evm', chainId: 56, confirmations: 15, tokens: [token('bsc', 'USDT', 18), token('bsc', 'USDC', 18), native('bsc', 'BNB', 18)] },
  { id: 'polygon', name: 'Polygon', family: 'evm', chainId: 137, confirmations: 128, tokens: [token('polygon', 'USDC'), token('polygon', 'USDT0')] },
  { id: 'base', name: 'Base', family: 'evm', chainId: 8453, confirmations: 20, tokens: [token('base', 'USDC'), native('base', 'ETH', 18)] },
  { id: 'arbitrum', name: 'Arbitrum', family: 'evm', chainId: 42161, confirmations: 20, tokens: [token('arbitrum', 'USDC'), token('arbitrum', 'USDT0'), native('arbitrum', 'ETH', 18)] },
  { id: 'plasma', name: 'Plasma', family: 'evm', chainId: 9745, confirmations: 20, tokens: [token('plasma', 'USDT0')] },
  { id: 'x-layer', name: 'X Layer', family: 'evm', chainId: 196, confirmations: 20, tokens: [token('x-layer', 'USDT0')] },
  { id: 'solana', name: 'Solana', family: 'solana', confirmations: 32, tokens: [token('solana', 'USDC'), token('solana', 'USDT'), native('solana', 'SOL', 9)] },
  { id: 'aptos', name: 'Aptos', family: 'aptos', chainId: 1, confirmations: 1, tokens: [token('aptos', 'USDC'), token('aptos', 'USDT')] },
];

const TRANSFER = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SPL_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const SOLANA_PRECOMPILES = new Set(['Ed25519SigVerify111111111111111111111111111', 'KeccakSecp256k11111111111111111111111111111', 'Secp256r1SigVerify1111111111111111111111111']);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha256 = bytes => createHash('sha256').update(bytes).digest();
const fail = message => { throw new Error(message); };
const num = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) fail('chain.invalid_integer'); return n; };
const hex = value => `0x${BigInt(value).toString(16)}`;
const iso = ms => { const date = new Date(ms); if (!Number.isFinite(date.getTime())) fail('chain.invalid_timestamp'); return date.toISOString(); };
const strip = value => String(value ?? '').replace(/^0x/, '').toLowerCase();
const aptosAddress = value => { const s = strip(value); if (!/^[a-f0-9]{1,64}$/.test(s)) fail('chain.invalid_address'); return `0x${s.padStart(64, '0')}`; };

function decode58(value) {
  if (typeof value !== 'string' || !value || value.length > 90) fail('chain.invalid_address');
  let integer = 0n;
  for (const c of value) { const i = B58.indexOf(c); if (i < 0) fail('chain.invalid_address'); integer = integer * 58n + BigInt(i); }
  const tail = integer ? Buffer.from(integer.toString(16).padStart(Math.ceil(integer.toString(16).length / 2) * 2, '0'), 'hex') : Buffer.alloc(0);
  return Buffer.concat([Buffer.alloc(value.match(/^1*/)[0].length), tail]);
}

function encode58(bytes) {
  let integer = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`), out = '';
  while (integer) { out = B58[Number(integer % 58n)] + out; integer /= 58n; }
  let zeroes = 0; while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  return '1'.repeat(zeroes) + out;
}

// BIP-173/BIP-350: preserve Base58 case, canonicalize witness addresses to lowercase.
// Return the script too, so a provider's display address cannot disagree with its output.
function bitcoinAddress(value) {
  if (typeof value !== 'string' || value.length > 90) fail('chain.invalid_address');
  if (/^[13]/.test(value)) {
    const decoded = decode58(value), body = decoded.subarray(0, 21);
    if (decoded.length !== 25 || ![0, 5].includes(decoded[0]) || !timingSafeEqual(decoded.subarray(21), sha256(sha256(body)).subarray(0, 4))) fail('chain.invalid_address');
    const payload = body.subarray(1).toString('hex');
    return { address: value, script: decoded[0] === 0 ? `76a914${payload}88ac` : `a914${payload}87` };
  }
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) fail('chain.invalid_address');
  const address = value.toLowerCase();
  if (!address.startsWith('bc1') || address.length < 14) fail('chain.invalid_address');
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', data = [...address.slice(3)].map(c => alphabet.indexOf(c));
  if (data.some(n => n < 0)) fail('chain.invalid_address');
  let checksum = 1;
  for (const value of [3, 3, 0, 2, 3, ...data]) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    for (let bit = 0; bit < 5; bit++) if ((top >>> bit) & 1) checksum ^= generators[bit];
  }
  const version = data[0];
  if (version > 16 || (checksum >>> 0) !== (version === 0 ? 1 : 0x2bc830a3)) fail('chain.invalid_address');
  let accumulator = 0, bits = 0;
  const program = [];
  for (const value of data.slice(1, -6)) {
    accumulator = ((accumulator << 5) | value) & 0xfff; bits += 5;
    while (bits >= 8) { bits -= 8; program.push((accumulator >>> bits) & 255); }
  }
  if (bits >= 5 || ((accumulator << (8 - bits)) & 255) !== 0 || program.length < 2 || program.length > 40 || (version === 0 && ![20, 32].includes(program.length))) fail('chain.invalid_address');
  return { address, script: Buffer.from([version === 0 ? 0 : 0x50 + version, program.length, ...program]).toString('hex') };
}

export function tronToHex(value) {
  if (/^41[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  const decoded = decode58(value);
  if (decoded.length !== 25 || decoded[0] !== 0x41 || !timingSafeEqual(decoded.subarray(21), sha256(sha256(decoded.subarray(0, 21))).subarray(0, 4))) fail('chain.invalid_address');
  return decoded.subarray(0, 21).toString('hex');
}

export function tronFromHex(value) {
  let h = strip(value); if (h.length === 40) h = `41${h}`;
  if (!/^41[0-9a-f]{40}$/.test(h)) fail('chain.invalid_address');
  const body = Buffer.from(h, 'hex'); return encode58(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
}

export function normalizeAddress(chain, address) {
  const c = registry.find(c => c.id === chain); if (!c) fail('chain.unsupported');
  if (c.family === 'evm') { if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail('chain.invalid_address'); return address.toLowerCase(); }
  if (c.family === 'tron') return tronFromHex(tronToHex(address));
  if (c.family === 'aptos') return aptosAddress(address);
  if (c.family === 'bitcoin') return bitcoinAddress(address).address;
  if (decode58(address).length !== 32) fail('chain.invalid_address');
  return address;
}

export function validateAddress(chain, address) {
  try { normalizeAddress(chain, address); return true; } catch { return false; }
}

export function aptosPrimaryStore(owner, metadata) {
  const bytes = Buffer.concat([Buffer.from(strip(aptosAddress(owner)), 'hex'), Buffer.from(strip(aptosAddress(metadata)), 'hex'), Buffer.from([0xfc])]);
  return `0x${createHash('sha3-256').update(bytes).digest('hex')}`;
}

function definition(chain) { return registry.find(item => item.id === chain) ?? fail('chain.unsupported'); }
function chainConfig(chain, config) { return config?.[chain] ?? config; }

export function configuredTokens(chain, rawConfig) {
  const c = definition(chain), config = chainConfig(chain, rawConfig);
  if (!config || config.enabled !== true || typeof config.rpcUrl !== 'string') return [];
  let url; try { url = new URL(config.rpcUrl); } catch { return []; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return [];
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return [];
  if (['evm', 'aptos'].includes(c.family) && Number(config.chainId) !== c.chainId) return [];
  if (['solana', 'tron'].includes(c.family) && !config.expectedGenesisHash) return [];
  if (c.family === 'bitcoin' && (config.network !== 'main' || config.expectedGenesisHash !== BITCOIN_MAINNET_GENESIS || !Number.isSafeInteger(config.startBlock) || config.startBlock < 0)) return [];
  const entries = Array.isArray(config.tokens) ? config.tokens : Object.entries(config.tokens ?? {}).map(([id, item]) => ({ id, ...item }));
  const seen = new Set();
  return entries.flatMap(entry => {
    const standard = c.tokens.find(item => item.id === (entry.id ?? entry.token_id));
    if (!standard || entry.enabled === false || entry.decimals !== standard.decimals) return [];
    if (standard.kind === 'native') {
      if (entry.kind !== 'native' || entry.contract || entry.mint || entry.metadata || seen.has(standard.id)) return [];
      seen.add(standard.id);
      return [{ ...entry, ...standard }];
    }
    if (entry.kind && entry.kind !== 'token') return [];
    const address = entry.contract ?? entry.mint ?? entry.metadata;
    if (!validateAddress(chain, address)) return [];
    const normalized = normalizeAddress(chain, address);
    if (seen.has(normalized) || seen.has(standard.id)) return [];
    seen.add(normalized); seen.add(standard.id);
    return [{ ...entry, ...standard, contract: c.family === 'evm' || c.family === 'tron' ? normalized : undefined, mint: c.family === 'solana' ? normalized : undefined, metadata: c.family === 'aptos' ? normalized : undefined }];
  });
}

export function isChainConfigured(chain, config) { try { return configuredTokens(chain, config).length > 0; } catch { return false; } }

function context(chain, addresses, rawConfig, fetchImpl) {
  const c = definition(chain), config = chainConfig(chain, rawConfig), tokens = configuredTokens(chain, config);
  if (!tokens.length) fail('chain.not_configured');
  const watched = new Map();
  for (const item of addresses ?? []) {
    const address = typeof item === 'string' ? item : item.address;
    if (typeof item === 'object' && (item.enabled === false || (item.chain && item.chain !== chain))) continue;
    const normalized = normalizeAddress(chain, address);
    watched.set(normalized, normalized);
  }
  let counter = 0;
  async function request(path = '', body) {
    const url = `${config.rpcUrl.replace(/\/$/, '')}${path}`;
    const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(config.headers ?? {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs ?? 15_000), redirect: 'error' });
    if (!response.ok) fail(`chain.provider_http_${response.status}`);
    // Bitcoin RPC uses decimal JSON numbers; SOL/TRX use numeric u64 amounts.
    // Node >=24 supplies source lexemes before Number rounding. Never round money.
    const data = typeof response.text === 'function' ? JSON.parse(await response.text(), (key, value, ctx) => {
      if (typeof value === 'number' && ['value', 'amount', 'lamports'].includes(key)) {
        if (!ctx?.source) fail('chain.lossless_json_required');
        return ctx.source;
      }
      return value;
    }) : await response.json();
    if (data?.Error || data?.error) fail('chain.provider_error');
    return data;
  }
  async function rpc(method, params = []) {
    const body = { jsonrpc: '2.0', id: ++counter, method, params };
    const data = await request('', body);
    if (data.id !== body.id || !Object.hasOwn(data, 'result')) fail('chain.provider_invalid_response');
    return data.result;
  }
  return { c, config, tokens, watched, request, rpc };
}

function limits(fromBlock, toBlock, head, config, defaultBatch = 100) {
  const start = num(fromBlock ?? config.startBlock ?? head);
  const batch = Math.min(500, Math.max(1, num(config.batchSize ?? defaultBatch)));
  const end = Math.min(head, num(toBlock ?? head), start + batch - 1);
  return [start, end];
}

function event(c, token, txHash, index, to, from, amount, height, blockHash, time, confirmations, extra = {}) {
  if (typeof amount === 'number' && !Number.isSafeInteger(amount)) fail('chain.unsafe_amount');
  if (!/^(0|[1-9][0-9]*)$/.test(String(amount)) || BigInt(amount) <= 0n) return null;
  return { id: `${c.id}:${txHash}:${index}`, chain: c.id, token_id: token.id, tx_hash: txHash, event_index: index, to_address: to, from_address: from, amount_atomic: String(amount), block_height: height, block_hash: blockHash, block_time: time, confirmations, confirmed: confirmations >= c.confirmations, removed: false, ...extra };
}

function bitcoinAtomic(raw) {
  // Require original decimal text: accepting a Number here would lose its provenance.
  if (typeof raw !== 'string' || raw.length > 100) fail('chain.unsafe_amount');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(raw);
  if (!match) fail('chain.invalid_amount');
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) fail('chain.invalid_amount');
  const fraction = match[2] ?? '', digits = BigInt(match[1] + fraction), scale = 8 + exponent - fraction.length;
  let atomic;
  if (scale >= 0) atomic = digits * 10n ** BigInt(scale);
  else {
    const divisor = 10n ** BigInt(-scale);
    if (digits % divisor) fail('chain.invalid_amount_precision');
    atomic = digits / divisor;
  }
  if (atomic > 21_000_000n * 100_000_000n) fail('chain.invalid_amount');
  return atomic.toString();
}

async function scanBitcoin(ctx, fromBlock, toBlock) {
  const { c, config, tokens, watched, rpc } = ctx, token = tokens.find(t => t.kind === 'native');
  const info = await rpc('getblockchaininfo');
  if (info.chain !== 'main' || await rpc('getblockhash', [0]) !== BITCOIN_MAINNET_GENESIS) fail('chain.network_mismatch');
  if (info.initialblockdownload !== false) fail('chain.node_syncing');
  let head = num(info.blocks);
  const [start, end] = limits(fromBlock, toBlock, head, config, 10), transactions = [], blocks = [];
  if (end < start) return { transactions, cursor: start - 1, head, blocks, range: { from: start, to: end } };
  for (let height = start; height <= end; height++) {
    const canonical = await rpc('getblockhash', [height]);
    if (!/^[0-9a-f]{64}$/.test(canonical)) fail('chain.invalid_block_hash');
    const block = await rpc('getblock', [canonical, 2]);
    if (!block || block.hash !== canonical || num(block.height) !== height || !Array.isArray(block.tx) || !Number.isInteger(block.confirmations) || block.confirmations < 1) fail('chain.block_unavailable');
    if (blocks.length && block.previousblockhash !== blocks.at(-1).hash) fail('chain.inconsistent_blocks');
    const time = iso(num(block.time) * 1000);
    blocks.push({ height, hash: canonical, time });
    for (const tx of block.tx) {
      if (!/^[0-9a-f]{64}$/.test(tx.txid) || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) fail('chain.invalid_transaction');
      // Mining rewards are not customer payments and have an additional maturity rule.
      if (tx.vin.some(input => Object.hasOwn(input, 'coinbase'))) continue;
      for (let index = 0; index < tx.vout.length; index++) {
        const output = tx.vout[index];
        if (num(output.n) !== index) fail('chain.invalid_output_index');
        const address = output.scriptPubKey?.address;
        if (!address || !validateAddress('bitcoin', address)) continue;
        const { address: to, script } = bitcoinAddress(address);
        if (!watched.has(to)) continue;
        if (output.scriptPubKey.hex !== script) fail('chain.output_script_mismatch');
        const e = event(c, token, tx.txid, index, to, '', bitcoinAtomic(output.value), height, canonical, time, head - height + 1, { output_index: index });
        if (e) transactions.push(e);
      }
    }
  }
  const finalInfo = await rpc('getblockchaininfo');
  if (finalInfo.chain !== 'main' || finalInfo.initialblockdownload !== false) fail('chain.network_mismatch');
  head = Math.min(head, num(finalInfo.blocks));
  if (head < end) fail('chain.reorg_during_scan');
  if (await rpc('getblockhash', [end]) !== blocks.at(-1).hash) fail('chain.reorg_during_scan');
  for (const tx of transactions) { tx.confirmations = head - tx.block_height + 1; tx.confirmed = tx.confirmations >= c.confirmations; }
  return { transactions, cursor: end, head, blocks, range: { from: start, to: end } };
}

async function scanEvm(ctx, fromBlock, toBlock) {
  const { c, config, tokens, watched, rpc } = ctx;
  if (num(await rpc('eth_chainId')) !== c.chainId) fail('chain.network_mismatch');
  const head = num(await rpc('eth_blockNumber'));
  const [start, end] = limits(fromBlock, toBlock, head, config);
  if (end < start) return { transactions: [], cursor: start - 1, head, blocks: [], range: { from: start, to: end } };
  const blocks = [], blockMap = new Map(), transactions = [], receipts = new Map(), nativeToken = tokens.find(t => t.kind === 'native');
  async function receiptFor(txHash, block) {
    if (!receipts.has(txHash)) receipts.set(txHash, await rpc('eth_getTransactionReceipt', [txHash]));
    const receipt = receipts.get(txHash);
    if (!receipt || String(receipt.blockHash).toLowerCase() !== block.hash || num(receipt.blockNumber) !== block.height || (receipt.transactionHash && receipt.transactionHash.toLowerCase() !== txHash)) fail('chain.receipt_unavailable');
    return receipt;
  }
  for (let h = start; h <= end; h++) {
    const block = await rpc('eth_getBlockByNumber', [hex(h), Boolean(nativeToken)]);
    if (!block || num(block.number) !== h || !/^0x[0-9a-f]{64}$/i.test(block.hash)) fail('chain.block_unavailable');
    if (blocks.length && String(block.parentHash).toLowerCase() !== blocks.at(-1).hash) fail('chain.inconsistent_blocks');
    const item = { height: h, hash: block.hash.toLowerCase(), time: iso(num(block.timestamp) * 1000) };
    blocks.push(item); blockMap.set(h, item);
    if (nativeToken) {
      if (!Array.isArray(block.transactions)) fail('chain.transactions_unavailable');
      for (const tx of block.transactions) {
        if (typeof tx !== 'object') fail('chain.transactions_unavailable');
        if (!tx.to || !watched.has(String(tx.to).toLowerCase())) continue;
        if (!/^0x[0-9a-f]+$/i.test(tx.value)) fail('chain.invalid_amount');
        if (BigInt(tx.value) === 0n) continue;
        const txHash = String(tx.hash).toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(txHash) || String(tx.blockHash).toLowerCase() !== item.hash || num(tx.blockNumber) !== h) fail('chain.invalid_transaction');
        const receipt = await receiptFor(txHash, item);
        if (String(receipt.transactionHash).toLowerCase() !== txHash || num(receipt.transactionIndex) !== num(tx.transactionIndex)) fail('chain.receipt_unavailable');
        if (num(receipt.status) !== 1) continue;
        // Negative positions are reserved for native movements; ERC-20 logs stay >=0.
        const e = event(c, nativeToken, txHash, -1, normalizeAddress(c.id, tx.to), normalizeAddress(c.id, tx.from), BigInt(tx.value).toString(), h, item.hash, item.time, head - h + 1);
        if (e) transactions.push(e);
      }
    }
  }
  if (watched.size) {
    for (const t of tokens.filter(t => t.kind !== 'native')) {
      // decimals() from the configured contract, queried at a pinned block.
      const decimals = await rpc('eth_call', [{ to: t.contract, data: '0x313ce567' }, hex(end)]);
      if (num(decimals) !== t.decimals) fail('chain.token_decimals_mismatch');
      const destinations = [...watched.keys()].map(address => `0x${address.slice(2).padStart(64, '0')}`);
      for (let offset = 0; offset < destinations.length; offset += 50) {
        const logs = await rpc('eth_getLogs', [{ fromBlock: hex(start), toBlock: hex(end), address: t.contract, topics: [`0x${TRANSFER}`, null, destinations.slice(offset, offset + 50)] }]);
        if (!Array.isArray(logs)) fail('chain.invalid_logs');
        for (const log of logs) {
          if (String(log.address).toLowerCase() !== t.contract || !Array.isArray(log.topics) || log.topics.length !== 3 || strip(log.topics[0]) !== TRANSFER) continue;
          if (!log.topics.slice(1).every(topic => /^0x0{24}[0-9a-f]{40}$/i.test(topic)) || !/^0x[0-9a-f]{64}$/i.test(log.data)) continue;
          const to = `0x${strip(log.topics[2]).slice(-40)}`, from = `0x${strip(log.topics[1]).slice(-40)}`;
          if (!watched.has(to)) continue;
          const height = num(log.blockNumber), block = blockMap.get(height);
          if (!block || String(log.blockHash).toLowerCase() !== block.hash) fail('chain.reorg_during_scan');
          const txHash = String(log.transactionHash).toLowerCase();
          if (!/^0x[0-9a-f]{64}$/.test(txHash)) fail('chain.invalid_transaction_hash');
          const receipt = await receiptFor(txHash, block);
          if (num(receipt.status) !== 1) continue;
          const index = num(log.logIndex);
          const inReceipt = receipt.logs?.find(item => num(item.logIndex) === index && String(item.address).toLowerCase() === t.contract && String(item.data).toLowerCase() === String(log.data).toLowerCase() && JSON.stringify(item.topics?.map(strip)) === JSON.stringify(log.topics.map(strip)));
          if (!inReceipt || inReceipt.removed || log.removed) continue;
          const e = event(c, t, txHash, index, to, from, BigInt(log.data).toString(), height, block.hash, block.time, head - height + 1);
          if (e) transactions.push(e);
        }
      }
    }
  }
  // A provider may change branch during the multi-call scan. Do not commit a partial view.
  const check = await rpc('eth_getBlockByNumber', [hex(end), false]);
  if (!check || String(check.hash).toLowerCase() !== blockMap.get(end).hash) fail('chain.reorg_during_scan');
  return { transactions, cursor: end, head, blocks, range: { from: start, to: end } };
}

async function scanTron(ctx, fromBlock, toBlock) {
  const { c, config, tokens, watched, request } = ctx;
  const genesis = await request('/walletsolidity/getblockbynum', { num: 0 });
  if (genesis.blockID !== config.expectedGenesisHash) fail('chain.network_mismatch');
  const solid = await request('/walletsolidity/getnowblock', {});
  const head = num(solid.block_header?.raw_data?.number);
  const [start, end] = limits(fromBlock, toBlock, head, config, 20), transactions = [], blocks = [];
  const contractTokens = tokens.filter(t => t.kind !== 'native'), nativeToken = tokens.find(t => t.kind === 'native');
  const contracts = new Map(contractTokens.map(t => [tronToHex(t.contract).slice(2), t]));
  for (const t of contractTokens) {
    const result = await request('/walletsolidity/triggerconstantcontract', { owner_address: t.contract, contract_address: t.contract, function_selector: 'decimals()', visible: true });
    if (result.result?.result !== true || result.constant_result?.length !== 1 || num(`0x${result.constant_result[0]}`) !== t.decimals) fail('chain.token_decimals_mismatch');
  }
  for (let h = start; h <= end; h++) {
    const block = await request('/walletsolidity/getblockbynum', { num: h });
    if (!block.blockID || num(block.block_header?.raw_data?.number) !== h) fail('chain.block_unavailable');
    if (blocks.length && block.block_header.raw_data.parentHash !== blocks.at(-1).hash) fail('chain.inconsistent_blocks');
    const time = iso(num(block.block_header.raw_data.timestamp));
    blocks.push({ height: h, hash: block.blockID, time });
    for (const tx of block.transactions ?? []) {
      if (!tx.ret?.length || tx.ret.some(ret => ret.contractRet !== 'SUCCESS')) continue;
      const receipt = await request('/walletsolidity/gettransactioninfobyid', { value: tx.txID });
      if (receipt.id !== tx.txID || num(receipt.blockNumber) !== h) fail('chain.receipt_unavailable');
      if (receipt.result === 'FAILED' || (receipt.receipt?.result && receipt.receipt.result !== 'SUCCESS')) continue;
      if (nativeToken) {
        for (const [index, contract] of (tx.raw_data?.contract ?? []).entries()) {
          if (contract.type !== 'TransferContract' || contract.parameter?.type_url !== 'type.googleapis.com/protocol.TransferContract') continue;
          const info = contract.parameter.value;
          const to = normalizeAddress(c.id, info?.to_address); if (!watched.has(to)) continue;
          if (!/^[0-9a-f]{64}$/i.test(tx.txID)) fail('chain.invalid_transaction_hash');
          const from = normalizeAddress(c.id, info.owner_address);
          const e = event(c, nativeToken, tx.txID, -(index + 1), to, from, info.amount, h, block.blockID, time, Math.max(c.confirmations, head - h + 1), { finality: 'solidified' });
          if (e) transactions.push(e);
        }
      }
      for (const [index, log] of (receipt.log ?? []).entries()) {
        const t = contracts.get(strip(log.address));
        if (!t || log.topics?.length !== 3 || strip(log.topics[0]) !== TRANSFER) continue;
        if (!log.topics.slice(1).every(topic => /^0{24}[0-9a-f]{40}$/i.test(strip(topic))) || !/^[0-9a-f]{64}$/i.test(strip(log.data))) continue;
        const to = tronFromHex(strip(log.topics[2]).slice(-40)); if (!watched.has(to)) continue;
        const from = tronFromHex(strip(log.topics[1]).slice(-40));
        const e = event(c, t, tx.txID, index, to, from, BigInt(`0x${strip(log.data)}`).toString(), h, block.blockID, time, Math.max(c.confirmations, head - h + 1), { finality: 'solidified' });
        if (e) transactions.push(e);
      }
    }
  }
  if (blocks.length) {
    const check = await request('/walletsolidity/getblockbynum', { num: end });
    if (check.blockID !== blocks.at(-1).hash) fail('chain.reorg_during_scan');
  }
  return { transactions, cursor: end, head, blocks, range: { from: start, to: end } };
}

// A successful transaction can catch a failed inner CPI. Only credit inner transfers
// if the invocation and every ancestor have explicit success logs. Truncated or
// ambiguous logs fail closed for inner instructions; top-level success is in meta.err.
function solanaInnerSuccess(instructions, logs) {
  const invocations = [], stack = [];
  for (const line of logs ?? []) {
    let match = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[([0-9]+)\]$/.exec(line);
    if (match) {
      const depth = num(match[2]);
      if (depth !== stack.length + 1) return new Set();
      const item = { programId: match[1], depth, parent: stack.at(-1), success: false };
      invocations.push(item); stack.push(item); continue;
    }
    match = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(line);
    if (match) {
      const item = stack.pop(); if (!item || item.programId !== match[1]) return new Set();
      item.success = match[2] === 'success';
    }
  }
  // Known top-level signature precompiles do not emit ordinary invoke logs and
  // cannot perform CPI. Filter only the log-matching view, never event positions.
  const expectedInvocations = instructions.filter(item => item.inner || !SOLANA_PRECOMPILES.has(item.instruction.programId));
  if (stack.length || invocations.length !== expectedInvocations.length) return new Set();
  const successful = new Set();
  for (let i = 0; i < expectedInvocations.length; i++) {
    const expected = expectedInvocations[i], actual = invocations[i];
    if (expected.instruction.programId !== actual.programId || (expected.instruction.stackHeight != null && expected.instruction.stackHeight !== actual.depth) || (!expected.inner && actual.depth !== 1)) return new Set();
    let current = actual, success = true;
    while (current) { success &&= current.success; current = current.parent; }
    if (success) successful.add(expected.index);
  }
  return successful;
}

async function scanSolana(ctx, fromBlock, toBlock) {
  const { c, config, tokens, watched, rpc } = ctx;
  if (await rpc('getGenesisHash') !== config.expectedGenesisHash) fail('chain.network_mismatch');
  const head = num(await rpc('getSlot', [{ commitment: 'finalized' }]));
  const [start, end] = limits(fromBlock, toBlock, head, config, 20), transactions = [], blocks = [];
  if (end < start) return { transactions, cursor: start - 1, head, blocks, range: { from: start, to: end } };
  const mints = new Map(), nativeToken = tokens.find(t => t.kind === 'native');
  for (const t of tokens.filter(t => t.kind !== 'native')) {
    const mint = await rpc('getAccountInfo', [t.mint, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    const value = mint?.value;
    if (value?.owner !== SPL_PROGRAM || value?.data?.parsed?.type !== 'mint' || value.data.parsed.info.decimals !== t.decimals || value.data.parsed.info.isInitialized !== true) fail('chain.token_metadata_mismatch');
    mints.set(t.mint, t);
  }
  // getBlocks excludes skipped slots. An unavailable returned slot is an error, never silently skipped.
  const slots = await rpc('getBlocks', [start, end, { commitment: 'finalized' }]);
  if (!Array.isArray(slots)) fail('chain.invalid_slots');
  for (const rawSlot of slots) {
    const slot = num(rawSlot); if (slot < start || slot > end) fail('chain.invalid_slots');
    const block = await rpc('getBlock', [slot, { commitment: 'finalized', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 1, rewards: false }]);
    if (!block?.blockhash || block.blockTime === null || block.blockTime === undefined || !Array.isArray(block.transactions)) fail('chain.block_unavailable');
    const time = iso(num(block.blockTime) * 1000); blocks.push({ height: slot, hash: block.blockhash, time });
    for (const tx of block.transactions) {
      if (tx.version !== undefined && !['legacy', 0, 1].includes(tx.version)) fail('chain.unsupported_transaction_version');
      if (!tx.meta || tx.meta.err !== null) continue;
      const signature = tx.transaction?.signatures?.[0]; if (!signature) fail('chain.invalid_transaction_hash');
      const message = tx.transaction.message, accountKeys = message.accountKeys.map(a => typeof a === 'string' ? a : a.pubkey);
      const balances = new Map();
      for (const balance of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
        if (balance.owner && (balance.programId === undefined || balance.programId === SPL_PROGRAM)) balances.set(accountKeys[balance.accountIndex], balance);
      }
      const instructions = [];
      for (let index = 0; index < message.instructions.length; index++) {
        instructions.push({ instruction: message.instructions[index], index: instructions.length, inner: false });
        const inner = tx.meta.innerInstructions?.find(item => item.index === index);
        for (let j = 0; j < (inner?.instructions ?? []).length; j++) instructions.push({ instruction: inner.instructions[j], index: instructions.length, inner: true });
      }
      const innerSuccess = solanaInnerSuccess(instructions, tx.meta.logMessages);
      for (const { instruction, index, inner } of instructions) {
        if (inner && !innerSuccess.has(index)) continue;
        if (nativeToken && instruction.programId === SYSTEM_PROGRAM && ['transfer', 'transferWithSeed'].includes(instruction.parsed?.type)) {
          const info = instruction.parsed.info;
          const to = normalizeAddress(c.id, info?.destination); if (!watched.has(to)) continue;
          const e = event(c, nativeToken, signature, index, to, normalizeAddress(c.id, info.source), info.lamports, slot, block.blockhash, time, c.confirmations, { finality: 'finalized' });
          if (e) transactions.push(e);
          continue;
        }
        if (instruction.programId !== SPL_PROGRAM || !['transfer', 'transferChecked'].includes(instruction.parsed?.type)) continue;
        const info = instruction.parsed.info, destination = balances.get(info.destination), source = balances.get(info.source);
        if (!destination || !watched.has(destination.owner)) continue;
        const t = mints.get(destination.mint); if (!t || destination.uiTokenAmount?.decimals !== t.decimals) continue;
        if (info.mint && info.mint !== t.mint) continue;
        if (source && source.mint !== t.mint) continue;
        const amount = instruction.parsed.type === 'transferChecked' ? info.tokenAmount?.amount : info.amount;
        if (instruction.parsed.type === 'transferChecked' && info.tokenAmount?.decimals !== t.decimals) continue;
        const e = event(c, t, signature, index, destination.owner, source?.owner ?? '', amount, slot, block.blockhash, time, c.confirmations, { finality: 'finalized' });
        if (e) transactions.push(e);
      }
    }
  }
  return { transactions, cursor: end, head, blocks, range: { from: start, to: end } };
}

async function scanAptos(ctx, fromBlock, toBlock) {
  const { c, config, tokens, watched, request } = ctx;
  const ledger = await request('');
  if (num(ledger.chain_id) !== c.chainId) fail('chain.network_mismatch');
  const head = num(ledger.ledger_version), [start, end] = limits(fromBlock, toBlock, head, config, 100), transactions = [], blocks = [];
  if (end < start) return { transactions, cursor: start - 1, head, blocks, range: { from: start, to: end } };
  const tokenMap = new Map(tokens.map(t => [t.metadata, t]));
  const primaryStores = new Map();
  for (const owner of watched.keys()) for (const t of tokens) primaryStores.set(aptosPrimaryStore(owner, t.metadata), { owner, token: t });
  const resources = new Map();
  async function resource(address, type, version) {
    const key = `${address}/${type}/${version}`;
    if (!resources.has(key)) resources.set(key, await request(`/accounts/${address}/resource/${encodeURIComponent(type)}?ledger_version=${version}`));
    return resources.get(key)?.data;
  }
  for (const t of tokens) {
    const metadata = await resource(t.metadata, '0x1::fungible_asset::Metadata', end);
    if (metadata?.decimals !== t.decimals) fail('chain.token_decimals_mismatch');
  }
  let cursor = start;
  while (cursor <= end) {
    const list = await request(`/transactions?start=${cursor}&limit=${Math.min(100, end - cursor + 1)}`);
    if (!Array.isArray(list) || !list.length) fail('chain.transactions_unavailable');
    for (const tx of list) {
      const version = num(tx.version); if (version !== cursor || version > end) fail('chain.non_contiguous_transactions');
      cursor++;
      if (!tx.hash) fail('chain.invalid_transaction_hash');
      const time = typeof tx.timestamp === 'string' && /^\d+$/.test(tx.timestamp) ? iso(num(BigInt(tx.timestamp) / 1000n)) : undefined;
      blocks.push({ height: version, hash: tx.hash, ...(time ? { time } : {}) });
      if (tx.type !== 'user_transaction' || tx.success !== true) continue;
      if (!time) fail('chain.invalid_timestamp');
      for (const [index, evt] of (tx.events ?? []).entries()) {
        // FA Deposit supplies a store, not its owner or token. Resolve both at this transaction's version.
        if (!/^0x0*1::fungible_asset::Deposit$/.test(evt.type)) continue;
        const store = aptosAddress(evt.data?.store);
        const expected = primaryStores.get(store); if (!expected) continue;
        const fa = await resource(store, '0x1::fungible_asset::FungibleStore', version);
        if (!fa?.metadata?.inner) fail('chain.invalid_fungible_store');
        const t = tokenMap.get(aptosAddress(fa.metadata.inner)); if (!t) continue;
        const obj = await resource(store, '0x1::object::ObjectCore', version);
        const to = aptosAddress(obj?.owner); if (to !== expected.owner || t.id !== expected.token.id) fail('chain.store_identity_mismatch');
        const e = event(c, t, tx.hash, index, to, aptosAddress(tx.sender), evt.data.amount, version, tx.hash, time, 1, { finality: 'committed', ledger_version: version });
        if (e) transactions.push(e);
      }
    }
  }
  return { transactions, cursor: end, head, blocks, range: { from: start, to: end } };
}

export async function scanChain({ chain, addresses, fromBlock, toBlock, config, fetchImpl = fetch }) {
  const ctx = context(chain, addresses, config, fetchImpl);
  const scanner = { bitcoin: scanBitcoin, evm: scanEvm, tron: scanTron, solana: scanSolana, aptos: scanAptos }[ctx.c.family];
  const result = await scanner(ctx, fromBlock, toBlock);
  // A provider may duplicate logs; one event can never count twice in a batch.
  result.transactions = [...new Map(result.transactions.map(tx => [tx.id, tx])).values()];
  return result;
}
