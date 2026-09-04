/**
 * End-to-end: a real relay, a fake tab, and this package driven over real MCP
 * stdio. Proves frames actually round-trip — a server that starts proves nothing.
 */
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";

const TOKEN = "c".repeat(64);
const pairs = new Map();

// --- the relay, same pairing rules as app/api/mcp/[token]/route.ts ---
const wss = new WebSocketServer({ port: 0 });
wss.on("connection", (ws) => {
  let token = null, side = null;
  ws.on("message", (raw) => {
    const data = raw.toString("utf8");
    if (!token) {
      const hello = JSON.parse(data);
      token = hello.token; side = hello.hello;
      const pair = pairs.get(token) ?? {};
      pair[side] = ws;
      pairs.set(token, pair);
      return;
    }
    const pair = pairs.get(token) ?? {};
    const peer = side === "tab" ? pair.agent : pair.tab;
    if (peer) peer.send(data);
    else ws.send(JSON.stringify({ error: "peer not connected", code: 4002 }));
  });
  // The real route detaches on close. Without this the relay forwards into a
  // dead socket and the agent waits forever — which is what my first run
  // measured: my test relay, not the package.
  ws.on("close", () => {
    const pair = pairs.get(token);
    if (pair && pair[side] === ws) delete pair[side];
  });
});
await new Promise((r) => wss.on("listening", r));
const url = `ws://127.0.0.1:${wss.address().port}/api/mcp/relay`;

// --- the fake tab: sends schemas on connect, answers calls ---
const { WebSocket } = await import("ws");
const tab = new WebSocket(url);
await new Promise((r) => tab.on("open", r));
tab.send(JSON.stringify({ hello: "tab", token: TOKEN }));
const TOOLS = [
  { name: "list_apps", description: "List apps", parameters: { type: "object", properties: {}, required: [] } },
  { name: "vm_exec", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];
// Sent unsolicited at connect, exactly as the design says — and deliberately
// BEFORE the agent exists, so the test proves the agent's request path works.
tab.send(JSON.stringify({ tools: TOOLS }));
tab.on("message", (raw) => {
  const msg = JSON.parse(raw.toString("utf8"));
  // The agent asks on connect, because it may pair long after the tab did and
  // would otherwise never see the schemas the tab sent at its own connect time.
  if (msg.want === "tools") {
    tab.send(JSON.stringify({ tools: TOOLS }));
    return;
  }
  if (msg.id == null) return;
  if (msg.tool === "vm_exec") tab.send(JSON.stringify({ id: msg.id, result: `ran: ${msg.input.command}` }));
  else tab.send(JSON.stringify({ id: msg.id, result: "notes.js, paint.js" }));
});

// --- the package, over real MCP stdio ---
const child = spawn("node", ["index.mjs", "--token", TOKEN, "--relay", url], {
  cwd: import.meta.dirname, stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
const waiters = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});
const rpc = (id, method, params) => {
  const p = new Promise((r) => waiters.set(id, r));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
};

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"}: ${name}${cond ? "" : ` -> ${detail}`}`);
  if (!cond) failures++;
};

await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await rpc(2, "tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name);
check("tools/list comes from the tab, not hardcoded", names.join(",") === "list_apps,vm_exec", JSON.stringify(names));
check("parameters passed through as inputSchema",
  list.result?.tools?.[1]?.inputSchema?.properties?.command?.type === "string",
  JSON.stringify(list.result?.tools?.[1]?.inputSchema));

const call = await rpc(3, "tools/call", { name: "vm_exec", arguments: { command: "uname -m" } });
check("tools/call round-trips through the tab", call.result?.content?.[0]?.text === "ran: uname -m", JSON.stringify(call.result));

// the failure that matters: tab gone must error, not hang
tab.close();
await new Promise((r) => setTimeout(r, 200));
const orphan = await Promise.race([
  rpc(4, "tools/call", { name: "list_apps", arguments: {} }),
  new Promise((r) => setTimeout(() => r({ hung: true }), 8000)),
]);
check("a call with no tab errors instead of hanging", !orphan.hung && (orphan.error || orphan.result?.isError), JSON.stringify(orphan).slice(0, 120));

child.kill(); wss.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
