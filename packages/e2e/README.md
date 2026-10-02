# @gent/e2e

Subprocess tests: the TUI on a real pty (`tests/e2e.test.ts`, `tests/scrollback.test.ts`) and the server process lifecycle (`tests/server-lifecycle.test.ts`). Run them with `bun run test:e2e` from the root.

`src/pty-fixture.ts` owns the pty: zigpty in the caller's scope, with `@xterm/headless` as the screen. zigpty makes the pty the child's controlling terminal, so a resize reaches the child as SIGWINCH and ctrl+c in cooked mode as SIGINT. `Bun.Terminal` (Bun 1.4.2) does not: its child has no controlling terminal and gets neither signal (`stty size` follows a resize only because it reads the size directly). Switch to it when Bun fixes that.

## Drive scripts

A live check can run as a script on the same fixture, without herdr:

```bash
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

- `command` runs on the pty; `cwd` and `out` resolve against the script's directory. `env` values are used as written (give absolute paths) and laid over `PATH`, `COLORTERM` and `LANG` only (zigpty adds `TERM`), so no key from the caller's environment reaches the program unless the script names it.
- Steps: `send` text, `keys` a name from `keys` in `src/pty-fixture.ts` (other text goes as is), `wait` ms, `waitFor` a regex on the screen (default 15 s; a miss is logged, the script goes on), `settle` until quiet for that many ms (default 500; no quiet within 15 s fails the script), `resize` cols rows, `cap` / `capAll` the screen without / with scrollback, `cells` the cursor row's first 16 cells, `raw` the bytes so far, `sh` a shell command in `cwd`.
- Each capture prints and lands in `out/<name>.txt` (`raw`: `<name>.raw`). The screen is a live emulator that follows each resize and answers the program's terminal queries, so a capture after a resize reads as a terminal window would.
- At the end the program gets ctrl+c, then SIGKILL after a second; the script prints `exit=<code>`.
