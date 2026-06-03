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
