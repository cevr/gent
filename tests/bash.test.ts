import { describe, test, expect } from "bun:test"
import { splitCdCommand, injectGitTrailers, stripBackground } from "@gent/core/tools/bash"

describe("splitCdCommand", () => {
  test("cd /foo && ls → { cwd: '/foo', command: 'ls' }", () => {
    const result = splitCdCommand("cd /foo && ls")
    expect(result).toEqual({ cwd: "/foo", command: "ls" })
  })

  test("cd with quoted path && cmd → quoted path", () => {
    const result = splitCdCommand('cd "/path with spaces" && ls -la')
    expect(result).toEqual({ cwd: "/path with spaces", command: "ls -la" })
  })

  test("cd /foo; ls → semicolon separator", () => {
    const result = splitCdCommand("cd /foo; ls")
    expect(result).toEqual({ cwd: "/foo", command: "ls" })
  })

  test("plain command → null", () => {
    expect(splitCdCommand("ls -la")).toBeNull()
  })
})

describe("injectGitTrailers", () => {
  test('git commit -m "msg" → injects --trailer', () => {
    const result = injectGitTrailers('git commit -m "fix bug"', "sess-123")
    expect(result).toContain('--trailer "Session-Id: sess-123"')
    expect(result).toContain("git commit")
  })

  test("git push → unchanged", () => {
    const cmd = "git push origin main"
    expect(injectGitTrailers(cmd, "sess-123")).toBe(cmd)
  })

  test("already has --trailer → unchanged", () => {
    const cmd = 'git commit --trailer "Foo: bar" -m "msg"'
    expect(injectGitTrailers(cmd, "sess-123")).toBe(cmd)
  })
})

describe("stripBackground", () => {
  test('"cmd &" → "cmd"', () => {
    expect(stripBackground("cmd &")).toBe("cmd")
  })

  test('"cmd  &  " → "cmd"', () => {
    expect(stripBackground("cmd  &  ")).toBe("cmd")
  })

  test('"cmd" → "cmd"', () => {
    expect(stripBackground("cmd")).toBe("cmd")
  })
})
