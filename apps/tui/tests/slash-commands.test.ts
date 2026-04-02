import { describe, it, expect, test } from "effect-bun-test"
import {
  executeSlashCommand,
  parseSlashCommand,
  type SlashCommandContext,
  type ExtensionSlashCommand,
} from "../src/commands/slash-commands"
import { Effect } from "effect"
import { ClientError } from "../src/utils/format-error"

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

describe("executeSlashCommand", () => {
  interface MockCalls {
    openPalette: number
    clearMessages: number
    newSession: number
    navigateToSessions: number
    createBranch: number
    openTree: number
    openFork: number
    openPermissions: number
    openAuth: number
  }

  const createMockContext = (): { ctx: SlashCommandContext; calls: MockCalls } => {
    const calls: MockCalls = {
      openPalette: 0,
      clearMessages: 0,
      newSession: 0,
      navigateToSessions: 0,
      createBranch: 0,
      openTree: 0,
      openFork: 0,
      openPermissions: 0,
      openAuth: 0,
    }

    const ctx: SlashCommandContext = {
      openPalette: () => {
        calls.openPalette++
      },
      clearMessages: () => {
        calls.clearMessages++
      },
      navigateToSessions: () => {
        calls.navigateToSessions++
      },
      createBranch: Effect.sync(() => {
        calls.createBranch++
      }),
      openTree: () => {
        calls.openTree++
      },
      openFork: () => {
        calls.openFork++
      },
      setReasoningLevel: () => Effect.void,
      openPermissions: () => {
        calls.openPermissions++
      },
      openAuth: () => {
        calls.openAuth++
      },
      newSession: () =>
        Effect.sync(() => {
          calls.newSession++
        }),
    }

    return { ctx, calls }
  }

  it.live("/clear starts a new session", () => {
    const { ctx, calls } = createMockContext()
    return executeSlashCommand("clear", "", ctx).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(result.error).toBeUndefined()
        expect(calls.newSession).toBe(1)
      }),
    )
  })

  it.live("/new starts a new session", () => {
    const { ctx, calls } = createMockContext()
    return executeSlashCommand("new", "", ctx).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(result.error).toBeUndefined()
        expect(calls.newSession).toBe(1)
      }),
    )
  })

  it.live("/sessions navigates to sessions", () => {
    const { ctx, calls } = createMockContext()
    return executeSlashCommand("sessions", "", ctx).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(result.error).toBeUndefined()
        expect(calls.navigateToSessions).toBe(1)
      }),
    )
  })

  it.live("/branch calls createBranch", () => {
    const { ctx, calls } = createMockContext()
    return executeSlashCommand("branch", "", ctx).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(calls.createBranch).toBe(1)
      }),
    )
  })

  it.live("/tree opens branch tree", () => {
    const { ctx, calls } = createMockContext()
    return executeSlashCommand("tree", "", ctx).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(calls.openTree).toBe(1)
      }),
    )
  })

  it.live("/fork opens fork picker", () => {
    const { ctx, calls } = createMockContext()
    return executeSlashCommand("fork", "", ctx).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(calls.openFork).toBe(1)
      }),
    )
  })

  it.live("unknown command returns error", () => {
    const { ctx } = createMockContext()
    return executeSlashCommand("unknown", "", ctx).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(false)
        expect(result.error).toBe("Unknown command: /unknown")
      }),
    )
  })

  it.live("case insensitive commands", () => {
    const { ctx: ctx1, calls: calls1 } = createMockContext()
    const { ctx: ctx2, calls: calls2 } = createMockContext()
    return Effect.gen(function* () {
      yield* executeSlashCommand("NEW", "", ctx1)
      expect(calls1.newSession).toBe(1)

      yield* executeSlashCommand("Clear", "", ctx2)
      expect(calls2.newSession).toBe(1)
    })
  })

  it.live("handles async errors gracefully", () => {
    const ctx: SlashCommandContext = {
      openPalette: () => {},
      clearMessages: () => {},
      navigateToSessions: () => {},
      createBranch: Effect.fail(ClientError("Branch failed")),
      openTree: () => {},
      openFork: () => {},
      setReasoningLevel: () => Effect.void,
      openPermissions: () => {},
      openAuth: () => {},
      newSession: () => Effect.void,
    }

    return executeSlashCommand("branch", "", ctx).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(result.error).toBe("Branch failed")
      }),
    )
  })

  it.live("extension slash command is executed", () => {
    const { ctx } = createMockContext()
    let called = false
    const extCommands: ExtensionSlashCommand[] = [
      {
        slash: "myext",
        onSelect: () => {
          called = true
        },
      },
    ]

    return executeSlashCommand("myext", "", ctx, extCommands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(called).toBe(true)
      }),
    )
  })

  it.live("extension slash command receives args via onSlash", () => {
    const { ctx } = createMockContext()
    let receivedArgs = ""
    const extCommands: ExtensionSlashCommand[] = [
      {
        slash: "myext",
        onSelect: () => {},
        onSlash: (args) => {
          receivedArgs = args
        },
      },
    ]

    return executeSlashCommand("myext", "some args here", ctx, extCommands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(receivedArgs).toBe("some args here")
      }),
    )
  })

  it.live("extension slash command falls back to onSelect when no onSlash", () => {
    const { ctx } = createMockContext()
    let selectCalled = false
    const extCommands: ExtensionSlashCommand[] = [
      {
        slash: "myext",
        onSelect: () => {
          selectCalled = true
        },
      },
    ]

    return executeSlashCommand("myext", "ignored args", ctx, extCommands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(selectCalled).toBe(true)
      }),
    )
  })

  it.live("builtin commands take precedence over extension commands", () => {
    const { ctx, calls } = createMockContext()
    let extCalled = false
    const extCommands: ExtensionSlashCommand[] = [
      {
        slash: "clear",
        onSelect: () => {
          extCalled = true
        },
      },
    ]

    return executeSlashCommand("clear", "", ctx, extCommands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(calls.newSession).toBe(1)
        expect(extCalled).toBe(false)
      }),
    )
  })

  it.live("extension slash commands are case insensitive", () => {
    const { ctx } = createMockContext()
    let called = false
    const extCommands: ExtensionSlashCommand[] = [
      {
        slash: "MyExt",
        onSelect: () => {
          called = true
        },
      },
    ]

    return executeSlashCommand("myext", "", ctx, extCommands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(called).toBe(true)
      }),
    )
  })

  it.live("unknown command with no matching extension returns error", () => {
    const { ctx } = createMockContext()
    const extCommands: ExtensionSlashCommand[] = [{ slash: "other", onSelect: () => {} }]

    return executeSlashCommand("unknown", "", ctx, extCommands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(false)
        expect(result.error).toBe("Unknown command: /unknown")
      }),
    )
  })
})
