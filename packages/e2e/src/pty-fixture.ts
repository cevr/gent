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
  Data,
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Result,
  Schema,
  type Scope,
} from "effect"
import { constVoid } from "effect/Function"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
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

/**
 * The key of the raw stream. It stays in this module: a test reads what the
 * terminal draws (`ptyWaitFor`, `screenWaitFor`, `settleAndCapture`), never
 * the bytes, which a cell-diff renderer splits wherever a cell already holds
 * the character it needs.
 */
const RAW = Symbol("raw pty output")

/** What the waits read: the size, and the raw stream under this module's key. */
export interface PtyStream {
  readonly size: PtySize
  /** Everything the child has written so far. It grows whenever the terminal repaints. */
  readonly [RAW]: () => string
}

export interface TestContext extends PtyStream {
  readonly pty: IPty
  /** How many characters the child has written so far: a mark to wait past, not text to assert on. */
  readonly written: () => number
  readonly resize: (size: PtySize) => void
}

/** A stream a test feeds by hand (`read` returns all of it so far), for a test of the waits themselves. */
export const fedStream = (read: () => string, size: PtySize): PtyStream => ({
  size,
  [RAW]: read,
})

const encodeRaw = Schema.encodeSync(Schema.fromJsonString(Schema.String))

/** The raw stream, JSON-escaped, for a failure message only: the assertion reads the screen. */
export const rawForFailure = (stream: PtyStream): string => encodeRaw(stream[RAW]())

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
 * SIGKILL to the pty's process group: zigpty starts the child as a session
 * leader, so the group is everything it started and did not move out.
 */
const killGroup = (pid: number) =>
  ignoreSyncDefect(() => process.kill(-pid, "SIGKILL")).pipe(
    Effect.andThen(ignoreSyncDefect(() => process.kill(pid, "SIGKILL"))),
  )

/**
 * Start `command` in a pty that belongs to the caller's scope. Closing the
 * scope sends ctrl+c, waits for the exit, kills a child that outlives the
 * wait, and then kills what is left of its process group. `onText` sees
 * each chunk the child writes.
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
        [RAW]: () => output,
        written: () => output.length,
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
          yield* killGroup(pty.pid)
          yield* exitWithin(pty.exited, "2 seconds")
        }
        // A descendant the child left in its group goes with it.
        yield* ignoreSyncDefect(() => process.kill(-pty.pid, "SIGKILL"))
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

/**
 * Wait until `text` has been drawn: the output, colors stripped, contained it
 * at some point, or the terminal holds it now, scrollback included.
 *
 * The stream alone misses text the TUI draws over the frame before it. A
 * cell-diff renderer writes only the cells that change, so a turn line drawn
 * over the live line reaches the pty as `2`, a cursor move and `retries`: the
 * space between them was a space already. A terminal fed the same bytes reads
 * `2 retries`. The stream check still sees text that was on screen only
 * between two polls.
 */
export const ptyWaitFor = (ctx: PtyStream, text: string, opts: { timeout: number }) =>
  Effect.acquireUseRelease(
    Effect.sync(() => ({ emulator: newEmulator(ctx.size), fed: 0 })),
    (terminal) =>
      waitFor(
        Effect.suspend(() => {
          const output = ctx[RAW]()
          if (Bun.stripANSI(output).includes(text)) return Effect.succeed(true)
          const fresh = output.slice(terminal.fed)
          terminal.fed = output.length
          return drained(terminal.emulator, fresh).pipe(
            Effect.map(() =>
              readRows(terminal.emulator, 0, terminal.emulator.buffer.active.length).some((row) =>
                row.includes(text),
              ),
            ),
          )
        }),
        (drawn) => drawn,
        opts.timeout,
        `PTY output "${text}"`,
      ),
    (terminal) => ignoreSyncDefect(() => terminal.emulator.dispose()),
  ).pipe(Effect.asVoid)

/**
 * Wait until the screen as drawn now satisfies `predicate`. The output keeps
 * every frame ever drawn, so text that left the screen is still in it; the
 * parsed grid shows only what a reader sees.
 */
export const screenWaitFor = (
  ctx: PtyStream,
  predicate: (visible: ReadonlyArray<string>) => boolean,
  opts: { timeout: number; label: string },
) =>
  waitFor(
    Effect.suspend(() => parseTerminal(ctx[RAW](), ctx.size)),
    (grid) => predicate(grid.visible),
    opts.timeout,
    `screen: ${opts.label}`,
  ).pipe(Effect.asVoid)

// ── Settle-then-capture ──

class PtySettleError extends Schema.TaggedError<
  PtySettleError,
  { readonly brand: unique symbol }
>()("@gent/e2e/PtySettleError", {
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
  ctx: PtyStream,
  options: SettleOptions = {},
): Effect.Effect<void, PtySettleError> =>
  Effect.gen(function* () {
    const quietMs = options.quietMs ?? 500
    const timeoutMs = options.timeoutMs ?? 15_000
    const quietPolls = Math.max(1, Math.ceil(quietMs / SETTLE_POLL_MS))
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs

    const loop = (lastSeen: number, stablePolls: number): Effect.Effect<void, PtySettleError> =>
      Effect.gen(function* () {
        const seen = ctx[RAW]().length
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
  ctx: PtyStream,
  options: SettleOptions = {},
): Effect.Effect<TerminalGrid, PtySettleError> =>
  settlePty(ctx, options).pipe(
    Effect.andThen(Effect.suspend(() => parseTerminal(ctx[RAW](), ctx.size))),
  )

/**
 * Settle, then replay everything captured by then and `following` after it:
 * what a program writes at the cursor once the child has exited, as the
 * shell's prompt does.
 */
export const settleAndCaptureFollowedBy = (
  ctx: PtyStream,
  following: string,
  options: SettleOptions = {},
): Effect.Effect<TerminalGrid, PtySettleError> =>
  settlePty(ctx, options).pipe(
    Effect.andThen(Effect.suspend(() => parseTerminal(ctx[RAW]() + following, ctx.size))),
  )

// ── Live screen ──

/** A session whose output also feeds a live emulator that follows each resize, as a terminal window does. */
interface LivePtyContext extends TestContext {
  readonly screen: Terminal
}

/**
 * The colours the live emulator reports: a dark terminal's, Tomorrow Night's
 * ground and text over xterm.js's Tango palette. `@xterm/headless` parses a
 * colour query and answers none, so without these the TUI would draw as on a
 * terminal that keeps its colours to itself: no surface reads the ground.
 */
const LIVE_PALETTE = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec",
] as const

/** The ground a live terminal reports: Tomorrow Night's (dark) or Tomorrow's (light). */
const LiveGround = Schema.Literals(["dark", "light"])
type LiveGround = typeof LiveGround.Type

/**
 * OSC 10 to 19 (foreground, background, cursor, mouse, Tek, highlight) and
 * the colour each reports, for each ground: Tomorrow Night's, or Tomorrow's
 * white ground and text, which a light-mode check reads.
 */
const LIVE_SPECIAL_COLORS: Readonly<Record<LiveGround, ReadonlyArray<readonly [number, string]>>> =
  {
    dark: [
      [10, "#c5c8c6"],
      [11, "#1d1f21"],
      [12, "#c5c8c6"],
      [13, "#c5c8c6"],
      [14, "#1d1f21"],
      [15, "#c5c8c6"],
      [16, "#1d1f21"],
      [17, "#373b41"],
      [19, "#c5c8c6"],
    ],
    light: [
      [10, "#4d4d4c"],
      [11, "#ffffff"],
      [12, "#4d4d4c"],
      [13, "#4d4d4c"],
      [14, "#ffffff"],
      [15, "#4d4d4c"],
      [16, "#ffffff"],
      [17, "#d6d6d6"],
      [19, "#4d4d4c"],
    ],
  }

/** `#1d1f21` as an xterm colour reply spells it: `rgb:1d1d/1f1f/2121`. */
const xtermColor = (hex: string): string => {
  const channel = (at: number) => hex.slice(at, at + 2).repeat(2)
  return `rgb:${channel(1)}/${channel(3)}/${channel(5)}`
}

/**
 * Answer the child's colour queries as a terminal does: `OSC 4;<i>;?` with
 * the palette entry, `OSC <n>;?` with the special colour. A set (not a
 * query) is left to the emulator.
 */
const answerColorQueries = (
  screen: Terminal,
  ground: LiveGround,
  reply: (text: string) => void,
): ReadonlyArray<{ readonly dispose: () => void }> => [
  screen.parser.registerOscHandler(4, (data) => {
    const fields = data.split(";")
    const answers: string[] = []
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const index = Number(fields[at])
      const hex = Option.fromUndefinedOr(LIVE_PALETTE[index])
      if (fields[at + 1] !== "?" || Option.isNone(hex)) return false
      answers.push(`\x1b]4;${index};${xtermColor(hex.value)}\x1b\\`)
    }
    reply(answers.join(""))
    return true
  }),
  ...LIVE_SPECIAL_COLORS[ground].map(([ident, hex]) =>
    screen.parser.registerOscHandler(ident, (data) => {
      if (data !== "?") return false
      reply(`\x1b]${ident};${xtermColor(hex)}\x1b\\`)
      return true
    }),
  ),
]

/**
 * Start `command` on a pty with a live emulator on the other side. Unlike the
 * replay above, which reads all output at the current size, the emulator saw
 * each byte at the size it was written for, so history across a resize reads
 * as a real terminal's would. It also answers the child's terminal queries
 * (device attributes, cursor position) and, as a real terminal does, its
 * colour queries, from `LIVE_PALETTE` and the ground's special colours.
 */
const openLivePty = (
  spec: PtyCommand,
  ground: LiveGround,
  onText: (text: string) => void = constVoid,
): Effect.Effect<LivePtyContext, never, Scope.Scope> =>
  Effect.gen(function* () {
    const screen = yield* Effect.acquireRelease(
      Effect.sync(() => newEmulator(spec.size)),
      (emulator) => ignoreSyncDefect(() => emulator.dispose()),
    )
    const context = yield* openPty(spec, (text) => {
      screen.write(text)
      onText(text)
    })
    yield* Effect.acquireRelease(
      Effect.sync(() => screen.onData((reply) => context.pty.write(reply))),
      (subscription) => ignoreSyncDefect(() => subscription.dispose()),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => answerColorQueries(screen, ground, (reply) => context.pty.write(reply))),
      (handlers) => ignoreSyncDefect(() => handlers.forEach((handler) => handler.dispose())),
    )
    const session: LivePtyContext = {
      pty: context.pty,
      [RAW]: context[RAW],
      written: context.written,
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

/** A regular expression's source, refused when the script is decoded if it does not compile. */
const PatternSource = Schema.String.check(
  Schema.makeFilter(
    (source: string) =>
      Result.isSuccess(Result.try(() => new RegExp(source))) ||
      `not a regular expression: ${source}`,
  ),
)

/** A capture's file name: one path segment, so every capture lands in `out`. */
const CaptureName = Schema.String.check(
  Schema.isPattern(/^\w[\w.-]*$/, {
    message: "a capture name is one file name: letters, digits, `_`, `.` and `-`",
  }),
)

/**
 * One step of a drive script. `send` writes text, `keys` writes a named key
 * from `keys` (or the text itself), `wait` sleeps, `waitFor` polls the screen
 * for a regex (default 15 s; a timeout is a miss and the drive goes on),
 * `settle` waits for a quiet window, `resize` resizes, `cap` / `capAll` save
 * the screen (with scrollback), `cells` saves the cursor row's cells, `raw`
 * saves the raw output, and `sh` runs a shell command (30 s unless the step
 * names its ms).
 */
const DriveStep = Schema.Union([
  Schema.Tuple([Schema.Literal("send"), Schema.String]),
  Schema.Tuple([Schema.Literal("keys"), Schema.String]),
  Schema.Tuple([Schema.Literal("wait"), Schema.Finite]),
  Schema.Tuple([Schema.Literal("waitFor"), PatternSource, Schema.optionalKey(Schema.Finite)]),
  Schema.Tuple([Schema.Literal("settle"), Schema.optionalKey(Schema.Finite)]),
  Schema.Tuple([Schema.Literal("resize"), Schema.Int, Schema.Int]),
  Schema.Tuple([Schema.Literals(["cap", "capAll", "cells", "raw"]), CaptureName]),
  Schema.Tuple([Schema.Literal("sh"), Schema.String, Schema.optionalKey(Schema.Finite)]),
])
type DriveStep = typeof DriveStep.Type

/**
 * A live check as data: the program to run, the pty size, where captures go,
 * and the steps. `env` is laid over a minimal terminal environment (`PATH`,
 * `COLORTERM`, `LANG`; zigpty adds `TERM`), shared by the pty and `sh` steps,
 * never over the caller's, so no credential reaches either unless the script
 * names it. `cwd` and `out` resolve against the script's directory. `exit` is
 * the code the program must end with when it exits by itself; a program the
 * cleanup stops at the end has no code to check.
 */
export const DriveScript = Schema.Struct({
  command: Schema.NonEmptyArray(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cols: Schema.Int,
  rows: Schema.Int,
  /** The ground the terminal reports to a colour query; dark when the script names none. */
  ground: Schema.optionalKey(LiveGround),
  out: Schema.String,
  exit: Schema.optionalKey(Schema.Int),
  steps: Schema.Array(DriveStep),
})
type DriveScript = typeof DriveScript.Type

/**
 * What one step came to: `Ok`; `Miss`, a `waitFor` whose pattern never
 * showed; `Fail`, an `sh` step that exited non-zero or outlived its limit.
 * `at` is the step's index, `ms` the time since the program started, and
 * `file` what a capture step saved.
 */
export const StepOutcome = Schema.TaggedUnion({
  Ok: {
    at: Schema.Int,
    step: Schema.String,
    ms: Schema.Finite,
    file: Schema.optionalKey(Schema.String),
  },
  Miss: { at: Schema.Int, step: Schema.String, ms: Schema.Finite },
  Fail: { at: Schema.Int, step: Schema.String, ms: Schema.Finite, reason: Schema.String },
})
export type StepOutcome = typeof StepOutcome.Type

/**
 * How the program ended: `Exited` by itself before the steps ran out, with
 * its code; `Stopped` by the cleanup once they had (ctrl+c, then SIGKILL to
 * its process group); `Survived`, alive after the SIGKILL.
 */
export const DriveEnd = Schema.TaggedUnion({
  Exited: { code: Schema.Int },
  Stopped: { code: Schema.Int },
  Survived: {},
})
export type DriveEnd = typeof DriveEnd.Type

/** A drive's outcome: each step's, how the program ended, and the recording it left. */
export interface DriveOutcome {
  readonly steps: ReadonlyArray<StepOutcome>
  readonly end: DriveEnd
  /** The asciicast v2 recording of the whole drive, `None` with `record: false`. */
  readonly recording: Option.Option<string>
}

/** What a drive's caller asks of it beyond the script: a recording, and screens on stderr. */
export interface DriveOptions {
  /** Record the drive as `<out>/drive.cast` (asciicast v2); on by default. */
  readonly record?: boolean
  /** Print each capture's screen on stderr after its step line; off by default. */
  readonly print?: boolean
}

/**
 * What makes a drive fail, one line each: a missed or failed step, a program
 * that exited by itself with another code than `script.exit` (0 when the
 * script names none), or one that survived the cleanup. Empty: it passed.
 */
export const driveProblems = (
  script: DriveScript,
  outcome: DriveOutcome,
): ReadonlyArray<string> => {
  const steps = outcome.steps.flatMap((step) =>
    StepOutcome.match(step, {
      Ok: () => [],
      Miss: (miss) => [`miss ${miss.step}`],
      Fail: (fail) => [`fail ${fail.step}: ${fail.reason}`],
    }),
  )
  const expected = script.exit ?? 0
  const end = DriveEnd.match(outcome.end, {
    Exited: ({ code }) =>
      Option.toArray(
        Option.liftPredicate(
          `the program exited ${code}, the script expects ${expected}`,
          () => code !== expected,
        ),
      ),
    Stopped: ({ code }) =>
      Option.toArray(
        Option.liftPredicate(
          `the program still ran when the steps ended (stopped with ${code}); the script expects it to exit ${expected}`,
          () => Predicate.isNotUndefined(script.exit),
        ),
      ),
    Survived: () => ["the program survived the cleanup's SIGKILL"],
  })
  return [...steps, ...end]
}

/** What a step came to, before it has its index, label and time. */
type StepDone = Data.TaggedEnum<{
  Ok: { readonly file: Option.Option<string>; readonly screen: Option.Option<string> }
  Miss: {}
  Fail: { readonly reason: string }
}>
const StepDone = Data.taggedEnum<StepDone>()
const stepOk = StepDone.Ok({ file: Option.none(), screen: Option.none() })

const WAIT_FOR_DEFAULT_MS = 15_000
const SH_LIMIT_MS = 30_000
const RECORDING = "drive.cast"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** A step as its outcome line names it: the verb, then its argument as JSON text. */
const stepLabel = (step: DriveStep): string => {
  const [verb, ...rest] = step
  return [
    verb,
    ...rest.map((each) =>
      Option.match(Option.liftPredicate(each, Predicate.isString), {
        onNone: () => String(each),
        onSome: (text) => encodeJson(text),
      }),
    ),
  ].join(" ")
}

/** One outcome as the compact line a drive prints on stderr. */
const outcomeLine = (outcome: StepOutcome): string =>
  StepOutcome.match(outcome, {
    Ok: (ok) =>
      [`ok   ${ok.step} ${ok.ms}ms`, ...Option.toArray(Option.fromUndefinedOr(ok.file))].join(" "),
    Miss: (miss) => `miss ${miss.step} ${miss.ms}ms`,
    Fail: (fail) => `fail ${fail.step} ${fail.ms}ms ${fail.reason}`,
  })

/**
 * The asciicast v2 text of a drive: the header with the starting size, then
 * one `[seconds, "o", text]` per chunk the program wrote and one
 * `[seconds, "r", "<cols>x<rows>"]` per resize.
 */
const castText = (
  size: PtySize,
  startedMs: number,
  events: ReadonlyArray<readonly [number, "o" | "r", string]>,
): string => {
  const header = encodeJson({
    version: 2,
    width: size.cols,
    height: size.rows,
    timestamp: Math.floor(startedMs / 1000),
    env: { TERM: "xterm-256color" },
  })
  return [header, ...events.map((event) => encodeJson([...event]))]
    .map((line) => `${line}\n`)
    .join("")
}

const CastHeader = Schema.Struct({
  version: Schema.Literal(2),
  width: Schema.Int,
  height: Schema.Int,
})
const CastEvent = Schema.Tuple([Schema.Finite, Schema.String, Schema.String])
const decodeCastHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(CastHeader))
const decodeCastEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(CastEvent))

class RecordingInvalid extends Schema.TaggedError<
  RecordingInvalid,
  { readonly brand: unique symbol }
>()("@gent/e2e/RecordingInvalid", { file: Schema.String, message: Schema.String }) {}

/** A recording a player can play: its size, its length in seconds, and its event count. */
export interface RecordingCheck {
  readonly width: number
  readonly height: number
  readonly seconds: number
  readonly events: number
}

/**
 * Read an asciicast v2 file as a player does: a version 2 header, then
 * events in time order. Fails `RecordingInvalid` on anything else, on no
 * output, or on a length of zero.
 */
export const checkRecording = Effect.fn("Drive.checkRecording")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const invalid = (message: string) => new RecordingInvalid({ file, message })
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((error) => invalid(error.message)))
  const [first = "", ...lines] = text.trimEnd().split("\n")
  const header = yield* decodeCastHeader(first).pipe(
    Effect.mapError((error) => invalid(`header: ${error.message}`)),
  )
  const events = yield* Effect.forEach(lines, (line, at) =>
    decodeCastEvent(line).pipe(
      Effect.mapError((error) => invalid(`event ${at + 1}: ${error.message}`)),
    ),
  )
  const times = events.map(([seconds]) => seconds)
  if (times.some((seconds, at) => at > 0 && seconds < (times[at - 1] ?? 0))) {
    return yield* invalid("events out of time order")
  }
  if (!events.some(([, kind]) => kind === "o")) return yield* invalid("no output event")
  const seconds = times.at(-1) ?? 0
  if (seconds <= 0) return yield* invalid("a length of zero")
  return {
    width: header.width,
    height: header.height,
    seconds,
    events: events.length,
  } satisfies RecordingCheck
})

/**
 * Run `script` on a live pty and return each step's outcome, how the
 * program ended and its recording. Captures go to files under `script.out`
 * by name; each step prints one line on stderr (`ok|miss|fail <step> <ms>`,
 * and a capture's file), and a capture's screen too with `print`. A miss or
 * a failed step does not stop the drive: the outcome holds it, and
 * `driveProblems` reads it. An `sh` step runs in a process group of its
 * own, stopped with the step, so a command it left in the background ends
 * with it.
 */
export const runDriveScript = Effect.fn("Drive.run")(function* (
  script: DriveScript & { readonly cwd: string },
  options: DriveOptions = {},
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const clock = yield* Clock.Clock
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  yield* fs.makeDirectory(script.out, { recursive: true }).pipe(Effect.orDie)
  const startedMs = clock.currentTimeMillisUnsafe()
  const elapsedMs = () => clock.currentTimeMillisUnsafe() - startedMs
  const env = {
    // oxlint-disable-next-line effect/noGlobals -- drive processes use only the caller's PATH and declared env
    PATH: Bun.env["PATH"] ?? "/usr/bin:/bin",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    ...script.env,
  }
  const size = { cols: script.cols, rows: script.rows }
  const record = options.record ?? true
  const cast: Array<readonly [number, "o" | "r", string]> = []
  const castEvent = (kind: "o" | "r", text: string) => {
    if (record) cast.push([elapsedMs() / 1000, kind, text])
  }
  const castFile = path.join(script.out, RECORDING)
  const recording = Option.liftPredicate(castFile, () => record)
  // The recording is written when the drive ends, an interrupted one included.
  const saveRecording = Effect.suspend(() =>
    Option.match(recording, {
      onNone: () => Effect.void,
      onSome: (file) => fs.writeFileString(file, castText(size, startedMs, cast)),
    }),
  ).pipe(Effect.ignore)
  const outcomes: Array<StepOutcome> = []

  const end = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* openLivePty(
        { command: script.command[0], args: script.command.slice(1), cwd: script.cwd, env, size },
        script.ground ?? "dark",
        (text) => castEvent("o", text),
      )
      const save = (name: string, extension: string, text: string) => {
        const file = path.join(script.out, `${name}.${extension}`)
        return fs.writeFileString(file, text).pipe(Effect.orDie, Effect.as(file))
      }
      const printed = (text: string) =>
        Effect.suspend(() => {
          if (options.print === true) return Console.error(text)
          return Effect.void
        })
      const capture = (name: string, scope: "viewport" | "all") =>
        Effect.gen(function* () {
          yield* drained(session.screen)
          const { screen } = session
          const buffer = screen.buffer.active
          const header =
            `# ${name} ${screen.cols}x${screen.rows} buffer=${buffer.type} ` +
            `cursor=${buffer.cursorX},${buffer.cursorY} t=${elapsedMs()}ms`
          const numbered = screenRows(session, scope).map(
            (row, index) => `${String(index + 1).padStart(3, "0")}|${row}`,
          )
          const text = `${header}\n${numbered.join("\n")}\n`
          const file = yield* save(name, "txt", text)
          return { file, text }
        })
      const visibleScreen = drained(session.screen).pipe(
        Effect.map(() => screenRows(session, "viewport").join("\n")),
      )
      const shell = (command: string, limitMs: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("/bin/sh", ["-c", command], {
                cwd: script.cwd,
                env,
                extendEnv: false,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "inherit",
                // Its own process group: the scope's end stops the group, whatever the shell left.
                detached: true,
                forceKillAfter: "2 seconds",
              }),
            )
            return yield* handle.exitCode.pipe(
              Effect.map((code) => Option.some(Number(code))),
              Effect.timeoutOption(`${limitMs} millis`),
              Effect.map(Option.flatten),
            )
          }),
        ).pipe(
          Effect.map(
            Option.match({
              onNone: () => Option.some(`outlived ${limitMs}ms; its process group was stopped`),
              onSome: (code) => Option.liftPredicate(`exit ${code}`, () => code !== 0),
            }),
          ),
          Effect.catch((error) => Effect.succeedSome(error.message)),
        )

      const saved = (file: string, screen: Option.Option<string>) =>
        StepDone.Ok({ file: Option.some(file), screen })
      const ok = stepOk
      const runStep = (step: DriveStep): Effect.Effect<StepDone, PtySettleError> => {
        switch (step[0]) {
          case "send":
            return Effect.sync(() => session.pty.write(step[1])).pipe(Effect.as(ok))
          case "keys": {
            const name = step[1]
            const bytes = Arr.findFirst(Object.entries(keys), ([key]) => key === name)
            return Effect.sync(() =>
              session.pty.write(
                Option.match(bytes, { onNone: () => name, onSome: ([, value]) => value }),
              ),
            ).pipe(Effect.as(ok))
          }
          case "wait":
            return Effect.sleep(`${step[1]} millis`).pipe(Effect.as(ok))
          case "waitFor": {
            const pattern = new RegExp(step[1])
            return waitFor(
              visibleScreen,
              (text) => pattern.test(text),
              step[2] ?? WAIT_FOR_DEFAULT_MS,
              step[1],
            ).pipe(
              Effect.as(ok),
              Effect.orElseSucceed(() => StepDone.Miss()),
            )
          }
          case "settle":
            return settlePty(session, { quietMs: step[1] ?? 500 }).pipe(Effect.as(ok))
          case "resize":
            return Effect.sync(() => {
              session.resize({ cols: step[1], rows: step[2] })
              castEvent("r", `${step[1]}x${step[2]}`)
            }).pipe(Effect.as(ok))
          case "cap":
            return capture(step[1], "viewport").pipe(
              Effect.map(({ file, text }) => saved(file, Option.some(text))),
            )
          case "capAll":
            return capture(step[1], "all").pipe(
              Effect.map(({ file, text }) => saved(file, Option.some(text))),
            )
          case "cells":
            return drained(session.screen).pipe(
              Effect.map(() => `# ${step[1]} ${cursorCells(session)}`),
              Effect.flatMap((text) =>
                Effect.map(save(step[1], "txt", `${text}\n`), (file) =>
                  saved(file, Option.some(text)),
                ),
              ),
            )
          case "raw":
            return Effect.suspend(() => save(step[1], "raw", session[RAW]())).pipe(
              Effect.map((file) => saved(file, Option.none())),
            )
          case "sh":
            return shell(step[1], step[2] ?? SH_LIMIT_MS).pipe(
              Effect.map(
                Option.match({
                  onNone: () => ok,
                  onSome: (reason) => StepDone.Fail({ reason }),
                }),
              ),
            )
        }
      }

      for (const [at, step] of script.steps.entries()) {
        const done = yield* runStep(step)
        const label = stepLabel(step)
        const ms = elapsedMs()
        const outcome = StepDone.$match(done, {
          Ok: ({ file }) =>
            StepOutcome.cases.Ok.make({
              at,
              step: label,
              ms,
              ...Option.match(file, { onNone: () => ({}), onSome: (each) => ({ file: each }) }),
            }),
          Miss: () => StepOutcome.cases.Miss.make({ at, step: label, ms }),
          Fail: ({ reason }) => StepOutcome.cases.Fail.make({ at, step: label, ms, reason }),
        })
        outcomes.push(outcome)
        yield* Console.error(outcomeLine(outcome))
        if (StepDone.$is("Ok")(done))
          yield* Option.match(done.screen, { onNone: () => Effect.void, onSome: printed })
      }
      // A program that exited during the steps ended by itself; the cleanup stops one still running.
      const early = yield* exitWithin(session.pty.exited, "50 millis")
      return { session, early }
    }),
  ).pipe(
    Effect.flatMap(({ session, early }): Effect.Effect<DriveEnd> =>
      Option.match(early, {
        onSome: (code) => Effect.succeed(DriveEnd.cases.Exited.make({ code })),
        onNone: () =>
          exitWithin(session.pty.exited, "100 millis").pipe(
            Effect.map(
              Option.match({
                onNone: () => DriveEnd.cases.Survived.make({}),
                onSome: (code) => DriveEnd.cases.Stopped.make({ code }),
              }),
            ),
          ),
      }),
    ),
    Effect.ensuring(saveRecording),
  )
  return { steps: outcomes, end, recording } satisfies DriveOutcome
})
