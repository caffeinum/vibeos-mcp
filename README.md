# vibeos-mcp

Drive a [vibeOS](https://vibeos.sh/app) desktop from your own MCP client — Claude
Code, Cursor, Codex — instead of pasting an API key into the browser. vibeOS
supplies the tools and the machine; your agent supplies the model.

```sh
claude mcp add vibeos -- npx vibeos-mcp --token <token>
```

Get the token from **Settings → Capabilities** in the desktop. It is remembered
in that browser for seven days — reloads and closed tabs keep the pairing —
and *Forget this agent* ends it at once.

## Why a relay exists

An MCP client spawns a subprocess or POSTs to an endpoint. A browser tab can do
neither — it cannot listen, only dial out. So both ends dial the same relay and
it pairs them by token and copies frames, parsing nothing beyond the first frame.
The default relay is `wss://2yetm9bvy2.execute-api.us-east-1.amazonaws.com/prod`
(API Gateway + DynamoDB: pairing is durable, so it does not matter which server
each side lands on), with `wss://vibeos.sh/api/mcp/relay` as fallback. The
Capabilities pane's command carries `--relay <url>` when the tab is on a
non-default one.

## Security

**The token is root on the desktop.** The tool set includes `edit_file` on
`system/os.js` and `vm_exec`, so anything holding it can rewrite the OS and run
commands in the VM. It is sent as the first frame and never in a URL, because
URLs reach access logs, proxies and `Referer` headers.

The relay sees every tool call in plaintext. Assume the operator of vibeos.sh
can read what your agent does on your desktop.

## Frame contract

Between the tab and this package. The relay does not interpret any of it.

| Direction | Frame | Meaning |
|---|---|---|
| both → relay | `{"hello":"tab"\|"agent","token":"<64 hex>"}` | first frame, pairs the socket |
| agent → tab | `{"want":"tools","agent":"<client name>"}` | sent on every (re)connect, and again after MCP initialize once the client's name is known (empty before) |
| tab → agent | `{"tools":[{name,description,parameters}]}` | `TOOL_SCHEMAS`, verbatim |
| agent → tab | `{"id":N,"tool":"name","input":{...}}` | a call |
| tab → agent | `{"id":N,"result":...}` or `{"id":N,"error":"..."}` | its answer; any `{mime,base64}` or `{mimeType,data}` object in a result, at any depth, reaches the MCP client as image content and `{mime:"text/plain",text}` as a text block, each replaced in the JSON by a marker; never a data: url in text |
| relay → either | `{"paired":true\|false,"instance":"<id>"}` | the relay's answer to the hello: is the other side already there, and which relay function instance this is (tab and agent must land on the same one) |
| agent → relay | `{"ping":N}` | every 30 s; a relay that names its instance must answer within 10 s or this side redials |
| relay → agent | `{"pong":N,"instance":"<id>"}` | the relay's answer, never forwarded to the tab |
| relay → either | `{"bye":4001\|4003,"reason":"…"}` | sent just before a normal close by a relay that cannot send custom close codes (API Gateway); means exactly what the close code would |
| relay → either | `{"error":"peer not connected","code":4002}` | the other end is gone |
| tab → relay | `{"revoke":true}` | byte-exact; the relay closes both ends 4003 and forgets the token |
| tab → relay | `{"ping":<ms>}` | every 30 s, answered by the relay the same way |

The tab also sends `{"tools":...}` unsolicited when it connects. That is not
enough on its own: this package usually pairs *after* the tab, and reconnects
roughly every 800 s when the serverless function reaches its limit — so it asks
on every connect and the tab must answer `want`.

`--relay` (or `VIBEOS_RELAY`) takes a comma-separated list: a relay that cannot
be reached at all falls through to the next; one that was open and dropped is
redialed as is. A call whose frame exceeds 128 KB is refused with an error naming
the size (API Gateway closes the sender above that); the tab does the same for
results. An API Gateway `{"message":"Internal server error",…}` frame (a
throttled lambda) fails in-flight calls loudly rather than vanishing.

## Seeing the desktop

`read_desktop` returns the open windows (top first, with geometry), the dock
and the machine state as structured text; `{window}` gives one window's body as
text (password and hidden values never), `{window, dom:true}` its sanitised
outerHTML, and `{screen:"image"}` the machine's screen (the VM's VGA canvas) as
a JPEG at most 1024 wide and under about 110 KB for the relay, with the text
console's rows alongside. The desktop's own windows are DOM, which the tab
cannot rasterise without a large vendor library, so they come back as text, not
pixels. `list_themes`, `list_files` and `search_file` over a directory or glob
(in a worker, 3 s deadline) complete the picture; the chat log and machine
snapshots under `system/` are the person's and are not readable.

## Failure behaviour

Calls fail; they never hang. An MCP client waiting forever is indistinguishable
from one doing slow work, and the user cannot tell the difference.

- Relay drops mid-call (the ~800 s cut): in-flight calls reject with a note that
  the desktop may still have run the tool. The socket redials in place.
- The tab never answers (its main thread is busy — a catastrophic regex in
  `search_file` measured about 50 s): the call fails at a deadline, 120 s by
  default (`VIBEOS_CALL_TIMEOUT_MS`), or `timeout_s` + 30 s for `vm_exec`, with
  a note that the desktop may still finish it.
- No tab paired: `tools/list` answers within 2 s with an empty list — Claude Code
  gives up on a slow list and shows the server as broken — and sends
  `notifications/tools/list_changed` the moment the tab's schemas arrive. A
  `tools/call` in the gap errors with the relay instance id, so it can be
  compared with the one the Capabilities pane shows.
- The tab's socket dies with a call in flight: the relay tells this side
  `4002` at once (not on the next send), so the call fails with the same note.
- A second `vibeos-mcp` on the same token (close code 4001): final for the
  first one. Stop one, or pair a new token.
- The pairing outlives the tab. The token is remembered in that browser for
  seven days: `reload_os`, a hand reload or a closed tab only open a gap — calls
  in it fail with `peer not connected` — and a tab back on the same token
  answers again; this package reconnects on its own. A second tab of the same
  browser offers *Take over here* rather than dialing over the first, and the
  first is told. *Forget this agent* in the pane, or the expiry, ends it: a
  connected package reads revoked (4003); one that dials afterwards finds no tab.
- Revoked in Settings (close code 4003): final. No redial; every later call
  and `tools/list` say the desktop revoked the token.

## Development

```sh
node e2e.mjs   # real relay, fake tab, this package over real MCP stdio
```
