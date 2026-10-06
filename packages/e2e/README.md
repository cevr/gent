# @gent/e2e

Each file in `packages/e2e/tests/` is one area:

- `packages/e2e/tests/e2e.test.ts` and `packages/e2e/tests/scrollback.test.ts`: the TUI on a real pty.
- `packages/e2e/tests/server-lifecycle.test.ts`: the server process lifecycle.
- `packages/e2e/tests/drive.test.ts`: the drive-script runner below.
- `packages/e2e/tests/pty-fixture.test.ts`: the fixture's screen reads on recorded frames, with no process.

`bun run test:e2e` from the root runs them all, one file at a time. `bun run test` runs only the fixture test, the one that spawns nothing.

Every wait for a gent that a test starts from source (the first frame, the server's ready line, a headless run's exit) has one bound, `GENT_START_BOUND_MS` from `@gent/core/test-utils`. The bound times a warm start, about 1.5 CPU-seconds: the test preload names one transform cache for the checkout (`XDG_CACHE_HOME`, `node_modules/.cache/gent-test`), and each `test:e2e` lane also preloads `packages/tooling/src/warm-source-start-boundary.ts`, which fills that cache before the first test. A start with a cold cache costs about 5.5 CPU-seconds and misses the bound once the load passes 30, so a bare `bun test` of one file, which skips the warm-up, can fail its first start on a loaded machine.

`packages/e2e/src/pty-fixture.ts` owns the pty: zigpty in the caller's scope, with `@xterm/headless` as the screen. zigpty makes the pty the child's controlling terminal, so a resize reaches the child as SIGWINCH and ctrl+c in cooked mode as SIGINT. `Bun.Terminal` (Bun 1.4.2) does not: its child has no controlling terminal and gets neither signal (`stty size` follows a resize only because it reads the size directly). Switch to it when Bun fixes that.

## Drive scripts

A live check can run as a script on the same fixture, without herdr. gent has no default model: a scratch home with no `model` starts the TUI on `no model · /model`, and a sent prompt is refused. Seed one in the scratch home before the run, as the pty fixture does:

```bash
mkdir -p /tmp/scratch/home/.gent
printf '{"model":"<provider>/<model>"}\n' > /tmp/scratch/home/.gent/config.json
bun packages/e2e/src/drive.ts <script.json>
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
- Steps: `send` text, `keys` a name from `keys` in `src/pty-fixture.ts` (other text goes as is), `wait` ms, `waitFor` a regex on the screen (default 15 s; a miss is logged, the script goes on), `settle` until quiet for that many ms (default 500; no quiet within 15 s fails the script), `resize` cols rows, `cap` / `capAll` the screen without / with scrollback, `cells` the cursor row's first 16 cells, `raw` the bytes so far, `sh` a shell command in `cwd`.
- Each capture prints and lands in `out/<name>.txt` (`raw`: `<name>.raw`). The screen is a live emulator that follows each resize and answers the program's terminal queries, so a capture after a resize reads as a terminal window would.
- At the end the program gets ctrl+c, then SIGKILL after a second; the script prints `exit=<code>`.
