import { describe, test, expect } from "effect-bun-test"
import { Option } from "effect"
import {
  classifyBashCommand,
  splitCdCommand,
  injectGitTrailers,
  stripBackground,
} from "../../src/exec-tools.js"

import { SessionId } from "@gent/core-internal/domain/ids"

describe("splitCdCommand", () => {
  test("cd /foo && ls → { cwd: '/foo', command: 'ls' }", () => {
    const result = splitCdCommand("cd /foo && ls")
    expect(result).toEqual(Option.some({ cwd: "/foo", command: "ls" }))
  })

  test("cd with quoted path && cmd → quoted path", () => {
    const result = splitCdCommand('cd "/path with spaces" && ls -la')
    expect(result).toEqual(Option.some({ cwd: "/path with spaces", command: "ls -la" }))
  })

  test("cd /foo; ls → semicolon separator", () => {
    const result = splitCdCommand("cd /foo; ls")
    expect(result).toEqual(Option.some({ cwd: "/foo", command: "ls" }))
  })

  test("plain command → None", () => {
    expect(Option.isNone(splitCdCommand("ls -la"))).toBe(true)
  })
})

describe("injectGitTrailers", () => {
  test('git commit -m "msg" → injects --trailer', () => {
    const result = injectGitTrailers('git commit -m "fix bug"', SessionId.make("sess-123"))
    expect(result).toContain('--trailer "Session-Id: sess-123"')
    expect(result).toContain("git commit")
  })

  test("git push → unchanged", () => {
    const cmd = "git push origin main"
    expect(injectGitTrailers(cmd, SessionId.make("sess-123"))).toBe(cmd)
  })

  test("already has --trailer → unchanged", () => {
    const cmd = 'git commit --trailer "Foo: bar" -m "msg"'
    expect(injectGitTrailers(cmd, SessionId.make("sess-123"))).toBe(cmd)
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

describe("classifyBashCommand", () => {
  test("a read-only command that names a secret file stays safe", () => {
    expect(classifyBashCommand("cat ~/.aws/credentials").level).toBe("safe")
    expect(classifyBashCommand("grep -n KEY .env").level).toBe("safe")
  })

  test("a write to a secret file is sensitive", () => {
    expect(classifyBashCommand("cp ~/.aws/credentials /tmp/x").level).toBe("sensitive")
  })

  test("a read-only prefix does not exempt a later segment that writes a secret", () => {
    for (const command of [
      "cat README.md; cp ~/.aws/credentials /tmp/x",
      "ls && cp ~/.aws/credentials /tmp/x",
      "ls || mv .env /tmp/x",
      "ls | xargs -I{} cp {} ~/.ssh/id_rsa",
      "cat README.md\ncp ~/.aws/credentials /tmp/x",
      "cat $(cp ~/.aws/credentials /tmp/x)",
      "cat `cp ~/.aws/credentials /tmp/x`",
      "cat <<EOF | sh\ncp ~/.aws/credentials /tmp/x\nEOF",
    ]) {
      expect(classifyBashCommand(command).level, command).toBe("sensitive")
    }
  })

  test("a compound command of read-only segments stays safe", () => {
    expect(classifyBashCommand("cat .env | grep KEY && ls -la secrets").level).toBe("safe")
  })

  test("destructive and external patterns win over the read-only exemption", () => {
    expect(classifyBashCommand("cat x; rm -rf /").level).toBe("destructive")
    expect(classifyBashCommand("ls && git push").level).toBe("external")
  })
})
