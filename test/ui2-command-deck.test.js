const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("premium UI 2.0 is centered on binary event-contract tickets", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const css = read("public/styles.css");
  const designDoc = read("design/魏夙AI高级UI2.0设计说明.md");
  const figmaSvg = read("design/魏夙AI高级UI2.0-Figma导入稿.svg");

  assert.match(html, /id="eventContractDesk"/, "page should include an event-contract desk");
  assert.match(html, /id="eventWinRate"/, "desk should show event-contract win probability");
  assert.match(html, /id="eventCallProbability"/, "desk should show buy-up probability");
  assert.match(html, /id="eventPutProbability"/, "desk should show buy-down probability");
  assert.match(html, /id="eventPayout"/, "desk should show simulated payout");
  assert.match(html, /id="eventExpiryMode"/, "desk should show 10m/15m expiry mode");
  assert.match(app, /updateEventContractDesk/, "frontend should render event-contract desk values from state");
  assert.match(css, /\.event-contract-desk/, "event desk should have dedicated premium styling");

  for (const source of [html, app, designDoc, figmaSvg]) {
    assert.doesNotMatch(source, /持仓量|资金费率|多空账户|主动买卖|盘口厚度|Open Interest|open interest|\bOI\b/, "event-contract UI should not expose ordinary futures position metrics");
  }
});
