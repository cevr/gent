# @gent/e2e

Each file in `packages/e2e/tests/` is one area:

- `packages/e2e/tests/e2e.test.ts` and `packages/e2e/tests/scrollback.test.ts`: the TUI on a real pty.
- `packages/e2e/tests/server-lifecycle.test.ts`: the server process lifecycle.
- `packages/e2e/tests/machines-hard-kill.test.ts`: a machine run across a SIGKILL of its host (`packages/e2e/src/machine-host.ts`, a process entry with routed fake models): rounds, commands and answers run once, and the run goes on with no client call.
- `packages/e2e/tests/drive.test.ts`: the drive-script runner below.
- `packages/e2e/tests/pty-fixture.test.ts`: the fixture's screen reads on recorded frames, with no process.
- `packages/e2e/tests/verify.test.ts`: the verify-gent helpers (`packages/e2e/src/verify.ts`) as a shell runs them: launch, doctor, a `gent ctl` turn, stop.

`bun run test:e2e` from the root runs them all, one file at a time. `bun run test` runs only the fixture test, the one that spawns nothing.

Every wait for a gent that a test starts from source (the first frame, the server's ready line, a headless run's exit) has one bound, `GENT_START_BOUND_MS` from `@gent/core/test-utils`. The bound times a warm start, about 1.5 CPU-seconds: the test preload names one transform cache for the checkout (`XDG_CACHE_HOME`, `node_modules/.cache/gent-test`), and each `test:e2e` lane also preloads `packages/tooling/src/warm-source-start-boundary.ts`, which fills that cache before the first test. A start with a cold cache costs about 5.5 CPU-seconds and misses the bound once the load passes 30, so a bare `bun test` of one file, which skips the warm-up, can fail its first start on a loaded machine.

`packages/e2e/src/pty-fixture.ts` owns the pty: zigpty in the caller's scope, with `@xterm/headless` as the screen. zigpty makes the pty the child's controlling terminal, so a resize reaches the child as SIGWINCH and ctrl+c in cooked mode as SIGINT. `Bun.Terminal` (Bun 1.4.2) does not: its child has no controlling terminal and gets neither signal (`stty size` follows a resize only because it reads the size directly). Switch to it when Bun fixes that.

## Drive scripts

A live check can run as a script on the same fixture, without herdr. `bun run verify:drive` runs one inside a scratch run that `verify:launch` seeds and serves (the verify-gent skill, `.claude/skills/verify-gent/SKILL.md`); `drive.ts` below runs one with no run around it. gent has no default model: a scratch home with no `model` starts the TUI on `no model · /model`, and a sent prompt is refused. Seed one in the scratch home before the run, as the pty fixture does:

```bash
mkdir -p /tmp/scratch/home/.gent
printf '{"model":"<provider>/<model>"}\n' > /tmp/scratch/home/.gent/config.json
bun packages/e2e/src/drive.ts <script.json> [--no-record] [--print]
```

```json
{
  "command": ["/bin/sh", "./gent.sh", "--debug"],
  "env": { "HOME": "/tmp/scratch/home", "GENT_DATA_DIR": "/tmp/scratch/data" },
  "cols": 60,
  "rows": 20,
  "out": "caps",
  "steps": [
    ["waitFor", "debug", 30000],
    ["settle"],
    ["keys", "ctrl+p"],
    ["send", "/clear"],
    ["settle", 300],
    ["cap", "palette-60"],
    ["resize", 120, 40],
    ["settle"],
    ["capAll", "palette-120-with-history"]
  ]
}
```

- `command` runs on the pty; `cwd` and `out` resolve against the script's directory. `ground` (`dark` by default, or `light`) is what the emulator reports to a colour query: Tomorrow Night's ground, or Tomorrow's white one for a light-mode check. `env` values are used as written (give absolute paths) and laid over `PATH`, `COLORTERM` and `LANG` only (zigpty adds `TERM`), shared by the pty program and `sh` steps, so no key from the caller's environment reaches either unless the script names it.
- `sweep` names further `[cols, rows]`: the steps run at `cols`x`rows`, at each size it names, then once more from the first size through a live `resize` to the last, followed by `settle`, `fits` and `cap resized`. A `resize` fails once the program has exited. Each pass prints `== <size>` on stderr and writes to `out/<size>/` (`out/<first>-<last>/` for the resize), with its own captures, recording and last pass; a failure names its pass's size.
- Steps: `send` text, `keys` a name from `keys` in `src/pty-fixture.ts` (other text goes as is), `wait` ms, `waitFor` a regex on the screen (default 15 s; a miss is recorded, the script goes on), `settle` until quiet for that many ms (default 500; no quiet within 15 s fails the script), `resize` cols rows, `cap` / `capAll` the screen without / with scrollback, `cells` the cursor row's first 16 cells, `raw` the bytes so far, `sh` a shell command in `cwd` with an optional limit in ms (default 30 s), and the assertions on the visible screen: `expect` / `expectNot` a regex (matched against the rows joined by newlines) in an optional span `[first, last]` (1-based, inclusive, negative from the bottom), `fits` (no row the terminal wrapped, no word cut at the right edge) in an optional span, `stable` ms (the screen does not change that long). An `sh` step runs in a process group of its own; the group stops with the step, so a command it left in the background stops too. A non-zero exit or a step past its limit fails the step.
- The decoder refuses a `waitFor`, `expect` or `expectNot` pattern that is not a valid regex, a row 0 in a span, a capture name that is not a plain file name (letters, digits, `_`, `.` and `-`, first a letter, digit or `_`), and a `sweep` that names a size twice (the first included) or beside a capture named `resized`.
- Each capture lands in `out/<name>.txt` (`raw`: `<name>.raw`), and an `sh` step has `$EVIDENCE` set to `out`; `--print` also prints the screen. The screen is a live emulator that follows each resize and answers the program's terminal queries, so a capture after a resize reads as a terminal window would.
- Each step prints one line on stderr: `ok   <step> <ms>ms [file]` (the file named from `out`), `miss <step> <ms>ms`, or `FAIL <step> <ms>ms <reason>`, under a failed assertion the rows that show why. The last stderr line is `pass <ok>/<steps> · <end> · <out>`.
- A pass that passes copies its `.txt` captures to `out/passed/` (`keepPassed`, called once the caller's own checks passed too); a later run into the same `out` that fails prints each capture's rows that changed since that pass.
- The run records the terminal to `out/drive.cast` (asciicast v2; `--no-record` skips it). The recording is saved when the run fails or is interrupted too.
- At the end the program gets ctrl+c, then SIGKILL to its process group after a second. Stdout has one line, `end=<Exited|Stopped|Survived> recording=<file|none>`, for each pass, led by `size=<size>` in a sweep.
- `exit` names the code the program must exit with by itself before the steps end. Without `exit`, the program may exit 0 or still run when the steps end. A missed or failed step, or an end the script does not expect, fails the run with exit 1.
