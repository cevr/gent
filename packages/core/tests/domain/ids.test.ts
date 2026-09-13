/**
 * Branded id locks — guarantees id brands survive.
 *
 * Tests cover:
 * - `Schema.decodeUnknownSync` roundtrip for each branded id
 * - cross-brand assignability is a compile-time error (recorded via @ts-expect-error)
 *
 * @module
 */
import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  RpcId,
  SessionId,
  ToolCallId,
  ToolId,
} from "../../src/domain/ids"

describe("branded ids — roundtrip", () => {
  test("SessionId decodes from a plain string and brand survives", () => {
    const id = Schema.decodeSync(SessionId)("sess-abc")
    expect(String(id)).toBe("sess-abc")
  })

  test("ToolCallId decodes from a plain string and brand survives", () => {
    const id = Schema.decodeSync(ToolCallId)("tc-1")
    expect(String(id)).toBe("tc-1")
  })

  test("ToolId and RpcId roundtrip", () => {
    expect(String(Schema.decodeSync(ToolId)("read_file"))).toBe("read_file")
    expect(String(Schema.decodeSync(RpcId)("todo.list"))).toBe("todo.list")
  })

  test("BranchId, MessageId, ActorCommandId all roundtrip", () => {
    expect(String(Schema.decodeSync(BranchId)("b-1"))).toBe("b-1")
    expect(String(Schema.decodeSync(MessageId)("m-1"))).toBe("m-1")
    expect(String(Schema.decodeSync(ActorCommandId)("a-1"))).toBe("a-1")
  })

  test("InteractionRequestId and ExtensionId roundtrip", () => {
    expect(String(Schema.decodeSync(InteractionRequestId)("int-1"))).toBe("int-1")
    expect(String(Schema.decodeSync(ExtensionId)("@gent/x"))).toBe("@gent/x")
  })
})

describe("branded ids — cross-brand assignability is a type error", () => {
  test("SessionId is not assignable to ToolCallId", () => {
    const session = Schema.decodeSync(SessionId)("sess-abc")
    // @ts-expect-error — branded ids should not be cross-assignable
    const tool: ToolCallId = session
    expect(String(tool)).toBe("sess-abc")
  })

  test("ToolCallId is not assignable to SessionId", () => {
    const tool = Schema.decodeSync(ToolCallId)("tc-1")
    // @ts-expect-error — branded ids should not be cross-assignable
    const session: SessionId = tool
    expect(String(session)).toBe("tc-1")
  })

  test("ExtensionId and InteractionRequestId are mutually non-assignable", () => {
    const ext = Schema.decodeSync(ExtensionId)("@gent/x")
    const interaction = Schema.decodeSync(InteractionRequestId)("int-1")
    // @ts-expect-error
    const a: InteractionRequestId = ext
    // @ts-expect-error
    const b: ExtensionId = interaction
    expect([String(a), String(b)]).toEqual(["@gent/x", "int-1"])
  })

  test("ToolId and RpcId are mutually non-assignable", () => {
    const tool = Schema.decodeSync(ToolId)("read_file")
    const rpc = Schema.decodeSync(RpcId)("todo.list")
    // @ts-expect-error
    const a: RpcId = tool
    // @ts-expect-error
    const b: ToolId = rpc
    expect([String(a), String(b)]).toEqual(["read_file", "todo.list"])
  })
})
