/**
 * MachineEngine — substrate that drives `Resource.machine` actors.
 *
 * Owns per-session actor spawn, mailbox queues, supervised restart, and
 * the `send` / `execute` / `publish` / `getActorStatuses` / `terminateAll`
 * operations. Producers yield this Tag; read-only consumers (projections)
 * yield `MachineExecute` instead — the read-only call surface that
 * gains the `ReadOnly` brand in B11.4.
 *
 * Method semantics:
 *   - `send`: cast (fire-and-forget) of a typed command message
 *   - `execute`: typed call/await-reply (formerly `ask` pre-B11.3d)
 *   - `publish`: broadcast an `AgentEvent` to all session actors;
 *     returns the extensionIds whose machine actually transitioned
 *   - `getActorStatuses`: snapshot of per-actor status (debug surface)
 *   - `terminateAll`: stop every actor + close mailboxes for a session
 *
 * Internal mailbox-tag uses `_tag: "execute"` for typed-reply items.
 *
 * @module
 */

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import type { AgentEvent } from "../../../domain/event.js"
import type { AnyResourceMachine } from "../../../domain/resource.js"
import type {
  AnyExtensionActorDefinition,
  ExtensionActorStatusInfo,
  ExtensionReduceContext,
  ExtensionRef,
  LoadedExtension,
} from "../../../domain/extension.js"
import type { BranchId, SessionId } from "../../../domain/ids.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionMessageDefinition,
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "../../../domain/extension-protocol.js"
import {
  ExtensionProtocolError,
  isExtensionRequestDefinition,
  listExtensionProtocolDefinitions,
} from "../../../domain/extension-protocol.js"
import { CurrentExtensionSession } from "../extension-actor-shared.js"
import { spawnMachineExtensionRef } from "../spawn-machine-ref.js"
import { ExtensionTurnControl } from "../turn-control.js"

const CurrentMailboxSession = Context.Reference<SessionId | undefined>(
  "@gent/core/src/runtime/extensions/resource-host/machine-engine/CurrentMailboxSession",
  { defaultValue: () => undefined },
)

/** Extract the (at most one) `Resource.machine` declared by an extension. */
const extractMachine = (ext: LoadedExtension): AnyResourceMachine | undefined => {
  for (const r of ext.contributions.resources ?? []) {
    if (r.machine !== undefined) return r.machine
  }
  return undefined
}

interface ExtensionProtocolRegistry {
  readonly get: (extensionId: string, tag: string) => AnyExtensionMessageDefinition | undefined
}

interface ActorEntry {
  readonly ref: ExtensionRef
  readonly actor?: AnyExtensionActorDefinition
}

interface ActorSpawnSpec {
  readonly extensionId: string
  readonly actor: AnyExtensionActorDefinition
}

interface PublishMailboxItem {
  readonly _tag: "publish"
  readonly sessionId: SessionId
  readonly ctx: ExtensionReduceContext
  readonly event: AgentEvent
  readonly done: Deferred.Deferred<ReadonlyArray<string>>
}

interface SendMailboxItem {
  readonly _tag: "send"
  readonly sessionId: SessionId
  readonly branchId?: BranchId
  readonly message: AnyExtensionCommandMessage
  readonly done: Deferred.Deferred<ExtensionProtocolError | undefined>
}

interface ExecuteMailboxItem {
  readonly _tag: "execute"
  readonly sessionId: SessionId
  readonly branchId?: BranchId
  readonly message: AnyExtensionRequestMessage
  readonly done: Deferred.Deferred<unknown | ExtensionProtocolError>
}

type MailboxItem = PublishMailboxItem | SendMailboxItem | ExecuteMailboxItem

interface MailboxSlot {
  readonly queue: Queue.Queue<MailboxItem>
}

const ACTOR_RESTART_LIMIT = 1

export interface MachineEngineService {
  /**
   * Publish an event to all workflow actors for the session.
   *
   * Returns the list of extensionIds whose machine actually transitioned.
   * EventPublisher uses this to emit `ExtensionStateChanged` pulses ONLY
   * for extensions with real news — not blanket per-event broadcasts.
   */
  readonly publish: (
    event: AgentEvent,
    ctx: ExtensionReduceContext,
  ) => Effect.Effect<ReadonlyArray<string>>
  readonly send: (
    sessionId: SessionId,
    message: AnyExtensionCommandMessage,
    branchId?: BranchId,
  ) => Effect.Effect<void, ExtensionProtocolError>
  /**
   * Typed call/await-reply against an actor's request protocol.
   */
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
    const spawnSpecs: ActorSpawnSpec[] = []
    const spawnByExtension = new Map<string, ActorSpawnSpec>()
    const protocolMap = new Map<string, Map<string, AnyExtensionMessageDefinition>>()
    for (const ext of extensions) {
      // `Resource.machine` is structurally identical to
      // `ExtensionActorDefinition` — see resource.ts. Cast to the
      // runtime shape so existing actor-named code paths stay intact.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const actor = extractMachine(ext) as AnyExtensionActorDefinition | undefined
      if (actor !== undefined) {
        const spec = {
          extensionId: ext.manifest.id,
          actor,
        }
        spawnSpecs.push(spec)
        spawnByExtension.set(ext.manifest.id, spec)
      }
      const allDefs =
        actor?.protocols !== undefined ? listExtensionProtocolDefinitions(actor.protocols) : []
      for (const definition of allDefs) {
        const byTag = protocolMap.get(definition.extensionId) ?? new Map()
        byTag.set(definition._tag, definition)
        protocolMap.set(definition.extensionId, byTag)
      }
    }

    yield* Effect.logDebug("extension.state-runtime.init").pipe(
      Effect.annotateLogs({
        totalExtensions: extensions.length,
        extensionsWithActors: spawnSpecs.length,
        actorIds: spawnSpecs.map((s) => s.extensionId).join(", "),
        extensionsWithoutActors: extensions
          .filter((ext) => extractMachine(ext) === undefined)
          .map((ext) => ext.manifest.id)
          .join(", "),
      }),
    )

    type ActorSlot =
      | { readonly _tag: "ready"; readonly entries: ActorEntry[] }
      | { readonly _tag: "pending"; readonly gate: Deferred.Deferred<ActorEntry[]> }

    const actorsRef = yield* Ref.make<Map<SessionId, ActorSlot>>(new Map())
    const actorStatusesRef = yield* Ref.make<Map<SessionId, Map<string, ExtensionActorStatusInfo>>>(
      new Map(),
    )
    const mailboxSlotsRef = yield* Ref.make<Map<SessionId, MailboxSlot>>(new Map())
    const runtimeScope = yield* Scope.make()
    const spawnSemaphore = yield* Semaphore.make(1)
    const mailboxSemaphore = yield* Semaphore.make(1)
    const turnControl = yield* ExtensionTurnControl

    const setActorStatus = (status: ExtensionActorStatusInfo) =>
      Ref.update(actorStatusesRef, (current) => {
        const next = new Map(current)
        const byExtension = new Map(next.get(status.sessionId) ?? new Map())
        byExtension.set(status.extensionId, status)
        next.set(status.sessionId, byExtension)
        return next
      })

    const formatCause = (cause: Cause.Cause<unknown>) => String(Cause.squash(cause))
    const getProtocolFailure = (
      cause: Cause.Cause<unknown>,
    ): ExtensionProtocolError | undefined => {
      const failure = cause.reasons.find(Cause.isFailReason)
      return failure !== undefined && Schema.is(ExtensionProtocolError)(failure.error)
        ? failure.error
        : undefined
    }
    const logIsolatedFailure = (message: string, fields: Record<string, unknown>) =>
      Effect.logWarning(message).pipe(Effect.annotateLogs(fields))
    const stopActor = (entry: ActorEntry) => Effect.exit(entry.ref.stop).pipe(Effect.asVoid)
    const getActorStatus = (sessionId: SessionId, extensionId: string) =>
      Ref.get(actorStatusesRef).pipe(
        Effect.map((current) => current.get(sessionId)?.get(extensionId)),
      )
    const replaceReadyEntry = (
      sessionId: SessionId,
      extensionId: string,
      nextEntry: ActorEntry | undefined,
    ) =>
      Ref.update(actorsRef, (current) => {
        const slot = current.get(sessionId)
        if (slot === undefined || slot._tag !== "ready") return current
        const existingIndex = slot.entries.findIndex((entry) => entry.ref.id === extensionId)
        let entries = slot.entries
        if (existingIndex === -1) {
          if (nextEntry !== undefined) {
            entries = [...slot.entries, nextEntry]
          }
        } else if (nextEntry === undefined) {
          entries = slot.entries.filter((entry) => entry.ref.id !== extensionId)
        } else {
          entries = slot.entries.map((entry, index) =>
            index === existingIndex ? nextEntry : entry,
          )
        }
        const next = new Map(current)
        next.set(sessionId, { _tag: "ready", entries })
        return next
      })
    const markActorFailed = (
      extensionId: string,
      sessionId: SessionId,
      branchId: BranchId | undefined,
      error: string,
      failurePhase: "start" | "runtime",
      restartCount: number,
    ) =>
      setActorStatus({
        extensionId,
        sessionId,
        branchId,
        status: "failed",
        error,
        failurePhase,
        ...(restartCount > 0 ? { restartCount } : {}),
      })

    const spawnActorEntry = (
      spec: ActorSpawnSpec,
      sessionId: SessionId,
      branchId: BranchId | undefined,
      lifecycleStatus: "starting" | "restarting",
      failurePhase: "start" | "runtime",
      restartCount: number,
    ): Effect.Effect<ActorEntry | undefined> =>
      Effect.gen(function* () {
        yield* setActorStatus({
          extensionId: spec.extensionId,
          sessionId,
          branchId,
          status: lifecycleStatus,
          ...(restartCount > 0 ? { restartCount } : {}),
        })

        const spawnExit = yield* Effect.exit(
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off
          /* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- actor R is erased at registration */
          (
            spawnMachineExtensionRef(spec.extensionId, spec.actor, {
              sessionId,
              branchId,
            }) as Effect.Effect<ExtensionRef, never, never>
          ).pipe(Effect.provideService(ExtensionTurnControl, turnControl)),
          /* eslint-enable @typescript-eslint/no-unsafe-type-assertion */
        )

        if (spawnExit._tag === "Failure") {
          const error = formatCause(spawnExit.cause)
          yield* markActorFailed(
            spec.extensionId,
            sessionId,
            branchId,
            error,
            failurePhase,
            restartCount,
          )
          yield* Effect.logWarning("extension.start.failed").pipe(
            Effect.annotateLogs({ extensionId: spec.extensionId, error }),
          )
          return undefined
        }

        const startExit = yield* Effect.exit(spawnExit.value.start)
        if (startExit._tag === "Failure") {
          const error = formatCause(startExit.cause)
          yield* stopActor({ ref: spawnExit.value, actor: spec.actor })
          yield* markActorFailed(
            spec.extensionId,
            sessionId,
            branchId,
            error,
            failurePhase,
            restartCount,
          )
          yield* Effect.logWarning("extension.start.failed").pipe(
            Effect.annotateLogs({ extensionId: spec.extensionId, error }),
          )
          return undefined
        }

        yield* setActorStatus({
          extensionId: spec.extensionId,
          sessionId,
          branchId,
          status: "running",
          ...(restartCount > 0 ? { restartCount } : {}),
        })
        yield* Effect.logDebug("extension.actor.spawned").pipe(
          Effect.annotateLogs({
            extensionId: spec.extensionId,
            sessionId,
            lifecycleStatus,
            restartCount,
          }),
        )
        return { ref: spawnExit.value, actor: spec.actor }
      })

    const restartActor = (
      sessionId: SessionId,
      branchId: BranchId | undefined,
      entry: ActorEntry,
      error: string,
    ): Effect.Effect<ActorEntry | undefined> =>
      Effect.gen(function* () {
        const currentStatus = yield* getActorStatus(sessionId, entry.ref.id)
        const currentRestartCount = currentStatus?.restartCount ?? 0
        const actorBranchId = branchId ?? currentStatus?.branchId
        yield* stopActor(entry)

        if (currentRestartCount >= ACTOR_RESTART_LIMIT) {
          yield* replaceReadyEntry(sessionId, entry.ref.id, undefined)
          yield* markActorFailed(
            entry.ref.id,
            sessionId,
            actorBranchId,
            error,
            "runtime",
            currentRestartCount,
          )
          return undefined
        }

        const spec = spawnByExtension.get(entry.ref.id)
        if (spec === undefined) {
          yield* replaceReadyEntry(sessionId, entry.ref.id, undefined)
          yield* markActorFailed(
            entry.ref.id,
            sessionId,
            actorBranchId,
            `extension "${entry.ref.id}" cannot be restarted: spawn spec missing`,
            "runtime",
            currentRestartCount,
          )
          return undefined
        }

        const restarted = yield* spawnActorEntry(
          spec,
          sessionId,
          actorBranchId,
          "restarting",
          "runtime",
          currentRestartCount + 1,
        )
        yield* replaceReadyEntry(sessionId, entry.ref.id, restarted)
        return restarted
      })

    const runSupervised = <A>(
      sessionId: SessionId,
      branchId: BranchId | undefined,
      entry: ActorEntry,
      operation: string,
      run: (ref: ExtensionRef) => Effect.Effect<A, ExtensionProtocolError>,
    ): Effect.Effect<
      | { readonly _tag: "success"; readonly value: A }
      | { readonly _tag: "protocol"; readonly error: ExtensionProtocolError }
      | { readonly _tag: "terminal"; readonly error: string }
    > =>
      Effect.gen(function* () {
        let current = entry
        while (true) {
          const exit = yield* Effect.exit(run(current.ref))
          if (exit._tag === "Success") {
            return { _tag: "success", value: exit.value } as const
          }

          const protocol = getProtocolFailure(exit.cause)
          if (protocol !== undefined) {
            return { _tag: "protocol", error: protocol } as const
          }

          const error = formatCause(exit.cause)
          yield* Effect.logWarning("extension.actor.runtime.failed").pipe(
            Effect.annotateLogs({
              extensionId: current.ref.id,
              sessionId,
              branchId,
              operation,
              error,
            }),
          )
          const restarted = yield* restartActor(sessionId, branchId, current, error)
          if (restarted === undefined) {
            return { _tag: "terminal", error } as const
          }
          current = restarted
        }
      })

    const getOrSpawnActors = (
      sessionId: SessionId,
      branchId?: BranchId,
    ): Effect.Effect<ActorEntry[]> =>
      Effect.withSpan("MachineEngine.spawnWorkflows")(
        Effect.gen(function* () {
          const result = yield* spawnSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const existing = (yield* Ref.get(actorsRef)).get(sessionId)
              if (existing !== undefined) return existing
              const gate = yield* Deferred.make<ActorEntry[]>()
              const slot: ActorSlot = { _tag: "pending", gate }
              yield* Ref.update(actorsRef, (current) => {
                const next = new Map(current)
                next.set(sessionId, slot)
                return next
              })
              return { _tag: "owner" as const, gate }
            }),
          )

          if ("entries" in result && result._tag === "ready") return result.entries
          if ("gate" in result && result._tag === "pending") {
            return yield* Deferred.await(result.gate)
          }

          const gate = result.gate
          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              const entries: ActorEntry[] = []
              for (const spec of spawnSpecs) {
                const entry = yield* spawnActorEntry(
                  spec,
                  sessionId,
                  branchId,
                  "starting",
                  "start",
                  0,
                )
                if (entry !== undefined) {
                  entries.push(entry)
                }
              }
              return entries
            }),
          )

          const entries =
            exit._tag === "Success"
              ? exit.value
              : yield* logIsolatedFailure("extension.spawn.session.failed", {
                  sessionId,
                  error: formatCause(exit.cause),
                }).pipe(Effect.as([] as ActorEntry[]))

          yield* Ref.update(actorsRef, (current) => {
            const next = new Map(current)
            next.set(sessionId, { _tag: "ready", entries })
            return next
          })
          yield* Effect.logDebug("extension.actors.session.ready").pipe(
            Effect.annotateLogs({
              sessionId,
              requested: spawnSpecs.length,
              spawned: entries.length,
              spawnedIds: entries.map((e) => e.ref.id).join(", "),
              failedIds: spawnSpecs
                .filter((s) => !entries.some((e) => e.ref.id === s.extensionId))
                .map((s) => s.extensionId)
                .join(", "),
            }),
          )
          yield* Deferred.succeed(gate, entries)
          return entries
        }),
      ) as Effect.Effect<ActorEntry[]>

    const findEntry = (entries: ReadonlyArray<ActorEntry>, extensionId: string) =>
      entries.find((entry) => entry.ref.id === extensionId)

    const protocols: ExtensionProtocolRegistry = {
      get: (extensionId, tag) => protocolMap.get(extensionId)?.get(tag),
    }

    const protocolError = (
      extensionId: string,
      tag: string,
      phase: "command" | "request" | "reply",
      message: string,
    ) =>
      new ExtensionProtocolError({
        extensionId,
        tag,
        phase,
        message,
      })

    const decodeReply = <A>(
      extensionId: string,
      tag: string,
      schema: Schema.Codec<A, unknown, never, never>,
      value: unknown,
    ): Effect.Effect<A, ExtensionProtocolError> =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.catchIf(Schema.isSchemaError, () =>
          Schema.encodeUnknownEffect(schema)(value).pipe(
            Effect.flatMap((encoded) => Schema.decodeUnknownEffect(schema)(encoded)),
          ),
        ),
        Effect.mapError((error) => protocolError(extensionId, tag, "reply", error.message)),
      )

    const decodeMessage = <M extends AnyExtensionCommandMessage | AnyExtensionRequestMessage>(
      message: M,
      expectedKind: "command" | "request",
    ): Effect.Effect<M, ExtensionProtocolError> =>
      Effect.gen(function* () {
        const definition = protocols.get(message.extensionId, message._tag)
        if (definition === undefined) {
          return yield* protocolError(
            message.extensionId,
            message._tag,
            expectedKind,
            `extension "${message.extensionId}" has no protocol definition for "${message._tag}"`,
          )
        }
        const actualKind = isExtensionRequestDefinition(definition) ? "request" : "command"
        if (actualKind !== expectedKind) {
          return yield* protocolError(
            message.extensionId,
            message._tag,
            expectedKind,
            `extension "${message.extensionId}" message "${message._tag}" is registered as a ${actualKind}, not a ${expectedKind}`,
          )
        }
        return yield* Schema.decodeUnknownEffect(definition.schema)(message).pipe(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          Effect.map((value) => value as M),
          Effect.mapError((error) =>
            protocolError(message.extensionId, message._tag, expectedKind, error.message),
          ),
        )
      })

    const publishImmediate = (event: AgentEvent, ctx: ExtensionReduceContext) =>
      Effect.gen(function* () {
        const transitioned: string[] = []
        const entries = yield* getOrSpawnActors(ctx.sessionId, ctx.branchId)
        for (const entry of entries) {
          const publishResult = yield* runSupervised(
            ctx.sessionId,
            ctx.branchId,
            entry,
            "publish",
            (ref) => ref.publish(event, ctx),
          )
          let actorChanged = false
          if (publishResult._tag === "success") {
            actorChanged = publishResult.value
          } else if (publishResult._tag === "protocol") {
            actorChanged = yield* logIsolatedFailure("extension.publish.failed", {
              actorId: entry.ref.id,
              error: publishResult.error.message,
            }).pipe(Effect.as(false))
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
        const entries = yield* getOrSpawnActors(sessionId, branchId)
        const decoded = yield* decodeMessage(message, "command")
        const entry = findEntry(entries, decoded.extensionId)
        if (entry === undefined) {
          yield* Effect.logWarning("extension.send.not-loaded").pipe(
            Effect.annotateLogs({
              extensionId: decoded.extensionId,
              tag: decoded._tag,
              sessionId,
              loadedActors: entries.map((e) => e.ref.id).join(", "),
            }),
          )
          return yield* protocolError(
            decoded.extensionId,
            decoded._tag,
            "command",
            `extension "${decoded.extensionId}" is not loaded`,
          )
        }
        const sendResult = yield* runSupervised(sessionId, branchId, entry, "send", (ref) =>
          ref.send(decoded, branchId),
        )
        if (sendResult._tag === "protocol") {
          return yield* sendResult.error
        }
        if (sendResult._tag === "terminal") {
          return yield* protocolError(
            decoded.extensionId,
            decoded._tag,
            "command",
            sendResult.error,
          )
        }
      })

    const executeImmediate = <M extends AnyExtensionRequestMessage>(
      sessionId: SessionId,
      message: M,
      branchId?: BranchId,
    ): Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError> =>
      Effect.gen(function* () {
        const entries = yield* getOrSpawnActors(sessionId, branchId)
        const decoded = yield* decodeMessage(message, "request")
        const definition = protocols.get(decoded.extensionId, decoded._tag)
        if (definition === undefined || !isExtensionRequestDefinition(definition)) {
          return yield* protocolError(
            decoded.extensionId,
            decoded._tag,
            "request",
            `extension "${decoded.extensionId}" request "${decoded._tag}" is not registered`,
          )
        }
        const entry = findEntry(entries, decoded.extensionId)
        if (entry === undefined) {
          yield* Effect.logWarning("extension.execute.not-loaded").pipe(
            Effect.annotateLogs({
              extensionId: decoded.extensionId,
              tag: decoded._tag,
              sessionId,
              loadedActors: entries.map((e) => e.ref.id).join(", "),
              registeredSpawnSpecs: spawnSpecs.map((s) => s.extensionId).join(", "),
            }),
          )
          return yield* protocolError(
            decoded.extensionId,
            decoded._tag,
            "request",
            `extension "${decoded.extensionId}" is not loaded`,
          )
        }
        const replyResult = yield* runSupervised(sessionId, branchId, entry, "execute", (ref) =>
          ref.execute(decoded, branchId),
        )
        if (replyResult._tag === "protocol") {
          return yield* replyResult.error
        }
        if (replyResult._tag === "terminal") {
          return yield* protocolError(decoded.extensionId, decoded._tag, "reply", replyResult.error)
        }
        return yield* decodeReply(
          decoded.extensionId,
          decoded._tag,
          definition.replySchema,
          replyResult.value,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        ).pipe(Effect.map((value) => value as ExtractExtensionReply<M>))
      })

    const processMailboxItem = (item: MailboxItem) =>
      Effect.gen(function* () {
        const currentSession = { sessionId: item.sessionId }
        switch (item._tag) {
          case "publish": {
            const changed = yield* publishImmediate(item.event, item.ctx).pipe(
              Effect.provideService(CurrentExtensionSession, currentSession),
              Effect.provideService(CurrentMailboxSession, item.sessionId),
            )
            yield* Deferred.succeed(item.done, changed)
            return
          }
          case "send": {
            const exit = yield* Effect.exit(
              sendImmediate(item.sessionId, item.message, item.branchId).pipe(
                Effect.provideService(CurrentExtensionSession, currentSession),
                Effect.provideService(CurrentMailboxSession, item.sessionId),
              ),
            )
            if (exit._tag === "Success") {
              yield* Deferred.succeed(item.done, void 0)
              return
            }
            const protocol = getProtocolFailure(exit.cause)
            yield* Deferred.succeed(
              item.done,
              protocol ??
                protocolError(
                  item.message.extensionId,
                  item.message._tag,
                  "command",
                  formatCause(exit.cause),
                ),
            )
            return
          }
          case "execute": {
            const exit = yield* Effect.exit(
              executeImmediate(item.sessionId, item.message, item.branchId).pipe(
                Effect.provideService(CurrentExtensionSession, currentSession),
                Effect.provideService(CurrentMailboxSession, item.sessionId),
              ),
            )
            if (exit._tag === "Success") {
              yield* Deferred.succeed(item.done, exit.value)
              return
            }
            const protocol = getProtocolFailure(exit.cause)
            yield* Deferred.succeed(
              item.done,
              protocol ??
                protocolError(
                  item.message.extensionId,
                  item.message._tag,
                  "reply",
                  formatCause(exit.cause),
                ),
            )
          }
        }
      }).pipe(
        Effect.catchCause((cause) => {
          const error = formatCause(cause)
          const complete = (() => {
            switch (item._tag) {
              case "publish":
                return Deferred.succeed(item.done, [] as ReadonlyArray<string>)
              case "send":
                return Deferred.succeed(
                  item.done,
                  protocolError(item.message.extensionId, item.message._tag, "command", error),
                )
              case "execute":
                return Deferred.succeed(
                  item.done,
                  protocolError(item.message.extensionId, item.message._tag, "reply", error),
                )
            }
          })()
          return Effect.logWarning("extension.mailbox.failed").pipe(
            Effect.annotateLogs({
              sessionId: item.sessionId,
              operation: item._tag,
              error,
            }),
            Effect.andThen(complete),
          )
        }),
      )

    const mailboxWorker = (sessionId: SessionId, queue: Queue.Queue<MailboxItem>) =>
      Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processMailboxItem))).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void
          return Effect.logWarning("extension.mailbox.worker.failed").pipe(
            Effect.annotateLogs({ sessionId, error: formatCause(cause) }),
          )
        }),
      )

    const ensureMailboxSlot = (sessionId: SessionId): Effect.Effect<MailboxSlot> => {
      const createSlot: Effect.Effect<MailboxSlot> = Effect.gen(function* () {
        const existing = (yield* Ref.get(mailboxSlotsRef)).get(sessionId)
        if (existing !== undefined) return existing

        const queue = yield* Queue.unbounded<MailboxItem>()
        yield* Effect.forkIn(mailboxWorker(sessionId, queue), runtimeScope)

        const slot: MailboxSlot = { queue }
        yield* Ref.update(mailboxSlotsRef, (current) => {
          const next = new Map(current)
          next.set(sessionId, slot)
          return next
        })
        return slot
      })

      return mailboxSemaphore.withPermits(1)(createSlot)
    }

    const service = {
      publish: (event, ctx) =>
        Effect.withSpan("MachineEngine.publish", {
          attributes: { "extension.event": event._tag },
        })(
          Effect.gen(function* () {
            const slot = yield* ensureMailboxSlot(ctx.sessionId)
            const done = yield* Deferred.make<ReadonlyArray<string>>()
            yield* Queue.offer(slot.queue, {
              _tag: "publish",
              sessionId: ctx.sessionId,
              ctx,
              event,
              done,
            })
            const currentSession = yield* CurrentMailboxSession
            if (currentSession === ctx.sessionId) {
              // Re-entrant publish from inside the same mailbox: cannot
              // wait on `done` (would deadlock). The caller is itself an
              // effect inside the mailbox loop and will be told via the
              // outer publish's deferred. Treat as "no transitions
              // observed by this nested call".
              return [] as ReadonlyArray<string>
            }
            return yield* Deferred.await(done)
          }),
        ),

      send: (sessionId, message, branchId) =>
        Effect.withSpan("MachineEngine.send", {
          attributes: {
            "extension.id": message.extensionId,
            "extension.message": message._tag,
          },
        })(
          Effect.gen(function* () {
            const slot = yield* ensureMailboxSlot(sessionId)
            const done = yield* Deferred.make<ExtensionProtocolError | undefined>()
            yield* Queue.offer(slot.queue, {
              _tag: "send",
              sessionId,
              branchId,
              message,
              done,
            })
            const currentSession = yield* CurrentMailboxSession
            if (currentSession === sessionId) {
              // Re-entrant send is queued behind the current mailbox item.
              // Waiting here would deadlock; delivery continues once the
              // outer item finishes.
              return
            }
            const result = yield* Deferred.await(done)
            if (result !== undefined) return yield* result
          }),
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
          Effect.gen(function* () {
            const slot = yield* ensureMailboxSlot(sessionId)
            const done = yield* Deferred.make<unknown | ExtensionProtocolError>()
            yield* Queue.offer(slot.queue, {
              _tag: "execute",
              sessionId,
              branchId,
              message,
              done,
            })
            const result = yield* Deferred.await(done)
            if (Schema.is(ExtensionProtocolError)(result)) {
              return yield* result
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            return result as ExtractExtensionReply<M>
          }),
        ),

      getActorStatuses: (sessionId) =>
        Effect.gen(function* () {
          return [...((yield* Ref.get(actorStatusesRef)).get(sessionId) ?? new Map()).values()]
        }),

      terminateAll: (sessionId) =>
        Effect.withSpan("MachineEngine.terminateAll")(
          Effect.gen(function* () {
            const slot = (yield* Ref.get(actorsRef)).get(sessionId)
            if (slot !== undefined && slot._tag === "ready") {
              for (const { ref } of slot.entries) {
                yield* Effect.exit(ref.stop).pipe(Effect.asVoid)
              }
            }
            yield* Ref.update(actorsRef, (current) => {
              const next = new Map(current)
              next.delete(sessionId)
              return next
            })
            yield* Ref.update(actorStatusesRef, (current) => {
              const next = new Map(current)
              next.delete(sessionId)
              return next
            })
            const mailbox = (yield* Ref.get(mailboxSlotsRef)).get(sessionId)
            if (mailbox !== undefined) {
              yield* Queue.shutdown(mailbox.queue)
              yield* Ref.update(mailboxSlotsRef, (current) => {
                const next = new Map(current)
                next.delete(sessionId)
                return next
              })
            }
          }),
        ),
    } as MachineEngineService
    return { runtimeScope, service }
  })

// ── Public Tag ──
//
// `MachineEngine` is the substrate-wide call surface for the machine engine:
// `publish` / `send` / `execute` / `getActorStatuses` / `terminateAll`.
// Producers yield this Tag (event-publisher, agent-loop, session-runtime,
// rpc-handlers). Read-only consumers (projections) yield `MachineExecute`
// instead.

export class MachineEngine extends Context.Service<MachineEngine, MachineEngineService>()(
  "@gent/core/src/runtime/extensions/resource-host/machine-engine/MachineEngine",
) {
  /**
   * Build the layer for a fixed extension set. The returned layer owns a
   * `runtimeScope` whose lifetime equals the layer's scope — when the layer
   * is torn down, all spawned actors are stopped and mailbox queues are
   * shut down.
   */
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
