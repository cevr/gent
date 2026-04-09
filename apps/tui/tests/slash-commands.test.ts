import { describe, it, expect, test } from "effect-bun-test"
import { executeSlashCommand, parseSlashCommand } from "../src/commands/slash-commands"
import { Effect } from "effect"
import type { Command } from "../src/command/types"

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
  it.live("executes matching command", () => {
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
    return executeSlashCommand("new", "", commands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(called).toBe(true)
      }),
    )
  })

  it.live("unknown command returns error", () =>
    executeSlashCommand("unknown", "", []).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(false)
        expect(result.error).toBe("Unknown command: /unknown")
      }),
    ),
  )

  it.live("case insensitive matching", () => {
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
    return executeSlashCommand("NEW", "", commands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(called).toBe(true)
      }),
    )
  })

  it.live("prefers onSlash over onSelect when args present", () => {
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
    return executeSlashCommand("think", "high", commands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(receivedArgs).toBe("high")
      }),
    )
  })

  it.live("falls back to onSelect when no onSlash", () => {
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
    return executeSlashCommand("ext", "ignored", commands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(selectCalled).toBe(true)
      }),
    )
  })

  it.live("lower priority wins", () => {
    let winner = ""
    const commands = [
      cmd({
        id: "a",
        slash: "test",
        slashPriority: 10,
        onSelect: () => {
          winner = "a"
        },
      }),
      cmd({
        id: "b",
        slash: "test",
        slashPriority: 0,
        onSelect: () => {
          winner = "b"
        },
      }),
    ]
    return executeSlashCommand("test", "", commands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(winner).toBe("b")
      }),
    )
  })

  it.live("aliases resolve to the command", () => {
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
    return executeSlashCommand("clear", "", commands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(called).toBe(true)
      }),
    )
  })

  it.live("alias matching is case insensitive", () => {
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
    return executeSlashCommand("CLEAR", "", commands).pipe(
      Effect.map((result) => {
        expect(result.handled).toBe(true)
        expect(called).toBe(true)
      }),
    )
  })
})
