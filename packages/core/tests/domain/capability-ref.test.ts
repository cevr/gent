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
import { Context, Effect, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import {
  action,
  getToolId,
  getToolMetadata,
  isToolToken,
  ref,
  request,
  tool,
} from "@gent/core/extensions/api"
import type { CommandId, RpcId, ToolId } from "@gent/core/domain/ids"
import { ExtensionId } from "@gent/core/domain/ids"
import { PermissionRule } from "@gent/core/domain/permission"

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

    const toolId: ToolId = getToolId(toolToken)
    const commandId: CommandId = actionToken.id
    const rpcId: RpcId = requestToken.id
    expect([String(toolId), String(commandId), String(rpcId)]).toEqual([
      "test.tool",
      "test.action",
      "test.read",
    ])
  })

  test("tool lowers to a native Effect AI tool with Gent metadata annotations", () => {
    const params = Schema.Struct({ x: Schema.String })
    const rule = new PermissionRule({ tool: "test.tool", action: "deny" })
    const prompt = { id: "tool.prompt", content: "Use carefully.", priority: 42 }
    const token = tool({
      id: "test.tool",
      description: "ephemeral",
      intent: "read",
      destructive: true,
      params,
      needs: [{ tag: "fs", access: "read" }],
      promptSnippet: "short",
      promptGuidelines: ["be precise"],
      interactive: true,
      permissionRules: [rule],
      prompt,
      execute: () => Effect.succeed("ok"),
    })

    expect(isToolToken(token)).toBe(true)
    expect(Context.get(token.annotations, AiTool.Readonly)).toBe(true)
    expect(Context.get(token.annotations, AiTool.Destructive)).toBe(true)

    const metadata = getToolMetadata(token)
    expect(metadata.id).toBe(getToolId(token))
    expect(metadata.intent).toBe("read")
    expect(metadata.input).toBe(params)
    expect(metadata.needs).toEqual([{ tag: "fs", access: "read" }])
    expect(metadata.promptSnippet).toBe("short")
    expect(metadata.promptGuidelines).toEqual(["be precise"])
    expect(metadata.interactive).toBe(true)
    expect(metadata.permissionRules).toEqual([rule])
    expect(metadata.prompt).toEqual(prompt)
  })

  test("write intent is not marked destructive unless requested", () => {
    const token = tool({
      id: "test.write",
      description: "write without destructive side effects",
      params: Schema.Struct({}),
      execute: () => Effect.succeed("ok"),
    })

    expect(Context.get(token.annotations, AiTool.Readonly)).toBe(false)
    expect(Context.get(token.annotations, AiTool.Destructive)).toBe(false)
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
