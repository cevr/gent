import { Cause, Deferred, Effect, Exit, Fiber, Ref, Schema, Scope, Semaphore } from "effect"
import { RpcClient } from "effect/unstable/rpc"
import { GentRpcs, type GentRpcClient } from "@gent/core/server/rpcs.js"
import {
  GentConnectionError,
  type ConnectionState,
  type GentLifecycle,
} from "@gent/core/server/transport-contract.js"
import { makeNamespacedClient, type GentNamespacedClient } from "./namespaced-client.js"
import { runSupervisorRestart } from "./supervisor-boundary.js"

type BuildLocalRpcClient<E, R> = (scope: Scope.Closeable) => Effect.Effect<GentRpcClient, E, R>

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

const makeUnavailableClient = (
  stateRef: Ref.Ref<ConnectionState>,
): Effect.Effect<GentRpcClient, never, Scope.Scope> =>
  RpcClient.makeNoSerialization(GentRpcs, {
    supportsAck: true,
    disableTracing: true,
    onFromClient: () => Effect.fail(unavailableError(stateRef)),
  }).pipe(Effect.map(({ client }) => client))

const makeSwappableClient = (
  clientRef: Ref.Ref<GentRpcClient | undefined>,
  unavailableClient: GentRpcClient,
): GentNamespacedClient => {
  const current = () => Ref.getUnsafe(clientRef) ?? unavailableClient

  const flatClient: GentRpcClient = {
    "actor.sendUserMessage": (input, options) => current()["actor.sendUserMessage"](input, options),
    "actor.sendToolResult": (input, options) => current()["actor.sendToolResult"](input, options),
    "actor.invokeTool": (input, options) => current()["actor.invokeTool"](input, options),
    "actor.interrupt": (input, options) => current()["actor.interrupt"](input, options),
    "actor.getState": (input, options) => current()["actor.getState"](input, options),
    "actor.getMetrics": (input, options) => current()["actor.getMetrics"](input, options),
    "auth.listProviders": (input, options) => current()["auth.listProviders"](input, options),
    "auth.setKey": (input, options) => current()["auth.setKey"](input, options),
    "auth.deleteKey": (input, options) => current()["auth.deleteKey"](input, options),
    "auth.listMethods": (input, options) => current()["auth.listMethods"](input, options),
    "auth.authorize": (input, options) => current()["auth.authorize"](input, options),
    "auth.callback": (input, options) => current()["auth.callback"](input, options),
    "branch.list": (input, options) => current()["branch.list"](input, options),
    "branch.create": (input, options) => current()["branch.create"](input, options),
    "branch.getTree": (input, options) => current()["branch.getTree"](input, options),
    "branch.switch": (input, options) => current()["branch.switch"](input, options),
    "branch.fork": (input, options) => current()["branch.fork"](input, options),
    "driver.list": (input, options) => current()["driver.list"](input, options),
    "driver.set": (input, options) => current()["driver.set"](input, options),
    "driver.clear": (input, options) => current()["driver.clear"](input, options),
    "extension.send": (input, options) => current()["extension.send"](input, options),
    "extension.ask": (input, options) => current()["extension.ask"](input, options),
    "extension.request": (input, options) => current()["extension.request"](input, options),
    "extension.listStatus": (input, options) => current()["extension.listStatus"](input, options),
    "extension.listCommands": (input, options) =>
      current()["extension.listCommands"](input, options),
    "interaction.respondInteraction": (input, options) =>
      current()["interaction.respondInteraction"](input, options),
    "message.send": (input, options) => current()["message.send"](input, options),
    "message.list": (input, options) => current()["message.list"](input, options),
    "model.list": (input, options) => current()["model.list"](input, options),
    "permission.listRules": (input, options) => current()["permission.listRules"](input, options),
    "permission.deleteRule": (input, options) => current()["permission.deleteRule"](input, options),
    "queue.drain": (input, options) => current()["queue.drain"](input, options),
    "queue.get": (input, options) => current()["queue.get"](input, options),
    "server.status": (input, options) => current()["server.status"](input, options),
    "session.create": (input, options) => current()["session.create"](input, options),
    "session.list": (input, options) => current()["session.list"](input, options),
    "session.get": (input, options) => current()["session.get"](input, options),
    "session.delete": (input, options) => current()["session.delete"](input, options),
    "session.getChildren": (input, options) => current()["session.getChildren"](input, options),
    "session.getTree": (input, options) => current()["session.getTree"](input, options),
    "session.getSnapshot": (input, options) => current()["session.getSnapshot"](input, options),
    "session.updateReasoningLevel": (input, options) =>
      current()["session.updateReasoningLevel"](input, options),
    "session.events": (input, options) => current()["session.events"](input, options),
    "session.watchRuntime": (input, options) => current()["session.watchRuntime"](input, options),
    "steer.command": (input, options) => current()["steer.command"](input, options),
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

      const unavailableClient = yield* makeUnavailableClient(stateRef)

      return {
        client: makeSwappableClient(clientRef, unavailableClient),
        lifecycle,
        stop,
      } satisfies LocalSupervisorResource
    }),
    (supervisor) => supervisor.stop,
  )
