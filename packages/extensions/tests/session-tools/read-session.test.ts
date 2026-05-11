import { describe, test, expect } from "bun:test"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  truncate,
  renderMessageParts,
  renderSessionTree,
} from "../../src/session-tools/read-session.js"
import { messagePartsDisplayText } from "@gent/core-internal/domain/message-part-projection"
import {
  dateFromMillis,
  Branch,
  Message,
  type MessagePart,
} from "@gent/core-internal/domain/message"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"

describe("truncate", () => {
  test("under max → unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  test("over max → sliced + '…'", () => {
    expect(truncate("hello world", 5)).toBe("hello…")
  })
})

describe("messagePartsDisplayText", () => {
  test("read-session subpath exports renderMessageParts", () => {
    const parts: MessagePart[] = [Prompt.textPart({ text: "hello world" })]
    expect(renderMessageParts(parts)).toBe(messagePartsDisplayText(parts))
  })

  test("text part → text content", () => {
    const parts: MessagePart[] = [Prompt.textPart({ text: "hello world" })]
    expect(messagePartsDisplayText(parts)).toBe("hello world")
  })

  test("tool-call part → '### tool: name' header + truncated input", () => {
    const parts: MessagePart[] = [
      Prompt.toolCallPart({
        id: ToolCallId.make("tc1"),
        name: "read",
        params: { path: "/tmp/test.txt" },
        providerExecuted: false,
      }),
    ]
    const result = messagePartsDisplayText(parts)
    expect(result).toContain("### tool: read")
    expect(result).toContain("/tmp/test.txt")
  })

  test("tool-call part with undefined input renders without throwing", () => {
    const parts: MessagePart[] = [
      Prompt.toolCallPart({
        id: ToolCallId.make("tc1"),
        name: "read",
        params: undefined,
        providerExecuted: false,
      }),
    ]
    expect(messagePartsDisplayText(parts)).toBe("### tool: read\nundefined")
  })

  test("tool-result part → 'result: {truncated output}'", () => {
    const parts: MessagePart[] = [
      Prompt.toolResultPart({
        id: ToolCallId.make("tc1"),
        name: "read",
        isFailure: false,
        result: "file contents here",
      }),
    ]
    const result = messagePartsDisplayText(parts)
    expect(result).toContain("result: file contents here")
  })

  test("mixed parts joined with newline", () => {
    const parts: MessagePart[] = [
      Prompt.textPart({ text: "start" }),
      Prompt.toolCallPart({
        id: ToolCallId.make("tc1"),
        name: "bash",
        params: { command: "ls" },
        providerExecuted: false,
      }),
    ]
    const result = messagePartsDisplayText(parts)
    expect(result).toContain("start")
    expect(result).toContain("### tool: bash")
    expect(result.indexOf("start")).toBeLessThan(result.indexOf("### tool: bash"))
  })
})

describe("renderSessionTree", () => {
  const now = dateFromMillis(0)
  const sid = SessionId.make("s1")
  const bid1 = BranchId.make("b1")
  const bid2 = BranchId.make("b2")

  const makeBranch = (id: BranchId, opts?: { parentBranchId?: BranchId; name?: string }) =>
    new Branch({
      id,
      sessionId: sid,
      parentBranchId: opts?.parentBranchId,
      name: opts?.name,
      createdAt: now,
    })

  let messageIndex = 0
  const makeMessage = (branchId: BranchId, role: "user" | "assistant", text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(`msg-${messageIndex++}`),
      sessionId: sid,
      branchId,
      role,
      parts: [Prompt.textPart({ text })],
      createdAt: now,
    })

  test("single branch → '# Branch: name' header + messages", () => {
    const branch = makeBranch(bid1, { name: "main" })
    const msg = makeMessage(bid1, "user", "hello")
    const result = renderSessionTree([{ branch, messages: [msg] }], undefined)
    expect(result).toContain("# Branch: main")
    expect(result).toContain("## user")
    expect(result).toContain("hello")
  })

  test("target branch → '[TARGET BRANCH]' marker", () => {
    const branch = makeBranch(bid1, { name: "main" })
    const msg = makeMessage(bid1, "user", "hello")
    const result = renderSessionTree([{ branch, messages: [msg] }], bid1)
    expect(result).toContain("[TARGET BRANCH]")
  })

  test("child branch → '--- branch point ---' separator", () => {
    const parent = makeBranch(bid1, { name: "main" })
    const child = makeBranch(bid2, { parentBranchId: bid1, name: "fix" })
    const result = renderSessionTree(
      [
        { branch: parent, messages: [makeMessage(bid1, "user", "start")] },
        { branch: child, messages: [makeMessage(bid2, "assistant", "fixed")] },
      ],
      undefined,
    )
    expect(result).toContain("# Branch: main")
    expect(result).toContain("--- branch point: fix ---")
  })
})
