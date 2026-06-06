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

test("manual reset clears history and immediately resumes scanning without bootstrapping orders", () => {
  const server = read("server.js");
  const resetMatch = server.match(/async function resetSimulation\([^)]*\) \{([\s\S]*?)\n\}/);
  assert.ok(resetMatch, "resetSimulation should exist");
  const resetBody = resetMatch[1];
  const bootstrapMatch = server.match(/async function bootstrapHistoricalTrades\([^)]*\) \{([\s\S]*?)\n\s*await refreshMarket/);
  assert.ok(bootstrapMatch, "bootstrapHistoricalTrades should exist");
  const bootstrapBody = bootstrapMatch[1];

  assert.doesNotMatch(resetBody, /bootstrapHistoricalTrades\(/, "manual reset must not create historical trades immediately");
  assert.doesNotMatch(resetBody, /botTick\(/, "manual reset must not immediately run the trading loop");
  assert.match(resetBody, /state\.bot\.active\s*=\s*true/, "manual reset should keep the bot scanning after the reset");
  assert.match(resetBody, /waiting-live-cycle/, "manual reset should return to live scanning status");
  assert.doesNotMatch(resetBody, /paused-after-reset/, "manual reset should not create a reset-pause state anymore");
  assert.match(resetBody, /manualResetAt/, "manual reset should stamp a reset marker for stale client-backup rejection");
  assert.match(bootstrapBody, /manualResetAt/, "startup bootstrap must also respect reset markers preserved through market errors");
  assert.match(server, /stale-client-backup-after-reset/, "server should reject old browser backups after manual reset");
});

test("automation has no user pause switch and only stops for low balance", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const server = read("server.js");

  assert.doesNotMatch(html, /id="toggleBot"/, "topbar should not expose a pause/resume button");
  assert.doesNotMatch(app, /toggleBot\.addEventListener/, "frontend should not wire a pause/resume action");
  assert.doesNotMatch(server, /url\.pathname === "\/api\/control"/, "backend should not accept manual pause control");
  assert.match(server, /paused-low-balance/, "automation may still stop when balance is below the minimum ticket size");
});
