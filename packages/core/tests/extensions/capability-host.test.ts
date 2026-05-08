/**
 * Extension capability registry regression locks.
 *
 * Model tools are compiled through the model tool registry. Public command
 * dispatch accepts slash-capable requests and actions; palette-only actions
 * stay on local surfaces.
 */
import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Exit, Schema } from "effect"
import type { LoadedExtension } from "../../src/domain/extension.js"
import {
  type CapabilityCoreContext,
  CapabilityError,
  CapabilityNotFoundError,
} from "@gent/core-internal/domain/capability"
import {
  action,
  ExtensionContext,
  request,
  tool,
  type RequestCapability,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import { BranchId, ExtensionId, SessionId } from "@gent/core-internal/domain/ids"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"

const extensionId = ExtensionId.make("@test/c")
const ctx: CapabilityCoreContext = {
  sessionId: SessionId.make("s"),
  branchId: BranchId.make("b"),
  cwd: "/tmp",
  home: "/tmp",
  host: testExtensionHostContext().host,
}
const extWith = (
  scope: "builtin" | "user" | "project",
  requests: ReadonlyArray<RequestCapability>,
): LoadedExtension => ({
  manifest: { id: extensionId },
  scope,
  sourcePath: `/test/${scope}`,
  contributions: { requests },
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

const shadowTool = (params?: { readonly id?: string }): ToolCapability =>
  tool({
    id: params?.id ?? "tool-shadow",
    description: "Tool shadow",
    params: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: (input) => Effect.succeed({ value: input.value }),
  })

const expectRpcFailure = (
  effect: Effect.Effect<unknown, CapabilityError | CapabilityNotFoundError>,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return yield* Effect.die("expected rpc failure")
    const reason = exit.cause.reasons.find(Cause.isFailReason)
    if (reason === undefined) return yield* Effect.die("expected failed cause")
    return reason.error
  })

describe("extension capability registries", () => {
  it.live("dispatches request capabilities by (extensionId, capabilityId)", () =>
    Effect.gen(function* () {
      const cap = echoRequest()
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* resolved.rpcRegistry.run(extensionId, cap.id, { value: "hi" }, ctx, {
        intent: "read",
      })
      expect(result).toEqual({ value: "hi" })
    }),
  )

  it.live("read request handlers receive read-intent ExtensionContext authority", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "read-context-facade",
        extensionId,
        intent: "read",
        input: Schema.Struct({}),
        output: Schema.Struct({
          parentEnvEmpty: Schema.Boolean,
          processDenied: Schema.Boolean,
          followUpDenied: Schema.Boolean,
          interactionDenied: Schema.Boolean,
        }),
        execute: () =>
          Effect.gen(function* () {
            const extensionCtx = yield* ExtensionContext
            const processExit = yield* Effect.exit(extensionCtx.Process.run("echo", ["hi"]))
            const followUpExit = yield* Effect.exit(
              extensionCtx.Session.queueFollowUp({ sourceId: "read-request", content: "nope" }),
            )
            const interactionExit = yield* Effect.exit(
              extensionCtx.Interaction.present({ content: "nope", title: "read request" }),
            )
            return {
              parentEnvEmpty: Object.keys(extensionCtx.Process.parentEnv).length === 0,
              processDenied: Exit.isFailure(processExit),
              followUpDenied: Exit.isFailure(followUpExit),
              interactionDenied: Exit.isFailure(interactionExit),
            }
          }),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* resolved.rpcRegistry.run(
        extensionId,
        cap.id,
        {},
        testExtensionHostContext({
          sessionId: SessionId.make("read-request-session"),
          branchId: BranchId.make("read-request-branch"),
        }),
        {
          intent: "read",
        },
      )
      expect(result).toEqual({
        parentEnvEmpty: true,
        processDenied: true,
        followUpDenied: true,
        interactionDenied: true,
      })
    }),
  )

  it.live("dispatches slash-decorated request capabilities through the rpc registry", () =>
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
        contributions: { requests: [cap] },
      }
      const resolved = resolveExtensions([ext])
      const result = yield* resolved.rpcRegistry.run(extensionId, cap.id, { value: "hi" }, ctx, {
        intent: "write",
      })
      expect(result).toEqual({ value: "hi" })
    }),
  )

  it.live("dispatches slash action capabilities through the public command registry", () =>
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
        contributions: { actions: [cap] },
      }
      const resolved = resolveExtensions([ext])
      const result = yield* resolved.rpcRegistry.run(extensionId, cap.id, { value: "hi" }, ctx, {
        intent: "write",
      })
      expect(result).toEqual({ value: "hi" })
    }),
  )

  it.live("provides ExtensionContext to action handlers", () =>
    Effect.gen(function* () {
      const cap = action({
        id: "context-action",
        name: "Context Action",
        description: "Action with host context service",
        surface: "slash",
        input: Schema.Struct({}),
        output: Schema.Struct({ hasRunProcess: Schema.Boolean }),
        execute: () =>
          Effect.gen(function* () {
            const extensionCtx = yield* ExtensionContext
            return { hasRunProcess: "run" in extensionCtx.Process }
          }),
      })
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "/test/context-action",
        contributions: { actions: [cap] },
      }
      const resolved = resolveExtensions([ext])
      const result = yield* resolved.rpcRegistry.run(
        extensionId,
        cap.id,
        {},
        testExtensionHostContext({
          sessionId: SessionId.make("action-context-session"),
          branchId: BranchId.make("action-context-branch"),
        }),
        { intent: "write" },
      )
      expect(result).toEqual({ hasRunProcess: true })
    }),
  )

  it.live("public command registry rejects palette-only action capabilities", () =>
    Effect.gen(function* () {
      const cap = action({
        id: "private-ping",
        name: "Private Ping",
        description: "Private action",
        surface: "palette",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (input) => Effect.succeed({ value: input.value }),
      })
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "/test/private-action",
        contributions: { actions: [cap] },
      }
      const resolved = resolveExtensions([ext])
      const result = yield* expectRpcFailure(
        resolved.rpcRegistry.run(extensionId, cap.id, { value: "hi" }, ctx, {
          intent: "write",
        }),
      )
      expect(Schema.is(CapabilityNotFoundError)(result)).toBe(true)
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
          contributions: { requests: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-private-action",
          contributions: { actions: [project] },
        },
      ])
      const result = yield* resolved.rpcRegistry.run(
        extensionId,
        project.id,
        { value: "hi" },
        ctx,
        {
          intent: "write",
        },
      )
      expect(result).toEqual({ value: "hi" })
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
          contributions: { requests: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-public-action",
          contributions: { actions: [project] },
        },
      ])
      const result = yield* expectRpcFailure(
        resolved.rpcRegistry.run(extensionId, builtin.id, { value: "hi" }, ctx, {
          intent: "read",
        }),
      )
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
      expect(result.reason).toContain("intent mismatch")
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
          contributions: { requests: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-tool",
          contributions: { tools: [project] },
        },
      ])
      const result = yield* expectRpcFailure(
        resolved.rpcRegistry.run(extensionId, builtin.id, { value: "hi" }, ctx, {
          intent: "read",
        }),
      )
      expect(Schema.is(CapabilityNotFoundError)(result)).toBe(true)
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
          contributions: { requests: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-tool",
          contributions: { tools: [project] },
        },
      ])
      const result = yield* expectRpcFailure(
        resolved.rpcRegistry.run(extensionId, builtin.id, { value: "hi" }, ctx, {
          intent: "read",
        }),
      )
      expect(Schema.is(CapabilityNotFoundError)(result)).toBe(true)
    }),
  )

  it.live("scope precedence shadows lower-scope request capabilities by identity", () =>
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

      const writeResult = yield* expectRpcFailure(
        resolved.rpcRegistry.run(extensionId, readCap.id, null, ctx, { intent: "write" }),
      )
      expect(Schema.is(CapabilityError)(writeResult)).toBe(true)
      if (!Schema.is(CapabilityError)(writeResult)) return
      expect(writeResult.reason).toContain("intent mismatch")
    }),
  )

  it.live("input decode failure is wrapped in CapabilityError", () =>
    Effect.gen(function* () {
      const cap = echoRequest()
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* expectRpcFailure(
        resolved.rpcRegistry.run(extensionId, cap.id, { value: 42 }, ctx, { intent: "read" }),
      )
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
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
        execute: () => Effect.succeed({ value: 42 } as unknown as { value: string }),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* expectRpcFailure(
        resolved.rpcRegistry.run(extensionId, cap.id, { value: "x" }, ctx, { intent: "read" }),
      )
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
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
      const result = yield* expectRpcFailure(
        resolved.rpcRegistry.run(extensionId, cap.id, { value: "x" }, ctx, { intent: "read" }),
      )
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
      expect(result.reason).toMatch(/handler defect/)
    }),
  )
})
