# gamut testbed

A live multi-model run of the gent TUI against a red app, in one command.
`fixture/` is **ledgerline**: a Bun/TypeScript ledger with four failing tests
and six open tasks in its README. The agent under test is asked to fix it by
delegating to children, so one run exercises the orchestrator, the child
sessions, the tools, and the model overrides at once.

## Commands

```bash
bun run gamut list                  # the presets and the models each one pins
bun run gamut up sol                # Sol at high effort for orchestration, ordinary work and review
bun run gamut up mixed --prompt ./my-prompt.md --no-build
bun run gamut up haiku --remote https://github.com/cevr/gamut-ledgerline  # origin for the merge gate
bun run gamut read                  # the rows added since the last read, or (no change)
bun run gamut read --full           # the whole screen
bun run gamut wait                  # block until a turn has run (after a /command: any stored event, or about 15 s of quiet), no session in the run's data.db has an open turn, and the screen shows no working child (the agents tray's pulse)
bun run gamut send "also run typecheck"   # types into the TUI composer, then Enter
bun run gamut keys esc down enter   # press named keys in order; an unknown name is refused with the list
bun run gamut interrupt             # one Ctrl-C
bun run gamut status                # what the run actually did (below)
bun run gamut restart               # quit and resume the same session
bun run gamut down                  # quit, stop the host, remove the scratch dir
```

`--remote <url>` adds that GitHub repository as the scratch repo's `origin`
and force-pushes the first commit to its `main`, so an orchestrate run's
merge gate can push and wait for CI. The fixture's
`.github/workflows/gate.yml` runs the project's whole gate (`bun run
typecheck`, `bun test`) on every push. Without `--remote` the run has no
remote, and a merge state fails with `No such remote 'origin'`. The owner's
throwaway private repository for this is `cevr/gamut-ledgerline`; each run
replaces its history.

The `sol` preset and fixture use `openai/gpt-6.1-sol` at `high` for ordinary
work and review. Only repetitive mechanical tasks use `openai/gpt-6-luna`
at `max`, through an explicit child override. Other presets are explicit
model comparisons. The `haiku` preset is the only one a live check may spend
the owner's Anthropic accounts on.

The TUI takes from the caller only its terminal basics (`PATH`, `SHELL`,
`USER`, `LOGNAME`, `TMPDIR`, `LANG`) and the proxy variables
(`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` in either case,
`NODE_EXTRA_CA_CERTS` and `ANTHROPIC_BASE_URL`). The host's config file
carries them owner-only and the host removes it once read, so no value
reaches a process argument. Run
`eval "$(teamclaude env --mitm)"`, or `--no-mitm` for its base-URL mode,
before `up` to send the run's Anthropic requests through the TeamClaude
account pool rather than the owner's own account.

A comparison preset names model families (`openai/sol`, `openai/luna`, `anthropic/opus`,
`anthropic/sonnet`, `anthropic/fable`, `anthropic/haiku`), not releases. `up` and `list` resolve
each family to its newest release in the models.dev catalog. Offline, they
use the chat catalog body (`source = api.json`) in `model_catalog_snapshots`
from `$GENT_DATA_DIR/data.db`, or the OS home directory's `.gent/data.db` when
`GENT_DATA_DIR` is unset. The driver copies the database and its WAL into a
fresh scratch directory, opens only that copy read-only, validates the body,
and removes the copy after reading. It reads no auth files. If there is no
valid chat snapshot, the original fetch error is reported. A new Sol, Luna,
Opus, Sonnet or Fable release needs no edit here.

`up` copies `fixture/` to `$TMPDIR/gent-gamut-<timestamp>/work`, makes it a git
repo, installs it, writes the preset into `work/.gent/config.json` (agents `main` and
`delegate`, and machine `tiers`: the reviewer as `strongest`, the worker as
`efficient`, which shadow the owner's tiers) and the roster block in `work/AGENTS.md`, runs the root build of **this** checkout
(turbo: the `gent-cell` worker, then the `gent` binary beside it in
`apps/tui/`, under `bin/`), and
launches it on its own terminal host. The run is recorded in
`$TMPDIR/gent-gamut-<checkout name>.json`. Rifts with different names can run at
once. Each command checks the recorded binary's canonical checkout path before
using the run. A checkout with the same name refuses a foreign run without
changing its host, state file or scratch tree. An existing owned run remains
discoverable at the same path.

## What `status` proves

It reads the run's own `data.db` read-only and prints:

- **the session tree** — parent and child sessions, indented, with names, so a
  delegation that never spawned a child is visible as a missing row;
- **the model per session**, from `StreamEnded.model`, so a preset that did not
  reach a child shows as the wrong model rather than passing silently;
- **every stored user message**, joined `messages` → `message_chunks` →
  `content_chunks`, so a prompt sent twice, or a resume that replayed one, is
  counted rather than guessed;
- **tool calls per session**, from `ToolCallStarted`;
- **extension pulses per extension**, the stored `ExtensionStateChanged`
  events grouped by `extensionId`, so a widget that refetched too often, or
  never, has a count;
- **context per model call**, the mean and the largest input tokens of
  `StreamEnded` (cache reads included), for the root sessions and the
  children apart;
- **re-read files**, an estimate of the share of the cells' output that is
  a file its session read before: a `read` answers the cell's code, so a
  cell counts at most its own output. Not seen: `context.read`, a value a
  cell kept from an earlier cell, a `read` outside a cell, a re-read through
  bash;
- **orchestrate units**, the orchestrate machine's runs, with its moves from
  the merge gate by `fail` and from `merge` by `red`, the gate failures per
  unit;
- **`bun test` in the work dir**, pass and fail counts — the red app is the
  only real measure of whether the run did the work.

## The four traps it removes

1. **The real database.** A binary built anywhere opens `~/.gent/data.db` and
   wipes it when its schema version differs, which breaks every older binary. `up` exports
   `GENT_DATA_DIR` to the TUI, so the run writes its own `data.db` in the
   scratch dir. Auth is unaffected: the auth store resolves from
   `${home}/.gent/auth`, not the data dir, so the real credentials still work.
2. **The wrong binary.** `~/.local/bin/gent` runs whichever release or checkout
   was last installed (`install.sh`, or `bun run install:global` from a checkout); only that command replaces it, and the gate and the build
   leave it alone. `up` builds this checkout and launches its own binary (the
   one under `apps/tui/`) by absolute path, and never runs `bun run install:global`. It
   builds through the root build, so the `gent-cell` worker beside the binary
   is this checkout's too.
3. **The stale TUI.** `pkill` returns before the process releases the PTY, so
   the next command types into the dying session. The host owns the TUI's
   process: `restart` and `down` press Ctrl-C every 300 ms until that process
   exits, which closes a UI layer, clears the draft or cancels a turn before
   arming exit. Past 15 seconds `restart` stops with the TUI left to read, and
   `down` kills it. Another process is never signalled: a host that has
   stopped is killed by its recorded id only while `ps` shows it is still the
   host.
4. **The real user config.** Five writers can reach `~/.gent/config.json` from
   the TUI: the first `/model` pick, a driver override set or cleared, the
   auth order, and a renamed auth slot. `up` gives the TUI `HOME` as
   `<scratch>/home`. Each top-level entry of the owner's home is a link
   there, and so is each entry of `~/.gent` except `config.json` (a copy) and
   the `data.db` files. The login, the skills and the shell read as before;
   a write to the user config changes the run's copy. `down` removes the
   links with the scratch tree, never what they point to.

## The fixture

Its red state is committed. `up` never edits it: every run gets a copy. It is
excluded from the repo's lint via `.oxlintignore`, and it is not a workspace,
so `bun run test` and `bun run typecheck` do not reach it — its four failing
tests are the exercise, not a regression.

## The terminal host

The TUI runs on a pty in `@gent/e2e`'s terminal host
(`packages/e2e/src/pty-host.ts`), a detached process that answers `send`,
`keys`, `read`, `wait`, `restart` and `down` on `<scratch>/host.sock` and logs
to `<scratch>/host.log`. It needs no terminal multiplexer. `read` keeps a mark:
it prints the rows the TUI added since the last read, from the scrollback and
the screen, and says how many rows of the last read are gone (a row drawn
over). Once gent exits, every read ends with its exit code. There is no
attach: watch a run with `read --full`. A host that has stopped (a kill, a
slept machine) is named with its log; `down` still cleans up.

The pure parts of `gamut.ts` (preset → config, roster rewrite, state file,
read output) and its commands on a real host, with a shell script in gent's
place, are covered by `testbeds/gamut/tests/gamut.test.ts`, which the
`@gent/tooling` test task runs; the host itself by
`packages/e2e/tests/pty-host.test.ts`.
