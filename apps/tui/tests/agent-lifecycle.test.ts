import { describe, expect, test } from "bun:test"
import {
  AgentSwitched,
  ErrorOccurred,
  MessageReceived,
  StreamEnded,
  StreamStarted,
  TurnCompleted,
} from "@gent/core/domain/event"
import { reduceAgentLifecycle } from "../src/client/agent-lifecycle"

describe("reduceAgentLifecycle", () => {
  test("marks a turn as streaming when the stream starts", () => {
    const event = new StreamStarted({ sessionId: "s1", branchId: "b1" })

    expect(reduceAgentLifecycle(event)).toEqual({
      status: { _tag: "streaming" },
    })
  })

  test("keeps streaming until TurnCompleted", () => {
    const streamEnded = new StreamEnded({ sessionId: "s1", branchId: "b1" })
    const assistantMessage = new MessageReceived({
      sessionId: "s1",
      branchId: "b1",
      messageId: "m1",
      role: "assistant",
    })
    const turnCompleted = new TurnCompleted({
      sessionId: "s1",
      branchId: "b1",
      durationMs: 42,
    })

    expect(reduceAgentLifecycle(streamEnded)).toEqual({})
    expect(reduceAgentLifecycle(assistantMessage)).toEqual({})
    expect(reduceAgentLifecycle(turnCompleted)).toEqual({
      status: { _tag: "idle" },
    })
  })

  test("uses user messages to enter streaming immediately", () => {
    const userMessage = new MessageReceived({
      sessionId: "s1",
      branchId: "b1",
      messageId: "m1",
      role: "user",
    })

    expect(reduceAgentLifecycle(userMessage)).toEqual({
      status: { _tag: "streaming" },
    })
  })

  test("surfaces agent switches and errors", () => {
    const switched = new AgentSwitched({
      sessionId: "s1",
      branchId: "b1",
      fromAgent: "cowork",
      toAgent: "deepwork",
    })
    const errored = new ErrorOccurred({
      sessionId: "s1",
      branchId: "b1",
      error: "boom",
    })

    expect(reduceAgentLifecycle(switched)).toEqual({
      preferredAgent: "deepwork",
    })
    expect(reduceAgentLifecycle(errored)).toEqual({
      status: { _tag: "error", error: "boom" },
    })
  })
})
