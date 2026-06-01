# 魏夙的 AI 实盘部署记录

## 已购买域名

正式域名：`weisu.pw`

域名注册商：阿里云

DNS 控制台：阿里云云解析 DNS

## 推荐部署

推荐 Render Web Service：

- Runtime: Node
- Build command: 留空
- Start command: `node server.js`
- Health check path: `/api/state`
- Environment:
  - `NODE_ENV=production`
  - `SYMBOL=BTCUSDT`
  - `RMB_PER_USDT=7.2`
  - `MAX_STAKE_USDT=8`

## DNS 记录

当前目标域名：

- 根域名：`weisu.pw`
- www 域名：`www.weisu.pw`

等 Render 生成服务域名后，例如：

`weisu-ai-futures-trader.onrender.com`

在阿里云云解析 DNS 中添加：

| 主机记录 | 类型 | 值 |
| --- | --- | --- |
| `@` | `A` | `216.24.57.1` |
| `www` | `CNAME` | `weisu-ai-futures-trader.onrender.com` |

如果部署平台支持 ALIAS/ANAME/CNAME flattening，也可以把根域 `@` 指向 Render 给出的目标。

Render 官方要求添加自定义域名后回到 Render Dashboard 验证域名；配置 DNS 时删除冲突的 `AAAA` 记录。

## 阿里云填写步骤

1. 打开阿里云控制台，进入 `云解析 DNS`。
2. 找到 `weisu.pw`，点击 `解析设置`。
3. 添加 `@` 的 `A` 记录，记录值填 `216.24.57.1`。
4. 添加 `www` 的 `CNAME` 记录，记录值填 Render 生成的 `*.onrender.com` 域名。
5. 如果已有 `@` 或 `www` 的冲突记录，先暂停或删除冲突记录；尤其注意不要保留冲突的 `AAAA`。
6. 回到 Render 的 Custom Domains 页面，添加并验证 `weisu.pw` 和 `www.weisu.pw`。

## 付款边界

Codex 可以准备代码、部署配置、DNS 记录和操作步骤。域名注册、云平台付费、二维码扫码和银行卡/支付宝/微信付款必须由用户本人完成。
