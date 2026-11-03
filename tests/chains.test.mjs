import test from 'node:test';
import assert from 'node:assert/strict';
import { registry, scanChain, configuredTokens, isChainConfigured, validateAddress, normalizeAddress, tronFromHex, tronToHex, aptosPrimaryStore, BITCOIN_MAINNET_GENESIS } from '../server/chains.mjs';

const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const addr = digit => `0x${digit.repeat(40)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const asTopic = address => `0x${address.slice(2).padStart(64, '0')}`;
const amount = 900719925474099300000001n;
const evmConfig = { enabled: true, rpcUrl: 'https://node.example.test', chainId: 56, tokens: [{ id: 'bsc-usdt', contract: addr('a'), decimals: 18 }] };
const response = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
function rpcFixture(handler) { return async (_url, options) => { const req = JSON.parse(options.body); return response({ jsonrpc: '2.0', id: req.id, result: await handler(req.method, req.params) }); }; }
function evmFixture({ status = '0x1', extraLogs = [], removed = false, fakeContract = false, mismatchDecimals = false, branchChange = false, head = '0x72' } = {}) {
  const log = { address: fakeContract ? addr('e') : addr('a'), blockNumber: '0x64', blockHash: hash('b'), transactionHash: hash('c'), logIndex: '0x1', data: `0x${amount.toString(16).padStart(64, '0')}`, topics: [TOPIC, asTopic(addr('2')), asTopic(addr('1'))], removed };
  let reads = 0;
  return rpcFixture((method, params) => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_blockNumber') return head;
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: branchChange && reads++ ? hash('d') : hash('b'), parentHash: hash('0'), timestamp: '0x6553f100' };
    if (method === 'eth_call') return mismatchDecimals ? '0x6' : '0x12';
    if (method === 'eth_getLogs') return [log, ...extraLogs];
    if (method === 'eth_getTransactionReceipt') return { status, blockHash: hash('b'), blockNumber: '0x64', logs: [log] };
    throw new Error(`unexpected fixture method ${method}`);
  });
}
const evmScan = overrides => scanChain({ chain: 'bsc', config: evmConfig, addresses: [addr('1')], fromBlock: 100, toBlock: 100, ...overrides });

test('registry describes eleven networks and seven native assets without claiming they are configured', () => {
  assert.equal(registry.length, 11);
  assert.deepEqual(registry.flatMap(c => c.tokens.filter(t => t.kind === 'native').map(t => t.id)).sort(), ['bitcoin-btc', 'ethereum-eth', 'base-eth', 'arbitrum-eth', 'bsc-bnb', 'solana-sol', 'tron-trx'].sort());
  assert.ok(registry.flatMap(c => c.tokens).every(t => t.priceAsset));
  assert.equal(isChainConfigured('bsc', {}), false);
  assert.equal(isChainConfigured('bsc', evmConfig), true);
  assert.equal(configuredTokens('bsc', { ...evmConfig, tokens: [{ ...evmConfig.tokens[0], decimals: 6 }] }).length, 0);
  assert.equal(configuredTokens('bsc', { ...evmConfig, chainId: 1 }).length, 0);
  assert.equal(configuredTokens('bsc', { ...evmConfig, rpcUrl: 'http://unsafe.example' }).length, 0);
});

test('address validation rejects malformed/checksum-invalid addresses and normalizes equivalent Aptos addresses', () => {
  assert.equal(validateAddress('bsc', addr('a')), true);
  assert.equal(validateAddress('bsc', '0x123'), false);
  assert.equal(validateAddress('solana', 'garbage'), false);
  assert.equal(validateAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), true);
  assert.equal(validateAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u'), false);
  const tron = tronFromHex('41' + '12'.repeat(20));
  assert.equal(tronToHex(tron), '41' + '12'.repeat(20));
  assert.equal(normalizeAddress('aptos', '0x1'), '0x' + '0'.repeat(63) + '1');
});

test('EVM receipt-backed event preserves integer amount and exact network/token/recipient identity', async () => {
  const result = await evmScan({ fetchImpl: evmFixture() });
  assert.equal(result.transactions.length, 1);
  const e = result.transactions[0];
  assert.equal(e.amount_atomic, amount.toString());
  assert.equal(e.to_address, addr('1'));
  assert.equal(e.token_id, 'bsc-usdt');
  assert.equal(e.confirmed, true);
  assert.equal(e.confirmations, 15);
  assert.equal(e.event_index, 1);
  assert.equal(result.cursor, 100);
  assert.equal(result.blocks[0].hash, hash('b'));
});

test('EVM underconfirmed transaction remains unconfirmed', async () => {
  const result = await evmScan({ fetchImpl: evmFixture({ head: '0x65' }) });
  assert.equal(result.transactions[0].confirmed, false);
  assert.equal(result.transactions[0].confirmations, 2);
});

test('EVM failed receipt, fake token, removed event cannot become a payment', async () => {
  for (const fixture of [{ status: '0x0' }, { fakeContract: true }, { removed: true }]) {
    assert.equal((await evmScan({ fetchImpl: evmFixture(fixture) })).transactions.length, 0);
  }
});

test('EVM refuses wrong token precision, wrong chain, and branch changes', async () => {
  await assert.rejects(evmScan({ fetchImpl: evmFixture({ mismatchDecimals: true }) }), /decimals_mismatch/);
  await assert.rejects(evmScan({ fetchImpl: evmFixture({ branchChange: true }) }), /reorg_during_scan/);
  await assert.rejects(evmScan({ fetchImpl: rpcFixture(() => '0x1') }), /network_mismatch/);
});

test('provider failure aborts the entire scan instead of returning an advanced cursor', async () => {
  await assert.rejects(evmScan({ fetchImpl: async () => ({ ok: false, status: 429 }) }), /provider_http_429/);
  await assert.rejects(evmScan({ config: {} }), /not_configured/);
});

function tronFixture({ failed = false, fake = false } = {}) {
  const contract = tronFromHex('41' + 'aa'.repeat(20)), to = tronFromHex('41' + '11'.repeat(20));
  const config = { enabled: true, rpcUrl: 'https://tron.example.test', expectedGenesisHash: 'genesis', tokens: [{ id: 'tron-usdt', contract, decimals: 6 }] };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body), path = new URL(url).pathname;
    if (path.endsWith('getblockbynum') && body.num === 0) return response({ blockID: 'genesis' });
    if (path.endsWith('triggerconstantcontract')) return response({ result: { result: true }, constant_result: ['06'] });
    if (path.endsWith('getnowblock')) return response({ block_header: { raw_data: { number: 100 } } });
    if (path.endsWith('getblockbynum')) return response({ blockID: 'canonical', block_header: { raw_data: { number: 100, timestamp: 1700000000000 } }, transactions: [{ txID: 'tx1', ret: [{ contractRet: 'SUCCESS' }] }] });
    if (path.endsWith('gettransactioninfobyid')) return response({ id: 'tx1', blockNumber: 100, receipt: { result: failed ? 'REVERT' : 'SUCCESS' }, log: [{ address: (fake ? 'bb' : 'aa').repeat(20), topics: [TOPIC.slice(2), '0'.repeat(24) + '22'.repeat(20), '0'.repeat(24) + '11'.repeat(20)], data: '123'.padStart(64, '0') }] });
    throw new Error('unexpected fixture');
  };
  return { chain: 'tron', config, addresses: [to], fromBlock: 100, toBlock: 100, fetchImpl };
}

test('TRON uses solidified receipt logs, checksum addresses and exact configured contracts', async () => {
  const result = await scanChain(tronFixture());
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount_atomic, '291');
  assert.equal(result.transactions[0].finality, 'solidified');
  assert.equal(result.transactions[0].confirmed, true);
  assert.equal((await scanChain(tronFixture({ failed: true }))).transactions.length, 0);
  assert.equal((await scanChain(tronFixture({ fake: true }))).transactions.length, 0);
});

const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const owner = '11111111111111111111111111111111';
const programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function solanaFixture({ failed = false, fakeMint = false, wrongProgram = false, missingBlock = false } = {}) {
  const config = { enabled: true, rpcUrl: 'https://solana.example.test', expectedGenesisHash: 'genesis', tokens: [{ id: 'solana-usdc', mint, decimals: 6 }] };
  const destinationMint = fakeMint ? owner : mint;
  const instruction = { programId: wrongProgram ? owner : programId, parsed: { type: 'transferChecked', info: { source: 'sourceATA', destination: 'destATA', mint: destinationMint, tokenAmount: { amount: '1000001', decimals: 6 } } } };
  const tx = { transaction: { signatures: ['signature'], message: { accountKeys: [{ pubkey: 'sourceATA' }, { pubkey: 'destATA' }], instructions: [instruction] } }, meta: { err: failed ? { InstructionError: [0, 'Custom'] } : null, preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: destinationMint, owner, programId, uiTokenAmount: { decimals: 6 } }], innerInstructions: [] } };
  const fetchImpl = rpcFixture(method => {
    if (method === 'getGenesisHash') return 'genesis';
    if (method === 'getSlot') return 100;
    if (method === 'getAccountInfo') return { value: { owner: programId, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } } };
    if (method === 'getBlocks') return [100];
    if (method === 'getBlock') return missingBlock ? null : { blockhash: 'blockhash', blockTime: 1700000000, transactions: [tx] };
    throw new Error('unexpected fixture');
  });
  return { chain: 'solana', addresses: [owner], fromBlock: 100, toBlock: 100, config, fetchImpl };
}

test('Solana settles only successful finalized SPL transfers to the recipient owner', async () => {
  const result = await scanChain(solanaFixture());
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount_atomic, '1000001');
  assert.equal(result.transactions[0].to_address, owner);
  assert.equal(result.transactions[0].finality, 'finalized');
  for (const bad of [{ failed: true }, { fakeMint: true }, { wrongProgram: true }]) assert.equal((await scanChain(solanaFixture(bad))).transactions.length, 0);
  await assert.rejects(scanChain(solanaFixture({ missingBlock: true })), /block_unavailable/);
});

function aptosFixture({ failed = false, fakeToken = false, wrongOwner = false } = {}) {
  const metadata = '0xabc', owner = '0x123', store = aptosPrimaryStore(owner, metadata);
  const config = { enabled: true, rpcUrl: 'https://aptos.example.test/v1', chainId: 1, tokens: [{ id: 'aptos-usdc', metadata, decimals: 6 }] };
  const fetchImpl = async url => {
    const parsed = new URL(url), path = decodeURIComponent(parsed.pathname);
    if (path === '/v1') return response({ chain_id: 1, ledger_version: '100' });
    if (path.endsWith('::Metadata')) return response({ data: { decimals: 6 } });
    if (path.endsWith('::FungibleStore')) return response({ data: { metadata: { inner: fakeToken ? '0xdef' : metadata } } });
    if (path.endsWith('::ObjectCore')) return response({ data: { owner: wrongOwner ? '0x456' : owner } });
    if (path.endsWith('/transactions')) return response([{ version: '100', hash: '0xtransaction', type: 'user_transaction', success: !failed, sender: '0x456', timestamp: '1700000000000000', events: [{ type: '0x1::fungible_asset::Deposit', data: { store, amount: '9007199254740993' } }] }]);
    throw new Error(`unexpected fixture ${path}`);
  };
  return { chain: 'aptos', config, addresses: [owner], fromBlock: 100, toBlock: 100, fetchImpl };
}

test('Aptos validates FA metadata and store ownership at the committed transaction version', async () => {
  const result = await scanChain(aptosFixture());
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount_atomic, '9007199254740993');
  assert.equal(result.transactions[0].finality, 'committed');
  assert.equal((await scanChain(aptosFixture({ failed: true }))).transactions.length, 0);
  assert.equal((await scanChain(aptosFixture({ fakeToken: true }))).transactions.length, 0);
  await assert.rejects(scanChain(aptosFixture({ wrongOwner: true })), /store_identity_mismatch/);
});

// BIP-350 published address/script vectors; mainnet only.
const btcAddress = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const btcScript = '0014751e76e8199196d454941c45d1b3a323f1433bd6';
const taproot = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
const taprootScript = '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const btcConfig = { enabled: true, rpcUrl: 'http://127.0.0.1:8332', network: 'main', expectedGenesisHash: BITCOIN_MAINNET_GENESIS, startBlock: 100, tokens: [{ id: 'bitcoin-btc', kind: 'native', decimals: 8 }] };

test('Bitcoin validates Base58Check, mainnet Bech32/Bech32m, witness versions and padding', () => {
  for (const address of [btcAddress, btcAddress.toUpperCase(), taproot, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'BC1SW50QGDZ25J', 'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs']) assert.equal(validateAddress('bitcoin', address), true, address);
  for (const address of [
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh',
    'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4',
    'BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R',
    'bc1pw5dgrnzv', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav',
    'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf',
    'bc1gmk9yu', btcAddress.replace('q', 'Q'), 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c',
  ]) assert.equal(validateAddress('bitcoin', address), false, address);
  assert.equal(normalizeAddress('bitcoin', btcAddress.toUpperCase()), btcAddress);
});

test('native configuration requires explicit kind, network identity, exact precision and Bitcoin startBlock', () => {
  assert.equal(isChainConfigured('bitcoin', btcConfig), true);
  for (const bad of [{ network: 'test' }, { expectedGenesisHash: 'wrong' }, { startBlock: undefined }, { tokens: [{ id: 'bitcoin-btc', decimals: 8 }] }, { tokens: [{ id: 'bitcoin-btc', kind: 'native', decimals: 6 }] }, { tokens: [{ id: 'bitcoin-btc', kind: 'native', decimals: 8, contract: btcAddress }] }]) assert.equal(isChainConfigured('bitcoin', { ...btcConfig, ...bad }), false);
  assert.equal(configuredTokens('bsc', { ...evmConfig, tokens: [{ id: 'bsc-bnb', kind: 'native', decimals: 18, priceAsset: 'USDT' }] })[0].priceAsset, 'BNB');
});

function bitcoinFixture({ head = 105, wrongNetwork = false, wrongGenesis = false, syncing = false, branchChange = false, orphan = false, scriptMismatch = false, value = '0.00000001', duplicate = false, coinbase = false, unsafeNumber = false } = {}) {
  let blockHashReads = 0;
  const tx = { txid: 'c'.repeat(64), vin: coinbase ? [{ coinbase: '00' }] : [{ txid: 'd'.repeat(64), vout: 0 }], vout: [
    { n: 0, value: JSON.rawJSON(value), scriptPubKey: { address: btcAddress, hex: scriptMismatch ? '00' : btcScript } },
    { n: 1, value: JSON.rawJSON('0.10000001'), scriptPubKey: { address: taproot, hex: taprootScript } },
  ] };
  const fetchImpl = rpcFixture((method, params) => {
    if (method === 'getblockchaininfo') return { chain: wrongNetwork ? 'test' : 'main', blocks: head, initialblockdownload: syncing };
    if (method === 'getblockhash') return params[0] === 0 ? (wrongGenesis ? 'a'.repeat(64) : BITCOIN_MAINNET_GENESIS) : (branchChange && blockHashReads++ ? 'e'.repeat(64) : 'b'.repeat(64));
    if (method === 'getblock') return { hash: 'b'.repeat(64), height: 100, confirmations: orphan ? -1 : head - 99, previousblockhash: 'a'.repeat(64), time: 1700000000, tx: duplicate ? [tx, tx] : [tx] };
    throw new Error(`unexpected fixture ${method}`);
  });
  return { chain: 'bitcoin', config: btcConfig, addresses: [btcAddress.toUpperCase(), taproot], fromBlock: 100, toBlock: 100, fetchImpl: unsafeNumber ? async (...args) => { const result = await fetchImpl(...args); const body = JSON.parse(await result.text()); return { ok: true, json: async () => body }; } : fetchImpl };
}

test('Bitcoin counts exact UTXO output values and distinct output indices, with canonical confirmation count', async () => {
  const result = await scanChain(bitcoinFixture({ duplicate: true }));
  assert.deepEqual(result.transactions.map(t => [t.event_index, t.amount_atomic, t.confirmations, t.confirmed]), [[0, '1', 6, true], [1, '10000001', 6, true]]);
  assert.equal(result.transactions[0].from_address, '');
  assert.equal(result.transactions[0].block_hash, 'b'.repeat(64));
  assert.equal((await scanChain(bitcoinFixture({ value: '1e-8', head: 104 }))).transactions[0].amount_atomic, '1');
  assert.equal((await scanChain(bitcoinFixture({ head: 104 }))).transactions[0].confirmed, false);
  assert.equal((await scanChain(bitcoinFixture({ value: '20999999.99999999' }))).transactions[0].amount_atomic, '2099999999999999');
  assert.equal((await scanChain(bitcoinFixture({ coinbase: true }))).transactions.length, 0);
});

test('Bitcoin rejects foreign networks, syncing/orphan blocks, script/address disagreement, decimal rounding and reorg', async () => {
  for (const [options, error] of [[{ wrongNetwork: true }, /network_mismatch/], [{ wrongGenesis: true }, /network_mismatch/], [{ syncing: true }, /node_syncing/], [{ orphan: true }, /block_unavailable/], [{ scriptMismatch: true }, /script_mismatch/], [{ value: '0.000000001' }, /amount_precision/], [{ branchChange: true }, /reorg_during_scan/], [{ unsafeNumber: true }, /unsafe_amount/]]) await assert.rejects(scanChain(bitcoinFixture(options)), error);
});

function evmNativeFixture({ failed = false, wrongReceipt = false, contractCreation = false, zero = false, includeToken = false } = {}) {
  const config = { ...evmConfig, tokens: [{ id: 'bsc-bnb', kind: 'native', decimals: 18 }, ...(includeToken ? evmConfig.tokens : [])] };
  const log = { address: addr('a'), blockNumber: '0x64', blockHash: hash('b'), transactionHash: hash('c'), logIndex: '0x0', data: '0x' + '1'.padStart(64, '0'), topics: [TOPIC, asTopic(addr('2')), asTopic(addr('1'))] };
  const tx = { hash: hash('c'), blockHash: hash('b'), blockNumber: '0x64', transactionIndex: '0x0', from: addr('2'), to: contractCreation ? null : addr('1'), value: zero ? '0x0' : '0x10000000000000001' };
  const fetchImpl = rpcFixture(method => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_blockNumber') return '0x72';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: hash('b'), parentHash: hash('0'), timestamp: '0x6553f100', transactions: [tx] };
    if (method === 'eth_getTransactionReceipt') return { transactionHash: tx.hash, transactionIndex: '0x0', status: failed ? '0x0' : '0x1', blockNumber: '0x64', blockHash: wrongReceipt ? hash('e') : hash('b'), logs: [log] };
    if (method === 'eth_call') return '0x12';
    if (method === 'eth_getLogs') return [log];
    throw new Error(`unexpected fixture ${method}`);
  });
  return { chain: 'bsc', config, addresses: [addr('1')], fromBlock: 100, toBlock: 100, fetchImpl };
}

test('EVM native top-level value uses successful canonical receipt and a disjoint native index', async () => {
  const result = await scanChain(evmNativeFixture({ includeToken: true }));
  assert.deepEqual(result.transactions.map(t => [t.token_id, t.event_index, t.amount_atomic]), [['bsc-bnb', -1, '18446744073709551617'], ['bsc-usdt', 0, '1']]);
  for (const options of [{ failed: true }, { contractCreation: true }, { zero: true }]) assert.equal((await scanChain(evmNativeFixture(options))).transactions.length, 0);
  await assert.rejects(scanChain(evmNativeFixture({ wrongReceipt: true })), /receipt_unavailable/);
});

function tronNativeFixture({ failed = false, wrongType = false, unsafeNumber = false } = {}) {
  const base = tronFixture({ failed });
  base.config.tokens.push({ id: 'tron-trx', kind: 'native', decimals: 6 });
  const original = base.fetchImpl;
  base.fetchImpl = async (url, options) => {
    const body = await (await original(url, options)).json();
    if (body.transactions) {
      body.transactions[0].txID = 'c'.repeat(64);
      body.transactions[0].raw_data = { contract: [{ type: wrongType ? 'TriggerSmartContract' : 'TransferContract', parameter: { type_url: 'type.googleapis.com/protocol.TransferContract', value: { owner_address: '41' + '22'.repeat(20), to_address: '41' + '11'.repeat(20), amount: unsafeNumber ? Number('9007199254740993') : JSON.rawJSON('9007199254740993') } } }] };
    }
    if (body.id === 'tx1') body.id = 'c'.repeat(64);
    return unsafeNumber ? { ok: true, json: async () => body } : response(body);
  };
  return base;
}

test('TRX preserves raw numeric sun and separates native contract indices from token log indices', async () => {
  const result = await scanChain(tronNativeFixture());
  assert.deepEqual(result.transactions.map(t => [t.token_id, t.event_index, t.amount_atomic]), [['tron-trx', -1, '9007199254740993'], ['tron-usdt', 0, '291']]);
  assert.equal((await scanChain(tronNativeFixture({ failed: true }))).transactions.length, 0);
  assert.equal((await scanChain(tronNativeFixture({ wrongType: true }))).transactions.filter(t => t.token_id === 'tron-trx').length, 0);
  await assert.rejects(scanChain(tronNativeFixture({ unsafeNumber: true })), /unsafe_amount/);
});

function solanaNativeFixture({ failed = false, type = 'transfer', wrongProgram = false, inner = false, innerFailed = false, ancestorFailed = false, missingLogs = false } = {}) {
  const nativeInstruction = { programId: wrongProgram ? programId : owner, stackHeight: ancestorFailed ? 3 : inner ? 2 : 1, parsed: { type, info: { source: mint, destination: owner, lamports: JSON.rawJSON('9007199254740993') } } };
  const config = { enabled: true, rpcUrl: 'https://solana.example.test', expectedGenesisHash: 'genesis', tokens: [{ id: 'solana-sol', kind: 'native', decimals: 9 }] };
  const tx = { transaction: { signatures: ['native-signature'], message: { accountKeys: [mint, owner], instructions: inner ? [{ programId: mint, stackHeight: 1 }] : [nativeInstruction] } }, meta: { err: failed ? { InstructionError: [0, 'Custom'] } : null, preBalances: [10, 10], postBalances: [0, 20], preTokenBalances: [], postTokenBalances: [], innerInstructions: inner ? [{ index: 0, instructions: [nativeInstruction] }] : [], logMessages: missingLogs ? null : inner ? [`Program ${mint} invoke [1]`, `Program ${owner} invoke [2]`, `Program ${owner} ${innerFailed ? 'failed: insufficient lamports' : 'success'}`, `Program ${mint} success`] : [] } };
  if (ancestorFailed) {
    tx.meta.innerInstructions = [{ index: 0, instructions: [{ programId, stackHeight: 2 }, nativeInstruction] }];
    tx.meta.logMessages = [`Program ${mint} invoke [1]`, `Program ${programId} invoke [2]`, `Program ${owner} invoke [3]`, `Program ${owner} success`, `Program ${programId} failed: caught by outer program`, `Program ${mint} success`];
  }
  return { chain: 'solana', config, addresses: [owner], fromBlock: 100, toBlock: 100, fetchImpl: rpcFixture(method => {
    if (method === 'getGenesisHash') return 'genesis';
    if (method === 'getSlot') return 100;
    if (method === 'getBlocks') return [100];
    if (method === 'getBlock') return { blockhash: 'blockhash', blockTime: 1700000000, transactions: [tx] };
    throw new Error(`unexpected fixture ${method}`);
  }) };
}

test('SOL credits only explicit System Program transfers with exact lamports, never fees or balance deltas', async () => {
  for (const options of [{}, { type: 'transferWithSeed' }, { inner: true }]) assert.equal((await scanChain(solanaNativeFixture(options))).transactions[0].amount_atomic, '9007199254740993');
  for (const options of [{ failed: true }, { wrongProgram: true }, { type: 'createAccount' }, { inner: true, innerFailed: true }, { inner: true, ancestorFailed: true }, { inner: true, missingLogs: true }]) assert.equal((await scanChain(solanaNativeFixture(options))).transactions.length, 0);
});

test('SOL and SPL transfers in one transaction retain distinct instruction identities', async () => {
  const fixture = solanaFixture(), original = fixture.fetchImpl;
  fixture.config.tokens.push({ id: 'solana-sol', kind: 'native', decimals: 9 });
  fixture.fetchImpl = async (...args) => {
    const body = await (await original(...args)).json();
    if (body.result?.transactions) body.result.transactions[0].transaction.message.instructions.push({ programId: owner, parsed: { type: 'transfer', info: { source: mint, destination: owner, lamports: 1000000000 } } });
    return response(body);
  };
  assert.deepEqual((await scanChain(fixture)).transactions.map(t => [t.token_id, t.event_index, t.amount_atomic]), [['solana-usdc', 0, '1000001'], ['solana-sol', 1, '1000000000']]);
});

test('Solana opts into mainnet v1 transactions and reads transfers without treating transactionConfig fees as payments', async () => {
  for (const fixture of [solanaNativeFixture(), solanaFixture()]) {
    const original = fixture.fetchImpl;
    fixture.fetchImpl = async (...args) => {
      const request = JSON.parse(args[1].body);
      if (request.method === 'getBlock') assert.equal(request.params[1].maxSupportedTransactionVersion, 1);
      const body = await (await original(...args)).json();
      if (body.result?.transactions) for (const tx of body.result.transactions) {
        tx.version = 1;
        tx.transaction.message.transactionConfig = { computeUnitLimit: 30000, loadedAccountsDataSizeLimit: 200000, heapSize: null, priorityFee: 1000 };
      }
      return response(body);
    };
    const result = await scanChain(fixture);
    assert.equal(result.transactions.length, 1);
    assert.equal(result.transactions[0].amount_atomic, fixture.chain === 'solana' && fixture.config.tokens[0].id === 'solana-sol' ? '9007199254740993' : '1000001');
  }
});

test('Solana known top-level precompiles may omit invoke logs without losing subsequent successful CPI or renumbering it', async () => {
  for (const precompile of ['Ed25519SigVerify111111111111111111111111111', 'KeccakSecp256k11111111111111111111111111111', 'Secp256r1SigVerify1111111111111111111111111', 'UnknownProgram111111111111111111111111111']) {
    for (const options of [{}, { innerFailed: true }, { ancestorFailed: true }, { missingLogs: true }]) {
      const fixture = solanaNativeFixture({ inner: true, ...options }), original = fixture.fetchImpl;
      fixture.fetchImpl = async (...args) => {
        const body = await (await original(...args)).json();
        if (body.result?.transactions) for (const tx of body.result.transactions) {
          tx.transaction.message.instructions.unshift({ programId: precompile, stackHeight: 1, accounts: [], data: '1' });
          tx.meta.innerInstructions[0].index = 1;
        }
        return response(body);
      };
      const result = await scanChain(fixture), expectSuccess = !Object.keys(options).length && !precompile.startsWith('Unknown');
      assert.equal(result.transactions.length, expectSuccess ? 1 : 0);
      if (expectSuccess) assert.equal(result.transactions[0].event_index, 2);
    }
  }
});
