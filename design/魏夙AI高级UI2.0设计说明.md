# 魏夙 AI 高级 UI 2.0 设计说明

## 文件

- `design/魏夙AI高级UI2.0-Figma导入稿.svg`
- 当前 Codex 会话没有暴露 `use_figma` / `create_new_file` 可写工具，所以先提供可直接导入 Figma 的 SVG 高保真稿。
- 导入 Figma 后建议拆成组件：顶部状态栏、滚动行情条、资产指标卡、多源行情驾驶舱、TradingView 风格 K 线区、事件票据、手动下单模块。

## 视觉路线

关键词：`Binance Pro K线 + 华尔街交易桌 + 事件合约下注票据 + 情绪雷达`。

- 背景：极深黑灰，不做廉价大渐变。
- 高光：金色为事件合约与赔率感，绿色/红色为多空方向，青色为数据源和主动成交。
- 卡片：8px 圆角、细边框、低透明内发光、扫描线和轻微掠光。
- 字体：密集但可读，标题要有压迫感，指标卡数字大但不遮挡盘面。

## 本次落到网页代码的 UI 模块

### 多源行情驾驶舱

代码位置：

- `public/index.html`：`#marketCommandDeck`
- `public/app.js`：`updateMarketCommandDeck(state)`
- `public/styles.css`：`.market-command-deck`

字段映射：

- `deckOpenInterest`：Binance USD-M `openInterest` + `openInterestHist`
- `deckFunding`：Binance USD-M `premiumIndex`
- `deckLongShort`：Binance Futures `globalLongShortAccountRatio`
- `deckTakerFlow`：Binance Futures `takerlongshortRatio`
- `deckDiscipline`：当前 AI/魏夙模拟票据和执行纪律

显示原则：

- 有真实 Binance 情绪数据就显示真实值。
- 数据断开时显示等待或断开，不生成假值。
- 有持仓时驾驶舱明确显示方向、周期、投入、入场价和预计结算。

## 下一步设计建议

1. 把 `情绪云图` 做成更像雷达：中间是“当前 10m/15m 胜率估算”，周围环绕 OI、资金费率、主动买卖、盘口厚度。
2. 把 `策略实验室` 做成排行榜：策略名、模拟次数、实操次数、胜率、最近 10 笔、是否启用。
3. 把 `魏夙手动画像` 独立成侧边抽屉：偏好多空、平均投入、失误类型、最近改进建议。
4. K 线标记继续减少遮挡：默认缩小，鼠标悬停展开，点击固定展开。
5. 最终产品感可以形成三层：看盘层、下单层、复盘层，避免所有信息同时挤到图上。
