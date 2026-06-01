# weisu.pw 阿里云 DNS 记录

在阿里云 `云解析 DNS` -> `weisu.pw` -> `解析设置` 中添加或确认：

| 主机记录 | 记录类型 | 记录值 | TTL |
| --- | --- | --- | --- |
| `@` | `A` | `216.24.57.1` | 默认 |
| `www` | `CNAME` | `weisu-ai-futures-trader.onrender.com` | 默认 |

注意：

- `www` 的 CNAME 记录值必须换成 Render 实际生成的服务域名，如果服务名不是 `weisu-ai-futures-trader`，不要照抄示例。
- 如果阿里云已有 `@` 或 `www` 的旧记录，先暂停或删除冲突记录。
- 如果有 `AAAA` 记录并且部署平台没有提供 IPv6 地址，先删除，避免域名解析到错误位置。
- DNS 保存后需要回到部署平台验证 `weisu.pw` 和 `www.weisu.pw`。
