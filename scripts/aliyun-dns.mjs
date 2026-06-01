import crypto from "node:crypto";

const ENDPOINT = "https://alidns.aliyuncs.com/";
const API_VERSION = "2015-01-09";

const DEFAULT_RECORDS = [
  { rr: "@", type: "A", value: "216.24.57.1" },
];

function usage() {
  return [
    "Usage:",
    "  node scripts/aliyun-dns.mjs --domain weisu.pw --render-host your-service.onrender.com [--apply]",
    "",
    "Environment:",
    "  ALIYUN_ACCESS_KEY_ID      temporary AccessKey ID",
    "  ALIYUN_ACCESS_KEY_SECRET  temporary AccessKey secret",
    "",
    "Behavior:",
    "  Without --apply, prints the planned changes only.",
    "  With --apply, creates or updates @ A and www CNAME records.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { apply: false, domain: "weisu.pw", renderHost: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--apply") {
      args.apply = true;
    } else if (item === "--domain") {
      args.domain = argv[++i] || "";
    } else if (item === "--render-host") {
      args.renderHost = (argv[++i] || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    } else if (item === "--help" || item === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nonce() {
  return crypto.randomBytes(16).toString("hex");
}

function signParams(params, accessKeySecret) {
  const canonicalizedQuery = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");
  const stringToSign = `GET&%2F&${percentEncode(canonicalizedQuery)}`;
  return crypto
    .createHmac("sha1", `${accessKeySecret}&`)
    .update(stringToSign)
    .digest("base64");
}

async function callAliDns(action, input = {}) {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    throw new Error("Missing ALIYUN_ACCESS_KEY_ID or ALIYUN_ACCESS_KEY_SECRET.");
  }

  const params = {
    Format: "JSON",
    Version: API_VERSION,
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    Timestamp: timestamp(),
    SignatureVersion: "1.0",
    SignatureNonce: nonce(),
    Action: action,
    ...input,
  };
  params.Signature = signParams(params, accessKeySecret);

  const url = `${ENDPOINT}?${Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&")}`;

  const response = await fetch(url, {
    headers: { "user-agent": "WeiSu-AI-DNS-Setup/1.0" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.Code) {
    throw new Error(`${action} failed: ${body.Code || response.status} ${body.Message || response.statusText}`);
  }
  return body;
}

function normalizeRecords(payload) {
  const records = payload?.DomainRecords?.Record;
  if (!records) return [];
  return Array.isArray(records) ? records : [records];
}

async function listRecords(domain) {
  const all = [];
  let pageNumber = 1;
  for (;;) {
    const payload = await callAliDns("DescribeDomainRecords", {
      DomainName: domain,
      PageNumber: pageNumber,
      PageSize: 100,
    });
    const records = normalizeRecords(payload);
    all.push(...records);
    const total = Number(payload.TotalCount || records.length);
    if (pageNumber * 100 >= total || !records.length) break;
    pageNumber += 1;
  }
  return all;
}

function planChanges(existing, desired) {
  return desired.map((target) => {
    const sameType = existing.find((record) => record.RR === target.rr && record.Type === target.type);
    const conflicts = existing.filter((record) => (
      record.RR === target.rr &&
      record.Type !== target.type &&
      ["A", "AAAA", "CNAME"].includes(record.Type)
    ));

    if (sameType && sameType.Value === target.value) {
      return { action: "skip", target, recordId: sameType.RecordId, conflicts };
    }
    if (sameType) {
      return { action: "update", target, recordId: sameType.RecordId, from: sameType.Value, conflicts };
    }
    return { action: "add", target, conflicts };
  });
}

async function applyChange(domain, change) {
  const { target } = change;
  if (change.action === "skip") return { ...change, applied: false };

  if (change.action === "update") {
    await callAliDns("UpdateDomainRecord", {
      RecordId: change.recordId,
      RR: target.rr,
      Type: target.type,
      Value: target.value,
    });
    return { ...change, applied: true };
  }

  await callAliDns("AddDomainRecord", {
    DomainName: domain,
    RR: target.rr,
    Type: target.type,
    Value: target.value,
  });
  return { ...change, applied: true };
}

function summarizePlan(plan) {
  return plan.map((item) => {
    const base = `${item.action.toUpperCase()} ${item.target.rr} ${item.target.type} ${item.target.value}`;
    const from = item.from ? ` from ${item.from}` : "";
    const conflicts = item.conflicts?.length
      ? `; conflicts: ${item.conflicts.map((record) => `${record.RR} ${record.Type} ${record.Value}`).join(", ")}`
      : "";
    return `${base}${from}${conflicts}`;
  }).join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.domain) throw new Error("Missing --domain.");
  if (!args.renderHost) throw new Error("Missing --render-host. Use the real Render *.onrender.com host.");

  const desired = [
    ...DEFAULT_RECORDS,
    { rr: "www", type: "CNAME", value: args.renderHost },
  ];

  const existing = await listRecords(args.domain);
  const plan = planChanges(existing, desired);
  console.log(summarizePlan(plan));

  if (!args.apply) {
    console.log("\nDry run only. Re-run with --apply to create or update these records.");
    return;
  }

  const results = [];
  for (const change of plan) {
    results.push(await applyChange(args.domain, change));
  }
  console.log("\nApplied:");
  console.log(summarizePlan(results.filter((item) => item.applied)));
  const skipped = results.filter((item) => !item.applied);
  if (skipped.length) {
    console.log("\nAlready correct:");
    console.log(summarizePlan(skipped));
  }
}

main().catch((error) => {
  console.error(error.message);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
});
