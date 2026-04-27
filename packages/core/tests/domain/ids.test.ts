/**
 * Branded id locks — guarantees the W7-C1 brand pass survives.
 *
 * Tests cover:
 * - `Schema.decodeUnknownSync` roundtrip for each branded id
 * - cross-brand assignability is a compile-time error (recorded via @ts-expect-error)
 * - `TurnEvent.Tool*` decode produces `ToolCallId`-branded `toolCallId`
 *
 * @module
 */
import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { TurnEvent } from "@gent/core/domain/driver"
import {
  ActorCommandId,
  ActorId,
  ArtifactId,
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
  TaskId,
  ToolCallId,
} from "@gent/core/domain/ids"

describe("branded ids — roundtrip", () => {
  test("SessionId decodes from a plain string and brand survives", () => {
    const id = Schema.decodeUnknownSync(SessionId)("sess-abc")
    expect(String(id)).toBe("sess-abc")
  })

  test("ToolCallId decodes from a plain string and brand survives", () => {
    const id = Schema.decodeUnknownSync(ToolCallId)("tc-1")
    expect(String(id)).toBe("tc-1")
  })

  test("BranchId, MessageId, TaskId, ActorCommandId, ArtifactId all roundtrip", () => {
    expect(String(Schema.decodeUnknownSync(BranchId)("b-1"))).toBe("b-1")
    expect(String(Schema.decodeUnknownSync(MessageId)("m-1"))).toBe("m-1")
    expect(String(Schema.decodeUnknownSync(TaskId)("t-1"))).toBe("t-1")
    expect(String(Schema.decodeUnknownSync(ActorCommandId)("a-1"))).toBe("a-1")
    expect(String(Schema.decodeUnknownSync(ArtifactId)("art-1"))).toBe("art-1")
  })

  test("ActorId, InteractionRequestId, ExtensionId all roundtrip", () => {
    expect(String(Schema.decodeUnknownSync(ActorId)("actor-1"))).toBe("actor-1")
    expect(String(Schema.decodeUnknownSync(InteractionRequestId)("int-1"))).toBe("int-1")
    expect(String(Schema.decodeUnknownSync(ExtensionId)("@gent/x"))).toBe("@gent/x")
  })
})

describe("branded ids — cross-brand assignability is a type error", () => {
  test("SessionId is not assignable to ToolCallId", () => {
    const session = Schema.decodeUnknownSync(SessionId)("sess-abc")
    // @ts-expect-error — branded ids should not be cross-assignable
    const tool: ToolCallId = session
    expect(String(tool)).toBe("sess-abc")
  })

  test("ToolCallId is not assignable to SessionId", () => {
    const tool = Schema.decodeUnknownSync(ToolCallId)("tc-1")
    // @ts-expect-error — branded ids should not be cross-assignable
    const session: SessionId = tool
    expect(String(session)).toBe("tc-1")
  })

  test("ExtensionId, ActorId, InteractionRequestId are mutually non-assignable", () => {
    const ext = Schema.decodeUnknownSync(ExtensionId)("@gent/x")
    const actor = Schema.decodeUnknownSync(ActorId)("a-1")
    const interaction = Schema.decodeUnknownSync(InteractionRequestId)("int-1")
    // @ts-expect-error
    const a: ActorId = ext
    // @ts-expect-error
    const b: InteractionRequestId = actor
    // @ts-expect-error
    const c: ExtensionId = interaction
    expect([String(a), String(b), String(c)]).toEqual(["@gent/x", "a-1", "int-1"])
  })
})

describe("TurnEvent — toolCallId is branded ToolCallId", () => {
  test("ToolCall variant decodes toolCallId as ToolCallId", () => {
    const decoded = Schema.decodeUnknownSync(TurnEvent)({
      _tag: "tool-call",
      toolCallId: ToolCallId.make("tc-7"),
      toolName: "echo",
      input: { text: "hi" },
    })
    expect(decoded._tag).toBe("tool-call")
    if (decoded._tag !== "tool-call") throw new Error("unreachable")
    // Compile-time: assigning to ToolCallId should typecheck.
    const id: ToolCallId = decoded.toolCallId
    expect(String(id)).toBe("tc-7")
  })

  test("ToolStarted, ToolCompleted, ToolFailed all carry branded toolCallId", () => {
    const started = Schema.decodeUnknownSync(TurnEvent)({
      _tag: "tool-started",
      toolCallId: ToolCallId.make("tc-1"),
      toolName: "echo",
    })
    const completed = Schema.decodeUnknownSync(TurnEvent)({
      _tag: "tool-completed",
      toolCallId: ToolCallId.make("tc-2"),
    })
    const failed = Schema.decodeUnknownSync(TurnEvent)({
      _tag: "tool-failed",
      toolCallId: ToolCallId.make("tc-3"),
      error: "boom",
    })
    if (started._tag === "tool-started") {
      const id: ToolCallId = started.toolCallId
      expect(String(id)).toBe("tc-1")
    }
    if (completed._tag === "tool-completed") {
      const id: ToolCallId = completed.toolCallId
      expect(String(id)).toBe("tc-2")
    }
    if (failed._tag === "tool-failed") {
      const id: ToolCallId = failed.toolCallId
      expect(String(id)).toBe("tc-3")
    }
  })
})
