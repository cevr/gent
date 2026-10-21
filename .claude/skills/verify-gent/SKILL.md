---
name: verify-gent
description: Launch gent (this repo's TUI agent harness) on the scripted model in a scratch home, check the run is worth driving, drive the real TUI and `gent ctl` as a user does from a feature map, and keep the proof. Use to check a change in the real TUI, to confirm a turn, a slash command, a pane, a picker or a ctl call works, or to show the owner it works. No paid model call, no owner data.
---

# Verify gent

One run is one scratch directory: a seeded home, a source server of this checkout on the scripted model, and a `gent` wrapper that reaches only that server. A drive opens the real TUI on a pty (zigpty and a headless xterm, no herdr), sends keys, waits for text and saves each screen. `gent ctl` reads and drives the same session from a shell.

Run every command from the checkout under test. Use `bun run --silent`, so stdout holds only the command's JSON.

## Launch

```sh
RUN="$TMPDIR/verify/<name>"            # a new directory, outside every checkout
bun run --silent verify:launch --dir "$RUN"
```

It prints one `Launched` line: `dir`, `work`, `gent`, `url`, `build`, `supervisorPid`, `serverPid`, `ms` (about 1.3 s on the laptop, measured). It refuses a directory that is not empty or that is inside the checkout. What it seeds:

- `$RUN/home`: `HOME`, with `.gent/config.json` naming `anthropic/claude-sonnet-5`.
- `$RUN/data`: `GENT_DATA_DIR`. `$RUN/auth`: fake provider keys (`GENT_AUTH_DIRECTORY`). `$RUN/gh`: an empty `gh` config.
- `$RUN/work`: the workspace. A drive runs there unless its script names a `cwd`.
- `$RUN/bin/gent`: runs this checkout's `apps/tui/src/main.tsx` with the run's environment and nothing of the caller's.
- `$RUN/run.json`: the record. `$RUN/server.log`, `$RUN/serve.log`: the server and supervisor output.

The server is `gent server start --mock`: the scripted model. A message that holds a debug phrase plays a scenario (`DEBUG_SCENARIOS` in `packages/core/src/runtime/provider.ts`): `debug tools` (six tool steps, the last fails), `debug ask` (a background question, then a 20 s bash step), `debug think` (a reasoning heading, one bash step, the answer `Both chrome paths draw once.`), `debug threads`, `debug delegate`, `debug handoff`, `debug usage limit`. Any other message gets `gent debug response. Latest user message: …`.

Ready means usable: the record exists and the lock's server answers with the recorded PID. A turn needs no warm-up.

## Doctor

```sh
bun run --silent verify:doctor --dir "$RUN"
```

Read-only. It prints `Healthy` with every check and `timingsMeaningful`, or fails with `DoctorFailed` naming the first failed `check`:

- `record`: `run.json` parses.
- `supervisor`: the recorded supervisor PID is alive and runs `verify.ts serve`.
- `server`: the data directory's lock names the recorded server PID, and its identity route answers.
- `build`: the server's build is `src-<short HEAD>` of this checkout; uncommitted files are counted in the detail.
- `client`: a client lists sessions within 10 s.
- `scratch`: `HOME`, `GENT_DATA_DIR` and `GENT_AUTH_DIRECTORY` are under `$RUN`.
- `log`: the logs under `$RUN/data/logs` hold no `Error` or `Fatal` line.
- `load`: the load average against the core count. Above it, `timingsMeaningful` is false: claim no timing.

Run it before the first drive, and again after any surprising result.

## Drive

A drive is a JSON script for `verify:drive`, which runs it on the run's TUI:

```sh
bun run --silent verify:drive --dir "$RUN" --script <script.json> --out "$EVIDENCE/<feature>"
```

- `command` is the argv. `["gent", …]` runs the run's wrapper: `["gent"]` opens a new session, `["gent", "resume"]` the last one, `["gent", "-p", "<prompt>"]` sends a first prompt.
- Steps: `["send", text]`, `["keys", name]` (`enter`, `esc`, `tab`, `up`, `down`, `backspace`, `ctrl+c`, `ctrl+p` …, the `keys` table in `packages/e2e/src/pty-fixture.ts`), `["waitFor", regex, ms]`, `["settle", ms]` (the screen is quiet that long), `["wait", ms]`, `["resize", cols, rows]`, `["cap", name]`, `["capAll", name]` (with scrollback), `["sh", command]`.
- `sh` runs in the workspace with `gent` on `PATH` as the run's wrapper and `$EVIDENCE` set to `--out`. `gent ctl` there finds the run's server through its data directory.
- It prints `Driven` (`exit`, `captures`, `hits`). A `waitFor` that never matched or an `sh` step that failed makes it fail with `DriveMissed` (`misses`, `shells`), after the script ran to its end.
- Reach a state by keys and slash commands. `gent ctl send` is a second client, a user path of its own; never a setter that skips the TUI.

Feature recipes, with a shipped script each: [features/README.md](features/README.md).

`gent ctl` (full surface in `apps/tui/docs/cli.md`): `send`, `events`, `wait`, `snapshot`, `status`, `request`. Outside a drive, run it as `$RUN/bin/gent ctl … --cwd $RUN/work`. Exit codes: 0 ok, 1 failed, 2 usage, 3 no server, 4 not found, 124 wait timed out.

## Evidence

The caller names the evidence directory, outside every checkout (`verify:drive` refuses one inside). One subdirectory per feature. What it holds:

- each `cap` as `<name>.txt`: a header (`# <name> <cols>x<rows> buffer=… cursor=… t=<ms>`), then numbered rows;
- the files the script's `sh` steps write: `gent ctl` JSON (`events`, `snapshot`, `status`, a `request` reply) and workspace files;
- the drive's own output: the `Driven` or `DriveMissed` line, and each step's hit or miss on stderr (keep it: `2> "$EVIDENCE/<feature>.log"`).

Proof rules:

- A write is proved by a second view: a `gent ctl` read, a `gent resume`, or a file in `$RUN/work`.
- A flaky step is reported as n/n trials, with the doctor's load line.
- A failure is rerun on a second run of the base commit (a fresh `$RUN`), to tell new from pre-existing.
- An entry point the run cannot reach is reported with its unmet precondition, never passed through another path.

## Cleanup

```sh
bun run --silent verify:stop --dir "$RUN" --remove
```

It sends SIGTERM to the recorded supervisor (only when that PID still runs `verify.ts serve`), waits up to 10 s, then SIGKILLs a recorded PID that still runs the run's command. It prints `Stopped` with `alive` (empty when nothing is left) and `removed`. Never kill by name: the owner's gent and other runs match. Evidence stays where `--out` put it.

## Helpers

| Command                                                                 | Prints                         |
| ----------------------------------------------------------------------- | ------------------------------ |
| `bun run --silent verify:launch --dir <run> [--port 0] [--timeout 90]`  | `Launched`                     |
| `bun run --silent verify:doctor --dir <run>`                            | `Healthy`, else `DoctorFailed` |
| `bun run --silent verify:drive --dir <run> --script <file> --out <dir>` | `Driven`, else `DriveMissed`   |
| `bun run --silent verify:stop --dir <run> [--remove]`                   | `Stopped`                      |

All four are `packages/e2e/src/verify.ts`, tested by `packages/e2e/tests/verify.test.ts` (in `bun run test:e2e`). A helper failure is one `VerifyFailed` line (`step`, `message`) on stderr and exit 1. `bun packages/e2e/src/drive.ts <script>` runs a script with no run around it, when a check needs no server.

## Hosts

Proved on the laptop (macOS) only. The Workbox (`bite-cristian`) is unproven: the `ps` and `git` checks and the zigpty pty are untested there. Several runs can live side by side: each run has its own port (`--port 0` picks a free one) and its own data directory. Never drive the owner's gent: its lock is under `~/.gent`, which no run reads.
