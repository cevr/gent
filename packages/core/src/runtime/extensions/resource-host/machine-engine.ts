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
import type { BranchId, SessionId } from "../../../domain/ids.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
  ExtensionProtocolError,
} from "../../../domain/extension-protocol.js"
import { CurrentExtensionSession } from "../extension-actor-shared.js"
import { ExtensionTurnControl } from "../turn-control.js"
import { makeMachineLifecycle } from "./machine-lifecycle.js"
import { makeSessionMailbox } from "./machine-mailbox.js"
import { collectMachineProtocol, extractMachine, protocolError } from "./machine-protocol.js"

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
  ExtensionTurnControl
> =>
  Effect.gen(function* () {
    const { spawnSpecs, spawnByExtension, protocols } = collectMachineProtocol(extensions)

    yield* Effect.logDebug("extension.state-runtime.init").pipe(
      Effect.annotateLogs({
        totalExtensions: extensions.length,
        extensionsWithActors: spawnSpecs.length,
        actorIds: spawnSpecs.map((spec) => spec.extensionId).join(", "),
        extensionsWithoutActors: extensions
          .filter((extension) => extractMachine(extension) === undefined)
          .map((extension) => extension.manifest.id)
          .join(", "),
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

    const findEntry = (extensionId: string, sessionId: SessionId, branchId?: BranchId) =>
      lifecycle.getOrSpawnActors(sessionId, branchId).pipe(
        Effect.map((entries) => ({
          entry: entries.find((candidate) => candidate.ref.id === extensionId),
          entries,
        })),
      )
    const withSession = <A, E>(sessionId: SessionId, effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.provideService(CurrentExtensionSession, { sessionId }))

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
        const { entry, entries } = yield* findEntry(decoded.extensionId, sessionId, branchId)
        if (entry === undefined) {
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
        const { entry, entries } = yield* findEntry(decoded.extensionId, sessionId, branchId)
        if (entry === undefined) {
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
            const effect = withSession(ctx.sessionId, publishImmediate(event, ctx))
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
          Effect.gen(function* () {
            yield* lifecycle.terminateActors(sessionId)
            yield* mailbox.shutdown(sessionId)
          }),
        ),
    } satisfies MachineEngineService

    return { runtimeScope, service }
  })

export class MachineEngine extends Context.Service<MachineEngine, MachineEngineService>()(
  "@gent/core/src/runtime/extensions/resource-host/machine-engine/MachineEngine",
) {
  static fromExtensions = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<MachineEngine, never, ExtensionTurnControl> =>
    Layer.effect(
      MachineEngine,
      Effect.acquireRelease(makeMachineEngine(extensions), ({ runtimeScope }) =>
        Scope.close(runtimeScope, Exit.void),
      ).pipe(Effect.map(({ service }) => service)),
    )

  static Live = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<MachineEngine, never, ExtensionTurnControl> =>
    MachineEngine.fromExtensions(extensions)

  static Test = (): Layer.Layer<MachineEngine> =>
    MachineEngine.fromExtensions([]).pipe(Layer.provide(ExtensionTurnControl.Test()))
}
