// Daily prod pairing canary (beads-tavc.17). Proves the "bring your own agent"
// door still opens, so a break is caught in a day, not a week (tavc.15 was dark
// for 7). Two checks against PROD:
//   1) a real cold pair over the default durable relay — the published package
//      as the agent + a native-ws tab, through want:tools -> tools -> a tool
//      call round-trip. No browser: this exercises the relay + the package end
//      to end (the path tavc.15 broke). It does NOT cover the browser kernel.
//   2) the relay Lambda's 24h Errors (CloudWatch, best-effort — needs AWS creds
//      in ~/.aws; skipped with a note if unavailable).
// Exit 0 = healthy, 1 = a check failed (reason on stdout). run-canary.sh turns a
// non-zero exit into a paw DM to vibeos-ceo. Point --relay at a dead url to
// prove the alert fires (the pair probe then fails).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";

const RELAY = process.env.CANARY_RELAY || "wss://2yetm9bvy2.execute-api.us-east-1.amazonaws.com/prod";
const FN = process.env.CANARY_FN || "vibeos-mcp-relay";
const REGION = process.env.CANARY_REGION || "us-east-1";
const PKG = process.env.CANARY_PKG || "vibeos-mcp@latest";
const PAIR_TIMEOUT_MS = Number(process.env.CANARY_PAIR_TIMEOUT_MS) || 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];

// --- check 1: a real cold pair over the relay ---
async function pairProbe() {
  const token = randomBytes(32).toString("hex");
  const home = mkdtempSync(join(tmpdir(), "canary-"));
  const TOOL = { name: "canary_ping", description: "canary health probe", parameters: { type: "object", properties: {}, required: [] } };
  let tab, child;
  const cleanup = () => { try { tab?.close(); } catch {} try { child?.kill(); } catch {} try { rmSync(home, { recursive: true, force: true }); } catch {} };
  try {
    // native-ws "tab": attaches, answers want:tools, answers the tool call.
    tab = new WebSocket(RELAY);
    const tabReady = new Promise((res, rej) => { tab.on("open", res); tab.on("error", rej); });
    await Promise.race([tabReady, sleep(15000).then(() => { throw new Error("tab ws never opened (relay unreachable?)"); })]);
    tab.send(JSON.stringify({ hello: "tab", token, test: 1 })); // marks this pair as our own, so the HN agent-only/paired read drops it (beads-1vu7)
    tab.send(JSON.stringify({ tools: [TOOL], instructions: "canary" })); // unsolicited, per the contract
    tab.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.want === "tools") tab.send(JSON.stringify({ tools: [TOOL], instructions: "canary" }));
      else if (m.id != null && typeof m.tool === "string") tab.send(JSON.stringify({ id: m.id, result: m.tool === "canary_ping" ? "pong" : "unknown" }));
    });

    // the real published package as the agent, over stdio MCP
    child = spawn("npx", ["-y", PKG, "--token", token, "--relay", RELAY], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, VIBEOS_HOME: home } });
    let buf = ""; const waiters = new Map();
    child.stdout.on("data", (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue; let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
      }
    });
    let id = 0;
    const rpc = (method, params, ms = 20000) => {
      const n = ++id;
      const p = new Promise((r) => waiters.set(n, r));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      return Promise.race([p, sleep(ms).then(() => ({ hung: true }))]);
    };
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "relay-canary", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const deadline = Date.now() + PAIR_TIMEOUT_MS;
    let paired = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      const list = await rpc("tools/list", {}, 8000);
      const names = (list.result?.tools || []).map((t) => t.name);
      if (names.includes("canary_ping")) { paired = true; break; }
    }
    if (!paired) { fails.push(`pair probe: no tab schemas within ${Math.round(PAIR_TIMEOUT_MS / 1000)}s (relay ${RELAY})`); return; }
    const call = await rpc("tools/call", { name: "canary_ping", arguments: {} }, 15000);
    const text = call.result?.content?.[0]?.text ?? "";
    if (call.hung || call.result?.isError || text !== "pong") fails.push(`pair probe: tool call did not round-trip (got ${JSON.stringify(call.hung ? "hung" : text).slice(0, 80)})`);
  } catch (e) {
    fails.push(`pair probe: ${e.message}`);
  } finally {
    cleanup();
  }
}

// --- check 2: relay Lambda error RATE over a recent window (best-effort) ---
// A recent window, not 24h: the canary asks "is the door erroring NOW", so a
// resolved past spike (e.g. a fix deployed 6h ago) must not alert. A rate catches
// a sustained break (tavc.15 ran ~1-2% all week) while ignoring a stray error.
const ERR_WINDOW_H = Number(process.env.CANARY_ERR_WINDOW_H) || 3;
function errorCheck() {
  const end = new Date();
  const start = new Date(end.getTime() - ERR_WINDOW_H * 3600 * 1000);
  const q = (metric, stat) => {
    const r = spawnSync("aws", ["cloudwatch", "get-metric-statistics", "--region", REGION, "--namespace", "AWS/Lambda",
      "--metric-name", metric, "--dimensions", `Name=FunctionName,Value=${FN}`,
      "--start-time", start.toISOString(), "--end-time", end.toISOString(), "--period", "86400",
      "--statistics", stat, "--query", `sum(Datapoints[].${stat})`, "--output", "text"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const v = (r.stdout || "").trim();
    return v === "None" || v === "" ? 0 : Number(v);
  };
  const errors = q("Errors", "Sum");
  if (errors === null) { console.log("note: CloudWatch error check skipped (no AWS creds / query failed)"); return; }
  const inv = q("Invocations", "Sum") ?? 0;
  const rate = inv > 0 ? errors / inv : 0;
  console.log(`relay last ${ERR_WINDOW_H}h: errors=${errors} invocations=${inv} rate=${(rate * 100).toFixed(2)}%`);
  if (errors >= 5 && rate > 0.01) fails.push(`relay Lambda error rate elevated: ${errors}/${inv} in ${ERR_WINDOW_H}h (${(rate * 100).toFixed(2)}%)`);
}

await pairProbe();
errorCheck();

if (fails.length) { console.log("CANARY FAIL: " + fails.join(" | ")); process.exit(1); }
console.log(`CANARY OK (pair + relay errors healthy, relay ${RELAY})`);
process.exit(0);
