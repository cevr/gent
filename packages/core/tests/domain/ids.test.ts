/**
 * Branded id locks: two ids of different brands are not assignable to each
 * other, recorded through `@ts-expect-error`.
 *
 * @module
 */
import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import {
  ExtensionId,
  InteractionRequestId,
  RpcId,
  SessionId,
  ToolCallId,
  ToolId,
} from "../../src/domain/ids"

describe("branded ids — cross-brand assignability is a type error", () => {
  test("SessionId is not assignable to ToolCallId", () => {
    const session = Schema.decodeSync(SessionId)("sess-abc")
    // @ts-expect-error -- branded ids should not be cross-assignable
    const tool: ToolCallId = session
    expect(String(tool)).toBe("sess-abc")
  })

  test("ToolCallId is not assignable to SessionId", () => {
    const tool = Schema.decodeSync(ToolCallId)("tc-1")
    // @ts-expect-error -- branded ids should not be cross-assignable
    const session: SessionId = tool
    expect(String(session)).toBe("tc-1")
  })

  test("ExtensionId and InteractionRequestId are mutually non-assignable", () => {
    const ext = Schema.decodeSync(ExtensionId)("@gent/x")
    const interaction = Schema.decodeSync(InteractionRequestId)("int-1")
    // @ts-expect-error -- an ExtensionId is not an InteractionRequestId.
    const a: InteractionRequestId = ext
    // @ts-expect-error -- an InteractionRequestId is not an ExtensionId.
    const b: ExtensionId = interaction
    expect([String(a), String(b)]).toEqual(["@gent/x", "int-1"])
  })

  test("ToolId and RpcId are mutually non-assignable", () => {
    const tool = Schema.decodeSync(ToolId)("read_file")
    const rpc = Schema.decodeSync(RpcId)("todo.list")
    // @ts-expect-error -- a ToolId is not an RpcId.
    const a: RpcId = tool
    // @ts-expect-error -- an RpcId is not a ToolId.
    const b: ToolId = rpc
    expect([String(a), String(b)]).toEqual(["read_file", "todo.list"])
  })
})
