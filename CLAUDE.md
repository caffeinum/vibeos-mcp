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
The hello reply carries the relay function `instance`; `{ping:N}` every 30 s is
answered by the relay with `{pong:N,instance}` (never forwarded). A `{bye:4001|4003,reason}` frame
before a normal close means that close code (API Gateway cannot send custom codes).
`--relay` accepts a comma-separated fallback list; default is the durable relay
(API Gateway + DynamoDB, `wss://2yetm9bvy2.execute-api.us-east-1.amazonaws.com/prod`,
instance `apigw-us-east-1`) then vercel. Sends over 128 KB are refused (API Gateway
closes the sender with 1009); its `{"message":"Internal server error",…}` frame is
surfaced as relay error code 5000 and fails in-flight calls.
`tools/list`
must answer fast (empty if no tab, then `list_changed`): Claude Code times out a
slow list and shows the server as broken.

**A token is root on that desktop**: edit_file on the OS source, vm_exec in the
machine. Per tab (sessionStorage), survives `reload_os` — the tab resumes it and
this package reconnects, list_changed follows — dies with the tab or a hand
reload, revocable in the pane. A 7-day remembered token is landing's next push.

## Proof

`e2e.mjs` runs the real pairing rules over a local ws relay with a fake tab and this
package over real MCP stdio. It found the `want:tools` contract (the agent pairs
after the tab and reconnects every 13 min, so an unsolicited send is not enough) and
the ws-drops-sends-on-CLOSING trap. Against the live route, both a raw stdio client
and `mcpt tools/call` were verified on 2026-09-04. `live-tab.mjs` drives a real
vibeos.sh/app tab in a headless Chrome (puppeteer-core, not shipped) to pair a
token for a full live e2e: tab → relay → npm package → mcpt; last green 2026-09-04
22:30 PDT on vibeos-mcp@0.1.12 against landing 00a6d3d: the whole tool surface incl.
read_desktop image, directory search deadline, secrets stripped, reload_os keeping
the pairing. `reload-probe.mjs`-style in-process checks live in the scratchpad recipe
in live-tab.mjs's header. A tab reloaded mid-deploy can run a stale kernel: pane says Waiting with
no relay instance while no relay has it; reload again.

## Ownership

Owned by the `vibeos-mcp` paw agent. The tab side (`RemoteBridge`, the Capabilities
pane) lives in vibeos-landing's `public/app/kernel/agent.js` and `ui/settings.js`;
changes to the frame contract must land on both sides, contract first.

Until this is published on npm the pane advertises `npx github:caffeinum/vibeos-mcp`.

## CI / publish

`.github/workflows/ci.yml` runs `node e2e.mjs` on push/PR (the relay is inline in
e2e.mjs; nothing is fetched from vibeos-landing). `publish.yaml` publishes to npm on
a `v*` tag with `--provenance` via npm trusted publishing (OIDC). The trusted
publisher on npmjs.com is bound to `caffeinum/vibeos-mcp` + the file name
`publish.yaml` exactly — renaming the workflow breaks it. No token secret and no
`registry-url` on setup-node: either plants an `_authToken` in .npmrc and npm then
skips OIDC (seen as E404/ENEEDAUTH). The tag must equal `v<package.json version>`.

Release: bump `version` in package.json (and the server version in index.mjs),
commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. 0.1.2 was published by hand to
create the package; 0.1.3+ went through the workflow. `@caffeinum/vibeos-mcp`
0.1.0/0.1.1 exist from a scoped-token detour and should be deprecated.

`bin` paths must not start with `./` or npm rewrites them at publish. Local
`npm view` may 404 fresh versions: ~/.npmrc has a `before=` min-release-age gate;
override with `npm_config_before=` to check.
