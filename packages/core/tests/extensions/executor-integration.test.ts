import { describe, expect, it } from "effect-bun-test"
/**
 * Executor integration tests — tool execution with mocked services,
 * and actor lifecycle through the actor primitive (W10-1c).
 *
 * The executor uses a `Behavior` actor + Layer-scoped
 * `ExecutorConnectionRunner` (Option G). Connection state is volatile
 * per process — the actor has no persistence — so the old "state
 * persists via durability" test is gone; cross-extension Receptionist
 * discovery is exercised end-to-end here via typed Executor RPC/controller
 * services, while the actor remains the source of truth for connection state.
 */
import { Deferred, Effect, Layer } from "effect"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { Provider } from "@gent/core/providers/provider"
import { Gent } from "@gent/sdk"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { executorActor } from "@gent/extensions/executor/actor"
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
import {
  ExecutorConnectionRunner,
  ExecutorConnectionRunnerLayer,
} from "@gent/extensions/executor/connection-runner"
import { ActorRouter } from "../../src/runtime/extensions/resource-host/actor-router"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { ActorHost } from "../../src/runtime/extensions/actor-host"
import { EventStore } from "@gent/core/domain/event"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { defineResource } from "@gent/core/domain/contribution"
import { resolveExtensions, type ResolvedExtensions } from "../../src/runtime/extensions/registry"
import { buildExtensionLayers } from "../../src/runtime/profile"
import { e2ePreset } from "./helpers/test-preset"
// Tool .effect crosses the erased runtime leaf boundary in tool().
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
// ── Actor lifecycle helpers ──
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
 *   - `actors: [executorActor]` — Behavior spawned by ActorHost.
 *   - `resources` — sidecar+bridge layer for the tools, plus the
 *     ExecutorConnectionRunner layer so connection work fires on entry
 *     to `Connecting`.
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
  // Connection runner layer — its R channel is closed by providing the
  // sidecar+bridge here so the resource's residual R is `ActorEngine |
  // Receptionist`, which the runtime supplies.
  const runnerLayer = ExecutorConnectionRunnerLayer("/test").pipe(Layer.provide(sidecarBridgeLayer))
  const extension: LoadedExtension = {
    manifest: { id: EXECUTOR_EXTENSION_ID },
    scope: "builtin",
    sourcePath: "builtin",
    contributions: {
      rpc: [ExecutorRpc.Start, ExecutorRpc.Stop, ExecutorRpc.GetSnapshot],
      actors: [executorActor],
      resources: [
        defineResource({
          scope: "process",
          layer: ExecutorControllerLive,
        }),
        defineResource({
          tag: ExecutorConnectionRunner,
          scope: "process",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: sidecar+bridge are mocked, so layer R is closed at construction
          layer: runnerLayer as Layer.Layer<ExecutorConnectionRunner>,
        }),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: bare sidecar+bridge for the tools, A widened to unknown for bucket fit
        defineResource({
          scope: "process",
          layer: sidecarBridgeLayer as Layer.Layer<unknown>,
        }) as never,
      ],
    },
  }
  return { extension, layer: sidecarBridgeLayer as Layer.Layer<never> }
}
const makeRuntimeLayer = (extension: LoadedExtension) => {
  const turnControl = ExtensionTurnControl.Test()
  const storage = Storage.Test()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActorHost only walks `extensions`
  const resolved = { extensions: [extension] } as unknown as ResolvedExtensions
  // Build the actor runtime stack: `ActorEngine.Live` provides engine +
  // Receptionist; `ActorHost.fromResolved` spawns contributed behaviors;
  // both stay in the output set so the runner layer can pull them. The
  // resource-layer chain below is provideMerged onto this stack so it
  // shares the same engine instance that the host registers actors with.
  const machine = ActorRouter.Live([extension]).pipe(
    Layer.provideMerge(turnControl),
    Layer.provideMerge(ActorHost.fromResolved(resolved)),
    Layer.provideMerge(ActorEngine.Live),
  )
  // Pull every `scope: "process"` resource layer from the extension and
  // chain them onto `machine` via `Layer.provideMerge` so the runner's
  // `ActorEngine | Receptionist` requirements resolve to the same
  // instance the host registers actors with.
  const extLayers = (extension.contributions.resources ?? [])
    .filter((r) => r.scope === "process")
    .map(
      (r) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion -- test fixture: closed-R typed elsewhere
        r.layer as Layer.Layer<any, never, any>,
    )
  // Stack the resource layers on top of `machine + storage` so each
  // resource's `ActorEngine | Receptionist | Storage | …` deps are
  // satisfied by the underlying stack. `provideMerge` keeps the
  // resource's outputs (e.g. `ExecutorConnectionRunner`) in the result
  // and forces the resource layer to activate (otherwise an unused
  // output is dead-stripped, and the connection runner never starts).
  const baseStack = Layer.mergeAll(machine, storage)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture: extLayers carry open A; provideMerge widens, narrowed at consumption
  const machineWithResources = extLayers.reduce<Layer.Layer<any, never, any>>(
    (acc, resource) => Layer.provideMerge(resource, acc),
    baseStack,
  )
  return Layer.mergeAll(machineWithResources, EventStore.Memory, turnControl)
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
        ExecuteTool.effect({ code: "tools.search({ query: 'api' })" }, ctx).pipe(
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
        narrowR(ExecuteTool.effect({ code: "bad()" }, ctx).pipe(Effect.provide(bridgeLayer))),
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
        narrowR(ExecuteTool.effect({ code: "x" }, ctx).pipe(Effect.provide(bridgeLayer))),
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
        ExecuteTool.effect({ code: "api.call()" }, ctx).pipe(Effect.provide(bridgeLayer)),
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
        ResumeTool.effect(
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
          ResumeTool.effect(
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
          ResumeTool.effect(
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
// ── Actor lifecycle ──
//
// The runner observes the actor's state via `engine.subscribeState` and
// drives the sidecar connection on entry to `Connecting`. Snapshot reads
// route through `ExecutorRead.snapshot()` and `ExecutorWrite` commands,
// exercising end-to-end cross-extension Receptionist discovery without
// the retired actor-route protocol shim.
describe("Executor actor lifecycle", () => {
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
          // autoStart=false means the runner does not tell `Connect` —
          // actor stays Idle.
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
            const commands = yield* client.extension.listCommands({ sessionId: createdSessionId })
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
  // longer exists; the actor ships without `persistence` and re-bootstraps
  // from `Idle` via autoStart. Cross-process persistence is covered by
  // `actor-host.test.ts > fromResolvedWithPersistence round-trips state`
  // for actors that DO opt in.
  // Regression for W10-1c B2: Disconnect mid-handshake must cancel
  // the in-flight `runConnection` fork. Without the cancel, the
  // sidecar resolve eventually `tell`s `Connected` and pushes the
  // actor to Ready against user intent.
  it.live(
    "Disconnect during Connecting cancels in-flight handshake (B2 regression)",
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
          // Wait until the actor enters Connecting (autoStart fired).
          yield* waitForExecutorStatus("connecting")
          // Disconnect mid-handshake.
          yield* executor.disconnect()
          // Actor should land on Idle promptly (Connecting → Idle).
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
  // Regression for W10-1c B1: production composer must cross-wire
  // `ActorEngine | Receptionist` into the resource layer's R channel.
  // `Layer.mergeAll(baseLayers, resourceLayer)` does NOT cross-wire,
  // so the `ExecutorConnectionRunner` layer would build silently dead
  // (its bootstrap fork swallows the "Service not found" defect).
  // Validation: drive autoStart through `buildExtensionLayers` (the
  // production composer) and assert state reaches `ready`.
  it.live(
    "buildExtensionLayers wires runner so autoStart reaches Ready (B1 regression)",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: true } })
      const resolved = resolveExtensions([extension])
      const layer = buildExtensionLayers(resolved).pipe(
        Layer.provideMerge(Storage.Test()),
        Layer.provideMerge(EventStore.Memory),
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
