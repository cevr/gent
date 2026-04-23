import { describe, test, expect } from "bun:test"
import {
  truncate,
  renderMessageParts,
  renderSessionTree,
} from "@gent/extensions/session-tools/read-session"
import {
  TextPart,
  ToolCallPart,
  ToolResultPart,
  Branch,
  Message,
  type MessagePart,
} from "@gent/core/domain/message"
import { SessionId, BranchId, MessageId } from "@gent/core/domain/ids"

describe("truncate", () => {
  test("under max → unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  test("over max → sliced + '…'", () => {
    expect(truncate("hello world", 5)).toBe("hello…")
  })
})

describe("renderMessageParts", () => {
  test("text part → text content", () => {
    const parts: MessagePart[] = [new TextPart({ type: "text", text: "hello world" })]
    expect(renderMessageParts(parts)).toBe("hello world")
  })

  test("tool-call part → '### tool: name' header + truncated input", () => {
    const parts: MessagePart[] = [
      new ToolCallPart({
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "read",
        input: { path: "/tmp/test.txt" },
      }),
    ]
    const result = renderMessageParts(parts)
    expect(result).toContain("### tool: read")
    expect(result).toContain("/tmp/test.txt")
  })

  test("tool-result part → 'result: {truncated output}'", () => {
    const parts: MessagePart[] = [
      new ToolResultPart({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "read",
        output: { type: "json", value: "file contents here" },
      }),
    ]
    const result = renderMessageParts(parts)
    expect(result).toContain("result: file contents here")
  })

  test("mixed parts joined with newline", () => {
    const parts: MessagePart[] = [
      new TextPart({ type: "text", text: "start" }),
      new ToolCallPart({
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "bash",
        input: { command: "ls" },
      }),
    ]
    const result = renderMessageParts(parts)
    expect(result).toContain("start")
    expect(result).toContain("### tool: bash")
    expect(result.indexOf("start")).toBeLessThan(result.indexOf("### tool: bash"))
  })
})

describe("renderSessionTree", () => {
  const now = new Date()
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

  const makeMessage = (branchId: BranchId, role: "user" | "assistant", text: string) =>
    new Message.regular({
      id: MessageId.make(`msg-${Math.random().toString(36).slice(2, 8)}`),
      sessionId: sid,
      branchId,
      role,
      parts: [new TextPart({ type: "text", text })],
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
