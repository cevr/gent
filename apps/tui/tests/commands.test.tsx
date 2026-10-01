/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import {
  type Command,
  CommandPalette,
  executeSlashCommand,
  parseSlashCommand,
  useCommand,
} from "../src/commands"
import { createEffect, ErrorBoundary, For, onCleanup, onMount } from "solid-js"
import { Effect, Option, Schema } from "effect"
import { BranchId, dateFromMillis, GentRpcError, SessionId } from "@gent/core/protocol"
import { type ClientContextValue, useClient } from "../src/client"
import { useExtensionUI } from "../src/extensions/host"
import type { AgentRowEntry } from "@gent/extensions/client"
import { createMockClient, renderFrame, renderScoped } from "./render-harness-boundary"
import { waitForFrame } from "./helpers-boundary"
import { makePaneSlot } from "./extension-test-harness-boundary"

// ── slash commands ──────────────────────────────────────────────────────────

describe("parseSlashCommand", () => {
  test("splits a slash line into its name and the rest, trimmed", () => {
    const cases: ReadonlyArray<readonly [string, [string, string]]> = [
      ["/agent", ["agent", ""]],
      ["/branch feature-branch extra", ["branch", "feature-branch extra"]],
      ["  /clear  ", ["clear", ""]],
    ]
    for (const [line, parsed] of cases) {
      expect(parseSlashCommand(line)).toEqual(Option.some(parsed))
    }
  })

  test("reads a line without a leading slash as no command", () => {
    expect(parseSlashCommand("hello")).toEqual(Option.none())
    expect(parseSlashCommand("")).toEqual(Option.none())
  })
})

const cmd = (overrides: Partial<Command> & { id: string; slash: string }): Command => ({
  title: overrides.id,
  onSelect: () => {},
  ...overrides,
})

describe("executeSlashCommand", () => {
  test("a slash runs its command by name or alias, in any case", () => {
    for (const typed of ["new", "NEW", "clear", "CLEAR"]) {
      let called = false
      const commands = [
        cmd({
          id: "new",
          slash: "new",
          aliases: ["clear"],
          onSelect: () => {
            called = true
          },
        }),
      ]
      expect(executeSlashCommand(typed, "", commands)).toBe(true)
      expect(called).toBe(true)
    }
  })

  test("a name no command carries runs nothing", () => {
    expect(executeSlashCommand("unknown", "", [])).toBe(false)
  })

  test("prefers onSlash over onSelect when args present", () => {
    let receivedArgs = ""
    const commands = [
      cmd({
        id: "think",
        slash: "think",
        onSelect: () => {},
        onSlash: (args) => {
          receivedArgs = args
        },
      }),
    ]
    expect(executeSlashCommand("think", "high", commands)).toBe(true)
    expect(receivedArgs).toBe("high")
  })

  test("falls back to onSelect when no onSlash", () => {
    let selectCalled = false
    const commands = [
      cmd({
        id: "ext",
        slash: "ext",
        onSelect: () => {
          selectCalled = true
        },
      }),
    ]
    expect(executeSlashCommand("ext", "ignored", commands)).toBe(true)
    expect(selectCalled).toBe(true)
  })

  test("a slash beats another command's alias", () => {
    let winner = ""
    const commands = [
      cmd({ id: "new", slash: "new", aliases: ["clear"], onSelect: () => (winner = "alias") }),
      cmd({ id: "clear", slash: "clear", onSelect: () => (winner = "slash") }),
    ]
    executeSlashCommand("clear", "", commands)
    expect(winner).toBe("slash")
  })
})

// ── command palette ─────────────────────────────────────────────────────────

// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined

/** The palette as ctrl+p opens it: the session view hands the key to `handleKeybind`. */
function OpenPaletteOnMount() {
  const command = useCommand()
  createEffect(() => {
    command.handleKeybind({ name: "p", ctrl: true }, [], true)
  })
  return <CommandPalette />
}

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

function ExtensionProbe(props: {
  readonly onReady: (ext: ReturnType<typeof useExtensionUI>) => void
}) {
  const ext = useExtensionUI()
  onMount(() => {
    props.onReady(ext)
  })
  return <box />
}

/** The agents extension's docked pane, as the session view mounts it below the composer
 * and owns its one pane slot. */
function AgentsPaneWidget() {
  const ext = useExtensionUI()
  ext.setPaneOwner(Option.some(makePaneSlot()))
  onCleanup(() => ext.setPaneOwner(Option.none()))
  return (
    <For each={ext.widgets().filter((widget) => widget.id === "agents.pane")}>
      {(widget) => {
        const Widget = widget.component
        return <Widget />
      }}
    </For>
  )
}

const rootId = SessionId.make("session-root")
const rootBranchId = BranchId.make("branch-root")
const delegateId = SessionId.make("session-delegate")
const delegateBranchId = BranchId.make("branch-delegate")

const rootSession = {
  id: rootId,
  activeBranchId: rootBranchId,
  name: "Root",
  createdAt: dateFromMillis(0),
  updatedAt: dateFromMillis(3),
}

/**
 * Three stored sessions and no live loop: a root, the handoff that continues
 * its thread, and a delegate run that opened a thread of its own.
 */
const storedRows: ReadonlyArray<AgentRowEntry> = [
  {
    sessionId: rootId,
    branchId: rootBranchId,
    section: "inactive",
    name: "Root",
    live: false,
    depth: 0,
    sideThread: false,
  },
  {
    sessionId: SessionId.make("session-handoff"),
    branchId: BranchId.make("branch-handoff"),
    section: "inactive",
    name: "Handoff",
    live: false,
    depth: 1,
    parentSessionId: rootId,
    sideThread: false,
  },
  {
    sessionId: delegateId,
    branchId: delegateBranchId,
    section: "inactive",
    name: "Delegate",
    live: false,
    depth: 1,
    parentSessionId: rootId,
    sideThread: true,
  },
]

const storedSessionsClient = () =>
  createMockClient({
    extension: {
      request: (input: { readonly capabilityId: string }) =>
        Effect.sync(() => {
          if (input.capabilityId === "list-agents") return { rows: storedRows }
          return absent
        }),
    },
  })

describe("CommandPalette renderer", () => {
  it.scopedLive("opens the theme submenu through keyboard navigation and activation", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <OpenPaletteOnMount />, {
        width: 90,
        height: 28,
      })
      expect(renderFrame(setup)).toContain("Commands")
      // Theme is the first row.
      setup.mockInput.pressKey("RETURN")
      yield* Effect.promise(() => setup.renderOnce())
      // The theme level enumerates the catalog; Dark/Light is the Mode level.
      const frame = renderFrame(setup)
      expect(frame).toContain("System")
      expect(frame).toContain("fx")
      expect(frame).toContain("opencode")
    }),
  )

  it.scopedLive("a submenu's escape steps back to the root, where escape closes", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <OpenPaletteOnMount />, { width: 90, height: 28 })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Commands") && frame.includes("Branches"),
        "commands root",
      )
      // Branches (the last row) opens a level whose footer shows "Back"
      // where the root shows "Close".
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("esc back"), "branches level")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => frame.includes("esc close"), "root again")
    }),
  )

  // A failed branch list is the level's answer, not a crash: the palette
  // stays open and says why, and Esc still steps back.
  it.scopedLive("a branch list that fails shows why in the palette", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        branch: {
          list: () =>
            Effect.fail(
              Schema.decodeSync(GentRpcError)({
                _tag: "InvalidStateError",
                message: "branch list refused",
              }),
            ),
        },
      })
      const setup = yield* renderScoped(
        () => (
          <ErrorBoundary fallback={(error) => <text>crashed: {String(error)}</text>}>
            <OpenPaletteOnMount />
          </ErrorBoundary>
        ),
        { client, initialSession: rootSession, width: 90, height: 28 },
      )
      yield* waitForFrame(setup, (frame) => frame.includes("Branches"), "commands root")
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      const failed = yield* waitForFrame(
        setup,
        (frame) => frame.includes("branch list refused") || frame.includes("crashed"),
        "the branch level answers",
      )
      expect(failed).not.toContain("crashed")
      expect(failed).toContain("esc back")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => frame.includes("esc close"), "root again")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("the palette Sessions item opens the agents pane and a row switches to it", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const setup = yield* renderScoped(
        () => (
          <>
            <OpenPaletteOnMount />
            <AgentsPaneWidget />
            <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
          </>
        ),
        { client: storedSessionsClient(), initialSession: rootSession, width: 90, height: 28 },
      )
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Commands") && frame.includes("Sessions"),
        "commands root",
      )
      yield* Effect.promise(() => setup.mockInput.typeText("Sessions"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Sessions ·") && frame.includes("Delegate"),
        "agents pane",
      )
      // Every row is stored: no loop runs, and the pane still lists them all.
      expect(renderFrame(setup)).toContain("Inactive (3)")
      // The pane opens on the current session; the delegate is two rows down.
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => !frame.includes("Sessions ·"), "agents pane closed")
      expect(ctx.value.session()).toEqual({
        sessionId: delegateId,
        branchId: delegateBranchId,
        name: "Delegate",
        modelId: absent,
        reasoningLevel: absent,
        cwd: absent,
      })
    }),
  )

  it.scopedLive("/sessions opens the agents pane over stored sessions and marks side threads", () =>
    Effect.gen(function* () {
      let ext: Option.Option<ReturnType<typeof useExtensionUI>> = Option.none()
      const setup = yield* renderScoped(
        () => (
          <>
            <AgentsPaneWidget />
            <ExtensionProbe onReady={(value) => (ext = Option.some(value))} />
          </>
        ),
        { client: storedSessionsClient(), initialSession: rootSession, width: 90, height: 28 },
      )
      if (Option.isNone(ext)) return yield* Effect.die("extension context not ready")
      const commands = () =>
        ext.pipe(
          Option.map((value) => value.commands()),
          Option.getOrElse(() => []),
        )
      yield* waitForFrame(
        setup,
        () => commands().some((command) => command.slash === "sessions"),
        "extension commands loaded",
      )
      expect(executeSlashCommand("sessions", "", commands())).toBe(true)
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Sessions ·") && frame.includes("Delegate"),
        "agents pane",
      )
      const lines = renderFrame(setup).split("\n")
      // The marker rides the row, so the reader sees side work before opening it.
      expect(lines.find((line) => line.includes("Delegate"))).toContain("side thread")
      expect(lines.find((line) => line.includes("Handoff"))).not.toContain("side thread")
      expect(lines.find((line) => line.includes("Root"))).not.toContain("side thread")
    }),
  )
})
