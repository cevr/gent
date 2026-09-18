import { describe, expect, test } from "effect-bun-test"
import { type Command, executeSlashCommand, parseSlashCommand } from "../src/commands"

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

  test("lower priority wins", () => {
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
    const result = executeSlashCommand("test", "", commands)
    expect(result.handled).toBe(true)
    expect(winner).toBe("b")
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
