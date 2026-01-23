import { describe, test, expect } from "bun:test"
import { executeSlashCommand, parseSlashCommand, type SlashCommandContext } from "../src/commands/slash-commands"
import { Effect } from "effect"
import { ClientError } from "../src/utils/format-error"

describe("parseSlashCommand", () => {
  test("parses simple command", () => {
    expect(parseSlashCommand("/model")).toEqual(["model", ""])
  })

  test("parses command with args", () => {
    expect(parseSlashCommand("/model opus")).toEqual(["model", "opus"])
  })

  test("parses command with multiple args", () => {
    expect(parseSlashCommand("/branch feature-branch")).toEqual(["branch", "feature-branch"])
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
    navigateToSessions: number
    compactHistory: number
    createBranch: number
    openTree: number
    openFork: number
    toggleBypass: number
    openPermissions: number
    openAuth: number
  }

  const createMockContext = (): { ctx: SlashCommandContext; calls: MockCalls } => {
    const calls: MockCalls = {
      openPalette: 0,
      clearMessages: 0,
      navigateToSessions: 0,
      compactHistory: 0,
      createBranch: 0,
      openTree: 0,
      openFork: 0,
      toggleBypass: 0,
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
      compactHistory: Effect.sync(() => {
        calls.compactHistory++
      }),
      createBranch: Effect.sync(() => {
        calls.createBranch++
      }),
      openTree: () => {
        calls.openTree++
      },
      openFork: () => {
        calls.openFork++
      },
      toggleBypass: Effect.sync(() => {
        calls.toggleBypass++
      }),
      openPermissions: () => {
        calls.openPermissions++
      },
      openAuth: () => {
        calls.openAuth++
      },
    }

    return { ctx, calls }
  }

  test("/model opens palette", async () => {
    const { ctx, calls } = createMockContext()
    const result = await Effect.runPromise(executeSlashCommand("model", "", ctx))

    expect(result.handled).toBe(true)
    expect(result.error).toBeUndefined()
    expect(calls.openPalette).toBe(1)
  })

  test("/clear clears messages", async () => {
    const { ctx, calls } = createMockContext()
    const result = await Effect.runPromise(executeSlashCommand("clear", "", ctx))

    expect(result.handled).toBe(true)
    expect(result.error).toBeUndefined()
    expect(calls.clearMessages).toBe(1)
  })

  test("/sessions navigates to sessions", async () => {
    const { ctx, calls } = createMockContext()
    const result = await Effect.runPromise(executeSlashCommand("sessions", "", ctx))

    expect(result.handled).toBe(true)
    expect(result.error).toBeUndefined()
    expect(calls.navigateToSessions).toBe(1)
  })

  test("/compact calls compactHistory", async () => {
    const { ctx, calls } = createMockContext()
    const result = await Effect.runPromise(executeSlashCommand("compact", "", ctx))

    expect(result.handled).toBe(true)
    expect(calls.compactHistory).toBe(1)
  })

  test("/branch calls createBranch", async () => {
    const { ctx, calls } = createMockContext()
    const result = await Effect.runPromise(executeSlashCommand("branch", "", ctx))

    expect(result.handled).toBe(true)
    expect(calls.createBranch).toBe(1)
  })

  test("/tree opens branch tree", async () => {
    const { ctx, calls } = createMockContext()
    const result = await Effect.runPromise(executeSlashCommand("tree", "", ctx))

    expect(result.handled).toBe(true)
    expect(calls.openTree).toBe(1)
  })

  test("/fork opens fork picker", async () => {
    const { ctx, calls } = createMockContext()
    const result = await Effect.runPromise(executeSlashCommand("fork", "", ctx))

    expect(result.handled).toBe(true)
    expect(calls.openFork).toBe(1)
  })

  test("/bypass toggles bypass", async () => {
    const { ctx, calls } = createMockContext()
    const result = await Effect.runPromise(executeSlashCommand("bypass", "", ctx))

    expect(result.handled).toBe(true)
    expect(calls.toggleBypass).toBe(1)
  })

  test("unknown command returns error", async () => {
    const { ctx } = createMockContext()
    const result = await Effect.runPromise(executeSlashCommand("unknown", "", ctx))

    expect(result.handled).toBe(false)
    expect(result.error).toBe("Unknown command: /unknown")
  })

  test("case insensitive commands", async () => {
    const { ctx: ctx1, calls: calls1 } = createMockContext()
    await Effect.runPromise(executeSlashCommand("MODEL", "", ctx1))
    expect(calls1.openPalette).toBe(1)

    const { ctx: ctx2, calls: calls2 } = createMockContext()
    await Effect.runPromise(executeSlashCommand("Clear", "", ctx2))
    expect(calls2.clearMessages).toBe(1)
  })

  test("handles async errors gracefully", async () => {
    const ctx: SlashCommandContext = {
      openPalette: () => {},
      clearMessages: () => {},
      navigateToSessions: () => {},
      compactHistory: Effect.fail(ClientError("Compact failed")),
      createBranch: Effect.void,
      openTree: () => {},
      openFork: () => {},
      toggleBypass: Effect.void,
      openPermissions: () => {},
      openAuth: () => {},
    }

    const result = await Effect.runPromise(executeSlashCommand("compact", "", ctx))
    expect(result.handled).toBe(true)
    expect(result.error).toBe("Compact failed")
  })
})
