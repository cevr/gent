import {
  Context,
  Effect,
  type Fiber,
  Layer,
  Ref,
  Schema,
  ScopedRef,
  Semaphore,
  SubscriptionRef,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { type TurnProjection } from "@gent/core/extensions/api"
import {
  ExecutorState,
  projectSnapshot,
  transitionConnect,
  transitionConnected,
  transitionConnectionFailed,
  transitionDisconnect,
  viewForState,
} from "./actor.js"
import { ExecutorEndpoint, ExecutorMcpInspection, type ResolvedExecutorSettings } from "./domain.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import type { ExecutorSnapshotReply } from "./protocol.js"
import { ExecutorSidecar } from "./sidecar.js"

interface ExecutorReadShape {
  readonly snapshot: () => Effect.Effect<ExecutorSnapshotReply>
}

interface ExecutorWriteShape extends ExecutorReadShape {
  readonly connect: (cwd: string) => Effect.Effect<void>
  readonly disconnect: () => Effect.Effect<void>
}

interface ExecutorRuntimeShape extends ExecutorWriteShape {
  readonly turnProjection: () => Effect.Effect<TurnProjection>
}

export class ExecutorRead extends Context.Service<ExecutorRead, ExecutorReadShape>()(
  "@gent/extensions/src/executor/controller/ExecutorRead",
) {}

export class ExecutorWrite extends Context.Service<ExecutorWrite, ExecutorWriteShape>()(
  "@gent/extensions/src/executor/controller/ExecutorWrite",
) {}

export class ExecutorRuntime extends Context.Service<ExecutorRuntime, ExecutorRuntimeShape>()(
  "@gent/extensions/src/executor/controller/ExecutorRuntime",
) {}

export const ExecutorControllerLive = (
  cwd: string,
): Layer.Layer<
  ExecutorRuntime | ExecutorRead | ExecutorWrite,
  never,
  ExecutorSidecar | ExecutorMcpBridge | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const sidecar = yield* ExecutorSidecar
      const bridge = yield* ExecutorMcpBridge
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const state = yield* SubscriptionRef.make<ExecutorState>(ExecutorState.cases.Idle.make({}))
      const gate = yield* Semaphore.make(1)
      const connection = yield* ScopedRef.fromAcquire(
        Effect.succeed<Fiber.Fiber<void> | null>(null),
      )
      const generation = yield* Ref.make(0)

      const snapshot = () => SubscriptionRef.get(state).pipe(Effect.map(projectSnapshot))

      const setIfCurrent = (expectedGeneration: number, next: ExecutorState) =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            const currentGeneration = yield* Ref.get(generation)
            const current = yield* SubscriptionRef.get(state)
            if (currentGeneration !== expectedGeneration || current._tag !== "Connecting") return
            yield* SubscriptionRef.set(state, next)
          }),
        )

      const runConnection = (targetCwd: string, expectedGeneration: number) =>
        Effect.gen(function* () {
          const endpointRaw = yield* sidecar
            .resolveEndpoint(targetCwd)
            .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
          const endpoint = yield* Schema.decodeUnknownEffect(ExecutorEndpoint)(endpointRaw)
          const inspection = yield* bridge.inspect(endpoint.baseUrl).pipe(
            Effect.flatMap((raw) => Schema.decodeUnknownEffect(ExecutorMcpInspection)(raw)),
            Effect.orElseSucceed(() => undefined),
          )
          yield* setIfCurrent(
            expectedGeneration,
            transitionConnected(ExecutorState.cases.Connecting.make({ cwd: targetCwd }), {
              mode: endpoint.mode,
              baseUrl: endpoint.baseUrl,
              scopeId: endpoint.scope.id,
              executorPrompt: inspection?.instructions,
            }),
          )
        }).pipe(
          Effect.catchEager((cause) =>
            setIfCurrent(
              expectedGeneration,
              transitionConnectionFailed(
                ExecutorState.cases.Connecting.make({ cwd: targetCwd }),
                cause instanceof Error ? cause.message : String(cause),
              ),
            ),
          ),
          Effect.catchDefect((cause) =>
            setIfCurrent(
              expectedGeneration,
              transitionConnectionFailed(
                ExecutorState.cases.Connecting.make({ cwd: targetCwd }),
                cause instanceof Error ? cause.message : String(cause),
              ),
            ),
          ),
        )

      const connect = (targetCwd: string) =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(state)
            const next = transitionConnect(current, targetCwd)
            if (next === current) return
            const nextGeneration = yield* Ref.updateAndGet(generation, (n) => n + 1)
            yield* SubscriptionRef.set(state, next)
            yield* ScopedRef.set(
              connection,
              runConnection(targetCwd, nextGeneration).pipe(Effect.forkScoped),
            )
          }),
        )

      const disconnect = () =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(state)
            const next = transitionDisconnect(current)
            if (next === current) return
            yield* Ref.update(generation, (n) => n + 1)
            yield* ScopedRef.set(connection, Effect.succeed(null))
            yield* SubscriptionRef.set(state, next)
          }),
        )

      const runtime = {
        snapshot,
        connect,
        disconnect,
        turnProjection: () =>
          SubscriptionRef.get(state).pipe(Effect.map((current) => viewForState(current))),
      } satisfies ExecutorRuntimeShape

      const read = {
        snapshot: runtime.snapshot,
      } satisfies ExecutorReadShape
      const write = {
        snapshot: runtime.snapshot,
        connect: runtime.connect,
        disconnect: runtime.disconnect,
      } satisfies ExecutorWriteShape

      const bootstrap = Effect.gen(function* () {
        const settingsRaw = yield* sidecar
          .resolveSettings(cwd)
          .pipe(
            Effect.catchEager(() =>
              Effect.sync((): ResolvedExecutorSettings | undefined => undefined),
            ),
          )
        const settings = settingsRaw
        if (settings?.autoStart !== true) return
        yield* runtime.connect(cwd)
      }).pipe(
        Effect.catchDefect((cause) =>
          Effect.logError("executor.runtime.bootstrap.defect").pipe(
            Effect.annotateLogs({ defect: String(cause) }),
          ),
        ),
      )
      yield* bootstrap.pipe(Effect.forkIn(scope))

      return Layer.mergeAll(
        Layer.succeed(ExecutorRuntime, runtime),
        Layer.succeed(ExecutorWrite, write),
        Layer.succeed(ExecutorRead, read),
      )
    }),
  )
