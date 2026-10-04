/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Deferred, Effect, Option, Predicate, Schema } from "effect"
import type { ExtensionStatus } from "@gent/core/extensions/api"
import extensionAdminClient, {
  extensionDetail,
  extensionIssue,
  extensionRow,
  paneTitle,
} from "../../src/extensions/extension-admin.client"
import { renderFrame, renderScoped } from "../render-harness-boundary"
import { waitForFrame, waitUntil } from "../helpers-boundary"
import { makePaneSlot, provideClientServices } from "../extension-test-harness-boundary"

// ── extensions pane ─────────────────────────────────────────────────────────

/**
 * The `/extensions` pane: a row per extension of the session with its scope,
 * state and version, the keys that turn one off or on and set it up again,
 * and a failure's whole text.
 */

const builtin: ExtensionStatus = {
  _tag: "Active",
  id: "@gent/memory",
  scope: "builtin",
  sourcePath: "builtin",
}
const reloadFailed: ExtensionStatus = {
  _tag: "Active",
  id: "@user/notes",
  scope: "user",
  sourcePath: "/home/u/.gent/extensions/notes.ts",
  version: "0123456789abcdef0123",
  reloadFailed: { phase: "setup", error: "notes setup boom\n    at setup (notes.ts:4:9)" },
}
const failed: ExtensionStatus = {
  _tag: "Failed",
  id: "@user/broken",
  scope: "user",
  sourcePath: "/home/u/.gent/extensions/broken.ts",
  phase: "load",
  error: "Failed to build broken.ts: Unexpected }",
}
const disabled: ExtensionStatus = {
  _tag: "Disabled",
  id: "@project/off",
  scope: "project",
  sourcePath: "/repo/.gent/extensions/off.ts",
}
const statuses = [builtin, reloadFailed, failed, disabled]

describe("extensions pane rows", () => {
  test("a row names the scope, the state and the version, and a narrow row keeps the state", () => {
    expect(extensionRow(reloadFailed, 70)).toBe(
      `${"@user/notes".padEnd(33)}  user · reload failed · 0123456789ab`,
    )
    expect(extensionRow(builtin, 40)).toBe(`${"@gent/memory".padEnd(26)}  builtin · on`)
    expect(extensionRow(reloadFailed, 40)).toBe(`${"@user/notes".padEnd(18)}  user · reload failed`)
    expect(extensionRow(reloadFailed, 30)).toBe(`${"@user/notes".padEnd(15)}  reload failed`)
    expect(extensionRow(disabled, 30)).toBe(`${"@project/off".padEnd(15)}  project · off`)
  })

  test("the title counts each state, the detail names the failure, and enter's text is whole", () => {
    expect(paneTitle(statuses)).toBe("Extensions · 1 on · 1 reload failed · 1 failed · 1 off")
    expect(paneTitle([builtin])).toBe("Extensions · 1 on")
    expect(extensionDetail(reloadFailed)).toBe("new version failed at setup: notes setup boom")
    expect(extensionDetail(failed)).toBe("failed at load: Failed to build broken.ts: Unexpected }")
    expect(extensionDetail(builtin)).toBe("builtin")
    expect(extensionIssue(reloadFailed)).toEqual(
      Option.some(
        "The new version failed at setup; version 0123456789ab still runs.\n\nnotes setup boom\n    at setup (notes.ts:4:9)",
      ),
    )
    expect(extensionIssue(builtin)).toEqual(Option.none())
    expect(extensionIssue(disabled)).toEqual(Option.none())
  })
})

/** The pane's requests as the server answers them, each one recorded. */
const paneServer = (
  extensions: ReadonlyArray<ExtensionStatus> = statuses,
  afterChange: ReadonlyArray<ExtensionStatus> = extensions,
) => {
  const requests: Array<{ readonly capabilityId: string; readonly input: unknown }> = []
  let reloads = 0
  let current = extensions
  return {
    requests,
    reloads: () => reloads,
    options: {
      requestEffect: (request: { readonly capabilityId: string; readonly input: unknown }) =>
        Effect.sync(() => {
          requests.push({ capabilityId: request.capabilityId, input: request.input })
          let detail = ""
          if (request.capabilityId === "extensions.pane.set-enabled") {
            detail = "Disabled @user/notes in /home/u/.gent/config.json."
          }
          if (request.capabilityId === "extensions.pane.reload") {
            detail = "Set @user/notes up again; the next turn runs the new setup."
          }
          if (detail.length > 0) current = afterChange
          return { detail, extensions: current }
        }),
      shell: {
        pane: makePaneSlot(),
        reloadExtensions: () => {
          reloads += 1
        },
      },
    },
  }
}

/** The pane as the extension contributes it, open, at `width` columns. */
const openPane = (
  width: number,
  extensions: ReadonlyArray<ExtensionStatus> = statuses,
  height = 30,
  afterChange: ReadonlyArray<ExtensionStatus> = extensions,
) =>
  Effect.gen(function* () {
    const server = paneServer(extensions, afterChange)
    const setup = yield* openPaneOn(server.options, width, height)
    return { setup, server }
  })

/** The pane open at `width` columns over a server the test gives. */
const openPaneOn = (
  options: Parameters<typeof provideClientServices>[1],
  width: number,
  height = 30,
) =>
  Effect.gen(function* () {
    const contributions = yield* provideClientServices(extensionAdminClient.setup, options)
    const command = Option.getOrThrow(Option.fromUndefinedOr(contributions.commands?.[0]))
    const widget = Option.getOrThrow(Option.fromUndefinedOr(contributions.widgets?.[0]))
    expect(command.slash).toBe("extensions")
    const Pane = widget.component
    const setup = yield* renderScoped(() => <Pane />, { width, height })
    command.onSelect()
    yield* waitForFrame(setup, (frame) => frame.includes("Extensions ·"), "the extensions pane")
    return setup
  })

/** A change the server refuses, in its own words. */
class PaneRefusal extends Schema.TaggedError<PaneRefusal>()("PaneRefusal", {
  message: Schema.String,
}) {}

/**
 * A server that answers as the real one: a change reads and writes one
 * status, `reload` refuses an extension that is off, and each `set-enabled`
 * waits for the test to let it end.
 */
const statefulServer = (initial: ExtensionStatus) =>
  Effect.sync(() => {
    const gates: Array<Deferred.Deferred<void>> = []
    const requests: Array<{ readonly capabilityId: string; readonly input: unknown }> = []
    let current = initial
    const turnedOn: ExtensionStatus = {
      _tag: "Active",
      id: initial.id,
      scope: initial.scope,
      sourcePath: initial.sourcePath,
      version: "0123456789abcdef0123",
    }
    const turnedOff: ExtensionStatus = {
      _tag: "Disabled",
      id: initial.id,
      scope: initial.scope,
      sourcePath: initial.sourcePath,
    }
    const answer = (request: {
      readonly capabilityId: string
      readonly input: unknown
    }): Effect.Effect<unknown, PaneRefusal> =>
      Effect.gen(function* () {
        requests.push({ capabilityId: request.capabilityId, input: request.input })
        if (request.capabilityId === "extensions.pane.set-enabled") {
          const gate = yield* Deferred.make<void>()
          gates.push(gate)
          yield* Deferred.await(gate)
          const on =
            Predicate.hasProperty(request.input, "enabled") && request.input.enabled === true
          current = turnedOff
          let verb = "Disabled"
          if (on) {
            current = turnedOn
            verb = "Enabled"
          }
          return {
            detail: `${verb} ${initial.id} in /home/u/.gent/config.json.`,
            extensions: [current],
          }
        }
        if (request.capabilityId === "extensions.pane.reload") {
          if (current._tag === "Disabled") {
            return yield* new PaneRefusal({
              message: `${initial.id} is off in a config: turn it on to set it up`,
            })
          }
          return {
            detail: `Set ${initial.id} up again; the next turn runs the new setup.`,
            extensions: [current],
          }
        }
        return { detail: "", extensions: [current] }
      })
    return {
      requests,
      /** Let the oldest waiting `set-enabled` end, once one waits. */
      release: Effect.gen(function* () {
        yield* waitUntil(() => gates.length > 0, "a set-enabled waits")
        const gate = yield* Effect.fromOption(Option.fromUndefinedOr(gates.shift()))
        yield* Deferred.succeed(gate, void 0)
      }),
      options: {
        requestEffect: answer,
        shell: { pane: makePaneSlot(), reloadExtensions: () => {} },
      },
    }
  })

describe("extensions pane", () => {
  it.scopedLive(
    "opens on the first extension that needs the reader; space turns it off and r sets it up again, each without an ask, and the client extensions load again",
    () =>
      Effect.gen(function* () {
        const { setup, server } = yield* openPane(120)
        const frame = renderFrame(setup)
        expect(frame).toContain("Extensions · 1 on · 1 reload failed · 1 failed · 1 off")
        expect(frame).toContain("user · reload failed · 0123456789ab")
        expect(frame).toContain("project · off")
        expect(frame).toContain("new version failed at setup: notes setup boom")
        expect(frame).toContain("space on/off")

        setup.mockInput.pressKey(" ")
        yield* waitForFrame(
          setup,
          (text) => text.includes("Disabled @user/notes in /home/u/.gent/config.json."),
          "the toggle's reply",
        )
        expect(
          server.requests.find((request) => request.capabilityId === "extensions.pane.set-enabled"),
        ).toEqual({
          capabilityId: "extensions.pane.set-enabled",
          input: { id: "@user/notes", enabled: false },
        })
        expect(server.reloads()).toBe(1)

        setup.mockInput.pressKey("r")
        yield* waitForFrame(setup, (text) => text.includes("Set @user/notes up again"), "reload")
        expect(server.requests.map((request) => request.capabilityId)).toContain(
          "extensions.pane.reload",
        )
        expect(server.reloads()).toBe(2)
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("enter shows a failure's whole text, esc goes back, and esc again closes", () =>
    Effect.gen(function* () {
      const { setup } = yield* openPane(120)
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (text) => text.includes("at setup (notes.ts:4:9)"), "the issue")
      expect(renderFrame(setup)).toContain("version 0123456789ab still runs")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (text) => text.includes("1 reload failed"), "the list again")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (text) => !text.includes("Extensions ·"), "the pane closed")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("at 45 columns a row keeps its id and its state, and a resize widens it", () =>
    Effect.gen(function* () {
      const { setup } = yield* openPane(45)
      const narrow = renderFrame(setup)
      expect(narrow).toContain("@user/notes")
      expect(narrow).toContain("reload failed")
      expect(narrow).not.toContain("0123456789ab")
      setup.resize(120, 30)
      yield* waitForFrame(setup, (text) => text.includes("0123456789ab"), "the wide row")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a failed extension past the first screen of rows opens in view, and stays in view as the terminal shortens",
    () =>
      Effect.gen(function* () {
        const builtins = Array.from({ length: 23 }, (_, index): ExtensionStatus => ({
          ...builtin,
          id: `@gent/builtin-${String(index).padStart(2, "0")}`,
        }))
        const { setup } = yield* openPane(120, [...builtins, reloadFailed, disabled], 20)
        yield* waitForFrame(
          setup,
          (text) => text.includes("@user/notes") && text.includes("new version failed"),
          "the failed row in view",
        )
        setup.resize(120, 12)
        yield* waitForFrame(
          setup,
          (text) => text.includes("@user/notes  ") && !text.includes("builtin-00"),
          "the failed row in view on a short terminal",
        )
      }).pipe(Effect.timeout("10 seconds")),
  )

  // Keys the reader presses while a change runs act after it, in order,
  // each on the state the change before it left, and each reply shows.
  it.scopedLive("a reload pressed while a turn-on runs waits for it, and both replies show", () =>
    Effect.gen(function* () {
      const server = yield* statefulServer(disabled)
      const setup = yield* openPaneOn(server.options, 120)
      yield* waitForFrame(setup, (text) => text.includes("project · off"), "the row")
      setup.mockInput.pressKey(" ")
      setup.mockInput.pressKey("r")
      yield* server.release
      yield* waitForFrame(
        setup,
        (text) =>
          text.includes("Enabled @project/off") && text.includes("Set @project/off up again"),
        "both replies",
      )
      expect(renderFrame(setup)).not.toContain("is off in a config")
      const changes = server.requests
        .map((request) => request.capabilityId)
        .filter((id) => id !== "extensions.pane.status")
      expect(changes).toEqual(["extensions.pane.set-enabled", "extensions.pane.reload"])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("two presses of space turn an extension on and then off again", () =>
    Effect.gen(function* () {
      const server = yield* statefulServer(disabled)
      const setup = yield* openPaneOn(server.options, 120)
      yield* waitForFrame(setup, (text) => text.includes("project · off"), "the row")
      setup.mockInput.pressKey(" ")
      setup.mockInput.pressKey(" ")
      yield* server.release
      yield* server.release
      yield* waitForFrame(
        setup,
        (text) => text.includes("Disabled @project/off") && text.includes("project · off"),
        "the second reply",
      )
      expect(
        server.requests
          .filter((request) => request.capabilityId === "extensions.pane.set-enabled")
          .map((request) => request.input),
      ).toEqual([
        { id: "@project/off", enabled: true },
        { id: "@project/off", enabled: false },
      ])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "the cursor stays on the row the reader turned off when the rows come back in a new order",
    () =>
      Effect.gen(function* () {
        const notesOff: ExtensionStatus = {
          _tag: "Disabled",
          id: reloadFailed.id,
          scope: reloadFailed.scope,
          sourcePath: reloadFailed.sourcePath,
        }
        const { setup } = yield* openPane(120, statuses, 30, [builtin, failed, disabled, notesOff])
        setup.mockInput.pressKey(" ")
        yield* waitForFrame(
          setup,
          (text) =>
            text.includes("Disabled @user/notes in /home/u/.gent/config.json.") &&
            text.includes("2 off"),
          "the reply on the row turned off",
        )
      }).pipe(Effect.timeout("10 seconds")),
  )
})
