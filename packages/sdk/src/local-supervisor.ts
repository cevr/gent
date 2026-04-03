import { Cause, Deferred, Effect, Exit, Ref, Scope, Semaphore } from "effect"
import type { RpcClient, RpcGroup } from "effect/unstable/rpc"
import type { GentRpcs } from "@gent/core/server/rpcs.js"
import {
  GentConnectionError,
  type ConnectionState,
  type GentLifecycle,
} from "@gent/core/server/transport-contract.js"
import { makeNamespacedClient, type GentNamespacedClient } from "./namespaced-client.js"

type GentRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof GentRpcs>>

type BuildLocalRpcClient<E, R> = (scope: Scope.Closeable) => Effect.Effect<GentRpcClient, E, R>

interface LocalSupervisor {
  readonly client: GentNamespacedClient
  readonly lifecycle: GentLifecycle
}

interface LocalSupervisorResource extends LocalSupervisor {
  readonly stop: Effect.Effect<void>
}

const makeSwappableClient = (
  clientRef: Ref.Ref<GentRpcClient | undefined>,
  stateRef: Ref.Ref<ConnectionState>,
): GentNamespacedClient => {
  const flatClient = new Proxy({} as GentRpcClient, {
    get(_target, key: string) {
      return (...args: ReadonlyArray<unknown>) => {
        const client = Ref.getUnsafe(clientRef)
        if (client === undefined) {
          const state = Ref.getUnsafe(stateRef)
          const reason = state._tag === "disconnected" ? state.reason : "local runtime unavailable"
          throw new GentConnectionError({ message: reason })
        }
        const method = (client as Record<string, unknown>)[key]
        if (typeof method !== "function") {
          throw new Error(`local supervisor rpc method missing: ${String(key)}`)
        }
        return (method as (...methodArgs: ReadonlyArray<unknown>) => unknown)(...args)
      }
    },
  })

  return makeNamespacedClient(flatClient)
}

export const startLocalSupervisor = <E, R>(
  buildClient: BuildLocalRpcClient<E, R>,
  mapError: (error: E | unknown) => GentConnectionError,
): Effect.Effect<LocalSupervisor, GentConnectionError, R | Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const supervisorServices = yield* Effect.services<R>()
      const listeners = new Set<(state: ConnectionState) => void>()
      const transitionLock = yield* Semaphore.make(1)
      const generationRef = yield* Ref.make(0)
      const stoppedRef = yield* Ref.make(false)
      const scopeRef = yield* Ref.make<Scope.Closeable | undefined>(undefined)
      const clientRef = yield* Ref.make<GentRpcClient | undefined>(undefined)
      const initialReady = yield* Deferred.make<void>()
      const readyRef = yield* Ref.make(initialReady)
      const stateRef = yield* Ref.make<ConnectionState>({ _tag: "connecting" })

      const emit = (state: ConnectionState) =>
        Effect.gen(function* () {
          yield* Ref.set(stateRef, state)
          for (const listener of listeners) listener(state)
        })

      const closeCurrentScope = (clearClient: boolean) =>
        Effect.gen(function* () {
          const currentScope = yield* Ref.getAndSet(scopeRef, undefined)
          if (clearClient) {
            yield* Ref.set(clientRef, undefined)
          }
          if (currentScope !== undefined) {
            yield* Scope.close(currentScope, Exit.void)
          }
        })

      const launchGeneration = (generation: number, transition: ConnectionState) =>
        Effect.gen(function* () {
          const stopped = yield* Ref.get(stoppedRef)
          if (stopped) {
            return yield* Effect.fail(new GentConnectionError({ message: "local runtime stopped" }))
          }

          const ready = yield* Deferred.make<void>()
          yield* Ref.set(readyRef, ready)
          yield* emit(transition)

          const scope = yield* Scope.make()
          const exit = yield* buildClient(scope).pipe(Effect.mapError(mapError), Effect.exit)
          if (Exit.isFailure(exit)) {
            yield* Scope.close(scope, exit)
            yield* Ref.set(clientRef, undefined)
            const error = mapError(Cause.squash(exit.cause))
            yield* emit({ _tag: "disconnected", reason: error.message })
            yield* Deferred.succeed(ready, void 0)
            return yield* Effect.fail(error)
          }

          yield* Ref.set(scopeRef, scope)
          yield* Ref.set(clientRef, exit.value)
          yield* emit({ _tag: "connected", generation })
          yield* Deferred.succeed(ready, void 0)
        })

      const restartInternal = Effect.gen(function* () {
        const nextGeneration = (yield* Ref.get(generationRef)) + 1
        yield* Ref.set(generationRef, nextGeneration)
        yield* closeCurrentScope(false)
        yield* launchGeneration(nextGeneration, {
          _tag: "reconnecting",
          attempt: nextGeneration,
          generation: nextGeneration,
        })
      })

      const restart = transitionLock.withPermits(1)(
        Effect.promise(() => Effect.runPromiseWith(supervisorServices)(restartInternal)),
      )

      yield* transitionLock.withPermits(1)(
        launchGeneration(0, {
          _tag: "connecting",
        }),
      )

      const lifecycle: GentLifecycle = {
        getState: () => Ref.getUnsafe(stateRef),
        subscribe: (listener) => {
          listeners.add(listener)
          listener(Ref.getUnsafe(stateRef))
          return () => {
            listeners.delete(listener)
          }
        },
        restart,
        waitForReady: Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          if (state._tag === "connected" || state._tag === "disconnected") return
          const ready = yield* Ref.get(readyRef)
          yield* Deferred.await(ready).pipe(Effect.catchEager(() => Effect.void))
        }),
      }

      const stop = transitionLock
        .withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.set(stoppedRef, true)
            yield* closeCurrentScope(true)
            yield* emit({ _tag: "disconnected", reason: "stopped" })
            const ready = yield* Ref.get(readyRef)
            yield* Deferred.succeed(ready, void 0)
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

      return {
        client: makeSwappableClient(clientRef, stateRef),
        lifecycle,
        stop,
      } satisfies LocalSupervisorResource
    }),
    (supervisor) => supervisor.stop,
  )
