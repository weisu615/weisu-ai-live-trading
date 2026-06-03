const els = {
  modePill: document.getElementById("modePill"),
  tickerTape: document.getElementById("tickerTape"),
  toggleBot: document.getElementById("toggleBot"),
  advanceBot: document.getElementById("advanceBot"),
  resetBot: document.getElementById("resetBot"),
  resetConfirm: document.getElementById("resetConfirm"),
  cancelReset: document.getElementById("cancelReset"),
  confirmReset: document.getElementById("confirmReset"),
  balanceRmb: document.getElementById("balanceRmb"),
  balanceUsdt: document.getElementById("balanceUsdt"),
  pnlRmb: document.getElementById("pnlRmb"),
  pnlUsdt: document.getElementById("pnlUsdt"),
  winRate: document.getElementById("winRate"),
  tradeCount: document.getElementById("tradeCount"),
  countdown: document.getElementById("countdown"),
  botStatus: document.getElementById("botStatus"),
  currentPrice: document.getElementById("currentPrice"),
  priceChange: document.getElementById("priceChange"),
  dataSource: document.getElementById("dataSource"),
  klineRangeLabel: document.getElementById("klineRangeLabel"),
  flareEvent: document.getElementById("flareEvent"),
  flareOdds: document.getElementById("flareOdds"),
  flareFlow: document.getElementById("flareFlow"),
  flareEdge: document.getElementById("flareEdge"),
  eventWindow: document.getElementById("eventWindow"),
  eventOdds: document.getElementById("eventOdds"),
  callTicket: document.getElementById("callTicket"),
  putTicket: document.getElementById("putTicket"),
  callTicketState: document.getElementById("callTicketState"),
  putTicketState: document.getElementById("putTicketState"),
  eventHeat: document.getElementById("eventHeat"),
  eventTempo: document.getElementById("eventTempo"),
  eventRule: document.getElementById("eventRule"),
  callEdgeBar: document.getElementById("callEdgeBar"),
  putEdgeBar: document.getElementById("putEdgeBar"),
  eventSide: document.getElementById("eventSide"),
  eventStake: document.getElementById("eventStake"),
  eventEdge: document.getElementById("eventEdge"),
  eventSettle: document.getElementById("eventSettle"),
  manualStake: document.getElementById("manualStake"),
  manualDuration: document.getElementById("manualDuration"),
  manualStatus: document.getElementById("manualStatus"),
  manualButtons: document.querySelectorAll("[data-manual-direction]"),
  userHabitWinRate: document.getElementById("userHabitWinRate"),
  userHabitSamples: document.getElementById("userHabitSamples"),
  userHabitBias: document.getElementById("userHabitBias"),
  positionTitle: document.getElementById("positionTitle"),
  positionDirection: document.getElementById("positionDirection"),
  entryPrice: document.getElementById("entryPrice"),
  stake: document.getElementById("stake"),
  confidence: document.getElementById("confidence"),
  aiNote: document.getElementById("aiNote"),
  exposure: document.getElementById("exposure"),
  drawdown: document.getElementById("drawdown"),
  streak: document.getElementById("streak"),
  statusDot: document.getElementById("statusDot"),
  tradeRows: document.getElementById("tradeRows"),
  canvas: document.getElementById("klineCanvas"),
  overviewCanvas: document.getElementById("overviewCanvas"),
  timeframeTabs: document.getElementById("timeframeTabs"),
  toggleOverview: document.getElementById("toggleOverview"),
  zoomIn: document.getElementById("zoomIn"),
  zoomOut: document.getElementById("zoomOut"),
  panLeft: document.getElementById("panLeft"),
  panRight: document.getElementById("panRight"),
  rangeSlider: document.getElementById("rangeSlider"),
};

let latestState = null;
let countdownTimer = null;
let selectedTimeframe = "10m";
let chartView = "focus";
let visibleCandles = 64;
let viewEndRatio = 1;
let chartHover = { x: null, y: null };
let restoreAttempted = false;
let statePollTimer = null;
let autoAdvanceTimer = null;
let autoAdvanceInFlight = false;
let chartCandlesByTimeframe = new Map();
let chartLoadingTimeframe = null;

const CLIENT_BACKUP_KEY = "weisu-ai-live-trading:snapshot:v1";
const STATE_POLL_MS = 10 * 1000;
const AUTO_ADVANCE_MS = 30 * 1000;
const CLIENT_BACKUP_TRADE_LIMIT = 100;

const TIMEFRAMES = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "10m": 10 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

const SERVER_KLINE_TIMEFRAMES = new Set(["5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"]);
const LONG_HISTORY_TIMEFRAMES = new Set(["1d", "1w", "1M"]);

function fmtUsdt(value, digits = 2) {
  return `${Number(value || 0).toFixed(digits)} USDT`;
}

function fmtRmb(value, digits = 2) {
  return `¥${Number(value || 0).toFixed(digits)}`;
}

function fmtPrice(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtTime(iso) {
  if (!iso) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function fmtDateTime(iso) {
  if (!iso) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatCountdown(ms) {
  const safe = Math.max(0, Number(ms || 0));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function directionText(direction) {
  return direction === "LONG" ? "买涨" : direction === "SHORT" ? "买跌" : "--";
}

function actorText(trade) {
  if (trade?.mode === "user-manual" || trade?.userManual) return "魏夙手动";
  if (trade?.mode === "historical") return "历史回放";
  return "AI 自动";
}

function userHabitBiasText(habits = {}) {
  const longTrades = Number(habits.longTrades || 0);
  const shortTrades = Number(habits.shortTrades || 0);
  if (!longTrades && !shortTrades) return "--";
  if (longTrades === shortTrades) return "多空均衡";
  return longTrades > shortTrades ? `偏买涨 ${longTrades}:${shortTrades}` : `偏买跌 ${shortTrades}:${longTrades}`;
}

function compactStakeText(value) {
  const amount = Number(value || 0);
  return amount >= 10 ? Math.round(amount).toString() : amount.toFixed(1);
}

function durationLabel(trade) {
  const minutes = Number(trade.durationMinutes || Number.parseInt(trade.timeframe, 10) || 10);
  return `${minutes}m`;
}

function settlementLabel(trade) {
  if (trade.exitTime) return fmtDateTime(trade.exitTime);
  if (trade.settlementTime) return `预计 ${fmtDateTime(trade.settlementTime)}`;
  return "--";
}

function plainSettlementLabel(trade) {
  if (!trade?.settlementTime) return "信号到达即开";
  return fmtDateTime(trade.settlementTime);
}

function resultText(result) {
  if (result === "WIN") return "成功";
  if (result === "LOSS") return "失败";
  if (result === "FLAT") return "持平";
  return "进行中";
}

function setText(el, value) {
  el.textContent = value;
}

function eventOddsText(state, open) {
  const payout = Number(open?.payoutRate ?? state?.config?.payoutRate ?? 0.82);
  return `模拟回报 +${Math.round(payout * 100)}%`;
}

function updateTickerTape(state, priceChange) {
  const account = state.account || {};
  const stats = state.stats || {};
  const price = `$${fmtPrice(state.market?.currentPrice)}`;
  const pnl = `${account.realizedPnlUsdt >= 0 ? "+" : ""}${fmtUsdt(account.realizedPnlUsdt)}`;
  const items = [
    `BTCUSDT 永续 ${price}`,
    `短线波动 ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(3)}%`,
    "事件窗口 10m / 15m",
    eventOddsText(state, state.openTrade),
    `胜率 ${stats.winRate || 0}% · 样本 ${stats.settledTrades || 0}`,
    `余额 ${fmtUsdt(account.availableBalanceUsdt)}`,
    `累计 ${pnl}`,
    state.bot?.active ? "AI 扫描高胜率事件" : "AI 已暂停",
    state.openTrade ? `${durationLabel(state.openTrade)} ${directionText(state.openTrade.direction)} LIVE` : "纪律: 边际不够不买",
  ];
  els.tickerTape.innerHTML = [...items, ...items].map((item) => `<span>${item}</span>`).join("");
}

function confidenceFromBotNote(note) {
  const match = String(note || "").match(/置信度\s*(\d+)%/);
  return match ? `${match[1]}%` : "--";
}

function eventHeatText(state, open) {
  if (open) return `${Math.round(Number(open.confidence || 0) * 100)}% LIVE`;
  const skippedConfidence = confidenceFromBotNote(state.bot?.note);
  if (skippedConfidence !== "--") return `${skippedConfidence} WAIT`;
  if (!state.bot?.active) return "PAUSED";
  return "SCANNING";
}

function eventTempoText(state) {
  const baseCandles = state.market?.baseCandles || [];
  const recent = baseCandles.slice(-4);
  if (recent.length < 2) return "装载行情";
  const first = recent[0].close || recent[0].open || 0;
  const last = recent[recent.length - 1].close || first;
  const movePct = first ? Math.abs((last - first) / first) * 100 : 0;
  if (movePct >= 0.18) return "高速波动";
  if (movePct >= 0.08) return "可下注区";
  return "窄幅磨盘";
}

function eventRuleText(state, open) {
  if (open) return `${durationLabel(open)} 到期结算`;
  if (!state.bot?.active) return "暂停观察";
  if (state.bot?.status === "signal-skipped") return "边际不够不买";
  if (state.account?.availableBalanceUsdt < state.config?.minStakeUsdt) return "余额风控";
  return "只打高胜率";
}

function impliedEdge(state, open) {
  const noteConfidence = Number(confidenceFromBotNote(state.bot?.note).replace("%", "")) / 100;
  const confidence = Number(open?.confidence || noteConfidence || 0.5);
  const directional = open?.direction === "SHORT" ? -1 : open?.direction === "LONG" ? 1 : Math.sign(Number(state.market?.priceChangePct || 0));
  const centered = Math.max(0.08, Math.min(0.92, confidence));
  const longEdge = directional >= 0 ? centered : 1 - centered;
  return {
    long: Math.round(Math.max(0.08, Math.min(0.92, longEdge)) * 100),
    short: Math.round(Math.max(0.08, Math.min(0.92, 1 - longEdge)) * 100),
  };
}

function updateMarketFlare(state, open) {
  const edge = impliedEdge(state, open);
  setText(els.flareEvent, open ? `${durationLabel(open)} ${directionText(open.direction)}` : "10m / 15m");
  setText(els.flareOdds, eventOddsText(state, open).replace("模拟回报 ", ""));
  setText(els.flareFlow, open ? "LIVE TICKET" : eventTempoText(state));
  setText(els.flareEdge, open ? `${Math.max(edge.long, edge.short)}%` : eventRuleText(state, open));
}

function updateContractBoard(state, open) {
  const confidence = Number(open?.confidence || 0);
  const activeLong = open?.direction === "LONG";
  const activeShort = open?.direction === "SHORT";
  const edge = impliedEdge(state, open);

  setText(els.eventWindow, open ? `${durationLabel(open)} 事件合约` : "10m / 15m 候选");
  setText(els.eventOdds, eventOddsText(state, open));
  setText(els.callTicketState, activeLong ? "LIVE" : "WAIT");
  setText(els.putTicketState, activeShort ? "LIVE" : "WAIT");
  setText(els.eventSide, open ? directionText(open.direction) : "等待高胜率触发");
  setText(els.eventStake, open ? fmtUsdt(open.stakeUsdt) : `最低 ${fmtUsdt(state.config?.minStakeUsdt || 5)}`);
  setText(els.eventEdge, open ? `${Math.round(confidence * 100)}%` : `${state.bot?.status || "扫描中"}`);
  setText(els.eventSettle, plainSettlementLabel(open));
  setText(els.eventHeat, eventHeatText(state, open));
  setText(els.eventTempo, eventTempoText(state));
  setText(els.eventRule, eventRuleText(state, open));
  updateMarketFlare(state, open);

  els.callTicket.classList.toggle("active", activeLong);
  els.putTicket.classList.toggle("active", activeShort);
  els.callTicket.classList.toggle("muted", activeShort);
  els.putTicket.classList.toggle("muted", activeLong);
  els.eventHeat.classList.toggle("hot", Boolean(open) && confidence >= 0.66);
  els.callEdgeBar.style.width = `${edge.long}%`;
  els.putEdgeBar.style.width = `${edge.short}%`;
  els.callEdgeBar.parentElement.classList.toggle("hot", activeLong);
  els.putEdgeBar.parentElement.classList.toggle("hot", activeShort);
}

function updateManualOrderPanel(state) {
  const habits = state.userHabits || {};
  const minStake = Number(state.config?.minStakeUsdt || 5);
  const balance = Number(state.account?.availableBalanceUsdt || 0);
  const hasPrice = Number(state.market?.currentPrice || 0) > 0;
  const hasOpenTrade = Boolean(state.openTrade);
  const disabled = hasOpenTrade || balance < minStake || !hasPrice;

  els.manualStake.min = String(minStake);
  els.manualStake.max = String(Math.max(minStake, balance).toFixed(2));
  if (!els.manualStake.value || Number(els.manualStake.value) < minStake) {
    els.manualStake.value = minStake.toFixed(2);
  }
  if (Number(els.manualStake.value) > balance && balance >= minStake) {
    els.manualStake.value = balance.toFixed(2);
  }

  els.manualButtons.forEach((button) => {
    button.disabled = disabled;
  });
  els.manualStake.disabled = disabled && balance < minStake;
  els.manualDuration.disabled = disabled && hasOpenTrade;

  setText(els.userHabitWinRate, `${Number(habits.winRate || 0).toFixed(1)}%`);
  setText(els.userHabitSamples, `${habits.totalTrades || 0} 笔`);
  setText(els.userHabitBias, userHabitBiasText(habits));

  if (hasOpenTrade) {
    setText(els.manualStatus, "当前已有未结算票据，等结算后再手动参与。");
  } else if (balance < minStake) {
    setText(els.manualStatus, `可用余额低于 ${minStake.toFixed(2)} USDT，暂不能手动下单。`);
  } else if (!hasPrice) {
    setText(els.manualStatus, "等待 Binance 永续行情价，拿到真实入场价后才能手动下单。");
  } else {
    setText(els.manualStatus, habits.lastLesson || "手动单会进入同一个模拟账户，结算后单独复盘你的判断习惯。");
  }
}

function durableTrades(state) {
  return [
    ...(state?.trades || []),
    state?.openTrade,
  ].filter((trade) => trade && trade.mode !== "historical");
}

function buildClientBackup(state) {
  return {
    updatedAt: state.updatedAt || state.serverTime || new Date().toISOString(),
    serverResetAt: state.bot?.manualResetAt || null,
    account: state.account,
    openTrade: state.openTrade || null,
    trades: (state.trades || []).slice(0, CLIENT_BACKUP_TRADE_LIMIT),
    insights: (state.insights || []).slice(0, 20),
    userHabits: state.userHabits || null,
  };
}

function saveClientBackup(state) {
  if (!window.localStorage || !state) return;
  const hasTradeHistory = (state.trades || []).length || state.openTrade;
  const hasAccountHistory = Math.abs(Number(state.account?.realizedPnlUsdt || 0)) > 0.0001;
  const resetLocked = state.bot?.manualResetAt || state.bot?.status === "paused-after-reset";
  if (resetLocked && !hasTradeHistory && !hasAccountHistory) {
    clearClientBackup();
    return;
  }
  if (!hasTradeHistory && !hasAccountHistory) return;
  try {
    localStorage.setItem(CLIENT_BACKUP_KEY, JSON.stringify(buildClientBackup(state)));
  } catch {
    // Local browser storage can be unavailable in private modes; server state remains primary.
  }
}

function readClientBackup() {
  if (!window.localStorage) return null;
  try {
    const raw = localStorage.getItem(CLIENT_BACKUP_KEY);
    if (!raw) return null;
    const backup = JSON.parse(raw);
    if (!Array.isArray(backup.trades)) return null;
    return backup;
  } catch {
    return null;
  }
}

function clearClientBackup() {
  try {
    localStorage.removeItem(CLIENT_BACKUP_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function shouldRestoreFromClientBackup(serverState, backup) {
  if (restoreAttempted || !backup) return false;
  const backupCount = (backup.trades || []).length + (backup.openTrade ? 1 : 0);
  if (!backupCount) return false;
  const serverDurableCount = durableTrades(serverState).length;
  return serverDurableCount === 0;
}

async function restoreClientBackupIfNeeded(serverState) {
  const backup = readClientBackup();
  if (!shouldRestoreFromClientBackup(serverState, backup)) return serverState;
  restoreAttempted = true;
  const response = await fetch("/api/restore-client-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(backup),
  });
  const result = await response.json();
  return result.state || serverState;
}

function updateState(state) {
  latestState = state;
  const account = state.account;
  const stats = state.stats;
  const open = state.openTrade;
  const balanceRmb = account.availableBalanceUsdt * account.rmbPerUsdt;
  const priceChange = Number(state.market.priceChangePct || 0);

  setText(els.modePill, `永续实盘 · 模拟账户`);
  setText(els.balanceRmb, fmtRmb(balanceRmb));
  setText(els.balanceUsdt, `${fmtUsdt(account.availableBalanceUsdt)} 可用 · ${fmtUsdt(account.equityUsdt)} 权益`);
  setText(els.pnlRmb, `${account.realizedPnlRmb >= 0 ? "+" : ""}${fmtRmb(account.realizedPnlRmb)}`);
  setText(els.pnlUsdt, `${account.realizedPnlUsdt >= 0 ? "+" : ""}${fmtUsdt(account.realizedPnlUsdt)}`);
  setText(els.winRate, `${stats.winRate}%`);
  setText(els.tradeCount, `${stats.settledTrades} 已结算 · ${stats.totalTrades} 总笔数`);
  setText(els.countdown, formatCountdown(state.countdownMs));
  setText(els.botStatus, `${state.bot.status} · ${fmtTime(state.serverTime)}`);
  setText(els.currentPrice, `$${fmtPrice(state.market.currentPrice)}`);
  setText(els.priceChange, `${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(3)}%`);
  els.priceChange.className = priceChange >= 0 ? "positive" : "negative";
  setText(els.dataSource, state.market.source || "--");
  updateTickerTape(state, priceChange);
  updateContractBoard(state, open);
  updateManualOrderPanel(state);

  setText(els.positionTitle, open ? `${open.signalLabel} · ${directionText(open.direction)}` : "等待信号");
  setText(els.positionDirection, open ? directionText(open.direction) : "--");
  setText(els.entryPrice, open ? `$${fmtPrice(open.entryPrice)}` : "--");
  setText(els.stake, open ? fmtUsdt(open.stakeUsdt) : "--");
  setText(els.confidence, open ? `${Math.round(open.confidence * 100)}%` : "--");
  setText(els.aiNote, state.bot.note || open?.preTradeNote || "扫描 Binance 永续1分钟波动，等待高质量10/15分钟事件订单。");
  setText(els.exposure, fmtUsdt(account.openExposureUsdt));
  setText(els.drawdown, fmtUsdt(account.maxDrawdownUsdt));
  setText(els.streak, stats.currentStreak);

  els.toggleBot.textContent = state.bot.active ? "⏸" : "▶";
  els.statusDot.className = "status-dot";
  if (!state.bot.active || state.bot.status.includes("paused")) els.statusDot.classList.add("paused");
  if (state.bot.status === "error") els.statusDot.classList.add("error");

  renderTrades(state);
  syncChartControls(state);
  drawChart(state);
  startCountdown();
  saveClientBackup(state);
}

function renderTrades(state) {
  const rows = [];
  if (state.openTrade) rows.push(state.openTrade);
  rows.push(...state.trades);

  els.tradeRows.innerHTML = rows
    .slice(0, CLIENT_BACKUP_TRADE_LIMIT)
    .map((trade) => {
      const resultClass = trade.result === "WIN" ? "win" : trade.result === "LOSS" ? "loss" : trade.result === "FLAT" ? "flat" : "pending";
      const directionClass = trade.direction === "LONG" ? "long" : "short";
      const pnlClass = trade.pnlUsdt >= 0 ? "positive" : "negative";
      return `
        <tr>
          <td>${trade.sequence ? `#${trade.sequence}` : trade.id}</td>
          <td>${fmtDateTime(trade.entryTime)}</td>
          <td><span class="tag period">${durationLabel(trade)}</span></td>
          <td><span class="tag ${directionClass}">${directionText(trade.direction)}</span></td>
          <td><span class="tag source">${actorText(trade)}</span></td>
          <td>${fmtUsdt(trade.stakeUsdt)}</td>
          <td>$${fmtPrice(trade.entryPrice)}</td>
          <td>${trade.exitPrice ? `$${fmtPrice(trade.exitPrice)}` : "等待结算"}</td>
          <td>${settlementLabel(trade)}</td>
          <td><span class="tag ${resultClass}">${resultText(trade.result)}</span></td>
          <td class="${pnlClass}">${trade.pnlUsdt >= 0 ? "+" : ""}${fmtUsdt(trade.pnlUsdt)}</td>
          <td class="summary-cell">${trade.summary || trade.preTradeNote}</td>
        </tr>
      `;
    })
    .join("");
}

function aggregateForTimeframe(baseCandles, timeframe) {
  const intervalMs = TIMEFRAMES[timeframe] || TIMEFRAMES["10m"];
  const loaded = chartCandlesByTimeframe.get(timeframe);
  if (loaded?.length) return loaded;
  if (LONG_HISTORY_TIMEFRAMES.has(timeframe)) return [];
  if (timeframe === "10m" && latestState?.market?.candles?.length) return latestState.market.candles;
  if (!baseCandles?.length) return [];
  if (timeframe === "1m") return baseCandles;

  const buckets = new Map();
  baseCandles.forEach((item) => {
    const bucketTime = Math.floor(item.openTime / intervalMs) * intervalMs;
    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, {
        time: bucketTime,
        openTime: bucketTime,
        closeTime: bucketTime + intervalMs - 1,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.volume,
        closed: item.closeTime < Date.now(),
      });
      return;
    }
    existing.high = Math.max(existing.high, item.high);
    existing.low = Math.min(existing.low, item.low);
    existing.close = item.close;
    existing.volume += item.volume;
    existing.closed = existing.closeTime < Date.now();
  });

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

function candlesForSelectedTimeframe(state = latestState) {
  return aggregateForTimeframe(state?.market?.baseCandles || [], selectedTimeframe);
}

function shouldLoadServerKlines(timeframe) {
  return SERVER_KLINE_TIMEFRAMES.has(timeframe) && !chartCandlesByTimeframe.has(timeframe) && chartLoadingTimeframe !== timeframe;
}

function loadTimeframeCandles(timeframe) {
  if (!shouldLoadServerKlines(timeframe)) return;
  chartLoadingTimeframe = timeframe;
  setText(els.klineRangeLabel, `正在加载 Binance 永续 ${timeframe} 历史K线...`);

  fetch(`/api/klines?interval=${encodeURIComponent(timeframe)}`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((payload) => {
      const candles = Array.isArray(payload.candles) ? payload.candles : [];
      chartCandlesByTimeframe.set(timeframe, candles);
      if (selectedTimeframe === timeframe && latestState) {
        if (LONG_HISTORY_TIMEFRAMES.has(timeframe)) {
          chartView = timeframe === "1d" ? "focus" : "overview";
          visibleCandles = timeframe === "1d" ? 240 : 180;
        }
        syncChartControls(latestState);
        drawChart(latestState);
      }
    })
    .catch((error) => {
      if (selectedTimeframe === timeframe) {
        setText(els.klineRangeLabel, `Binance ${timeframe} 历史K线加载失败：${error.message}`);
      }
    })
    .finally(() => {
      if (chartLoadingTimeframe === timeframe) chartLoadingTimeframe = null;
    });
}

function drawChart(state) {
  loadTimeframeCandles(selectedTimeframe);
  const candlesForTimeframe = candlesForSelectedTimeframe(state);
  const windowInfo = getWindowInfo(candlesForTimeframe);
  updateChartRangeLabel(windowInfo);
  drawMainChart(state, windowInfo);
  drawOverviewChart(state, windowInfo);
}

function getWindowInfo(allCandles) {
  const total = allCandles?.length || 0;
  const count = chartView === "overview" ? total : Math.min(total, Math.max(18, visibleCandles));
  const maxStart = Math.max(0, total - count);
  const start = chartView === "overview" ? 0 : Math.round(maxStart * viewEndRatio);
  return {
    allCandles: allCandles || [],
    candles: (allCandles || []).slice(start, start + count),
    start,
    count,
    total,
  };
}

function formatAxisDate(timeMs, timeframe = selectedTimeframe) {
  const date = new Date(timeMs);
  if (timeframe === "1M") {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (timeframe === "1w" || timeframe === "1d") {
    return `${String(date.getUTCFullYear()).slice(2)}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function updateChartRangeLabel(windowInfo) {
  const candles = windowInfo.allCandles || [];
  if (!candles.length) {
    setText(els.klineRangeLabel, chartLoadingTimeframe === selectedTimeframe ? `正在加载 Binance 永续 ${selectedTimeframe} 历史K线...` : "等待 Binance 永续K线");
    return;
  }
  const first = candles[0];
  const last = candles[candles.length - 1];
  const shownStart = windowInfo.candles[0] || first;
  const shownEnd = windowInfo.candles[windowInfo.candles.length - 1] || last;
  const scope = LONG_HISTORY_TIMEFRAMES.has(selectedTimeframe) ? "上线以来历史" : "近期历史";
  setText(
    els.klineRangeLabel,
    `${scope} · ${selectedTimeframe} · 全部 ${candles.length} 根 · 当前 ${formatAxisDate(shownStart.openTime)} 至 ${formatAxisDate(shownEnd.openTime)}`,
  );
}

function setupCanvas(canvas, minHeight = 320) {
  const parent = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, parent.clientWidth);
  const height = Math.max(minHeight, parent.clientHeight);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawMainChart(state, windowInfo) {
  const { ctx, width, height } = setupCanvas(els.canvas, 320);
  const candles = windowInfo.candles;
  if (!candles.length) {
    drawCanvasMessage(ctx, width, height, chartLoadingTimeframe === selectedTimeframe ? "正在加载 Binance 永续历史K线..." : "等待 Binance 永续K线");
    return;
  }

  const padding = { top: 20, right: 72, bottom: 34, left: 18 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const range = Math.max(1, maxPrice - minPrice);
  const priceToY = (price) => padding.top + ((maxPrice - price) / range) * chartH;
  const step = chartW / candles.length;
  const denseMode = step < 2.4;
  const drawEvery = denseMode ? Math.max(1, Math.ceil(candles.length / chartW)) : 1;
  const bodyW = denseMode ? 1 : Math.max(3, Math.min(12, step * 0.58));

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(155,163,173,0.85)";
  ctx.font = "12px Inter, sans-serif";

  for (let i = 0; i <= 5; i += 1) {
    const y = padding.top + (chartH / 5) * i;
    const price = maxPrice - (range / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right + 4, y);
    ctx.stroke();
    ctx.fillText(fmtPrice(price), width - padding.right + 10, y + 4);
  }

  const xTicks = 5;
  for (let i = 0; i <= xTicks; i += 1) {
    const index = Math.min(candles.length - 1, Math.round((candles.length - 1) * (i / xTicks)));
    const candle = candles[index];
    const x = padding.left + step * index + step / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.055)";
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();
    ctx.fillStyle = "rgba(155,163,173,0.78)";
    ctx.fillText(formatAxisDate(candle.openTime), Math.max(padding.left, Math.min(width - padding.right - 58, x - 26)), height - 9);
  }

  if (denseMode) {
    ctx.strokeStyle = "rgba(54, 214, 195, 0.76)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    candles.forEach((candle, index) => {
      const x = padding.left + step * index + step / 2;
      const y = priceToY(candle.close);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  candles.forEach((candle, index) => {
    if (denseMode && index % drawEvery !== 0 && index !== candles.length - 1) return;
    const x = padding.left + step * index + step / 2;
    const up = candle.close >= candle.open;
    const color = up ? "#18c47c" : "#f05d5e";
    const yOpen = priceToY(candle.open);
    const yClose = priceToY(candle.close);
    const yHigh = priceToY(candle.high);
    const yLow = priceToY(candle.low);
    const top = Math.min(yOpen, yClose);
    const bodyH = Math.max(2, Math.abs(yOpen - yClose));

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();
    ctx.fillRect(x - bodyW / 2, top, bodyW, bodyH);
  });

  const trades = [...(state.trades || []), state.openTrade].filter(Boolean);
  const tradeMarkers = trades.map((trade) => {
    const entryTime = new Date(trade.entryTime).getTime();
    const index = candles.findIndex((candle) => entryTime >= candle.openTime && entryTime <= candle.closeTime);
    if (index < 0) return null;
    const x = padding.left + step * index + step / 2;
    const y = priceToY(trade.entryPrice);
    const long = trade.direction === "LONG";
    const color = long ? "#36d6c3" : "#d7a84f";
    const distance = chartHover.x == null ? Infinity : Math.hypot(chartHover.x - x, chartHover.y - y);
    return { trade, x, y, long, color, distance };
  }).filter(Boolean);
  const hoveredMarker = tradeMarkers.reduce((closest, marker) => {
    if (marker.distance >= 34) return closest;
    return !closest || marker.distance < closest.distance ? marker : closest;
  }, null);

  tradeMarkers.forEach((marker) => {
    const { trade, x, y, long, color } = marker;
    const expanded = hoveredMarker === marker;
    const labelAllowed = expanded || (!denseMode && step >= 24 && tradeMarkers.length <= 14);
    const label = expanded
      ? `${durationLabel(trade)} ${directionText(trade.direction)} ${Number(trade.stakeUsdt).toFixed(2)}U @${fmtPrice(trade.entryPrice)}`
      : `${long ? "涨" : "跌"}${compactStakeText(trade.stakeUsdt)}U`;
    const labelY = expanded
      ? (long ? Math.max(padding.top + 4, y - 38) : Math.min(height - padding.bottom - 26, y + 18))
      : (long ? Math.max(padding.top + 4, y - 24) : Math.min(height - padding.bottom - 16, y + 8));

    if (labelAllowed) {
      ctx.font = expanded ? "700 12px Inter, sans-serif" : "800 9px Inter, sans-serif";
      const textPadding = expanded ? 9 : 4;
      const labelWidth = expanded
        ? Math.min(ctx.measureText(label).width + textPadding * 2, 198)
        : Math.min(Math.max(ctx.measureText(label).width + textPadding * 2, 28), 46);
      const labelHeight = expanded ? 26 : 16;
      const labelX = Math.max(padding.left, Math.min(width - padding.right - labelWidth, x - labelWidth / 2));
      ctx.globalAlpha = expanded ? 1 : 0.78;
      ctx.fillStyle = "rgba(8, 9, 11, 0.92)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      roundRect(ctx, labelX, labelY, labelWidth, labelHeight, expanded ? 6 : 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(label, labelX + textPadding, labelY + (expanded ? 17 : 12), labelWidth - textPadding * 2);
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = color;
    ctx.beginPath();
    if (long) {
      ctx.moveTo(x, y - 10);
      ctx.lineTo(x - 7, y + 5);
      ctx.lineTo(x + 7, y + 5);
    } else {
      ctx.moveTo(x, y + 10);
      ctx.lineTo(x - 7, y - 5);
      ctx.lineTo(x + 7, y - 5);
    }
    ctx.closePath();
    ctx.fill();
  });

  const latest = candles[candles.length - 1];
  const yLatest = priceToY(latest.close);
  ctx.strokeStyle = "rgba(215,168,79,0.85)";
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(padding.left, yLatest);
  ctx.lineTo(width - padding.right, yLatest);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#d7a84f";
  ctx.fillText(`$${fmtPrice(latest.close)}`, width - padding.right + 10, yLatest - 8);
}

function drawCanvasMessage(ctx, width, height, message) {
  ctx.fillStyle = "rgba(155,163,173,0.86)";
  ctx.font = "700 14px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(message, width / 2, height / 2);
  ctx.textAlign = "left";
}

function drawOverviewChart(state, windowInfo) {
  const { ctx, width, height } = setupCanvas(els.overviewCanvas, 74);
  const all = windowInfo.allCandles || [];
  const candles = LONG_HISTORY_TIMEFRAMES.has(selectedTimeframe) ? all : all.slice(-520);
  if (!candles.length) {
    drawCanvasMessage(ctx, width, height, "等待全览K线");
    return;
  }

  const padding = { top: 10, right: 16, bottom: 16, left: 16 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const maxPrice = Math.max(...candles.map((c) => c.high));
  const minPrice = Math.min(...candles.map((c) => c.low));
  const range = Math.max(1, maxPrice - minPrice);
  const priceToY = (price) => padding.top + ((maxPrice - price) / range) * chartH;
  const step = chartW / Math.max(1, candles.length - 1);

  ctx.strokeStyle = "rgba(54, 214, 195, 0.72)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  candles.forEach((candle, index) => {
    const x = padding.left + step * index;
    const y = priceToY(candle.close);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const offset = Math.max(0, windowInfo.total - candles.length);
  const localStart = Math.max(0, windowInfo.start - offset);
  const localEnd = Math.min(candles.length - 1, localStart + Math.max(1, windowInfo.count - 1));
  const startX = padding.left + step * localStart;
  const endX = padding.left + step * localEnd;
  ctx.fillStyle = "rgba(215, 168, 79, 0.12)";
  ctx.strokeStyle = "rgba(215, 168, 79, 0.55)";
  ctx.fillRect(startX, padding.top, Math.max(2, endX - startX), chartH);
  ctx.strokeRect(startX, padding.top, Math.max(2, endX - startX), chartH);

  ctx.fillStyle = "rgba(155, 163, 173, 0.9)";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText(`${selectedTimeframe} 全览 · ${formatAxisDate(candles[0].openTime)} → ${formatAxisDate(candles[candles.length - 1].openTime)}`, padding.left, height - 5);
}

function syncChartControls(state = latestState) {
  const allCandles = candlesForSelectedTimeframe(state);
  if (allCandles.length) {
    visibleCandles = Math.min(Math.max(18, visibleCandles), allCandles.length);
  }
  els.rangeSlider.value = String(Math.round(viewEndRatio * 1000));
  els.toggleOverview.classList.toggle("active", chartView === "overview");
  els.toggleOverview.textContent = chartView === "overview" ? "聚焦" : "全览";
}

function setFocusMode() {
  chartView = "focus";
  syncChartControls();
}

function adjustZoom(multiplier) {
  const allCandles = candlesForSelectedTimeframe(latestState);
  if (!allCandles.length) return;
  setFocusMode();
  visibleCandles = Math.round(Math.max(18, Math.min(allCandles.length, visibleCandles * multiplier)));
  syncChartControls();
  drawChart(latestState);
}

function panWindow(deltaRatio) {
  setFocusMode();
  viewEndRatio = Math.max(0, Math.min(1, viewEndRatio + deltaRatio));
  syncChartControls();
  if (latestState) drawChart(latestState);
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (!latestState?.openTrade?.settlementTime) return;
    const ms = new Date(latestState.openTrade.settlementTime).getTime() - Date.now();
    setText(els.countdown, formatCountdown(ms));
  }, 1000);
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    if (payload.state) updateState(payload.state);
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  const state = payload.state || payload;
  updateState(state);
  return state;
}

async function fetchState() {
  const state = await fetch("/api/state").then((res) => res.json());
  updateState(state);
  return state;
}

function startStatePolling() {
  clearInterval(statePollTimer);
  statePollTimer = setInterval(() => {
    fetchState().catch(() => {});
  }, STATE_POLL_MS);
}

async function runAutoAdvance() {
  if (autoAdvanceInFlight || document.hidden) return;
  autoAdvanceInFlight = true;
  try {
    await postJson("/api/advance");
  } catch {
    fetchState().catch(() => {});
  } finally {
    autoAdvanceInFlight = false;
  }
}

function startAutoAdvance() {
  clearInterval(autoAdvanceTimer);
  window.setTimeout(() => runAutoAdvance(), 2000);
  autoAdvanceTimer = setInterval(() => runAutoAdvance(), AUTO_ADVANCE_MS);
}

els.toggleBot.addEventListener("click", () => {
  postJson("/api/control", { active: !latestState?.bot?.active });
});

els.advanceBot.addEventListener("click", () => {
  postJson("/api/advance");
});

async function submitManualOrder(direction) {
  const durationMinutes = Number(els.manualDuration.value || 10);
  const stakeUsdt = Number(els.manualStake.value || latestState?.config?.minStakeUsdt || 5);
  setText(els.manualStatus, "正在按真实 Binance 永续价提交手动模拟单...");
  try {
    await postJson("/api/manual-order", { direction, durationMinutes, stakeUsdt });
  } catch (error) {
    setText(els.manualStatus, error.message);
  }
}

els.manualButtons.forEach((button) => {
  button.addEventListener("click", () => {
    submitManualOrder(button.dataset.manualDirection);
  });
});

function openResetConfirm() {
  els.resetConfirm.hidden = false;
  els.confirmReset.focus();
}

function closeResetConfirm() {
  els.resetConfirm.hidden = true;
}

async function confirmResetSimulation() {
  closeResetConfirm();
  clearClientBackup();
  await postJson("/api/reset");
}

els.resetBot.addEventListener("click", openResetConfirm);
els.cancelReset.addEventListener("click", closeResetConfirm);
els.confirmReset.addEventListener("click", () => {
  confirmResetSimulation().catch(() => fetchState().catch(() => {}));
});

els.resetConfirm.addEventListener("click", (event) => {
  if (event.target === els.resetConfirm) closeResetConfirm();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.resetConfirm.hidden) closeResetConfirm();
});

els.timeframeTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-timeframe]");
  if (!button) return;
  selectedTimeframe = button.dataset.timeframe;
  viewEndRatio = 1;
  if (LONG_HISTORY_TIMEFRAMES.has(selectedTimeframe)) {
    chartView = selectedTimeframe === "1d" ? "focus" : "overview";
    visibleCandles = selectedTimeframe === "1d" ? 240 : 180;
  } else {
    chartView = "focus";
    visibleCandles = selectedTimeframe === "1h" ? 180 : 64;
  }
  els.timeframeTabs.querySelectorAll("button").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
  loadTimeframeCandles(selectedTimeframe);
  syncChartControls(latestState);
  if (latestState) drawChart(latestState);
});

els.toggleOverview.addEventListener("click", () => {
  chartView = chartView === "focus" ? "overview" : "focus";
  els.toggleOverview.classList.toggle("active", chartView === "overview");
  els.toggleOverview.textContent = chartView === "overview" ? "聚焦" : "全览";
  if (latestState) drawChart(latestState);
});

els.zoomIn.addEventListener("click", () => adjustZoom(0.72));
els.zoomOut.addEventListener("click", () => adjustZoom(1.38));
els.panLeft.addEventListener("click", () => panWindow(-0.12));
els.panRight.addEventListener("click", () => panWindow(0.12));
els.rangeSlider.addEventListener("input", () => {
  setFocusMode();
  viewEndRatio = Number(els.rangeSlider.value) / 1000;
  if (latestState) drawChart(latestState);
});

els.canvas.addEventListener("mousemove", (event) => {
  const rect = els.canvas.getBoundingClientRect();
  chartHover = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (latestState) drawChart(latestState);
});

els.canvas.addEventListener("mouseleave", () => {
  chartHover = { x: null, y: null };
  if (latestState) drawChart(latestState);
});

window.addEventListener("resize", () => {
  if (latestState) drawChart(latestState);
});

async function boot() {
  const initial = await fetch("/api/state").then((res) => res.json());
  const restored = await restoreClientBackupIfNeeded(initial);
  updateState(restored);

  const stream = new EventSource("/api/stream");
  stream.addEventListener("message", (event) => {
    updateState(JSON.parse(event.data));
  });
  stream.addEventListener("error", () => {
    fetchState().catch(() => {});
  });

  startStatePolling();
  startAutoAdvance();
}

boot().catch((error) => {
  setText(els.aiNote, `页面连接失败：${error.message}`);
});
