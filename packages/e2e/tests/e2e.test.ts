/**
 * PTY-based E2E tests for TUI.
 * Uses zigpty for pseudo-terminal emulation with waitFor pattern.
 */
import { afterEach } from "bun:test"
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
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
import { raceWithNullTimeout } from "../src/effect-test-adapters"

const TEST_TIMEOUT = 30_000

const ENTER = "\r"
const ESC = "\x1b"
const CTRL_C = "\x03"
const UP = "\x1b[A"
const DOWN = "\x1b[B"

let testContext: TestContext | null = null

const currentContext = (): TestContext => {
  if (testContext === null) throw new Error("test context was not initialized")
  return testContext
}

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (testContext !== null) {
        yield* testContext.cleanup
        testContext = null
        yield* shortPause(100)
      }
    }),
  ),
)

describe("E2E: Basics", () => {
  it.live(
    "starts and shows home view with prompt",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        expect(stripAnsi(ctx.output)).toContain("❯")
      }),
    TEST_TIMEOUT,
  )

  it.live(
    "typing text appears in output",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        const before = ctx.output.length
        ctx.pty.write("hello world")
        yield* shortPause(1_000)
        expect(ctx.output.length).toBeGreaterThan(before)
        expect(stripAnsi(ctx.output)).toContain("hello")
      }),
    TEST_TIMEOUT,
  )

  it.live(
    "double ESC exits with code 0",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        ctx.pty.write(ESC)
        yield* shortPause(200)
        ctx.pty.write(ESC)
        const code = yield* raceWithNullTimeout(ctx.pty.exited, 10_000)
        expect(code).toBe(0)
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Auth", () => {
  it.live(
    "missing auth opens auth panel and method picker",
    () =>
      Effect.gen(function* () {
        testContext = spawnNoAuth()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "API Keys", { timeout: 10_000 })
        yield* ptyWaitFor(ctx.pty, "Claude Code", { timeout: 10_000 })
        yield* ptyWaitFor(ctx.pty, "Manually enter API key", { timeout: 10_000 })
        expect(ctx.output).toContain("API Keys")
      }),
    TEST_TIMEOUT,
  )

  it.live(
    "auth panel: arrows select manual key entry",
    () =>
      Effect.gen(function* () {
        testContext = spawnNoAuth()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "API Keys", { timeout: 10_000 })
        yield* shortPause(750)
        ctx.pty.write(DOWN)
        yield* shortPause(200)
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx.pty, "(type key)", { timeout: 5_000 })
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Slash Commands", () => {
  it.live(
    "/ prefix shows autocomplete popup with commands",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        ctx.pty.write("/")
        yield* ptyWaitFor(ctx.pty, "Commands", { timeout: 5_000 })
        yield* ptyWaitFor(ctx.pty, "/new", { timeout: 5_000 })
        ctx.pty.write(ESC)
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Shell Mode", () => {
  it.live(
    "! enters shell, runs echo, ESC exits",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        ctx.pty.write("!")
        yield* ptyWaitFor(ctx.pty, "$", { timeout: 5_000 })
        ctx.pty.write("echo zigpty-e2e")
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx.pty, "zigpty-e2e", { timeout: 5_000 })
        ctx.pty.write(ESC)
      }),
    TEST_TIMEOUT,
  )

  it.live(
    "shell mode: sequential commands",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        ctx.pty.write("!")
        yield* ptyWaitFor(ctx.pty, "$", { timeout: 5_000 })
        ctx.pty.write("echo first-cmd")
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx.pty, "first-cmd", { timeout: 5_000 })
        yield* shortPause(500)
        ctx.pty.write("echo second-cmd")
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx.pty, "second-cmd", { timeout: 5_000 })
        ctx.pty.write(ESC)
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Session", () => {
  it.live(
    "submitting message triggers session creation",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        ctx.pty.write("hi")
        yield* shortPause(300)
        ctx.pty.write(ENTER)
        yield* shortPause(3_000)
        expect(ctx.output.length).toBeGreaterThan(2000)
        ctx.pty.write(CTRL_C)
      }),
    TEST_TIMEOUT,
  )

  it.live(
    "double ESC after session activity exits without watchdog fallback",
    () =>
      Effect.gen(function* () {
        yield* resetClientLog()
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        ctx.pty.write("hi")
        yield* shortPause(300)
        ctx.pty.write(ENTER)
        yield* shortPause(3_000)
        ctx.pty.write(ESC)
        yield* shortPause(200)
        ctx.pty.write(ESC)
        const code = yield* raceWithNullTimeout(ctx.pty.exited, 8_000)
        const log = readClientLog()
        expect(code).toBe(0)
        expect(log).not.toContain("shutdown.watchdog-fired")
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Headless", () => {
  it.live(
    "-H flag produces output",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn(["-H", "say hello"])
        const ctx = currentContext()
        yield* raceWithNullTimeout(ctx.pty.exited, 8_000)
        expect(ctx.output.length).toBeGreaterThan(0)
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Prompt History", () => {
  it.live(
    "up arrow at empty prompt does not crash",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        ctx.pty.write(UP)
        yield* shortPause(500)
        expect(stripAnsi(ctx.output)).toContain("❯")
      }),
    TEST_TIMEOUT,
  )

  it.live(
    "up arrow at non-empty input does not navigate",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
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
  it.live(
    "$ trigger shows skills popup",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedSkillAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        yield* shortPause(2_000)
        ctx.pty.write("$t")
        yield* ptyWaitFor(ctx.pty, "Skills", { timeout: 5_000 })
        const clean = stripAnsi(ctx.output)
        expect(clean).toContain("Skills")
        ctx.pty.write(ESC)
      }),
    TEST_TIMEOUT,
  )

  it.live(
    "ESC closes skill popup",
    () =>
      Effect.gen(function* () {
        testContext = yield* seedSkillAndSpawn()
        const ctx = currentContext()
        yield* ptyWaitFor(ctx.pty, "❯", { timeout: 10_000 })
        yield* shortPause(2_000)
        ctx.pty.write("$t")
        yield* ptyWaitFor(ctx.pty, "Skills", { timeout: 5_000 })
        ctx.pty.write(ESC)
        yield* shortPause(500)
        expect(stripAnsi(ctx.output)).toContain("❯")
      }),
    TEST_TIMEOUT,
  )
})
