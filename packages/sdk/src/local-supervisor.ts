import { Cause, Deferred, Effect, Exit, Fiber, Ref, Schema, Scope, Semaphore } from "effect"
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
          const reason =
            state._tag === "disconnected"
              ? state.reason
              : `local runtime unavailable (state: ${state._tag})`
          return Effect.fail(new GentConnectionError({ message: reason }))
        }
        const method = (client as Record<string, unknown>)[key]
        if (typeof method !== "function") {
          return Effect.fail(new GentConnectionError({ message: `rpc method missing: ${key}` }))
        }
        return (method as (...methodArgs: ReadonlyArray<unknown>) => unknown)(...args)
      }
    },
  })

  return makeNamespacedClient(flatClient)
}

export interface LocalSupervisorOptions {
  /** When true, automatically reconnect on build failure or post-connect scope close.
   *  Uses exponential backoff: 1s → 2s → 4s → ... → 30s cap. */
  readonly autoReconnect?: boolean
  /** Called after a successful connect. Should complete (success or failure)
   *  when the connection is lost. Supervisor triggers reconnect on completion. */
  readonly watchConnection?: () => Effect.Effect<void>
}

/** Compute reconnect delay: exponential backoff 1s → 2s → 4s → 8s → 16s → 30s cap */
const reconnectDelayMs = (attempt: number): number => Math.min(1000 * Math.pow(2, attempt), 30_000)

export const startLocalSupervisor = <E, R>(
  buildClient: BuildLocalRpcClient<E, R>,
  mapError: (error: E | unknown) => GentConnectionError,
  options?: LocalSupervisorOptions,
): Effect.Effect<LocalSupervisor, GentConnectionError, R | Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const autoReconnect = options?.autoReconnect ?? false
      const supervisorScope = yield* Scope.Scope
      const supervisorServices = yield* Effect.context<R>()
      const listeners = new Set<(state: ConnectionState) => void>()
      const transitionLock = yield* Semaphore.make(1)
      const generationRef = yield* Ref.make(0)
      const stoppedRef = yield* Ref.make(false)
      const scopeRef = yield* Ref.make<Scope.Closeable | undefined>(undefined)
      const clientRef = yield* Ref.make<GentRpcClient | undefined>(undefined)
      const launchFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined)
      const initialReady = yield* Deferred.make<void>()
      const readyRef = yield* Ref.make(initialReady)
      const stateRef = yield* Ref.make<ConnectionState>({ _tag: "connecting" })
      const reconnectAttemptRef = yield* Ref.make(0)

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

      const interruptLaunch = Ref.getAndSet(launchFiberRef, undefined).pipe(
        Effect.flatMap((fiber) =>
          fiber === undefined ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.asVoid),
        ),
      )

      // Forward-declared; assigned after restartInternal is defined
      let triggerAutoReconnect: Effect.Effect<void> = Effect.void

      const launchGeneration = (generation: number, ready: Deferred.Deferred<void>) =>
        Effect.gen(function* () {
          const stopped = yield* Ref.get(stoppedRef)
          if (stopped) {
            return yield* new GentConnectionError({ message: "local runtime stopped" })
          }

          const scope = yield* Scope.make()
          yield* Ref.set(scopeRef, scope)
          const exit = yield* buildClient(scope).pipe(Effect.mapError(mapError), Effect.exit)
          if (Exit.isFailure(exit)) {
            yield* Scope.close(scope, exit)
            const currentScope = yield* Ref.get(scopeRef)
            if (currentScope === scope) {
              yield* Ref.set(scopeRef, undefined)
            }
            yield* Ref.set(clientRef, undefined)
            const squashed = Cause.squash(exit.cause)
            const error = Schema.is(GentConnectionError)(squashed) ? squashed : mapError(squashed)
            yield* Effect.logError("local-supervisor.launch.failed").pipe(
              Effect.annotateLogs({
                generation,
                error: error.message,
                cause: String(squashed),
              }),
            )
            const currentGeneration = yield* Ref.get(generationRef)
            const stoppedNow = yield* Ref.get(stoppedRef)
            if (currentGeneration !== generation || stoppedNow) {
              yield* Deferred.succeed(ready, void 0)
              return yield* error
            }
            yield* emit({ _tag: "disconnected", reason: error.message })
            yield* Deferred.succeed(ready, void 0)

            // Auto-reconnect: retry with exponential backoff instead of giving up
            if (autoReconnect) {
              const attempt = yield* Ref.getAndUpdate(reconnectAttemptRef, (n) => n + 1)
              const delayMs = reconnectDelayMs(attempt)
              yield* Effect.logWarning("local-supervisor.auto-reconnect.scheduled").pipe(
                Effect.annotateLogs({ generation, delayMs }),
              )
              yield* Effect.sleep(delayMs)
              yield* triggerAutoReconnect
              return
            }
            return yield* error
          }

          const currentGeneration = yield* Ref.get(generationRef)
          const stoppedNow = yield* Ref.get(stoppedRef)
          if (currentGeneration !== generation || stoppedNow) {
            yield* Scope.close(scope, Exit.void)
            const currentScope = yield* Ref.get(scopeRef)
            if (currentScope === scope) {
              yield* Ref.set(scopeRef, undefined)
            }
            yield* Deferred.succeed(ready, void 0)
            return
          }

          yield* Ref.set(clientRef, exit.value)
          yield* emit({ _tag: "connected", generation })
          yield* Deferred.succeed(ready, void 0)

          // Reset backoff counter on successful connect
          if (autoReconnect) {
            yield* Ref.set(reconnectAttemptRef, 0)
          }

          // Auto-reconnect: watch connection health and trigger reconnect on loss
          if (autoReconnect && options?.watchConnection !== undefined) {
            yield* options.watchConnection().pipe(
              Effect.catchEager(() => Effect.void),
              Effect.flatMap(() =>
                Effect.gen(function* () {
                  const currentGen = yield* Ref.get(generationRef)
                  const isStopped = yield* Ref.get(stoppedRef)
                  if (currentGen === generation && !isStopped) {
                    yield* Effect.logWarning(
                      "local-supervisor.connection-lost.auto-reconnect",
                    ).pipe(Effect.annotateLogs({ generation }))
                    yield* triggerAutoReconnect
                  }
                }),
              ),
              Effect.forkScoped,
            )
          }
        })

      const startLaunch = (generation: number, transition: ConnectionState) =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>()
          yield* Ref.set(readyRef, ready)
          yield* emit(transition)
          const fiber = yield* launchGeneration(generation, ready).pipe(
            Effect.catchEager(() => Effect.void),
            Effect.forkScoped,
          )
          yield* Ref.set(launchFiberRef, fiber)
        })

      const restartInternal = Effect.gen(function* () {
        const nextGeneration = (yield* Ref.get(generationRef)) + 1
        yield* Ref.set(generationRef, nextGeneration)
        yield* interruptLaunch
        yield* closeCurrentScope(true)
        yield* startLaunch(nextGeneration, {
          _tag: "reconnecting",
          attempt: nextGeneration,
          generation: nextGeneration,
        })
      })

      const restart = transitionLock.withPermits(1)(
        Effect.promise(() =>
          Effect.runPromiseWith(supervisorServices)(
            restartInternal.pipe(Effect.provideService(Scope.Scope, supervisorScope)),
          ),
        ),
      )

      // Wire up auto-reconnect trigger (uses restartInternal, defined above)
      triggerAutoReconnect = Effect.promise(() =>
        Effect.runPromiseWith(supervisorServices)(
          transitionLock
            .withPermits(1)(restartInternal)
            .pipe(
              Effect.provideService(Scope.Scope, supervisorScope),
              Effect.catchEager(() => Effect.void),
            ),
        ),
      )

      yield* transitionLock.withPermits(1)(
        startLaunch(0, {
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
            yield* interruptLaunch
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
