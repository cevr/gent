import {
  Context,
  Effect,
  type Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  ScopedRef,
  Semaphore,
  TxSubscriptionRef,
} from "effect"
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
import { ExecutorEndpoint, ExecutorMcpInspection } from "./domain.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import type { ExecutorSnapshotReply } from "./protocol.js"
import { ExecutorSidecar } from "./sidecar.js"

interface ExecutorReadService {
  readonly snapshot: Effect.Effect<ExecutorSnapshotReply>
}

interface ExecutorWriteService extends ExecutorReadService {
  readonly connect: (cwd: string) => Effect.Effect<void>
  readonly disconnect: Effect.Effect<void>
}

interface ExecutorRuntimeService extends ExecutorWriteService {
  readonly turnProjection: Effect.Effect<TurnProjection>
}

export class ExecutorRead extends Context.Service<ExecutorRead, ExecutorReadService>()(
  "@gent/extensions/src/executor/controller/ExecutorRead",
) {}

export class ExecutorWrite extends Context.Service<ExecutorWrite, ExecutorWriteService>()(
  "@gent/extensions/src/executor/controller/ExecutorWrite",
) {}

export class ExecutorRuntime extends Context.Service<ExecutorRuntime, ExecutorRuntimeService>()(
  "@gent/extensions/src/executor/controller/ExecutorRuntime",
) {}

export const ExecutorControllerLive = (
  cwd: string,
): Layer.Layer<
  ExecutorRuntime | ExecutorRead | ExecutorWrite,
  never,
  ExecutorSidecar | ExecutorMcpBridge
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const sidecar = yield* ExecutorSidecar
      const bridge = yield* ExecutorMcpBridge
      const state = yield* TxSubscriptionRef.make<ExecutorState>(ExecutorState.cases.Idle.make({}))
      const gate = yield* Semaphore.make(1)
      const connection = yield* ScopedRef.fromAcquire(
        Effect.succeed(Option.none<Fiber.Fiber<void>>()),
      )
      const generation = yield* Ref.make(0)

      const snapshot = TxSubscriptionRef.get(state).pipe(Effect.map(projectSnapshot))

      const setIfCurrent = (expectedGeneration: number, next: ExecutorState) =>
        Effect.gen(function* () {
          const currentGeneration = yield* Ref.get(generation)
          const current = yield* TxSubscriptionRef.get(state)
          if (currentGeneration !== expectedGeneration || current._tag !== "Connecting") return
          yield* TxSubscriptionRef.set(state, next)
        }).pipe(gate.withPermits(1))

      const runConnection = (targetCwd: string, expectedGeneration: number) =>
        Effect.gen(function* () {
          const endpointRaw = yield* sidecar.resolveEndpoint(targetCwd)
          const endpoint = yield* Schema.decodeEffect(ExecutorEndpoint)(endpointRaw)
          const inspection = yield* bridge.inspect(endpoint.baseUrl).pipe(
            Effect.flatMap((raw) => Schema.decodeEffect(ExecutorMcpInspection)(raw)),
            Effect.option,
          )
          yield* setIfCurrent(
            expectedGeneration,
            transitionConnected(ExecutorState.cases.Connecting.make({ cwd: targetCwd }), {
              mode: endpoint.mode,
              baseUrl: endpoint.baseUrl,
              scopeId: endpoint.scope.id,
              executorPrompt: Option.getOrUndefined(
                inspection.pipe(
                  Option.flatMap((value) => Option.fromNullishOr(value.instructions)),
                ),
              ),
            }),
          )
        }).pipe(
          Effect.catchEager((cause) => {
            let message = String(cause)
            if (cause instanceof Error) message = cause.message
            return setIfCurrent(
              expectedGeneration,
              transitionConnectionFailed(
                ExecutorState.cases.Connecting.make({ cwd: targetCwd }),
                message,
              ),
            )
          }),
          Effect.catchDefect((cause) => {
            let message = String(cause)
            if (cause instanceof Error) message = cause.message
            return setIfCurrent(
              expectedGeneration,
              transitionConnectionFailed(
                ExecutorState.cases.Connecting.make({ cwd: targetCwd }),
                message,
              ),
            )
          }),
        )

      const connect = (targetCwd: string) =>
        Effect.gen(function* () {
          const current = yield* TxSubscriptionRef.get(state)
          const next = transitionConnect(current, targetCwd)
          if (next === current) return
          const nextGeneration = yield* Ref.updateAndGet(generation, (n) => n + 1)
          yield* TxSubscriptionRef.set(state, next)
          yield* ScopedRef.set(
            connection,
            runConnection(targetCwd, nextGeneration).pipe(
              Effect.forkScoped,
              Effect.map(Option.some),
            ),
          )
        }).pipe(gate.withPermits(1))

      const disconnect: Effect.Effect<void> = Effect.gen(function* () {
        const current = yield* TxSubscriptionRef.get(state)
        const next = transitionDisconnect(current)
        if (next === current) return
        yield* Ref.update(generation, (n) => n + 1)
        yield* ScopedRef.set(connection, Effect.succeed(Option.none()))
        yield* TxSubscriptionRef.set(state, next)
      }).pipe(gate.withPermits(1))

      const runtime = {
        snapshot,
        connect,
        disconnect,
        turnProjection: TxSubscriptionRef.get(state).pipe(Effect.map(viewForState)),
      } satisfies ExecutorRuntimeService

      const read = {
        snapshot: runtime.snapshot,
      } satisfies ExecutorReadService
      const write = {
        snapshot: runtime.snapshot,
        connect: runtime.connect,
        disconnect: runtime.disconnect,
      } satisfies ExecutorWriteService

      const bootstrap = Effect.gen(function* () {
        const settings = yield* sidecar.resolveSettings(cwd).pipe(Effect.option)
        if (Option.isNone(settings) || settings.value.autoStart !== true) return
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
