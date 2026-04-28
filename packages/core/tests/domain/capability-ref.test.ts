/**
 * Asserts the typed-ref accessor invariants for capability tokens:
 *
 * 1. `request(...)` attaches a `CapabilityRef` under a private request-local
 *    symbol (private — only `ref(token)` reads it).
 * 2. `ref(requestToken)` returns the typed ref with the same id/intent
 *    metadata the author provided.
 * 3. `ref(toolToken)` and `ref(actionToken)` fail at compile time — only
 *    request tokens carry a ref.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { action, ref, request, tool } from "@gent/core/extensions/api"
import type { CommandId, RpcId, ToolId } from "@gent/core/domain/ids"
import { ExtensionId } from "@gent/core/domain/ids"

describe("ref(token)", () => {
  test("factories brand emitted bucket ids while accepting author strings", () => {
    const toolToken = tool({
      id: "test.tool",
      description: "ephemeral",
      params: Schema.Struct({ x: Schema.String }),
      execute: () => Effect.succeed("ok"),
    })
    const actionToken = action({
      id: "test.action",
      name: "Test Action",
      description: "ephemeral",
      surface: "palette",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
    })
    const requestToken = request({
      id: "test.read",
      extensionId: ExtensionId.make("ext-test"),
      intent: "read",
      input: Schema.Struct({ q: Schema.String }),
      output: Schema.Struct({ n: Schema.Number }),
      execute: () => Effect.succeed({ n: 1 }),
    })

    const toolId: ToolId = toolToken.id
    const commandId: CommandId = actionToken.id
    const rpcId: RpcId = requestToken.id
    expect([String(toolId), String(commandId), String(rpcId)]).toEqual([
      "test.tool",
      "test.action",
      "test.read",
    ])
  })

  test("returns the typed ref for a request token, preserving id + intent + schema identity", () => {
    const inputSchema = Schema.Struct({ q: Schema.String })
    const outputSchema = Schema.Struct({ n: Schema.Number })
    const token = request({
      id: "test.read",
      extensionId: ExtensionId.make("ext-test"),
      intent: "read",
      input: inputSchema,
      output: outputSchema,
      execute: () => Effect.succeed({ n: 1 }),
    })

    const r = ref(token)
    const capabilityId: RpcId = r.capabilityId
    expect(String(capabilityId)).toBe("test.read")
    expect(r.extensionId as string).toBe("ext-test")
    expect(r.intent).toBe("read")
    // Schema identity: refValue forwards author schemas by reference. A
    // future refactor that clones/wraps would silently change decode
    // behavior at the dispatcher boundary.
    expect(r.input).toBe(inputSchema)
    expect(r.output).toBe(outputSchema)
  })

  test("ref accessor only accepts request tokens", () => {
    const token = tool({
      id: "test.tool",
      description: "ephemeral",
      params: Schema.Struct({ x: Schema.String }),
      execute: () => Effect.succeed("ok"),
    })
    const actionToken = action({
      id: "test.action",
      name: "Test Action",
      description: "ephemeral",
      surface: "palette",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
    })

    // @ts-expect-error Tool tokens are not request refs.
    ref(token)
    // @ts-expect-error Action tokens are not request refs.
    ref(actionToken)
  })
})
