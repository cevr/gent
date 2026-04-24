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
})
