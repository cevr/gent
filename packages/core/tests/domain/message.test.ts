import { describe, expect, test } from "bun:test"
import { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { Message, TextPart, copyMessageToBranch } from "@gent/core/domain/message"

describe("copyMessageToBranch", () => {
  test("preserves interjection variant when copying to a new branch", () => {
    const message = Message.Interjection.make({
      id: MessageId.make("source-message"),
      sessionId: SessionId.make("source-session"),
      branchId: BranchId.make("source-branch"),
      role: "user",
      parts: [new TextPart({ type: "text", text: "steer now" })],
      createdAt: new Date(0),
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copied-message"),
      branchId: BranchId.make("copied-branch"),
    })

    expect(copied._tag).toBe("interjection")
    expect(copied.id).toBe("copied-message")
    expect(copied.branchId).toBe("copied-branch")
    expect(copied.sessionId).toBe("source-session")
  })

  test("preserves regular variant and role when copying", () => {
    const message = Message.Regular.make({
      id: MessageId.make("src-msg"),
      sessionId: SessionId.make("src-session"),
      branchId: BranchId.make("src-branch"),
      role: "assistant",
      parts: [new TextPart({ type: "text", text: "hello" })],
      createdAt: new Date(0),
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copy-msg"),
      branchId: BranchId.make("copy-branch"),
    })

    expect(copied._tag).toBe("regular")
    expect(copied.role).toBe("assistant")
    expect(copied.id).toBe("copy-msg")
    expect(copied.branchId).toBe("copy-branch")
    expect(copied.sessionId).toBe("src-session")
    expect(copied.parts).toEqual(message.parts)
  })

  test("threads explicit sessionId override when provided", () => {
    const message = Message.Regular.make({
      id: MessageId.make("src-msg"),
      sessionId: SessionId.make("src-session"),
      branchId: BranchId.make("src-branch"),
      role: "user",
      parts: [new TextPart({ type: "text", text: "x" })],
      createdAt: new Date(0),
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copy-msg"),
      sessionId: SessionId.make("override-session"),
      branchId: BranchId.make("copy-branch"),
    })

    expect(copied.sessionId).toBe("override-session")
  })

  test("preserves optional fields (turnDurationMs, metadata) when present", () => {
    const message = Message.Regular.make({
      id: MessageId.make("src-msg"),
      sessionId: SessionId.make("src-session"),
      branchId: BranchId.make("src-branch"),
      role: "assistant",
      parts: [new TextPart({ type: "text", text: "x" })],
      createdAt: new Date(0),
      turnDurationMs: 1234,
      metadata: { customType: "demo", extensionId: "ext-x" },
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copy-msg"),
      branchId: BranchId.make("copy-branch"),
    })

    expect(copied.turnDurationMs).toBe(1234)
    expect(copied.metadata?.customType).toBe("demo")
    expect(copied.metadata?.extensionId).toBe("ext-x")
  })

  test("omits optional fields when source has none (no spurious undefined keys)", () => {
    const message = Message.Regular.make({
      id: MessageId.make("src-msg"),
      sessionId: SessionId.make("src-session"),
      branchId: BranchId.make("src-branch"),
      role: "user",
      parts: [new TextPart({ type: "text", text: "x" })],
      createdAt: new Date(0),
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copy-msg"),
      branchId: BranchId.make("copy-branch"),
    })

    expect("turnDurationMs" in copied).toBe(false)
    expect("metadata" in copied).toBe(false)
  })
})
