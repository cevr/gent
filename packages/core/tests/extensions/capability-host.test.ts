/**
 * Extension capability registry regression locks.
 *
 * Model tools are compiled through the model tool registry. Public transport
 * dispatch is the RPC registry only; human actions stay on local surfaces.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Schema } from "effect"
import type { LoadedExtension } from "../../src/domain/extension.js"
import {
  type CapabilityCoreContext,
  CapabilityError,
  CapabilityNotFoundError,
} from "@gent/core/domain/capability"
import { action, request, tool, type RequestToken, type ToolToken } from "@gent/core/extensions/api"
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import { BranchId, ExtensionId, RpcId, SessionId } from "@gent/core/domain/ids"

const extensionId = ExtensionId.make("@test/c")
const ctx: CapabilityCoreContext = {
  sessionId: SessionId.make("s"),
  branchId: BranchId.make("b"),
  cwd: "/tmp",
  home: "/tmp",
}
const extWith = (
  scope: "builtin" | "user" | "project",
  rpc: ReadonlyArray<RequestToken>,
): LoadedExtension => ({
  manifest: { id: extensionId },
  scope,
  sourcePath: `/test/${scope}`,
  contributions: { rpc },
})

const echoRequest = (params?: { readonly id?: string; readonly value?: string }) =>
  request({
    id: params?.id ?? "echo",
    extensionId,
    intent: "read",
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: (input) => Effect.succeed({ value: params?.value ?? input.value }),
  })

const pingAction = (params?: { readonly id?: string; readonly value?: string }) =>
  action({
    id: params?.id ?? "ping",
    name: "Ping",
    description: "Ping action",
    surface: "slash",
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: (input) => Effect.succeed({ value: params?.value ?? input.value }),
  })

const shadowTool = (params?: { readonly id?: string }): ToolToken =>
  tool({
    id: params?.id ?? "tool-shadow",
    description: "Tool shadow",
    params: Schema.Struct({ value: Schema.String }),
    execute: (input) => Effect.succeed({ value: input.value }),
  })

describe("extension capability registries", () => {
  it.live("dispatches request tokens by (extensionId, capabilityId)", () =>
    Effect.gen(function* () {
      const cap = echoRequest()
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* resolved.rpcRegistry.run(extensionId, cap.id, { value: "hi" }, ctx, {
        intent: "read",
      })
      expect(result).toEqual({ value: "hi" })
    }),
  )

  it.live("dispatches slash-decorated request tokens through the rpc registry", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "ping",
        extensionId,
        intent: "write",
        slash: { name: "Ping", description: "Ping request" },
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (input) => Effect.succeed({ value: input.value }),
      })
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "/test/rpc",
        contributions: { rpc: [cap] },
      }
      const resolved = resolveExtensions([ext])
      const result = yield* resolved.rpcRegistry.run(extensionId, cap.id, { value: "hi" }, ctx, {
        intent: "write",
      })
      expect(result).toEqual({ value: "hi" })
    }),
  )

  it.live("rpc registry does not dispatch action tokens", () =>
    Effect.gen(function* () {
      const cap = action({
        id: "private-ping",
        name: "Private Ping",
        description: "Private action",
        surface: "slash",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (input) => Effect.succeed({ value: input.value }),
      })
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "/test/private-action",
        contributions: { commands: [cap] },
      }
      const resolved = resolveExtensions([ext])
      const result = yield* resolved.rpcRegistry
        .run(extensionId, RpcId.make(String(cap.id)), { value: "hi" }, ctx, { intent: "write" })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityNotFoundError)
    }),
  )

  it.live("higher-scope action shadows lower-scope slash request", () =>
    Effect.gen(function* () {
      const builtin = request({
        id: "shadowed",
        extensionId,
        intent: "write",
        slash: { name: "Shadowed", description: "Shadowed request" },
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: () => Effect.succeed({ value: "builtin" }),
      })
      const project = action({
        id: "shadowed",
        name: "Project Private",
        description: "Project private action",
        surface: "slash",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (input) => Effect.succeed({ value: input.value }),
      })
      const resolved = resolveExtensions([
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "/test/builtin-request",
          contributions: { rpc: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-private-action",
          contributions: { commands: [project] },
        },
      ])
      const result = yield* resolved.rpcRegistry
        .run(extensionId, builtin.id, { value: "hi" }, ctx, { intent: "write" })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityNotFoundError)
    }),
  )

  it.live("request dispatch rejects higher-scope action shadowing lower request", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "same", value: "builtin-request" })
      const project = pingAction({ id: "same", value: "project-action" })
      const resolved = resolveExtensions([
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "/test/builtin-request",
          contributions: { rpc: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-public-action",
          contributions: { commands: [project] },
        },
      ])
      const result = yield* resolved.rpcRegistry
        .run(extensionId, builtin.id, { value: "hi" }, ctx, { intent: "read" })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityNotFoundError)
    }),
  )

  it.live("request dispatch rejects higher-scope tool shadowing lower request", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "same", value: "builtin-request" })
      const project = shadowTool({ id: "same" })
      const resolved = resolveExtensions([
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "/test/builtin-request",
          contributions: { rpc: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-tool",
          contributions: { tools: [project] },
        },
      ])
      const result = yield* resolved.rpcRegistry
        .run(extensionId, builtin.id, { value: "hi" }, ctx, { intent: "read" })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityNotFoundError)
    }),
  )

  it.live("request dispatch rejects lower request shadowed by higher-scope tool", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "same", value: "builtin-request" })
      const project = shadowTool({ id: "same" })
      const resolved = resolveExtensions([
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "/test/builtin-request",
          contributions: { rpc: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-tool",
          contributions: { tools: [project] },
        },
      ])
      const result = yield* resolved.rpcRegistry
        .run(extensionId, builtin.id, { value: "hi" }, ctx, { intent: "read" })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityNotFoundError)
    }),
  )

  it.live("scope precedence shadows lower-scope request tokens by identity", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "thing", value: "builtin" })
      const project = echoRequest({ id: "thing", value: "project" })
      const resolved = resolveExtensions([
        extWith("builtin", [builtin]),
        extWith("project", [project]),
      ])
      const result = yield* resolved.rpcRegistry.run(extensionId, project.id, { value: "x" }, ctx, {
        intent: "read",
      })
      expect(result).toEqual({ value: "project" })
    }),
  )

  it.live("intent mismatch on the winning request is a typed capability error", () =>
    Effect.gen(function* () {
      const writeCap = request({
        id: "thing",
        extensionId,
        intent: "write",
        input: Schema.Unknown,
        output: Schema.Unknown,
        execute: () => Effect.succeed("builtin-write"),
      })
      const readCap = request({
        id: "thing",
        extensionId,
        intent: "read",
        input: Schema.Unknown,
        output: Schema.Unknown,
        execute: () => Effect.succeed("project-read"),
      })
      const resolved = resolveExtensions([
        extWith("builtin", [writeCap]),
        extWith("project", [readCap]),
      ])

      const readResult = yield* resolved.rpcRegistry.run(extensionId, readCap.id, null, ctx, {
        intent: "read",
      })
      expect(readResult).toBe("project-read")

      const writeResult = yield* resolved.rpcRegistry
        .run(extensionId, readCap.id, null, ctx, { intent: "write" })
        .pipe(Effect.flip)
      expect(writeResult).toBeInstanceOf(CapabilityError)
      if (!(writeResult instanceof CapabilityError)) return
      expect(writeResult.reason).toContain("intent mismatch")
    }),
  )

  it.live("input decode failure is wrapped in CapabilityError", () =>
    Effect.gen(function* () {
      const cap = echoRequest()
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* resolved.rpcRegistry
        .run(extensionId, cap.id, { value: 42 }, ctx, { intent: "read" })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityError)
      if (!(result instanceof CapabilityError)) return
      expect(result.reason).toMatch(/input decode failed/)
    }),
  )

  it.live("output validation failure is wrapped in CapabilityError", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "bad",
        extensionId,
        intent: "read",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture intentionally violates output contract
        execute: () => Effect.succeed({ value: 42 } as unknown as { value: string }),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* resolved.rpcRegistry
        .run(extensionId, cap.id, { value: "x" }, ctx, { intent: "read" })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityError)
      if (!(result instanceof CapabilityError)) return
      expect(result.reason).toMatch(/output validation failed/)
    }),
  )

  it.live("handler defects are coerced into typed CapabilityError", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "boom",
        extensionId,
        intent: "read",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: () => Effect.die("boom"),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* resolved.rpcRegistry
        .run(extensionId, cap.id, { value: "x" }, ctx, { intent: "read" })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityError)
      if (!(result instanceof CapabilityError)) return
      expect(result.reason).toMatch(/handler defect/)
    }),
  )
})
