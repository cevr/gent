/**
 * PTY-based E2E tests for TUI.
 * Uses zigpty for pseudo-terminal emulation with waitFor pattern.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { waitFor } from "@gent/core/test-utils"
import {
  ptyWaitFor,
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
        yield* ptyWaitFor(ctx, "Sign in", { timeout: 10_000 })
        // The boot gate opens on the first *required* provider, and the
        // default agent's model is a Claude one, so the picker it opens is
        // anthropic's. This waited for "ChatGPT Pro/Plus", a label only
        // openai offers, which this flow therefore never shows.
        yield* ptyWaitFor(ctx, "Claude Code", { timeout: 10_000 })
        yield* waitForOutput(ctx, "Manually enter API key", 10_000)
        expect(ctx.output).toContain("· method")
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "auth panel: arrows select manual key entry",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquireTestContext(spawnNoAuth)
        yield* ptyWaitFor(ctx, "Sign in", { timeout: 10_000 })
        yield* ptyWaitFor(ctx, "Manually enter API key", { timeout: 10_000 })
        ctx.pty.write(UP)
        yield* shortPause(200)
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "API key ›", { timeout: 5_000 })
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
    "submitting message opens a session and starts the turn",
    () =>
      Effect.gen(function* () {
        // `--mock-empty` keeps the turn offline: memory state, no seeded
        // session, a model that answers nothing. The home footer reads
        // "ready"; only the session route renders the "Generating" label.
        const ctx = yield* acquireTestContext(seedAndSpawn(["--mock-empty"]))
        yield* ptyWaitFor(ctx, "ready", { timeout: 10_000 })
        ctx.pty.write("hi")
        yield* shortPause(300)
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "Generating", { timeout: 10_000 })
        ctx.pty.write(CTRL_C)
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
