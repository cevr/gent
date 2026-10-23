# TUI verify: live checks without herdr, at the fewest tokens

Owner, 2026-10-21: "we should build for Gent kind of the verification tool that makes it so we don't have to call herder that it can be most token efficient as possible".

## What exists (measured 2026-10-21)

- `packages/e2e/src/pty-fixture.ts`: zigpty plus `@xterm/headless`. The child owns its terminal, so resize sends SIGWINCH, ctrl+c sends SIGINT, and terminal queries get answers.
- `packages/e2e/src/drive.ts`: runs a JSON script of steps (`send`, `keys`, `waitFor`, `settle`, `resize`, `cap`, `capAll`, `sh`) on that pty, with no herdr. Each `cap` prints the whole screen. That is the token cost: a 120x40 capture is about 4,800 characters, and a check takes several.
- `testbeds/gamut/gamut.ts`: the multi-model live run. `up`, `read`, `send`, `wait`, `interrupt` and `restart` all go through a herdr pane (26 references). `status` reads the run's `data.db`, and needs no pane.

## Goal

An agent verifies a TUI change with one command. The command returns a few lines when the check passes, and only the rows that matter when it fails. herdr is not needed for any check.

## Unit 1: `gent ctl` and the verify-gent skill (owner, 2026-10-21)

The retro measured 362 times that agents drove gent through herdr panes by hand, because gent has no control CLI. P3 of [kernel-orchestration.md](kernel-orchestration.md) names it.

- `gent ctl send|events|wait|snapshot|status`: JSON output over the existing RPC. One session or run per call. `wait` has its own exit code for a timeout.
- Then `/create-verification-skill` writes `.claude/skills/verify-gent` on top of `gent ctl` and `testbeds/gamut`, with a feature map of the TUI abilities.
- Done when the skill is proved end to end once, with its proof path in the report.

- **Stack** (owner, 2026-10-21; `create-verification-skill` step 2, dotfiles `d163cc6`). Each helper (`gent ctl`, `verify:launch`, `verify:doctor` and the rest) is an Effect v4 program on Bun, written to the `effect` skill:
  - `effect/cli` for commands and flags;
  - the platform `ChildProcessSpawner` and `FileSystem`;
  - `Schema` for each JSON value it prints or reads;
  - `Effect.timeout` and `Schedule` for readiness waits;
  - scoped resources, so a launched app stops when the drive ends;
  - the repo's own services and test layers (the RPC client, `pty-fixture.ts`, the scratch-home guards), no new ones.
  - A success prints one JSON result. A failure prints a tagged error and exits non-zero.

The design below (assertions, size sweep, a herdr-free gamut) comes after unit 1, as the skill shows what it still needs.

### Unit 1 status (2026-10-21)

- **Merged** at `29e600828`, `824569f83`, fix `27a38b795` (one Codex round: 3 blockers, 8 should-fix, 1 nit, all fixed).
- `gent ctl send|events|wait|snapshot|status|request`: exit 0 ok, 1 failed, 2 usage, 3 no server, 4 not found, 124 wait timed out. `status --run <id>` comes from the machines extension's client projection; the TUI host holds no machine code.
- A request reply crosses the wire as a value or void, decoded with `decodeRequestReply` and the request's output schema. This also fixed the `/sessions` pane, which stayed on `Loading…` since an optional key set to `undefined` failed the encoder.
- `.claude/skills/verify-gent`: `bun run --silent verify:launch|doctor|drive|stop` in `packages/e2e/src/verify.ts`, ten drives over six feature files, an asciicast `drive.cast` per drive, captures in files (`--print` to show them). A passing turn drive prints 32 lines (measured). Cold-start proof: scratchpad `verify-gent-proof-2/`, all ten drives `Driven`, no PID, port or run dir left.
- **Open:** the Sessions pane takes 5 to 7 s to leave `Loading…` with 9 sessions while the server answers in about 2 ms (measured, cause not found); the Sessions detail says `(anthropic)` and the status row `(Anthropic)`; the Workbox host is unproven; most of a drive's output bytes are long evidence paths (print them relative to `--out`).

## Design

1. **Assertions, not captures.** New drive steps:
   - `expect <regex> [rows a..b]` and `expectNot`: on a pass, one line; on a fail, the matched region (or the named rows) plus three rows of context.
   - `fits`: no row of the screen wraps, and no text is cut at the right edge. This catches the wrapped-row bugs the gate missed.
   - `stable <ms>`: the screen does not change for that long. This catches a status that stays on "running".
   - `cap` stays, but is written to `out/` and not printed unless `--print` is set.
2. **Size sweep.** A script that names `sizes: [[120,40],[60,20]]` runs its steps at each size, then once more through a live resize from the first size to the last. The output is one block for each size.
3. **Compact report.** One line per step: `ok`, `FAIL` or `miss`, the step, and its time. At the end: `pass N/M`, the exit code, and the out directory. On a fail, the output also has a screen diff against the last passing capture of the same name, with only the changed rows.
4. **A herdr-free gamut.** `gamut up` starts the TUI on the pty fixture in a detached host process, which owns the pty and listens on a Unix socket in the run's scratch directory. `send`, `keys`, `interrupt`, `restart` and `down` become socket calls. `read` returns only the rows that changed since the last read, with `--full` for the whole screen. `wait` keeps its database rule and asks the host for the tray pulse, not the pane text. With no herdr pane, a run starts from any shell, a subagent included.
5. **Scratch setup in the tool.** The script takes `model` and a fixture, and the tool seeds the scratch `HOME`, `GENT_DATA_DIR` and config. The tool refuses paths outside the scratch directory, as `fetch-capture.ts` does.

### Items 1 and 3 status (2026-10-23)

- `expect`, `expectNot`, `fits`, `stable` and the compact report with a diff against `out/passed/` are in `packages/e2e/src/pty-fixture.ts`. Drive output names files relative to `out` (the unit-1 leftover).
- Each assertion was broken in turn (8 probes); each break fails a test in `packages/e2e/tests/drive.test.ts` (measured).
- `fits` reads the terminal's wrap flag (only while the row still ends on text at the last column; a row painted over keeps a stale flag) and the last two cells, skipping wide characters and keeping a combining mark with its letter. The cut rule is a guess: a word that ends exactly at the edge reads as cut. Old captures end on `$0.02`, `…` and borders at the last column, so only two letters at the edge count as a cut (measured on `tree-sections` captures).
- Live: a drive with `expect`, `fits` and `stable` at 120x40, a resize to 60x20 and back passed 3/3 at 25 stderr lines (load 7.57 on 12 cores). `stable` right after `ready` caught the status row drawing `(anthropic)`, then `(Anthropic)` (1 of 3 runs).
- Open: the diff is row by row, so a block that moved shows every row it crossed; item 2 (size sweep), item 4 (gamut without herdr) and item 5 (scratch setup) are not started.

## Done when

- A drive script with `expect`, `fits` and a two-size sweep passes on the current TUI and fails on a planted wrap. Each assertion is proved by breaking it first.
- `gamut up/send/read/wait/status/down` runs with herdr not installed (`PATH` without it), and `read` after a short answer prints fewer than 10 rows.
- A typical check (start, send a prompt, wait, assert, resize, assert) prints under 40 lines when it passes (target, guess).
- The steering docs say that a live check is verify-gent, `drive.ts` or gamut, not herdr. Done in unit 1 (`824569f83`).

## Order

Unit 1 is the next unit after stage 3. After stage 3 of [kernel-orchestration.md](kernel-orchestration.md) merges, and before stage 4b. Every later TUI change gets cheaper to check.
