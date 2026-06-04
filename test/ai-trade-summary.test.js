const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("ai settlement summaries call out event-contract specific miss patterns", () => {
  const server = read("server.js");

  assert.match(server, /buildTradeSummaryV4/, "server should route AI summaries through the upgraded formatter");
  assert.match(server, /middleRangeEntry/, "summaries should distinguish middle-of-range entries");
  assert.match(server, /方向看对但赔率边际不值/, "summaries should distinguish right-direction but poor payout-edge outcomes");
  assert.match(server, /结构中段/, "summaries should flag entering from the middle of the range");
  assert.match(server, /触发太晚/, "summaries should flag triggers that arrive too late in the event window");
  assert.match(server, /假突破后回到原结构内/, "summaries should call out false breakouts that fall back into prior structure");
});
