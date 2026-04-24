import { describe, expect, test } from "bun:test"
import {
  AgentSwitched,
  ErrorOccurred,
  MessageReceived,
  StreamEnded,
  StreamStarted,
  TurnCompleted,
} from "@gent/core/domain/event"
import { Message } from "@gent/core/domain/message"
import { reduceAgentLifecycle } from "../src/client/agent-lifecycle"

const makeMessage = (role: "user" | "assistant") =>
  Message.cases.regular.make({
    id: "m1",
    sessionId: "s1",
    branchId: "b1",
    role,
    parts: [],
    createdAt: new Date(0),
  })

describe("reduceAgentLifecycle", () => {
  test("marks a turn as streaming when the stream starts", () => {
    const event = StreamStarted.make({ sessionId: "s1", branchId: "b1" })

    expect(reduceAgentLifecycle(event)).toEqual({
      status: { _tag: "streaming" },
    })
  })

  test("keeps streaming until TurnCompleted", () => {
    const streamEnded = StreamEnded.make({ sessionId: "s1", branchId: "b1" })
    const assistantMessage = MessageReceived.make({
      message: makeMessage("assistant"),
    })
    const turnCompleted = TurnCompleted.make({
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
    const userMessage = MessageReceived.make({
      message: makeMessage("user"),
    })

    expect(reduceAgentLifecycle(userMessage)).toEqual({
      status: { _tag: "streaming" },
    })
  })

  test("surfaces agent switches and errors", () => {
    const switched = AgentSwitched.make({
      sessionId: "s1",
      branchId: "b1",
      fromAgent: "cowork",
      toAgent: "deepwork",
    })
    const errored = ErrorOccurred.make({
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
