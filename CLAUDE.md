# vibeos-mcp

The MCP server that lets any MCP client (Claude Code, Cursor, Codex, mcpt) drive a
vibeOS desktop at https://vibeos.sh/app — "bring your own agent", the alternative to
pasting an OpenAI key. `bun` or `node`, no build step.

    claude mcp add vibeos -- npx vibeos-mcp --token <token from Settings › Capabilities>

## How it works

The tab cannot listen, so both sides dial a relay on vibeos.sh (`/api/mcp/relay`, a
Vercel function that pairs two websockets by token and pipes frames; source in
`caffeinum/vibeos-landing` under `app/api/mcp/` and `lib/mcp-relay.ts`). This package
is a stdio MCP server that dials the same relay with `relay-socket.mjs` (redials
0.5/1/2/2/2 s across the function's ~800 s cut and holds frames in the gap).

**Frame contract** (README.md has the table): first frame `{hello:'agent', token}`
(never in a url); `{want:'tools'}` on EVERY connect and the tab answers
`{tools:[…]}` — its `TOOL_SCHEMAS` verbatim, so there is no second API here;
`{id, tool, input}` → `{id, result}` | `{id, error}`; relay close codes: 4001 another
package took this token (final), 4002 peer gone (retry), 4003 revoked (final).

**A token is root on that desktop**: edit_file on the OS source, vm_exec in the
machine. Per tab, in memory only, dies with the tab, revocable in the pane.

## Proof

`e2e.mjs` runs the real pairing rules over a local ws relay with a fake tab and this
package over real MCP stdio. It found the `want:tools` contract (the agent pairs
after the tab and reconnects every 13 min, so an unsolicited send is not enough) and
the ws-drops-sends-on-CLOSING trap. Against the live route, both a raw stdio client
and `mcpt tools/call` were verified on 2026-09-04.

## Ownership

Owned by the `vibeos-mcp` paw agent. The tab side (`RemoteBridge`, the Capabilities
pane) lives in vibeos-landing's `public/app/kernel/agent.js` and `ui/settings.js`;
changes to the frame contract must land on both sides, contract first.

Until this is published on npm the pane advertises `npx github:caffeinum/vibeos-mcp`.

## CI / publish

`.github/workflows/ci.yml` runs `node e2e.mjs` on push/PR (the relay is inline in
e2e.mjs; nothing is fetched from vibeos-landing). `publish.yml` publishes to npm on
a `v*` tag with `--provenance`: trusted publishing (OIDC) if the npm package has a
trusted publisher bound to `caffeinum/vibeos-mcp` + `publish.yml`, else the
`NPM_TOKEN` secret. The tag must equal `v<package.json version>`.
