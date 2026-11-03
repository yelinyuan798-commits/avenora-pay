# 价格、精确金额与锁价

Avenora Pay 的链上扫描与价格服务是两套独立校验：扫描器证明实际到账的链、资产、地址和数量；价格服务决定创建付款指令时的币数量及计费美元价值。客户端提交的币价、USD值或“已付款”状态均不被使用。

## 官方行情与缓存

服务端固定使用 Coinbase 官方公共HTTPS接口，不接受客户指定行情URL：

- [Spot Price官方说明](https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices)：`https://api.coinbase.com/v2/prices/{ASSET}-USD/spot`，资产固定为BTC、ETH、BNB、SOL、TRX、USDT、USDC。
- [Exchange Rates官方说明](https://docs.cdp.coinbase.com/coinbase-app/track-apis/exchange-rates)：`https://api.coinbase.com/v2/exchange-rates?currency=USD`，读取CNY和EUR换算。接口返回每1 USD对应的法币数值，系统按有理数反向换算，避免方向颠倒。

已核对官方文档，并只读验证以上七种资产及法币接口可返回有效数据。接口当前可用不等于持续可用；生产必须监控过期、连接失败和行情提供方变化。无需提供交易所密钥，不下交易所订单，也不保管钱包私钥。

价格缓存保存在本机SQLite的`market_prices`表。默认每60秒刷新一次，新的live报价最多接受120秒内的价格。网络失败不会更新时间戳或把缺价改成1 USD；过期缓存无法创建或改选新报价。HTTP返回的资产名与USD计价必须正确，数值必须是正的十进制字符串，所有计算使用18位或币种自身精度的整数。

服务端私有配置示例：

```json
{
  "pricing": {
    "enabled": true,
    "stablePolicy": "market",
    "refreshSeconds": 60,
    "maxAgeSeconds": 120,
    "fingerprintMaxUsd": "0.01",
    "refreshInDemo": false
  }
}
```

刷新间隔允许30–120秒，最大陈旧时间允许30–300秒；合理设置应保证刷新间隔小于最大陈旧时间。`APP_MODE=live`默认启动刷新，`APP_MODE=demo`默认不联网抓价。所有demo订单使用明确标记的固定演示价格，避免将测试价格误作实时行情。若在演示服务中确需测试live配置，可显式开启`refreshInDemo`；这不会让demo订单使用实时价格。

`stablePolicy: "parity"`是显式固定平价政策，只对已知USDT、USDC及USDT0按1 USD报价，来源标记`configured_stable_parity`。它不表示稳定币市场价格永远为1美元，也不会为BTC或其他资产补造价格。默认`market`使用真实缓存，包括稳定币。未知token ID一律拒绝。

## 精度和金额分配

| 资产 | token ID | 最小单位精度 |
|---|---|---:|
| BTC | `bitcoin-btc` | 8 |
| ETH | `ethereum-eth`、`base-eth`、`arbitrum-eth` | 18 |
| BNB | `bsc-bnb` | 18 |
| SOL | `solana-sol` | 9 |
| TRX | `tron-trx` | 6 |
| USDT / USDC / USDT0 | 各链固定白名单ID | 按注册表与节点配置核验 |

先计算商品法币金额及已锁定手续费，再用可信法币/USD与币/USD价格换算到该币最小单位，并向上取整。报价不会通过浮点数，也不会把很小的BTC数量截断成0。BTC在添加唯一尾差前，基础数量必须至少546聪；低于该值直接拒绝，不会靠抬高到546聪或添加尾数让客户多付。

每个订单的唯一付款指纹由最小币单位构成，不再假定所有币都支持相同的4位小数尾差。包含基础换算向上取整误差在内的额外USD价值，必须同时不超过0.01 USD和应付USD价值的1%。BTC采用整数聪，ETH/BNB采用整数wei，其他币同理。可用指纹有限；已使用地址/资产/金额永久保留，改选、取消和过期均不回收。某一金额的指纹耗尽后，系统拒绝该报价，并可使用同项目其他启用地址继续分配，防止旧付款误认到新订单。

## 报价快照与支付窗口

每次选择币种会写入不可随行情变化的快照，包含币/USD价、法币/USD换算、报价时间、行情观察时间、来源、手续费、实际应付数量、唯一尾差USD值以及锁定的`usd_atomic`。商户套餐GMV使用该美元快照，不把币数量当作美元，也不在付款时重新估值。

收银台字段包括`token_symbol`、`token_decimals`、精确字符串`payable_amount`，以及`pricing.token_usd_price / fiat_usd_rate / quoted_at / price_observed_at / price_source / is_demo / usd_value / fingerprint_usd / price_valid_until`。`price_valid_until`表示此行情允许创建新报价的缓存截止时间；已经生成的付款指令以订单自己的`expires_at`为准。USDT0显示实际代币名，行情映射可使用USDT。

- 延迟订单在第一次选择支付方式时才启动付款窗口。
- BTC首次付款窗口至少20分钟；其他波动币默认最多10分钟；稳定币沿用默认20分钟。
- 改选不延长原窗口。波动币改选可缩短剩余窗口；剩余不足20分钟时不能改进BTC，应新建BTC订单。
- 同一已选方式再次查询返回原快照；不会因为行情过期而改写已发出的付款指令。
- BTC尚未实现mempool广播时间验收。是否及时付款以进入已验证规范区块的时间为准。广播早于截止、但首次入块晚于截止的款项需要人工复核，不能直接宣称按时到账。
- 首次入块在有效窗口内的订单进入`confirming`，达到所需确认数后才发货；等待确认可以超过付款窗口。重组会撤回未最终确认的匹配。

## 测试与界限

`tests/pricing.test.mjs`覆盖官方响应校验、法币换算方向、缓存失败和过期、BTC dust、全币精度、尾差上限、手续费快照、行情变化后结算、窗口改选、跨币种USD额度、未知历史估值及固定demo价格。`tests/multicoin-flow.test.mjs`检查七种主流资产公开收银台至一次库存交付，以及BTC订阅确认数和重复事件。以上为可控模拟，不代替每条主网、每个实际节点和实际钱包的收款验收。
