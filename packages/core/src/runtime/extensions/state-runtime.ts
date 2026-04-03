import { Cause, Deferred, Effect, Exit, Layer, Ref, Schema, Semaphore, ServiceMap } from "effect"
import type { AgentEvent, ExtensionUiSnapshot } from "../../domain/event.js"
import { ExtensionUiSnapshot as ExtensionUiSnapshotClass } from "../../domain/event.js"
import type {
  ExtensionActorStatusInfo,
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionProjectionConfig,
  ExtensionReduceContext,
  ExtensionRef,
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
  readonly projection?: ExtensionProjectionConfig
}

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
  ): Layer.Layer<ExtensionStateRuntime> =>
    Layer.effect(
      ExtensionStateRuntime,
      Effect.gen(function* () {
        const spawns: Array<{
          extensionId: string
          spawn: SpawnExtensionRef<never>
          projection?: ExtensionProjectionConfig
        }> = []
        const protocolMap = new Map<string, Map<string, AnyExtensionMessageDefinition>>()
        for (const ext of extensions) {
          if (ext.setup.spawn !== undefined) {
            spawns.push({
              extensionId: ext.manifest.id,
              spawn: ext.setup.spawn as SpawnExtensionRef<never>,
              projection: ext.setup.projection,
            })
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

        const setActorStatus = (status: ExtensionActorStatusInfo) =>
          Ref.update(actorStatusesRef, (current) => {
            const next = new Map(current)
            const byExtension = new Map(next.get(status.sessionId) ?? new Map())
            byExtension.set(status.extensionId, status)
            next.set(status.sessionId, byExtension)
            return next
          })

        const formatCause = (cause: Cause.Cause<unknown>) => String(Cause.squash(cause))
        const logIsolatedFailure = (message: string, fields: Record<string, unknown>) =>
          Effect.sync(() => {
            console.warn(message, fields)
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
                  const turnControl = yield* Effect.serviceOption(ExtensionTurnControl)
                  const spawnLayer =
                    turnControl._tag === "Some"
                      ? Layer.succeed(ExtensionTurnControl, turnControl.value)
                      : ExtensionTurnControl.Test()

                  const entries: ActorEntry[] = []
                  for (const { extensionId, spawn, projection } of spawns) {
                    yield* setActorStatus({
                      extensionId,
                      sessionId,
                      branchId,
                      status: "starting",
                    })
                    const ref = yield* spawn({
                      sessionId,
                      branchId,
                    }).pipe(
                      Effect.tap((actorRef) =>
                        Effect.exit(actorRef.start).pipe(
                          Effect.flatMap((startExit) => {
                            if (Exit.isSuccess(startExit)) {
                              return setActorStatus({
                                extensionId,
                                sessionId,
                                branchId,
                                status: "running",
                              }).pipe(Effect.as(actorRef))
                            }
                            const error = formatCause(startExit.cause)
                            return setActorStatus({
                              extensionId,
                              sessionId,
                              branchId,
                              status: "failed",
                              error,
                            }).pipe(
                              Effect.andThen(
                                Effect.logWarning("extension.start.failed").pipe(
                                  Effect.annotateLogs({ extensionId, error }),
                                ),
                              ),
                              Effect.as(undefined),
                            )
                          }),
                        ),
                      ),
                      // @effect-diagnostics-next-line strictEffectProvide:off
                      Effect.provide(spawnLayer),
                      Effect.catchEager((error) =>
                        setActorStatus({
                          extensionId,
                          sessionId,
                          branchId,
                          status: "failed",
                          error: String(error),
                        }).pipe(
                          Effect.andThen(
                            Effect.logWarning("extension.start.failed").pipe(
                              Effect.annotateLogs({ extensionId, error: String(error) }),
                            ),
                          ),
                          Effect.as(undefined),
                        ),
                      ),
                      Effect.catchDefect((defect) =>
                        setActorStatus({
                          extensionId,
                          sessionId,
                          branchId,
                          status: "failed",
                          error: String(defect),
                        }).pipe(
                          Effect.andThen(
                            Effect.logWarning("extension.start.failed").pipe(
                              Effect.annotateLogs({ extensionId, error: String(defect) }),
                            ),
                          ),
                          Effect.as(undefined),
                        ),
                      ),
                    )
                    if (ref !== undefined) {
                      entries.push({ ref, projection })
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
                for (const { ref } of entries) {
                  const publishExit = yield* Effect.exit(ref.publish(event, ctx))
                  const actorChanged =
                    publishExit._tag === "Success"
                      ? publishExit.value
                      : yield* logIsolatedFailure("extension.publish.failed", {
                          actorId: ref.id,
                          error: formatCause(publishExit.cause),
                        }).pipe(Effect.as(false))
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
                for (const { ref, projection } of entries) {
                  const derive = projection?.derive
                  if (derive === undefined) continue
                  const snapshotExit = yield* Effect.exit(ref.snapshot)
                  const { state } =
                    snapshotExit._tag === "Success"
                      ? snapshotExit.value
                      : yield* logIsolatedFailure("extension.snapshot.failed", {
                          actorId: ref.id,
                          error: formatCause(snapshotExit.cause),
                        }).pipe(Effect.as({ state: undefined, epoch: 0 }))
                  if (state === undefined) continue
                  const deriveExit = yield* Effect.exit(Effect.sync(() => derive(state, ctx)))
                  const derived =
                    deriveExit._tag === "Success"
                      ? deriveExit.value
                      : yield* logIsolatedFailure("extension.derive.failed", {
                          actorId: ref.id,
                          error: formatCause(deriveExit.cause),
                        }).pipe(Effect.as(undefined))
                  if (derived !== undefined) {
                    const { uiModel: _, ...turn } = derived
                    results.push({ extensionId: ref.id, projection: turn })
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
                if (entry === undefined) return
                const sendExit = yield* Effect.exit(entry.ref.send(decoded, branchId))
                if (sendExit._tag === "Failure") {
                  return yield* protocolError(
                    decoded.extensionId,
                    decoded._tag,
                    "command",
                    formatCause(sendExit.cause),
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
                const replyExit = yield* Effect.exit(entry.ref.ask(decoded, branchId))
                if (replyExit._tag === "Failure") {
                  return yield* protocolError(
                    decoded.extensionId,
                    decoded._tag,
                    "reply",
                    formatCause(replyExit.cause),
                  )
                }
                return yield* decodeReply(
                  decoded.extensionId,
                  decoded._tag,
                  definition.replySchema,
                  replyExit.value,
                ).pipe(Effect.map((value) => value as ExtractExtensionReply<M>))
              }),
            ),

          getUiSnapshots: (sessionId, branchId) =>
            Effect.withSpan("ExtensionStateRuntime.getUiSnapshots")(
              Effect.gen(function* () {
                const snapshots: ExtensionUiSnapshot[] = []
                const entries = yield* getOrSpawnActors(sessionId, branchId)
                for (const { ref, projection } of entries) {
                  const derive = projection?.derive
                  if (derive === undefined) continue
                  const snapshotExit = yield* Effect.exit(ref.snapshot)
                  const { state, epoch } =
                    snapshotExit._tag === "Success"
                      ? snapshotExit.value
                      : yield* logIsolatedFailure("extension.snapshot.failed", {
                          actorId: ref.id,
                          error: formatCause(snapshotExit.cause),
                        }).pipe(Effect.as({ state: undefined, epoch: 0 }))
                  if (state === undefined) continue
                  const deriveExit = yield* Effect.exit(Effect.sync(() => derive(state, undefined)))
                  const derived =
                    deriveExit._tag === "Success"
                      ? deriveExit.value
                      : yield* logIsolatedFailure("extension.derive.failed", {
                          actorId: ref.id,
                          error: formatCause(deriveExit.cause),
                        }).pipe(Effect.as(undefined))
                  let uiModel = (derived as ExtensionProjection | undefined)?.uiModel
                  if (uiModel !== undefined && projection?.uiModelSchema !== undefined) {
                    uiModel = yield* Schema.decodeUnknownEffect(
                      projection.uiModelSchema as Schema.Any,
                    )(uiModel).pipe(
                      Effect.catchEager(() =>
                        Effect.logWarning("extension.uiModel.schemaValidation.failed").pipe(
                          Effect.annotateLogs({ actorId: ref.id }),
                          Effect.as(undefined),
                        ),
                      ),
                    )
                  }
                  if (uiModel !== undefined) {
                    snapshots.push(
                      new ExtensionUiSnapshotClass({
                        sessionId,
                        branchId,
                        extensionId: ref.id,
                        epoch,
                        model: uiModel,
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

  static Live = (extensions: ReadonlyArray<LoadedExtension>): Layer.Layer<ExtensionStateRuntime> =>
    ExtensionStateRuntime.fromExtensions(extensions)

  static Test = (): Layer.Layer<ExtensionStateRuntime> => ExtensionStateRuntime.fromExtensions([])
}
