import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  AgentSwitched,
  ErrorOccurred,
  MessageReceived,
  StreamEnded,
  StreamStarted,
  TurnCompleted,
} from "@gent/core-internal/domain/event"
import { reduceAgentLifecycle } from "../src/client/context"
import { AgentStatus } from "../src/client/agent-state"
import {
  AgentName,
  BranchId,
  Message,
  MessageId,
  SessionId,
  dateFromMillis,
} from "@gent/core/protocol"

const makeMessage = (role: "user" | "assistant") =>
  Message.cases.regular.make({
    id: MessageId.make("m1"),
    sessionId: SessionId.make("s1"),
    branchId: BranchId.make("b1"),
    role,
    parts: [],
    createdAt: dateFromMillis(0),
  })

describe("reduceAgentLifecycle", () => {
  test("marks a turn as streaming when the stream starts", () => {
    const event = StreamStarted.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
    })

    expect(reduceAgentLifecycle(event)).toEqual({
      status: { _tag: "Streaming" },
    })
    expect(Schema.is(AgentStatus.cases.Streaming)(reduceAgentLifecycle(event).status)).toBe(true)
  })

  test("keeps streaming until TurnCompleted", () => {
    const streamEnded = StreamEnded.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
    })
    const assistantMessage = MessageReceived.make({
      message: makeMessage("assistant"),
    })
    const turnCompleted = TurnCompleted.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      durationMs: 42,
    })

    expect(reduceAgentLifecycle(streamEnded)).toEqual({})
    expect(reduceAgentLifecycle(assistantMessage)).toEqual({})
    expect(reduceAgentLifecycle(turnCompleted)).toEqual({
      status: { _tag: "Idle" },
    })
    expect(Schema.is(AgentStatus.cases.Idle)(reduceAgentLifecycle(turnCompleted).status)).toBe(true)
  })

  test("uses user messages to enter streaming immediately", () => {
    const userMessage = MessageReceived.make({
      message: makeMessage("user"),
    })

    expect(reduceAgentLifecycle(userMessage)).toEqual({
      status: { _tag: "Streaming" },
    })
    expect(Schema.is(AgentStatus.cases.Streaming)(reduceAgentLifecycle(userMessage).status)).toBe(
      true,
    )
  })

  test("surfaces agent switches and errors", () => {
    const switched = AgentSwitched.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      fromAgent: AgentName.make("cowork"),
      toAgent: AgentName.make("deepwork"),
    })
    const errored = ErrorOccurred.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      error: "boom",
    })

    expect(reduceAgentLifecycle(switched)).toEqual({
      preferredAgent: AgentName.make("deepwork"),
    })
    expect(reduceAgentLifecycle(errored)).toEqual({
      status: { _tag: "Error", error: "boom" },
    })
    expect(Schema.is(AgentStatus.cases.Error)(reduceAgentLifecycle(errored).status)).toBe(true)
  })
})
