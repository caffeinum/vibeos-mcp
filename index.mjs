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
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { RelaySocket, FRAME_MAX_BYTES } from "./relay-socket.mjs";
import { loadToken, mintToken, forgetToken, storePath } from "./token-store.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// Comma-separated, in order of preference: a relay that cannot be reached at
// all falls through to the next. The durable relay (API Gateway + DynamoDB, no
// instance affinity) first; the vercel function, which pairs in memory per
// instance, only as a fallback.
const DEFAULT_RELAYS = "wss://2yetm9bvy2.execute-api.us-east-1.amazonaws.com/prod,wss://vibeos.sh/api/mcp/relay";
const relayUrls = (flag("--relay") ?? process.env.VIBEOS_RELAY ?? DEFAULT_RELAYS)
  .split(",").map((u) => u.trim()).filter(Boolean);
const APP_URL = process.env.VIBEOS_APP ?? "https://vibeos.sh/app";

if (args[0] === "forget") {
  process.stderr.write(forgetToken() ? `vibeos-mcp: forgot the token in ${storePath()}\n` : "vibeos-mcp: no remembered token\n");
  process.exit(0);
}

// Where the token comes from decides what "no tab" means: a token the person
// typed (--token / VIBEOS_TOKEN) belongs to a desktop they already paired; a
// token minted here has no desktop yet, and the way to get one is the link.
const givenToken = flag("--token") ?? process.env.VIBEOS_TOKEN;
if (givenToken !== undefined && !/^[0-9a-f]{64}$/.test(givenToken)) {
  // stderr, not stdout: stdout is the MCP transport and any stray byte there
  // corrupts the protocol.
  process.stderr.write("vibeos-mcp: --token must be the 64-hex token from Settings > Capabilities (or omit it: the link pairs a desktop)\n");
  process.exit(2);
}
const remembered = givenToken ? null : loadToken();
const minted = givenToken || remembered ? null : mintToken();
const token = givenToken ?? remembered?.token ?? minted.token;
const tokenIsOurs = !givenToken;
/** The one link that pairs a desktop to this token; the token rides the fragment, never the wire to vibeos.sh. */
const pairUrl = `${APP_URL}#pair=${token}` +
  (relayUrls[0] !== DEFAULT_RELAYS.split(",")[0] ? `&relay=${encodeURIComponent(relayUrls[0])}` : "");
const pairLine = () =>
  `no vibeOS desktop is paired yet. Open ${pairUrl} in a browser to pair one — an agent with this link is root on that desktop (it can edit the OS and run commands in its machine) for 7 days; the desktop's Settings > Capabilities can forget it.`;

if (process.stdin.isTTY) {
  // Run by hand in a terminal, not by an MCP client. Say what to do; in the
  // no-token case also wait for the desktop to pair, then leave the token
  // remembered for the MCP client to use.
  process.stderr.write(
    tokenIsOurs
      ? `vibeos-mcp: ${minted ? "minted a token" : "using the remembered token"} (${storePath()}).\n` +
        `  pair a desktop:  ${pairUrl}\n` +
        "  then register:   claude mcp add vibeos -- npx vibeos-mcp\n" +
        "waiting for the desktop… (Ctrl-C to quit)\n"
      : "vibeos-mcp: this is an MCP server — it speaks to a client over stdin, not to you. Register it instead:\n" +
        `  claude mcp add vibeos -- npx vibeos-mcp --token ${token}\n` +
        "(Cursor/Codex: same command in their MCP config.) Ctrl-C to quit.\n"
  );
}

/** How long a call may wait for the tab before it fails; tests shorten it. */
const CALL_TIMEOUT_MS = Number(process.env.VIBEOS_CALL_TIMEOUT_MS) || 120_000;

/** Tool calls awaiting an answer from the tab, by id. */
const pending = new Map();
let nextId = 1;
let toolSchemas = [];
let sawSchemas = null;
/** The tab's map of the OS, sent with the tools; the client sees it once, at initialize. */
let instructions = "";
let instructionsLate = false;
/** What the relay last said about the tab: paired or not, on which instance. */
let paired = false;
let relayInstance = undefined;
const noTab = () => tokenIsOurs
  ? pairLine()
  : `no vibeOS tab is paired with this token${relayInstance ? ` (relay instance ${relayInstance} — the Capabilities pane must show the same one)` : ""} — open vibeos.sh/app › Settings › Capabilities`;
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
// `sampling` tells the tab whether this client's model can power the desktop's
// apps (api.ai) when the tab has no model of its own. Known after initialize.
const canSample = () => !!server.getClientCapabilities?.()?.sampling;
const askForTools = () => socket.send(JSON.stringify({ want: "tools", agent: agentName, sampling: canSample(), pairing: tokenIsOurs && !paired && !toolSchemas.length }));

/** How long an app's api.ai ask may wait on the client's model (a human may approve each). */
const ASK_TIMEOUT_MS = Number(process.env.VIBEOS_ASK_TIMEOUT_MS) || 120_000;

/**
 * The tab asks the client's model on behalf of an app: {ask:N, ai:{prompt,
 * images?:[{mime,base64}], json?, system?}} → {ask:N, result} | {ask:N, error}.
 * Only when the client declared the sampling capability; otherwise the error
 * says so and the tab shows its "connect a model" upsell instead.
 */
async function answerAsk(msg) {
  const reply = (body) => socket.send(JSON.stringify({ ask: msg.ask, ...body }));
  const ai = msg.ai ?? {};
  if (!canSample()) {
    return reply({ error: `the connected MCP client (${agentName || "unknown"}) does not support sampling, so it cannot power apps; connect a model in Settings` });
  }
  if (typeof ai.prompt !== "string" || !ai.prompt) return reply({ error: "ai.prompt must be a non-empty string" });
  const content = [{ type: "text", text: ai.json ? `${ai.prompt}\n\nAnswer with JSON only, no prose.` : ai.prompt }];
  for (const img of Array.isArray(ai.images) ? ai.images : []) {
    if (typeof img?.mime === "string" && typeof img?.base64 === "string") content.push({ type: "image", mimeType: img.mime, data: img.base64 });
  }
  try {
    const result = await Promise.race([
      server.createMessage({
        messages: [{ role: "user", content: content.length === 1 ? content[0] : content }],
        ...(typeof ai.system === "string" && ai.system ? { systemPrompt: ai.system } : {}),
        maxTokens: Number.isInteger(ai.maxTokens) ? ai.maxTokens : 2000,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`the client's model did not answer within ${Math.round(ASK_TIMEOUT_MS / 1000)} s`)), ASK_TIMEOUT_MS)),
    ]);
    const parts = Array.isArray(result.content) ? result.content : [result.content];
    const text = parts.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
    reply({ result: text });
  } catch (e) {
    reply({ error: `sampling failed: ${e.message}` });
  }
}

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

    if (msg?.ask != null && msg?.ai) {
      answerAsk(msg);
      return;
    }
    if (Array.isArray(msg?.tools)) {
      if (Buffer.byteLength(raw) > FRAME_MAX_BYTES * 0.9) {
        process.stderr.write(`vibeos-mcp: the tab's tool list is ${Buffer.byteLength(raw)} bytes, near the relay's ${FRAME_MAX_BYTES} byte frame limit\n`);
      }
      const changed = JSON.stringify(msg.tools) !== JSON.stringify(toolSchemas);
      toolSchemas = msg.tools;
      if (process.stdin.isTTY && tokenIsOurs) {
        process.stderr.write("vibeos-mcp: paired ✓ — the token is remembered; `claude mcp add vibeos -- npx vibeos-mcp` uses it.\n");
        socket.close();
        process.exit(0);
      }
      if (typeof msg.instructions === "string" && msg.instructions !== instructions) {
        instructions = msg.instructions;
        server._instructions = instructions;
        if (initialized && !instructionsLate) {
          instructionsLate = true;
          process.stderr.write("vibeos-mcp: the tab's instructions arrived after initialize; MCP has no way to re-send them, so this client works from the tool descriptions alone (a reconnect gets them)\n");
        }
      }
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
  { name: "vibeos", version: "0.2.2" },
  { capabilities: { tools: { listChanged: true } } }
);
let initialized = false;

// The tab's instructions belong in the initialize result and MCP offers no
// second chance, but the tab's frame usually lands ~1.5 s after the client's
// initialize (the relay dial). So initialize waits for the first tools frame,
// briefly: the relay open plus the tab's answer, never long enough for a
// client to give up on the server.
const INIT_WAIT_MS = Number(process.env.VIBEOS_INIT_WAIT_MS) || 3500;
const originalInitialize = server._oninitialize.bind(server);
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  if (!toolSchemas.length && !ended) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, INIT_WAIT_MS);
      const prior = sawSchemas;
      sawSchemas = () => { clearTimeout(timer); prior?.(); resolve(); };
    });
    if (!toolSchemas.length) sawSchemas = null;
  }
  server._instructions = instructions || (tokenIsOurs && !toolSchemas.length ? pairLine() : undefined);
  return originalInitialize(request);
});

const PAIR_TOOL = {
  name: "pair_desktop",
  description: "No vibeOS desktop is paired yet. Returns the link that pairs one to this agent; show it to the person. The desktop's tools appear here once it is paired.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

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
    // Not every client shows the server's instructions (mcpt does not), so
    // the link is also a tool until a desktop pairs; then the real list
    // replaces it via list_changed.
    return { tools: tokenIsOurs ? [PAIR_TOOL] : [] };
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
  if (request.params.name === PAIR_TOOL.name && tokenIsOurs) {
    return { content: [{ type: "text", text: toolSchemas.length ? "a desktop is already paired; its tools are listed now" : pairLine() }] };
  }
  await settled(3000);
  if (!paired && !toolSchemas.length) {
    return { content: [{ type: "text", text: noTab() }], isError: true };
  }
  const id = nextId++;
  // A tab whose main thread is busy (a catastrophic regex in search_file
  // measured ~50 s) answers nothing, and the relay keeps ponging on its
  // behalf, so nothing else would ever end the call. vm_exec has its own
  // budget (timeout_s, up to 600) that this must not cut short.
  const budget = request.params.name === "vm_exec"
    ? Math.max(CALL_TIMEOUT_MS, ((request.params.arguments?.timeout_s ?? 20) + 30) * 1000)
    : CALL_TIMEOUT_MS;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`the desktop did not answer ${request.params.name} within ${Math.round(budget / 1000)} s — the tab may be busy or frozen; it may still finish the call`));
    }, budget);
    pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
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
