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
bun run gamut wait                  # block until a turn has run, no session in the run's data.db has an open turn, and the pane shows no busy row
bun run gamut send "also run typecheck"   # types into the TUI composer, then Enter
bun run gamut interrupt             # one Ctrl-C
bun run gamut status                # what the run actually did (below)
bun run gamut restart               # quit and resume the same session
bun run gamut down                  # quit, close the pane, remove the scratch dir
```

`up` first checks that herdr has a current pane, and stops with one line if
not. It then copies `fixture/` to `$TMPDIR/gent-gamut-<timestamp>/work`, makes it a git
repo, installs it, writes the preset into `work/.gent/config.json` and the
roster block in `work/AGENTS.md`, builds `apps/tui/bin/gent` from **this**
checkout, and launches it in a fresh pane. The run is recorded in
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
- **`bun test` in the work dir**, pass and fail counts — the red app is the
  only real measure of whether the run did the work.

## The three traps it removes

1. **The real database.** A binary built anywhere opens `~/.gent/data.db` and
   runs its migrations there, which breaks every older binary. `up` exports
   `GENT_DATA_DIR` at the pane, so the run writes its own `data.db` in the
   scratch dir. Auth is unaffected: the auth store resolves from
   `${home}/.gent/auth`, not the data dir, so the real credentials still work.
2. **The wrong binary.** `~/.bun/bin/gent` points at whichever checkout last
   ran the gate. `up` builds and launches `apps/tui/bin/gent` by absolute path
   from this checkout, and never sets `GENT_LINK`.
3. **The stale TUI.** `pkill` returns before the process releases the PTY, so
   the next command types into the dying session. `restart` and `down` send two
   raw `\x03` bytes (`send-keys` does not deliver Ctrl chords) and then poll
   `pgrep` until the binary is gone.

## The fixture

Its red state is committed. `up` never edits it: every run gets a copy. It is
excluded from the repo's lint via `.oxlintignore`, and it is not a workspace,
so `bun run test` and `bun run typecheck` do not reach it — its four failing
tests are the exercise, not a regression.

The pure parts of `gamut.ts` (preset → config, roster rewrite, state file,
pane id) are covered by `testbeds/gamut/tests/gamut.test.ts`, which the
`@gent/tooling` test task runs.
