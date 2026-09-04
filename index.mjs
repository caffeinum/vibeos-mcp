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
import { RelaySocket } from "./relay-socket.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const token = flag("--token") ?? process.env.VIBEOS_TOKEN;
const relayUrl = flag("--relay") ?? process.env.VIBEOS_RELAY ?? "wss://vibeos.sh/api/mcp/relay";

if (!token || !/^[0-9a-f]{64}$/.test(token)) {
  // stderr, not stdout: stdout is the MCP transport and any stray byte there
  // corrupts the protocol.
  process.stderr.write(
    "vibeos-mcp: --token must be the 64-hex token from Settings > Capabilities\n"
  );
  process.exit(2);
}

/** Tool calls awaiting an answer from the tab, by id. */
const pending = new Map();
let nextId = 1;
let toolSchemas = [];
let sawSchemas = null;
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

const socket = new RelaySocket(relayUrl, {
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
      toolSchemas = msg.tools;
      sawSchemas?.();
      return;
    }
    if (msg?.error && msg?.code) {
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
  { name: "vibeos", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (ended) throw new Error(`vibeos: ${ended}`);
  if (!toolSchemas.length) {
    // Wait briefly for the tab's schema frame rather than reporting zero tools,
    // which a client caches and which looks like a broken server.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      sawSchemas = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    sawSchemas = null;
  }
  if (!toolSchemas.length) {
    throw new Error(
      "no vibeOS tab is paired with this token — open vibeos.sh/app and check Settings > Capabilities"
    );
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (ended) return { content: [{ type: "text", text: `vibeos: ${ended}` }], isError: true };
  const id = nextId++;
  const answer = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });

  socket.send(
    JSON.stringify({ id, tool: request.params.name, input: request.params.arguments ?? {} })
  );

  const msg = await answer;
  if (msg.error) {
    return { content: [{ type: "text", text: String(msg.error) }], isError: true };
  }
  const result = msg.result ?? msg.output ?? "";
  return {
    content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
  };
});

server.oninitialized = () => {
  agentName = server.getClientVersion()?.name ?? "";
  askForTools();
};

process.on("SIGINT", () => {
  socket.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
