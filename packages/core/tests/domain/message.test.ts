import { describe, expect, test } from "bun:test"
import { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { Message, TextPart, copyMessageToBranch } from "@gent/core/domain/message"

describe("copyMessageToBranch", () => {
  test("preserves interjection variant when copying to a new branch", () => {
    const message = new Message.interjection({
      id: MessageId.of("source-message"),
      sessionId: SessionId.of("source-session"),
      branchId: BranchId.of("source-branch"),
      role: "user",
      parts: [new TextPart({ type: "text", text: "steer now" })],
      createdAt: new Date(0),
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.of("copied-message"),
      branchId: BranchId.of("copied-branch"),
    })

    expect(copied._tag).toBe("interjection")
    expect(copied.id).toBe("copied-message")
    expect(copied.branchId).toBe("copied-branch")
    expect(copied.sessionId).toBe("source-session")
  })
})
