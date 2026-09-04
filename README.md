# vibeos-mcp

Drive a [vibeOS](https://vibeos.sh/app) desktop from your own MCP client — Claude
Code, Cursor, Codex — instead of pasting an API key into the browser. vibeOS
supplies the tools and the machine; your agent supplies the model.

```sh
claude mcp add vibeos -- npx @caffeinum/vibeos-mcp --token <token>
```

Get the token from **Settings → Capabilities** in the desktop. It is one token
per tab session: it dies when the tab closes, and *Revoke* kills it immediately.

## Why a relay exists

An MCP client spawns a subprocess or POSTs to an endpoint. A browser tab can do
neither — it cannot listen, only dial out. So both ends dial
`wss://vibeos.sh/api/mcp/relay` and the server pairs them by token and copies
frames. The relay parses nothing beyond the first frame.

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
| tab → agent | `{"id":N,"result":...}` or `{"id":N,"error":"..."}` | its answer |
| relay → either | `{"paired":true\|false}` | the relay's answer to the hello: is the other side already there |
| relay → either | `{"error":"peer not connected","code":4002}` | the other end is gone |
| tab → relay | `{"revoke":true}` | byte-exact; the relay closes both ends 4003 and forgets the token |
| tab → agent | `{"ping":<ms>}` | every 30 s, so the relay's 4002 tells the tab the agent left; ignored here |

The tab also sends `{"tools":...}` unsolicited when it connects. That is not
enough on its own: this package usually pairs *after* the tab, and reconnects
roughly every 800 s when the serverless function reaches its limit — so it asks
on every connect and the tab must answer `want`.

## Failure behaviour

Calls fail; they never hang. An MCP client waiting forever is indistinguishable
from one doing slow work, and the user cannot tell the difference.

- Relay drops mid-call (the ~800 s cut): in-flight calls reject with a note that
  the desktop may still have run the tool. The socket redials in place.
- No tab paired: `tools/list` explains that no tab is connected rather than
  reporting zero tools, which clients cache.
- The tab's socket dies with a call in flight: the relay tells this side
  `4002` at once (not on the next send), so the call fails with the same note.
- A second `vibeos-mcp` on the same token (close code 4001): final for the
  first one. Stop one, or pair a new token.
- The tab closes or reloads — `reload_os` included, since the token lives in
  the tab and dies with it: the tab sends the revoke on its way out, so this
  reads as revoked (4003), not as a relay outage. Driving the desktop again
  needs a new token from Settings > Capabilities.
- Revoked in Settings (close code 4003): final. No redial; every later call
  and `tools/list` say the desktop revoked the token.

## Development

```sh
node e2e.mjs   # real relay, fake tab, this package over real MCP stdio
```
