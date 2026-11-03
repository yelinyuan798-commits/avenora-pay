# Avenora Pay

**免费开源的多商户非托管加密货币收款平台。** 客户向商户自己的钱包转账，平台读取链上数据、核对订单并触发自动发货或签名通知。

Avenora Pay 独立实现，采用 [MIT 许可证](LICENSE)，允许免费使用、商用、修改和分发，须保留许可证要求的版权与许可声明。内置的商户订阅收费模块是可选业务功能，不是使用本项目代码的授权费用。第三方材料保留各自许可，见 [第三方声明](THIRD_PARTY_NOTICES.md)。

*An open-source, self-hosted, non-custodial crypto payment platform. MIT licensed.*

![Avenora Pay 演示首页：多币收款与商户工作台](docs/images/overview.png)

> 截图中的金额、订单和地址均为合成演示内容。本项目尚未完成独立安全审计或全部主网的真实收款验收；自动测试与模拟发货不能替代实际部署验收。

## 快速体验

需要 **Node.js 24 或以上**及 npm。

```sh
git clone https://github.com/yelinyuan798-commits/avenora-pay.git
cd avenora-pay
npm ci
npm run build
npm run dev
```

打开 <http://127.0.0.1:8787>，点击 **体验商户工作台**。服务会生成独立演示商户、测试地址、商品和订单；没有通用默认管理员账号或密码。创建商品订单后，可在收银台模拟到账并查看库存交付，也可体验订阅账单和套餐开通。

默认本地环境使用 `APP_MODE=demo`，演示报价固定，二维码不能用于付款。`npm run dev` 启动常驻服务并读取已经构建的前端；修改前端后需重新执行 `npm run build`。如果当前终端设置过 `NODE_ENV` 或 `APP_MODE`，请核对后再启动。

本地开发模式保留真实商户注册入口，真实商户仍须配置节点、报价和收款地址才能收款。**需要公开演示站时，应使用 `NODE_ENV=production` 与 `APP_MODE=demo`，并使用独立空数据库。** 配置方法见 [部署指南](docs/deployment.md)。

## 功能

- **多商户与多项目**：订单、收款地址、API 密钥、Webhook、商品和库存相互隔离。
- **收款与交付**：精确金额分配、链上确认、未匹配款复核、事务内一次库存分配、签名通知、重试与死信处理。
- **分享收款**：固定金额或买家自填金额的收款链接；退款模块登记商户申报的外部退款记录，未进行链上核验，也不替商户转币。
- **商户工作台**：收款统计、订单筛选、当前数据 CSV 导出、品牌展示、支持邮箱和手续费设置。
- **接入能力**：服务端 HMAC 签名、时间窗、请求防重放、建单幂等，以及 Node.js [接入工具](scripts/sdk.mjs)。
- **可选平台订阅**：套餐、月订阅账单、付款后开通、同档续费、宽限期、资源与 USD 计价额度，以及管理员审计记录。
- **账户安全**：密码哈希、会话失效、TOTP 两步验证和一次性恢复码；服务端密钥及商品库存加密存储。

平台不收集钱包私钥，不托管商户资产，也不执行提现或退款转账。它依赖所配置节点、行情来源和运行环境的正确性。

## 支持的资产与网络

主流资产包括 **BTC、ETH、BNB、SOL、TRX、USDT、USDC**，部分网络另支持 USDT0。注册表包含 11 条网络，但登记在注册表中不表示已经配置或验证可实收。

| 读取适配器 | 网络 |
| --- | --- |
| Bitcoin | Bitcoin 主网 |
| EVM | Ethereum、BNB Smart Chain、Polygon、Base、Arbitrum、Plasma、X Layer |
| TRON | TRON |
| Solana | Solana |
| Aptos | Aptos |

网络与币种必须同时匹配：例如 Ethereum、Base 和 Arbitrum 上的 ETH 是不同收款方式。同名稳定币也不能代替合约或 mint 身份核对。节点、网络标识、币种与扫描起点必须显式配置，未配置的真实方式不会开放。

金额以整数最小单位计算，付款数量以完整十进制字符串显示。服务端根据报价快照锁定应付金额；缺失或过期的行情会阻止新的真实报价。演示价格始终明确标为固定测试价格。详见 [链配置](docs/chains.md) 与 [报价和锁价](docs/pricing.md)。

## 工作流程

1. 商户在后台或通过签名 API 创建订单。
2. 系统按网络、币种、公开收款地址与报价分配唯一应付金额。
3. 客户按完整金额直接转账至商户地址。
4. 扫描器校验实际链上转账，并等待所需确认。
5. 支付确认后，在数据库事务内分配库存并记录通知事件；商城也可验证 Webhook 后自行履约。

浏览器跳转、客户端提交“已付款”或重复通知都不是付款证明。已过期订单不会因迟扫自动恢复为已支付，符合条件的款项需要显式复核认领。

## 部署

应用需要常驻 Node.js 服务、后台扫描与通知任务、可写的 SQLite 数据库。它不能仅作为静态页面部署，目前按**单实例**设计。

仓库提供 `Dockerfile` 和 `compose.yaml`。当前 Compose 默认是 **live** 模式，并非一键演示配置：

```sh
cp .env.example .env
# 在本机编辑 .env，并准备私有 data/chains.json
# 完整步骤、演示覆盖配置与 HTTPS 反向代理要求见部署指南
docker compose config --quiet
docker compose up -d --build
```

生产启动必须提供有效的 64 位十六进制 `MASTER_KEY` 与 HTTPS `PUBLIC_BASE_URL`。仓库不附带真实节点凭据、商户地址或管理员身份。Docker 对主机只开放回环端口，HTTPS 由反向代理提供；反代信任需要按实际网络配置。

详见 [部署指南](docs/deployment.md)。如需向使用你部署平台的商户收费，再阅读 [平台订阅说明](docs/billing.md)。

## 当前边界

- ETH / BNB 只识别钱包直接转账的顶层交易值；TRX 只识别标准成功 `TransferContract`，不识别合约内部 TRX 转账。
- BTC 不以 mempool 广播时间确认付款；需要在付款窗口内进入区块，随后等待确认。默认 6 次确认，不能保证绝对不会重组。
- Solana 内部指令需要完整且可核对的成功调用日志；不支持 Token-2022。Aptos 支持当前实现的 Fungible Asset primary store 路径。
- 唯一付款金额永久保留，尾数空间有限；需要按业务量配置足够的收款地址。
- 订阅不自动扣款，不做跨档余额折算；没有接入邮件验证、邮件找回、Telegram 或邀请码系统。
- 未完成全网络真实入账、长期负载、完整故障恢复和独立安全审计。

## 文档与检查

- [部署指南](docs/deployment.md)
- [链配置与适配边界](docs/chains.md)
- [价格、精确金额与锁价](docs/pricing.md)
- [平台订阅收费与额度](docs/billing.md)
- [接口约定](docs/contract.md)
- [验证记录](docs/verification.md)
- [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md)

```sh
npm test
npm run build
```

2026-11-03 的开源副本复核：Node.js 24 与 26 下均为 102 项测试通过，生产前端构建通过。测试使用隔离数据库和可控链响应，不发起真实转币。后续版本请以当前命令输出和 CI 结果为准。
