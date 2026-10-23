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

It prints one `Launched` line: `dir`, `work`, `gent`, `url`, `build`, `supervisorPid`, `serverPid`, `ms` (about 1.3 s on the laptop, measured). Paths are the real paths (`/private/tmp/…`, not `/tmp/…`). It refuses a directory that is not empty or that is inside the checkout under any name, a symlink included. Until the server answers, launch owns the supervisor: ctrl+c, a kill or a failure of launch stops the supervisor and its server. What it seeds:

- `$RUN/home`: `HOME`, with `.gent/config.json` naming `anthropic/claude-sonnet-5`.
- `$RUN/data`: `GENT_DATA_DIR`. `$RUN/auth`: fake provider keys (`GENT_AUTH_DIRECTORY`). `$RUN/gh`: an empty `gh` config. `$RUN/cache`: the source transform cache (`XDG_CACHE_HOME`).
- `$RUN/work`: the workspace. A drive runs there unless its script names a `cwd`.
- `$RUN/bin/gent`: runs this checkout's `apps/tui/src/main.tsx` with the run's environment and nothing of the caller's.
- `$RUN/pids.json`: the receipt `stop` reads, written as each process starts. `$RUN/run.json`: the record, written once the server answers.
- With `--data <file>`: a copy of the file in `$RUN/data`, there before the server starts. It seeds server state the scripted model cannot make, such as the account ledger `credential-usage.json` ([lanes](features/lanes.md)).
- `$RUN/server.log`, `$RUN/serve.log`: the server and supervisor output. `$RUN/verify.log`: the whole cause of a helper defect.

The server is `gent server start --mock`: the scripted model. A message that holds a debug phrase plays a scenario (`DEBUG_SCENARIOS` in `packages/core/src/runtime/provider.ts`): `debug tools` (six tool steps, the last fails), `debug ask` (a background question, then a 20 s bash step), `debug think` (a reasoning heading, one bash step, the answer `Both chrome paths draw once.`), `debug threads`, `debug delegate`, `debug handoff`, `debug machine` (starts the `soak` machine: one 45 s command), `debug usage limit`. Any other message gets `gent debug response. Latest user message: …`.

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
- `scratch`: `HOME`, `GENT_DATA_DIR`, `GENT_AUTH_DIRECTORY` and `XDG_CACHE_HOME` resolve under `$RUN`.
- `log`: the logs under `$RUN/data/logs` hold no `Error` or `Fatal` line.
- `load`: the load average against the core count. Above it, `timingsMeaningful` is false: claim no timing.

Run it before the first drive, and again after any surprising result.

## Drive

A drive is a JSON script for `verify:drive`, which runs it on the run's TUI:

```sh
bun run --silent verify:drive --dir "$RUN" --script <script.json> --out "$EVIDENCE/<feature>" 2> "$EVIDENCE/<feature>.log"
```

- `command` is the argv, and its program is `gent`: the run's wrapper. `["gent"]` opens a new session, `["gent", "resume"]` the last one, `["gent", "-p", "<prompt>"]` sends a first prompt. Another program is refused.
- The steps, the assertions (`expect`, `expectNot`, `fits`, `stable`), the checks a script passes before it runs, and the stderr report with its diff against the last pass: [drive-script.md](drive-script.md). Read it before you write or change a drive.
- It prints `Driven` (`passes`, one for each size a script runs at: `size`, `steps`, `end`, `captures`, `recording`; files named from `--out`). It fails with `DriveFailed` (`out`, `problems`, one line each, led by the size in a sweep) after the script ran to its end when a `waitFor` never matched, an assertion failed, an `sh` step exited non-zero or outlived its limit, or the program exited by itself with another code than the script's `exit` (0 when it names none). A program still running when the steps end is stopped by the drive (`end: Stopped`) and passes, unless the script names an `exit`.
- Reach a state by keys and slash commands. `gent ctl send` is a second client, a user path of its own; never a setter that skips the TUI.

Feature recipes, with a shipped script each: [features/README.md](features/README.md).

`gent ctl` (full surface in `apps/tui/docs/cli.md`): `send`, `events`, `wait`, `snapshot`, `status`, `request`, `lanes` (no session; `--line` prints the band's row). Outside a drive, run it as `$RUN/bin/gent ctl … --cwd $RUN/work`. Exit codes: 0 ok, 1 failed, 2 usage (a flag the parser refuses too), 3 no server, 4 not found, 124 wait timed out. Every failure is one JSON line on stderr. `status --run <id>` prints a machine run's view (`View`), the machines extension's projection of its `run-status` request. A `request` reply is `{"_tag":"Value","value":…}`, or `{"_tag":"Void"}` for a request with no output (`/goal`). `send --new --request-id <id>` is safe to retry: the same id makes one session and one message.

## Evidence

The caller names the evidence directory, outside every checkout (`verify:drive` refuses one inside). One subdirectory per feature. What it holds:

- each `cap` as `<name>.txt`: a header (`# <name> <cols>x<rows> buffer=… cursor=… t=<ms>`), then numbered rows;
- `passed/<name>.txt`: the captures of the last drive into this directory that passed, which a failing drive is diffed against;
- `drive.cast`: the whole drive as an asciicast v2 recording, on by default (`--no-record` turns it off). Before it prints `Driven`, the drive reads it back as a player does: a version 2 header at the size the pass starts at, events in time order, a length above zero. `Driven.recording` names the file, its `seconds` and `events`. Any asciicast v2 player plays it (`asciinema play`, not installed on the laptop);
- the files the script's `sh` steps write: `gent ctl` JSON (`events`, `snapshot`, `status`, a `request` reply) and workspace files;
- a sweep (`sweep` in the script) holds the files above in one directory for each pass, named by its size: `120x40/`, `60x20/`, `120x40-60x20/` for the live resize;
- the drive's own output: the `Driven` or `DriveFailed` line, and the step lines on stderr (keep them: `2> "$EVIDENCE/<feature>.log"`).

Proof rules:

- A write is proved by a second view: a `gent ctl` read, a `gent resume`, or a file in `$RUN/work`.
- A flaky step is reported as n/n trials, with the doctor's load line.
- A failure is rerun on a second run of the base commit (a fresh `$RUN`), to tell new from pre-existing.
- An entry point the run cannot reach is reported with its unmet precondition, never passed through another path.

## Cleanup

```sh
bun run --silent verify:stop --dir "$RUN" --remove
```

It reads the receipt `$RUN/pids.json`, so a run whose launch died before its server answered stops too. It sends SIGTERM to the recorded supervisor (only when that PID still runs `verify.ts serve`), waits up to 10 s, then SIGKILLs a recorded PID that still runs the run's command. It prints `Stopped` (`supervisorPid`, `serverPid`, `removed`) only when `ps` shows no recorded PID left. When `ps` cannot run, or a PID survives the SIGKILL, it fails with `StopFailed` (`alive`) and keeps the receipt and the directory: run it again. Never kill by name: the owner's gent and other runs match. Evidence stays where `--out` put it.

## Helpers

| Command                                                                                         | Prints                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------ |
| `bun run --silent verify:launch --dir <run> [--port 0] [--timeout 90] [--data <file>]`          | `Launched`                     |
| `bun run --silent verify:doctor --dir <run>`                                                    | `Healthy`, else `DoctorFailed` |
| `bun run --silent verify:drive --dir <run> --script <file> --out <dir> [--print] [--no-record]` | `Driven`, else `DriveFailed`   |
| `bun run --silent verify:stop --dir <run> [--remove]`                                           | `Stopped`, else `StopFailed`   |

All four are `packages/e2e/src/verify.ts`, tested by `packages/e2e/tests/verify.test.ts` (in `bun run test:e2e`). A helper failure is one tagged JSON line on stderr and exit 1: `VerifyFailed` (`step`, `message`), `DoctorFailed`, `DriveFailed` or `StopFailed`. A flag the parser refuses is `VerifyUsage` and exit 2. A defect is `VerifyFailed` with `step: "defect"`; its whole cause is in `$RUN/verify.log`. `bun packages/e2e/src/drive.ts <script> [--no-record] [--print]` runs a script with no run around it, when a check needs no server.

## Hosts

Proved on the laptop (macOS) only. The Workbox (`bite-cristian`) is unproven: the `ps` and `git` checks and the zigpty pty are untested there. Several runs can live side by side: each run has its own port (`--port 0` picks a free one) and its own data directory. Never drive the owner's gent: its lock is under `~/.gent`, which no run reads.
