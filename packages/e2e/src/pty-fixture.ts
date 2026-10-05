import {
  makeTempDirectoryScoped,
  seedAuthKeys,
  serveModelCatalogFixture,
  TEST_MODEL_ID,
  waitFor,
} from "@gent/core/test-utils"
import { BunServices } from "@effect/platform-bun"
import { Terminal } from "@xterm/headless"
import {
  Array as Arr,
  Clock,
  Console,
  Context,
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  type Scope,
} from "effect"
import { constVoid } from "effect/Function"
import { spawn, type IPty } from "zigpty"
import { exitWithin, tuiDirectory } from "./server-process-fixture"

// ── Keys ──

/** The bytes a terminal in its default modes sends for each key a test or a drive script presses. */
export const keys = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  backspace: "\x7f",
  "alt+up": "\x1b[1;3A",
  "alt+backspace": "\x1b\x7f",
  "alt+backspace-csiu": "\x1b[127;3u",
  "ctrl+a": "\x01",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+e": "\x05",
  "ctrl+g": "\x07",
  "ctrl+j": "\n",
  "ctrl+o": "\x0f",
  "ctrl+p": "\x10",
  "ctrl+s": "\x13",
  "ctrl+t": "\x14",
  "ctrl+u": "\x15",
  "ctrl+w": "\x17",
  "ctrl+\\": "\x1c",
  "ctrl+backspace": "\x1b[127;5u",
  "ctrl+backspace-legacy": "\x08",
  "shift+enter": "\x1b[13;2u",
  "super+a": "\x1b[97;9u",
  "hyper+a": "\x1b[97;17u",
} as const satisfies Record<string, string>

// ── PTY ──

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40

interface PtySize {
  readonly cols: number
  readonly rows: number
}

export interface TestContext {
  readonly pty: IPty
  /** Everything the child has written so far. It grows whenever the terminal repaints. */
  readonly output: string
  readonly size: PtySize
  readonly resize: (size: PtySize) => void
}

interface PtyCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Record<string, string>
  readonly size: PtySize
}

const ignoreSyncDefect = (evaluate: () => void): Effect.Effect<void> =>
  Effect.sync(evaluate).pipe(Effect.ignoreCause)

/**
 * Start `command` in a pty that belongs to the caller's scope. Closing the
 * scope sends ctrl+c, waits for the exit, and kills a child that outlives the
 * wait. `onText` sees each chunk the child writes.
 *
 * zigpty makes the pty the child's controlling terminal, so a resize reaches
 * it as SIGWINCH and ctrl+c in cooked mode as SIGINT. `Bun.Terminal` (Bun
 * 1.4.2) does not: its child gets neither. Switch once Bun gives the child
 * a controlling terminal.
 */
const openPty = (
  spec: PtyCommand,
  onText: (text: string) => void = constVoid,
): Effect.Effect<TestContext, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let output = ""
      let currentSize = spec.size

      const pty = spawn(spec.command, [...spec.args], {
        name: "xterm-256color",
        cols: spec.size.cols,
        rows: spec.size.rows,
        cwd: spec.cwd,
        env: spec.env,
      })

      pty.onData((data) => {
        output += data
        onText(String(data))
      })

      const context: TestContext = {
        pty,
        get output() {
          return output
        },
        get size() {
          return currentSize
        },
        resize: (next: PtySize) => {
          currentSize = next
          pty.resize(next.cols, next.rows)
        },
      }
      return context
    }),
    ({ pty }) =>
      Effect.gen(function* () {
        yield* ignoreSyncDefect(() => pty.write(keys["ctrl+c"]))
        if (Option.isNone(yield* exitWithin(pty.exited, "1 second"))) {
          yield* ignoreSyncDefect(() => process.kill(pty.pid, "SIGKILL"))
          yield* exitWithin(pty.exited, "2 seconds")
        }
        yield* ignoreSyncDefect(() => pty.close())
      }),
  )

// ── TUI under test ──

/**
 * The home a spawned TUI reads, under `tempDir`: its user config names the
 * test model, as a first `/model` pick does, since gent ships no default model.
 */
const seedHome = (tempDir: string) =>
  Effect.gen(function* () {
    const fs = Context.get(yield* Layer.build(BunServices.layer), FileSystem.FileSystem)
    const home = `${tempDir}/home`
    yield* fs.makeDirectory(`${home}/.gent`, { recursive: true })
    yield* fs.writeFileString(`${home}/.gent/config.json`, `{"model":"${TEST_MODEL_ID}"}\n`)
    return home
  }).pipe(Effect.orDie)

/**
 * Start the TUI from this checkout, isolated in `tempDir`, its home included.
 * The child reads the fixture catalog from a loopback listener of the same
 * scope, never models.dev.
 */
const spawnWithDir = (
  tempDir: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
  size: PtySize = DEFAULT_PTY_SIZE,
): Effect.Effect<TestContext, never, Scope.Scope> =>
  Effect.all([seedHome(tempDir), serveModelCatalogFixture]).pipe(
    Effect.flatMap(([home, catalogOrigin]) =>
      openPty({
        command: "bun",
        args: [`${tuiDirectory}/src/main.tsx`, "--isolate", ...extraArgs],
        cwd: tuiDirectory,
        env: {
          // oxlint-disable-next-line effect/noGlobals -- the fixture hands the test's environment to the real TUI process
          ...Bun.env,
          HOME: home,
          GENT_DATA_DIR: tempDir,
          GENT_AUTH_DIRECTORY: `${tempDir}/auth`,
          GENT_MODEL_CATALOG_URL: catalogOrigin,
          // The `@gent/git` client runs `gh` when it is on PATH: an empty
          // config and no token keep it signed out, so it never reaches GitHub.
          GH_CONFIG_DIR: `${tempDir}/gh`,
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          ...extraEnv,
        },
        size,
      }),
    ),
  )

export const DEFAULT_PTY_SIZE: PtySize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }

export const seedAndSpawn = (
  extraArgs: string[] = [],
  size: PtySize = DEFAULT_PTY_SIZE,
  extraEnv: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const tempDir = yield* makeTempDirectoryScoped("gent-e2e-")
    yield* seedAuthKeys(`${tempDir}/auth`).pipe(Effect.orDie)
    return yield* spawnWithDir(tempDir, extraArgs, extraEnv, size)
  })

/**
 * Send the TUI a signal from outside, as `kill` does, and wait for its exit
 * code. `None`: it outlived `within`.
 */
export const signalAndExit = (ctx: TestContext, signal: NodeJS.Signals, within: Duration.Input) =>
  ignoreSyncDefect(() => process.kill(ctx.pty.pid, signal)).pipe(
    Effect.andThen(exitWithin(ctx.pty.exited, within)),
  )

export const spawnNoAuth = Effect.gen(function* () {
  const tempDir = yield* makeTempDirectoryScoped("gent-e2e-")
  return yield* spawnWithDir(tempDir)
})

export const seedSkillAndSpawn = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const tempDir = yield* makeTempDirectoryScoped("gent-e2e-")

  const skillDir = `${tempDir}/home/.claude/skills/test-skill`
  yield* fs.makeDirectory(skillDir, { recursive: true }).pipe(Effect.orDie)
  yield* fs
    .writeFileString(
      `${skillDir}/SKILL.md`,
      "---\nname: test-skill\ndescription: A test skill for e2e\n---\n\nTest skill content.",
    )
    .pipe(Effect.orDie)

  yield* seedAuthKeys(`${tempDir}/auth`).pipe(Effect.orDie)
  return yield* spawnWithDir(tempDir)
})

/** Wait until the output, colors stripped, has contained `text` at some point. */
export const ptyWaitFor = (ctx: TestContext, text: string, opts: { timeout: number }) =>
  waitFor(
    Effect.sync(() => Bun.stripANSI(ctx.output)),
    (output) => output.includes(text),
    opts.timeout,
    `PTY output "${text}"`,
  ).pipe(Effect.asVoid)

/**
 * Wait until the screen as drawn now satisfies `predicate`. The output keeps
 * every frame ever drawn, so text that left the screen is still in it; the
 * parsed grid shows only what a reader sees.
 */
export const screenWaitFor = (
  ctx: TestContext,
  predicate: (visible: ReadonlyArray<string>) => boolean,
  opts: { timeout: number; label: string },
) =>
  waitFor(
    Effect.suspend(() => parseTerminal(ctx.output, ctx.size)),
    (grid) => predicate(grid.visible),
    opts.timeout,
    `screen: ${opts.label}`,
  ).pipe(Effect.asVoid)

// ── Settle-then-capture ──

class PtySettleError extends Schema.TaggedError<PtySettleError>()("@gent/e2e/PtySettleError", {
  message: Schema.String,
}) {}

interface SettleOptions {
  /** How long the child must write nothing before the output counts as settled. */
  readonly quietMs?: number
  /** How long to wait for that quiet window before failing. */
  readonly timeoutMs?: number
}

const SETTLE_POLL_MS = 50

/**
 * Wait until the child has written nothing new for `quietMs`.
 *
 * A terminal repaints in bursts: one frame is many writes, and the rows a
 * commit hands to scrollback land in the same burst as the footer repaint that
 * follows it. Reading the grid mid-burst reads a half-drawn screen, so every
 * capture waits for the output to stop first. This is the one real asynchronous
 * boundary in these tests — no state signal says "the terminal is done", only
 * the absence of further output — so the wait is bounded and it fails loudly
 * when the quiet window never opens.
 */
export const settlePty = (
  ctx: Pick<TestContext, "output">,
  options: SettleOptions = {},
): Effect.Effect<void, PtySettleError> =>
  Effect.gen(function* () {
    const quietMs = options.quietMs ?? 500
    const timeoutMs = options.timeoutMs ?? 15_000
    const quietPolls = Math.max(1, Math.ceil(quietMs / SETTLE_POLL_MS))
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs

    const loop = (lastSeen: number, stablePolls: number): Effect.Effect<void, PtySettleError> =>
      Effect.gen(function* () {
        const seen = ctx.output.length
        let stable = 0
        if (seen === lastSeen) stable = stablePolls + 1
        if (stable >= quietPolls) return
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* new PtySettleError({
            message:
              `pty never went quiet for ${quietMs}ms within ${timeoutMs}ms ` +
              `(${seen} characters captured)`,
          })
        }
        // oxlint-disable-next-line effect/noFixedWaitInTests -- the poll interval of the quiet-window wait; only the absence of output marks the end of a repaint
        yield* Effect.sleep(`${SETTLE_POLL_MS} millis`)
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
interface TerminalGrid {
  readonly history: ReadonlyArray<string>
  readonly visible: ReadonlyArray<string>
  readonly cols: number
  readonly rows: number
}

/** Every row, history first, with blank rows dropped. */
export const gridText = (grid: TerminalGrid): ReadonlyArray<string> =>
  [...grid.history, ...grid.visible]
    .values()
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0)
    .toArray()

/** History rows only, blank rows dropped. */
export const historyText = (grid: TerminalGrid): ReadonlyArray<string> =>
  grid.history.map((row) => row.trimEnd()).filter((row) => row.length > 0)

/** How many rows contain `needle`. */
export const countRows = (rows: ReadonlyArray<string>, needle: string): number =>
  rows.filter((row) => row.includes(needle)).length

const newEmulator = (size: PtySize) =>
  new Terminal({ cols: size.cols, rows: size.rows, scrollback: 100_000, allowProposedApi: true })

/** Wait until `emulator` has processed every write so far. */
const drained = (emulator: Terminal, bytes = ""): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    emulator.write(bytes, () => resume(Effect.void))
  })

/**
 * Rows `from` (inclusive) to `to` (exclusive) of the active buffer, each cut
 * at the terminal's width: after a shrink a line of the alternate screen keeps
 * the cells drawn past the new last column, and a terminal does not show them.
 */
const readRows = (emulator: Terminal, from: number, to: number): string[] => {
  const buffer = emulator.buffer.active
  const rows: string[] = []
  for (let y = from; y < to; y++) {
    rows.push(
      Option.match(Option.fromNullishOr(buffer.getLine(y)), {
        onNone: () => "",
        onSome: (line) => line.translateToString(false, 0, emulator.cols),
      }),
    )
  }
  return rows
}

/**
 * Replay raw pty bytes through a headless VT emulator and read the grid back.
 *
 * `@xterm/headless` is the engine VS Code's terminal runs on, so it models the
 * one mechanism these tests are about: a scroll region (`ESC[1;<n>r`) with a
 * line feed at its bottom row pushes the top row into scrollback. `baseY` is
 * where that scrollback ends and the screen begins.
 */
const parseTerminal = (bytes: string, size: PtySize): Effect.Effect<TerminalGrid> =>
  Effect.acquireUseRelease(
    Effect.sync(() => newEmulator(size)),
    (emulator) =>
      drained(emulator, bytes).pipe(
        Effect.map(() => {
          const buffer = emulator.buffer.active
          return {
            history: readRows(emulator, 0, buffer.baseY),
            visible: readRows(emulator, buffer.baseY, buffer.length),
            cols: size.cols,
            rows: size.rows,
          }
        }),
      ),
    (emulator) => ignoreSyncDefect(() => emulator.dispose()),
  )

/**
 * Settle, then replay everything captured by then into a grid. The output is
 * read after the quiet window, not when the capture is built.
 */
export const settleAndCapture = (
  ctx: Pick<TestContext, "output" | "size">,
  options: SettleOptions = {},
): Effect.Effect<TerminalGrid, PtySettleError> =>
  settlePty(ctx, options).pipe(
    Effect.andThen(Effect.suspend(() => parseTerminal(ctx.output, ctx.size))),
  )

// ── Live screen ──

/** A session whose output also feeds a live emulator that follows each resize, as a terminal window does. */
interface LivePtyContext extends TestContext {
  readonly screen: Terminal
}

/**
 * Start `command` on a pty with a live emulator on the other side. Unlike the
 * replay above, which reads all output at the current size, the emulator saw
 * each byte at the size it was written for, so history across a resize reads
 * as a real terminal's would. It also answers the child's terminal queries
 * (device attributes, cursor position).
 */
const openLivePty = (spec: PtyCommand): Effect.Effect<LivePtyContext, never, Scope.Scope> =>
  Effect.gen(function* () {
    const screen = yield* Effect.acquireRelease(
      Effect.sync(() => newEmulator(spec.size)),
      (emulator) => ignoreSyncDefect(() => emulator.dispose()),
    )
    const context = yield* openPty(spec, (text) => screen.write(text))
    yield* Effect.acquireRelease(
      Effect.sync(() => screen.onData((reply) => context.pty.write(reply))),
      (subscription) => ignoreSyncDefect(() => subscription.dispose()),
    )
    const session: LivePtyContext = {
      pty: context.pty,
      get output() {
        return context.output
      },
      get size() {
        return context.size
      },
      resize: (next) => {
        screen.resize(next.cols, next.rows)
        context.resize(next)
      },
      screen,
    }
    return session
  })

/** Which rows a capture reads: the screen as drawn now, or all of it with the scrollback above. */
const captureRanges = {
  viewport: (screen: Terminal) => [
    screen.buffer.active.viewportY,
    screen.buffer.active.viewportY + screen.rows,
  ],
  all: (screen: Terminal) => [0, screen.buffer.active.length],
} satisfies Record<string, (screen: Terminal) => readonly [number, number]>

/** The rows of `scope`, trailing blanks trimmed. */
const screenRows = (session: LivePtyContext, scope: keyof typeof captureRanges): string[] => {
  const [from, to] = captureRanges[scope](session.screen)
  return readRows(session.screen, from, to).map((row) => row.trimEnd())
}

/** The cursor and the first 16 cells of its row: `x:[characters]/width` for each. */
const cursorCells = (session: LivePtyContext): string => {
  const buffer = session.screen.buffer.active
  const line = Option.fromNullishOr(buffer.getLine(buffer.viewportY + buffer.cursorY))
  const cells = Array.from({ length: 16 }, (_, x) =>
    Option.match(
      Option.flatMap(line, (row) => Option.fromNullishOr(row.getCell(x))),
      {
        onNone: () => `${x}:-`,
        onSome: (cell) => `${x}:[${cell.getChars()}]/${cell.getWidth()}`,
      },
    ),
  )
  return `cursor=${buffer.cursorX},${buffer.cursorY} ${cells.join(" ")}`
}

// ── Drive scripts ──

/**
 * One step of a drive script. `send` writes text, `keys` writes a named key
 * from `keys` (or the text itself), `wait` sleeps, `waitFor` polls the screen
 * for a regex (default 15 s, logs a miss and goes on), `settle` waits for a
 * quiet window, `resize` resizes, `cap` / `capAll` save the screen (with
 * scrollback), `cells` saves the cursor row's cells, `raw` saves the raw
 * output, and `sh` runs a shell command.
 */
const DriveStep = Schema.Union([
  Schema.Tuple([Schema.Literal("send"), Schema.String]),
  Schema.Tuple([Schema.Literal("keys"), Schema.String]),
  Schema.Tuple([Schema.Literal("wait"), Schema.Finite]),
  Schema.Tuple([Schema.Literal("waitFor"), Schema.String, Schema.optionalKey(Schema.Finite)]),
  Schema.Tuple([Schema.Literal("settle"), Schema.optionalKey(Schema.Finite)]),
  Schema.Tuple([Schema.Literal("resize"), Schema.Int, Schema.Int]),
  Schema.Tuple([Schema.Literals(["cap", "capAll", "cells", "raw"]), Schema.String]),
  Schema.Tuple([Schema.Literal("sh"), Schema.String]),
])
type DriveStep = typeof DriveStep.Type

/**
 * A live check as data: the program to run, the pty size, where captures go,
 * and the steps. `env` is laid over a minimal terminal environment (`PATH`,
 * `COLORTERM`, `LANG`; zigpty adds `TERM`), shared by the pty and `sh` steps,
 * never over the caller's, so no credential reaches either unless the script names it. `cwd` and `out` resolve
 * against the script's directory.
 */
export const DriveScript = Schema.Struct({
  command: Schema.NonEmptyArray(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cols: Schema.Int,
  rows: Schema.Int,
  out: Schema.String,
  steps: Schema.Array(DriveStep),
})
type DriveScript = typeof DriveScript.Type

const WAIT_FOR_DEFAULT_MS = 15_000

/**
 * Run `script` on a live pty, print each capture and save it under
 * `script.out`. Returns the exit code, `None` when the program outlived the
 * cleanup (ctrl+c, then SIGKILL).
 */
export const runDriveScript = (
  script: DriveScript & { readonly cwd: string },
): Effect.Effect<Option.Option<number>, PtySettleError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(script.out, { recursive: true }).pipe(Effect.orDie)
    const started = yield* Clock.currentTimeMillis
    const elapsed = Clock.currentTimeMillis.pipe(Effect.map((now) => now - started))
    const env = {
      // oxlint-disable-next-line effect/noGlobals -- drive processes use only the caller's PATH and declared env
      PATH: Bun.env["PATH"] ?? "/usr/bin:/bin",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
      ...script.env,
    }

    // The scope ends with the cleanup, which has waited for the exit already;
    // the code is read after it.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openLivePty({
          command: script.command[0],
          args: script.command.slice(1),
          cwd: script.cwd,
          env,
          size: { cols: script.cols, rows: script.rows },
        })
        const save = (name: string, extension: string, text: string) =>
          fs.writeFileString(path.join(script.out, `${name}.${extension}`), text).pipe(Effect.orDie)
        const capture = (name: string, scope: "viewport" | "all") =>
          Effect.gen(function* () {
            yield* drained(session.screen)
            const { screen } = session
            const buffer = screen.buffer.active
            const header =
              `# ${name} ${screen.cols}x${screen.rows} buffer=${buffer.type} ` +
              `cursor=${buffer.cursorX},${buffer.cursorY} t=${yield* elapsed}ms`
            const numbered = screenRows(session, scope).map(
              (row, index) => `${String(index + 1).padStart(3, "0")}|${row}`,
            )
            const text = `${header}\n${numbered.join("\n")}\n`
            yield* Console.log(text)
            yield* save(name, "txt", text)
          })
        const visibleScreen = drained(session.screen).pipe(
          Effect.map(() => screenRows(session, "viewport").join("\n")),
        )

        const runStep = (step: DriveStep): Effect.Effect<void, PtySettleError> => {
          switch (step[0]) {
            case "send":
              return Effect.sync(() => session.pty.write(step[1]))
            case "keys": {
              const name = step[1]
              const bytes = Arr.findFirst(Object.entries(keys), ([key]) => key === name)
              return Effect.sync(() =>
                session.pty.write(
                  Option.match(bytes, { onNone: () => name, onSome: ([, value]) => value }),
                ),
              )
            }
            case "wait":
              return Effect.sleep(`${step[1]} millis`)
            case "waitFor": {
              const pattern = new RegExp(step[1])
              return waitFor(
                visibleScreen,
                (text) => pattern.test(text),
                step[2] ?? WAIT_FOR_DEFAULT_MS,
                step[1],
              ).pipe(
                Effect.as("hit"),
                Effect.orElseSucceed(() => "TIMEOUT"),
                Effect.flatMap((result) =>
                  Effect.flatMap(elapsed, (ms) =>
                    Console.log(`waitFor ${step[1]}: ${result} ${ms}ms`),
                  ),
                ),
              )
            }
            case "settle":
              return settlePty(session, { quietMs: step[1] ?? 500 })
            case "resize":
              return Effect.sync(() => session.resize({ cols: step[1], rows: step[2] }))
            case "cap":
              return capture(step[1], "viewport")
            case "capAll":
              return capture(step[1], "all")
            case "cells":
              return drained(session.screen).pipe(
                Effect.map(() => `# ${step[1]} ${cursorCells(session)}`),
                Effect.tap((text) => Console.log(text)),
                Effect.flatMap((text) => save(step[1], "txt", `${text}\n`)),
              )
            case "raw":
              return Effect.suspend(() => save(step[1], "raw", session.output))
            case "sh":
              return Effect.acquireUseRelease(
                Effect.sync(() =>
                  // oxlint-disable-next-line effect/noGlobals -- a drive script's setup command runs as a plain shell process
                  Bun.spawn(["/bin/sh", "-c", step[1]], {
                    cwd: script.cwd,
                    env,
                    stdio: ["ignore", "ignore", "inherit"],
                  }),
                ),
                (shell) =>
                  exitWithin(shell.exited, "30 seconds").pipe(
                    Effect.flatMap((code) =>
                      Console.log(
                        `sh: ${step[1]} -> exit ${Option.getOrElse(code, () => "timeout")}`,
                      ),
                    ),
                  ),
                (shell) => ignoreSyncDefect(() => shell.kill("SIGKILL")),
              )
          }
        }

        for (const step of script.steps) yield* runStep(step)
        return session
      }),
    ).pipe(Effect.flatMap((ended) => exitWithin(ended.pty.exited, "100 millis")))
  })
