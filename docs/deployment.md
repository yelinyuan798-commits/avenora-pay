# 部署指南

Avenora Pay 是一个带后台扫描和通知任务的常驻 Node.js 服务，使用 SQLite 持久化数据。目前按单实例设计，不要让多个进程或容器同时操作同一数据库并执行后台任务。纯静态托管和请求结束即销毁的函数环境不适用。

本文使用保留示例域名 `payments.example.com`。请替换为自己控制的域名，不要照抄为可用服务地址。

## 选择运行模式

| 用途 | 参数 | 行为 |
| --- | --- | --- |
| 本地开发体验 | `npm run dev`，未设置 `NODE_ENV` / `APP_MODE` | 默认 demo 入口，保留本地真实商户注册能力 |
| 公网演示 | `NODE_ENV=production`、`APP_MODE=demo` | 仅允许演示商户，禁止真实注册、真实登录与真实收款入口，附加演示资源上限 |
| 自托管真实业务 | `NODE_ENV=production`、`APP_MODE=live` | 关闭演示入口；实际收款需完成节点、报价、商户地址与业务接入配置 |

`demo` 不是把现有真实数据库转换成测试数据的开关。公开演示应使用独立空数据目录或独立卷，链配置为 `{}`，不装入真实节点凭据、库存或商户信息。演示与 live 实例应使用不同数据库、主密钥和域名。

## 环境参数

参数由进程环境读取。**`npm run dev`、`npm start` 不自动加载 `.env`**；Docker Compose 会读取项目的 `.env`，原生 Node.js 可使用 `node --env-file=.env server/index.mjs`。

| 参数 | 默认值 / 要求 |
| --- | --- |
| `NODE_ENV` | 非 `production` 时采用开发默认值；`npm start` 会设置为 `production` |
| `APP_MODE` | 未指定时：production 为 `live`，其他为 `demo`；仅接受这两个值 |
| `HOST` | 原生启动默认 `127.0.0.1`；镜像内默认 `0.0.0.0` |
| `PORT` | `8787` |
| `DATA_DIR` | `data`，相对进程工作目录；保存 `payment.sqlite` 及 SQLite 辅助文件 |
| `MASTER_KEY` | production 必填，64 位十六进制字符，即 32 字节；开发模式未提供时在数据目录生成 `master.key` |
| `PUBLIC_BASE_URL` | production 必填 HTTPS 站点 origin；如 `https://payments.example.com`，不可包含凭据、路径、查询参数或片段 |
| `CHAIN_CONFIG_PATH` | 可选的私有 JSON 配置文件路径；未设置时不会自动启用真实链节点 |
| `TRUST_PROXY` | 未设置时不信任转发头；同机原生反代可设 `loopback`，其他拓扑应填写实际可信代理 IP 或网段；不接受 `true` |

`MASTER_KEY` 用于服务端凭据和库存加密，不是区块链钱包私钥。不要在升级或重启时重新生成；丢失它会使原有加密内容无法恢复。

### 首次准备主密钥

先复制模板并编辑自己的 HTTPS 域名：

```sh
cp .env.example .env
```

仅在首次安装且 `.env` 中 `MASTER_KEY=` 仍为空时，使用下面的命令生成密钥并写入本地文件，不把密钥打印到终端：

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const filename = '.env';
const source = readFileSync(filename, 'utf8');
if (!/^MASTER_KEY=$/m.test(source)) {
  throw new Error('MASTER_KEY is not empty; keep the existing key.');
}
writeFileSync(filename, source.replace(/^MASTER_KEY=$/m,
  'MASTER_KEY=' + randomBytes(32).toString('hex')));
chmodSync(filename, 0o600);
JS
```

`.env`、数据目录、节点配置与备份都应保持私有。不要把它们提交到 GitHub，或作为问题附件上传。

## 原生 Node.js 部署

需要 Node.js 24 或以上。进入代码目录后：

```sh
npm ci
npm test
npm run build
```

### 公网演示

先准备一个空配置文件：

```sh
mkdir -p data
printf '{}\n' > data/demo-chains.json
```

使用独立演示数据库和已准备的 `.env` 启动：

```sh
NODE_ENV=production APP_MODE=demo \
DATA_DIR=./data/public-demo CHAIN_CONFIG_PATH=./data/demo-chains.json \
HOST=127.0.0.1 PORT=8787 TRUST_PROXY=loopback \
node --env-file=.env server/index.mjs
```

前提是 HTTPS 反向代理与 Node.js 在同一主机，通过回环接口访问服务。其他网络拓扑应调整 `TRUST_PROXY`，不要直接信任全部转发来源。生产服务应交由操作系统的进程管理器常驻运行，配置工作目录、环境文件、日志和退出重启策略。

打开自己的 HTTPS 域名，点击“体验商户工作台”。首次生成独立空间；同一有效演示会话再次点击会复用当前空间。收银台使用非付款二维码和固定演示价格，模拟到账只操作当前商户的演示订单，演示 Webhook 不向外部接收端发送请求。

公开演示的固定边界仅在 `production + demo` 下启用：

- 全站最多 100 个演示空间；每个来源 IP 每 10 分钟最多新建 6 个。
- 每空间：项目 10、地址 50、订单 100、商品 50、库存合计 1000、收款链接 50、API 密钥 20、Webhook 端点 20。
- 每 IP 每分钟：认证写请求 40 次、其他写请求 120 次、其他请求 600 次。
- 演示创建与资源限制由服务端执行；正常的建单幂等重试不再次消耗订单数量。

这些演示上限与真实套餐额度分开。没有自动删除演示空间的策略；达到全站上限后，应按自己的保留策略归档并轮换为新的演示数据目录，不能把真实业务数据混入演示目录。

### 真实业务实例

准备私有 `data/chains.json`，参照 [链配置](chains.md) 核对网络、资产身份和扫描起点。再按 [价格配置](pricing.md) 设置报价策略：

```sh
NODE_ENV=production APP_MODE=live \
DATA_DIR=./data/live CHAIN_CONFIG_PATH=./data/chains.json \
HOST=127.0.0.1 PORT=8787 TRUST_PROXY=loopback \
node --env-file=.env server/index.mjs
```

不要与演示实例同时占用同一端口。若需并行运行，应分别配置端口、域名、环境文件和数据目录。

在本站注册自己的商户、建立项目、填写公开收款地址，再配置 API Key 和 Webhook。系统没有默认管理员密码；平台管理员由私有服务端配置中的商户 ID 指定。需要向其他商户收取平台订阅费时，另按 [平台收费说明](billing.md) 设置运营者收款项目。缺少必要配置时，真实收款或订阅收费会拒绝建单。

## Docker Compose

仓库当前的 `compose.yaml` 固定设置 `APP_MODE: live`，镜像默认也是 live。仅在 `.env` 增加 `APP_MODE=demo` **不会覆盖**这个写死的 Compose 配置。

### 真实业务配置

先准备 `.env` 和私有 `data/chains.json`。确认文件对镜像运行用户可读、对无关用户不可读；镜像以 `node` 用户运行，不能假定任意宿主机文件权限都可直接读取。

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Compose 把主机 `127.0.0.1:8787` 转发到容器端口，并使用 `payment-data` 命名卷保存数据库，同时把 `./data/chains.json` 只读挂载到容器。首次部署前应确认这个卷没有其他环境的旧数据。Compose 的 `.env` 只负责变量替换，不会把所有变量自动传入容器。

### 演示覆盖配置

为演示准备 `data/demo-chains.json`，内容为 `{}`。在本机创建以下 `compose.demo.yaml`，无需提交自己的部署覆盖文件：

```yaml
services:
  payments:
    environment:
      APP_MODE: demo
      TRUST_PROXY: ${TRUST_PROXY:-}
    volumes:
      - demo-data:/app/data
      - ./data/demo-chains.json:/app/data/chains.json:ro
volumes:
  demo-data:
```

同一挂载目标会覆盖基础 Compose 的数据源，因此演示使用独立的 `demo-data` 卷和空链配置。给这个实例单独准备 `.env` 的域名与主密钥，然后执行：

```sh
docker compose -p avenora-demo -f compose.yaml -f compose.demo.yaml config --quiet
docker compose -p avenora-demo -f compose.yaml -f compose.demo.yaml up -d --build
```

如需向 live 容器传入 `TRUST_PROXY`，同样在本机 Compose 覆盖配置的 `payments.environment` 中显式加入该变量。

**容器内的代理来源不一定是回环地址。** 即使 Nginx 在宿主机访问 `127.0.0.1:8787`，应用看到的 TCP 对端也可能是 Docker 网桥网关。应核对实际拓扑，只信任对应代理地址或固定网段，不能照搬原生部署的 `loopback`，也不要改成无条件信任。代理不受信任时，所有经过该代理的访客可能共用同一个限流额度。

两个 Compose 实例也不能同时绑定同一主机端口；并行部署时需另设端口及反向代理。`docker compose down` 默认保留命名卷，不要把删除卷作为常规升级步骤。

## HTTPS、请求来源与代理

- `PUBLIC_BASE_URL` 必须与浏览器实际访问的 HTTPS origin 一致。域名改变后应同步环境参数并重启；已发给客户的旧链接还需保持可达。
- 反向代理必须正确设置 `Host`、`X-Forwarded-Proto` 和 `X-Forwarded-For`，避免直接采用不可信客户端伪造的身份。
- Node.js 监听端口只应对本机反代或受控内部网络开放。
- production 登录 cookie 使用 `Secure`、`HttpOnly` 和 `SameSite=Strict`。不能通过临时 HTTP 公网地址验证其浏览器登录行为。
- 应用按可信 `PUBLIC_BASE_URL` 校验浏览器写请求来源，不通过任意 `X-Forwarded-Host` 决定可信域名。
- CSP 默认限制脚本和连接为同源，允许本地图片与二维码的 `data:` 图片。自行添加外部资源前应评估并更新策略，不要简单移除 CSP。

证书申请、域名解析和代理配置依赖具体部署环境；仓库不会自动申请证书。可以从本机访问 `http://127.0.0.1:8787/api/auth/me` 检查服务是否响应，再通过实际 HTTPS 域名检查完整演示登录和付款模拟路径。

## 数据、升级与恢复

数据库、SQLite 的 WAL 辅助文件、主密钥和私有配置构成一个可恢复整体。备份应使用受支持的一致性方式；最简单的方式是先停止单实例服务，再保存数据目录或卷、原 `MASTER_KEY`、链配置与环境参数。备份本身包含敏感内容，应加密保存并限制访问。

升级前保留可恢复备份，检查变更说明，运行测试并构建。确认一次只启动一个后台任务实例。恢复后核对商户、订单、库存、扫描游标和未完成通知；不要在恢复时生成新主密钥，也不要任意删除游标来“修复”漏单。

实际收款前，至少在自己的环境验证：

1. 所选链的实际节点能读取正确网络、币种与所需历史区间。
2. 真实订单金额、手续费、锁价和确认数与链上回执一致。
3. 外部 Webhook 可验签、可重试，并且业务方按事件或订单做幂等处理。
4. 节点中断、服务重启、库存不足、迟到付款和未匹配转账有可执行的处置路径。
5. 备份能够在隔离环境恢复，扫描和通知可以从保存状态继续。

自动测试与演示站成功只覆盖程序和模拟路径。已实现功能及未验证范围见 [验证记录](verification.md)；发现安全问题请按 [安全报告流程](../SECURITY.md) 私密联系维护者。


## 升级钱包订单标识版本

此版本为订单与报价表迁移唯一约束，并新增不可变付款模式与订单引用。升级前先做SQLite一致性备份（使用SQLite backup API或停服后复制完整数据库），同时保管原MASTER_KEY和私有配置；直接复制活动中的主文件可能遗漏WAL。首次启动在事务中迁移，历史订单默认保持amount模式，不改变旧付款来源与交付。升级后核对历史订单、数据库完整性与扫描游标，再为项目启用新模式。

不要在已产生新付款后直接恢复旧数据库副本，否则会丢失新的交易和履约记录。回退需要保留升级后的数据库及新增记录，不能仅切换到不支持新结构的旧代码。新钱包模式与自动恢复选项见[钱包支付说明](wallet-payments.md)。

## 启用普通转账的冲突金额分配

先使用数据库副本验证升级迁移与重复启动：旧订单、交易、库存、通知和报价的原有字段必须保留。此版本为订单与报价增加分配策略，并为报价保存付款截止时间；旧数据归为 `legacy`，保留旧金额占用规则。

部署新代码后，在私有链配置中启用[冲突金额配置](pricing.md#仅在冲突时增加金额)，项目选择 `amount` 模式；示例步长 `0.0000001` 当前针对 BSC USDT。关闭旧省尾数选项以保持页面完整到账提示。配置切换只用于新报价，不修改已经发出的付款金额。记录原配置和发布目录，保留原主密钥及扫描游标。

上线验证至少包括三个同地址同价订单显示 `1.0 / 1.0000001 / 1.0000002`，新页面没有钱包连接按钮和省尾数提示，乱序模拟到账分别发货、重复通知不再扣库存，以及迁移后原已付款订单仍能查看原交付。真实链上验收需由付款人使用支持完整小数的付款软件确认转账；模拟验证不能代替这一步。
