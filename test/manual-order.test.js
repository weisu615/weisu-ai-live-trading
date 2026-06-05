const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("frontend exposes manual event-contract order controls", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");

  assert.match(html, /id="manualStake"/, "manual stake input should be visible");
  assert.match(html, /data-manual-direction="LONG"/, "manual long button should be present");
  assert.match(html, /data-manual-direction="SHORT"/, "manual short button should be present");
  assert.match(html, /id="manualDuration"/, "manual duration selector should be present");
  assert.match(app, /\/api\/manual-order/, "manual controls should call the manual order API");
});

test("backend records manual orders and user habit learning", () => {
  const server = read("server.js");

  assert.match(server, /\/api\/manual-order/, "server should expose a manual order API");
  assert.match(server, /openUserManualTrade/, "server should create user manual trades through a dedicated path");
  assert.match(server, /user-manual/, "manual trades should be tagged separately from AI trades");
  assert.match(server, /buildUserManualSummary/, "manual settlements should use a user-focused review summary");
  assert.match(server, /userHabits/, "server should persist a manual-trading habit profile");
});

test("manual and AI event tickets keep separate open positions", () => {
  const server = read("server.js");

  assert.match(server, /userOpenTrade/, "manual orders should have a dedicated open-trade slot");
  assert.match(server, /state\.userOpenTrade\s*=\s*trade/, "manual order creation should not overwrite the AI open trade");
  assert.match(server, /state\.userOpenTrade\?\.stakeUsdt/, "account exposure should include the manual open stake");
  assert.doesNotMatch(
    server,
    /if \(state\.openTrade\) \{\s*throw new Error\("[^"]*手动/s,
    "manual entry should not be blocked only because the AI has an open ticket",
  );
});

test("frontend renders independent AI and user review ledgers", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");

  assert.match(html, /id="aiTradeRows"/, "AI review ledger should have its own table body");
  assert.match(html, /id="userTradeRows"/, "manual review ledger should have its own table body");
  assert.match(app, /renderTradeTable\(els\.aiTradeRows/, "AI trades should render into the AI table only");
  assert.match(app, /renderTradeTable\(els\.userTradeRows/, "manual trades should render into the user table only");
});

test("ai settlement summaries include market-context-specific diagnostics", () => {
  const server = read("server.js");

  assert.match(server, /buildTradeSummaryV4/, "server should route AI settlement summaries through the richer v4 formatter");
  assert.match(server, /到期窗口兑现/, "AI settlement summaries should mention event-window realization quality");
  assert.match(server, /过热追多|过冷追空/, "AI settlement summaries should record RSI-driven failure adjustments");
  assert.match(server, /量能和短动量都没真正打开/, "AI settlement summaries should identify thin-flow failure cases");
});
