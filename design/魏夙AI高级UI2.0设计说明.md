# 魏夙AI高级UI2.0设计说明

## 本次重启方向

这版只服务事件合约模拟盘：买涨、买跌、胜率、到期、投入、结算、复盘。页面不再做偏题终端，也不展示和“拥有币”有关的内容。

核心视觉关键词：

- Binance Pro K线质感
- 事件合约票据台
- LIVE / WAIT / READY 的刺激反馈
- 金边发光、红绿方向、灰底无信号
- AI票据和魏夙手动票据分离
- 下注前看胜率，下注后看倒计时和结算

## 第一屏结构

1. 顶部品牌区：魏夙的 AI 实盘，副标题标明 Binance BTCUSDT 永续K线、事件合约模拟账户。
2. 事件合约票据台：只显示当前胜率、买涨胜率、买跌胜率、模拟回报、到期窗口。
3. K线区：继续保留 TradingView 风格主图和全览条，票据标记必须写明方向、金额、周期。
4. 右侧票据区：买涨 / 买跌两张票，当前哪边占优就发光，AI和手动互不抢单。
5. 下方脉冲板：把K线信号翻译成事件合约语言，回答“这一张票值不值得买”。
6. 订单与复盘：AI复盘和魏夙手动复盘分开，每笔都有序号、周期、方向、投入、入场、结算、总结。

## 视觉规则

- 绿色只代表买涨优势，红色只代表买跌优势，金色代表等待确认或高价值提示。
- 所有卡片保持 8px 圆角，像专业交易终端，不做营销页。
- 闪光效果用于票据、边框和关键数值，不遮挡K线。
- 图表上方只放紧凑控件，避免挡住盘面。
- 信息密度要高，但每个模块只回答一个问题。

## 当前代码落点

- `public/index.html`：`#eventContractDesk`、`#eventPulseBoard`
- `public/app.js`：`updateEventContractDesk(state)`、`updateEventPulseBoard(state)`
- `public/styles.css`：`.event-contract-desk`、`.event-pulse-board`
- `server.js`：`eventPulseBoard: buildEventPulseBoard()`

## Figma落地说明

当前会话没有暴露可写入 Figma 的工具，所以本次同步维护可导入的 SVG 样板：`design/魏夙AI高级UI2.0-Figma导入稿.svg`。等 Figma 工具可用后，可以直接把这份结构迁移成 Figma 画板和组件库。
