/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import {
  type Command,
  CommandPalette,
  executeSlashCommand,
  parseSlashCommand,
  useCommand,
} from "../src/commands"
import { createEffect, For, onCleanup, onMount } from "solid-js"
import { resolveCommands } from "../src/extensions/loader-boundary"
import { Effect, Option } from "effect"
import { BranchId, dateFromMillis, SessionId } from "@gent/core/protocol"
import { type ClientContextValue, useClient } from "../src/client"
import { useExtensionUI } from "../src/extensions/host"
import type { AgentRowEntry } from "@gent/extensions/client"
import { createMockClient, renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForFrame } from "./helpers-boundary"
import { makePaneSlot } from "./extension-test-harness-boundary"

// ── slash commands ──────────────────────────────────────────────────────────

describe("parseSlashCommand", () => {
  test("parses simple command", () => {
    expect(parseSlashCommand("/agent")).toEqual(["agent", ""])
  })

  test("parses command with args", () => {
    expect(parseSlashCommand("/branch feature-branch")).toEqual(["branch", "feature-branch"])
  })

  test("parses command with multiple args", () => {
    expect(parseSlashCommand("/branch feature-branch extra")).toEqual([
      "branch",
      "feature-branch extra",
    ])
  })

  test("trims whitespace", () => {
    expect(parseSlashCommand("  /clear  ")).toEqual(["clear", ""])
  })

  test("returns null for non-command", () => {
    expect(parseSlashCommand("hello")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseSlashCommand("")).toBeNull()
  })

  test("handles command with trailing space", () => {
    expect(parseSlashCommand("/sessions ")).toEqual(["sessions", ""])
  })
})

const cmd = (overrides: Partial<Command> & { id: string; slash: string }): Command => ({
  title: overrides.id,
  onSelect: () => {},
  ...overrides,
})

describe("executeSlashCommand", () => {
  test("executes matching command", () => {
    let called = false
    const commands = [
      cmd({
        id: "new",
        slash: "new",
        onSelect: () => {
          called = true
        },
      }),
    ]
    const result = executeSlashCommand("new", "", commands)
    expect(result.handled).toBe(true)
    expect(called).toBe(true)
  })

  test("unknown command returns error", () => {
    const result = executeSlashCommand("unknown", "", [])
    expect(result.handled).toBe(false)
    expect(result.error).toBe("Unknown command: /unknown")
  })

  test("case insensitive matching", () => {
    let called = false
    const commands = [
      cmd({
        id: "new",
        slash: "new",
        onSelect: () => {
          called = true
        },
      }),
    ]
    const result = executeSlashCommand("NEW", "", commands)
    expect(result.handled).toBe(true)
    expect(called).toBe(true)
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
    const result = executeSlashCommand("think", "high", commands)
    expect(result.handled).toBe(true)
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
    const result = executeSlashCommand("ext", "ignored", commands)
    expect(result.handled).toBe(true)
    expect(selectCalled).toBe(true)
  })

  test("a project extension overrides a builtin slash", () => {
    let winner = ""
    const { commands, failures } = resolveCommands([
      {
        id: "@gent/session",
        scope: "builtin",
        source: "builtin:@gent/session",
        commands: [
          cmd({ id: "session.model", slash: "model", onSelect: () => (winner = "builtin") }),
        ],
      },
      {
        id: "@test/model",
        scope: "project",
        source: "/project/model.client.ts",
        commands: [
          cmd({ id: "project.model", slash: "model", onSelect: () => (winner = "project") }),
        ],
      },
    ])
    const result = executeSlashCommand("model", "", commands)
    expect(result.handled).toBe(true)
    expect(winner).toBe("project")
    expect(failures).toEqual([])
    // The builtin keeps its palette row; only the slash moved.
    expect(commands.find((command) => command.id === "session.model")?.slash).toBeUndefined()
  })

  test("a server slash that a session command already holds is dropped and reported", () => {
    const { commands, failures } = resolveCommands([
      {
        id: "@gent/session",
        scope: "builtin",
        source: "builtin:@gent/session",
        commands: [cmd({ id: "session.model", slash: "model" })],
      },
      {
        id: "@gent/example-models",
        scope: "builtin",
        source: "server:@gent/example-models",
        commands: [cmd({ id: "server:model", slash: "model" })],
      },
    ])
    expect(commands.map((command) => command.id)).toEqual(["session.model"])
    expect(failures.map((failure) => failure.id)).toEqual(["@gent/example-models"])
  })

  test("a keybind that types a character is refused in every scope, and the command stays", () => {
    const { commands, failures } = resolveCommands([
      {
        id: "@gent/session",
        scope: "builtin",
        source: "builtin:@gent/session",
        commands: [
          cmd({ id: "session.left", slash: "left", keybind: "left" }),
          cmd({ id: "session.help", slash: "help", keybind: "shift+/" }),
        ],
      },
      {
        id: "@test/keys",
        scope: "project",
        source: "/project/keys.client.ts",
        commands: [
          cmd({ id: "project.j", slash: "j", keybind: "j" }),
          cmd({ id: "project.space", slash: "space", keybind: "space" }),
          cmd({ id: "project.ctrl-j", slash: "ctrl-j", keybind: "ctrl+j" }),
          cmd({ id: "project.emoji", slash: "emoji", keybind: "🙂" }),
          cmd({ id: "project.accent", slash: "accent", keybind: "é" }),
          cmd({ id: "project.f1", slash: "f1", keybind: "f1" }),
          cmd({ id: "project.tab", slash: "tab", keybind: "tab" }),
        ],
      },
    ])
    const keybinds = Object.fromEntries(
      commands.map((command) => [
        command.id,
        Option.getOrElse(Option.fromNullishOr(command.keybind), () => "none"),
      ]),
    )
    expect(keybinds).toEqual({
      "session.left": "left",
      "session.help": "none",
      "project.j": "none",
      "project.space": "none",
      "project.ctrl-j": "ctrl+j",
      "project.emoji": "none",
      "project.accent": "none",
      "project.f1": "f1",
      "project.tab": "tab",
    })
    expect(commands.find((command) => command.id === "session.help")?.slash).toBe("help")
    expect(failures.map((failure) => failure.id)).toEqual([
      "@gent/session",
      "@test/keys",
      "@test/keys",
      "@test/keys",
      "@test/keys",
    ])
    expect(failures[1]?.reason).toContain('keybind "j"')
  })

  // A keybind runs before the Esc ladder: a bare escape would take the turn
  // cancel and the quit away from Esc.
  test("a bare escape keybind is refused, and one with ctrl stays", () => {
    const { commands, failures } = resolveCommands([
      {
        id: "@test/keys",
        scope: "project",
        source: "/project/keys.client.ts",
        commands: [
          cmd({ id: "project.escape", slash: "escape", keybind: "escape" }),
          cmd({ id: "project.shift-escape", slash: "shift-escape", keybind: "shift+escape" }),
          cmd({ id: "project.ctrl-escape", slash: "ctrl-escape", keybind: "ctrl+escape" }),
        ],
      },
    ])
    const keybinds = Object.fromEntries(
      commands.map((command) => [
        command.id,
        Option.getOrElse(Option.fromNullishOr(command.keybind), () => "none"),
      ]),
    )
    expect(keybinds).toEqual({
      "project.escape": "none",
      "project.shift-escape": "none",
      "project.ctrl-escape": "ctrl+escape",
    })
    expect(failures).toHaveLength(2)
    expect(failures[0]?.reason).toContain('keybind "escape"')
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

  test("aliases resolve to the command", () => {
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
    const result = executeSlashCommand("clear", "", commands)
    expect(result.handled).toBe(true)
    expect(called).toBe(true)
  })

  test("alias matching is case insensitive", () => {
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
    const result = executeSlashCommand("CLEAR", "", commands)
    expect(result.handled).toBe(true)
    expect(called).toBe(true)
  })
})

// ── command palette ─────────────────────────────────────────────────────────

const absent = Option.getOrUndefined(Option.none())

function OpenPaletteOnMount() {
  const command = useCommand()
  createEffect(() => {
    command.openPalette()
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
  it.live("opens the theme submenu through keyboard navigation and activation", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <OpenPaletteOnMount />, {
          width: 90,
          height: 28,
        }),
      )
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

  it.live("wraps the cursor at both ends through the shared list", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <OpenPaletteOnMount />, { width: 90, height: 28 }),
      )
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Commands") && frame.includes("Branches"),
        "commands root",
      )
      // Up from the first row lands on the last: Branches, whose level shows
      // "Back" in the footer where the root shows "Close".
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("Esc Back"), "branches level")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => frame.includes("Esc Close"), "root again")
      // Down from the last row lands on the first: Theme.
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("System"), "theme level")
    }),
  )

  it.live("the palette Sessions item opens the agents pane and a row switches to it", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <OpenPaletteOnMount />
              <AgentsPaneWidget />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          { client: storedSessionsClient(), initialSession: rootSession, width: 90, height: 28 },
        ),
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
        (frame) => frame.includes("Agents ·") && frame.includes("Delegate"),
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
      yield* waitForFrame(setup, (frame) => !frame.includes("Agents ·"), "agents pane closed")
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

  it.live("/sessions opens the agents pane over stored sessions and marks side threads", () =>
    Effect.gen(function* () {
      let ext: Option.Option<ReturnType<typeof useExtensionUI>> = Option.none()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <AgentsPaneWidget />
              <ExtensionProbe onReady={(value) => (ext = Option.some(value))} />
            </>
          ),
          { client: storedSessionsClient(), initialSession: rootSession, width: 90, height: 28 },
        ),
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
      expect(executeSlashCommand("sessions", "", commands())).toEqual({ handled: true })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Agents ·") && frame.includes("Delegate"),
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
