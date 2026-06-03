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
const EVALUATION_COOLDOWN_MS = 60 * 1000;
const MARKET_REFRESH_MS = 30 * 1000;
const HISTORICAL_KLINE_CACHE_MS = 10 * 60 * 1000;
const FUTURES_HISTORY_START_MS = Date.UTC(2019, 8, 1);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_PATH = process.env.STATE_PATH || path.join(DATA_DIR, "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "") || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const SUPABASE_STATE_TABLE = process.env.SUPABASE_STATE_TABLE || "weisu_bot_state";
const SUPABASE_STATE_ID = process.env.SUPABASE_STATE_ID || "paper-live-btcusdt";
const SUPABASE_TIMEOUT_MS = 8000;

const CONFIG = {
  appName: "魏夙的 AI 实盘",
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: "10m/15m",
  allowedOrderDurations: [10, 15],
  startingRmb: 200,
  rmbPerUsdt: Number(process.env.RMB_PER_USDT || 7.2),
  minStakeUsdt: 5,
  maxStakeUsdt: Number(process.env.MAX_STAKE_USDT || 6.5),
  maxStakeBalanceRatio: 0.32,
  payoutRate: 0.82,
  maxBootstrapTrades: 4,
  maxTradeHistory: Number(process.env.MAX_TRADE_HISTORY || 100),
};

const DEFAULT_BINANCE_FAPI_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://fapi4.binance.com",
];
const REGION_BLOCK_HINT = "HTTP 451: Binance refused futures market-data access from this deployment region/IP. Move the service to a non-restricted region or configure a trusted USD-M futures market-data proxy.";
const SUPABASE_TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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
const historicalKlineCache = new Map();
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
      manualResetAt: null,
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
    userOpenTrade: null,
    trades: [],
    nextTradeSequence: 1,
    insights: [],
    userHabits: createInitialUserHabits(),
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

function createInitialUserHabits() {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    winRate: 0,
    longTrades: 0,
    shortTrades: 0,
    avgStakeUsdt: 0,
    preferredDuration: "--",
    lastLesson: "还没有魏夙手动单样本。",
    patterns: [],
  };
}

async function loadState() {
  if (hasSupabaseStateStorage()) {
    try {
      const loaded = await loadStateFromSupabase();
      if (loaded) {
        state = mergeLoadedState(loaded);
        console.log(`Loaded state from Supabase table ${SUPABASE_STATE_TABLE}/${SUPABASE_STATE_ID}`);
        return;
      }
    } catch (error) {
      console.warn("Failed to load state from Supabase, falling back to local state:", error.message);
    }
  }

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

function hasSupabaseStateStorage() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_TABLE_NAME_RE.test(SUPABASE_STATE_TABLE));
}

function buildSupabaseRestUrl(params = "") {
  const suffix = params ? `?${params}` : "";
  return `${SUPABASE_URL}/rest/v1/${SUPABASE_STATE_TABLE}${suffix}`;
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function fetchSupabase(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadStateFromSupabase() {
  const params = new URLSearchParams({
    id: `eq.${SUPABASE_STATE_ID}`,
    select: "state",
    limit: "1",
  });
  const rows = await fetchSupabase(buildSupabaseRestUrl(params.toString()), {
    headers: supabaseHeaders({ accept: "application/json" }),
  });
  return Array.isArray(rows) && rows[0]?.state ? rows[0].state : null;
}

async function saveStateToSupabase(snapshot) {
  const params = new URLSearchParams({ on_conflict: "id" });
  await fetchSupabase(buildSupabaseRestUrl(params.toString()), {
    method: "POST",
    headers: supabaseHeaders({
      prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify({
      id: SUPABASE_STATE_ID,
      state: snapshot,
      updated_at: nowIso(),
    }),
  });
}

function mergeLoadedState(loaded) {
  const fresh = createInitialState();
  const trades = normalizeTradeHistory(loaded.trades);
  let openTrade = loaded.openTrade ? normalizeTradeShape(loaded.openTrade) : null;
  let userOpenTrade = loaded.userOpenTrade ? normalizeTradeShape(loaded.userOpenTrade) : null;
  if (openTrade?.mode === "user-manual" && !userOpenTrade) {
    userOpenTrade = openTrade;
    openTrade = null;
  }
  const maxSequence = getMaxTradeSequence([...trades, openTrade, userOpenTrade].filter(Boolean));
  return {
    ...fresh,
    ...loaded,
    mode: fresh.mode,
    config: { ...fresh.config, ...loaded.config, ...CONFIG },
    bot: { ...fresh.bot, ...loaded.bot },
    market: { ...fresh.market, ...loaded.market, symbol: CONFIG.symbol },
    account: { ...fresh.account, ...loaded.account },
    openTrade,
    userOpenTrade,
    trades,
    nextTradeSequence: Math.max(
      Number(loaded.nextTradeSequence || 1),
      maxSequence + 1,
      1,
    ),
    insights: Array.isArray(loaded.insights) ? loaded.insights : [],
    userHabits: normalizeUserHabits(loaded.userHabits),
  };
}

function normalizeUserHabits(userHabits = {}) {
  const fresh = createInitialUserHabits();
  return {
    ...fresh,
    ...userHabits,
    patterns: Array.isArray(userHabits.patterns) ? userHabits.patterns.slice(0, 20) : [],
  };
}

function normalizeTradeHistory(trades) {
  return Array.isArray(trades)
    ? trades.map(normalizeTradeShape).slice(0, CONFIG.maxTradeHistory)
    : [];
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
    sequence: getTradeSequence(trade),
    durationMinutes,
    timeframe: `${durationMinutes}m`,
    entryBucket: Number.isFinite(trade.entryBucket) ? trade.entryBucket : bucketOf(entryMs),
    settlementTime: new Date(settlementMs).toISOString(),
  };
}

function getTradeSequence(trade) {
  const numeric = Number(trade?.sequence);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsedId = String(trade?.id || "").match(/(\d+)$/);
  return parsedId ? Number(parsedId[1]) : 0;
}

function getMaxTradeSequence(trades) {
  return trades.reduce((max, trade) => Math.max(max, getTradeSequence(trade)), 0);
}

function hasDurableHistory() {
  const nonBootstrapTrades = state.trades.some((trade) => trade.mode !== "historical");
  const nonBootstrapOpenTrade = Boolean(state.openTrade && state.openTrade.mode !== "historical");
  const nonBootstrapUserOpenTrade = Boolean(state.userOpenTrade && state.userOpenTrade.mode !== "historical");
  return nonBootstrapTrades || nonBootstrapOpenTrade || nonBootstrapUserOpenTrade;
}

function coerceFiniteNumber(value, fallback, min = -Infinity, max = Infinity) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function restoreClientSnapshot(snapshot = {}) {
  const backupTrades = normalizeTradeHistory(snapshot.trades);
  const backupOpenTrade = snapshot.openTrade ? normalizeTradeShape(snapshot.openTrade) : null;
  const backupUserOpenTrade = snapshot.userOpenTrade ? normalizeTradeShape(snapshot.userOpenTrade) : null;
  if (!backupTrades.length && !backupOpenTrade && !backupUserOpenTrade) {
    return { restored: false, reason: "empty-client-backup" };
  }
  const serverResetAt = state.bot?.manualResetAt || null;
  const resetLocked = Boolean(serverResetAt || state.bot?.status === "paused-after-reset");
  const backupResetAt = snapshot.serverResetAt || null;
  if (resetLocked && (!serverResetAt || backupResetAt !== serverResetAt)) {
    return { restored: false, reason: "stale-client-backup-after-reset" };
  }
  if (hasDurableHistory()) {
    return { restored: false, reason: "server-already-has-history" };
  }

  const fresh = createInitialState();
  const account = snapshot.account || {};
  const restoredAccount = {
    ...fresh.account,
    availableBalanceUsdt: coerceFiniteNumber(account.availableBalanceUsdt, fresh.account.availableBalanceUsdt, 0, 100000),
    equityUsdt: coerceFiniteNumber(account.equityUsdt, fresh.account.equityUsdt, 0, 100000),
    realizedPnlUsdt: coerceFiniteNumber(account.realizedPnlUsdt, 0, -100000, 100000),
    realizedPnlRmb: coerceFiniteNumber(account.realizedPnlRmb, 0, -1000000, 1000000),
    highWaterUsdt: coerceFiniteNumber(account.highWaterUsdt, fresh.account.highWaterUsdt, 0, 100000),
    maxDrawdownUsdt: coerceFiniteNumber(account.maxDrawdownUsdt, 0, 0, 100000),
    openExposureUsdt: coerceFiniteNumber(account.openExposureUsdt, 0, 0, 100000),
  };

  state = {
    ...fresh,
    account: restoredAccount,
    openTrade: backupOpenTrade,
    userOpenTrade: backupUserOpenTrade,
    trades: backupTrades,
    nextTradeSequence: getMaxTradeSequence([...backupTrades, backupOpenTrade, backupUserOpenTrade].filter(Boolean)) + 1,
    insights: Array.isArray(snapshot.insights) ? snapshot.insights.slice(0, 20) : [],
    userHabits: normalizeUserHabits(snapshot.userHabits),
  };
  state.bot.status = "client-history-restored";
  state.bot.note = `已从浏览器本地备份恢复最近 ${backupTrades.length} 笔历史订单；后端继续扫描 Binance 永续1分钟行情。`;
  recalculateStats();
  scheduleSave();
  broadcast();
  return { restored: true, count: backupTrades.length };
}

function scheduleSave() {
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(async () => {
    await saveState(state);
  }, 250);
}

async function saveState(snapshot) {
  let supabaseSaved = false;
  if (hasSupabaseStateStorage()) {
    try {
      await saveStateToSupabase(snapshot);
      supabaseSaved = true;
    } catch (error) {
      console.warn("Failed to save state to Supabase, writing local fallback:", error.message);
    }
  }

  try {
    await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fsp.writeFile(STATE_PATH, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    if (!supabaseSaved) console.warn("Failed to save state:", error.message);
  }
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
  const nextSettlementTime = getNearestSettlementTime() || state.bot.nextSettlementTime || state.bot.nextDecisionTime;
  return {
    ...state,
    storage: {
      provider: hasSupabaseStateStorage() ? "supabase" : "local-file",
      stateId: hasSupabaseStateStorage() ? SUPABASE_STATE_ID : null,
    },
    serverTime: nowIso(),
    countdownMs: nextSettlementTime ? Math.max(0, new Date(nextSettlementTime).getTime() - now) : 0,
  };
}

function getOpenTrades() {
  return [state.openTrade, state.userOpenTrade].filter(Boolean);
}

function getNearestSettlementTime() {
  const times = getOpenTrades()
    .map((trade) => trade.settlementTime)
    .filter(Boolean)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return times[0] || null;
}

const BINANCE_NATIVE_INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"]);
const FULL_HISTORY_INTERVALS = new Set(["1d", "1w", "1M"]);

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
  throw new Error(summarizeKlineFetchErrors(errors, "1m"));
}

async function fetchHistoricalKlines(interval) {
  if (!BINANCE_NATIVE_INTERVALS.has(interval) && interval !== "10m") {
    throw new Error(`Unsupported kline interval: ${interval}`);
  }

  if (interval === "10m") {
    const history = await fetchHistoricalKlines("1m");
    return {
      ...history,
      interval: "10m",
      source: `${history.source} · aggregated 10m`,
      candles: aggregateKlinesFromCandles(history.candles, TEN_MINUTES).slice(-720),
    };
  }

  const cacheKey = `${CONFIG.symbol}:${interval}`;
  const cached = historicalKlineCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < HISTORICAL_KLINE_CACHE_MS) {
    return cached.payload;
  }

  const fullHistory = FULL_HISTORY_INTERVALS.has(interval);
  const limit = fullHistory ? 1500 : 1500;
  const startTime = fullHistory ? FUTURES_HISTORY_START_MS : null;
  const payload = await fetchBinanceKlinePages({ interval, limit, startTime });
  historicalKlineCache.set(cacheKey, { cachedAt: Date.now(), payload });
  return payload;
}

async function fetchBinanceKlinePages({ interval, limit = 1500, startTime = null }) {
  const symbol = state.market.symbol || CONFIG.symbol;
  const bases = getBinanceFapiBases();
  const errors = [];

  for (const base of bases) {
    try {
      const host = new URL(base).host;
      const raw = [];
      let nextStart = startTime;
      const maxLoops = startTime ? 16 : 1;

      for (let loop = 0; loop < maxLoops; loop += 1) {
        const endpointUrl = new URL("/fapi/v1/klines", base);
        endpointUrl.searchParams.set("symbol", symbol);
        endpointUrl.searchParams.set("interval", interval);
        endpointUrl.searchParams.set("limit", String(limit));
        if (nextStart) endpointUrl.searchParams.set("startTime", String(nextStart));

        const page = await fetchJson(endpointUrl.toString());
        if (!Array.isArray(page) || page.length === 0) break;
        raw.push(...page);
        if (!startTime || page.length < limit) break;

        const lastOpenTime = Number(page[page.length - 1][0]);
        const next = lastOpenTime + 1;
        if (next <= nextStart || lastOpenTime >= Date.now()) break;
        nextStart = next;
      }

      const candles = normalizeHistoricalKlines(raw);
      return {
        symbol,
        interval,
        source: `Binance USD-M Futures ${interval} (${host})`,
        candles,
        earliest: candles[0]?.openTime || null,
        latest: candles[candles.length - 1]?.openTime || null,
      };
    } catch (error) {
      errors.push({ host: safeHost(base), source: `Binance USD-M Futures ${interval}`, message: error.message });
    }
  }

  throw new Error(summarizeKlineFetchErrors(errors, interval));
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
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

function summarizeKlineFetchErrors(errors, interval = "1m") {
  if (!errors.length) return "Unable to fetch Binance USD-M futures market data";
  const hosts = errors.map((error) => error.host).join(", ");
  const lastMessage = errors[errors.length - 1].message;
  const regionBlock = errors.find((error) => /\b451\b/.test(error.message));
  if (regionBlock) {
    return `Binance USD-M Futures ${interval} failed for ${hosts}. ${REGION_BLOCK_HINT} Blocked endpoint: ${regionBlock.host}. Error: ${regionBlock.message}`;
  }
  return `Binance USD-M Futures ${interval} failed for ${hosts}. Last error: ${lastMessage}`;
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

function normalizeHistoricalKlines(rawKlines) {
  const deduped = new Map();
  for (const raw of rawKlines) {
    const candle = normalizeKline(raw);
    deduped.set(candle.openTime, {
      ...candle,
      time: candle.openTime,
      open: round(candle.open, 2),
      high: round(candle.high, 2),
      low: round(candle.low, 2),
      close: round(candle.close, 2),
      volume: round(candle.volume, 3),
      closed: candle.closeTime < Date.now(),
    });
  }
  return Array.from(deduped.values()).sort((a, b) => a.openTime - b.openTime);
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

function aggregateKlinesFromCandles(candles, intervalMs = TEN_MINUTES) {
  const buckets = new Map();

  for (const item of candles) {
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
        const keepResetPause = !state.bot.active && state.bot.manualResetAt && !state.trades.length && !state.openTrade && !state.userOpenTrade;
        state.market.source = state.market.source === "none" ? "Binance disconnected" : state.market.source;
        if (keepResetPause) {
          state.bot.dataSource = state.market.candles.length ? `${state.market.source} 路 stale` : "Binance disconnected";
          state.bot.lastError = error.message;
          return;
        }
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
  const sequence = Math.max(1, Math.floor(Number(state.nextTradeSequence || 1)));
  state.nextTradeSequence = sequence + 1;
  return {
    id: `WS-${String(sequence).padStart(4, "0")}`,
    sequence,
  };
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

function latestTradablePrice() {
  const latestBase = state.market.baseCandles?.[state.market.baseCandles.length - 1];
  const latestTenMinute = state.market.candles?.[state.market.candles.length - 1];
  return Number(latestBase?.close || latestTenMinute?.close || state.market.currentPrice || 0);
}

function getLastEntryTimeMs(currentTime) {
  if (state.openTrade?.entryTime) return new Date(state.openTrade.entryTime).getTime();
  const latestAiTrade = state.trades.find((trade) => trade.mode !== "user-manual");
  if (latestAiTrade?.entryTime) return new Date(latestAiTrade.entryTime).getTime();
  return null;
}

function evaluateTradeDecision(signal, currentTime) {
  const lastEntryTime = getLastEntryTimeMs(currentTime);
  const waitedMinutes = lastEntryTime ? Math.max(0, Math.round((currentTime - lastEntryTime) / 60000)) : 0;
  const recent = state.trades.slice(0, 2);
  const recentLosses = recent.filter((trade) => trade.result === "LOSS").length;
  const minConfidence = recentLosses ? 0.68 : 0.64;
  const minScore = recentLosses ? 0.55 : 0.45;
  const absScore = Math.abs(signal.score);
  const strongMomentum = Math.abs(signal.momentum3 || 0) >= 0.0009;
  const volumeConfirmed = (signal.volumeRatio || 1) >= 1.05;
  const highConviction = signal.confidence >= 0.68 && absScore >= 0.58;
  const enoughSignal = signal.confidence >= minConfidence && absScore >= minScore;
  const breakoutReady = strongMomentum && volumeConfirmed;
  const exceptionalScore = absScore >= 0.95;
  const standardConfirmed = enoughSignal && (strongMomentum || volumeConfirmed);
  const opportunisticSignal = highConviction && (breakoutReady || exceptionalScore);

  if (opportunisticSignal) {
    return {
      shouldOpen: true,
      forceMinStake: false,
      trigger: "盘中强信号",
      reason: `盘中强信号直接开仓：置信度 ${Math.round(signal.confidence * 100)}%，强度 ${absScore.toFixed(2)}，量能 ${Number(signal.volumeRatio || 1).toFixed(2)}x，3根动量 ${round((signal.momentum3 || 0) * 100, 2)}%。`,
    };
  }

  if (standardConfirmed) {
    return {
      shouldOpen: true,
      forceMinStake: false,
      trigger: "信号达标",
      reason: `信号达标：置信度 ${Math.round(signal.confidence * 100)}%，强度 ${absScore.toFixed(2)}，不等待下一根10分钟开盘线。`,
    };
  }

  if (enoughSignal) {
    return {
      shouldOpen: false,
      forceMinStake: false,
      trigger: "影子观察",
      reason: `信号有方向但确认不足：置信度 ${Math.round(signal.confidence * 100)}%，强度 ${absScore.toFixed(2)}，量能 ${Number(signal.volumeRatio || 1).toFixed(2)}x，3根动量 ${round((signal.momentum3 || 0) * 100, 2)}%。先记录为影子样本，不因等待时间强行下单。`,
    };
  }

  return {
    shouldOpen: false,
    forceMinStake: false,
    trigger: "继续扫描",
    reason: `继续扫描：置信度 ${Math.round(signal.confidence * 100)}%，强度 ${absScore.toFixed(2)}，量能 ${Number(signal.volumeRatio || 1).toFixed(2)}x，事件合约胜率边际不足；${waitedMinutes ? `距离上次进场约 ${waitedMinutes} 分钟，` : ""}不因等待时间强行下单。`,
  };
}

function calculateStake(signal, decision = {}) {
  const balance = state.account.availableBalanceUsdt;
  const minStake = CONFIG.minStakeUsdt;
  if (Number.isFinite(Number(decision.stakeUsdt))) {
    const requestedStake = round(Number(decision.stakeUsdt), 2);
    return {
      stakeUsdt: round(Math.max(minStake, Math.min(requestedStake, balance)), 2),
      stakeReason: decision.stakeReason || `魏夙手动选择投入 ${requestedStake.toFixed(2)} USDT。`,
    };
  }
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
  if ((signal.volumeRatio || 1) < 1.05) riskScore *= 0.55;
  if (Math.abs(signal.score || 0) < 0.9) riskScore *= 0.82;
  if (signal.confidence < 0.68) riskScore *= 0.7;
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
  const identity = createTradeId();
  const isUserManual = mode === "user-manual";
  const trade = {
    id: identity.id,
    sequence: identity.sequence,
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
    signalReason: signal.reason,
    actor: decision.actor || (isUserManual ? "魏夙手动" : "AI"),
    userManual: isUserManual,
    aiSignalDirection: decision.aiSignalDirection || null,
    aiSignalConfidence: decision.aiSignalConfidence || null,
    aiSignalReason: decision.aiSignalReason || null,
    rsi: signal.rsi,
    volumeRatio: signal.volumeRatio,
    momentum3: signal.momentum3,
    maSpread: signal.maSpread,
    stakeReason,
    durationReason,
    trigger: decision.trigger || "信号达标",
    decisionReason: decision.reason || "信号通过，执行模拟下单。",
    preTradeNote: isUserManual
      ? `魏夙手动${signal.direction === "LONG" ? "买涨" : "买跌"}：${signal.reason} 本笔为 ${durationMinutes} 分钟模拟事件订单，投入 ${stakeUsdt.toFixed(2)} USDT：${stakeReason}。周期选择：${durationReason}`
      : `AI ${signal.label}：${signal.reason}。${decision.reason || ""} 本笔为 ${durationMinutes} 分钟模拟事件订单，投入 ${stakeUsdt.toFixed(2)} USDT：${stakeReason}。周期选择：${durationReason}`,
    summary: `等待 ${durationMinutes} 分钟订单结算。`,
    balanceAfterUsdt: null,
    createdAt: nowIso(),
  };

  state.account.availableBalanceUsdt = round(state.account.availableBalanceUsdt - stakeUsdt, 4);
  if (isUserManual) {
    state.userOpenTrade = trade;
  } else {
    state.openTrade = trade;
    state.bot.status = mode === "live" ? "position-open" : "backfilling";
    state.bot.lastDecisionAt = trade.entryTime;
    state.bot.lastEvaluationAt = trade.entryTime;
    state.bot.lastEvaluatedBucket = entryBucket;
    state.bot.nextDecisionTime = trade.settlementTime;
    state.bot.nextSettlementTime = trade.settlementTime;
    state.bot.note = trade.preTradeNote;
  }
  recalculateAccountExposure();

  return trade;
}

function buildUserManualSignal(direction, aiSignal) {
  const aligned = aiSignal.direction === direction;
  const magnitude = Math.max(0.18, Math.abs(Number(aiSignal.score || 0)));
  return {
    ...aiSignal,
    direction,
    confidence: aligned ? aiSignal.confidence : round(Math.max(0.35, 1 - Number(aiSignal.confidence || 0.52)), 3),
    score: round(direction === "LONG" ? magnitude : -magnitude, 4),
    label: direction === "LONG" ? "魏夙手动买涨" : "魏夙手动买跌",
    reason: `魏夙手动选择${direction === "LONG" ? "买涨" : "买跌"}；AI 当时参考方向为${aiSignal.direction === "LONG" ? "买涨" : "买跌"}，原始理由：${aiSignal.reason}`,
  };
}

async function openUserManualTrade(body = {}) {
  const direction = String(body.direction || "").toUpperCase();
  if (!["LONG", "SHORT"].includes(direction)) {
    throw new Error("手动下单方向必须是买涨或买跌。");
  }

  const durationMinutes = Number(body.durationMinutes || 10);
  if (!CONFIG.allowedOrderDurations.includes(durationMinutes)) {
    throw new Error("手动订单周期只能选择 10m 或 15m。");
  }

  const stakeUsdt = round(Number(body.stakeUsdt || CONFIG.minStakeUsdt), 2);
  if (!Number.isFinite(stakeUsdt) || stakeUsdt < CONFIG.minStakeUsdt) {
    throw new Error(`手动下单最低 ${CONFIG.minStakeUsdt} USDT。`);
  }

  if (state.userOpenTrade) {
    throw new Error("当前已有魏夙手动未结算事件票据，等这一单结算后再手动下单。");
  }

  if (stakeUsdt > state.account.availableBalanceUsdt) {
    throw new Error(`余额不足，可用 ${state.account.availableBalanceUsdt.toFixed(2)} USDT。`);
  }

  const entryPrice = latestTradablePrice();
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error("还没有可用的 Binance 永续入场价，先刷新行情后再手动下单。");
  }

  let trade = null;
  mutateState(() => {
    const signalCandles = state.market.baseCandles?.length ? state.market.baseCandles : state.market.candles;
    const aiSignal = buildSignal(signalCandles);
    const manualSignal = buildUserManualSignal(direction, aiSignal);
    trade = openTrade(entryPrice, Date.now(), manualSignal, "user-manual", {
      actor: "魏夙手动",
      trigger: "魏夙手动下单",
      reason: `魏夙手动参与模拟事件合约，选择 ${durationMinutes} 分钟${direction === "LONG" ? "买涨" : "买跌"}。`,
      durationMinutes,
      durationReason: `魏夙手动选择 ${durationMinutes} 分钟事件窗口。`,
      stakeUsdt,
      stakeReason: `魏夙手动选择投入 ${stakeUsdt.toFixed(2)} USDT。`,
      aiSignalDirection: aiSignal.direction,
      aiSignalConfidence: aiSignal.confidence,
      aiSignalReason: aiSignal.reason,
    });
  });

  if (!trade) throw new Error("手动下单失败，账户余额或行情状态不满足条件。");
  return trade;
}

function settleTrade(exitPrice, exitTime, slot = "ai") {
  const trade = slot === "user" ? state.userOpenTrade : state.openTrade;
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
  trade.summary = trade.mode === "user-manual" ? buildUserManualSummary(trade) : buildTradeSummaryV3(trade);

  state.account.availableBalanceUsdt = round(state.account.availableBalanceUsdt + returnedUsdt, 4);
  state.account.realizedPnlUsdt = round(state.account.realizedPnlUsdt + pnlUsdt, 4);
  state.account.realizedPnlRmb = round(state.account.realizedPnlUsdt * state.account.rmbPerUsdt, 2);
  if (trade.mode === "user-manual") updateUserHabits(trade);
  if (slot === "user" || trade.mode === "user-manual") {
    state.userOpenTrade = null;
  } else {
    state.openTrade = null;
  }
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, CONFIG.maxTradeHistory);
  if (trade.mode !== "user-manual") {
    state.bot.status = "waiting-next-cycle";
    state.bot.note = trade.summary;
  }
  state.insights.unshift({
    time: trade.exitTime,
    type: trade.result,
    title: trade.mode === "user-manual"
      ? `魏夙手动${trade.result === "WIN" ? "成功" : trade.result === "LOSS" ? "失败" : "持平"}复盘`
      : trade.result === "WIN" ? "成功复盘" : trade.result === "LOSS" ? "失败复盘" : "持平复盘",
    body: trade.summary,
  });
  state.insights = state.insights.slice(0, 20);
  recalculateAccountExposure();

  return trade;
}

function settleOpenTradeIfDue(slot, now) {
  const trade = slot === "user" ? state.userOpenTrade : state.openTrade;
  if (!trade || now < new Date(trade.settlementTime).getTime()) return "not-due";

  const settlementCandle = findTradeSettlementCandle(trade);
  if (!settlementCandle) {
    if (slot !== "user") {
      state.bot.status = "waiting-binance-close";
      state.bot.note = "等待 Binance 返回订单到期后的真实1分钟收盘价。";
    }
    return "waiting";
  }

  settleTrade(settlementCandle.close, settlementCandle.closeTime, slot);
  return "settled";
}

function buildTradeSummary(trade) {
  const directionText = trade.direction === "LONG" ? "买涨" : "买跌";
  const durationText = `${trade.durationMinutes || 10}分钟`;
  const moveText = `价格从 ${formatPrice(trade.entryPrice)} 到 ${formatPrice(trade.exitPrice)}，波动 ${trade.priceMovePct}%`;
  const confidenceText = Number.isFinite(Number(trade.confidence))
    ? `入场置信度 ${Math.round(Number(trade.confidence) * 100)}%`
    : "入场置信度未记录";
  const strengthText = Number.isFinite(Number(trade.score))
    ? `信号强度 ${Math.abs(Number(trade.score)).toFixed(2)}`
    : "信号强度未记录";
  const triggerText = trade.trigger ? `触发来源：${trade.trigger}` : "触发来源：事件信号";
  const durationReason = trade.durationReason || "周期按事件合约短线风险控制选择";
  const context = `${triggerText}，${confidenceText}，${strengthText}，周期理由：${durationReason}`;

  if (trade.result === "WIN") {
    const lesson = Math.abs(trade.priceMovePct) < 0.08
      ? "这笔胜利来自到期方向判断正确，但价差不大，说明边际存在但不算厚，后续不能因为赢了就放大仓位。"
      : "这笔胜利说明入场后的短周期动量延续到了到期点，信号与事件合约时间窗匹配度较好。";
    return `${durationText}${directionText}成功：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}，净收益 ${trade.pnlUsdt.toFixed(2)} USDT。${context}。${lesson} 下一轮继续看量能、动量和到期窗口是否同步，只在边际还够厚时出手。`;
  }

  if (trade.result === "LOSS") {
    const againstDirection = trade.direction === "LONG" ? trade.priceMovePct < 0 : trade.priceMovePct > 0;
    let diagnosis = "失败原因需要继续从信号源拆解";
    if (Math.abs(trade.priceMovePct) < 0.06) {
      diagnosis = "到期价差太窄，事件合约方向虽然可判断但赔率边际不厚，容易被噪音吞掉";
    } else if (againstDirection) {
      diagnosis = "入场后价格反向推进，说明短周期触发信号没有获得后续资金流确认";
    } else {
      diagnosis = "方向并非完全错误，但到期点没有站在有利一侧，时间窗选择或入场点需要优化";
    }
    const nextAdjustment = Math.abs(Number(trade.score || 0)) < 0.45
      ? "下一轮提高信号强度门槛，弱信号只做影子观察。"
      : "下一轮重点复核量能和3根动量是否同向，避免单一指标触发。";
    return `${durationText}${directionText}失败：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}，亏损 ${Math.abs(trade.pnlUsdt).toFixed(2)} USDT。${context}。${diagnosis}。${nextAdjustment}`;
  }

  return `${durationText}${directionText}持平：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}。${context}。本轮退回本金，说明事件窗口内没有形成足够价格差；下一轮优先等待更清晰的突破、放量或反转确认。`;
}

function buildTradeSummaryV2(trade) {
  const directionText = trade.direction === "LONG" ? "买涨" : "买跌";
  const durationText = `${trade.durationMinutes || 10}分钟`;
  const moveText = `价格从 ${formatPrice(trade.entryPrice)} 到 ${formatPrice(trade.exitPrice)}，波动 ${trade.priceMovePct}%`;
  const confidenceText = Number.isFinite(Number(trade.confidence))
    ? `入场置信度 ${Math.round(Number(trade.confidence) * 100)}%`
    : "入场置信度未记录";
  const strengthText = Number.isFinite(Number(trade.score))
    ? `信号强度 ${Math.abs(Number(trade.score)).toFixed(2)}`
    : "信号强度未记录";
  const triggerText = trade.trigger ? `触发来源：${trade.trigger}` : "触发来源：事件信号";
  const durationReason = trade.durationReason || "周期按事件合约短线风险控制选择";
  const signalReason = trade.signalReason || "入场时的结构信号未完整落档";
  const volumeText = Number.isFinite(Number(trade.volumeRatio))
    ? `量能 ${Number(trade.volumeRatio).toFixed(2)}x`
    : "量能未记录";
  const momentumText = Number.isFinite(Number(trade.momentum3))
    ? `3根动量 ${round(Number(trade.momentum3) * 100, 2)}%`
    : "3根动量未记录";
  const rsiText = Number.isFinite(Number(trade.rsi)) ? `RSI ${Number(trade.rsi).toFixed(1)}` : "RSI 未记录";
  const marketContext = [
    Math.abs(Number(trade.priceMovePct || 0)) < 0.03 ? "到期前市场几乎没有拉开价差" : "到期前市场出现了可交易的方向波动",
    Number(trade.volumeRatio || 0) >= 1.2 ? "量能明显放大" : Number(trade.volumeRatio || 0) >= 1.05 ? "量能有轻度确认" : "量能偏薄",
    Math.abs(Number(trade.momentum3 || 0)) >= 0.0015 ? "短周期动量较强" : Math.abs(Number(trade.momentum3 || 0)) >= 0.0007 ? "短周期动量一般" : "短周期动量不足",
  ].join("，");
  const entryLogic = `入场逻辑：${signalReason}；${triggerText}；${confidenceText}；${strengthText}；${volumeText}；${momentumText}；${rsiText}；周期理由：${durationReason}`;

  if (trade.result === "WIN") {
    const lesson = Math.abs(trade.priceMovePct) < 0.08
      ? "这笔胜利更多来自方向判断勉强站对，而不是厚边际兑现"
      : "这笔胜利说明入场后的方向延续覆盖了事件合约到期窗口";
    const nextStep = Number(trade.volumeRatio || 0) < 1.05
      ? "下一轮同类低量能样本继续只给最小仓位，不放大利润错觉。"
      : "下一轮继续要求量能和动量同向，不因单笔盈利扩大风险。";
    return `${durationText}${directionText}成功：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}，净收益 ${trade.pnlUsdt.toFixed(2)} USDT。市场上下文：${marketContext}。${entryLogic}。成功原因：${lesson}。${nextStep}`;
  }

  if (trade.result === "LOSS") {
    const againstDirection = trade.direction === "LONG" ? trade.priceMovePct < 0 : trade.priceMovePct > 0;
    let diagnosis = "失败原因仍需继续从信号源拆解。";
    if (Math.abs(trade.priceMovePct) < 0.06) {
      diagnosis = "到期价差太窄，属于方向可能没错但赔率空间不够的事件合约失败。";
    } else if (againstDirection) {
      diagnosis = "入场后出现反向推进，说明触发点没有拿到后续资金流确认，属于反抽打穿。";
    } else {
      diagnosis = "方向并非完全错误，但到期点没有站到有利一侧，时间窗或入场点仍偏早。";
    }
    const nextAdjustment = Math.abs(Number(trade.priceMovePct || 0)) < 0.06
      ? "下一轮把这类窄幅样本改成影子观察，等量能或动量更厚再下单。"
      : Number(trade.volumeRatio || 0) < 1.05
        ? "下一轮低量能信号只保留样本，不再给加仓权重。"
        : "下一轮遇到突发反抽时，先等二次确认或更厚的合约流向再追。";
    return `${durationText}${directionText}失败：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}，亏损 ${Math.abs(trade.pnlUsdt).toFixed(2)} USDT。市场上下文：${marketContext}。${entryLogic}。失败原因：${diagnosis}${nextAdjustment}`;
  }

  return `${durationText}${directionText}持平：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}。市场上下文：${marketContext}。${entryLogic}。本轮退回本金，说明事件窗口内没有形成足够价差；下一轮优先等更清晰的突破、放量或反转确认。`;
}

function buildTradeSummaryV3(trade) {
  const directionText = trade.direction === "LONG" ? "买涨" : "买跌";
  const durationText = `${trade.durationMinutes || 10}分钟`;
  const moveText = `价格从 ${formatPrice(trade.entryPrice)} 到 ${formatPrice(trade.exitPrice)}，波动 ${trade.priceMovePct}%`;
  const confidenceText = Number.isFinite(Number(trade.confidence))
    ? `入场置信度 ${Math.round(Number(trade.confidence) * 100)}%`
    : "入场置信度未记录";
  const strengthText = Number.isFinite(Number(trade.score))
    ? `信号强度 ${Math.abs(Number(trade.score)).toFixed(2)}`
    : "信号强度未记录";
  const triggerText = trade.trigger ? `触发来源：${trade.trigger}` : "触发来源：事件信号";
  const durationReason = trade.durationReason || "周期按事件合约短线风险控制选择";
  const signalReason = trade.signalReason || "入场时的结构信号未完整落档";
  const volumeRatio = Number(trade.volumeRatio || 0);
  const volumeText = Number.isFinite(Number(trade.volumeRatio))
    ? `量能 ${Number(trade.volumeRatio).toFixed(2)}x`
    : "量能未记录";
  const momentum3 = Number(trade.momentum3 || 0);
  const momentumText = Number.isFinite(Number(trade.momentum3))
    ? `3根动量 ${round(Number(trade.momentum3) * 100, 2)}%`
    : "3根动量未记录";
  const rsi = Number(trade.rsi || 50);
  const rsiText = Number.isFinite(Number(trade.rsi)) ? `RSI ${Number(trade.rsi).toFixed(1)}` : "RSI 未记录";
  const numericMovePct = Number(trade.priceMovePct || 0);
  const absMovePct = Math.abs(numericMovePct);
  const score = Number(trade.score || 0);
  const overextendedLong = trade.direction === "LONG" && rsi >= 68;
  const overextendedShort = trade.direction === "SHORT" && rsi <= 32;
  const settlementWindowText = absMovePct >= 0.12
    ? "到期窗口兑现充分"
    : absMovePct >= 0.06
      ? "到期窗口兑现一般"
      : "到期窗口兑现偏弱";
  const marketContext = [
    absMovePct < 0.03 ? "到期前市场几乎没有拉开价差" : "到期前市场出现了可交易的方向波动",
    volumeRatio >= 1.2 ? "量能明显放大" : volumeRatio >= 1.05 ? "量能有轻度确认" : "量能偏薄",
    Math.abs(momentum3) >= 0.0015 ? "短周期动量较强" : Math.abs(momentum3) >= 0.0007 ? "短周期动量一般" : "短周期动量不足",
    settlementWindowText,
  ].join("，");
  const entryLogic = `入场逻辑：${signalReason}；${triggerText}；${confidenceText}；${strengthText}；${volumeText}；${momentumText}；${rsiText}；周期理由：${durationReason}`;

  if (trade.result === "WIN") {
    const lesson = absMovePct < 0.08
      ? "这笔胜利更像薄边际兑现，方向虽然站对，但优势并不厚。"
      : trade.durationMinutes === 15
        ? "这笔胜利说明结构、延续和持有窗口都匹配，15分钟事件单才有兑现基础。"
        : "这笔胜利说明入场后的方向延续覆盖了10分钟到期窗口。";
    const nextStep = volumeRatio < 1.05
      ? "下一轮同类低量能样本继续只给最小仓位，不把薄胜误判成可放大的稳定优势。"
      : overextendedLong || overextendedShort
        ? "下一轮即使延续成功，也不要把过热追单当成常态模板；先等回踩或二次确认。"
        : "下一轮继续要求量能和动量同向，不因单笔盈利扩大风险。";
    return `${durationText}${directionText}成功：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}，净收益 ${trade.pnlUsdt.toFixed(2)} USDT。市场上下文：${marketContext}。${entryLogic}。成功原因：${lesson}${nextStep}`;
  }

  if (trade.result === "LOSS") {
    const againstDirection = trade.direction === "LONG" ? numericMovePct < 0 : numericMovePct > 0;
    let diagnosis = "失败原因仍需继续从信号源拆解。";
    if (absMovePct < 0.06) {
      diagnosis = "到期价差太窄，属于方向可能没错但赔率空间不够的事件合约失败。";
    } else if (volumeRatio < 1.05 && Math.abs(momentum3) < 0.0009) {
      diagnosis = "入场时量能和短动量都偏薄，更像在噪音里提前下注，而不是等到事件窗口真正打开。";
    } else if (overextendedLong || overextendedShort) {
      diagnosis = `入场时 RSI 已经${overextendedLong ? "偏高" : "偏低"}，更像末端追击，随后被均值回拉打掉。`;
    } else if (againstDirection) {
      diagnosis = "入场后出现反向推进，说明触发点没有拿到后续资金流确认，属于反抽打穿。";
    } else {
      diagnosis = "方向并非完全错误，但到期点没有站到有利一侧，时间窗或入场点仍偏早。";
    }
    const nextAdjustment = absMovePct < 0.06
      ? "下一轮把这类窄幅样本改成影子观察，等量能、盘口或动量更厚再下单。"
      : volumeRatio < 1.05
        ? "下一轮低量能信号只保留样本，不再给真实模拟仓位优先级。"
        : overextendedLong || overextendedShort
          ? `下一轮把这类 RSI ${overextendedLong ? "过热追多" : "过冷追空"} 降级为等待二次确认，不再直接成交。`
          : score && Math.abs(score) < 0.58
            ? "下一轮同类刚过线信号降级为影子观察，等更厚的结构确认。"
            : "下一轮遇到突发反抽时，先等二次确认或更厚的合约流向再进。";
    return `${durationText}${directionText}失败：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}，亏损 ${Math.abs(trade.pnlUsdt).toFixed(2)} USDT。市场上下文：${marketContext}。${entryLogic}。失败原因：${diagnosis}${nextAdjustment}`;
  }

  return `${durationText}${directionText}持平：本笔投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}。市场上下文：${marketContext}。${entryLogic}。本轮退回本金，说明事件窗口内没有形成足够价差；下一轮优先等更清晰的突破、放量或反转确认。`;
}

function buildUserManualSummary(trade) {
  const directionText = trade.direction === "LONG" ? "买涨" : "买跌";
  const durationText = `${trade.durationMinutes || 10}分钟`;
  const aiDirectionText = trade.aiSignalDirection === "LONG" ? "买涨" : trade.aiSignalDirection === "SHORT" ? "买跌" : "未知";
  const alignment = trade.aiSignalDirection === trade.direction ? "你这次和 AI 盘面方向同向" : "你这次是逆着 AI 盘面方向出手";
  const moveText = `价格从 ${formatPrice(trade.entryPrice)} 到 ${formatPrice(trade.exitPrice)}，波动 ${trade.priceMovePct}%`;
  const volumeText = Number.isFinite(Number(trade.volumeRatio)) ? `量能 ${Number(trade.volumeRatio).toFixed(2)}x` : "量能未记录";
  const momentumText = Number.isFinite(Number(trade.momentum3)) ? `3根动量 ${round(Number(trade.momentum3) * 100, 2)}%` : "3根动量未记录";
  const aiContext = `当时 AI 参考方向 ${aiDirectionText}，${alignment}；${volumeText}，${momentumText}，RSI ${Number(trade.rsi || 50).toFixed(1)}。`;

  if (trade.result === "WIN") {
    const habit = trade.aiSignalDirection === trade.direction
      ? "这说明你顺着盘口和动量做判断时，胜率样本值得保留。"
      : "这说明你有逆向抓反抽的成功样本，但这种打法要继续要求更清晰的到期价差。";
    const riskNote = Math.abs(Number(trade.priceMovePct || 0)) < 0.06
      ? "不过这笔价差不厚，不能因为赢了就把窄幅盘也当成高胜率。"
      : "这笔到期价差覆盖了事件窗口，说明入场时机有效。";
    return `魏夙手动${durationText}${directionText}成功：投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}，净收益 ${trade.pnlUsdt.toFixed(2)} USDT。${aiContext}判断正确点：${habit}${riskNote}我会把这类样本记为你的有效习惯，后续 AI 信号会参考你在同向/逆向场景下的表现。`;
  }

  if (trade.result === "LOSS") {
    let diagnosis = "这笔失败要从入场确认不足复盘。";
    if (trade.aiSignalDirection && trade.aiSignalDirection !== trade.direction) {
      diagnosis = "主要问题是逆着 AI 盘面方向出手，但没有等到足够的二次确认。";
    } else if (Number(trade.volumeRatio || 0) < 1.05) {
      diagnosis = "主要问题是量能没有跟上，方向判断可能有想法，但事件合约到期窗口里赔率边际不够。";
    } else if (Math.abs(Number(trade.priceMovePct || 0)) < 0.06) {
      diagnosis = "主要问题是波动太窄，事件合约看对一点点也不一定能站到结算有利侧。";
    } else {
      diagnosis = "主要问题是入场后价格反向推进，说明触发点没有拿到后续资金流确认。";
    }
    const correction = trade.durationMinutes === 15
      ? "下次 15m 手动单要更重视趋势延续，别只看一两根短线反应。"
      : "下次 10m 手动单要更重视入场后一两分钟是否马上给方向反馈。";
    return `魏夙手动${durationText}${directionText}失败：投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}，亏损 ${Math.abs(trade.pnlUsdt).toFixed(2)} USDT。${aiContext}你错在：${diagnosis}${correction}我会把这笔记入你的失败习惯样本，后续遇到类似盘口会提醒少下或等确认。`;
  }

  return `魏夙手动${durationText}${directionText}持平：投入 ${trade.stakeUsdt.toFixed(2)} USDT，${moveText}。${aiContext}这类样本说明方向和到期窗口都没有拉开优势，下次优先等更明确的放量或突破。`;
}

function buildUserHabitLesson(trade) {
  const directionText = trade.direction === "LONG" ? "买涨" : "买跌";
  const alignment = trade.aiSignalDirection === trade.direction ? "顺 AI 方向" : "逆 AI 方向";
  if (trade.result === "WIN") {
    return `${alignment}${directionText}成功，保留为有效判断样本。`;
  }
  if (trade.result === "LOSS") {
    return `${alignment}${directionText}失败，下次要求量能、动量或二次确认更充分。`;
  }
  return `${alignment}${directionText}持平，说明到期价差不足。`;
}

function updateUserHabits(trade) {
  const manualTrades = [
    trade,
    ...state.trades.filter((item) => item.mode === "user-manual" && item.status === "SETTLED"),
  ].slice(0, CONFIG.maxTradeHistory);
  const totalTrades = manualTrades.length;
  const wins = manualTrades.filter((item) => item.result === "WIN").length;
  const losses = manualTrades.filter((item) => item.result === "LOSS").length;
  const flats = manualTrades.filter((item) => item.result === "FLAT").length;
  const longTrades = manualTrades.filter((item) => item.direction === "LONG").length;
  const shortTrades = manualTrades.filter((item) => item.direction === "SHORT").length;
  const durationCounts = manualTrades.reduce((counts, item) => {
    const key = `${item.durationMinutes || 10}m`;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const preferredDuration = Object.entries(durationCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "--";
  const avgStakeUsdt = totalTrades
    ? round(manualTrades.reduce((sum, item) => sum + Number(item.stakeUsdt || 0), 0) / totalTrades, 2)
    : 0;
  const lesson = buildUserHabitLesson(trade);

  state.userHabits = {
    totalTrades,
    wins,
    losses,
    flats,
    winRate: totalTrades ? round((wins / totalTrades) * 100, 1) : 0,
    longTrades,
    shortTrades,
    avgStakeUsdt,
    preferredDuration,
    lastLesson: lesson,
    patterns: [
      {
        time: trade.exitTime,
        result: trade.result,
        direction: trade.direction,
        durationMinutes: trade.durationMinutes || 10,
        stakeUsdt: trade.stakeUsdt,
        lesson,
      },
      ...(state.userHabits?.patterns || []),
    ].slice(0, 20),
  };
}

function recalculateAccountExposure() {
  const aiOpenExposure = state.openTrade?.stakeUsdt || 0;
  const manualOpenExposure = state.userOpenTrade?.stakeUsdt || 0;
  const openExposure = aiOpenExposure + manualOpenExposure;
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
  const openTradeCount = getOpenTrades().length;
  state.stats = {
    totalTrades: settled.length + openTradeCount,
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
  if (state.trades.length > 0 || state.openTrade || state.userOpenTrade) return;
  if (!state.bot.active && state.bot.manualResetAt) return;
  if (state.bot.status === "paused-after-reset") return;

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

      const aiSettlementStatus = settleOpenTradeIfDue("ai", now);
      settleOpenTradeIfDue("user", now);
      if (aiSettlementStatus === "waiting") return;

      if (!state.bot.active) {
        if (state.openTrade) return;
        if (state.bot.status === "paused-after-reset") {
          state.bot.nextDecisionTime = null;
          state.bot.nextSettlementTime = null;
          return;
        }
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
    settleOpenTradeIfDue("ai", now);
    settleOpenTradeIfDue("user", now);
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
      if (state.bot.status === "paused-after-reset") {
        state.bot.nextSettlementTime = null;
        return;
      }
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
  const previousMarket = state.market;
  const resetAt = nowIso();
  state = createInitialState();
  state.market = previousMarket || state.market;
  state.bot.dataSource = state.market.source || state.bot.dataSource;
  state.bot.active = false;
  state.bot.status = "paused-after-reset";
  state.bot.manualResetAt = resetAt;
  state.bot.note = "模拟盘已重置：账户、订单、复盘和持仓已清空；自动化已暂停，点击播放后才会重新扫描并模拟下单。";
  state.bot.nextDecisionTime = null;
  state.bot.nextSettlementTime = null;
  state.updatedAt = nowIso();
  recalculateStats();
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

    if (url.pathname === "/api/klines" && req.method === "GET") {
      const interval = url.searchParams.get("interval") || "1d";
      const history = await fetchHistoricalKlines(interval);
      sendJson(res, history);
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

    if (url.pathname === "/api/manual-order" && req.method === "POST") {
      try {
        const body = await readBody(req);
        await openUserManualTrade(body);
        sendJson(res, publicState());
      } catch (error) {
        sendJson(res, { error: error.message, state: publicState() }, 400);
      }
      return;
    }

    if (url.pathname === "/api/restore-client-state" && req.method === "POST") {
      const body = await readBody(req);
      const result = restoreClientSnapshot(body);
      sendJson(res, { ...result, state: publicState() });
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
