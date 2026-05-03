import { describe, expect, it } from "effect-bun-test"
/**
 * Executor integration tests — tool execution with mocked services,
 * and runtime lifecycle through the process-scoped executor resource.
 *
 * Connection state is volatile per process, so the old "state persists via
 * durability" test is gone. Public commands exercise the typed Executor
 * RPC/controller services end-to-end.
 */
import { Deferred, Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { Provider } from "@gent/core/providers/provider"
import { Gent } from "@gent/sdk"
import type { LoadedExtension } from "../../src/domain/extension.js"
import {
  type ExecutorMcpToolResult,
  type ResolvedExecutorSettings,
  ExecutorSettingsDefaults,
  EXECUTOR_EXTENSION_ID,
} from "@gent/extensions/executor/domain"
import { ExecutorMcpBridge } from "@gent/extensions/executor/mcp-bridge"
import { ExecutorSidecar } from "@gent/extensions/executor/sidecar"
import { ExecutorRpc, type ExecutorSnapshotReply } from "@gent/extensions/executor/protocol"
import {
  ExecutorControllerLive,
  ExecutorRead,
  ExecutorWrite,
} from "@gent/extensions/executor/controller"
import { ExecuteTool, ResumeTool } from "@gent/extensions/executor/tools"
import { EventStore } from "@gent/core/domain/event"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { defineResource } from "@gent/core/domain/contribution"
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import { buildExtensionLayers } from "../../src/runtime/profile"
import { e2ePreset } from "./helpers/test-preset"
import { getToolEffect } from "@gent/core/extensions/api"
// Tool execution now flows through Gent metadata on the native Effect tool.
// Tests provide all needed services; narrow R so runPromise/it.live accept it.
const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>
// ── Tool test helpers ──
const readySnapshot: ExecutorSnapshotReply = {
  status: "ready",
  baseUrl: "http://127.0.0.1:4788",
}
const notReadySnapshot: ExecutorSnapshotReply = {
  status: "idle",
}
const makeToolCtx = (snapshot: ExecutorSnapshotReply | undefined) =>
  testToolContext({
    extension: {
      request: () => Effect.succeed(snapshot as never),
    },
  })
const successResult: ExecutorMcpToolResult = {
  text: "Hello from Executor",
  structuredContent: { answer: 42 },
  isError: false,
}
const errorResult: ExecutorMcpToolResult = {
  text: "Tool not found: nonexistent",
  structuredContent: null,
  isError: true,
}
const waitingResult: ExecutorMcpToolResult = {
  text: "Waiting for approval",
  structuredContent: null,
  isError: false,
  executionId: "exec-abc-123",
}
// ── Runtime lifecycle helpers ──
const mockEndpoint = {
  mode: "local" as const,
  baseUrl: "http://127.0.0.1:4788",
  ownedByGent: true,
  scope: { id: "scope-1", name: "test", dir: "/test" },
}
const mockInspection = {
  instructions: "Use tools.search to discover APIs",
  tools: [{ name: "execute" }],
}
/**
 * Build a `LoadedExtension` carrying:
 *   - `resources` — sidecar+bridge plus ExecutorRuntime in one resource layer.
 *     The controller depends on sidecar+bridge, so the layer is composed with
 *     `provideMerge` instead of relying on sibling resource cross-wiring.
 */
const makeExecutorExtension = (overrides?: {
  sidecar?: Parameters<typeof ExecutorSidecar.Test>[0]
  bridge?: Parameters<typeof ExecutorMcpBridge.Test>[0]
  settings?: Partial<ResolvedExecutorSettings>
}): {
  extension: LoadedExtension
  layer: Layer.Layer<never>
} => {
  const settings: ResolvedExecutorSettings = {
    ...ExecutorSettingsDefaults,
    ...overrides?.settings,
  }
  const sidecarLayer = ExecutorSidecar.Test({
    resolveEndpoint: () => Effect.succeed(mockEndpoint),
    resolveSettings: () => Effect.succeed(settings),
    ...overrides?.sidecar,
  })
  const bridgeLayer = ExecutorMcpBridge.Test({
    inspect: () => Effect.succeed(mockInspection),
    ...overrides?.bridge,
  })
  const sidecarBridgeLayer = Layer.merge(sidecarLayer, bridgeLayer)
  const executorLayer = Layer.provideMerge(ExecutorControllerLive("/test"), sidecarBridgeLayer)
  const extension: LoadedExtension = {
    manifest: { id: EXECUTOR_EXTENSION_ID },
    scope: "builtin",
    sourcePath: "builtin",
    contributions: {
      rpc: [ExecutorRpc.Start, ExecutorRpc.Stop, ExecutorRpc.GetSnapshot],
      resources: [
        defineResource({
          scope: "process",
          layer: executorLayer,
        }),
      ],
    },
  }
  return { extension, layer: sidecarBridgeLayer as Layer.Layer<never> }
}
const makeRuntimeLayer = (extension: LoadedExtension) => {
  const storage = Layer.orDie(Storage.Test())
  const extLayers = (extension.contributions.resources ?? [])
    .filter((r) => r.scope === "process")
    .map((r) => r.layer as Layer.Layer<any, never, any>)
  const baseStack = Layer.mergeAll(storage, BunServices.layer)
  const machineWithResources = extLayers.reduce<Layer.Layer<any, never, any>>(
    (acc, resource) => Layer.provideMerge(resource, acc),
    baseStack,
  )
  return Layer.mergeAll(machineWithResources, EventStore.Memory)
}
const executorSnapshot = Effect.gen(function* () {
  const executor = yield* ExecutorRead
  return yield* executor.snapshot()
})
const waitForExecutorStatus = (status: ExecutorSnapshotReply["status"]) =>
  Effect.gen(function* () {
    const executor = yield* ExecutorRead
    return yield* waitFor(
      executor
        .snapshot()
        .pipe(
          Effect.catchEager(() => Effect.succeed(undefined as ExecutorSnapshotReply | undefined)),
        ),
      (snap) => snap?.status === status,
      3000,
      `executor status = ${status}`,
    ).pipe(Effect.catchEager(() => Effect.succeed(undefined as never)))
  })
// ── Tool tests ──
describe("Executor tools", () => {
  it.live("execute calls MCP bridge and returns result text", () =>
    Effect.gen(function* () {
      const bridgeLayer = ExecutorMcpBridge.Test({
        execute: (_baseUrl, _code) => Effect.succeed(successResult),
      })
      const ctx = makeToolCtx(readySnapshot)
      const result = yield* narrowR(
        getToolEffect(ExecuteTool)({ code: "tools.search({ query: 'api' })" }, ctx).pipe(
          Effect.provide(bridgeLayer),
        ),
      )
      expect(result.text).toBe("Hello from Executor")
      expect(result.structuredContent).toEqual({ answer: 42 })
    }),
  )
  it.live("execute Effect.fails when MCP returns isError: true", () =>
    Effect.gen(function* () {
      const bridgeLayer = ExecutorMcpBridge.Test({
        execute: () => Effect.succeed(errorResult),
      })
      const ctx = makeToolCtx(readySnapshot)
      const exit = yield* Effect.exit(
        narrowR(
          getToolEffect(ExecuteTool)({ code: "bad()" }, ctx).pipe(Effect.provide(bridgeLayer)),
        ),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
  it.live("execute fails when actor not Ready", () =>
    Effect.gen(function* () {
      const bridgeLayer = ExecutorMcpBridge.Test({
        execute: () => Effect.succeed(successResult),
      })
      const ctx = makeToolCtx(notReadySnapshot)
      const exit = yield* Effect.exit(
        narrowR(getToolEffect(ExecuteTool)({ code: "x" }, ctx).pipe(Effect.provide(bridgeLayer))),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
  it.live("execute returns executionId when waiting_for_interaction", () =>
    Effect.gen(function* () {
      const bridgeLayer = ExecutorMcpBridge.Test({
        execute: () => Effect.succeed(waitingResult),
      })
      const ctx = makeToolCtx(readySnapshot)
      const result = yield* narrowR(
        getToolEffect(ExecuteTool)({ code: "api.call()" }, ctx).pipe(Effect.provide(bridgeLayer)),
      )
      expect(result.executionId).toBe("exec-abc-123")
      expect(result.text).toBe("Waiting for approval")
    }),
  )
  it.live("resume calls MCP bridge with parsed content", () =>
    Effect.gen(function* () {
      const captured: {
        executionId: string
        action: string
        content?: Record<string, unknown>
      }[] = []
      const bridgeLayer = ExecutorMcpBridge.Test({
        resume: (_baseUrl, executionId, action, content) => {
          captured.push({ executionId, action, content })
          return Effect.succeed(successResult)
        },
      })
      const ctx = makeToolCtx(readySnapshot)
      yield* narrowR(
        getToolEffect(ResumeTool)(
          {
            executionId: "exec-1",
            action: "accept" as "accept" | "decline" | "cancel",
            content: '{"approved": true}',
          },
          ctx,
        ).pipe(Effect.provide(bridgeLayer)),
      )
      expect(captured).toHaveLength(1)
      expect(captured[0]!.executionId).toBe("exec-1")
      expect(captured[0]!.action).toBe("accept")
      expect(captured[0]!.content).toEqual({ approved: true })
    }),
  )
  it.live("resume fails with invalid JSON content", () =>
    Effect.gen(function* () {
      const bridgeLayer = ExecutorMcpBridge.Test({
        resume: () => Effect.succeed(successResult),
      })
      const ctx = makeToolCtx(readySnapshot)
      const exit = yield* Effect.exit(
        narrowR(
          getToolEffect(ResumeTool)(
            {
              executionId: "exec-1",
              action: "accept" as "accept" | "decline" | "cancel",
              content: "not valid json{{{",
            },
            ctx,
          ).pipe(Effect.provide(bridgeLayer)),
        ),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
  it.live("resume fails when actor not Ready", () =>
    Effect.gen(function* () {
      const bridgeLayer = ExecutorMcpBridge.Test({
        resume: () => Effect.succeed(successResult),
      })
      const ctx = makeToolCtx(notReadySnapshot)
      const exit = yield* Effect.exit(
        narrowR(
          getToolEffect(ResumeTool)(
            {
              executionId: "exec-1",
              action: "decline" as "accept" | "decline" | "cancel",
            },
            ctx,
          ).pipe(Effect.provide(bridgeLayer)),
        ),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
})
// ── Runtime lifecycle ──
//
// The runtime owns state and drives sidecar connection fibers directly.
// Snapshot reads route through `ExecutorRead.snapshot()` and
// `ExecutorWrite` commands.
describe("Executor runtime lifecycle", () => {
  it.live(
    "autoStart=true → Idle → Connecting → Ready",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: true } })
      return narrowR(
        Effect.gen(function* () {
          yield* waitForExecutorStatus("ready")
          const reply = yield* executorSnapshot
          expect(reply.status).toBe("ready")
          expect(reply.baseUrl).toBe("http://127.0.0.1:4788")
        })
          .pipe(Effect.provide(makeRuntimeLayer(extension)))
          .pipe(Effect.timeout("8 seconds")),
      )
    },
    10000,
  )
  it.live(
    "autoStart=false → stays Idle",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: false } })
      return narrowR(
        Effect.gen(function* () {
          // autoStart=false means the runtime does not connect.
          yield* waitForExecutorStatus("idle")
          const reply = yield* executorSnapshot
          expect(reply.status).toBe("idle")
        })
          .pipe(Effect.provide(makeRuntimeLayer(extension)))
          .pipe(Effect.timeout("8 seconds")),
      )
    },
    10000,
  )
  it.live(
    "sidecar failure → Connecting → Error",
    () => {
      const { extension } = makeExecutorExtension({
        sidecar: {
          resolveEndpoint: () => Effect.fail(new Error("port exhausted") as never),
          resolveSettings: () => Effect.succeed(ExecutorSettingsDefaults),
        },
      })
      return narrowR(
        Effect.gen(function* () {
          yield* waitForExecutorStatus("error")
          const reply = yield* executorSnapshot
          expect(reply.status).toBe("error")
          expect(reply.errorMessage).toBeDefined()
        })
          .pipe(Effect.provide(makeRuntimeLayer(extension)))
          .pipe(Effect.timeout("8 seconds")),
      )
    },
    10000,
  )
  it.live(
    "/executor-start command → Connecting → Ready",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: false } })
      return narrowR(
        Effect.gen(function* () {
          const executor = yield* ExecutorWrite
          yield* waitForExecutorStatus("idle")
          const before = yield* executorSnapshot
          expect(before.status).toBe("idle")
          yield* executor.connect("/test")
          yield* waitForExecutorStatus("ready")
          const after = yield* executorSnapshot
          expect(after.status).toBe("ready")
        })
          .pipe(Effect.provide(makeRuntimeLayer(extension)))
          .pipe(Effect.timeout("8 seconds")),
      )
    },
    10000,
  )
  it.live(
    "/executor-stop from Ready → Idle",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: true } })
      return narrowR(
        Effect.gen(function* () {
          const executor = yield* ExecutorWrite
          yield* waitForExecutorStatus("ready")
          const before = yield* executorSnapshot
          expect(before.status).toBe("ready")
          yield* executor.disconnect()
          yield* waitForExecutorStatus("idle")
          const after = yield* executorSnapshot
          expect(after.status).toBe("idle")
        })
          .pipe(Effect.provide(makeRuntimeLayer(extension)))
          .pipe(Effect.timeout("8 seconds")),
      )
    },
    10000,
  )
  it.live(
    "public executor commands list and dispatch through extension.request",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: false } })
      return narrowR(
        Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* Provider.Sequence([])
            const { client } = yield* Gent.test(
              createE2ELayer({ ...e2ePreset, providerLayer, extensions: [extension] }),
            )
            const { sessionId: createdSessionId, branchId: createdBranchId } =
              yield* client.session.create({
                cwd: "/tmp/gent-executor-public-command",
              })
            const commands = yield* client.extension.listSlashCommands({
              sessionId: createdSessionId,
            })
            expect(commands.map((command) => command.name).sort()).toEqual([
              "executor-start",
              "executor-stop",
            ])
            yield* client.extension.request({
              sessionId: createdSessionId,
              branchId: createdBranchId,
              extensionId: EXECUTOR_EXTENSION_ID,
              capabilityId: "executor-start",
              intent: "write",
              input: "",
            })
            const ready = (yield* waitFor(
              client.extension.request({
                sessionId: createdSessionId,
                branchId: createdBranchId,
                extensionId: EXECUTOR_EXTENSION_ID,
                capabilityId: "executor.snapshot",
                intent: "read",
                input: {},
              }) as Effect.Effect<ExecutorSnapshotReply, never, never>,
              (snapshot) => snapshot.status === "ready",
              3000,
              "executor public command ready",
            )) as ExecutorSnapshotReply
            expect(ready.status).toBe("ready")
            yield* client.extension.request({
              sessionId: createdSessionId,
              branchId: createdBranchId,
              extensionId: EXECUTOR_EXTENSION_ID,
              capabilityId: "executor-stop",
              intent: "write",
              input: "",
            })
            const idle = (yield* waitFor(
              client.extension.request({
                sessionId: createdSessionId,
                branchId: createdBranchId,
                extensionId: EXECUTOR_EXTENSION_ID,
                capabilityId: "executor.snapshot",
                intent: "read",
                input: {},
              }) as Effect.Effect<ExecutorSnapshotReply, never, never>,
              (snapshot) => snapshot.status === "idle",
              3000,
              "executor public command idle",
            )) as ExecutorSnapshotReply
            expect(idle.status).toBe("idle")
          }).pipe(Effect.timeout("8 seconds")),
        ),
      )
    },
    10000,
  )
  it.live(
    "/executor-start from Error → Connecting → Ready (retry)",
    () => {
      let callCount = 0
      const { extension } = makeExecutorExtension({
        settings: { autoStart: true },
        sidecar: {
          resolveEndpoint: () => {
            callCount++
            if (callCount === 1) return Effect.fail(new Error("first try fails") as never)
            return Effect.succeed(mockEndpoint)
          },
          resolveSettings: () => Effect.succeed(ExecutorSettingsDefaults),
        },
      })
      return narrowR(
        Effect.gen(function* () {
          const executor = yield* ExecutorWrite
          // First boot → autoStart Connect → resolveEndpoint fails → Error
          yield* waitForExecutorStatus("error")
          const mid = yield* executorSnapshot
          expect(mid.status).toBe("error")
          // Retry via command — second resolveEndpoint succeeds.
          yield* executor.connect("/test")
          yield* waitForExecutorStatus("ready")
          const after = yield* executorSnapshot
          expect(after.status).toBe("ready")
        })
          .pipe(Effect.provide(makeRuntimeLayer(extension)))
          .pipe(Effect.timeout("8 seconds")),
      )
    },
    10000,
  )
  // No persistence test: connection state is volatile per process. A
  // restored `Ready{baseUrl}` would point at a sidecar URL that no
  // longer exists; the runtime re-bootstraps from `Idle` via autoStart.
  // Regression lock: Disconnect mid-handshake must cancel
  // the in-flight `runConnection` fork. Without the cancel, the
  // sidecar resolve eventually `tell`s `Connected` and pushes the
  // actor to Ready against user intent.
  it.live(
    "Disconnect during Connecting cancels in-flight handshake",
    () => {
      const sidecarGate = Deferred.makeUnsafe<void>()
      const { extension } = makeExecutorExtension({
        settings: { autoStart: true },
        sidecar: {
          // resolveEndpoint blocks until the gate opens — long enough
          // for a Disconnect to arrive while state is Connecting.
          resolveEndpoint: () => Deferred.await(sidecarGate).pipe(Effect.as(mockEndpoint)),
          resolveSettings: () => Effect.succeed(ExecutorSettingsDefaults),
        },
      })
      return narrowR(
        Effect.gen(function* () {
          const executor = yield* ExecutorWrite
          // Wait until the runtime enters Connecting (autoStart fired).
          yield* waitForExecutorStatus("connecting")
          // Disconnect mid-handshake.
          yield* executor.disconnect()
          // Runtime should land on Idle promptly (Connecting → Idle).
          yield* waitForExecutorStatus("idle")
          // Now release the (cancelled) in-flight handshake. If it races
          // back to Ready, the regression has reappeared.
          yield* Deferred.succeed(sidecarGate, undefined)
          yield* Effect.sleep("100 millis")
          const final = yield* executorSnapshot
          expect(final.status).toBe("idle")
        })
          .pipe(Effect.provide(makeRuntimeLayer(extension)))
          .pipe(Effect.timeout("8 seconds")),
      )
    },
    10000,
  )
  // Regression lock: the executor resource composes its own dependent
  // services, and the production composer feeds platform/base services
  // into that resource layer. Validation: drive autoStart through
  // `buildExtensionLayers` and assert state reaches `ready`.
  it.live(
    "buildExtensionLayers wires runner so autoStart reaches Ready",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: true } })
      const resolved = resolveExtensions([extension])
      const layer = buildExtensionLayers(resolved).pipe(
        Layer.provideMerge(Storage.Test()),
        Layer.provideMerge(EventStore.Memory),
        Layer.provideMerge(BunServices.layer),
      )
      return narrowR(
        Effect.gen(function* () {
          yield* waitForExecutorStatus("ready")
          const reply = yield* executorSnapshot
          expect(reply.status).toBe("ready")
        })
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("8 seconds")),
      )
    },
    10000,
  )
})
