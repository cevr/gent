import { describe, expect, test } from "bun:test"
import {
  AgentName,
  AgentRunResult,
  getDurableAgentRunSessionId,
  makeRunSpec,
} from "@gent/core/domain/agent"
import { SessionId, ToolCallId } from "@gent/core/domain/ids"
import { ModelId } from "@gent/core/domain/model"

describe("makeRunSpec", () => {
  test("empty input produces empty spec — no spurious keys", () => {
    const spec = makeRunSpec()
    expect(Object.keys(spec)).toEqual([])
  })

  test("undefined fields are omitted, not stored", () => {
    const spec = makeRunSpec({
      persistence: undefined,
      overrides: undefined,
      tags: undefined,
      parentToolCallId: undefined,
    })
    expect(Object.keys(spec)).toEqual([])
    expect("persistence" in spec).toBe(false)
    expect("overrides" in spec).toBe(false)
    expect("tags" in spec).toBe(false)
    expect("parentToolCallId" in spec).toBe(false)
  })

  test("threads each provided field through", () => {
    const tcid = ToolCallId.make("tc-1")
    const spec = makeRunSpec({
      persistence: "ephemeral",
      overrides: {
        modelId: ModelId.make("custom/model"),
        allowedTools: ["bash"],
        deniedTools: ["read"],
        reasoningEffort: "high",
        systemPromptAddendum: "extra",
      },
      tags: ["auto-loop"],
      parentToolCallId: tcid,
    })
    expect(spec.persistence).toBe("ephemeral")
    expect(spec.overrides?.modelId).toBe(ModelId.make("custom/model"))
    expect(spec.overrides?.allowedTools).toEqual(["bash"])
    expect(spec.overrides?.deniedTools).toEqual(["read"])
    expect(spec.overrides?.reasoningEffort).toBe("high")
    expect(spec.overrides?.systemPromptAddendum).toBe("extra")
    expect(spec.tags).toEqual(["auto-loop"])
    expect(spec.parentToolCallId).toBe(tcid)
  })

  test("partial input — only persistence", () => {
    const spec = makeRunSpec({ persistence: "durable" })
    expect(Object.keys(spec)).toEqual(["persistence"])
    expect(spec.persistence).toBe("durable")
  })

  test("partial input — only tags", () => {
    const spec = makeRunSpec({ tags: ["a", "b"] })
    expect(Object.keys(spec)).toEqual(["tags"])
    expect(spec.tags).toEqual(["a", "b"])
  })
})

describe("getDurableAgentRunSessionId", () => {
  const sid = SessionId.make("session-1")
  const agentName = AgentName.make("cowork")

  test("Success + durable explicit returns sessionId", () => {
    const result = AgentRunResult.Success.make({
      text: "ok",
      sessionId: sid,
      agentName,
      persistence: "durable",
    })
    expect(getDurableAgentRunSessionId(result)).toBe(sid)
  })

  test("Success + persistence undefined defaults to durable, returns sessionId", () => {
    const result = AgentRunResult.Success.make({
      text: "ok",
      sessionId: sid,
      agentName,
    })
    expect(getDurableAgentRunSessionId(result)).toBe(sid)
  })

  test("Success + ephemeral returns undefined (do not surface ephemeral child to parent)", () => {
    const result = AgentRunResult.Success.make({
      text: "ok",
      sessionId: sid,
      agentName,
      persistence: "ephemeral",
    })
    expect(getDurableAgentRunSessionId(result)).toBeUndefined()
  })

  test("Failure with durable + sessionId returns it", () => {
    const result = AgentRunResult.Failure.make({
      error: "boom",
      sessionId: sid,
      agentName,
      persistence: "durable",
    })
    expect(getDurableAgentRunSessionId(result)).toBe(sid)
  })

  test("Failure without sessionId returns undefined", () => {
    const result = AgentRunResult.Failure.make({
      error: "boom",
    })
    expect(getDurableAgentRunSessionId(result)).toBeUndefined()
  })

  test("Failure ephemeral with sessionId returns undefined", () => {
    const result = AgentRunResult.Failure.make({
      error: "boom",
      sessionId: sid,
      persistence: "ephemeral",
    })
    expect(getDurableAgentRunSessionId(result)).toBeUndefined()
  })
})
