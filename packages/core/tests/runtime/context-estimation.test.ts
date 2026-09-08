import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import { estimateTokens } from "../../src/runtime/context-estimation"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("Token Estimation", () => {
  test("estimateTokens calculates token count", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "user",
        parts: [Prompt.textPart({ text: "Hello world" })], // 11 chars
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]

    const tokens = estimateTokens(messages)
    expect(tokens).toBe(3) // ceil(11/4) = 3
  })
})
describe("estimateTokens", () => {
  test("text parts", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "user",
        parts: [Prompt.textPart({ text: "x".repeat(100) })],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    expect(estimateTokens(messages)).toBe(25) // 100/4
  })

  test("tool-call parts use JSON.stringify of input", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: ToolCallId.make("tc1"),
            name: "test",
            params: { key: "value" },
            providerExecuted: false,
          }),
        ],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    const tokens = estimateTokens(messages)
    const expectedChars = encodeJson({ key: "value" }).length
    expect(tokens).toBe(Math.ceil(expectedChars / 4))
  })

  test("tool-result parts use JSON.stringify of output", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "tool",
        parts: [
          Prompt.toolResultPart({
            id: ToolCallId.make("tc1"),
            name: "test",
            isFailure: false,
            providerExecuted: false,
            result: { data: "hello" },
          }),
        ],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
  })

  test("image parts estimate ~250 tokens", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "user",
        parts: [Prompt.filePart({ data: "data:image/png;base64,abc", mediaType: "image/png" })],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    expect(estimateTokens(messages)).toBe(250) // 1000/4
  })

  test("multiple messages sum correctly", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "user",
        parts: [Prompt.textPart({ text: "x".repeat(100) })],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
      Message.cases.regular.make({
        id: MessageId.make("m2"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "assistant",
        parts: [Prompt.textPart({ text: "y".repeat(200) })],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    expect(estimateTokens(messages)).toBe(75) // (100+200)/4
  })
})
