const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("frontend exposes a TradingView-style chart with canvas fallback", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const css = read("public/styles.css");

  assert.match(html, /lightweight-charts/, "page should load TradingView Lightweight Charts");
  assert.match(html, /id="tvKlineChart"/, "page should expose a dedicated TradingView chart container");
  assert.match(app, /initTradingViewChart/, "frontend should initialize the TradingView-style chart");
  assert.match(app, /renderTradingViewChart/, "frontend should render candles through the TradingView-style chart");
  assert.match(app, /drawMainChart\(state, windowInfo\)/, "existing canvas chart should remain as fallback");
  assert.match(css, /\.tv-chart-wrap\.tv-ready\s+#klineCanvas/, "CSS should hide canvas only after TradingView chart is ready");
});

test("backend fetches and publishes multi-source Binance futures sentiment", () => {
  const server = read("server.js");

  assert.match(server, /sentiment:\s*createInitialSentiment\(\)/, "market state should carry sentiment data");
  assert.match(server, /fetchMarketSentimentFromBinance/, "server should fetch multi-source Binance sentiment");
  assert.match(server, /\/fapi\/v1\/openInterest/, "sentiment should include current open interest");
  assert.match(server, /\/fapi\/v1\/premiumIndex/, "sentiment should include current funding/premium data");
  assert.match(server, /\/futures\/data\/globalLongShortAccountRatio/, "sentiment should include global long/short account ratio");
  assert.match(server, /\/futures\/data\/takerlongshortRatio/, "sentiment should include taker buy/sell flow");
  assert.match(server, /state\.market\.sentiment\s*=\s*sentiment/, "refresh should publish sentiment without replacing K-lines");
});

test("sentiment cloud uses live multi-source fields instead of placeholders", () => {
  const server = read("server.js");

  assert.match(server, /marketSentiment\.openInterest/, "cloud should read open interest");
  assert.match(server, /marketSentiment\.funding/, "cloud should read funding");
  assert.match(server, /marketSentiment\.longShort/, "cloud should read long/short ratio");
  assert.match(server, /marketSentiment\.takerFlow/, "cloud should read taker flow");
  assert.doesNotMatch(server, /label:\s*"持仓量 OI"[\s\S]{0,160}value:\s*"待接入"/, "OI should no longer be a hard-coded placeholder");
});
