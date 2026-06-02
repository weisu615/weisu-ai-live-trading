const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8787);
const TEN_MINUTES = 10 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const MAX_WAIT_BETWEEN_TRADES = 30 * 60 * 1000;
const EVALUATION_COOLDOWN_MS = 60 * 1000;
const MARKET_REFRESH_MS = 30 * 1000;
const STATE_PATH = path.join(__dirname, "data", "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const CONFIG = {
  appName: "魏夙的 AI 实盘",
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: "10m/15m",
  allowedOrderDurations: [10, 15],
  startingRmb: 200,
  rmbPerUsdt: Number(process.env.RMB_PER_USDT || 7.2),
  minStakeUsdt: 5,
  maxStakeUsdt: Number(process.env.MAX_STAKE_USDT || 8),
  maxStakeBalanceRatio: 0.32,
  payoutRate: 0.82,
  maxBootstrapTrades: 4,
};

const DEFAULT_BINANCE_FAPI_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://fapi4.binance.com",
];
const REGION_BLOCK_HINT = "HTTP 451: Binance refused futures market-data access from this deployment region/IP. Move the service to a non-restricted region or configure a trusted USD-M futures market-data proxy.";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

let state = createInitialState();
let subscribers = new Set();
let lastMarketRefresh = 0;
let marketRefreshInFlight = null;
let stateSaveTimer = null;
const execFileAsync = promisify(execFile);

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function nowIso() {
  return new Date().toISOString();
}

function formatPrice(value) {
  return round(value, 2).toFixed(2);
}

function createInitialState() {
  const startingBalanceUsdt = round(CONFIG.startingRmb / CONFIG.rmbPerUsdt, 4);

  return {
    schemaVersion: 1,
    appName: CONFIG.appName,
    mode: "PAPER_LIVE",
    updatedAt: nowIso(),
    config: { ...CONFIG, startingBalanceUsdt },
    account: {
      startingRmb: CONFIG.startingRmb,
      rmbPerUsdt: CONFIG.rmbPerUsdt,
      startingBalanceUsdt,
      availableBalanceUsdt: startingBalanceUsdt,
      equityUsdt: startingBalanceUsdt,
      realizedPnlUsdt: 0,
      realizedPnlRmb: 0,
      highWaterUsdt: startingBalanceUsdt,
      maxDrawdownUsdt: 0,
      openExposureUsdt: 0,
    },
    bot: {
      active: true,
      status: "booting",
      lastError: null,
      lastDecisionAt: null,
      lastEvaluationAt: null,
      lastEvaluatedBucket: null,
      nextDecisionTime: null,
      nextSettlementTime: null,
      dataSource: "initializing",
      riskMode: "signal-gated-dynamic-stake",
      note: "模拟环境，仅用于策略观察和复盘。",
    },
    market: {
      symbol: CONFIG.symbol,
      currentPrice: null,
      source: "none",
      baseCandles: [],
      candles: [],
      refreshedAt: null,
      priceChangePct: 0,
    },
    openTrade: null,
    trades: [],
    insights: [],
    stats: {
      totalTrades: 0,
      settledTrades: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      winRate: 0,
      currentStreak: "0",
      profitFactor: 0,
    },
  };
}

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_PATH, "utf8");
    const loaded = JSON.parse(raw);
    state = mergeLoadedState(loaded);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Failed to load state, starting fresh:", error.message);
    }
    state = createInitialState();
  }
}

function mergeLoadedState(loaded) {
  const fresh = createInitialState();
  const trades = Array.isArray(loaded.trades) ? loaded.trades.map(normalizeTradeShape) : [];
  return {
    ...fresh,
    ...loaded,
    mode: fresh.mode,
    config: { ...fresh.config, ...loaded.config, ...CONFIG },
    bot: { ...fresh.bot, ...loaded.bot },
    market: { ...fresh.market, ...loaded.market, symbol: CONFIG.symbol },
    account: { ...fresh.account, ...loaded.account },
    openTrade: loaded.openTrade ? normalizeTradeShape(loaded.openTrade) : null,
    trades,
    insights: Array.isArray(loaded.insights) ? loaded.insights : [],
  };
}

function normalizeTradeShape(trade) {
  const parsedDuration = Number.parseInt(String(trade.durationMinutes || trade.timeframe || "10"), 10);
  const durationMinutes = CONFIG.allowedOrderDurations.includes(parsedDuration) ? parsedDuration : 10;
  const entryMs = new Date(trade.entryTime || nowIso()).getTime();
  const settlementMs = trade.settlementTime
    ? new Date(trade.settlementTime).getTime()
    : entryMs + durationMinutes * 60 * 1000;

  return {
    ...trade,
    durationMinutes,
    timeframe: `${durationMinutes}m`,
    entryBucket: Number.isFinite(trade.entryBucket) ? trade.entryBucket : bucketOf(entryMs),
    settlementTime: new Date(settlementMs).toISOString(),
  };
}

function scheduleSave() {
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true });
      await fsp.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
      console.warn("Failed to save state:", error.message);
    }
  }, 250);
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of subscribers) {
    res.write(payload);
  }
}

function mutateState(mutator) {
  mutator();
  state.updatedAt = nowIso();
  recalculateStats();
  scheduleSave();
  broadcast();
}

function publicState() {
  const now = Date.now();
  const open = state.openTrade;
  const nextSettlementTime = open?.settlementTime || state.bot.nextSettlementTime || state.bot.nextDecisionTime;
  return {
    ...state,
    serverTime: nowIso(),
    countdownMs: nextSettlementTime ? Math.max(0, new Date(nextSettlementTime).getTime() - now) : 0,
  };
}

async function fetchKlinesFromBinance() {
  const symbol = state.market.symbol || CONFIG.symbol;
  const endpoints = buildBinanceFapiEndpoints(symbol);

  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const raw = await fetchJson(endpoint.url);
      return { source: endpoint.source, raw };
    } catch (error) {
      errors.push({ host: endpoint.host, source: endpoint.source, message: error.message });
    }
  }
  throw new Error(summarizeKlineFetchErrors(errors));
}

function buildBinanceFapiEndpoints(symbol) {
  return getBinanceFapiBases().map((base) => {
    const endpointUrl = new URL("/fapi/v1/klines", base);
    endpointUrl.searchParams.set("symbol", symbol);
    endpointUrl.searchParams.set("interval", "1m");
    endpointUrl.searchParams.set("limit", "720");
    return {
      host: endpointUrl.host,
      source: `Binance USD-M Futures 1m (${endpointUrl.host})`,
      url: endpointUrl.toString(),
    };
  });
}

function getBinanceFapiBases() {
  const configured = [process.env.BINANCE_FAPI_BASE_URL, process.env.BINANCE_FAPI_BASES]
    .filter(Boolean)
    .join(",");
  const values = (configured || DEFAULT_BINANCE_FAPI_BASES.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const normalized = [];
  for (const value of values) {
    try {
      const url = new URL(value);
      const base = url.origin;
      if (!normalized.includes(base)) normalized.push(base);
    } catch {
      // Ignore malformed operator-provided endpoint values.
    }
  }
  return normalized.length ? normalized : DEFAULT_BINANCE_FAPI_BASES;
}

function summarizeKlineFetchErrors(errors) {
  if (!errors.length) return "Unable to fetch Binance USD-M futures market data";
  const hosts = errors.map((error) => error.host).join(", ");
  const lastMessage = errors[errors.length - 1].message;
  const regionBlock = errors.find((error) => /\b451\b/.test(error.message));
  if (regionBlock) {
    return `Binance USD-M Futures 1m failed for ${hosts}. ${REGION_BLOCK_HINT} Blocked endpoint: ${regionBlock.host}. Error: ${regionBlock.message}`;
  }
  return `Binance USD-M Futures 1m failed for ${hosts}. Last error: ${lastMessage}`;
}

async function fetchJson(url) {
  try {
    return await fetchJsonWithNode(url);
  } catch (nodeError) {
    if (!canUsePowerShellFetch()) {
      throw new Error(`Node fetch failed (${formatFetchError(nodeError)})`);
    }
    try {
      return await fetchJsonWithPowerShell(url);
    } catch (psError) {
      throw new Error(`Node fetch failed (${formatFetchError(nodeError)}); PowerShell fetch failed (${formatFetchError(psError)})`);
    }
  }
}

function canUsePowerShellFetch() {
  return process.platform === "win32" && process.env.DISABLE_POWERSHELL_FETCH !== "1";
}

function formatFetchError(error) {
  const message = error?.message || String(error);
  if (/\b451\b/.test(message)) return `${message}; ${REGION_BLOCK_HINT}`;
  return message;
}

async function fetchJsonWithNode(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "WeiSu-AI-Live-Trading/1.0" },
    });
    if (!response.ok) {
      const body = await response.text();
      const detail = body.trim().replace(/\s+/g, " ").slice(0, 160);
      throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithPowerShell(url) {
  const escapedUrl = url.replace(/'/g, "''");
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
    `(Invoke-WebRequest -UseBasicParsing -Uri '${escapedUrl}' -Headers @{ 'User-Agent'='Mozilla/5.0' }).Content`,
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    timeout: 12000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

function normalizeKline(raw) {
  return {
    openTime: Number(raw[0]),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    closeTime: Number(raw[6]),
  };
}

function aggregateKlines(rawKlines, intervalMs = TEN_MINUTES) {
  const buckets = new Map();

  for (const item of rawKlines.map(normalizeKline)) {
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
        minuteCount: 1,
      });
      continue;
    }

    existing.high = Math.max(existing.high, item.high);
    existing.low = Math.min(existing.low, item.low);
    existing.close = item.close;
    existing.volume += item.volume;
    existing.minuteCount += 1;
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.time - b.time)
    .map((candle) => ({
      ...candle,
      open: round(candle.open, 2),
      high: round(candle.high, 2),
      low: round(candle.low, 2),
      close: round(candle.close, 2),
      volume: round(candle.volume, 3),
      closed: candle.closeTime < Date.now(),
    }));
}

function aggregateToTenMinuteCandles(rawKlines) {
  return aggregateKlines(rawKlines, TEN_MINUTES);
}

async function refreshMarket(force = false) {
  if (!force && Date.now() - lastMarketRefresh < MARKET_REFRESH_MS) return;
  if (marketRefreshInFlight) return marketRefreshInFlight;

  marketRefreshInFlight = (async () => {
    try {
      const { source, raw } = await fetchKlinesFromBinance();
      const baseCandles = raw.map(normalizeKline).map((candle) => ({
        ...candle,
        time: candle.openTime,
        open: round(candle.open, 2),
        high: round(candle.high, 2),
        low: round(candle.low, 2),
        close: round(candle.close, 2),
        volume: round(candle.volume, 3),
        closed: candle.closeTime < Date.now(),
      })).slice(-720);
      const candles = aggregateToTenMinuteCandles(raw).slice(-90);
      const latest = candles[candles.length - 1];
      const previous = candles[candles.length - 2];

      mutateState(() => {
        state.market.source = source;
        state.market.baseCandles = baseCandles;
        state.market.candles = candles;
        state.market.currentPrice = latest?.close || state.market.currentPrice;
        state.market.refreshedAt = nowIso();
        state.market.priceChangePct = previous ? round(((latest.close - previous.close) / previous.close) * 100, 3) : 0;
        state.bot.dataSource = source;
        state.bot.lastError = null;
      });
    } catch (error) {
      mutateState(() => {
        state.market.source = state.market.source === "none" ? "Binance disconnected" : state.market.source;
        state.bot.status = state.market.candles.length ? "market-stale" : "market-disconnected";
        state.bot.dataSource = state.market.candles.length ? `${state.market.source} · stale` : "Binance disconnected";
        state.bot.lastError = error.message;
        state.bot.note = state.market.candles.length
          ? `Binance 行情暂时断开，继续保留最后一批真实K线，不生成模拟K线。错误：${error.message}`
          : `Binance 行情暂时断开，未生成任何模拟K线。错误：${error.message}`;
      });
    } finally {
      lastMarketRefresh = Date.now();
      marketRefreshInFlight = null;
    }
  })();

  return marketRefreshInFlight;
}

function sma(values, length) {
  if (values.length < length) return null;
  const slice = values.slice(-length);
  return slice.reduce((sum, value) => sum + value, 0) / length;
}

function rsi(values, length = 7) {
  if (values.length <= length) return 50;
  const slice = values.slice(-(length + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const change = slice[i] - slice[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

function buildSignal(candles) {
  const closed = candles.filter((candle) => candle.closed).slice(-24);
  if (closed.length < 10) {
    return {
      direction: "LONG",
      confidence: 0.52,
      score: 0.1,
      label: "样本不足默认试探",
      reason: "最近可用K线不足，按轻仓基础规则试探多单。",
      rsi: 50,
      volumeRatio: 1,
      momentum3: 0,
      maSpread: 0,
    };
  }

  const closes = closed.map((candle) => candle.close);
  const volumes = closed.map((candle) => candle.volume);
  const last = closed[closed.length - 1];
  const prev = closed[closed.length - 2];
  const shortMa = sma(closes, 3);
  const longMa = sma(closes, 8);
  const momentum3 = (last.close - closed[closed.length - 4].close) / closed[closed.length - 4].close;
  const candleBias = (last.close - last.open) / Math.max(1, last.high - last.low);
  const rsiValue = rsi(closes, 7);
  const volumeRatio = last.volume / Math.max(1, sma(volumes, 8));
  const maSpread = (shortMa - longMa) / longMa;
  const reversalGuard = Math.abs(last.close - last.high) < Math.abs(last.close - last.low) ? 0.08 : -0.08;

  let score = 0;
  score += Math.sign(momentum3) * Math.min(0.38, Math.abs(momentum3) * 120);
  score += Math.sign(maSpread) * Math.min(0.32, Math.abs(maSpread) * 150);
  score += candleBias * 0.22;
  score += (rsiValue - 50) / 140;
  score += volumeRatio > 1.15 ? Math.sign(last.close - prev.close) * 0.12 : 0;
  score += reversalGuard;

  const direction = score >= 0 ? "LONG" : "SHORT";
  const confidence = round(Math.min(0.88, 0.52 + Math.abs(score) * 0.18), 3);
  const label = direction === "LONG" ? "顺势看涨" : "弱势看跌";
  const reason = [
    `短均线${shortMa >= longMa ? "高于" : "低于"}长均线`,
    `3根动量${momentum3 >= 0 ? "向上" : "向下"}${round(momentum3 * 100, 2)}%`,
    `RSI ${round(rsiValue, 1)}`,
    `量能倍率 ${round(volumeRatio, 2)}x`,
  ].join("，");

  return {
    direction,
    confidence,
    score: round(score, 4),
    label,
    reason,
    rsi: round(rsiValue, 1),
    volumeRatio: round(volumeRatio, 2),
    momentum3: round(momentum3, 5),
    maSpread: round(maSpread, 5),
  };
}

function createTradeId() {
  const count = state.trades.length + (state.openTrade ? 1 : 0) + 1;
  return `WS-${String(count).padStart(4, "0")}`;
}

function bucketOf(timeMs) {
  return Math.floor(timeMs / TEN_MINUTES) * TEN_MINUTES;
}

function durationMs(minutes) {
  return Number(minutes || 10) * 60 * 1000;
}

function shouldEvaluateNow(timeMs) {
  if (!state.bot.lastEvaluationAt) return true;
  return timeMs - new Date(state.bot.lastEvaluationAt).getTime() >= EVALUATION_COOLDOWN_MS;
}

function findTradeSettlementCandle(trade) {
  const settlementMs = new Date(trade.settlementTime).getTime();
  const baseCandles = state.market.baseCandles || [];
  const oneMinuteClose = baseCandles.find((candle) => (
    candle.closed &&
    candle.closeTime >= settlementMs
  ));

  if (oneMinuteClose) {
    return {
      ...oneMinuteClose,
      minuteCount: trade.durationMinutes || 10,
    };
  }

  if ((trade.durationMinutes || 10) === 10) {
    return state.market.candles.find((candle) => (
      candle.openTime === trade.entryBucket &&
      candle.closeTime <= Date.now() &&
      candle.minuteCount >= 9
    ));
  }

  return null;
}

function getLastEntryTimeMs(currentTime) {
  if (state.openTrade?.entryTime) return new Date(state.openTrade.entryTime).getTime();
  if (state.trades[0]?.entryTime) return new Date(state.trades[0].entryTime).getTime();
  return currentTime - MAX_WAIT_BETWEEN_TRADES;
}

function evaluateTradeDecision(signal, currentTime) {
  const lastEntryTime = getLastEntryTimeMs(currentTime);
  const waitedMs = currentTime - lastEntryTime;
  const recent = state.trades.slice(0, 2);
  const recentLosses = recent.filter((trade) => trade.result === "LOSS").length;
  const minConfidence = recentLosses ? 0.65 : 0.61;
  const minScore = recentLosses ? 0.42 : 0.3;
  const absScore = Math.abs(signal.score);
  const strongMomentum = Math.abs(signal.momentum3 || 0) >= 0.0009;
  const volumeConfirmed = (signal.volumeRatio || 1) >= 1.05;
  const highConviction = signal.confidence >= 0.66 && absScore >= 0.52;
  const enoughSignal = signal.confidence >= minConfidence && absScore >= minScore;
  const opportunisticSignal = highConviction && (strongMomentum || volumeConfirmed);
  const forcedByWait = waitedMs >= MAX_WAIT_BETWEEN_TRADES && signal.confidence >= 0.54 && absScore >= 0.12;

  if (opportunisticSignal) {
    return {
      shouldOpen: true,
      forceMinStake: false,
      trigger: "盘中强信号",
      reason: `盘中强信号直接开仓：置信度 ${Math.round(signal.confidence * 100)}%，强度 ${absScore.toFixed(2)}，量能 ${Number(signal.volumeRatio || 1).toFixed(2)}x，3根动量 ${round((signal.momentum3 || 0) * 100, 2)}%。`,
    };
  }

  if (enoughSignal) {
    return {
      shouldOpen: true,
      forceMinStake: false,
      trigger: "信号达标",
      reason: `信号达标：置信度 ${Math.round(signal.confidence * 100)}%，强度 ${absScore.toFixed(2)}，不等待下一根10分钟开盘线。`,
    };
  }

  if (forcedByWait) {
    return {
      shouldOpen: true,
      forceMinStake: true,
      trigger: "最长等待试探",
      reason: `已等待 ${Math.round(waitedMs / 60000)} 分钟，触发最长等待规则；信号偏弱但不是随机噪音，只用最低仓位试探。`,
    };
  }

  const waitLeft = Math.max(0, MAX_WAIT_BETWEEN_TRADES - waitedMs);
  return {
    shouldOpen: false,
    forceMinStake: false,
    trigger: "继续扫描",
    reason: `继续扫描：置信度 ${Math.round(signal.confidence * 100)}%，强度 ${absScore.toFixed(2)}，量能 ${Number(signal.volumeRatio || 1).toFixed(2)}x，还没到值得出手的胜率；最长等待还剩约 ${Math.ceil(waitLeft / 60000)} 分钟。`,
  };
}

function calculateStake(signal, decision = {}) {
  const balance = state.account.availableBalanceUsdt;
  const minStake = CONFIG.minStakeUsdt;
  if (decision.forceMinStake) {
    return { stakeUsdt: Math.min(minStake, balance), stakeReason: decision.reason };
  }
  const hardMax = Math.min(CONFIG.maxStakeUsdt, Math.max(minStake, balance * CONFIG.maxStakeBalanceRatio));
  const recent = state.trades.slice(0, 3);
  const recentLosses = recent.filter((trade) => trade.result === "LOSS").length;
  const drawdownRatio = state.account.startingBalanceUsdt
    ? state.account.maxDrawdownUsdt / state.account.startingBalanceUsdt
    : 0;

  let riskScore = 0;
  riskScore += Math.max(0, Math.min(1, (signal.confidence - 0.56) / 0.22)) * 0.55;
  riskScore += Math.max(0, Math.min(1, Math.abs(signal.score) / 1.15)) * 0.45;

  if (signal.confidence < 0.6) riskScore *= 0.25;
  if (recent[0]?.result === "LOSS") riskScore *= 0.65;
  if (recentLosses >= 2) riskScore *= 0.35;
  if (drawdownRatio >= 0.28) riskScore *= 0.45;
  if (balance <= minStake * 2) riskScore = 0;

  const stake = minStake + (hardMax - minStake) * riskScore;
  const roundedStake = round(Math.max(minStake, Math.min(stake, hardMax, balance)), 2);
  const reason = [
    `置信度 ${Math.round(signal.confidence * 100)}%`,
    `信号强度 ${Math.abs(signal.score).toFixed(2)}`,
    recent[0]?.result === "LOSS" ? "上一笔失败，仓位降档" : "无上一笔失败惩罚",
    drawdownRatio >= 0.28 ? "回撤偏高，限制加仓" : "回撤可控",
  ].join("，");

  return { stakeUsdt: roundedStake, stakeReason: reason };
}

function chooseTradeDuration(signal, decision = {}) {
  if (CONFIG.allowedOrderDurations.includes(Number(decision.durationMinutes))) {
    return {
      durationMinutes: Number(decision.durationMinutes),
      durationReason: decision.durationReason || "按指定周期执行。",
    };
  }

  const rsiValue = Number(signal.rsi || 50);
  const absScore = Math.abs(signal.score || 0);
  const continuationSignal = signal.confidence >= 0.66 && absScore >= 0.52 && Number(signal.volumeRatio || 1) >= 1.05;
  const overheatedLong = signal.direction === "LONG" && rsiValue >= 72;
  const oversoldShort = signal.direction === "SHORT" && rsiValue <= 28;

  if (!decision.forceMinStake && continuationSignal && !overheatedLong && !oversoldShort) {
    return {
      durationMinutes: 15,
      durationReason: "趋势、量能和置信度同步，给 15 分钟持仓空间。",
    };
  }

  return {
    durationMinutes: 10,
    durationReason: "信号适合短周期验证，按 10 分钟订单控制反抽风险。",
  };
}

function openTrade(entryPrice, entryTime, signal, mode = "live", decision = {}) {
  if (state.account.availableBalanceUsdt < CONFIG.minStakeUsdt) {
    state.bot.active = false;
    state.bot.status = "paused-low-balance";
    state.bot.note = "余额低于 5 USDT，自动化已暂停。";
    return null;
  }

  const entryBucket = bucketOf(entryTime);
  const { durationMinutes, durationReason } = chooseTradeDuration(signal, decision);
  const settlementTime = entryTime + durationMs(durationMinutes);
  const { stakeUsdt, stakeReason } = calculateStake(signal, decision);
  const trade = {
    id: createTradeId(),
    mode,
    symbol: state.market.symbol,
    timeframe: `${durationMinutes}m`,
    durationMinutes,
    status: "OPEN",
    direction: signal.direction,
    stakeUsdt,
    payoutRate: CONFIG.payoutRate,
    entryPrice: round(entryPrice, 2),
    entryTime: new Date(entryTime).toISOString(),
    entryBucket,
    settlementTime: new Date(settlementTime).toISOString(),
    exitPrice: null,
    exitTime: null,
    result: "PENDING",
    pnlUsdt: 0,
    pnlRmb: 0,
    priceMovePct: 0,
    confidence: signal.confidence,
    score: signal.score,
    signalLabel: signal.label,
    stakeReason,
    durationReason,
    trigger: decision.trigger || "信号达标",
    decisionReason: decision.reason || "信号通过，执行模拟下单。",
    preTradeNote: `AI ${signal.label}：${signal.reason}。${decision.reason || ""} 本笔为 ${durationMinutes} 分钟模拟事件订单，投入 ${stakeUsdt.toFixed(2)} USDT：${stakeReason}。周期选择：${durationReason}`,
    summary: `等待 ${durationMinutes} 分钟订单结算。`,
    balanceAfterUsdt: null,
    createdAt: nowIso(),
  };

  state.account.availableBalanceUsdt = round(state.account.availableBalanceUsdt - stakeUsdt, 4);
  state.openTrade = trade;
  state.bot.status = mode === "live" ? "position-open" : "backfilling";
  state.bot.lastDecisionAt = trade.entryTime;
  state.bot.lastEvaluationAt = trade.entryTime;
  state.bot.lastEvaluatedBucket = entryBucket;
  state.bot.nextDecisionTime = trade.settlementTime;
  state.bot.nextSettlementTime = trade.settlementTime;
  state.bot.note = trade.preTradeNote;
  recalculateAccountExposure();

  return trade;
}

function settleTrade(exitPrice, exitTime) {
  const trade = state.openTrade;
  if (!trade) return null;

  const isLong = trade.direction === "LONG";
  const priceMove = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
  const won = isLong ? exitPrice > trade.entryPrice : exitPrice < trade.entryPrice;
  const flat = exitPrice === trade.entryPrice;
  const pnlUsdt = flat ? 0 : won ? round(trade.stakeUsdt * trade.payoutRate, 4) : -trade.stakeUsdt;
  const returnedUsdt = flat ? trade.stakeUsdt : won ? trade.stakeUsdt + pnlUsdt : 0;

  trade.status = "SETTLED";
  trade.exitPrice = round(exitPrice, 2);
  trade.exitTime = new Date(exitTime).toISOString();
  trade.result = flat ? "FLAT" : won ? "WIN" : "LOSS";
  trade.pnlUsdt = round(pnlUsdt, 4);
  trade.pnlRmb = round(pnlUsdt * state.account.rmbPerUsdt, 2);
  trade.priceMovePct = round(priceMove, 3);
  trade.summary = buildTradeSummary(trade);

  state.account.availableBalanceUsdt = round(state.account.availableBalanceUsdt + returnedUsdt, 4);
  state.account.realizedPnlUsdt = round(state.account.realizedPnlUsdt + pnlUsdt, 4);
  state.account.realizedPnlRmb = round(state.account.realizedPnlUsdt * state.account.rmbPerUsdt, 2);
  state.openTrade = null;
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 120);
  state.bot.status = "waiting-next-cycle";
  state.bot.note = trade.summary;
  state.insights.unshift({
    time: trade.exitTime,
    type: trade.result,
    title: trade.result === "WIN" ? "成功复盘" : trade.result === "LOSS" ? "失败复盘" : "持平复盘",
    body: trade.summary,
  });
  state.insights = state.insights.slice(0, 20);
  recalculateAccountExposure();

  return trade;
}

function buildTradeSummary(trade) {
  const directionText = trade.direction === "LONG" ? "买涨" : "买跌";
  const durationText = `${trade.durationMinutes || 10}分钟`;
  const moveText = `价格从 ${formatPrice(trade.entryPrice)} 到 ${formatPrice(trade.exitPrice)}，波动 ${trade.priceMovePct}%`;

  if (trade.result === "WIN") {
    return `${durationText}${directionText}成功：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}。入场信号和订单到期方向一致，净收益 ${trade.pnlUsdt.toFixed(2)} USDT。下一轮继续按风险模型评估，不因连胜盲目放大。`;
  }

  if (trade.result === "LOSS") {
    const diagnosis = Math.abs(trade.priceMovePct) < 0.06
      ? "失败主要来自窄幅震荡，方向判断没有足够空间兑现"
      : "失败主要来自入场后反向突破，短周期信号被反抽打穿";
    return `${durationText}${directionText}失败：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}。${diagnosis}，亏损 ${Math.abs(trade.pnlUsdt).toFixed(2)} USDT。下一轮仓位降档，降低对单一动量信号的权重，优先看量能和均线是否同步。`;
  }

  return `${durationText}${directionText}持平：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}。本轮退回本金，信号没有形成有效价格差，下一轮继续扫描更清晰的盘中结构。`;
}

function recalculateAccountExposure() {
  const openExposure = state.openTrade ? state.openTrade.stakeUsdt : 0;
  state.account.openExposureUsdt = round(openExposure, 4);
  state.account.equityUsdt = round(state.account.availableBalanceUsdt + openExposure, 4);
  state.account.highWaterUsdt = Math.max(state.account.highWaterUsdt || state.account.equityUsdt, state.account.equityUsdt);
  state.account.maxDrawdownUsdt = round(Math.max(state.account.maxDrawdownUsdt || 0, state.account.highWaterUsdt - state.account.equityUsdt), 4);
}

function recalculateStats() {
  const settled = state.trades.filter((trade) => trade.status === "SETTLED");
  const wins = settled.filter((trade) => trade.result === "WIN").length;
  const losses = settled.filter((trade) => trade.result === "LOSS").length;
  const flats = settled.filter((trade) => trade.result === "FLAT").length;
  const grossProfit = settled.filter((trade) => trade.pnlUsdt > 0).reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  const grossLoss = Math.abs(settled.filter((trade) => trade.pnlUsdt < 0).reduce((sum, trade) => sum + trade.pnlUsdt, 0));

  let streakResult = null;
  let streakCount = 0;
  for (const trade of settled) {
    if (!streakResult) streakResult = trade.result;
    if (trade.result !== streakResult) break;
    streakCount += 1;
  }

  recalculateAccountExposure();
  state.stats = {
    totalTrades: settled.length + (state.openTrade ? 1 : 0),
    settledTrades: settled.length,
    wins,
    losses,
    flats,
    winRate: settled.length ? round((wins / settled.length) * 100, 1) : 0,
    currentStreak: streakCount ? `${streakResult} x${streakCount}` : "0",
    profitFactor: grossLoss ? round(grossProfit / grossLoss, 2) : grossProfit > 0 ? 99 : 0,
  };
}

async function bootstrapHistoricalTrades() {
  if (state.trades.length > 0 || state.openTrade) return;

  await refreshMarket(true);
  const closed = state.market.candles.filter((candle) => candle.closed);
  if (closed.length < 16) return;

  const startIndex = Math.max(10, closed.length - CONFIG.maxBootstrapTrades - 1);
  mutateState(() => {
    for (let i = startIndex; i < closed.length - 1; i += 1) {
      if (state.account.availableBalanceUsdt < CONFIG.minStakeUsdt) break;
      const history = closed.slice(0, i);
      const candle = closed[i];
      const signal = buildSignal(history);
      const decision = evaluateTradeDecision(signal, candle.openTime);
      state.bot.lastEvaluatedBucket = candle.openTime;
      if (decision.shouldOpen) {
        openTrade(candle.open, candle.openTime, signal, "historical", {
          ...decision,
          durationMinutes: 10,
          durationReason: "历史回放按 10 分钟K线结算。",
        });
        settleTrade(candle.close, candle.closeTime);
      }
    }
    state.bot.status = "waiting-live-cycle";
    state.bot.note = "历史K线按策略回放完成，等待实时信号。";
  });
}

async function botTick() {
  try {
    await refreshMarket();
    const now = Date.now();
    const latest = state.market.candles[state.market.candles.length - 1];
    if (!latest?.close) return;

    mutateState(() => {
      const currentBucket = bucketOf(now);

      if (state.openTrade && now >= new Date(state.openTrade.settlementTime).getTime()) {
        const settlementCandle = findTradeSettlementCandle(state.openTrade);
        if (settlementCandle) {
          settleTrade(settlementCandle.close, settlementCandle.closeTime);
        } else {
          state.bot.status = "waiting-binance-close";
          state.bot.note = "等待 Binance 返回订单到期后的真实1分钟收盘价。";
          return;
        }
      }

      if (!state.bot.active) {
        state.bot.status = state.account.availableBalanceUsdt < CONFIG.minStakeUsdt ? "paused-low-balance" : "paused";
        state.bot.note = state.bot.status === "paused-low-balance"
          ? "余额低于 5 USDT，自动化暂停；重置模拟账户后会继续扫描 10/15 分钟事件订单。"
          : "自动化已暂停；恢复后会继续扫描 Binance 永续1分钟波动。";
        return;
      }

      const canEvaluate = shouldEvaluateNow(now);
      if (!state.openTrade && canEvaluate && state.account.availableBalanceUsdt >= CONFIG.minStakeUsdt) {
        const signalCandles = state.market.baseCandles?.length ? state.market.baseCandles : state.market.candles;
        const signal = buildSignal(signalCandles);
        const decision = evaluateTradeDecision(signal, now);
        state.bot.lastEvaluationAt = new Date(now).toISOString();
        state.bot.lastEvaluatedBucket = currentBucket;
        state.bot.lastDecisionAt = new Date(now).toISOString();
        if (decision.shouldOpen) {
          openTrade(latest.close, now, signal, "live", decision);
        } else {
          state.bot.status = "signal-skipped";
          state.bot.note = `${decision.reason} 约 ${Math.round(EVALUATION_COOLDOWN_MS / 1000)} 秒后继续扫描 Binance 永续1分钟波动。`;
        }
      }

      if (!state.openTrade) {
        state.bot.nextDecisionTime = new Date(now + EVALUATION_COOLDOWN_MS).toISOString();
        state.bot.nextSettlementTime = null;
        if (state.bot.status !== "signal-skipped") {
          state.bot.status = "scanning-live-signal";
          state.bot.note = "正在扫描 Binance 永续1分钟波动；高质量信号会直接下 10/15 分钟模拟事件订单，不再死等10分钟开盘线。";
        }
      }
    });
  } catch (error) {
    mutateState(() => {
      state.bot.lastError = error.message;
      state.bot.status = "error";
      state.bot.note = `自动化循环异常：${error.message}`;
    });
  }
}

async function manualAdvance() {
  await refreshMarket(true);
  const latest = state.market.candles[state.market.candles.length - 1];
  if (!latest?.close) return;

  mutateState(() => {
    const now = Date.now();
    const currentBucket = bucketOf(now);
    if (state.openTrade && now >= new Date(state.openTrade.settlementTime).getTime()) {
      const settlementCandle = findTradeSettlementCandle(state.openTrade);
      if (settlementCandle) {
        settleTrade(settlementCandle.close, settlementCandle.closeTime);
      }
    }
    if (state.bot.active && !state.openTrade && state.account.availableBalanceUsdt >= CONFIG.minStakeUsdt) {
      const signalCandles = state.market.baseCandles?.length ? state.market.baseCandles : state.market.candles;
      const signal = buildSignal(signalCandles);
      const decision = evaluateTradeDecision(signal, now);
      state.bot.lastEvaluationAt = new Date(now).toISOString();
      state.bot.lastEvaluatedBucket = currentBucket;
      state.bot.lastDecisionAt = new Date(now).toISOString();
      if (decision.shouldOpen) {
        openTrade(latest.close, now, signal, "manual-refresh", decision);
      } else {
        state.bot.status = "signal-skipped";
        state.bot.note = `${decision.reason} 已刷新 Binance 永续行情，暂不下单。`;
      }
    } else if (!state.openTrade && !state.bot.active) {
      state.bot.nextDecisionTime = null;
      state.bot.status = state.account.availableBalanceUsdt < CONFIG.minStakeUsdt ? "paused-low-balance" : "paused";
      state.bot.note = state.bot.status === "paused-low-balance"
        ? "余额低于 5 USDT，自动化暂停；重置模拟账户后会继续扫描 10/15 分钟事件订单。"
        : "自动化已暂停；恢复后会继续扫描 Binance 永续1分钟波动。";
    } else if (!state.openTrade) {
      state.bot.nextDecisionTime = new Date(now + EVALUATION_COOLDOWN_MS).toISOString();
      state.bot.status = "scanning-live-signal";
      state.bot.note = "已刷新 Binance 永续实盘行情；继续扫描盘中信号。";
    }
  });
}

async function resetSimulation() {
  state = createInitialState();
  await bootstrapHistoricalTrades();
  await botTick();
  scheduleSave();
  broadcast();
}

function sendJson(res, payload, statusCode = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/state" && req.method === "GET") {
      sendJson(res, publicState());
      return;
    }

    if (url.pathname === "/api/stream" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(publicState())}\n\n`);
      subscribers.add(res);
      req.on("close", () => subscribers.delete(res));
      return;
    }

    if (url.pathname === "/api/control" && req.method === "POST") {
      const body = await readBody(req);
      mutateState(() => {
        state.bot.active = Boolean(body.active);
        state.bot.status = state.bot.active ? "waiting-live-cycle" : "paused";
        state.bot.note = state.bot.active ? "自动化已恢复。" : "自动化已暂停。";
      });
      sendJson(res, publicState());
      return;
    }

    if (url.pathname === "/api/advance" && req.method === "POST") {
      await manualAdvance();
      sendJson(res, publicState());
      return;
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      await resetSimulation();
      sendJson(res, publicState());
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

async function start() {
  await loadState();
  await bootstrapHistoricalTrades();
  await botTick();
  server.listen(PORT, () => {
    console.log(`${CONFIG.appName} running at http://localhost:${PORT}`);
  });
  setInterval(botTick, 15 * 1000);
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
