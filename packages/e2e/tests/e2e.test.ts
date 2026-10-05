/**
 * PTY-based E2E tests for TUI.
 * Uses zigpty for pseudo-terminal emulation with waitFor pattern.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Option } from "effect"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import {
  DEFAULT_PTY_SIZE,
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
// PTY cleanup can wait 1 s for ctrl+c and 2 s after SIGKILL. Leave 5 s before Bun.
const EFFECT_TIMEOUT = "25 seconds"

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
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
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
        ctx.pty.write(keys.esc)
        // oxlint-disable-next-line effect/noFixedWaitInTests -- a lone ESC counts as a key only after the escape-sequence timeout, and nothing on screen marks it
        yield* Effect.sleep(`${ESC_KEY_DECODE_MS} millis`)
        ctx.pty.write(keys["ctrl+c"])
        yield* ptyWaitFor(ctx, "ctrl+c again to exit", { timeout: 5_000 })
        ctx.pty.write(keys["ctrl+c"])
        expect(yield* exitWithin(ctx.pty.exited, "10 seconds")).toEqual(Option.some(0))
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "ctrl+d on the empty composer exits with code 0",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn()
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write(keys["ctrl+d"])
        expect(yield* exitWithin(ctx.pty.exited, "10 seconds")).toEqual(Option.some(0))
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
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
        // user's model (the fixture home's config) is a Claude one, so the
        // picker it opens is anthropic's.
        yield* ptyWaitFor(ctx, "Claude Code", { timeout: 10_000 })
        yield* ptyWaitFor(ctx, "Manually enter API key", { timeout: 10_000 })
        expect(ctx.output).toContain("· method")
        // The rows end in "+ Add credential", so the key entry is one down.
        ctx.pty.write(keys.down)
        // The selection moves in a repaint; Enter goes to the row it lands on.
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write(keys.enter)
        yield* ptyWaitFor(ctx, "API key ›", { timeout: 5_000 })
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
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
        ctx.pty.write(keys.esc)
        // The output keeps the frames that drew the popup; the screen must not.
        yield* screenWaitFor(ctx, (visible) => !visible.some((row) => row.includes("Commands")), {
          timeout: 5_000,
          label: "no commands popup",
        })
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
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
        ctx.pty.write("!")
        yield* ptyWaitFor(ctx, "$", { timeout: 5_000 })
        ctx.pty.write("echo first-$((1+1))")
        ctx.pty.write(keys.enter)
        yield* ptyWaitFor(ctx, "first-2", { timeout: 5_000 })
        // A command leaves shell mode: the next one starts with its own `!`.
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write("!")
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write("echo second-$((2+1))")
        ctx.pty.write(keys.enter)
        yield* ptyWaitFor(ctx, "second-3", { timeout: 5_000 })
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
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
        // "ready"; only the session route renders the `✻` live line.
        const ctx = yield* seedAndSpawn(["--mock-empty"])
        yield* ptyWaitFor(ctx, "ready", { timeout: 10_000 })
        ctx.pty.write("hi")
        // Enter must reach the composer after the text it submits is drawn.
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write(keys.enter)
        yield* ptyWaitFor(ctx, "✻ Thinking", { timeout: 10_000 })
        ctx.pty.write(keys["ctrl+c"])
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
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
        ctx.pty.write("$t")
        yield* screenWaitFor(ctx, showsSkillsPopup, { timeout: 10_000, label: "the skills popup" })
        yield* ptyWaitFor(ctx, "test-skill", { timeout: 10_000 })
        ctx.pty.write(keys.esc)
        // The output keeps the frames that drew the popup; the screen must not.
        yield* screenWaitFor(ctx, (visible) => !showsSkillsPopup(visible), {
          timeout: 5_000,
          label: "no skills popup",
        })
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )
})

// The terminal handover (`ClientShell.handover`, the editor's too): the
// renderer gives the terminal to a program, and takes it back when the
// program exits, header, composer and footer drawn again.
describe("E2E: Terminal handover", () => {
  it.scopedLive(
    "ctrl+g hands the terminal to the editor and takes it back with the edit",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* makeTempDirectoryScoped("gent-e2e-editor-")
        const editor = `${dir}/editor`
        yield* fs.writeFileString(
          editor,
          [
            "#!/bin/sh",
            "printf 'HANDOVER-PROBE\\n'",
            "printf 'edited by the probe' > \"$1\"",
            "",
          ].join("\n"),
        )
        yield* fs.chmod(editor, 0o755)
        const ctx = yield* seedAndSpawn(["--mock-empty"], DEFAULT_PTY_SIZE, {
          VISUAL: editor,
          EDITOR: editor,
        })
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("draft")
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write(keys["ctrl+g"])
        yield* ptyWaitFor(ctx, "HANDOVER-PROBE", { timeout: 10_000 })
        yield* screenWaitFor(
          ctx,
          (visible) =>
            visible.some((line) => line.includes("┃ edited by the probe")) &&
            visible.some((line) => line.includes("ctrl+p commands")) &&
            visible.some((line) => line.includes("ready")),
          { timeout: 10_000, label: "the screen back with the edit in the composer" },
        )
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  // The terminal's signal keys belong to the program it was handed to: the
  // program runs in the terminal's foreground group, and gent lets ctrl+\ and
  // ctrl+c pass while it waits, as a shell's `system()` does.
  it.scopedLive(
    "ctrl+\\ and ctrl+c during a handover reach the program, and gent takes the terminal back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* makeTempDirectoryScoped("gent-e2e-signals-")
        const editor = `${dir}/editor`
        yield* fs.writeFileString(
          editor,
          [
            "#!/bin/sh",
            "trap 'printf \"EDITOR-SIGQUIT\\n\"' QUIT",
            'trap \'printf "edited after ctrl+c" > "$1"; exit 0\' INT',
            "printf 'EDITOR-WAITING\\n'",
            "while :; do sleep 1; done",
            "",
          ].join("\n"),
        )
        yield* fs.chmod(editor, 0o755)
        const ctx = yield* seedAndSpawn(["--mock-empty"], DEFAULT_PTY_SIZE, {
          VISUAL: editor,
          EDITOR: editor,
        })
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("draft")
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write(keys["ctrl+g"])
        yield* ptyWaitFor(ctx, "EDITOR-WAITING", { timeout: 10_000 })
        ctx.pty.write(keys["ctrl+\\"])
        yield* ptyWaitFor(ctx, "EDITOR-SIGQUIT", { timeout: 5_000 })
        ctx.pty.write(keys["ctrl+c"])
        yield* screenWaitFor(
          ctx,
          (visible) =>
            visible.some((line) => line.includes("┃ edited after ctrl+c")) &&
            visible.some((line) => line.includes("ready")),
          { timeout: 10_000, label: "the screen back with the edit in the composer" },
        )
        // Gent is alive: the composer still takes keys.
        ctx.pty.write(" and more")
        yield* screenWaitFor(
          ctx,
          (visible) => visible.some((line) => line.includes("┃ edited after ctrl+c and more")),
          { timeout: 5_000, label: "the composer takes keys after the handover" },
        )
        expect(yield* exitWithin(ctx.pty.exited, "1 second")).toEqual(Option.none())
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  // `@gent/git` runs `hunk` from PATH; a stand-in prints its arguments and exits.
  it.scopedLive(
    "/diff hands the terminal to hunk and takes it back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* makeTempDirectoryScoped("gent-e2e-hunk-")
        yield* fs.writeFileString(
          `${dir}/hunk`,
          ["#!/bin/sh", "printf 'HUNK-PROBE %s\\n' \"$*\"", ""].join("\n"),
        )
        yield* fs.chmod(`${dir}/hunk`, 0o755)
        const ctx = yield* seedAndSpawn(["--mock-empty"], DEFAULT_PTY_SIZE, {
          // oxlint-disable-next-line effect/noGlobals -- the stand-in goes ahead of the test's own PATH
          PATH: `${dir}:${Bun.env["PATH"] ?? ""}`,
        })
        yield* ptyWaitFor(ctx, "┃", { timeout: 10_000 })
        ctx.pty.write("/diff")
        yield* settlePty(ctx, REPAINT)
        ctx.pty.write(keys.enter)
        yield* ptyWaitFor(ctx, "HUNK-PROBE diff --watch", { timeout: 10_000 })
        yield* screenWaitFor(
          ctx,
          (visible) =>
            visible.some((line) => line.includes("ctrl+p commands")) &&
            visible.some((line) => line.includes("ready")),
          { timeout: 10_000, label: "the screen back after hunk" },
        )
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )
})
