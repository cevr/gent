/**
 * Extension capability registry regression locks.
 *
 * Model tools are compiled through the model tool registry. Public command
 * dispatch accepts slash-capable requests.
 */
import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Exit, type FileSystem, type Path, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { CapabilityError, CapabilityNotFoundError } from "@gent/core-internal/domain/capability"
import {
  ExtensionContext,
  request,
  tool,
  type RequestCapability,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import { provideCurrentHostCtx } from "../../src/runtime/agent/current-extension-host-context"
import { BranchId, ExtensionId, SessionId } from "@gent/core-internal/domain/ids"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"

const extensionId = ExtensionId.make("@test/c")
const ctx = testExtensionHostContext({
  sessionId: SessionId.make("s"),
  branchId: BranchId.make("b"),
})
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
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: (input) => Effect.succeed({ value: params?.value ?? input.value }),
  })

const pingRequest = (params?: { readonly id?: string; readonly value?: string }) =>
  request({
    id: params?.id ?? "ping",
    extensionId,
    slash: { name: "Ping", description: "Ping request" },
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: (input: { value: string }) => Effect.succeed({ value: params?.value ?? input.value }),
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
  effect: Effect.Effect<
    unknown,
    CapabilityError | CapabilityNotFoundError,
    FileSystem.FileSystem | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return yield* Effect.die("expected rpc failure")
    const reason = exit.cause.reasons.find(Cause.isFailReason)
    if (reason === undefined) return yield* Effect.die("expected failed cause")
    return reason.error
  })

const runRpc = (
  registry: ReturnType<typeof resolveExtensions>["rpcRegistry"],
  capabilityId: string,
  input: unknown,
  hostCtx = ctx,
) => registry.run(extensionId, capabilityId, input).pipe(provideCurrentHostCtx(hostCtx))

describe("extension capability registries", () => {
  const test = it.live.layer(BunServices.layer)

  test("dispatches request capabilities by (extensionId, capabilityId)", () =>
    Effect.gen(function* () {
      const cap = echoRequest()
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* runRpc(resolved.rpcRegistry, cap.id, { value: "hi" })
      expect(result).toEqual({ value: "hi" })
    }))

  test("request handlers receive ExtensionContext authority without intent ceremony", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "context-facade",
        extensionId,
        input: Schema.Struct({}),
        output: Schema.Struct({
          parentEnvValue: Schema.String,
          processFailed: Schema.Boolean,
          followUpQueued: Schema.Boolean,
          interactionPresented: Schema.Boolean,
        }),
        execute: () =>
          Effect.gen(function* () {
            const extensionCtx = yield* ExtensionContext
            const processExit = yield* Effect.exit(extensionCtx.Process.run("echo", ["hi"]))
            const followUpExit = yield* Effect.exit(
              extensionCtx.Session.queueFollowUp({ sourceId: "request", content: "ok" }),
            )
            const interactionExit = yield* Effect.exit(
              extensionCtx.Interaction.present({ content: "ok", title: "request" }),
            )
            return {
              parentEnvValue: extensionCtx.Process.parentEnv["TEST_VALUE"] ?? "",
              processFailed: Exit.isFailure(processExit),
              followUpQueued: Exit.isSuccess(followUpExit),
              interactionPresented: Exit.isSuccess(interactionExit),
            }
          }),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* runRpc(
        resolved.rpcRegistry,
        cap.id,
        {},
        testExtensionHostContext({
          sessionId: SessionId.make("request-session"),
          branchId: BranchId.make("request-branch"),
          host: { ...testExtensionHostContext().host, parentEnv: { TEST_VALUE: "visible" } },
          session: { queueFollowUp: () => Effect.void },
          interaction: { present: () => Effect.void },
        }),
      )
      expect(result).toEqual({
        parentEnvValue: "visible",
        processFailed: true,
        followUpQueued: true,
        interactionPresented: true,
      })
    }))

  test("dispatches slash-decorated request capabilities through the rpc registry", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "ping",
        extensionId,
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
      const result = yield* runRpc(resolved.rpcRegistry, cap.id, { value: "hi" })
      expect(result).toEqual({ value: "hi" })
    }))

  test("provides ExtensionContext to request handlers carrying slash metadata", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "context-request",
        extensionId,
        slash: { name: "Context Request", description: "Request with host context service" },
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
        sourcePath: "/test/context-request",
        contributions: { requests: [cap] },
      }
      const resolved = resolveExtensions([ext])
      const result = yield* runRpc(
        resolved.rpcRegistry,
        cap.id,
        {},
        testExtensionHostContext({
          sessionId: SessionId.make("request-context-session"),
          branchId: BranchId.make("request-context-branch"),
        }),
      )
      expect(result).toEqual({ hasRunProcess: true })
    }))

  test("higher-scope slash request shadows lower-scope slash request", () =>
    Effect.gen(function* () {
      const builtin = request({
        id: "shadowed",
        extensionId,
        slash: { name: "Shadowed", description: "Shadowed request" },
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: () => Effect.succeed({ value: "builtin" }),
      })
      const project = request({
        id: "shadowed",
        extensionId,
        slash: { name: "Project Override", description: "Project override request" },
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (input: { value: string }) => Effect.succeed({ value: input.value }),
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
          sourcePath: "/test/project-override-request",
          contributions: { requests: [project] },
        },
      ])
      const result = yield* runRpc(resolved.rpcRegistry, project.id, { value: "hi" })
      expect(result).toEqual({ value: "hi" })
    }))

  test("request dispatch follows higher-scope slash request shadowing lower request", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "same", value: "builtin-request" })
      const project = pingRequest({ id: "same", value: "project-request" })
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
          sourcePath: "/test/project-public-request",
          contributions: { requests: [project] },
        },
      ])
      const result = yield* runRpc(resolved.rpcRegistry, builtin.id, { value: "hi" })
      expect(result).toEqual({ value: "project-request" })
    }))

  test("request dispatch rejects higher-scope tool shadowing lower request", () =>
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
        runRpc(resolved.rpcRegistry, builtin.id, { value: "hi" }),
      )
      expect(Schema.is(CapabilityNotFoundError)(result)).toBe(true)
    }))

  test("request dispatch rejects lower request shadowed by higher-scope tool", () =>
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
        runRpc(resolved.rpcRegistry, builtin.id, { value: "hi" }),
      )
      expect(Schema.is(CapabilityNotFoundError)(result)).toBe(true)
    }))

  test("scope precedence shadows lower-scope request capabilities by identity", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "thing", value: "builtin" })
      const project = echoRequest({ id: "thing", value: "project" })
      const resolved = resolveExtensions([
        extWith("builtin", [builtin]),
        extWith("project", [project]),
      ])
      const result = yield* runRpc(resolved.rpcRegistry, project.id, { value: "x" })
      expect(result).toEqual({ value: "project" })
    }))

  test("scope precedence picks the winning request without intent matching", () =>
    Effect.gen(function* () {
      const lowerCap = request({
        id: "thing",
        extensionId,
        input: Schema.Unknown,
        output: Schema.Unknown,
        execute: () => Effect.succeed("builtin-write"),
      })
      const higherCap = request({
        id: "thing",
        extensionId,
        input: Schema.Unknown,
        output: Schema.Unknown,
        execute: () => Effect.succeed("project-read"),
      })
      const resolved = resolveExtensions([
        extWith("builtin", [lowerCap]),
        extWith("project", [higherCap]),
      ])

      const readResult = yield* runRpc(resolved.rpcRegistry, higherCap.id, null)
      expect(readResult).toBe("project-read")
    }))

  test("input decode failure is wrapped in CapabilityError", () =>
    Effect.gen(function* () {
      const cap = echoRequest()
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* expectRpcFailure(runRpc(resolved.rpcRegistry, cap.id, { value: 42 }))
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
      expect(result.reason).toMatch(/input decode failed/)
    }))

  test("output validation failure is wrapped in CapabilityError", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "bad",
        extensionId,
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: () => Effect.succeed({ value: 42 } as unknown as { value: string }),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* expectRpcFailure(runRpc(resolved.rpcRegistry, cap.id, { value: "x" }))
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
      expect(result.reason).toMatch(/output validation failed/)
    }))

  test("handler defects are coerced into typed CapabilityError", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "boom",
        extensionId,
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: () => Effect.die("boom"),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* expectRpcFailure(runRpc(resolved.rpcRegistry, cap.id, { value: "x" }))
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
      expect(result.reason).toMatch(/handler defect/)
    }))
})
