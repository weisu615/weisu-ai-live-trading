const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("reset button requires an explicit confirmation step", () => {
  const app = read("public/app.js");
  assert.match(app, /openResetConfirm\(/, "reset click should open a confirmation dialog before POST /api/reset");
  assert.match(app, /confirmReset/, "confirmation dialog controls should be wired in the client");
  assert.match(app, /serverResetAt:\s*state\.bot\?\.manualResetAt/, "client backup should carry the server reset marker");
  assert.match(app, /clearClientBackup\(\)/, "client backup should be cleared during reset handling");
});

test("manual reset clears history and pauses automation instead of bootstrapping orders", () => {
  const server = read("server.js");
  const resetMatch = server.match(/async function resetSimulation\([^)]*\) \{([\s\S]*?)\n\}/);
  assert.ok(resetMatch, "resetSimulation should exist");
  const resetBody = resetMatch[1];
  const bootstrapMatch = server.match(/async function bootstrapHistoricalTrades\([^)]*\) \{([\s\S]*?)\n\s*await refreshMarket/);
  assert.ok(bootstrapMatch, "bootstrapHistoricalTrades should exist");
  const bootstrapBody = bootstrapMatch[1];

  assert.doesNotMatch(resetBody, /bootstrapHistoricalTrades\(/, "manual reset must not create historical trades immediately");
  assert.doesNotMatch(resetBody, /botTick\(/, "manual reset must not immediately run the trading loop");
  assert.match(resetBody, /state\.bot\.active\s*=\s*false/, "manual reset should pause the bot until the user resumes it");
  assert.match(resetBody, /paused-after-reset/, "manual reset should keep a distinct paused-after-reset state");
  assert.match(resetBody, /manualResetAt/, "manual reset should stamp a reset marker for stale client-backup rejection");
  assert.match(bootstrapBody, /paused-after-reset/, "startup bootstrap must not backfill orders after a saved manual reset");
  assert.match(bootstrapBody, /manualResetAt/, "startup bootstrap must also respect reset markers preserved through market errors");
  assert.match(server, /stale-client-backup-after-reset/, "server should reject old browser backups after manual reset");
  assert.match(server, /keepResetPause/, "market refresh errors should not hide the reset-paused state");
});
