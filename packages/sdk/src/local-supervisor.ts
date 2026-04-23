import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import type { GentRpcClient } from "@gent/core/server/rpcs.js"
import {
  GentConnectionError,
  type ConnectionState,
  type GentLifecycle,
} from "@gent/core/server/transport-contract.js"
import {
  makeFlatRpcClient,
  makeNamespacedClient,
  type GentNamespacedClient,
} from "./namespaced-client.js"
import { runSupervisorRestart } from "./supervisor-boundary.js"

type BuildLocalRpcClient<E, R> = (scope: Scope.Closeable) => Effect.Effect<GentRpcClient, E, R>
type StreamOptions = {
  readonly asQueue?: boolean | undefined
  readonly streamBufferSize?: number | undefined
}

interface LocalSupervisor {
  readonly client: GentNamespacedClient
  readonly lifecycle: GentLifecycle
}

interface LocalSupervisorResource extends LocalSupervisor {
  readonly stop: Effect.Effect<void>
}

const isStreamQueueRequest = (value: unknown): value is StreamOptions =>
  value !== null && typeof value === "object" && "asQueue" in value && value.asQueue === true

const disconnectedStreamResult = (args: ReadonlyArray<unknown>, error: GentConnectionError) => {
  if (isStreamQueueRequest(args[1])) {
    return Effect.gen(function* () {
      const queue = yield* Queue.make<never, GentConnectionError | Cause.Done>()
      yield* Queue.fail(queue, error)
      return Queue.asDequeue(queue)
    })
  }
  return Stream.fail(error)
}

const makeSwappableClient = (
  clientRef: Ref.Ref<GentRpcClient | undefined>,
  stateRef: Ref.Ref<ConnectionState>,
): GentNamespacedClient => {
  const route = <K extends keyof GentRpcClient>(key: K): GentRpcClient[K] => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return ((...args: ReadonlyArray<unknown>) => {
      const client = Ref.getUnsafe(clientRef)
      if (client === undefined) {
        const state = Ref.getUnsafe(stateRef)
        const reason =
          state._tag === "disconnected"
            ? state.reason
            : `local runtime unavailable (state: ${state._tag})`
        const error = new GentConnectionError({ message: reason })
        return key === "session.events" || key === "session.watchRuntime"
          ? disconnectedStreamResult(args, error)
          : Effect.fail(error)
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const method = client[key] as (...methodArgs: ReadonlyArray<unknown>) => unknown
      return method(...args)
    }) as GentRpcClient[K]
  }

  const flatClient = makeFlatRpcClient(route)

  return makeNamespacedClient(flatClient)
}

export const startLocalSupervisor = <E, R>(
  buildClient: BuildLocalRpcClient<E, R>,
  mapError: (error: E | unknown) => GentConnectionError,
): Effect.Effect<LocalSupervisor, GentConnectionError, R | Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
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
          runSupervisorRestart(supervisorServices, supervisorScope, restartInternal),
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
