import { describe, test, expect } from "bun:test"
import { executeSlashCommand, parseSlashCommand, type SlashCommandContext } from "../src/commands/slash-commands"

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
  }

  const createMockContext = (): { ctx: SlashCommandContext; calls: MockCalls } => {
    const calls: MockCalls = {
      openPalette: 0,
      clearMessages: 0,
      navigateToSessions: 0,
      compactHistory: 0,
      createBranch: 0,
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
      compactHistory: async () => {
        calls.compactHistory++
      },
      createBranch: async () => {
        calls.createBranch++
      },
    }

    return { ctx, calls }
  }

  test("/model opens palette", async () => {
    const { ctx, calls } = createMockContext()
    const result = await executeSlashCommand("model", "", ctx)

    expect(result.handled).toBe(true)
    expect(result.error).toBeUndefined()
    expect(calls.openPalette).toBe(1)
  })

  test("/clear clears messages", async () => {
    const { ctx, calls } = createMockContext()
    const result = await executeSlashCommand("clear", "", ctx)

    expect(result.handled).toBe(true)
    expect(result.error).toBeUndefined()
    expect(calls.clearMessages).toBe(1)
  })

  test("/sessions navigates to sessions", async () => {
    const { ctx, calls } = createMockContext()
    const result = await executeSlashCommand("sessions", "", ctx)

    expect(result.handled).toBe(true)
    expect(result.error).toBeUndefined()
    expect(calls.navigateToSessions).toBe(1)
  })

  test("/compact calls compactHistory", async () => {
    const { ctx, calls } = createMockContext()
    const result = await executeSlashCommand("compact", "", ctx)

    expect(result.handled).toBe(true)
    expect(calls.compactHistory).toBe(1)
  })

  test("/branch calls createBranch", async () => {
    const { ctx, calls } = createMockContext()
    const result = await executeSlashCommand("branch", "", ctx)

    expect(result.handled).toBe(true)
    expect(calls.createBranch).toBe(1)
  })

  test("unknown command returns error", async () => {
    const { ctx } = createMockContext()
    const result = await executeSlashCommand("unknown", "", ctx)

    expect(result.handled).toBe(false)
    expect(result.error).toBe("Unknown command: /unknown")
  })

  test("case insensitive commands", async () => {
    const { ctx: ctx1, calls: calls1 } = createMockContext()
    await executeSlashCommand("MODEL", "", ctx1)
    expect(calls1.openPalette).toBe(1)

    const { ctx: ctx2, calls: calls2 } = createMockContext()
    await executeSlashCommand("Clear", "", ctx2)
    expect(calls2.clearMessages).toBe(1)
  })

  test("handles async errors gracefully", async () => {
    const ctx: SlashCommandContext = {
      openPalette: () => {},
      clearMessages: () => {},
      navigateToSessions: () => {},
      compactHistory: async () => {
        throw new Error("Compact failed")
      },
      createBranch: async () => {},
    }

    const result = await executeSlashCommand("compact", "", ctx)
    expect(result.handled).toBe(true)
    expect(result.error).toBe("Compact failed")
  })
})
