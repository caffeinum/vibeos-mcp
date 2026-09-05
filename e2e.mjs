/**
 * End-to-end: a real relay, a fake tab, and this package driven over real MCP
 * stdio. Proves frames actually round-trip — a server that starts proves nothing.
 */
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";

const TOKEN = "c".repeat(64);
const BYE_TOKEN = "e".repeat(64);
const pairs = new Map();
const dials = new Map();

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
      dials.set(token, (dials.get(token) ?? 0) + 1);
      const peer = side === "tab" ? pair.agent : pair.tab;
      ws.send(JSON.stringify({ paired: !!peer, instance: "e2e-1" }));
      // API Gateway cannot send custom close codes: the relay says bye in-band
      // and then closes normally. Must read as revoked, and must not redial.
      if (token === BYE_TOKEN && side === "agent") {
        setTimeout(() => { ws.send(JSON.stringify({ bye: 4003, reason: "revoked" })); ws.close(1000); }, 300);
      }
      return;
    }
    const msg = JSON.parse(data);
    if (typeof msg.ping === "number") {
      // The relay answers pings itself and never forwards them (fix/relay-heartbeat).
      ws.send(JSON.stringify({ pong: msg.ping, instance: "e2e-1" }));
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
const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
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
  if (msg.tool === "freeze") return; // a busy main thread: no answer, ever
  if (msg.tool === "vm_exec") tab.send(JSON.stringify({ id: msg.id, result: `ran: ${msg.input.command}` }));
  else if (msg.tool === "read_desktop" && msg.input.alt) tab.send(JSON.stringify({ id: msg.id, result: { ok: true, image: { mimeType: "image/jpeg", data: PNG1 }, width: 2, height: 2 } }));
  else if (msg.tool === "read_desktop") tab.send(JSON.stringify({ id: msg.id, result: { ok: true, windows: [{ title: "Notes", z: 1 }], screen: { mime: "image/png", base64: PNG1, width: 1, height: 1 }, window: { title: "Notes", text: { mime: "text/plain", text: "hello from notes" } } } }));
  else tab.send(JSON.stringify({ id: msg.id, result: "notes.js, paint.js" }));
});

// --- the package, over real MCP stdio ---
const child = spawn("node", ["index.mjs", "--token", TOKEN, "--relay", url], {
  cwd: import.meta.dirname, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, VIBEOS_CALL_TIMEOUT_MS: "1500" },
});
const wire = (child) => {
  let buf = "";
  const waiters = new Map();
  const notifications = [];
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id == null && msg.method) notifications.push(msg.method);
      if (waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  const rpc = (id, method, params) => {
    const p = new Promise((r) => waiters.set(id, r));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  };
  return { rpc, notifications };
};
const { rpc } = wire(child);

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

const shot = await rpc(31, "tools/call", { name: "read_desktop", arguments: {} });
const c = shot.result?.content ?? [];
check("{mime,base64} anywhere in a result becomes MCP image content",
  c[1]?.type === "image" && c[1].mimeType === "image/png" && c[1].data === PNG1, JSON.stringify(c).slice(0, 200));
check("{mime:text/plain,text} becomes a text block; the JSON keeps markers, width, windows, no base64",
  c[2]?.type === "text" && c[2].text === "hello from notes" && /"screen":\{[^}]*"width":1[^}]*"content":"\[image 1\]"/.test(c[0]?.text ?? "") && /"windows":\[\{"title":"Notes"/.test(c[0]?.text ?? "") && !c[0].text.includes(PNG1),
  c[0]?.text?.slice(0, 300));

const shot2 = await rpc(32, "tools/call", { name: "read_desktop", arguments: { alt: true } });
check("image:{mimeType,data} is lifted too",
  shot2.result?.content?.[1]?.type === "image" && shot2.result.content[1].mimeType === "image/jpeg" && /"width":2/.test(shot2.result.content[0]?.text ?? ""), JSON.stringify(shot2.result).slice(0, 200));

const tf = Date.now();
const frozen = await rpc(33, "tools/call", { name: "freeze", arguments: {} });
check("a tab that never answers fails the call at the deadline, as a tool error",
  Date.now() - tf < 4000 && frozen.result?.isError && /did not answer freeze within 2 s/.test(frozen.result?.content?.[0]?.text ?? ""), `${Date.now() - tf}ms ${JSON.stringify(frozen).slice(0, 160)}`);
const stillAlive = await rpc(34, "tools/call", { name: "list_apps", arguments: {} });
check("and the next call on the same socket still works", stillAlive.result?.content?.[0]?.text === "notes.js, paint.js", JSON.stringify(stillAlive).slice(0, 120));

// the failure that matters: tab gone must error, not hang
tab.close();
await new Promise((r) => setTimeout(r, 200));
const orphan = await Promise.race([
  rpc(4, "tools/call", { name: "list_apps", arguments: {} }),
  new Promise((r) => setTimeout(() => r({ hung: true }), 8000)),
]);
check("a call with no tab errors instead of hanging, as a tool error result the model can act on", !orphan.hung && orphan.result?.isError && /peer not connected|no vibeOS tab/.test(orphan.result?.content?.[0]?.text ?? ""), JSON.stringify(orphan).slice(0, 160));

child.kill();

// --- the other order: the agent asks before any tab exists. Claude Code gives
// up on a slow tools/list and shows the server as broken, so the answer must be
// fast and empty, and list_changed must follow once the tab pairs.
const TOKEN2 = "d".repeat(64);
const child2 = spawn("node", ["index.mjs", "--token", TOKEN2, "--relay", url], {
  cwd: import.meta.dirname, stdio: ["pipe", "pipe", "inherit"],
});
const w2 = wire(child2);
await w2.rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
child2.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const t0 = Date.now();
const empty = await w2.rpc(2, "tools/list", {});
check("tools/list with no tab answers fast and empty, not an error",
  Date.now() - t0 < 3500 && Array.isArray(empty.result?.tools) && empty.result.tools.length === 0,
  `${Date.now() - t0}ms ${JSON.stringify(empty).slice(0, 120)}`);
const noTabCall = await w2.rpc(3, "tools/call", { name: "list_apps", arguments: {} });
check("tools/call with no tab names the relay instance",
  noTabCall.result?.isError && /no vibeOS tab.*e2e-1/.test(noTabCall.result?.content?.[0]?.text ?? ""),
  JSON.stringify(noTabCall).slice(0, 160));

const tab2 = new WebSocket(url);
await new Promise((r) => tab2.on("open", r));
tab2.send(JSON.stringify({ hello: "tab", token: TOKEN2 }));
tab2.on("message", (raw) => {
  const msg = JSON.parse(raw.toString("utf8"));
  if (msg.want === "tools") tab2.send(JSON.stringify({ tools: TOOLS }));
});
// the agent asked at ITS connect, before this tab existed; the tab's own
// unsolicited send is what must reach it now
tab2.send(JSON.stringify({ tools: TOOLS }));
await new Promise((r) => setTimeout(r, 500));
check("list_changed is sent once the tab's schemas arrive",
  w2.notifications.includes("notifications/tools/list_changed"), JSON.stringify(w2.notifications));
const after = await w2.rpc(4, "tools/list", {});
check("tools/list after the tab pairs has the tools",
  (after.result?.tools ?? []).map((t) => t.name).join(",") === "list_apps,vm_exec", JSON.stringify(after).slice(0, 120));

// --- bye frame instead of a close code, and a dead first relay url
const child3 = spawn("node", ["index.mjs", "--token", BYE_TOKEN, "--relay", `ws://127.0.0.1:1/dead,${url}`], {
  cwd: import.meta.dirname, stdio: ["pipe", "pipe", "pipe"],
});
let err3 = "";
child3.stderr.on("data", (d) => { err3 += d; });
const w3 = wire(child3);
await w3.rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
child3.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const inflightP = w3.rpc(9, "tools/call", { name: "list_apps", arguments: {} });
await new Promise((r) => setTimeout(r, 2500));
const inflight3 = await inflightP;
check("an unreachable first relay falls through to the next", /unreachable, trying ws:\/\/127\.0\.0\.1/.test(err3) && (dials.get(BYE_TOKEN) ?? 0) >= 1, err3.slice(0, 200));
const revoked = await w3.rpc(2, "tools/call", { name: "list_apps", arguments: {} });
check("a bye:4003 frame reads as revoked", revoked.result?.isError && /revoked/.test(revoked.result?.content?.[0]?.text ?? ""), JSON.stringify(revoked).slice(0, 160));
check("in-flight call at the bye got the reason, not 'disconnected mid-call'", !/disconnected mid-call/.test(JSON.stringify(inflight3)), JSON.stringify(inflight3).slice(0, 160));
check("and is final: no redial after bye", dials.get(BYE_TOKEN) === 1, `dials=${dials.get(BYE_TOKEN)}`);

const big = await w2.rpc(5, "tools/call", { name: "vm_exec", arguments: { command: "x".repeat(130 * 1024) } });
check("a call over 128 KB is refused with the size, not sent", big.result?.isError && /exceeds the relay's 131072 byte limit/.test(big.result?.content?.[0]?.text ?? ""), JSON.stringify(big).slice(0, 160));

child2.kill(); tab2.close(); child3.kill(); wss.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
