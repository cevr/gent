/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import {
  type Command,
  CommandPalette,
  executeSlashCommand,
  parseSlashCommand,
  useCommand,
} from "../src/commands"
import { createEffect, onMount } from "solid-js"
import { resolveCommands } from "../src/extensions/loader-boundary"
import { Effect, Option, Predicate } from "effect"
import { BranchId, dateFromMillis, SessionId } from "@gent/core/protocol"
import { type ClientContextValue, useClient } from "../src/client"
import { createMockClient, renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"

// ── slash-commands.test ─────────────────────────────────────────────────────

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
        id: "@gent/acp-agents",
        scope: "builtin",
        source: "server:@gent/acp-agents",
        commands: [cmd({ id: "server:model", slash: "model" })],
      },
    ])
    expect(commands.map((command) => command.id)).toEqual(["session.model"])
    expect(failures.map((failure) => failure.id)).toEqual(["@gent/acp-agents"])
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

// ── components/command-palette.test ─────────────────────────────────────────

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
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Commands") && frame.includes("Branches"),
          "commands root",
        ),
      )
      // Up from the first row lands on the last: Branches, whose level shows
      // "Back" in the footer where the root shows "Close".
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Esc Back"), "branches level"),
      )
      setup.mockInput.pressEscape()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Esc Close"), "root again"),
      )
      // Down from the last row lands on the first: Sessions.
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("+ New Session"), "sessions level"),
      )
    }),
  )

  it.live("switches sessions through the sessions palette", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const alphaSessionId = SessionId.make("session-alpha")
      const alphaBranchId = BranchId.make("branch-alpha")
      const betaSessionId = SessionId.make("session-beta")
      const betaBranchId = BranchId.make("branch-beta")
      const client = createMockClient({
        session: {
          list: () =>
            Effect.succeed([
              {
                id: alphaSessionId,
                activeBranchId: alphaBranchId,
                name: "Alpha",
                createdAt: dateFromMillis(0),
                updatedAt: dateFromMillis(1),
              },
              {
                id: betaSessionId,
                activeBranchId: betaBranchId,
                name: "Beta",
                createdAt: dateFromMillis(1),
                updatedAt: dateFromMillis(2),
              },
            ]),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <OpenPaletteOnMount />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            initialSession: {
              id: alphaSessionId,
              activeBranchId: alphaBranchId,
              name: "Alpha",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(1),
            },
            width: 90,
            height: 28,
          },
        ),
      )
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Commands") && frame.includes("Sessions"),
          "commands root",
        ),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Sessions") && frame.includes("Beta"),
          "sessions level",
        ),
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => !frame.includes("Sessions"),
          "sessions palette closed",
        ),
      )
      expect(ctx.value.session()).toEqual({
        sessionId: betaSessionId,
        branchId: betaBranchId,
        name: "Beta",
        modelId: absent,
        reasoningLevel: absent,
      })
    }),
  )

  it.live("marks a spawned session so side work is visible before opening it", () =>
    Effect.gen(function* () {
      const rootId = SessionId.make("session-root")
      const rootBranchId = BranchId.make("branch-root")
      const handoffId = SessionId.make("session-handoff")
      const spawnId = SessionId.make("session-spawn")
      // The three shapes the picker has to tell apart: a root, the handoff that
      // continues its thread, and a delegate run that opened a thread of its own.
      const client = createMockClient({
        session: {
          list: () =>
            Effect.succeed([
              {
                id: rootId,
                activeBranchId: rootBranchId,
                threadId: rootId,
                name: "Root",
                createdAt: dateFromMillis(0),
                updatedAt: dateFromMillis(3),
              },
              {
                id: handoffId,
                activeBranchId: BranchId.make("branch-handoff"),
                parentSessionId: rootId,
                threadId: rootId,
                name: "Handoff",
                createdAt: dateFromMillis(1),
                updatedAt: dateFromMillis(2),
              },
              {
                id: spawnId,
                activeBranchId: BranchId.make("branch-spawn"),
                parentSessionId: rootId,
                threadId: spawnId,
                name: "Delegate",
                createdAt: dateFromMillis(2),
                updatedAt: dateFromMillis(1),
              },
            ]),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <OpenPaletteOnMount />, {
          client,
          initialSession: {
            id: rootId,
            activeBranchId: rootBranchId,
            name: "Root",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(3),
          },
          width: 90,
          height: 28,
        }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Commands") && frame.includes("Sessions"),
          "commands root",
        ),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Delegate") && frame.includes("Handoff"),
          "sessions level",
        ),
      )
      const frame = renderFrame(setup)
      // The marker rides the row, so the reader sees it without opening anything.
      const delegateRow = frame.split("\n").find((line) => line.includes("Delegate"))
      const handoffRow = frame.split("\n").find((line) => line.includes("Handoff"))
      expect(delegateRow).toContain("side thread")
      expect(handoffRow).not.toContain("side thread")
    }),
  )

  it.live("creates palette sessions with workspace cwd", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const createdSessionId = SessionId.make("session-created")
      const createdBranchId = BranchId.make("branch-created")
      const createInputs: Array<{
        cwd?: string
        requestId?: string
      }> = []
      const workspaceCwd = process.cwd()
      const client = createMockClient({
        session: {
          create: (input: { cwd?: string; requestId?: string }) =>
            Effect.sync(() => {
              createInputs.push(input)
              return {
                sessionId: createdSessionId,
                branchId: createdBranchId,
                name: "Created",
              }
            }),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <OpenPaletteOnMount />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            cwd: workspaceCwd,
            width: 90,
            height: 28,
          },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Commands") && frame.includes("Sessions"),
          "commands root",
        ),
      )
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Sessions") && frame.includes("+ New Session"),
          "sessions level",
        ),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => !frame.includes("Sessions"),
          "palette closed after create",
        ),
      )
      expect(createInputs).toHaveLength(1)
      const firstInput = Option.fromNullishOr(createInputs[0])
      if (Option.isNone(firstInput)) return yield* Effect.die("session create was not called")
      expect(firstInput.value.cwd).toBe(workspaceCwd)
      expect(Predicate.isString(firstInput.value.requestId)).toBe(true)
      // The created session becomes the active one; the shell mounts what the
      // client says, so there is no second place a navigation could go wrong.
      expect(ctx.value.session()).toEqual({
        sessionId: createdSessionId,
        branchId: createdBranchId,
        name: "Created",
        modelId: absent,
        reasoningLevel: absent,
      })
    }),
  )
})
