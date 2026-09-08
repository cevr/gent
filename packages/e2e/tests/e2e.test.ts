/**
 * PTY-based E2E tests for TUI.
 * Uses zigpty for pseudo-terminal emulation with waitFor pattern.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import {
  ptyWaitFor,
  readClientLog,
  resetClientLog,
  seedAndSpawn,
  seedSkillAndSpawn,
  shortPause,
  spawnNoAuth,
  stripAnsi,
  type TestContext,
} from "../src/pty-fixture"

const TEST_TIMEOUT = 30_000

const ENTER = "\r"
const ESC = "\x1b"
const CTRL_C = "\x03"
const UP = "\x1b[A"
const ESC_KEY_DECODE_MS = 650

const raceWithTimeout = <A>(
  promise: PromiseLike<A>,
  timeoutMs: number,
): Effect.Effect<Option.Option<A>> =>
  Effect.race(
    Effect.promise(() => promise).pipe(Effect.asSome),
    // gent/no-sleep: allow real-clock timeout race for foreign Promise resolution
    Effect.sleep(`${timeoutMs} millis`).pipe(Effect.as(Option.none<A>())),
  )

const acquireTestContext = <R>(acquire: Effect.Effect<TestContext, never, R>) =>
  Effect.acquireRelease(acquire, (ctx) => ctx.cleanup.pipe(Effect.andThen(shortPause(100))))

const waitForOutput = (ctx: TestContext, text: string, timeoutMs: number) =>
  waitFor(
    Effect.sync(() => stripAnsi(ctx.output)),
    (output) => output.includes(text),
    timeoutMs,
    `output "${text}"`,
  )

describe("E2E: Basics", () => {
  it.scopedLive(
    "starts and shows home view with prompt",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* waitForOutput(ctx, "┃", 10_000)
        expect(stripAnsi(ctx.output)).toContain("┃")
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "typing text appears in output",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        const before = ctx.output.length
        ctx.pty.write("hello world")
        yield* shortPause(1_000)
        expect(ctx.output.length).toBeGreaterThan(before)
        expect(stripAnsi(ctx.output)).toContain("hello")
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "double ESC exits with code 0",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write(ESC)
        yield* shortPause(ESC_KEY_DECODE_MS)
        ctx.pty.write(ESC)
        const code = yield* raceWithTimeout(ctx.pty.exited, 10_000)
        expect(code).toEqual(Option.some(0))
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Auth", () => {
  it.scopedLive(
    "missing auth opens auth panel and method picker",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(spawnNoAuth)
        yield* ptyWaitFor(ctx, "API Keys", { timeout: 10_000 })
        yield* ptyWaitFor(ctx, "ChatGPT Pro/Plus", { timeout: 10_000 })
        yield* waitForOutput(ctx, "Manually enter API key", 10_000)
        expect(ctx.output).toContain("API Keys")
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "auth panel: arrows select manual key entry",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(spawnNoAuth)
        yield* ptyWaitFor(ctx, "API Keys", { timeout: 10_000 })
        yield* ptyWaitFor(ctx, "Manually enter API key", { timeout: 10_000 })
        ctx.pty.write(UP)
        yield* shortPause(200)
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "(type key)", { timeout: 5_000 })
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Slash Commands", () => {
  it.scopedLive(
    "/ prefix shows autocomplete popup with commands",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("/")
        yield* ptyWaitFor(ctx, "Commands", { timeout: 5_000 })
        yield* waitForOutput(ctx, "/new", 5_000)
        ctx.pty.write(ESC)
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Shell Mode", () => {
  it.scopedLive(
    "! enters shell, runs echo, ESC exits",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("!")
        yield* ptyWaitFor(ctx, "$", { timeout: 5_000 })
        ctx.pty.write("echo zigpty-e2e")
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "zigpty-e2e", { timeout: 5_000 })
        ctx.pty.write(ESC)
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "shell mode: sequential commands",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("!")
        yield* ptyWaitFor(ctx, "$", { timeout: 5_000 })
        ctx.pty.write("echo first-cmd")
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "first-cmd", { timeout: 5_000 })
        yield* shortPause(500)
        ctx.pty.write("echo second-cmd")
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "second-cmd", { timeout: 5_000 })
        ctx.pty.write(ESC)
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Session", () => {
  it.scopedLive(
    "submitting message triggers session creation",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("hi")
        yield* shortPause(300)
        ctx.pty.write(ENTER)
        yield* shortPause(3_000)
        expect(ctx.output.length).toBeGreaterThan(2000)
        ctx.pty.write(CTRL_C)
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "double ESC after session activity exits without watchdog fallback",
    () =>
      Effect.gen(function* () {
        yield* resetClientLog
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("hi")
        yield* shortPause(300)
        ctx.pty.write(ENTER)
        yield* shortPause(3_000)
        ctx.pty.write(ESC)
        yield* shortPause(ESC_KEY_DECODE_MS)
        ctx.pty.write(ESC)
        const code = yield* raceWithTimeout(ctx.pty.exited, 8_000)
        const log = yield* readClientLog
        expect(code).toEqual(Option.some(0))
        expect(log).not.toContain("shutdown.watchdog-fired")
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Headless", () => {
  it.scopedLive(
    "-H flag produces output",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn(["-H", "say hello"]))
        yield* raceWithTimeout(ctx.pty.exited, 8_000)
        expect(ctx.output.length).toBeGreaterThan(0)
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Prompt History", () => {
  it.scopedLive(
    "up arrow at empty prompt does not crash",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write(UP)
        yield* shortPause(500)
        expect(stripAnsi(ctx.output)).toContain("┃")
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "up arrow at non-empty input does not navigate",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedAndSpawn())
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("some text")
        yield* shortPause(500)
        ctx.pty.write(UP)
        yield* shortPause(300)
        expect(stripAnsi(ctx.output)).toContain("some")
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Skill Popup", () => {
  it.scopedLive(
    "$ trigger shows skills popup",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedSkillAndSpawn)
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        yield* shortPause(2_000)
        ctx.pty.write("$t")
        yield* ptyWaitFor(ctx, "Skills", { timeout: 5_000 })
        const clean = stripAnsi(ctx.output)
        expect(clean).toContain("Skills")
        ctx.pty.write(ESC)
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "ESC closes skill popup",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(seedSkillAndSpawn)
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        yield* shortPause(2_000)
        ctx.pty.write("$t")
        yield* ptyWaitFor(ctx, "Skills", { timeout: 5_000 })
        ctx.pty.write(ESC)
        yield* shortPause(500)
        expect(stripAnsi(ctx.output)).toContain("┃")
      }),
    TEST_TIMEOUT,
  )
})
