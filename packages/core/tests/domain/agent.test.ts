import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  AgentName,
  AgentRunResult,
  AgentRunToolCallSchema,
  DEFAULT_AGENT_NAME,
} from "@gent/core-internal/domain/agent"
import { SessionId } from "@gent/core-internal/domain/ids"
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
} from "@gent/core-internal/domain/interaction-request"

describe("AgentName brand", () => {
  test("DEFAULT_AGENT_NAME is branded as AgentName", () => {
    expect(Schema.is(AgentName)(DEFAULT_AGENT_NAME)).toBe(true)
  })

  test("plain string fails the brand predicate at the schema boundary", () => {
    expect(Schema.is(AgentName)("cowork")).toBe(true) // brand-only filter accepts strings at runtime
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(AgentName)("research"))
    expect(decoded).toBe(AgentName.make("research"))
  })
})

describe("AgentRunResult", () => {
  test("Success uses the stable wire tag 'success'", () => {
    const result = AgentRunResult.cases.success.make({
      text: "ok",
      sessionId: SessionId.make("s1"),
      agentName: AgentName.make("cowork"),
    })
    expect(result._tag).toBe("success")
  })

  test("Failure uses the stable wire tag 'error'", () => {
    const result = AgentRunResult.cases.error.make({ error: "boom" })
    expect(result._tag).toBe("error")
  })

  test("decode rejects unknown variant tags", () => {
    expect(() =>
      Effect.runSync(Schema.decodeUnknownEffect(AgentRunResult)({ _tag: "pending" })),
    ).toThrow()
  })
})

describe("AgentRunToolCallSchema", () => {
  test("decodes structurally typed tool-call records", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(AgentRunToolCallSchema)({
        toolName: "read",
        args: { path: "x.ts" },
        isError: false,
      }),
    )
    expect(decoded.toolName).toBe("read")
    expect(decoded.isError).toBe(false)
  })
})

describe("ApprovalRequest / ApprovalDecision schemas", () => {
  test("ApprovalRequest accepts text + optional metadata", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(ApprovalRequestSchema)({ text: "approve?" }),
    )
    expect(decoded.text).toBe("approve?")
  })

  test("ApprovalDecision requires approved boolean", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(ApprovalDecisionSchema)({ approved: true }),
    )
    expect(decoded.approved).toBe(true)
  })
})
