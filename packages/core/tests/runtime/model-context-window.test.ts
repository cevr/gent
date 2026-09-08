import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message"
import {
  latestUserMessageId,
  messagesInCurrentWindow,
  windowMarkerMessage,
} from "../../src/runtime/model-context-window"

const sessionId = SessionId.make("window-session")
const branchId = BranchId.make("window-branch")

const message = (id: string, role: "user" | "assistant", ordinal: number) =>
  Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId,
    branchId,
    role,
    parts: [Prompt.textPart({ text: id })],
    createdAt: dateFromMillis(1_000 + ordinal),
  })

describe("model context window", () => {
  test("a marker leads the window and everything before its anchor leaves the view", () => {
    const history = [
      message("u1", "user", 1),
      message("a1", "assistant", 2),
      message("u2", "user", 3),
      message("a2", "assistant", 4),
    ]
    const anchor = Option.getOrThrow(latestUserMessageId(history))
    expect(anchor).toBe(MessageId.make("u2"))
    const marker = windowMarkerMessage({
      sessionId,
      branchId,
      keepFromMessageId: anchor,
      createdAt: dateFromMillis(2_000),
    })
    const windowed = messagesInCurrentWindow([...history, marker, message("u3", "user", 5)])
    expect(windowed.map((entry) => String(entry.id))).toEqual([String(marker.id), "u2", "a2", "u3"])
    // The marker itself never anchors a later window.
    expect(latestUserMessageId([...history, marker])).toEqual(Option.some(MessageId.make("u2")))
  })

  test("a marker whose anchor is gone is ignored so nothing is lost", () => {
    const history = [message("u1", "user", 1), message("a1", "assistant", 2)]
    const marker = windowMarkerMessage({
      sessionId,
      branchId,
      keepFromMessageId: MessageId.make("missing"),
      createdAt: dateFromMillis(2_000),
    })
    expect(messagesInCurrentWindow([...history, marker])).toEqual([...history, marker])
    expect(messagesInCurrentWindow(history)).toBe(history)
  })
})
