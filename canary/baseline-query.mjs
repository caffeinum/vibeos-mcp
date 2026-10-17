// Pre-HN baseline (beads-1vu7, asked by yc): the daily agent-only vs paired
// tokenKey counts from the relay hello log, for the two UTC days before the HN
// launch (2026-10-17 and 2026-10-18), with our own harnesses (test:1) excluded.
// Read-only — it creates no pairs. Scheduled Sunday night by the launchd agent
// sh.vibeos.mcp.baseline; DMs the result to vibeos-yc over the cotal mesh.
import { spawnSync } from "node:child_process";

const REGION = process.env.BASELINE_REGION || "us-east-1";
const GROUP = "/aws/lambda/vibeos-mcp-relay";
const AWS = "/opt/homebrew/bin/aws";
const PAW = process.env.PAW_BIN || "paw";
const TO = process.env.BASELINE_TO || "vibeos-yc";

// Absolute UTC window: 2026-10-17 00:00Z .. 2026-10-19 00:00Z (covers both days).
const START = Math.floor(Date.UTC(2026, 9, 17, 0, 0, 0) / 1000);
const END = Math.floor(Date.UTC(2026, 9, 19, 0, 0, 0) / 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two-stage per-tokenKey rollup, test-excluded, bucketed by UTC day.
const Q_AGENT = "filter ev='hello' | stats max(side='agent') as a, max(test) as t by tk, bin(1d) as day | filter t=0 and a=1 | stats count(*) as n by day";
const Q_PAIRED = "filter ev='hello' | stats max(paired) as p, max(test) as t by tk, bin(1d) as day | filter t=0 and p=1 | stats count(*) as n by day";

async function run(q) {
  const start = spawnSync(AWS, ["logs", "start-query", "--region", REGION, "--log-group-name", GROUP,
    "--start-time", String(START), "--end-time", String(END), "--query-string", q, "--query", "queryId", "--output", "text"], { encoding: "utf8" });
  if (start.status !== 0) throw new Error("start-query failed: " + (start.stderr || "").trim());
  const qid = (start.stdout || "").trim();
  for (let i = 0; i < 15; i++) {
    await sleep(3000);
    const res = spawnSync(AWS, ["logs", "get-query-results", "--region", REGION, "--query-id", qid, "--output", "json"], { encoding: "utf8" });
    if (res.status !== 0) continue;
    const j = JSON.parse(res.stdout);
    if (j.status !== "Complete") continue;
    const byDay = {};
    for (const row of j.results) {
      const o = {};
      for (const f of row) o[f.field.replace("@", "")] = f.value;
      if (o.day) byDay[o.day.slice(0, 10)] = Number(o.n);
    }
    return byDay;
  }
  throw new Error("query did not complete: " + q.slice(0, 40));
}

const agent = await run(Q_AGENT);
const paired = await run(Q_PAIRED);
const days = ["2026-10-17", "2026-10-18"];
const lines = days.map((d) => {
  const a = agent[d] || 0, p = paired[d] || 0;
  return `${d}: agent=${a} paired=${p} agent-only=${a - p}`;
});
const msg = [
  "📊 vibeos-mcp relay pre-HN baseline (UTC days, our harnesses excluded via test:1):",
  ...lines,
  "agent=ran npx; paired=desktop paired; agent-only=ran but never opened the #pair link. (beads-1vu7)",
].join("\n");

console.log(new Date().toISOString());
console.log(msg);
const dm = spawnSync(PAW, ["dm", TO, msg], { encoding: "utf8" });
console.log("paw dm status=" + dm.status + " " + ((dm.stdout || "") + (dm.stderr || "")).trim());
process.exit(dm.status === 0 ? 0 : 1);
