/**
 * MachineEngine — actor-router for ExtensionMessage dispatch.
 *
 * After W10-PhaseB collapsed `Resource.machine` (FSM) into Behaviors,
 * this engine is purely a thin shim over `ActorEngine` + `Receptionist`:
 * decode the ExtensionMessage envelope, find the live `ActorRef` via
 * the extension's `serviceKey`, and `tell` (commands) or `ask`
 * (requests) the actor.
 *
 * Public surface:
 *   - `publish`: broadcast an `AgentEvent` to every actor-backed
 *     extension. Returns `[]` (no transition signal exists for
 *     Behaviors — extensions opt into pulses via `pulseTags`).
 *   - `send`: cast a typed command message
 *   - `execute`: request/reply against the actor protocol
 *   - `getActorStatuses`: returns `[]` (Behaviors are process-scoped,
 *     no per-session lifecycle to inspect — kept for surface compat)
 *   - `terminateAll`: no-op (Behaviors do not terminate per session)
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
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
import {
  collectExtensionProtocol,
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

const makeMachineEngine = (
  extensions: ReadonlyArray<LoadedExtension>,
): Effect.Effect<MachineEngineService, never, ActorEngine | Receptionist> =>
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

    // After W10-PhaseB, AgentEvent → behavior delivery is no longer
    // automatic. Behaviors that need to react to AgentEvents do so via
    // explicit `tell` from their `reactions:` handlers (see
    // `auto.ts`/`handoff.ts` for the pattern). `publish` remains for
    // protocol-surface compat — it still flows into `pulseTags`-driven
    // `ExtensionStateChanged` envelopes via `event-publisher.ts`.
    //
    // The `yieldNow` is load-bearing: the legacy publisher routed every
    // event through a per-session mailbox (`mailbox.submit`), which
    // forces a fiber yield as it serializes. Sites that publish on the
    // same fiber that drives the agent loop (e.g. `EventPublisher`
    // dispatched from a turn-control command) implicitly relied on that
    // yield to let the loop's driver fiber pick up the transition before
    // the publisher returned. With the mailbox gone, a no-op publish
    // never yields, and downstream waiters miss the `Idle → Running`
    // edge in the runtime state stream.
    const publishImmediate = (_event: AgentEvent, _ctx: ExtensionReduceContext) =>
      Effect.yieldNow.pipe(Effect.as<ReadonlyArray<string>>([]))

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

    const service: MachineEngineService = {
      publish: (event, ctx) =>
        Effect.withSpan("MachineEngine.publish", {
          attributes: { "extension.event": event._tag },
        })(withSession(ctx.sessionId, publishImmediate(event, ctx))),

      send: (sessionId, message, branchId) =>
        Effect.withSpan("MachineEngine.send", {
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
        Effect.withSpan("MachineEngine.execute", {
          attributes: {
            "extension.id": message.extensionId,
            "extension.message": message._tag,
          },
        })(withSession(sessionId, executeImmediate(sessionId, message, branchId))),

      getActorStatuses: (_sessionId: SessionId) =>
        Effect.succeed<ReadonlyArray<ExtensionActorStatusInfo>>([]),

      terminateAll: (_sessionId: SessionId) => Effect.void,
    }

    // Suppress unused — kept on the closure scope so the `extensions`
    // parameter shape stays explicit for readers of the call site.
    void ExtensionId
    return service
  })

export class MachineEngine extends Context.Service<MachineEngine, MachineEngineService>()(
  "@gent/core/src/runtime/extensions/resource-host/machine-engine/MachineEngine",
) {
  // The router uses the same Receptionist that ActorHost registers
  // behaviors with — both surfaces MUST share one ActorEngine instance,
  // so the engine is a requirement here, not a baked-in dependency.
  // Callers wire `ActorEngine.Live` (or a Test variant) ONCE at the
  // composition boundary so MachineEngine and ActorHost route through
  // the same mailbox map.
  static fromExtensions = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<MachineEngine, never, ActorEngine | Receptionist> =>
    Layer.effect(MachineEngine, makeMachineEngine(extensions))

  static Live = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<MachineEngine, never, ActorEngine | Receptionist> =>
    MachineEngine.fromExtensions(extensions)

  // Test variant — empty extension list. Bundles `ActorEngine.Live`
  // (which carries `Receptionist`) so callers don't need to think about
  // route discovery alignment; the engine and the actor host MUST share
  // one ActorEngine so the route hits the same actor map the host
  // registered into.
  static Test = (): Layer.Layer<MachineEngine | ActorEngine | Receptionist> =>
    MachineEngine.fromExtensions([]).pipe(Layer.provideMerge(ActorEngine.Live))
}
