#!/usr/bin/env node
/**
 * vibeos-mcp — an MCP server that hands your own agent the vibeOS desktop.
 *
 * The desktop lives in a browser tab, which cannot listen for connections. So
 * this dials the relay on vibeos.sh, the tab dials the same relay with the same
 * token, and the two are paired. This process speaks MCP over stdio to whatever
 * spawned it (Claude Code, Cursor, Codex) and forwards each call to the tab.
 *
 *   claude mcp add vibeos -- npx vibeos-mcp --token <token>
 *
 * The tool list is not hardcoded: the tab sends its TOOL_SCHEMAS on connect, so
 * a tool added to the desktop appears here without shipping a new version, and
 * this cannot drift from what the desktop actually implements.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { RelaySocket, FRAME_MAX_BYTES } from "./relay-socket.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const token = flag("--token") ?? process.env.VIBEOS_TOKEN;
// Comma-separated, in order of preference: a relay that cannot be reached at
// all falls through to the next. One url by default until the durable relay
// is announced.
// The durable relay (API Gateway + DynamoDB, no instance affinity) first; the
// vercel function, which pairs in memory per instance, only as a fallback.
const DEFAULT_RELAYS = "wss://2yetm9bvy2.execute-api.us-east-1.amazonaws.com/prod,wss://vibeos.sh/api/mcp/relay";
const relayUrls = (flag("--relay") ?? process.env.VIBEOS_RELAY ?? DEFAULT_RELAYS)
  .split(",").map((u) => u.trim()).filter(Boolean);

if (!token || !/^[0-9a-f]{64}$/.test(token)) {
  // stderr, not stdout: stdout is the MCP transport and any stray byte there
  // corrupts the protocol.
  process.stderr.write(
    "vibeos-mcp: --token must be the 64-hex token from Settings > Capabilities\n"
  );
  process.exit(2);
}

if (process.stdin.isTTY) {
  // Run by hand in a terminal, not by an MCP client: it would sit waiting for
  // JSON-RPC on stdin forever and look hung. Say so, keep running anyway.
  process.stderr.write(
    "vibeos-mcp: this is an MCP server — it speaks to a client over stdin, " +
    "not to you. Register it instead:\n" +
    `  claude mcp add vibeos -- npx vibeos-mcp --token ${token}\n` +
    "(Cursor/Codex: same command in their MCP config.) Ctrl-C to quit.\n"
  );
}

/** Tool calls awaiting an answer from the tab, by id. */
const pending = new Map();
let nextId = 1;
let toolSchemas = [];
let sawSchemas = null;
/** What the relay last said about the tab: paired or not, on which instance. */
let paired = false;
let relayInstance = undefined;
const noTab = () =>
  `no vibeOS tab is paired with this token${relayInstance ? ` (relay instance ${relayInstance} — the Capabilities pane must show the same one)` : ""} — open vibeos.sh/app › Settings › Capabilities`;
/**
 * Resolves once the relay has answered the hello (so `paired` means
 * something) or the tab's schemas have arrived, or after `ms`. A client like
 * mcpt sends its first call right after initialize, ~1.5 s before the relay
 * dial completes, and must not be told "no tab" for that.
 */
let settleWaiters = [];
const settled = (ms) => {
  if (paired || toolSchemas.length || relayInstance !== undefined || helloSeen) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { settleWaiters = settleWaiters.filter((w) => w !== done); resolve(); }, ms);
    const done = () => { clearTimeout(timer); resolve(); };
    settleWaiters.push(done);
  });
};
const settle = () => { for (const w of settleWaiters.splice(0)) w(); };
let helloSeen = false;
// The MCP client's name, once initialize has run: the tab's pane says
// "claude-code is connected" rather than "an agent".
let agentName = "";
/** Set when the desktop revoked the token: every later call fails with this. */
let ended = null;
const askForTools = () => socket.send(JSON.stringify({ want: "tools", agent: agentName }));

/**
 * A call fails rather than hanging when the tab goes away. An MCP client that
 * is waiting forever looks identical to one doing slow work, and the user has
 * no way to tell — so every path here ends in an answer or an error.
 */
function failAll(reason) {
  for (const [id, slot] of pending) {
    slot.reject(new Error(reason));
    pending.delete(id);
  }
}

const socket = new RelaySocket(relayUrls, {
  onWarn: (text) => process.stderr.write(`vibeos-mcp: ${text}\n`),
  hello: { hello: "agent", token },
  onGap: (open) => {
    if (open) {
      // Ask for the tool list on every (re)connect. The tab sends its schemas
      // unsolicited when IT connects, which is useless to us if we paired
      // afterwards — or reconnected after an 800 s cut, which happens roughly
      // every 13 minutes and would otherwise leave tools/list empty forever.
      askForTools();
      return;
    }
    if (!open) {
      // The relay closes every ~800 s by design. In-flight calls cannot survive
      // it: the tab may have run the tool, but the answer is gone.
      failAll("vibeos relay disconnected mid-call (the desktop may still have run it)");
    }
  },
  onHello: ({ paired: isPaired, instance }) => {
    paired = isPaired;
    relayInstance = instance;
    helloSeen = true;
    settle();
    process.stderr.write(
      `vibeos-mcp: relay connected, tab paired: ${isPaired ? "yes" : "no"}, relay instance ${instance ?? "(unreported)"}\n`
    );
  },
  onEnd: (reason) => {
    ended = reason;
    toolSchemas = [];
    failAll(`vibeos: ${reason}`);
  },
  onFrame: (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (Array.isArray(msg?.tools)) {
      if (Buffer.byteLength(raw) > FRAME_MAX_BYTES * 0.9) {
        process.stderr.write(`vibeos-mcp: the tab's tool list is ${Buffer.byteLength(raw)} bytes, near the relay's ${FRAME_MAX_BYTES} byte frame limit\n`);
      }
      const changed = JSON.stringify(msg.tools) !== JSON.stringify(toolSchemas);
      toolSchemas = msg.tools;
      paired = true;
      sawSchemas?.();
      settle();
      // A client that asked before the tab answered got an empty list; this
      // tells it to ask again rather than cache "no tools" for the session.
      if (changed && initialized) server.sendToolListChanged().catch(() => {});
      return;
    }
    if (msg?.error && msg?.code) {
      if (msg.code === 4002) paired = false;
      if (msg.code === 5000) process.stderr.write(`vibeos-mcp: ${msg.error} — in-flight calls failed\n`);
      failAll(`vibeos relay: ${msg.error}`);
      return;
    }
    if (msg?.id != null && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      pending.delete(msg.id);
      slot.resolve(msg);
    }
  },
});

const server = new Server(
  { name: "vibeos", version: "0.1.11" },
  { capabilities: { tools: { listChanged: true } } }
);
let initialized = false;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (ended) throw new Error(`vibeos: ${ended}`);
  if (!toolSchemas.length) {
    // Give the tab a moment to answer `want:tools` — the relay dial takes
    // ~1.5 s — but not long: Claude Code gives up on tools/list well before
    // 5 s and then shows the server as broken. Past that, answer with what we
    // have and send list_changed when the tab's schemas arrive.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      sawSchemas = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    sawSchemas = null;
  }
  if (!toolSchemas.length) {
    process.stderr.write(`vibeos-mcp: tools/list with no tab schemas yet — ${noTab()}\n`);
    return { tools: [] };
  }
  // `parameters` passes through as `inputSchema` unchanged: one source of truth
  // for the tool surface, no second API to keep in sync.
  return {
    tools: toolSchemas.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
  };
});

function liftMedia(value, blocks) {
  if (!value || typeof value !== "object") return value;
  // Both spellings the tab has used: {mime, base64} and {mimeType, data}.
  if (typeof value.mime === "string" && typeof value.base64 === "string") {
    blocks.push({ type: "image", data: value.base64, mimeType: value.mime });
    const { base64, ...rest } = value;
    return { ...rest, content: `[image ${blocks.length}]` };
  }
  if (typeof value.mimeType === "string" && value.mimeType.startsWith("image/") && typeof value.data === "string") {
    blocks.push({ type: "image", data: value.data, mimeType: value.mimeType });
    const { data, ...rest } = value;
    return { ...rest, content: `[image ${blocks.length}]` };
  }
  if (value.mime === "text/plain" && typeof value.text === "string") {
    blocks.push({ type: "text", text: value.text });
    const { text, ...rest } = value;
    return { ...rest, content: `[text ${blocks.length}]` };
  }
  if (Array.isArray(value)) return value.map((v) => liftMedia(v, blocks));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = liftMedia(v, blocks);
  return out;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (ended) return { content: [{ type: "text", text: `vibeos: ${ended}` }], isError: true };
  await settled(3000);
  if (!paired && !toolSchemas.length) {
    return { content: [{ type: "text", text: noTab() }], isError: true };
  }
  const id = nextId++;
  const answer = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });

  try {
    socket.send(
      JSON.stringify({ id, tool: request.params.name, input: request.params.arguments ?? {} })
    );
  } catch (e) {
    pending.delete(id);
    return { content: [{ type: "text", text: `vibeos: ${e.message}` }], isError: true };
  }

  // A relay gap or a final close rejects the pending call; the model reads a
  // tool error result and can retry, while a protocol-level error is only
  // shown to the user. Text is the same reason either way.
  let msg;
  try {
    msg = await answer;
  } catch (e) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
  if (msg.error) {
    return { content: [{ type: "text", text: String(msg.error) }], isError: true };
  }
  const result = msg.result ?? msg.output ?? "";
  // Media in a result — any {mime, base64} or {mimeType, data} object, at any depth, e.g.
  // read_desktop's screen — reaches the client as MCP image content, which
  // Claude Code renders; {mime:'text/plain', text} becomes a text block. Each
  // is replaced in the JSON by a marker so the surrounding fields keep their
  // place and nothing is sent as a data: url in text.
  const blocks = [];
  const lifted = liftMedia(result, blocks);
  if (blocks.length) {
    return { content: [{ type: "text", text: JSON.stringify(lifted) }, ...blocks] };
  }
  return {
    content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
  };
});

server.oninitialized = () => {
  initialized = true;
  agentName = server.getClientVersion()?.name ?? "";
  askForTools();
};

process.on("SIGINT", () => {
  socket.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
