# CLI flags and headless runs

## CLI Usage

```bash
# TUI mode (default)
bun run --cwd apps/tui dev

# Continue last session for cwd
bun run --cwd apps/tui dev resume

# Start with prompt (creates session, goes straight to session view)
bun run --cwd apps/tui dev -p "your prompt"

# Continue specific session
bun run --cwd apps/tui dev -s <session-id>

# Headless mode - streams to stdout, exits after response
bun run --cwd apps/tui dev -H "your prompt here"

# Headless mode that approves every ask.
# Without the flag, headless declines each ask: no user is present.
bun run --cwd apps/tui dev -H --approve-all "your prompt here"

# List sessions
bun run --cwd apps/tui dev sessions
```

## CLI Flags

| Flag             | Purpose                                         |
| ---------------- | ----------------------------------------------- |
| `-p, --prompt`   | Initial message (goes straight to session view) |
| `-s, --session`  | Resume specific session ID                      |
| `-H, --headless` | Headless mode + prompt arg                      |
| `-a, --agent`    | Agent override for headless mode                |
| `--approve-all`  | Headless: approve every ask (default: decline)  |

`gent resume [session-id]` opens a stored session; with no id it opens the last
session in this directory.

Priority: headless → session → continue → prompt → home

The `-p` prompt is a composer submission: `gent -p "/orchestrate <goal>"` runs
the command, and an unknown `/name` comes back to the draft with its reason.
A headless prompt is always a message: `-H` runs no slash command.

A headless run has no user, so it declines every interaction its turn presents,
with notes that name `--approve-all`. `--approve-all` approves every ask. The
run follows only its own turn: the live events from the `MessageReceived` of
the prompt it sent (the message its send's request id names, through
`userMessageIdForRequest`) to the `TurnCompleted` that names that message.
Another client's message with the same text is not the run's. A resumed
session's history and an
older turn still running on the branch are not printed and do not settle it. An
`ErrorOccurred` alone does not end the run; the `TurnCompleted` receipt does.
It exits 1 when the receipt says `interrupted`, `streamFailed` or `unanswered`,
even after partial text, which has printed already. A receipt without those
flags (a historical one) exits 1 on an error with no answer text. An error
marked `notice: true` (a compaction fallback) is only a warning. The client
status also ignores a notice. A failed turn phase appends one `TurnCompleted`
with `streamFailed: true`, which settles the run; the send fails too, and
whichever comes first ends it. SIGHUP exits 129, SIGINT 130 and SIGTERM 143. The run's end
owns stderr: a failed run prints one line, an answered run prints one
`Warning:` line for each notice.

## gent auth

`gent auth` signs in with no TUI: over SSH, on a workbox, in a script. Each
call starts its own server with state in memory: it opens no database and no
lock under the data directory (its logs still go there). It writes the credential store every gent on
the machine reads (`~/.gent/auth`, or `GENT_AUTH_DIRECTORY`) and, for a new
label, the user config's `authOrder`, so a running gent uses the sign-in at its
next turn. Stdout is one JSON line. The sign-in page, the instructions, the
prompts and the warnings go to stderr. The key or the code comes in on stdin. A
failure is one line on stderr and exit 1.

```bash
# Each provider's credentials and order, and the methods `login` takes (`SignIns`)
gent auth list

# A Claude account under the label work: open the page, sign in, paste the code
gent auth login anthropic --method "Sign in to a Claude account" --slot work

# A key from a script; a method's prompts are answered with --input key=value
printf %s "$KEY" | gent auth login openai --method "Manually enter API key"

# Remove one credential and its place in the order (`SignedOut`)
gent auth logout anthropic --slot work
```

- `--method` names a method by its label, in any case. Without it, `login`
  takes the provider's only method for the label. A method for the default
  credential alone is not offered for a named label.
- `--slot` is the label: 1 to 32 of `a-z`, `0-9`, `_` and `-`. The default is
  the default credential.
- A key typed on a terminal is not shown. A piped key is stdin's first line.
- A `code` sign-in waits for the pasted code. A refused code is shown on stderr,
  and the next line is tried. An `auto` sign-in waits for the browser and takes
  pasted codes too: the first to sign in wins, and a browser wait that runs out
  fails the call.
- `SignedIn` names the provider, the label and the method. A new label goes
  last in the order as it stands when the sign-in ends, as `/auth` puts it, and
  `authOrder` holds the order written. A label signed in again, or one the
  order names already, keeps its place, and no order is written. An order
  write a project config refuses is a warning: the credential stays stored.
- `logout` takes the label out of the order, and `authOrder` holds the order
  written. An order the removal would empty stays as it is, with a warning:
  the default would serve alone, and it can be a billed environment key.
- A closed stdin before an answer fails and stores nothing.

## gent ctl

`gent ctl` drives a running server from a shell, one session per call, over the
RPC the TUI uses. It finds the server through the data directory's lock
(`GENT_DATA_DIR`, else `~/.gent`), the way `gent doctor` does, or through
`--connect <url>`. It never starts a server: run `gent` or
`gent server start` under the same `GENT_DATA_DIR` first. A `--debug` or
`--isolate` TUI keeps its state in memory, and `gent ctl` cannot reach it.

```bash
gent ctl send --new --model anthropic/claude-sonnet-5 --wait "debug tools"
gent ctl events --limit 20                  # the newest session in this directory
gent ctl events --since 41 --tags ToolCallStarted,TurnCompleted
gent ctl wait --message <messageId>         # the turn a send opened, even one already ended
gent ctl wait --until InteractionPresented --timeout 20
gent ctl snapshot -s <session-id>
gent ctl status
gent ctl status --run run-0123456789abcdef   # a machine run, as the machines extension shows it
gent ctl request --extension @gent/machines --id run-status --input '{"run":"run-0123456789abcdef"}'
gent ctl lanes                              # the server's account lanes, no session
gent ctl lanes --line                       # lanes anthropic 3/5 free · 5h 120k/% ±8% · out 12%
gent ctl pool                               # this server's own pool facts, no session
gent ctl link                               # relay the server's RPC over stdio, for another machine's server
gent ctl review --since 7d --out /tmp/gent-review   # every workspace's sessions of the last week, for review
```

Without `--session`, a call names the newest conversation in `--cwd` (default:
the current directory), on its active branch (`--branch` names another). A
call prints one JSON value on stdout. An array of records in it prints one
record per line, so `events --limit 3` prints five lines. `events` prints one
compact record per stored event; `--full` prints the stored envelopes. A
`StreamChunk` is live only, so `events` never lists one, and `wait --until
turn` reads its reply from the answers the turn stored. Each record's `id` is a cursor
for `--since` and `--after`. `send` prints `Sent` once the loop holds the
turn (`message.send` with `completion: "admission"`); it does not wait for
the turn. `send --wait` waits for the turn and prints `TurnEnded`, and
`--timeout` bounds that wait. `send --request-id <id>` makes a retry safe: the
server admits one message per id, and with `--new` creates one session per id,
so a repeated `send --new --request-id <id>` names the same session and
message. `request` sends one extension request, as a client extension does,
and prints its reply as it crosses the wire: `{"_tag":"Value","value":…}`, the
output's encoded JSON, or `{"_tag":"Void"}` for a request whose output is
`Schema.Void` (`/goal`). A client extension may project one of its requests
into a `status` flag (`ctlProjection` in the client contribution): `status
--run <id>` is the machines extension's `run-status` request, printed as
`View` with the encoded reply in `view`.

ctl never subtracts a server time from its own clock: a `--connect` call
from another machine has another clock. `status` reads the session's
runtime state (the first value of `session.watchRuntime`) and the lanes
report together, never the session snapshot, which carries the whole
history. Its `runningMs` is the report's `serverNow` less the runtime's
`startedAtMs`, both on the server's clock. `lanes --line` reads
its ages, and whether a clock time is today, against the report's `serverNow`. A server older
than `serverNow` is read against the local clock.

`review --since <N>d|<ISO date> --out <dir>` exports the sessions of every
workspace touched in the window for the owner's review, in the shapes of the
retro skill's miner. The server reads its own store (`review.window`): at the
start it takes the read's time and each workspace's ids of the sessions in the
window, then reads each session a page at a time, so a session written during
the read is read once and a row written after the start does not count. The
client writes every file into a staging directory beside `--out`, then moves
them into `--out`, which it makes when absent and refuses when it is a file;
a failed read leaves the export before it whole. A `--since` that is neither
form exits 2. `messages.jsonl` holds one line per user message written in the
window, the miner's `{src, project, session, ts, kind, text}`: `kind` is `msg`
for the owner's (a client sent it and no extension wrote it), `peer` for one a
child, a parent, a machine or a wake wrote, `interrupt` (no text) for a turn
the owner stopped and `limit` for a usage-limit error. A branch counts only the
messages written on it, not the prefix a fork copied. `sessions.jsonl` holds
one line per session, first the miner's fields with its names and types:
`sub` (another session spawned it), `bytes`, `first`, `last`, `human`, `peer`,
`interrupts`, `compactions` (handoffs and prunes), `limits`, the token totals
`cacheRead`, `cacheWrite` and `output`, `skills`, `slash` (always empty: gent
stores no slash command), `agents` (sessions it spawned) and `rereads`; then
gent's own: its parent, turns, input tokens, tokens per model from the stored
receipts, handoffs, prunes, tool calls by tool, errors and limit errors by
provider. `rounds.jsonl` is the machines extension's (a client `review`
projection over its server request `MachinesRpc.Review`): one line per machine
round that ended in the window, with its machine, run, unit, state, visit,
role, model, effort, tokens, cost, minutes and outcome (the verdict move, the
ask, the wait or the error it led to). `roles.jsonl` is its second
(`MachinesRpc.Roles`): one line per orchestrate role, model and effort over
the runs that moved in the window, with its measures, each a count, a rate
with its n (a rate under n 5 has no value) or a share (`priced 7/9`). It is the
owner's: a `gent ctl review` that a gent tool or machine command runs
(`GENT_COMMAND_TOKEN` set) fails before it reads them. A projection whose extension the
server's launch profile does not run is skipped, and `digest.md` notes it
(`rounds: @gent/machines not loaded`, `roles: …`). `digest.md` sums them: the tokens per
model, the costliest sessions by cache read, the owner's messages repeated in
two or more sessions, the rounds per role and `model@effort`, and the roles
per model (`## Machine roles per model`: a rate under n 5 prints `—` and its
n; no combined score). Free text is
redacted with the miner's secret patterns and clipped to 300 characters (160
for a limit error). It prints `Review` with the file paths and the counts.

`lanes` names no session: the accounts are the server's. It prints `Lanes`,
the `accounts.lanes` report, with one record per provider gent read a quota
window of, saw a login lost on or read banked resets of (an account's
`resets`, each `{ count, expiresAt? }`), and `sabbathEnd` (epoch ms) while the
owner's Sabbath holds every start. `--line` prints the TUI band's lanes rows as text instead: in the
Sabbath first `sabbath · no run starts until <end>`, then one per
provider: `lanes <provider> <free>/<capacity> free · <window> <fuel per
percent>/% ±<band> · out <outside share>` for the window that carries the
fewest runs, `lanes <provider> 0 free · retry 13:47` when a window is spent
until a reset, `lanes <provider> 0/<capacity> free · <n> running` when runs
hold every lane (`· held` when a refusal holds the account), and `lanes unknown` with no reading or no rate. Each
provider's row is followed by a row
`login! <provider> <slot> refused · sign in with /auth` for each account whose
login the provider no longer takes (`unavailable` when the driver found no
credential), then a row `resets <provider> <slot> <count>, … · next lapses
<clock>` when its accounts hold banked resets (Claude's reset grants,
Codex's reset credits; a lapsed grant counts none, an account with none or
out of the provider's `scope` is not named, and a count goes 30 minutes
after the read that listed it). With peers (`link.machines`, below) the last
rows are the peers, one per machine: `peer <machine> <n> runs · <age>` while its lines come (its runs
on this server's accounts, the age of its last line), `peer <machine> unread
<age>` after 90 s with no line (with `· <n> runs held` while its last runs
still count, for 30 minutes), and `peer <machine> unread` before its first line. It
reads `peer! … · own link down` when this server's link brought no facts
for 90 s, `· peer link down` when the peer's link was heard and then went
quiet 90 s, and `· links down` for both. While this server links to the
peer, the row names the link's state in place of the link down: `· silent` (no frame for 90 s) or `· incompatible` (the
peer runs another build's RPC contract; no facts cross). A narrow row keeps
the held runs, then the link down, then the age, then the machine. With no link
of this server's own, the row goes 30 minutes after the peer went silent. The
JSON holds them as `peers`, sorted by machine: `machine`, `heardAt` (epoch ms, none before its first line), `runs`, `silent`,
`down` (`own`, `peer`), `counted` (its facts still count, inside the
30-minute hold) and `link` (`machine`, `state`: `connecting`, `connected`,
`silent`, `incompatible`), and `serverNow` (epoch ms) is the server's clock as
it built the report. No free lane is data, not a failure: the call exits 0.

`pool` names no session either. It prints `Pool`: the server's own pool
facts (`accounts.pool`), the part of its lanes another machine on the same
accounts reads (`plans/cross-machine-pool.md`). `boot` names this server
start, `host` its machine name (`GENT_MACHINE`, else the hostname to its first
dot, which the peer's band shows), `seq` rises at each change, and each provider holds its `runs` (the
admitted runs and reserving grants, as `{ accounts, model?, count }`) and its
`accounts`: per account its warm sessions per model (`live`), the fuel and the
unpriced steps each model spent since `boot` (`spend`), and the reset of its
weekly window (`week`, epoch ms, as the provider sent it). No facts hold a
time of this machine's clock.

```text
{"_tag":"Pool","server":"http://127.0.0.1:55350/rpc","boot":"c1758aa2372ad90a","host":"Cristians-MacBook-Pro","seq":1,"providers":[
{"provider":"anthropic","runs":[],"accounts":[{"slot":"default","live":[],"spend":[],"week":1793904480307}]}
]}
```

`link` is the far end of a link between two machines' servers. It relays the
local server's RPC socket over its stdio: each stdin line goes to the server
as one frame, each frame comes out as one stdout line, and it decodes
neither. It ends with exit 0 at its stdin's end (a last line with no newline
is a frame too) and closes the socket, so the server cancels the requests
still running, as for any client that closes; it ends with one `CtlFailed`
line and exit 1 when the server closes the socket, its stdin open or not. With no server it exits 3
and starts none. The other machine's server runs it through ssh: `link.machines`
in the user file `~/.gent/config.json` (a project file cannot set it) maps
each machine's name to the command that reaches it, an argv array. One file
serves every machine; each server runs every entry but its own name
(`GENT_MACHINE`, else the hostname to its first dot):

```json
{
  "link": {
    "machines": {
      "bite-cristian": ["ssh", "bite-workbox", "gent", "ctl", "link"],
      "Cristians-MacBook-Pro": ["ssh", "cvr@cristians-macbook-pro", "gent", "ctl", "link"]
    }
  }
}
```

Each run asks the far server's `link.hello` first: its machine name and its
RPC contract: its codecs and the release that holds their code (the commit,
the tree, the hash of `bun.lock` and the Bun version, read as gent is built,
or as the server starts in a source run). The tree is the content of the
working files: git lists the tracked files and the untracked files it does
not ignore, and gent hashes each one's bytes itself, so no git filter, diff
driver or line-ending setting changes it. Two machines match on the same
commit with byte-identical working files, the same lockfile and the same Bun:
two `bun run install:global` runs of one commit, which install the
lockfile's packages before they build. An edit is a release of its own, and
two machines match on it only with the same ignore rules too (a global
`core.excludesFile` that ignores a file on one machine only splits them). A process with no release (no git, no repository) names a contract no
other process names. A build with another contract makes the link
`incompatible` and nothing else runs. Over a connected link the pool's facts cross both ways
(docs/architecture/lanes.md, docs/architecture/server.md). A run that ends, or
that brings no frame for 90 s, runs again after 1 s, the wait doubling to 5
minutes. The server reads the machines at start (a new one takes a server
restart) and each command at each run.

A failure prints one tagged JSON line on stderr and exits with its code:

| Exit | Error             | Meaning                                                                                               |
| ---- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| 0    |                   | Success                                                                                               |
| 1    | `CtlFailed`       | An RPC or request failure, a lost connection, or a defect (`defect: …`; the client log has the cause) |
| 2    | `CtlUsage`        | A flag or argument the parser refuses, or flags that parse but do not fit together                    |
| 3    | `CtlNoServer`     | No live server for the data directory                                                                 |
| 4    | `CtlNotFound`     | The session or branch does not exist                                                                  |
| 124  | `CtlWaitTimedOut` | `wait` saw no match in `--timeout` seconds; `cursor` is the last event id it read                     |
