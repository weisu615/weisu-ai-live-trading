const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("manual stake input is promoted with quick sizing controls", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");

  assert.match(html, /class="manual-stake-ticket"/, "manual stake should have a dedicated premium ticket surface");
  assert.match(html, /data-stake-preset="5"/, "manual stake should offer a 5 USDT preset");
  assert.match(html, /data-stake-preset="25pct"/, "manual stake should offer a balance-ratio preset");
  assert.match(app, /applyStakePreset/, "frontend should wire quick stake presets into the manual stake input");
});

test("strategy lab and event pulse board are exposed in the UI", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");

  assert.match(html, /id="eventPulseBoard"/, "UI should include the event-contract pulse board");
  assert.match(html, /id="strategyLabRows"/, "UI should include strategy lab ranking rows");
  assert.match(app, /updateEventPulseBoard/, "frontend should render event pulse data from state");
  assert.match(app, /updateStrategyLab/, "frontend should render strategy lab data from state");
  assert.doesNotMatch(html, /情绪云图|sentimentCloud/, "event-contract UI should not label this as a generic sentiment cloud");
});

test("backend publishes shadow strategy lab data without controlling orders", () => {
  const server = read("server.js");

  assert.match(server, /strategyLab:\s*buildStrategyLab\(\)/, "public state should expose strategy lab data");
  assert.match(server, /eventPulseBoard:\s*buildEventPulseBoard\(\)/, "public state should expose event-contract pulse data");
  assert.match(server, /function buildStrategyLab/, "server should build strategy lab rankings");
  assert.match(server, /function buildEventPulseBoard/, "server should build event-contract pulse cards");
  assert.match(server, /shadowOnly:\s*true/, "strategy lab candidates should be explicitly shadow-only");
  assert.doesNotMatch(server, /strategyLab[\s\S]{0,120}openTrade\(/, "strategy lab should not directly place orders");
});

test("manual habit profile is visible and backed by state", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const server = read("server.js");

  assert.match(html, /id="manualHabitProfile"/, "UI should expose a dedicated WeiSu manual habit profile");
  assert.match(app, /updateManualHabitProfile/, "frontend should render the manual habit profile");
  assert.match(server, /manualHabitProfile:\s*buildManualHabitProfile\(\)/, "public state should expose computed manual habit profile");
});
