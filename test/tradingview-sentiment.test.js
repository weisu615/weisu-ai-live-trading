const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("frontend exposes a TradingView-style chart with local canvas fallback", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const css = read("public/styles.css");

  assert.match(html, /\/vendor\/lightweight-charts\.standalone\.production\.js/, "page should load the local TradingView Lightweight Charts bundle");
  assert.doesNotMatch(html, /unpkg\.com|cdn\.jsdelivr|cdnjs/, "page should not depend on overseas chart CDNs");
  assert.match(html, /id="tvKlineChart"/, "page should expose a dedicated TradingView chart container");
  assert.match(app, /initTradingViewChart/, "frontend should initialize the TradingView-style chart");
  assert.match(app, /renderTradingViewChart/, "frontend should render candles through the TradingView-style chart");
  assert.match(app, /drawMainChart\(state, windowInfo\)/, "existing canvas chart should remain as fallback");
  assert.match(css, /\.tv-chart-wrap\.tv-ready\s+#klineCanvas/, "CSS should hide canvas only after TradingView chart is ready");
});

test("backend publishes event-contract pulse data for binary tickets", () => {
  const server = read("server.js");

  assert.match(server, /eventPulseBoard:\s*buildEventPulseBoard\(\)/, "public state should expose event-contract pulse data");
  assert.match(server, /function buildEventPulseBoard/, "server should build a dedicated event-contract pulse board");
  assert.match(server, /callProbability/, "pulse board should publish buy-up probability");
  assert.match(server, /putProbability/, "pulse board should publish buy-down probability");
  assert.match(server, /payoutRate:\s*CONFIG\.payoutRate/, "pulse board should expose simulated payout rate");
});

test("chart panel stays compact when the side rail grows", () => {
  const html = read("public/index.html");
  const css = read("public/styles.css");

  assert.match(html, /<section class="dashboard">[\s\S]*<aside class="side-panel">[\s\S]*<section class="intelligence-grid"/, "event pulse and strategy lab should live inside the dashboard flow");
  assert.match(css, /grid-template-areas:\s*"chart side"\s*"intelligence side"/, "dashboard should let the left workflow continue below the chart while the ticket rail stays on the right");
  assert.match(css, /\.chart-panel\s*{[\s\S]*min-height:\s*auto;/, "chart panel should not create a large empty block under the overview");
  assert.match(css, /\.chart-wrap\s*{[\s\S]*height:\s*clamp\(420px,\s*52vh,\s*620px\)/, "main K-line chart should have a stable responsive height");
});

test("event-contract pulse board avoids ordinary futures position metrics", () => {
  const server = read("server.js");
  const app = read("public/app.js");
  const html = read("public/index.html");

  assert.doesNotMatch(server, /eventPulseBoard:\s*buildSentimentCloud\(\)/, "public state should not expose the old sentiment cloud");
  assert.doesNotMatch(server, /fetchMarketSentimentFromBinance|\/fapi\/v1\/openInterest|\/fapi\/v1\/premiumIndex|globalLongShortAccountRatio|takerlongshortRatio|openInterestHist|\/fapi\/v1\/depth/, "server should not fetch ordinary futures sentiment endpoints for event contracts");
  assert.doesNotMatch(app, /sentimentCloud|updateSentimentCloud|updateMarketCommandDeck/, "frontend should render event-contract modules only");
  assert.doesNotMatch(html, /情绪云图|持仓量|资金费率|多空账户|主动买卖|盘口厚度|\bOI\b/, "page copy should stay centered on event contracts");
});
