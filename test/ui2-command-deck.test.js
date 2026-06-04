const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("premium UI 2.0 exposes a live market command deck", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const css = read("public/styles.css");

  assert.match(html, /id="marketCommandDeck"/, "page should include the WeiSu market command deck");
  assert.match(html, /id="deckOpenInterest"/, "command deck should show OI");
  assert.match(html, /id="deckFunding"/, "command deck should show funding");
  assert.match(html, /id="deckLongShort"/, "command deck should show long/short account ratio");
  assert.match(html, /id="deckTakerFlow"/, "command deck should show taker buy/sell flow");
  assert.match(app, /updateMarketCommandDeck/, "frontend should render command deck values from state");
  assert.match(css, /\.market-command-deck/, "command deck should have dedicated premium styling");
});
