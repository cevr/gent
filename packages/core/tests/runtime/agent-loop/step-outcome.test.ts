import { describe, expect, test } from "bun:test"
import type * as Response from "effect/unstable/ai/Response"
import { finishPart, textDeltaPart, toolCallPart } from "../../../src/test-utils/language-model"
import { classifyStep } from "../../../src/runtime/agent/agent-loop.turn-execution"
import type { CollectedTurnResponse } from "../../../src/runtime/agent/turn-response"

const collected = (
  responseParts: ReadonlyArray<Response.AnyPart>,
  flags: Partial<Pick<CollectedTurnResponse, "interrupted" | "streamFailed" | "driverKind">> = {},
): CollectedTurnResponse => ({
  responseParts,
  messageProjection: { assistant: [], tool: [] },
  interrupted: false,
  streamFailed: false,
  driverKind: "model",
  ...flags,
})

describe("classifyStep", () => {
  test("an interrupt wins over everything else the step produced", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("partial"), toolCallPart("echo", {})], { interrupted: true }),
    )
    expect(outcome._tag).toBe("Interrupted")
  })

  test("a failed stream records whether observable output arrived first", () => {
    expect(classifyStep(collected([], { streamFailed: true }))).toEqual({
      _tag: "Failed",
      partialOutput: false,
    })
    expect(classifyStep(collected([textDeltaPart("some")], { streamFailed: true }))).toEqual({
      _tag: "Failed",
      partialOutput: true,
    })
  })

  test("an external driver step is External even when it carries tool calls", () => {
    const outcome = classifyStep(collected([toolCallPart("echo", {})], { driverKind: "external" }))
    expect(outcome._tag).toBe("External")
  })

  test("tool calls are counted", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("thinking"), toolCallPart("a", {}), toolCallPart("b", {})]),
    )
    expect(outcome).toEqual({ _tag: "ToolCalls", count: 2 })
  })

  test("a plain reply is Answered with neither flag", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("done"), finishPart({ finishReason: "stop" })]),
    )
    expect(outcome).toEqual({ _tag: "Answered", empty: false, truncated: false })
  })

  test("no observable output is an empty answer", () => {
    const outcome = classifyStep(collected([finishPart({ finishReason: "stop" })]))
    expect(outcome).toEqual({ _tag: "Answered", empty: true, truncated: false })
  })

  test("a length finish marks the answer truncated", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("cut off"), finishPart({ finishReason: "length" })]),
    )
    expect(outcome).toEqual({ _tag: "Answered", empty: false, truncated: true })
  })
})
