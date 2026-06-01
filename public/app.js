const els = {
  modePill: document.getElementById("modePill"),
  toggleBot: document.getElementById("toggleBot"),
  advanceBot: document.getElementById("advanceBot"),
  resetBot: document.getElementById("resetBot"),
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

const TIMEFRAMES = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "10m": 10 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

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

function resultText(result) {
  if (result === "WIN") return "成功";
  if (result === "LOSS") return "失败";
  if (result === "FLAT") return "持平";
  return "进行中";
}

function setText(el, value) {
  el.textContent = value;
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
}

function renderTrades(state) {
  const rows = [];
  if (state.openTrade) rows.push(state.openTrade);
  rows.push(...state.trades);

  els.tradeRows.innerHTML = rows
    .slice(0, 30)
    .map((trade) => {
      const resultClass = trade.result === "WIN" ? "win" : trade.result === "LOSS" ? "loss" : trade.result === "FLAT" ? "flat" : "pending";
      const directionClass = trade.direction === "LONG" ? "long" : "short";
      const pnlClass = trade.pnlUsdt >= 0 ? "positive" : "negative";
      return `
        <tr>
          <td>${trade.id}</td>
          <td>${fmtDateTime(trade.entryTime)}</td>
          <td><span class="tag period">${durationLabel(trade)}</span></td>
          <td><span class="tag ${directionClass}">${directionText(trade.direction)}</span></td>
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

function drawChart(state) {
  const candlesForTimeframe = aggregateForTimeframe(state.market.baseCandles, selectedTimeframe);
  const windowInfo = getWindowInfo(candlesForTimeframe);
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
  if (!candles.length) return;

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
  const bodyW = Math.max(4, Math.min(12, step * 0.58));

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

  candles.forEach((candle, index) => {
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
    const label = expanded
      ? `${durationLabel(trade)} ${directionText(trade.direction)} ${Number(trade.stakeUsdt).toFixed(2)}U @${fmtPrice(trade.entryPrice)}`
      : `${long ? "涨" : "跌"}${compactStakeText(trade.stakeUsdt)}U`;
    const labelY = expanded
      ? (long ? Math.max(padding.top + 4, y - 38) : Math.min(height - padding.bottom - 26, y + 18))
      : (long ? Math.max(padding.top + 4, y - 24) : Math.min(height - padding.bottom - 16, y + 8));

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

function drawOverviewChart(state, windowInfo) {
  const { ctx, width, height } = setupCanvas(els.overviewCanvas, 74);
  const candles = (windowInfo.allCandles || []).slice(-360);
  if (!candles.length) return;

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
  ctx.fillText(`${selectedTimeframe} 全览`, padding.left, height - 5);
}

function syncChartControls(state = latestState) {
  const allCandles = aggregateForTimeframe(state?.market?.baseCandles || [], selectedTimeframe);
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
  const allCandles = aggregateForTimeframe(latestState?.market?.baseCandles || [], selectedTimeframe);
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
  const state = await response.json();
  updateState(state);
}

els.toggleBot.addEventListener("click", () => {
  postJson("/api/control", { active: !latestState?.bot?.active });
});

els.advanceBot.addEventListener("click", () => {
  postJson("/api/advance");
});

els.resetBot.addEventListener("click", () => {
  postJson("/api/reset");
});

els.timeframeTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-timeframe]");
  if (!button) return;
  selectedTimeframe = button.dataset.timeframe;
  els.timeframeTabs.querySelectorAll("button").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
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
  updateState(initial);

  const stream = new EventSource("/api/stream");
  stream.addEventListener("message", (event) => {
    updateState(JSON.parse(event.data));
  });
}

boot().catch((error) => {
  setText(els.aiNote, `页面连接失败：${error.message}`);
});
