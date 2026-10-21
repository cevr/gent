# MCP servers (mcp)

The `@gent/mcp` extension (`packages/extensions/src/mcp.ts`) turns every
configured MCP server into host tools with the id `mcp.<server>.<tool>`, so
the cell reaches them as `await tools.mcp.<server>.<tool>(input)` and each
call runs the host tool path: permission, events, operation receipt, and
recovery. It uses only `@gent/core/extensions/api`, the client subpaths of
`@modelcontextprotocol/sdk`, and its `types.js` (the protocol error class and
the loose result schema); core has no MCP concept. The one Promise edge, the
`fetch` function an OAuth transport takes, lives in `mcp-boundary.ts`. Config
is the `mcpServers` object Claude Code, Cursor, and opencode share, in
`~/.gent/mcp.json` and, for a project root `trustedProjects` names, in
`<project>/.gent/mcp.json` (a project entry wins by name). Each entry decodes on
its own: one that does not decode is `misconfigured` with the schema issue as
its reason, and the file's other servers still run. A `command` entry
runs over stdio with the process's flat environment, empty values included and
read in one pass at the first setup, its own `env` winning (its stderr is ignored, so it never
draws on the TUI). A `url` entry sends its
`headers`; its `type` picks the transport: `http` (or `streamable-http`) and
`sse` pin one, and `auto`, the default, tries streamable HTTP and then SSE
when the server answers 400, 404, 405, 406, 415, 422 or 501 (never on 401 or
403, which SSE would refuse too). Strings expand `${NAME}` and
`${NAME:-default}`, and a value is taken literally; an entry whose variable is
unset is skipped with a warning. A stdio `cwd` resolves against the session's
cwd, after its variables expand.

A `plugin` entry runs a server that another tool's plugin ships, such as
Codex's computer use, and an update of the plugin needs no edit:

```json
{
  "mcpServers": {
    "computer-use": {
      "plugin": "~/.codex/plugins/cache/openai-bundled/unified-computer-use",
      "server": "cua_repl"
    }
  }
}
```

Each setup reads the entry `server` from the `.mcp.json` in the `plugin`
directory. When that directory has no `.mcp.json`, the entry reads the
version directory that Codex runs (`active_plugin_version` in Codex's
`core-plugin-common/src/installed.rs`): `local` when it is there, else the
newest subdirectory by semantic version (by text when a name is not one).
Only a name of ASCII letters, digits, `.`, `+`, `_` and `-` counts. The file's
servers are its `mcpServers` object, else its top-level object, as Codex and
Claude Code read them. `plugin` expands `${NAME}`, a leading `~` is the home
directory, and a relative path resolves against the session's cwd. The named
server is a `command` or `url` entry and runs as one, with the rules of the
plugin's own tool: `${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` expand to the
plugin root (the directory of the `.mcp.json`), and a stdio server gets both
in its environment; a stdio server runs in its `cwd` resolved against the
root, else in the root; and a `command` that starts with `./` or `../`
resolves against that directory. The `enabled` and `timeoutMs` of the `plugin`
entry apply. The entry keys with its plugin root, so a new version lists
again. A missing directory, no `.mcp.json`, a file that is not a JSON object,
no server of that name, or a server entry that does not decode makes the
entry `misconfigured` with the reason, and the other servers still run. gent
reads a plugin only when an entry names it.

Computer use can click and type in any app, so its tools must ask before they
run. A `@gent/guard` rule (see `docs/extensions.md`) in `~/.gent/config.json`
asks before each call of the server's tools, from the model or from the cell;
rules come before the pass for read-only tools:

```json
{ "guard": { "rules": [{ "tool": "mcp.computer-use.*", "effect": "ask" }] } }
```

An MCP image reaches the model as an image on a native call, and through
the cell when the cell shows it: `const shot = await
tools.mcp["computer-use"].js(...); shot` (or `shot.images[0]`, or a
`console.log` of it) sends the screenshot after the cell's result, as `cell.md`
says. A cell that reads only the text of a result sends no
image.

A `url` entry without its own `Authorization` header signs in with OAuth, all
inside the extension. `/mcp login <server>` runs the SDK's `auth()` with a
provider that never opens a browser: it registers the client, starts a
loopback listener on 127.0.0.1 for the redirect, and presents the
authorization URL. The listener's scope is a child of the extension's from
its creation: a login start that fails or is interrupted closes it, and a
start that succeeds hands it to the finishing fiber in one uninterruptible
step. Before `auth()`, the login sends one request with no token and keeps the
`resource_metadata` URL its 401 names in `WWW-Authenticate`; discovery starts
there, so a server whose metadata is off the well-known path is found. A
process fiber waits up to five minutes for the redirect,
exchanges the code, and lists the tools into the cache, so no turn waits on a
browser. A browser on another machine cannot reach the loopback listener, so
`/mcp login <server> <address>` hands the pending login the redirect address
the browser shows; it goes through the listener's checks (path, the login's
state, the server's refusal). The login lives in `<data dir>/mcp-auth.json` (mode 0600, written
with `writeFileAtomic`), keyed by server name and URL, with that metadata URL.
A token that expires within 60 seconds is refreshed before the dial. The
transport's `fetch` answers each 401 or 403 before the SDK sees it: a 401 on
`initialize`, `notifications/initialized`, `ping`, `tools/list` or the stream
`GET` refreshes the token (discovery starting from the metadata URL that 401
names) and sends that request once more; any other refusal, a `tools/call`
included, fails with "the <server> MCP server needs a login: run /mcp login
<server>". So a call is never sent twice. Every refresh and every stored login
holds the login file's one lock, `<data dir>/mcp-auth.json.lock` (created with
`wx`, removed when done, taken over when older than 30 seconds), so two gent
processes that write different logins never drop each other's token. A
refresh reads the login again under the lock: when another refresh, in this
process or another, already stored a new token, it uses that token and never
redeems the spent refresh token. The token request and the stored login are
one step that is not interrupted, and its requests end within 20 seconds: a
dial that times out, or a request the SDK aborts, waits for it, so a rotated
token is always stored and the lock never outlives its 30 seconds. Only the
wait between tries to take the lock can be interrupted: a lock a holder
created is always removed.

Setup reads each server's tool list from `<data dir>/mcp-catalog.json`, keyed
by the SHA-256 digest of the entry as it runs (its expanded values, for a
`url` entry its configured `type`, with `http` and `streamable-http` one
value, and for stdio the resolved directory its `cwd` names), so an edited
entry or a changed variable lists again. An entry from a project's
`.gent/mcp.json` belongs to that project and always keys with the session
directory, so two projects' `bun run mcp` (or `http://localhost:3000/mcp`) are
two servers. A user-file stdio entry whose command or arguments name a
relative path (`./server.ts`, `src/x.js`, `server.py`, or a flag value such as
`--config=./x.json`) also keys with the session directory, so two projects'
`./server.ts` are two servers. Any other user-file entry that names no `cwd`
keys without it, so a new project does not spawn every server at setup. A
relist on the first
connection corrects the cache for the next session; the capabilities a
session registered stay as its setup listed them. The file holds only the
digest, the server's `initialize` instructions and a `listedAt` stamp, never a
token. On a miss setup connects once and lists; every server setup listed, and
every cached entry it read whose stamp is over a day old, goes to the cache in
one write, stamped now. A write drops each entry stamped over 14 days ago. A server
that cannot list is logged and contributes nothing. `tools/list` goes out with
the SDK's loose result schema and each entry decodes on its own: an entry the
spec's tool shape refuses is skipped with a warning, and a `null` description
counts as none. So the SDK keeps no output validators, and the tool checks
structured content itself.

Calls share one process Resource (`McpClients`): an `RcMap` opens a server's
connection on its first call and closes it after five idle minutes, and a
failed connect is dropped from the map, so the next call connects again. A
connection is dropped when its transport closes and when a call on it fails in
the transport; a JSON-RPC error leaves it open, and a close that takes over two
seconds is abandoned. A call that carried an `Mcp-Session-Id` on a reused
connection and was answered 404 (the server forgot the session, so it ran
nothing) is sent once more on a new connection; a 404 without a session
leaves the connection open and is not sent again. A 401 or 403 on a call
drops the connection and marks the server `expired`, or `logged-out` when
the entry signs in with OAuth and has no stored login.
The tools are listed again when a connection opens, when the server sends
`notifications/tools/list_changed`, and when it answers a call as an unknown
tool. One server's lists run one at a time, so an older list never lands
last: a list that differs is written to the cache (under one permit), and a
call to a tool the server no longer lists fails with a message naming the
stale catalog. An empty or failed relist keeps the cached tools. After the
write, the pool reloads the extension (`ctx.Extensions.reload`) in each place
a loop opened in: each loop's `loopOpen` hook hands the pool its place's
reload, and reloads at once when a list since its setup read the cache
already changed it. The reloaded setup registers the cached list, so the next
turn there offers the new tools; only then does the server's state (and
`/mcp`) take the new list. A place with no open loop catches up when a loop
opens there: the open's reload lands after the profile the open resolved, so
that place's first turn may still run on the list it had.

The read-only `mcp.status` host tool and the `/mcp` slash command report each
server's transport, tool count, connection, and health: `healthy` (listed or
connected), `expired` (the server refused the credential; the reason names
`/mcp login`), `logged-out` (the server refused an OAuth entry that has no
stored login; the reason names `/mcp login`), `misconfigured` (the entry cannot run: it does not decode, names an unset variable, or names a plugin server that cannot be read),
`degraded` (a connect, list or call failed in the transport), or `unknown`
(read from the cache, not yet connected). With no server configured, only
`/mcp` is registered, and it says where to add one.

Each tool's input schema is imported from its JSON Schema (patterns ignored),
so the host checks input and the catalog shows its types. A tool with an
`outputSchema` has that type as its output: its result is the
`structuredContent`, and content that does not match the schema, or none,
fails the call. A result of text alone is its joined text, and one of
`structuredContent` alone (its text only repeating it) is that value; any
other result is an object of `structuredContent`, `text`, the other blocks as
`content`, `images`, and `omitted`, beside a `note`. An image block the tool
image store takes (`saveToolImage`: PNG, JPEG, GIF or WebP, scaled to fit)
is a `ToolImage` in `images`, so the model sees it after the call's result as
it sees any tool image, and its entry names the `path` of the image's
content-addressed file (`toolImageFile`), which cell code reads; a typed tool returns only its `structuredContent`, so
its images are dropped. `omitted` names each other image, audio, or blob
block with its MIME type and size; the cell never receives the bytes.
Each such block is written once to `<data dir>/mcp-blobs/<sha256>.<ext>` (the
extension from its MIME type, else `bin`) and its entry gains that `path`; a
block over 20 MiB is not written and has no path. A save that finds its file
already there sets the file's modification time to now, and writes it again
when it is gone. The first save in a process removes the blob files last
written over 14 days ago, checking each file's modification time right before
it removes it, so a file a save just reused stays. `isError` fails the call as
`{ error }`. Server and tool names become id segments in the tool id grammar:
runs of `[A-Za-z0-9-]` joined by one `_`, no `_` at either end, and the wire
name `mcp__<server>__<tool>` within 64 characters (a server takes at most 20).
Names that clean to one segment all stay: in code-unit order of the original
names, the first keeps it and the next take `_2`, `_3`, and so on. Many MCP tools collapse in the prompt catalog by
the host tool catalog budget; the model reaches them with `tools.search` and
`tools(id)`.
