/**
 * PTY-based E2E tests for TUI.
 * Runs the TUI on a Bun.Terminal pty and reads it with the waitFor pattern.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import {
  keys,
  ptyWaitFor,
  screenWaitFor,
  seedAndSpawn,
  seedSkillAndSpawn,
  settlePty,
  spawnNoAuth,
} from "../src/pty-fixture"
import { exitWithin } from "../src/server-process-fixture"

const TEST_TIMEOUT = 30_000

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
        ctx.write("hello world")
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
        ctx.write(keys.esc)
        // oxlint-disable-next-line effect/noFixedWaitInTests -- a lone ESC counts as a key only after the escape-sequence timeout, and nothing on screen marks it
        yield* Effect.sleep(`${ESC_KEY_DECODE_MS} millis`)
        ctx.write(keys["ctrl+c"])
        yield* ptyWaitFor(ctx, "ctrl+c again to exit", { timeout: 5_000 })
        ctx.write(keys["ctrl+c"])
        expect(yield* exitWithin(ctx.exited, "10 seconds")).toEqual(Option.some(0))
      }),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "ctrl+d on the empty composer exits with code 0",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn()
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.write(keys["ctrl+d"])
        expect(yield* exitWithin(ctx.exited, "10 seconds")).toEqual(Option.some(0))
      }),
    TEST_TIMEOUT,
  )
})

describe("E2E: Auth", () => {
  it.scopedLive(
    "missing auth opens the method picker, and arrows select manual key entry",
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
        ctx.write(keys.up)
        // The selection moves in a repaint; Enter goes to the row it lands on.
        yield* settlePty(ctx, REPAINT)
        ctx.write(keys.enter)
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
        ctx.write("/")
        yield* ptyWaitFor(ctx, "Commands", { timeout: 5_000 })
        yield* ptyWaitFor(ctx, "/new", { timeout: 5_000 })
        ctx.write(keys.esc)
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
    "! runs shell commands one after another and shows each output",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn(["--mock-empty"])
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.write("!")
        yield* ptyWaitFor(ctx, "$", { timeout: 5_000 })
        ctx.write("echo first-$((1+1))")
        ctx.write(keys.enter)
        yield* ptyWaitFor(ctx, "first-2", { timeout: 5_000 })
        // A command leaves shell mode: the next one starts with its own `!`.
        yield* settlePty(ctx, REPAINT)
        ctx.write("!")
        yield* settlePty(ctx, REPAINT)
        ctx.write("echo second-$((2+1))")
        ctx.write(keys.enter)
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
        ctx.write("hi")
        // Enter must reach the composer after the text it submits is drawn.
        yield* settlePty(ctx, REPAINT)
        ctx.write(keys.enter)
        yield* ptyWaitFor(ctx, "Generating", { timeout: 10_000 })
        ctx.write(keys["ctrl+c"])
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
    "$ trigger shows the skills popup, and ESC closes it",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedSkillAndSpawn
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        // oxlint-disable-next-line effect/noFixedWaitInTests -- a `$` typed before the skills are listed opens no popup, and no screen signal marks the listing
        yield* Effect.sleep(SKILL_DISCOVERY)
        ctx.write("$t")
        yield* screenWaitFor(ctx, showsSkillsPopup, { timeout: 10_000, label: "the skills popup" })
        yield* ptyWaitFor(ctx, "test-skill", { timeout: 10_000 })
        ctx.write(keys.esc)
        // The output keeps the frames that drew the popup; the screen must not.
        yield* screenWaitFor(ctx, (visible) => !showsSkillsPopup(visible), {
          timeout: 5_000,
          label: "no skills popup",
        })
      }).pipe(Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )
})
