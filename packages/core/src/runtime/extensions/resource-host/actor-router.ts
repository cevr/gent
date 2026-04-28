/**
 * ActorRouter — actor-router for ExtensionMessage dispatch.
 *
 * After W10-PhaseB collapsed `Resource.machine` (FSM) into Behaviors,
 * this engine is purely a thin shim over `ActorEngine` + `Receptionist`:
 * decode the ExtensionMessage envelope, find the live `ActorRef` via
 * the extension's `serviceKey`, and `tell` (commands) or `ask`
 * (requests) the actor.
 *
 * Public surface:
 *   - `send`: cast a typed command message
 *   - `execute`: request/reply against the actor protocol
 *
 * Note: there is no `publish(event, ctx)` — Behaviors do not receive
 * `AgentEvent` automatically. Extensions react to events via declared
 * `reactions:` handlers, which explicitly `tell` their actor. See
 * `auto.ts` / `handoff.ts` for the reaction pattern.
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
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
import {
  collectExtensionProtocol,
  protocolError,
  type ActorBackedRoute,
} from "./machine-protocol.js"

export interface ActorRouterService {
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
}

const makeActorRouter = (
  extensions: ReadonlyArray<LoadedExtension>,
): Effect.Effect<ActorRouterService, never, ActorEngine | Receptionist> =>
  Effect.gen(function* () {
    const { actorRoutes, protocols } = collectExtensionProtocol(extensions)
    const actorEngine = yield* ActorEngine
    const receptionist = yield* Receptionist

    yield* Effect.logDebug("extension.state-runtime.init").pipe(
      Effect.annotateLogs({
        totalExtensions: extensions.length,
        actorBackedExtensions: actorRoutes.size,
        actorIds: [...actorRoutes.keys()].join(", "),
      }),
    )

    const findActorRef = (route: ActorBackedRoute) => receptionist.findOne(route.serviceKey)

    const withSession = <A, E>(sessionId: SessionId, effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.provideService(CurrentExtensionSession, { sessionId }))

    const sendImmediate = (
      sessionId: SessionId,
      message: AnyExtensionCommandMessage,
      branchId?: BranchId,
    ): Effect.Effect<void, ExtensionProtocolError> =>
      Effect.gen(function* () {
        const decoded = yield* protocols.decodeCommand(message)
        const route = actorRoutes.get(decoded.extensionId)
        if (route === undefined) {
          yield* Effect.logWarning("extension.send.not-loaded").pipe(
            Effect.annotateLogs({
              extensionId: decoded.extensionId,
              tag: decoded._tag,
              sessionId,
              branchId,
            }),
          )
          return yield* protocolError(
            decoded.extensionId,
            decoded._tag,
            "command",
            `extension "${decoded.extensionId}" is not loaded`,
          )
        }
        const actorRef = yield* findActorRef(route)
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
        const route = actorRoutes.get(decoded.extensionId)
        if (route === undefined) {
          yield* Effect.logWarning("extension.execute.not-loaded").pipe(
            Effect.annotateLogs({
              extensionId: decoded.extensionId,
              tag: decoded._tag,
              sessionId,
              branchId,
            }),
          )
          return yield* protocolError(
            decoded.extensionId,
            decoded._tag,
            "request",
            `extension "${decoded.extensionId}" is not loaded`,
          )
        }
        const actorRef = yield* findActorRef(route)
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
      })

    const service: ActorRouterService = {
      send: (sessionId, message, branchId) =>
        Effect.withSpan("ActorRouter.send", {
          attributes: {
            "extension.id": message.extensionId,
            "extension.message": message._tag,
          },
        })(withSession(sessionId, sendImmediate(sessionId, message, branchId))),

      execute: <M extends AnyExtensionRequestMessage>(
        sessionId: SessionId,
        message: M,
        branchId?: BranchId,
      ) =>
        Effect.withSpan("ActorRouter.execute", {
          attributes: {
            "extension.id": message.extensionId,
            "extension.message": message._tag,
          },
        })(withSession(sessionId, executeImmediate(sessionId, message, branchId))),
    }

    // Suppress unused — kept on the closure scope so the `extensions`
    // parameter shape stays explicit for readers of the call site.
    void ExtensionId
    return service
  })

export class ActorRouter extends Context.Service<ActorRouter, ActorRouterService>()(
  "@gent/core/src/runtime/extensions/resource-host/actor-router/ActorRouter",
) {
  // The router uses the same Receptionist that ActorHost registers
  // behaviors with — both surfaces MUST share one ActorEngine instance,
  // so the engine is a requirement here, not a baked-in dependency.
  // Callers wire `ActorEngine.Live` (or a Test variant) ONCE at the
  // composition boundary so ActorRouter and ActorHost route through
  // the same mailbox map.
  static fromExtensions = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<ActorRouter, never, ActorEngine | Receptionist> =>
    Layer.effect(ActorRouter, makeActorRouter(extensions))

  static Live = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<ActorRouter, never, ActorEngine | Receptionist> =>
    ActorRouter.fromExtensions(extensions)

  // Test variant — empty extension list. Bundles `ActorEngine.Live`
  // (which carries `Receptionist`) so callers don't need to think about
  // route discovery alignment; the engine and the actor host MUST share
  // one ActorEngine so the route hits the same actor map the host
  // registered into.
  static Test = (): Layer.Layer<ActorRouter | ActorEngine | Receptionist> =>
    ActorRouter.fromExtensions([]).pipe(Layer.provideMerge(ActorEngine.Live))
}
