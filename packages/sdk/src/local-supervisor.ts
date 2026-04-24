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
import { makeNamespacedClient, type GentNamespacedClient } from "./namespaced-client.js"
import { runSupervisorRestart } from "./supervisor-boundary.js"

type BuildLocalRpcClient<E, R> = (scope: Scope.Closeable) => Effect.Effect<GentRpcClient, E, R>
type StreamOptions = {
  readonly asQueue?: boolean | undefined
  readonly streamBufferSize?: number | undefined
}
type StreamSuccess<T> = T extends Stream.Stream<infer A, infer _E, infer _R> ? A : never
type StreamFailure<T> = T extends Stream.Stream<infer _A, infer E, infer _R> ? E : never
type StreamRequirements<T> = T extends Stream.Stream<infer _A, infer _E, infer R> ? R : never
type SessionEventsInput = Parameters<GentRpcClient["session.events"]>[0]
type SessionEventsOptions = Parameters<GentRpcClient["session.events"]>[1]
type SessionEventsStream = ReturnType<GentRpcClient["session.events"]>
type SessionEventsSuccess = StreamSuccess<SessionEventsStream>
type SessionEventsFailure = StreamFailure<SessionEventsStream>
type SessionEventsRequirements = StreamRequirements<SessionEventsStream>
type WatchRuntimeInput = Parameters<GentRpcClient["session.watchRuntime"]>[0]
type WatchRuntimeOptions = Parameters<GentRpcClient["session.watchRuntime"]>[1]
type WatchRuntimeStream = ReturnType<GentRpcClient["session.watchRuntime"]>
type WatchRuntimeSuccess = StreamSuccess<WatchRuntimeStream>
type WatchRuntimeFailure = StreamFailure<WatchRuntimeStream>
type WatchRuntimeRequirements = StreamRequirements<WatchRuntimeStream>

interface LocalSupervisor {
  readonly client: GentNamespacedClient
  readonly lifecycle: GentLifecycle
}

interface LocalSupervisorResource extends LocalSupervisor {
  readonly stop: Effect.Effect<void>
}

const unavailableError = (stateRef: Ref.Ref<ConnectionState>): GentConnectionError => {
  const state = Ref.getUnsafe(stateRef)
  const reason =
    state._tag === "disconnected"
      ? state.reason
      : `local runtime unavailable (state: ${state._tag})`

  return new GentConnectionError({ message: reason })
}

const disconnectedStreamResult = <A, E, R>(
  options: StreamOptions | undefined,
  error: GentConnectionError,
):
  | Stream.Stream<A, E | GentConnectionError, R>
  | Effect.Effect<Queue.Dequeue<A, E | GentConnectionError | Cause.Done>, never, Scope.Scope> => {
  if (options?.asQueue === true) {
    return Effect.gen(function* () {
      const queue = yield* Queue.make<A, E | GentConnectionError | Cause.Done>()
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
  const current = () => Ref.getUnsafe(clientRef)
  const disconnected = () => Effect.fail(unavailableError(stateRef))

  function sessionEvents(
    input: SessionEventsInput,
    options: SessionEventsOptions & { readonly asQueue: true },
  ): Effect.Effect<
    Queue.Dequeue<SessionEventsSuccess, SessionEventsFailure | GentConnectionError | Cause.Done>,
    never,
    Scope.Scope
  >
  function sessionEvents(
    input: SessionEventsInput,
    options?: SessionEventsOptions,
  ): Stream.Stream<
    SessionEventsSuccess,
    SessionEventsFailure | GentConnectionError,
    SessionEventsRequirements
  >
  function sessionEvents(input: SessionEventsInput, options?: SessionEventsOptions) {
    const client = current()
    if (client !== undefined) return client["session.events"](input, options)
    return disconnectedStreamResult<
      SessionEventsSuccess,
      SessionEventsFailure,
      SessionEventsRequirements
    >(options, unavailableError(stateRef))
  }

  function watchRuntime(
    input: WatchRuntimeInput,
    options: WatchRuntimeOptions & { readonly asQueue: true },
  ): Effect.Effect<
    Queue.Dequeue<WatchRuntimeSuccess, WatchRuntimeFailure | GentConnectionError | Cause.Done>,
    never,
    Scope.Scope
  >
  function watchRuntime(
    input: WatchRuntimeInput,
    options?: WatchRuntimeOptions,
  ): Stream.Stream<
    WatchRuntimeSuccess,
    WatchRuntimeFailure | GentConnectionError,
    WatchRuntimeRequirements
  >
  function watchRuntime(input: WatchRuntimeInput, options?: WatchRuntimeOptions) {
    const client = current()
    if (client !== undefined) return client["session.watchRuntime"](input, options)
    return disconnectedStreamResult<
      WatchRuntimeSuccess,
      WatchRuntimeFailure,
      WatchRuntimeRequirements
    >(options, unavailableError(stateRef))
  }

  const flatClient: GentRpcClient = {
    "actor.sendUserMessage": (input, options) =>
      current()?.["actor.sendUserMessage"](input, options) ?? disconnected(),
    "actor.sendToolResult": (input, options) =>
      current()?.["actor.sendToolResult"](input, options) ?? disconnected(),
    "actor.invokeTool": (input, options) =>
      current()?.["actor.invokeTool"](input, options) ?? disconnected(),
    "actor.interrupt": (input, options) =>
      current()?.["actor.interrupt"](input, options) ?? disconnected(),
    "actor.getState": (input, options) =>
      current()?.["actor.getState"](input, options) ?? disconnected(),
    "actor.getMetrics": (input, options) =>
      current()?.["actor.getMetrics"](input, options) ?? disconnected(),
    "auth.listProviders": (input, options) =>
      current()?.["auth.listProviders"](input, options) ?? disconnected(),
    "auth.setKey": (input, options) => current()?.["auth.setKey"](input, options) ?? disconnected(),
    "auth.deleteKey": (input, options) =>
      current()?.["auth.deleteKey"](input, options) ?? disconnected(),
    "auth.listMethods": (input, options) =>
      current()?.["auth.listMethods"](input, options) ?? disconnected(),
    "auth.authorize": (input, options) =>
      current()?.["auth.authorize"](input, options) ?? disconnected(),
    "auth.callback": (input, options) =>
      current()?.["auth.callback"](input, options) ?? disconnected(),
    "branch.list": (input, options) => current()?.["branch.list"](input, options) ?? disconnected(),
    "branch.create": (input, options) =>
      current()?.["branch.create"](input, options) ?? disconnected(),
    "branch.getTree": (input, options) =>
      current()?.["branch.getTree"](input, options) ?? disconnected(),
    "branch.switch": (input, options) =>
      current()?.["branch.switch"](input, options) ?? disconnected(),
    "branch.fork": (input, options) => current()?.["branch.fork"](input, options) ?? disconnected(),
    "driver.list": (input, options) => current()?.["driver.list"](input, options) ?? disconnected(),
    "driver.set": (input, options) => current()?.["driver.set"](input, options) ?? disconnected(),
    "driver.clear": (input, options) =>
      current()?.["driver.clear"](input, options) ?? disconnected(),
    "extension.send": (input, options) =>
      current()?.["extension.send"](input, options) ?? disconnected(),
    "extension.ask": (input, options) =>
      current()?.["extension.ask"](input, options) ?? disconnected(),
    "extension.request": (input, options) =>
      current()?.["extension.request"](input, options) ?? disconnected(),
    "extension.listStatus": (input, options) =>
      current()?.["extension.listStatus"](input, options) ?? disconnected(),
    "extension.listCommands": (input, options) =>
      current()?.["extension.listCommands"](input, options) ?? disconnected(),
    "interaction.respondInteraction": (input, options) =>
      current()?.["interaction.respondInteraction"](input, options) ?? disconnected(),
    "message.send": (input, options) =>
      current()?.["message.send"](input, options) ?? disconnected(),
    "message.list": (input, options) =>
      current()?.["message.list"](input, options) ?? disconnected(),
    "model.list": (input, options) => current()?.["model.list"](input, options) ?? disconnected(),
    "permission.listRules": (input, options) =>
      current()?.["permission.listRules"](input, options) ?? disconnected(),
    "permission.deleteRule": (input, options) =>
      current()?.["permission.deleteRule"](input, options) ?? disconnected(),
    "queue.drain": (input, options) => current()?.["queue.drain"](input, options) ?? disconnected(),
    "queue.get": (input, options) => current()?.["queue.get"](input, options) ?? disconnected(),
    "server.status": (input, options) =>
      current()?.["server.status"](input, options) ?? disconnected(),
    "session.create": (input, options) =>
      current()?.["session.create"](input, options) ?? disconnected(),
    "session.list": (input, options) =>
      current()?.["session.list"](input, options) ?? disconnected(),
    "session.get": (input, options) => current()?.["session.get"](input, options) ?? disconnected(),
    "session.delete": (input, options) =>
      current()?.["session.delete"](input, options) ?? disconnected(),
    "session.getChildren": (input, options) =>
      current()?.["session.getChildren"](input, options) ?? disconnected(),
    "session.getTree": (input, options) =>
      current()?.["session.getTree"](input, options) ?? disconnected(),
    "session.getSnapshot": (input, options) =>
      current()?.["session.getSnapshot"](input, options) ?? disconnected(),
    "session.updateReasoningLevel": (input, options) =>
      current()?.["session.updateReasoningLevel"](input, options) ?? disconnected(),
    "session.events": sessionEvents,
    "session.watchRuntime": watchRuntime,
    "steer.command": (input, options) =>
      current()?.["steer.command"](input, options) ?? disconnected(),
  }

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
