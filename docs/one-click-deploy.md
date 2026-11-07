# 一键部署 Avenora Pay

如果你是使用某个运营者收款服务的商户，直接访问对方的平台网站并注册即可，无需安装整套程序。本页面向希望在自己账户下运行 Avenora Pay 的站长和运营者。

## 部署到 Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/yelinyuan798-commits/avenora-pay)

按钮会读取仓库的 [render.yaml](../render.yaml)，在**你的 Render 账户**中创建一个常驻服务和 1 GB 持久磁盘。代码免费；计算资源和磁盘由 Render 收费，具体费用以点击后展示的配置和 Render 账单为准。模板使用付费 `0.5c-512mb` 实例；不能删除持久盘或改用会丢失文件的免费实例来保存真实订单。

1. 点击按钮，登录自己的 Render 账户，查看服务与费用后确认部署。已有同名服务时请先核对目标，避免把新部署配置套用到已有实例。
2. 等待构建和健康检查完成。模板自动安装依赖、构建前端、配置生产运行模式，并让数据库保存在持久磁盘中。
3. 打开 Render 分配的 HTTPS 网址，进入 `/merchant/register` 注册自己的商户。没有默认管理员密码。
4. 在商户后台创建项目、填写公开收款地址。继续完成下面的链配置后，才会开放相应支付方式。

服务端加密密钥由 Render 首次生成，入口自动转换格式；服务域名来自 Render 提供的 `RENDER_EXTERNAL_URL`。不需要在部署表单里手写密钥或提前购买域名。入口不会在重启时生成新密钥，也不会把密钥打印到日志。

### 开始真实收款前

一键部署完成的是**网站与后台服务安装**。你仍需提供自己使用的网络、链节点、币种配置和商户公开收款地址；未配置的币种不会接受真实订单。

在 Render 服务的 **Environment → Secret Files** 中添加 `chains.json`，内容参考 [链配置](chains.md)、[报价配置](pricing.md) 和 [平台订阅](billing.md)。然后添加环境变量：

```text
CHAIN_CONFIG_PATH=/etc/secrets/chains.json
```

保存并重新部署。链配置包含节点凭据时只保存在私有配置中，不要提交到仓库。这里需要的是公开收款地址，不需要钱包私钥或助记词。设置了 `CHAIN_CONFIG_PATH` 后，文件缺失或 JSON 无效会阻止启动，避免误用空配置。

配置完成后，用小额真实订单核对到账、确认数和交付。接入 Dujiao-Next 等外部商城时，还要验证 API 签名、付款通知和商城自动发货。仅看到网站上线不代表所有链和外部商城已经验收。

### 域名、升级与备份

- **自己的域名**：先在 Render 绑定并验证 HTTPS 自定义域名，再设置 `PUBLIC_BASE_URL=https://你的域名` 并重新部署；该值优先于默认 Render 网址。付款链接与登录使用同一个正式域名。
- **密钥**：保管 `AVENORA_MASTER_KEY_BASE64` 和数据库备份。它是服务器数据加密密钥，不是钱包私钥；不要重新生成或删除。若从现有安装迁移，显式设置原来的 `MASTER_KEY`，不要给旧数据库换新密钥。
- **持久化**：数据位于 `/var/data`。仅运行一个实例；重新部署会有短暂停机。不要删除磁盘，也不要让多个服务共用一个 SQLite 数据库。
- **升级**：模板关闭跟随本仓库的自动部署，升级前先查看变更并备份，再手动部署选定版本。数据库、原密钥和私有配置需一起保管；一致性备份方法见 [部署指南](deployment.md#数据升级与恢复)。
- **代理与限流**：默认不盲目信任转发头。在正式开放多商户使用前，根据实际代理拓扑核对可信代理和访客限流；设置方法见 [HTTPS、请求来源与代理](deployment.md#https请求来源与代理)。

已有服务器的用户可继续使用 [Docker Compose 或原生 Node.js 部署](deployment.md)，无需购买 Render 服务。

## 模板验证范围

该入口可在本地验证环境参数转换、生产启动、商户注册、数据库重启保留和缺少链配置时不开放实收。模板需按 Render 官方 schema 校验；这些检查不能代替账户内的首次云端构建、磁盘权限与 HTTPS 验收。云端首次部署结果以自己的 Render 控制台为准。

参考：[部署按钮](https://render.com/docs/deploy-to-render)、[Blueprint 配置](https://render.com/docs/blueprint-spec)、[持久磁盘](https://render.com/docs/disks)、[默认域名环境变量](https://render.com/docs/environment-variables)、[私有配置文件](https://render.com/docs/configure-environment-variables#secret-files)。
