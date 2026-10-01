/**
 * PTY-based E2E tests for TUI.
 * Uses zigpty for pseudo-terminal emulation with waitFor pattern.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import {
  ptyWaitFor,
  screenWaitFor,
  seedAndSpawn,
  seedSkillAndSpawn,
  settlePty,
  spawnNoAuth,
} from "../src/pty-fixture"
import { exitWithin } from "../src/server-process-fixture"

const TEST_TIMEOUT = 30_000

const ENTER = "\r"
const ESC = "\x1b"
const CTRL_C = "\x03"
const CTRL_D = "\x04"
const UP = "\x1b[A"
const ESC_KEY_DECODE_MS = 650

/** A repaint burst is over once the child writes nothing for this long. */
const REPAINT = { quietMs: 200, timeoutMs: 5_000 }

describe("E2E: Basics", () => {
  it.scopedLive(
    "typing text appears in output",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn()
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("hello world")
        // The composer draws each keystroke on its own, so only the screen shows the words whole.
        yield* screenWaitFor(ctx, (visible) => visible.some((row) => row.includes("hello world")), {
          timeout: 5_000,
          label: "the typed text",
        })
      }),
    TEST_TIMEOUT,
  )

  // Esc never quits: after one, ctrl+c twice on the empty composer does, with
  // the cue drawn between the presses.
  it.scopedLive(
    "ctrl+c twice exits with code 0",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn()
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write(ESC)
        // gent/no-sleep: allow a lone ESC counts as a key only after the escape-sequence timeout, and nothing on screen marks it
        yield* Effect.sleep(`${ESC_KEY_DECODE_MS} millis`)
        ctx.pty.write(CTRL_C)
        yield* ptyWaitFor(ctx, "ctrl+c again to exit", { timeout: 5_000 })
        ctx.pty.write(CTRL_C)
        expect(yield* exitWithin(ctx.pty.exited, "10 seconds")).toEqual(Option.some(0))
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "ctrl+d on the empty composer exits with code 0",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn()
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write(CTRL_D)
        expect(yield* exitWithin(ctx.pty.exited, "10 seconds")).toEqual(Option.some(0))
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Auth", () => {
  it.scopedLive(
    "missing auth opens auth panel and method picker",
    () =>
      Effect.gen(function* () {
        const ctx = yield* spawnNoAuth
        yield* ptyWaitFor(ctx, "Sign in", { timeout: 10_000 })
        // The boot gate opens on the first *required* provider, and the
        // default agent's model is a Claude one, so the picker it opens is
        // anthropic's.
        yield* ptyWaitFor(ctx, "Claude Code", { timeout: 10_000 })
        yield* ptyWaitFor(ctx, "Manually enter API key", { timeout: 10_000 })
        expect(ctx.output).toContain("· method")
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "auth panel: arrows select manual key entry",
    () =>
      Effect.gen(function* () {
        const ctx = yield* spawnNoAuth
        yield* ptyWaitFor(ctx, "Sign in", { timeout: 10_000 })
        yield* ptyWaitFor(ctx, "Manually enter API key", { timeout: 10_000 })
        ctx.pty.write(UP)
        // The selection moves in a repaint; Enter goes to the row it lands on.
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "API key ›", { timeout: 5_000 })
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Slash Commands", () => {
  it.scopedLive(
    "/ prefix shows the commands popup, and ESC closes it",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn()
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("/")
        yield* ptyWaitFor(ctx, "Commands", { timeout: 5_000 })
        yield* ptyWaitFor(ctx, "/new", { timeout: 5_000 })
        ctx.pty.write(ESC)
        // The output keeps the frames that drew the popup; the screen must not.
        yield* screenWaitFor(ctx, (visible) => !visible.some((row) => row.includes("Commands")), {
          timeout: 5_000,
          label: "no commands popup",
        })
      }),
    TEST_TIMEOUT,
  )
})

// Each command computes its output, so the text waited for is never the
// composer's echo of what was typed: only a command that ran prints it. The
// shell output goes to the agent as a turn; `--mock-empty` keeps that turn offline.
describe("E2E: Shell Mode", () => {
  it.scopedLive(
    "! runs a shell command and shows its output",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn(["--mock-empty"])
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("!")
        yield* ptyWaitFor(ctx, "$", { timeout: 5_000 })
        ctx.pty.write("echo zigpty-$((1+1))")
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "zigpty-2", { timeout: 5_000 })
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "shell mode: sequential commands",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn(["--mock-empty"])
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("!")
        yield* ptyWaitFor(ctx, "$", { timeout: 5_000 })
        ctx.pty.write("echo first-$((1+1))")
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "first-2", { timeout: 5_000 })
        // A command leaves shell mode: the next one starts with its own `!`.
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write("!")
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write("echo second-$((2+1))")
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "second-3", { timeout: 5_000 })
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
        const ctx = yield* seedAndSpawn(["--mock-empty"])
        yield* ptyWaitFor(ctx, "ready", { timeout: 10_000 })
        ctx.pty.write("hi")
        // Enter must reach the composer after the text it submits is drawn.
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write(ENTER)
        yield* ptyWaitFor(ctx, "Generating", { timeout: 10_000 })
        ctx.pty.write(CTRL_C)
      }),
    TEST_TIMEOUT,
  )
})

/** How long the skills take to list after the composer first draws. Nothing on screen marks it. */
const SKILL_DISCOVERY = "2 seconds"

const showsSkillsPopup = (visible: ReadonlyArray<string>) =>
  visible.some((row) => row.includes("Skills"))

describe("E2E: Skill Popup", () => {
  it.scopedLive(
    "$ trigger shows skills popup",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedSkillAndSpawn
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        // gent/no-sleep: allow a `$` typed before the skills are listed opens no popup, and no screen signal marks the listing
        yield* Effect.sleep(SKILL_DISCOVERY)
        ctx.pty.write("$t")
        yield* screenWaitFor(ctx, showsSkillsPopup, { timeout: 10_000, label: "the skills popup" })
        yield* ptyWaitFor(ctx, "test-skill", { timeout: 10_000 })
      }).pipe(Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "ESC closes skill popup",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedSkillAndSpawn
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        // gent/no-sleep: allow a `$` typed before the skills are listed opens no popup, and no screen signal marks the listing
        yield* Effect.sleep(SKILL_DISCOVERY)
        ctx.pty.write("$t")
        yield* screenWaitFor(ctx, showsSkillsPopup, { timeout: 10_000, label: "the skills popup" })
        ctx.pty.write(ESC)
        // The output keeps the frames that drew the popup; the screen must not.
        yield* screenWaitFor(ctx, (visible) => !showsSkillsPopup(visible), {
          timeout: 5_000,
          label: "no skills popup",
        })
      }).pipe(Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )
})
