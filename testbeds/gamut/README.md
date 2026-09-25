# gamut testbed

A live multi-model run of the gent TUI against a red app, in one command.
`fixture/` is **ledgerline**: a Bun/TypeScript ledger with four failing tests
and six open tasks in its README. The agent under test is asked to fix it by
delegating to children, so one run exercises the orchestrator, the child
sessions, the tools, and the model overrides at once.

## Commands

```bash
bun run gamut list                  # the presets and the models each one pins
bun run gamut up sol-luna           # fresh scratch run in a new herdr pane
bun run gamut up mixed --prompt ./my-prompt.md --no-build
bun run gamut read 80               # the pane tail
bun run gamut wait                  # block until a turn has run (after a /command: any stored event, or about 15 s of quiet), no session in the run's data.db has an open turn, and the pane shows no busy row
bun run gamut send "also run typecheck"   # types into the TUI composer, then Enter
bun run gamut interrupt             # one Ctrl-C
bun run gamut status                # what the run actually did (below)
bun run gamut restart               # quit and resume the same session
bun run gamut down                  # quit, close the pane, remove the scratch dir
```

A preset names model families (`openai/sol`, `openai/luna`, `anthropic/opus`,
`anthropic/sonnet`, `anthropic/fable`), not releases. `up` and `list` resolve
each family to its newest release in the models.dev catalog (falling back to
gent's `~/.gent/models.json` copy offline), so a new Sol, Luna, Opus, Sonnet or
Fable release needs no edit here.

`up` first checks that herdr has a current pane, and stops with one line if
not. It then copies `fixture/` to `$TMPDIR/gent-gamut-<timestamp>/work`, makes it a git
repo, installs it, writes the preset into `work/.gent/config.json` and the
roster block in `work/AGENTS.md`, runs the root build of **this** checkout
(turbo: the `gent-cell` worker, then the `gent` binary beside it in
`apps/tui/`, under `bin/`), and
launches it in a fresh pane. The run is recorded in
`$TMPDIR/gent-gamut-<checkout name>.json`, one file per checkout, so two rifts can run at once.

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
- **`bun test` in the work dir**, pass and fail counts — the red app is the
  only real measure of whether the run did the work.

## The three traps it removes

1. **The real database.** A binary built anywhere opens `~/.gent/data.db` and
   runs its migrations there, which breaks every older binary. `up` exports
   `GENT_DATA_DIR` at the pane, so the run writes its own `data.db` in the
   scratch dir. Auth is unaffected: the auth store resolves from
   `${home}/.gent/auth`, not the data dir, so the real credentials still work.
2. **The wrong binary.** `~/.bun/bin/gent` is a copy of whichever checkout last
   ran `bun run install:global`; only that command replaces it, and the gate and the build
   leave it alone. `up` builds this checkout and launches its own binary (the
   one under `apps/tui/`) by absolute path, and never runs `bun run install:global`. It
   builds through the root build, so the `gent-cell` worker beside the binary
   is this checkout's too.
3. **The stale TUI.** `pkill` returns before the process releases the PTY, so
   the next command types into the dying session. `restart` and `down` press
   Ctrl-C up to four times, one raw `\x03` byte per press (`send-keys` does not
   deliver Ctrl chords), until the binary is gone: each press peels one layer
   (an expanded transcript, a draft in the composer, a running turn) and the
   last one exits. Then they poll `pgrep` until the process releases the PTY.

## The fixture

Its red state is committed. `up` never edits it: every run gets a copy. It is
excluded from the repo's lint via `.oxlintignore`, and it is not a workspace,
so `bun run test` and `bun run typecheck` do not reach it — its four failing
tests are the exercise, not a regression.

The pure parts of `gamut.ts` (preset → config, roster rewrite, state file,
pane id) are covered by `testbeds/gamut/tests/gamut.test.ts`, which the
`@gent/tooling` test task runs.
