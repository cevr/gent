/**
 * RunSpec threading tests.
 *
 * Verifies the CLI serialization round-trip used by SubprocessRunner.
 *
 * Public message.send runSpec behavior is covered by
 * tests/server/session-commands.test.ts.
 */

import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { ToolCallId } from "@gent/core/domain/ids"
import { RunSpecSchema } from "@gent/core/domain/agent"

// ── Tests ──

describe("RunSpec CLI serialization", () => {
  const codec = Schema.fromJsonString(RunSpecSchema)

  test("round-trips through JSON encode/decode", () => {
    const runSpec = {
      persistence: "ephemeral" as const,
      overrides: {
        modelId: "anthropic/claude-sonnet-4-6",
        allowedTools: ["grep", "glob", "read"],
        deniedTools: ["bash"],
        reasoningEffort: "high" as const,
        systemPromptAddendum: "Be concise.",
      },
      tags: ["subprocess-test"],
      parentToolCallId: ToolCallId.make("tc-abc-123"),
    }

    const json = Schema.encodeSync(codec)(runSpec)
    expect(typeof json).toBe("string")

    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded).toEqual(runSpec)
  })

  test("round-trips with minimal runSpec", () => {
    const runSpec = { parentToolCallId: ToolCallId.make("tc-only") }
    const json = Schema.encodeSync(codec)(runSpec)
    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded.parentToolCallId).toBe("tc-only")
  })

  test("round-trips empty runSpec", () => {
    const runSpec = {}
    const json = Schema.encodeSync(codec)(runSpec)
    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded).toEqual({})
  })
})
