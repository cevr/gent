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
```

Without `--session`, a call names the newest conversation in `--cwd` (default:
the current directory), on its active branch (`--branch` names another). A
call prints one JSON value on stdout. An array of records in it prints one
record per line, so `events --limit 3` prints five lines. `events` prints one
compact record per stored event; `--full` prints the stored envelopes. A
`StreamChunk` is live only, so `events` never lists one, and `wait --until
turn` reads its reply from the answers the turn stored. Each record's `id` is a cursor
for `--since` and `--after`. `send --request-id <id>` makes a retry safe: the
server admits one message per id, and with `--new` creates one session per id,
so a repeated `send --new --request-id <id>` names the same session and
message. `request` sends one extension request, as a client extension does,
and prints its reply as it crosses the wire: `{"_tag":"Value","value":…}`, the
output's encoded JSON, or `{"_tag":"Void"}` for a request whose output is
`Schema.Void` (`/goal`). A client extension may project one of its requests
into a `status` flag (`ctlProjection` in the client contribution): `status
--run <id>` is the machines extension's `run-status` request, printed as
`View` with the encoded reply in `view`.

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
Codex's reset credits; a lapsed grant counts none, and an account with none
is not named). No free lane is data, not a failure: the call exits 0.

A failure prints one tagged JSON line on stderr and exits with its code:

| Exit | Error             | Meaning                                                                                               |
| ---- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| 0    |                   | Success                                                                                               |
| 1    | `CtlFailed`       | An RPC or request failure, a lost connection, or a defect (`defect: …`; the client log has the cause) |
| 2    | `CtlUsage`        | A flag or argument the parser refuses, or flags that parse but do not fit together                    |
| 3    | `CtlNoServer`     | No live server for the data directory                                                                 |
| 4    | `CtlNotFound`     | The session or branch does not exist                                                                  |
| 124  | `CtlWaitTimedOut` | `wait` saw no match in `--timeout` seconds; `cursor` is the last event id it read                     |
