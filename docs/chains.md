# 链上扫描配置与验收边界

扫描器只读公开链数据，不签名、不转币、不接受浏览器提交的“到账证明”。`CHAIN_CONFIG_PATH` 指向本机私有 JSON 文件，最外层按链 ID 分组。未配置节点、网络标识或代币身份的链不会开放真实收款。RPC URL 可能包含服务商密钥，文件应放在 `data/` 并限制权限，不要发到聊天、日志或版本库。

## 配置结构

```json
{
  "ethereum": {
    "enabled": true,
    "rpcUrl": "https://YOUR_ETHEREUM_RPC_ENDPOINT",
    "chainId": 1,
    "startBlock": 0,
    "batchSize": 100,
    "tokens": [
      {"id": "ethereum-usdt", "contract": "0xdac17f958d2ee523a2206206994597c13d831ec7", "decimals": 6}
    ]
  }
}
```

上例的 `startBlock: 0` 仅用于说明字段；正式部署应填启用收款之前的区块高度，避免从创世块全量扫描。应用对每条真实链都要求显式 `startBlock`，Bitcoin 适配器本身也拒绝缺少该字段的配置。切换地址、代币或节点时需要规划回溯起点。不要在运行中跳过尚未扫描的区块。节点归档数据被裁剪或限流时会报错，游标应保持不动。

| 链 | family | 网络标识 | 代币标识配置 |
| --- | --- | --- | --- |
| bitcoin | bitcoin | `network:"main"`，`expectedGenesisHash` 必须为下方主网固定值 | `tokens:[{id:"bitcoin-btc",kind:"native",decimals:8}]` |
| ethereum / bsc / polygon / base / arbitrum / plasma / x-layer | evm | `chainId` 分别 1 / 56 / 137 / 8453 / 42161 / 9745 / 196 | `tokens:[{id,contract,decimals}]` |
| tron | tron | `expectedGenesisHash` 必填，必须与独立核对的主网创世块一致 | `contract` 使用 TRON Base58Check 地址，USDT 精度 6 |
| solana | solana | `expectedGenesisHash` 必填，必须与独立核对的主网 genesis hash 一致 | `mint` 使用 SPL mint 地址，精度 6 |
| aptos | aptos | `chainId:1`，`rpcUrl` 包含 `/v1` | `metadata` 为 Fungible Asset metadata 对象地址，精度 6 |

`headers` 可配置服务商需要的请求头，`timeoutMs` 默认 15000，`batchSize` 默认 Bitcoin 10 / EVM 100 / TRON 20 / Solana 20 / Aptos 100，最大 500。HTTP 仅允许本机节点，其他节点必须 HTTPS。节点响应不能将错误正文、URL或认证头写入对外接口。

配置中的代币合约需要从发行方及链上数据独立核对；同名 USDT / USDC 不代表同一资产。BSC 常用 USDT 和 USDC 为 18 位精度；其他内置稳定币为 6 位。配置精度必须与注册表和节点查询结果同时一致。BSC 的 Binance-Peg 资产不能描述为 Tether 或 Circle 在该链原生发行的资产。程序没有内置自动发现合约、交易所充值地址或真实钱包。

### 原生币配置

原生币配置必须显式写 `kind:"native"`，不写 `contract`、`mint` 或 `metadata`。这与同名包装代币不同，例如 ERC-20 WETH 不会当作原生 ETH。原有稳定币配置继续保留，可与原生币同时启用。注册表的 `priceAsset` 是报价资产标识，不能被节点配置覆写；原生币需要后台取得有效价格并锁定报价，不按 1 美元计价。

| token id | 链 | 最小单位精度 | priceAsset |
| --- | --- | --- | --- |
| bitcoin-btc | bitcoin | 8 | BTC |
| ethereum-eth | ethereum | 18 | ETH |
| base-eth | base | 18 | ETH |
| arbitrum-eth | arbitrum | 18 | ETH |
| bsc-bnb | bsc | 18 | BNB |
| solana-sol | solana | 9 | SOL |
| tron-trx | tron | 6 | TRX |

Bitcoin 示例仅包含占位符，不附带真实钱包或凭据。`startBlock` 应换成经过核对的启用前高度。Bitcoin Core 30 风格 RPC 返回完整交易与 `scriptPubKey.address`；只读使用 `getblockchaininfo`、`getblockhash`、`getblock`，不加载钱包、不调用签名或发送接口。节点须完成首次同步；裁剪节点须保留所有待扫高度的数据。

```json
{
  "bitcoin": {
    "enabled": true,
    "rpcUrl": "http://127.0.0.1:8332",
    "network": "main",
    "expectedGenesisHash": "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
    "startBlock": 0,
    "batchSize": 10,
    "headers": {"Authorization": "Basic REPLACE_LOCALLY_WITH_RPC_AUTH"},
    "tokens": [{"id": "bitcoin-btc", "kind": "native", "decimals": 8}]
  },
  "ethereum": {
    "enabled": true,
    "rpcUrl": "https://YOUR_ETHEREUM_RPC_ENDPOINT",
    "chainId": 1,
    "startBlock": 0,
    "tokens": [{"id": "ethereum-eth", "kind": "native", "decimals": 18}]
  }
}
```

Base / Arbitrum / BSC 使用相同 EVM 结构及对应 `chainId`。Solana / TRON 保留其节点和主网 `expectedGenesisHash` 配置，在 `tokens` 加入对应原生币条目即可。所有链默认关闭；配置缺失不会回退到任意公开节点。

## 已实现的读取方式

- Bitcoin：核对主网链名和固定创世 hash，按规范链高度读取完整区块，检查块 hash、高度、前后连续性，并在结束时重查末块。只处理普通交易的收款输出；排除 coinbase，不识别 mempool 未上链交易。输出地址须通过主网 Base58Check 或 Bech32 / Bech32m 校验，并与 `scriptPubKey.hex` 一致。一个输出一个事件，不合并不同输出或交易；不推测多输入交易的付款人地址。默认 6 个确认，属于概率确认，不代表绝对不可重组。
- EVM：`eth_chainId` 核验网络，读取连续规范区块、ERC-20 `Transfer` 日志、成功交易回执，并核对回执内同一事件及区块 hash；查询 `decimals()` 验证精度。原生 ETH / BNB 只识别完整区块交易中的顶层 `to` / `value`，交易回执必须成功并对应同一交易、块及位置；不追踪内部合约转账、桥接提取、奖励或余额变化。确认阈值沿用参考平台：Ethereum 20、BSC 15、Polygon 128、Base / Arbitrum / Plasma / X Layer 20。
- TRON：仅扫描 SolidityNode 已 solidified 区块，核对交易执行结果、回执、精确 TRC-20 合约和事件；使用 Base58Check 校验地址，并读 `decimals()`。原生 TRX 只识别成功的标准 `TransferContract`，不识别智能合约内部 TRX 转账。回执 API 没有提供块 hash，故以规范块中的交易成员关系、回执交易 ID / 高度及末块复核绑定。最终状态的确认显示至少 19。
- Solana：仅扫描 `finalized` slots，跳过真正未产块的 slot；识别标准 SPL Token Program 的 `transfer` / `transferChecked`，以 token balance 元数据验证收款账户 owner、mint、精度。原生 SOL 只识别 System Program 的 `transfer` / `transferWithSeed`。不把租金、费用、奖励、账户创建或余额差当作付款。`finalized` 表示共识确认，界面映射为至少 32。Token-2022、转账手续费扩展、自定义转账方式不在当前支持范围。
- Aptos：按 ledger version 连续读取 committed transactions；只处理成功交易中的官方 `0x1::fungible_asset::Deposit`，按官方派生规则定位付款地址的 primary store，在该交易 version 验证 FA metadata 和 ObjectCore owner。支持现行 FA 标准稳定币；旧 CoinStore、secondary store 和嵌套对象收款不在当前支持范围。

Solana 的成功交易仍可能捕获失败的内部调用。因此内部 SOL / SPL 指令只有在调用日志与完整指令序列对应、该指令及全部祖先明确成功时才入账。日志截断、缺失、无法对应或祖先回滚时跳过该内部指令；块仍可扫描完成并前移游标，这类付款不会因普通后续轮询自动补认，需要人工只读核验并安排受控回扫。不能把当前支持描述为“任意智能合约转账均可到账”。

已知顶层 Ed25519 / Secp256k1 / Secp256r1 签名预编译不产生普通 invoke 日志，因此仅在日志对齐时排除它们，事件指令位置仍保留；未知程序缺日志不会获得此例外。失败内部调用及失败祖先仍不会入账。

Solana `getBlock` 显式设置 `maxSupportedTransactionVersion:1`，兼容 legacy / v0 / v1。v1 的 `transactionConfig` 只影响执行资源与费用，不作为付款金额来源。根据 2026 年 9 月官方升级说明，RPC 应使用支持正确 v1 存储/返回的 Agave 4.2.2 或之后版本；不支持 v1 的旧读取参数会在遇到 v1 区块时停止扫描。

RPC 金额从原始 JSON 数字文本读取，再用 `BigInt` 转换。Bitcoin 的 BTC 小数与科学记数法精确转换为 satoshi，超出 8 位的非零尾数被拒绝；SOL lamports 和 TRX sun 保留整数精度。不先经过浮点乘法再取整。运行时要求 Node.js 24 或以上的 JSON parse source 支持。

## 与后台的约定

`scanChain` 返回 `transactions`、最后完整扫描到的 `cursor`、`head`、`blocks` 和 `range`。金额是最小单位十进制字符串；`block_time` 是 ISO UTC；事件唯一键是链＋交易 hash＋事件位置。Bitcoin / EVM 的 `blocks` 包含空区块，后台应据此识别旧的未确认事件所在区块是否已换 hash，清除匹配并回退订单。扫描失败整体抛错，不能推进游标。后台应重复扫描未确认区间、持久化游标及事件，并在数据库中独立实施去重和精确金额/地址/时间窗匹配。

`event_index` 是有符号整数：Bitcoin 使用 `vout.n`，EVM 原生币为 `-1`、代币为非负 `logIndex`；TRON 原生币为 `-(contractIndex+1)`、代币为非负日志位置；Solana 使用包含内部指令的展开顺序位置。添加原生币不会与同一交易的已有代币事件冲突。Bitcoin 的 `from_address` 为空字符串，并额外返回 `output_index`。

Solana 的 cursor 是 slot；Aptos 的 cursor 是 ledger version，不能当成其他链的块高解释。TRON / Solana / Aptos 只读取已最终确认的数据，因此通常直接从待支付变为已支付，不展示逐块累积的中间过程。

## 验证范围

`tests/chains.test.mjs` 使用固定 RPC / REST 响应验证五族解析、Bitcoin 地址官方向量与 UTXO、失败交易/内部调用拒绝、假代币拒绝、精度拒绝、原始 JSON 大整数、网络隔离、分叉中止和节点失败。尚未用真实商户钱包跑过十一链入账验收，不能把这些单元测试视为生产收款认证。启用某条链之前还需要真实只读对账、节点容量/补扫测试、订单金额窗口与重复事件全链路验收。深度重组超过所选确认阈值时仍需运营对账，不保证绝对不可逆。

## 官方依据

- [Bitcoin Core getblock](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/getblock/)、[getblockchaininfo](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/getblockchaininfo/)、[主网参数](https://github.com/bitcoin/bitcoin/blob/master/src/kernel/chainparams.cpp)：完整交易、规范链高度、初始同步状态和固定创世 hash。
- [BIP-173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki)、[BIP-350](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki)：主网 witness 地址、版本与 checksum 对应规则及测试向量。
- [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/)：区块、日志、交易回执和 `eth_call`。
- [TRON API Reference](https://developers.tron.network/docs/api)、[TRON Blocks](https://developers.tron.network/docs/block)：SolidityNode solidified 数据与回执区分。
- [TRON TransferContract](https://developers.tron.network/reference/buildtransaction)：原生 TRX 转账字段。
- [Solana getBlock](https://solana.com/docs/rpc/http/getblock)、[getBlocks](https://solana.com/docs/rpc/http/getblocks)、[JSON Structures](https://solana.com/docs/rpc/json-structures)：finalized 区块、指令与 token balance 元数据。
- [Agave System Program 解析](https://github.com/anza-xyz/agave/blob/master/transaction-status/src/parse_system.rs)：原生 SOL 指令类型与 lamports 字段。
- [Solana Precompiled Programs](https://solana.com/docs/core/programs/precompiles)、[Agave InvokeContext](https://github.com/anza-xyz/agave/blob/master/program-runtime/src/invoke_context.rs)：签名预编译身份、不可 CPI 与独立执行路径。
- [Solana Larger Transaction Sizes 升级说明](https://solana.com/upgrades/larger-transaction-sizes)：2026 年 9 月主网 v1 激活、RPC 版本参数与节点兼容要求。
- [Aptos Get transactions](https://aptos.dev/rest-api/operations/get_transactions)、[Get account resource](https://aptos.dev/rest-api/operations/get_account_resource)：已提交交易和指定 ledger version 的资源。
- [Aptos fungible_asset](https://github.com/aptos-labs/aptos-core/blob/main/aptos-move/framework/aptos-framework/sources/fungible_asset.move)、[primary_fungible_store](https://github.com/aptos-labs/aptos-core/blob/main/aptos-move/framework/aptos-framework/sources/primary_fungible_store.move)、[object](https://github.com/aptos-labs/aptos-core/blob/main/aptos-move/framework/aptos-framework/sources/object.move)：Deposit 事件、metadata、primary store 派生和 owner。
- [Tether Supported Protocols](https://tether.to/en/supported-protocols/)：示例 Ethereum USDT 和 TRON USDT 合约来源。

### Application scanner requirements

The application requires an explicit non-negative integer `startBlock` for every live chain, in addition to a valid node and token configuration. This avoids silently starting at the latest head and missing a payment made just before the first polling cycle. For Aptos this value is a ledger version, and for Solana it is a slot. Set it to a recent verified position at or before enabling the receiving address. Saved forward cursors take over after a successful scan.

The application persists an independent bounded Bitcoin/EVM reorg sweep cursor in addition to its forward cursor. Recent blocks are rescanned even if they originally contained no matching transfer, while unsettled and inventory-review transfers are checked separately. Live orders expire automatically only after a healthy scanner has verified sufficiently confirmed block timestamps beyond the order deadline. This deliberately delays expiry during node outages or scan backlog.


### 可选钱包订单标识

仅显式设置`tokens[].paymentReference:true`的EVM代币会读取原交易输入并验证Avenora订单标识。必须是成功的直接代币transfer，交易的to/from/value、收款人、原子金额、回执、区块及日志均须对应；缺少原交易数据会使该批扫描失败，不能先推进游标。普通无标识转账仍供旧amount订单识别；reference订单必须带正确标识。

目前实际只读兼容性验证覆盖BSC USDT，不能推断所有ERC-20或智能合约钱包兼容。配置例子、附加数据格式及实际钱包验收要求见[钱包支付说明](wallet-payments.md)。
