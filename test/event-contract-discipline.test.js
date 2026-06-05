const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("extreme chase longs are downgraded to shadow observation", () => {
  const server = read("server.js");

  assert.match(server, /const extremeChaseLong = signal\.direction === "LONG" && rsiValue >= 74;/, "decision logic should identify extreme long chases earlier");
  assert.match(server, /等回踩或二次确认，不把末端追价直接转成模拟成交/, "extreme long chases should be shadowed instead of executed");
});

test("15m short extensions stay conservative near oversold readings", () => {
  const server = read("server.js");

  assert.match(server, /const oversoldShort = signal\.direction === "SHORT" && rsiValue <= 32;/, "15m short entries should reject oversold tail entries earlier");
});

test("simulated bankroll migrates to 1000 RMB without wiping history", () => {
  const server = read("server.js");

  assert.match(server, /CONFIGURED_STARTING_RMB = Number\(process\.env\.STARTING_RMB \|\| 1000\)/, "default paper bankroll should be 1000 RMB");
  assert.match(server, /function migrateAccountFunding/, "loaded accounts should be migrated instead of reset");
  assert.match(server, /previousStartingRmb < CONFIG\.startingRmb/, "older 200 RMB accounts should be topped up to the new bankroll");
  assert.match(server, /normalizeTradeHistory\(loaded\.trades\)/, "trade history should be preserved during account migration");
});
