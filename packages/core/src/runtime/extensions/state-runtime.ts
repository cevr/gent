import { Cause, Deferred, Effect, Layer, Ref, Schema, Semaphore, ServiceMap } from "effect"
import type { AgentEvent, ExtensionUiSnapshot } from "../../domain/event.js"
import { ExtensionUiSnapshot as ExtensionUiSnapshotClass } from "../../domain/event.js"
import type {
  ExtensionActorDefinition,
  ExtensionActorStatusInfo,
  ExtensionDeriveContext,
  ExtensionReduceContext,
  ExtensionRef,
  ExtensionSnapshot,
  LoadedExtension,
  SpawnExtensionRef,
  TurnProjection,
} from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionMessageDefinition,
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "../../domain/extension-protocol.js"
import { ExtensionProtocolError } from "../../domain/extension-protocol.js"
import { ExtensionTurnControl } from "./turn-control.js"

interface ExtensionProtocolRegistry {
  readonly get: (extensionId: string, tag: string) => AnyExtensionMessageDefinition | undefined
}

interface ActorEntry {
  readonly ref: ExtensionRef
  readonly actor?: ExtensionActorDefinition
}

interface ActorSpawnSpec {
  readonly extensionId: string
  readonly actor: ExtensionActorDefinition
}

const ACTOR_RESTART_LIMIT = 1

export interface ExtensionStateRuntimeService {
  readonly publish: (event: AgentEvent, ctx: ExtensionReduceContext) => Effect.Effect<boolean>
  readonly deriveAll: (
    sessionId: SessionId,
    ctx: ExtensionDeriveContext,
  ) => Effect.Effect<ReadonlyArray<{ extensionId: string; projection: TurnProjection }>>
  readonly send: (
    sessionId: SessionId,
    message: AnyExtensionCommandMessage,
    branchId?: BranchId,
  ) => Effect.Effect<void, ExtensionProtocolError>
  readonly ask: <M extends AnyExtensionRequestMessage>(
    sessionId: SessionId,
    message: M,
    branchId?: BranchId,
  ) => Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError>
  readonly getUiSnapshots: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<ReadonlyArray<ExtensionUiSnapshot>>
  readonly getActorStatuses: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<ExtensionActorStatusInfo>>
  readonly terminateAll: (sessionId: SessionId) => Effect.Effect<void>
  readonly notifyObservers: (event: AgentEvent) => Effect.Effect<void>
}

export class ExtensionStateRuntime extends ServiceMap.Service<
  ExtensionStateRuntime,
  ExtensionStateRuntimeService
>()("@gent/core/src/runtime/extensions/state-runtime/ExtensionStateRuntime") {
  static fromExtensions = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<ExtensionStateRuntime, never, ExtensionTurnControl> =>
    Layer.effect(
      ExtensionStateRuntime,
      Effect.gen(function* () {
        const spawnSpecs: ActorSpawnSpec[] = []
        const spawnByExtension = new Map<string, ActorSpawnSpec>()
        const protocolMap = new Map<string, Map<string, AnyExtensionMessageDefinition>>()
        for (const ext of extensions) {
          const legacyProjection = ext.setup.projection
          let legacySnapshot: ExtensionActorDefinition["snapshot"] | undefined
          let legacyTurn: ExtensionActorDefinition["turn"] | undefined
          if (legacyProjection !== undefined) {
            const legacyDerive = legacyProjection.derive
            if (legacyProjection.uiModelSchema !== undefined || legacyDerive !== undefined) {
              legacySnapshot = {
                schema: legacyProjection.uiModelSchema,
                project:
                  legacyDerive === undefined
                    ? undefined
                    : (state: unknown) => legacyDerive(state, undefined).uiModel,
              }
            }
            if (legacyDerive !== undefined) {
              legacyTurn = {
                project: (state: unknown, ctx: ExtensionDeriveContext) => {
                  const { uiModel: _, ...turn } = legacyDerive(state, ctx)
                  return turn
                },
              }
            }
          }
          const actor =
            ext.setup.actor ??
            (ext.setup.spawn !== undefined
              ? {
                  spawn: ext.setup.spawn as SpawnExtensionRef<never>,
                  ...(legacySnapshot === undefined ? {} : { snapshot: legacySnapshot }),
                  ...(legacyTurn === undefined ? {} : { turn: legacyTurn }),
                }
              : undefined)
          if (actor !== undefined) {
            const spec = {
              extensionId: ext.manifest.id,
              actor,
            }
            spawnSpecs.push(spec)
            spawnByExtension.set(ext.manifest.id, spec)
          }
          for (const definition of ext.setup.protocols ?? []) {
            const byTag = protocolMap.get(definition.extensionId) ?? new Map()
            byTag.set(definition._tag, definition)
            protocolMap.set(definition.extensionId, byTag)
          }
        }

        const allObservers: Array<(event: AgentEvent) => void | Promise<void>> = []
        for (const ext of extensions) {
          if (ext.setup.observers !== undefined) {
            allObservers.push(...ext.setup.observers)
          }
        }

        type ActorSlot =
          | { readonly _tag: "ready"; readonly entries: ActorEntry[] }
          | { readonly _tag: "pending"; readonly gate: Deferred.Deferred<ActorEntry[]> }

        const actorsRef = yield* Ref.make<Map<SessionId, ActorSlot>>(new Map())
        const actorStatusesRef = yield* Ref.make<
          Map<SessionId, Map<string, ExtensionActorStatusInfo>>
        >(new Map())
        const spawnSemaphore = yield* Semaphore.make(1)
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
          Effect.sync(() => {
            console.warn(message, fields)
          })
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
              (spec.actor.spawn as SpawnExtensionRef<never>)({ sessionId, branchId }).pipe(
                Effect.provideService(ExtensionTurnControl, turnControl),
              ),
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
          Effect.withSpan("ExtensionStateRuntime.spawnActors")(
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
            if (definition.kind !== expectedKind) {
              return yield* protocolError(
                message.extensionId,
                message._tag,
                expectedKind,
                `extension "${message.extensionId}" message "${message._tag}" is registered as a ${definition.kind}, not a ${expectedKind}`,
              )
            }
            return yield* Schema.decodeUnknownEffect(definition.schema)(message).pipe(
              Effect.map((value) => value as M),
              Effect.mapError((error) =>
                protocolError(message.extensionId, message._tag, expectedKind, error.message),
              ),
            )
          })

        return {
          publish: (event, ctx) =>
            Effect.withSpan("ExtensionStateRuntime.publish", {
              attributes: { "extension.event": event._tag },
            })(
              Effect.gen(function* () {
                let changed = false
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
                  if (actorChanged) changed = true
                }
                return changed
              }),
            ),

          deriveAll: (sessionId, ctx) =>
            Effect.withSpan("ExtensionStateRuntime.deriveAll")(
              Effect.gen(function* () {
                const entries = yield* getOrSpawnActors(sessionId)
                const results: Array<{ extensionId: string; projection: TurnProjection }> = []
                for (const entry of entries) {
                  const { ref, actor } = entry
                  const turnProject = actor?.turn?.project
                  if (turnProject === undefined) continue
                  const snapshotResult = yield* runSupervised(
                    sessionId,
                    undefined,
                    entry,
                    "snapshot",
                    (actorRef) => actorRef.snapshot,
                  )
                  let snapshot: ExtensionSnapshot = { state: undefined, epoch: 0 }
                  if (snapshotResult._tag === "success") {
                    snapshot = snapshotResult.value
                  } else if (snapshotResult._tag === "protocol") {
                    snapshot = yield* logIsolatedFailure("extension.snapshot.failed", {
                      actorId: ref.id,
                      error: snapshotResult.error.message,
                    }).pipe(Effect.as({ state: undefined, epoch: 0 }))
                  }
                  const { state } = snapshot
                  if (state === undefined) continue
                  const turnExit = yield* Effect.exit(Effect.sync(() => turnProject(state, ctx)))
                  const derived =
                    turnExit._tag === "Success"
                      ? turnExit.value
                      : yield* logIsolatedFailure("extension.derive.failed", {
                          actorId: ref.id,
                          error: formatCause(turnExit.cause),
                        }).pipe(Effect.as(undefined))
                  if (derived !== undefined) {
                    results.push({ extensionId: ref.id, projection: derived })
                  }
                }
                return results
              }),
            ),

          send: (sessionId, message, branchId) =>
            Effect.withSpan("ExtensionStateRuntime.send", {
              attributes: {
                "extension.id": message.extensionId,
                "extension.message": message._tag,
              },
            })(
              Effect.gen(function* () {
                const entries = yield* getOrSpawnActors(sessionId, branchId)
                const decoded = yield* decodeMessage(message, "command")
                const entry = findEntry(entries, decoded.extensionId)
                if (entry === undefined) {
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
              }),
            ),

          ask: <M extends AnyExtensionRequestMessage>(
            sessionId: SessionId,
            message: M,
            branchId?: BranchId,
          ) =>
            Effect.withSpan("ExtensionStateRuntime.ask", {
              attributes: {
                "extension.id": message.extensionId,
                "extension.message": message._tag,
              },
            })(
              Effect.gen(function* () {
                const entries = yield* getOrSpawnActors(sessionId, branchId)
                const decoded = yield* decodeMessage(message, "request")
                const definition = protocols.get(decoded.extensionId, decoded._tag)
                if (definition === undefined || definition.kind !== "request") {
                  return yield* protocolError(
                    decoded.extensionId,
                    decoded._tag,
                    "request",
                    `extension "${decoded.extensionId}" request "${decoded._tag}" is not registered`,
                  )
                }
                const entry = findEntry(entries, decoded.extensionId)
                if (entry === undefined) {
                  return yield* protocolError(
                    decoded.extensionId,
                    decoded._tag,
                    "request",
                    `extension "${decoded.extensionId}" is not loaded`,
                  )
                }
                const replyResult = yield* runSupervised(sessionId, branchId, entry, "ask", (ref) =>
                  ref.ask(decoded, branchId),
                )
                if (replyResult._tag === "protocol") {
                  return yield* replyResult.error
                }
                if (replyResult._tag === "terminal") {
                  return yield* protocolError(
                    decoded.extensionId,
                    decoded._tag,
                    "reply",
                    replyResult.error,
                  )
                }
                return yield* decodeReply(
                  decoded.extensionId,
                  decoded._tag,
                  definition.replySchema,
                  replyResult.value,
                ).pipe(Effect.map((value) => value as ExtractExtensionReply<M>))
              }),
            ),

          getUiSnapshots: (sessionId, branchId) =>
            Effect.withSpan("ExtensionStateRuntime.getUiSnapshots")(
              Effect.gen(function* () {
                const snapshots: ExtensionUiSnapshot[] = []
                const entries = yield* getOrSpawnActors(sessionId, branchId)
                for (const entry of entries) {
                  const { ref, actor } = entry
                  const snapshotConfig = actor?.snapshot
                  if (snapshotConfig === undefined) continue
                  const snapshotResult = yield* runSupervised(
                    sessionId,
                    branchId,
                    entry,
                    "snapshot",
                    (actorRef) => actorRef.snapshot,
                  )
                  let snapshot: ExtensionSnapshot = { state: undefined, epoch: 0 }
                  if (snapshotResult._tag === "success") {
                    snapshot = snapshotResult.value
                  } else if (snapshotResult._tag === "protocol") {
                    snapshot = yield* logIsolatedFailure("extension.snapshot.failed", {
                      actorId: ref.id,
                      error: snapshotResult.error.message,
                    }).pipe(Effect.as({ state: undefined, epoch: 0 }))
                  }
                  const { state, epoch } = snapshot
                  if (state === undefined) continue
                  const project = snapshotConfig.project ?? ((value: unknown) => value)
                  const snapshotProjectExit = yield* Effect.exit(Effect.sync(() => project(state)))
                  let model =
                    snapshotProjectExit._tag === "Success"
                      ? snapshotProjectExit.value
                      : yield* logIsolatedFailure("extension.snapshot.project.failed", {
                          actorId: ref.id,
                          error: formatCause(snapshotProjectExit.cause),
                        }).pipe(Effect.as(undefined))
                  if (model !== undefined && snapshotConfig.schema !== undefined) {
                    model = yield* Schema.decodeUnknownEffect(snapshotConfig.schema as Schema.Any)(
                      model,
                    ).pipe(
                      Effect.catchEager(() =>
                        Effect.logWarning("extension.snapshot.schemaValidation.failed").pipe(
                          Effect.annotateLogs({ actorId: ref.id }),
                          Effect.as(undefined),
                        ),
                      ),
                    )
                  }
                  if (model !== undefined) {
                    snapshots.push(
                      new ExtensionUiSnapshotClass({
                        sessionId,
                        branchId,
                        extensionId: ref.id,
                        epoch,
                        model,
                      }),
                    )
                  }
                }
                return snapshots
              }),
            ),

          getActorStatuses: (sessionId) =>
            Effect.gen(function* () {
              return [...((yield* Ref.get(actorStatusesRef)).get(sessionId) ?? new Map()).values()]
            }),

          terminateAll: (sessionId) =>
            Effect.withSpan("ExtensionStateRuntime.terminateAll")(
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
              }),
            ),

          notifyObservers: (event) =>
            Effect.forEach(
              allObservers,
              (observer) =>
                Effect.tryPromise({
                  try: () => Promise.resolve(observer(event)),
                  catch: () => undefined,
                }).pipe(
                  Effect.catchDefect(() => Effect.void),
                  Effect.catchEager(() => Effect.void),
                ),
              { concurrency: "unbounded", discard: true },
            ),
        } as ExtensionStateRuntimeService
      }),
    )

  static Live = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<ExtensionStateRuntime, never, ExtensionTurnControl> =>
    ExtensionStateRuntime.fromExtensions(extensions)

  static Test = (): Layer.Layer<ExtensionStateRuntime> =>
    ExtensionStateRuntime.fromExtensions([]).pipe(Layer.provide(ExtensionTurnControl.Test()))
}
