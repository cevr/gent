/**
 * RunSpec threading tests.
 *
 * Verifies the run-spec JSON contract used by the headless CLI.
 *
 * Public message.send runSpec behavior is covered by
 * tests/server/message-send.test.ts.
 */

import { describe, test, expect } from "bun:test"
import { Predicate, Schema } from "effect"
import { ToolCallId } from "@gent/core-internal/domain/ids"
import { ModelId } from "@gent/core-internal/domain/model"
import { RunSpecSchema } from "@gent/core-internal/domain/agent"

// ── Tests ──

describe("run spec CLI serialization", () => {
  const codec = Schema.fromJsonString(RunSpecSchema)

  test("round-trips through JSON encode/decode", () => {
    const runSpec = {
      persistence: "ephemeral",
      overrides: {
        modelId: ModelId.make("anthropic/claude-sonnet-4-6"),
        allowedTools: ["grep", "glob", "read"],
        deniedTools: ["bash"],
        reasoningEffort: "high",
        systemPromptAddendum: "Be concise.",
      },
      tags: ["subprocess-test"],
      parentToolCallId: ToolCallId.make("tc-abc-123"),
    } satisfies Schema.Schema.Type<typeof RunSpecSchema>

    const json = Schema.encodeSync(codec)(runSpec)
    expect(Predicate.isString(json)).toBe(true)

    const decoded = Schema.decodeSync(codec)(json)
    expect(decoded).toEqual(runSpec)
  })

  test("round-trips with minimal runSpec", () => {
    const runSpec = { parentToolCallId: ToolCallId.make("tc-only") }
    const json = Schema.encodeSync(codec)(runSpec)
    const decoded = Schema.decodeSync(codec)(json)
    expect(decoded.parentToolCallId).toBe(ToolCallId.make("tc-only"))
  })

  test("round-trips empty runSpec", () => {
    const runSpec = {}
    const json = Schema.encodeSync(codec)(runSpec)
    const decoded = Schema.decodeSync(codec)(json)
    expect(decoded).toEqual({})
  })
})
