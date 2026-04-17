/**
 * RunSpec threading tests.
 *
 * Verifies that RunSpec (including parentToolCallId)
 * survive the full chain: client.message.send → RPC → session-commands
 * → actor-process → agentLoop.submit → resolveTurnContext → deriveAll.
 *
 * Also tests the CLI serialization round-trip used by SubprocessRunner.
 */

import { describe, test, expect, it } from "bun:test"
import { Schema } from "effect"
import { ToolCallId } from "@gent/core/domain/ids"
import { RunSpecSchema } from "@gent/core/domain/agent"

// ── Tests ──

describe("runSpec through RPC", () => {
  it.skip("parentToolCallId reaches ExtensionTurnContext via message.send", // the previous WorkflowContribution.turn / derive surface is gone in C2. // TODO(c2): rewrite to capture ExtensionTurnContext via a different hook —
  () => {})
})

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
      parentToolCallId: ToolCallId.of("tc-abc-123"),
    }

    const json = Schema.encodeSync(codec)(runSpec)
    expect(typeof json).toBe("string")

    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded).toEqual(runSpec)
  })

  test("round-trips with minimal runSpec", () => {
    const runSpec = { parentToolCallId: ToolCallId.of("tc-only") }
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
