import { makeTempDirectoryScoped, waitFor } from "@gent/core-internal/test-utils/language-model"
import { Terminal } from "@xterm/headless"
import { Clock, Effect, Predicate, Schema } from "effect"
import { spawn, type IPty } from "zigpty"
import { seedAuthBoundary } from "./auth-seed-boundary"
import { waitForProcessExit } from "./server-process-fixture"

const CTRL_C = "\x03"
const repoRoot = decodeURIComponent(new URL("../../..", import.meta.url).pathname).replace(
  /\/$/,
  "",
)
const tuiDir = `${repoRoot}/apps/tui`

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40

export interface PtySize {
  readonly cols: number
  readonly rows: number
}

export interface TestContext {
  readonly pty: IPty
  readonly output: string
  /** Bytes the child has written so far. Rises whenever the terminal repaints. */
  readonly bytesWritten: number
  readonly size: PtySize
  readonly resize: (size: PtySize) => void
  readonly tempDir: string
  readonly cleanup: Effect.Effect<void>
}

const ignoreSyncDefect = (evaluate: () => void): Effect.Effect<void> =>
  Effect.sync(evaluate).pipe(Effect.ignoreCause)

const spawnWithDir = (
  tempDir: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
  size: PtySize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
): TestContext => {
  const mainPath = `${tuiDir}/src/main.tsx`
  const preloadPath = `${tuiDir}/node_modules/@opentui/solid/scripts/preload.js`

  let output = ""
  let currentSize = size

  const pty = spawn("bun", ["--preload", preloadPath, mainPath, "--isolate", ...extraArgs], {
    name: "xterm-256color",
    cols: size.cols,
    rows: size.rows,
    cwd: tuiDir,
    env: {
      ...Bun.env,
      GENT_DATA_DIR: tempDir,
      GENT_AUTH_DIRECTORY: `${tempDir}/auth`,
      COLUMNS: String(size.cols),
      LINES: String(size.rows),
      ...extraEnv,
    },
  })

  pty.onData((data) => {
    output += data
  })

  const cleanup = Effect.gen(function* () {
    const pid = pty.pid
    yield* ignoreSyncDefect(() => pty.write(CTRL_C))
    const exited = yield* waitForProcessExit(pid, 1_000)
    if (!exited) {
      yield* ignoreSyncDefect(() => process.kill(pid, "SIGKILL"))
      yield* waitForProcessExit(pid, 2_000)
    }
    yield* ignoreSyncDefect(() => pty.close())
  })

  return {
    pty,
    get output() {
      return output
    },
    get bytesWritten() {
      return output.length
    },
    get size() {
      return currentSize
    },
    resize: (next: PtySize) => {
      currentSize = next
      pty.resize(next.cols, next.rows)
    },
    tempDir,
    cleanup,
  }
}

export const seedAndSpawn = (extraArgs: string[] = [], size?: PtySize) =>
  Effect.gen(function* () {
    const tempDir = yield* makeTempDirectoryScoped("gent-e2e-")
    yield* Effect.promise(() => seedAuthBoundary(`${tempDir}/auth`))
    return spawnWithDir(tempDir, extraArgs, {}, size)
  })

export const spawnNoAuth = Effect.gen(function* () {
  const tempDir = yield* makeTempDirectoryScoped("gent-e2e-")
  return spawnWithDir(tempDir)
})

export const seedSkillAndSpawn = Effect.gen(function* () {
  const tempDir = yield* makeTempDirectoryScoped("gent-e2e-")

  const fakeHome = `${tempDir}/home`
  const skillDir = `${fakeHome}/.claude/skills/test-skill`
  yield* Effect.promise(() => Bun.$`mkdir -p ${skillDir}`.quiet())
  yield* Effect.promise(() =>
    Bun.write(
      `${skillDir}/SKILL.md`,
      "---\nname: test-skill\ndescription: A test skill for e2e\n---\n\nTest skill content.",
    ),
  )

  yield* Effect.promise(() => seedAuthBoundary(`${tempDir}/auth`))
  return spawnWithDir(tempDir, [], { HOME: fakeHome })
})

export const ptyWaitFor = (ctx: TestContext, text: string, opts: { timeout: number }) =>
  waitFor(
    Effect.sync(() => stripAnsi(ctx.output)),
    (output) => output.includes(text),
    opts.timeout,
    `PTY output "${text}"`,
  ).pipe(Effect.asVoid)

// gent/no-sleep: allow PTY fixture primitive — deliberate OS-level pause for terminal redraw cycles
export const shortPause = (ms: number): Effect.Effect<void> => Effect.sleep(`${ms} millis`)

export const stripAnsi = (str: string): string => Bun.stripANSI(str)

// ── Settle-then-capture ──

export class PtySettleError extends Schema.TaggedError<PtySettleError>()(
  "@gent/e2e/PtySettleError",
  { message: Schema.String },
) {}

export interface SettleOptions {
  /** How long the child must write nothing before the output counts as settled. */
  readonly quietMs?: number
  /** How long to wait for that quiet window before failing. */
  readonly timeoutMs?: number
}

const SETTLE_POLL_MS = 50

/**
 * Wait until the child has written no new bytes for `quietMs`.
 *
 * A terminal repaints in bursts: one frame is many writes, and the rows a
 * commit hands to scrollback land in the same burst as the footer repaint that
 * follows it. Reading the grid mid-burst reads a half-drawn screen, so every
 * capture waits for the bytes to stop first. This is the one real asynchronous
 * boundary in these tests — no state signal says "the terminal is done", only
 * the absence of further output — so the wait is bounded and it fails loudly
 * when the quiet window never opens.
 */
export const settlePty = (
  ctx: TestContext,
  options: SettleOptions = {},
): Effect.Effect<void, PtySettleError> =>
  Effect.gen(function* () {
    const quietMs = options.quietMs ?? 500
    const timeoutMs = options.timeoutMs ?? 15_000
    const quietPolls = Math.max(1, Math.ceil(quietMs / SETTLE_POLL_MS))
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs

    const loop = (lastSeen: number, stablePolls: number): Effect.Effect<void, PtySettleError> =>
      Effect.gen(function* () {
        const seen = ctx.bytesWritten
        let stable = 0
        if (seen === lastSeen) stable = stablePolls + 1
        if (stable >= quietPolls) return
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* new PtySettleError({
            message:
              `pty never went quiet for ${quietMs}ms within ${timeoutMs}ms ` +
              `(${seen} bytes captured)`,
          })
        }
        yield* shortPause(SETTLE_POLL_MS)
        return yield* loop(seen, stable)
      })

    return yield* loop(-1, 0)
  })

// ── Terminal grid ──

/**
 * A parsed terminal, split the way a reader sees it: `history` is what has
 * scrolled off the top and survives only in the terminal's scrollback, and
 * `visible` is the screen itself.
 */
export interface TerminalGrid {
  readonly history: ReadonlyArray<string>
  readonly visible: ReadonlyArray<string>
  readonly cols: number
  readonly rows: number
}

/** Every row, history first, with blank rows dropped. */
export const gridText = (grid: TerminalGrid): ReadonlyArray<string> =>
  [...grid.history, ...grid.visible].map((row) => row.trimEnd()).filter((row) => row.length > 0)

/** History rows only, blank rows dropped. */
export const historyText = (grid: TerminalGrid): ReadonlyArray<string> =>
  grid.history.map((row) => row.trimEnd()).filter((row) => row.length > 0)

/** How many rows contain `needle`. */
export const countRows = (rows: ReadonlyArray<string>, needle: string): number =>
  rows.filter((row) => row.includes(needle)).length

/**
 * Replay raw pty bytes through a headless VT emulator and read the grid back.
 *
 * `@xterm/headless` is the engine VS Code's terminal runs on, so it models the
 * one mechanism these tests are about: a scroll region (`ESC[1;<n>r`) with a
 * line feed at its bottom row pushes the top row into scrollback. `baseY` is
 * where that scrollback ends and the screen begins.
 */
export const parseTerminal = (
  bytes: string,
  size: PtySize,
): Effect.Effect<TerminalGrid, never, never> =>
  Effect.callback<TerminalGrid>((resume) => {
    const terminal = new Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: 100_000,
      allowProposedApi: true,
    })
    terminal.write(bytes, () => {
      const buffer = terminal.buffer.active
      const readRow = (y: number): string => {
        const line = buffer.getLine(y)
        if (Predicate.isUndefined(line)) return ""
        return line.translateToString(false)
      }
      const history: string[] = []
      for (let y = 0; y < buffer.baseY; y++) history.push(readRow(y))
      const visible: string[] = []
      for (let y = buffer.baseY; y < buffer.length; y++) visible.push(readRow(y))
      terminal.dispose()
      resume(Effect.succeed({ history, visible, cols: size.cols, rows: size.rows }))
    })
  })

/** Settle, then replay everything captured so far into a grid. */
export const settleAndCapture = (
  ctx: TestContext,
  options: SettleOptions = {},
): Effect.Effect<TerminalGrid, PtySettleError> =>
  settlePty(ctx, options).pipe(Effect.andThen(parseTerminal(ctx.output, ctx.size)))
