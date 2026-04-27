/**
 * MachineEngine — substrate that drives `Resource.machine` actors.
 *
 * Public surface:
 *   - `publish`: broadcast an `AgentEvent` to all session actors
 *   - `send`: cast a typed command message
 *   - `execute`: request/reply against the actor protocol
 *   - `getActorStatuses`: debug snapshot of actor lifecycle state
 *   - `terminateAll`: stop all actors + close the session mailbox
 *
 * Internals are split by ownership:
 *   - `machine-protocol.ts`: protocol registry + decode/reply validation
 *   - `machine-lifecycle.ts`: actor spawn / restart / termination / status
 *   - `machine-mailbox.ts`: per-session serialization and same-fiber reentrancy
 *
 * @module
 */

import { Context, Effect, Exit, Layer, Scope } from "effect"
import type { AgentEvent } from "../../../domain/event.js"
import type {
  ExtensionActorStatusInfo,
  ExtensionReduceContext,
  LoadedExtension,
} from "../../../domain/extension.js"
import { ExtensionId } from "../../../domain/ids.js"
import type { BranchId, SessionId } from "../../../domain/ids.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
  ExtensionProtocolError,
} from "../../../domain/extension-protocol.js"
import { ActorEngine } from "../actor-engine.js"
import { Receptionist } from "../receptionist.js"
import { CurrentExtensionSession } from "../extension-actor-shared.js"
import { ExtensionTurnControl } from "../turn-control.js"
import { makeMachineLifecycle } from "./machine-lifecycle.js"
import { makeSessionMailbox } from "./machine-mailbox.js"
import { CurrentMachinePublishListener } from "./machine-publish-listener.js"
import {
  collectMachineProtocol,
  extractMachine,
  protocolError,
  type ActorBackedRoute,
} from "./machine-protocol.js"

export interface MachineEngineService {
  readonly publish: (
    event: AgentEvent,
    ctx: ExtensionReduceContext,
  ) => Effect.Effect<ReadonlyArray<string>>
  readonly send: (
    sessionId: SessionId,
    message: AnyExtensionCommandMessage,
    branchId?: BranchId,
  ) => Effect.Effect<void, ExtensionProtocolError>
  readonly execute: <M extends AnyExtensionRequestMessage>(
    sessionId: SessionId,
    message: M,
    branchId?: BranchId,
  ) => Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError>
  readonly getActorStatuses: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<ExtensionActorStatusInfo>>
  readonly terminateAll: (sessionId: SessionId) => Effect.Effect<void>
}

export const makeMachineEngine = (
  extensions: ReadonlyArray<LoadedExtension>,
): Effect.Effect<
  { runtimeScope: Scope.Closeable; service: MachineEngineService },
  never,
  ExtensionTurnControl | ActorEngine | Receptionist
> =>
  Effect.gen(function* () {
    const { spawnSpecs, spawnByExtension, actorRoutes, shadowedScopesByExtension, protocols } =
      collectMachineProtocol(extensions)
    const actorEngine = yield* ActorEngine
    const receptionist = yield* Receptionist

    const shadowedSummary = [...shadowedScopesByExtension.entries()]
      .flatMap(([id, scopes]) => scopes.map((scope) => `${id}@${scope}`))
      .join(", ")

    yield* Effect.logDebug("extension.state-runtime.init").pipe(
      Effect.annotateLogs({
        totalExtensions: extensions.length,
        extensionsWithActors: spawnSpecs.length,
        actorIds: spawnSpecs.map((spec) => `${spec.extensionId}@${spec.scope}`).join(", "),
        extensionsWithoutActors: extensions
          .filter((extension) => extractMachine(extension) === undefined)
          .map((extension) => extension.manifest.id)
          .join(", "),
        shadowedActors: shadowedSummary,
      }),
    )

    const runtimeScope = yield* Scope.make()
    const turnControl = yield* ExtensionTurnControl
    const lifecycle = yield* makeMachineLifecycle({
      runtimeScope,
      spawnSpecs,
      spawnByExtension,
      turnControl,
    })
    const mailbox = yield* makeSessionMailbox(runtimeScope)

    const findEntry = (extensionId: ExtensionId, sessionId: SessionId, branchId?: BranchId) =>
      lifecycle.getOrSpawnActors(sessionId, branchId).pipe(
        Effect.map((entries) => ({
          entry: entries.find((candidate) => candidate.ref.id === extensionId),
          entries,
        })),
      )

    // Actor-route fallback. When the extension has no FSM entry but
    // declares a serviceKey-bearing Behavior, find the live ActorRef
    // through the Receptionist and dispatch via the engine. Returns
    // `undefined` when no live actor is registered (the spawn either
    // hasn't happened yet or failed) — caller treats it the same as
    // "extension not loaded" with a routed-via-actor protocol error.
    const findActorRefForRoute = (route: ActorBackedRoute) =>
      receptionist.find(route.serviceKey).pipe(Effect.map((refs) => refs[0]))

    const withSession = <A, E>(sessionId: SessionId, effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.provideService(CurrentExtensionSession, { sessionId }))
    const notifyPublishListener = (transitioned: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const listener = yield* CurrentMachinePublishListener
        if (listener === undefined) return
        yield* listener(transitioned)
      })

    const publishImmediate = (event: AgentEvent, ctx: ExtensionReduceContext) =>
      Effect.gen(function* () {
        const transitioned: string[] = []
        const entries = yield* lifecycle.getOrSpawnActors(ctx.sessionId, ctx.branchId)
        for (const entry of entries) {
          const result = yield* lifecycle.runSupervised(
            ctx.sessionId,
            ctx.branchId,
            entry,
            "publish",
            (ref) => ref.publish(event, ctx),
          )
          let actorChanged = false
          if (result._tag === "success") {
            actorChanged = result.value
          } else if (result._tag === "protocol") {
            actorChanged = yield* Effect.logWarning("extension.publish.failed").pipe(
              Effect.annotateLogs({
                actorId: entry.ref.id,
                error: result.error.message,
              }),
              Effect.as(false),
            )
          } else if (result._tag === "terminal") {
            actorChanged = yield* Effect.logWarning("extension.publish.terminal").pipe(
              Effect.annotateLogs({
                actorId: entry.ref.id,
                error: result.error,
              }),
              Effect.as(false),
            )
          }
          if (actorChanged) transitioned.push(entry.ref.id)
        }
        return transitioned
      })

    const sendImmediate = (
      sessionId: SessionId,
      message: AnyExtensionCommandMessage,
      branchId?: BranchId,
    ): Effect.Effect<void, ExtensionProtocolError> =>
      Effect.gen(function* () {
        const decoded = yield* protocols.decodeCommand(message)
        const { entry, entries } = yield* findEntry(
          ExtensionId.make(decoded.extensionId),
          sessionId,
          branchId,
        )
        if (entry === undefined) {
          // Actor-route fallback: extension declared `actors:` with a
          // serviceKey but no FSM. Tell the live ActorRef directly.
          // Per-session routing is the actor's own concern — it sees
          // the message envelope and decides if it's a no-op for this
          // session vs a state mutation.
          const route = actorRoutes.get(decoded.extensionId)
          if (route !== undefined) {
            const actorRef = yield* findActorRefForRoute(route)
            if (actorRef === undefined) {
              yield* Effect.logWarning("extension.send.actor-not-spawned").pipe(
                Effect.annotateLogs({
                  extensionId: decoded.extensionId,
                  tag: decoded._tag,
                  sessionId,
                }),
              )
              return yield* protocolError(
                decoded.extensionId,
                decoded._tag,
                "command",
                `extension "${decoded.extensionId}" actor not registered`,
              )
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ExtensionMessage envelope IS the actor message (same _tag + payload); the actor matches on _tag
            yield* actorEngine.tell(actorRef, decoded as never)
            return
          }
          yield* Effect.logWarning("extension.send.not-loaded").pipe(
            Effect.annotateLogs({
              extensionId: decoded.extensionId,
              tag: decoded._tag,
              sessionId,
              loadedActors: entries.map((candidate) => candidate.ref.id).join(", "),
            }),
          )
          return yield* protocolError(
            decoded.extensionId,
            decoded._tag,
            "command",
            `extension "${decoded.extensionId}" is not loaded`,
          )
        }

        const result = yield* lifecycle.runSupervised(sessionId, branchId, entry, "send", (ref) =>
          ref.send(decoded, branchId),
        )
        if (result._tag === "protocol") {
          return yield* result.error
        }
        if (result._tag === "terminal") {
          return yield* protocolError(decoded.extensionId, decoded._tag, "command", result.error)
        }
      })

    const executeImmediate = <M extends AnyExtensionRequestMessage>(
      sessionId: SessionId,
      message: M,
      branchId?: BranchId,
    ): Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError> =>
      Effect.gen(function* () {
        const decoded = yield* protocols.decodeRequest(message)
        const definition = yield* protocols.requireRequestDefinition(
          decoded.extensionId,
          decoded._tag,
        )
        const { entry, entries } = yield* findEntry(
          ExtensionId.make(decoded.extensionId),
          sessionId,
          branchId,
        )
        if (entry === undefined) {
          // Actor-route fallback (mirror of sendImmediate). `ask` with a
          // phantom replyKey pins the answer's TS type for the ask
          // correlation — the engine threads `ctx.reply(value)` from the
          // actor back through the pending Deferred regardless of what
          // the replyKey returns. `ActorAskTimeout` surfaces here as a
          // protocol error so callers see one consistent failure shape.
          const route = actorRoutes.get(decoded.extensionId)
          if (route !== undefined) {
            const actorRef = yield* findActorRefForRoute(route)
            if (actorRef === undefined) {
              yield* Effect.logWarning("extension.execute.actor-not-spawned").pipe(
                Effect.annotateLogs({
                  extensionId: decoded.extensionId,
                  tag: decoded._tag,
                  sessionId,
                }),
              )
              return yield* protocolError(
                decoded.extensionId,
                decoded._tag,
                "request",
                `extension "${decoded.extensionId}" actor not registered`,
              )
            }
            const replyValue = yield* actorEngine
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ExtensionMessage envelope IS the actor message; reply correlation handled by the engine
              .ask(actorRef, decoded as never)
              .pipe(
                Effect.mapError((cause) =>
                  protocolError(
                    decoded.extensionId,
                    decoded._tag,
                    "reply",
                    `actor ask timed out after ${cause.askMs}ms`,
                  ),
                ),
              )
            return yield* protocols.decodeRequestReply(decoded, definition.replySchema, replyValue)
          }
          yield* Effect.logWarning("extension.execute.not-loaded").pipe(
            Effect.annotateLogs({
              extensionId: decoded.extensionId,
              tag: decoded._tag,
              sessionId,
              loadedActors: entries.map((candidate) => candidate.ref.id).join(", "),
            }),
          )
          return yield* protocolError(
            decoded.extensionId,
            decoded._tag,
            "request",
            `extension "${decoded.extensionId}" is not loaded`,
          )
        }

        const result = yield* lifecycle.runSupervised(
          sessionId,
          branchId,
          entry,
          "execute",
          (ref) => ref.execute(decoded, branchId),
        )
        if (result._tag === "protocol") {
          return yield* result.error
        }
        if (result._tag === "terminal") {
          return yield* protocolError(decoded.extensionId, decoded._tag, "reply", result.error)
        }
        return yield* protocols.decodeRequestReply(decoded, definition.replySchema, result.value)
      })

    const service = {
      publish: (event, ctx) =>
        Effect.withSpan("MachineEngine.publish", {
          attributes: { "extension.event": event._tag },
        })(
          Effect.gen(function* () {
            const effect = withSession(ctx.sessionId, publishImmediate(event, ctx)).pipe(
              Effect.tap(notifyPublishListener),
            )
            if (yield* mailbox.isWorkerFiber(ctx.sessionId)) {
              yield* mailbox.post(ctx.sessionId, effect.pipe(Effect.asVoid))
              return [] as ReadonlyArray<string>
            }
            return yield* mailbox.submit(ctx.sessionId, effect)
          }),
        ),

      send: (sessionId, message, branchId) =>
        Effect.withSpan("MachineEngine.send", {
          attributes: {
            "extension.id": message.extensionId,
            "extension.message": message._tag,
          },
        })(
          mailbox.submit(
            sessionId,
            withSession(sessionId, sendImmediate(sessionId, message, branchId)),
          ),
        ),

      execute: <M extends AnyExtensionRequestMessage>(
        sessionId: SessionId,
        message: M,
        branchId?: BranchId,
      ) =>
        Effect.withSpan("MachineEngine.execute", {
          attributes: {
            "extension.id": message.extensionId,
            "extension.message": message._tag,
          },
        })(
          mailbox.submit(
            sessionId,
            withSession(sessionId, executeImmediate(sessionId, message, branchId)),
          ),
        ),

      getActorStatuses: lifecycle.getActorStatuses,

      terminateAll: (sessionId) =>
        Effect.withSpan("MachineEngine.terminateAll")(
          mailbox.terminate(sessionId, lifecycle.terminateActors(sessionId)),
        ),
    } satisfies MachineEngineService

    return { runtimeScope, service }
  })

export class MachineEngine extends Context.Service<MachineEngine, MachineEngineService>()(
  "@gent/core/src/runtime/extensions/resource-host/machine-engine/MachineEngine",
) {
  // The actor-route fallback (W10-1b.0) reaches actor-only extensions
  // via the same Receptionist that ActorHost registers behaviors with —
  // both surfaces MUST share one ActorEngine instance, so the engine is
  // a requirement here, not a baked-in dependency. Callers wire
  // `ActorEngine.Live` (or a Test variant) ONCE at the composition
  // boundary so MachineEngine and ActorHost route through the same
  // mailbox map.
  static fromExtensions = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<MachineEngine, never, ExtensionTurnControl | ActorEngine | Receptionist> =>
    Layer.effect(
      MachineEngine,
      Effect.acquireRelease(makeMachineEngine(extensions), ({ runtimeScope }) =>
        Scope.close(runtimeScope, Exit.void),
      ).pipe(Effect.map(({ service }) => service)),
    )

  static Live = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<MachineEngine, never, ExtensionTurnControl | ActorEngine | Receptionist> =>
    MachineEngine.fromExtensions(extensions)

  // Re-exposes `ActorEngine` (and its inner `Receptionist`) via
  // `provideMerge` so callers that compose `MachineEngine.Test()` get the
  // same engine instance the route fallback uses. `Layer.provide` would
  // close the requirement and force callers to add a second
  // `ActorEngine.Live` — two engines, two Receptionists, route divergence.
  static Test = (): Layer.Layer<MachineEngine | ActorEngine | Receptionist> =>
    MachineEngine.fromExtensions([]).pipe(
      Layer.provide(ExtensionTurnControl.Test()),
      Layer.provideMerge(ActorEngine.Live),
    )
}
