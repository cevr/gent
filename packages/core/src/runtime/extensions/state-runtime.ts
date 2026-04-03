import { Deferred, Effect, Layer, Ref, Schema, Semaphore, ServiceMap } from "effect"
import type { AgentEvent, ExtensionUiSnapshot } from "../../domain/event.js"
import { ExtensionUiSnapshot as ExtensionUiSnapshotClass } from "../../domain/event.js"
import type {
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
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "../../domain/extension-protocol.js"
import { ExtensionTurnControl } from "./turn-control.js"

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
  ) => Effect.Effect<void>
  readonly ask: <M extends AnyExtensionRequestMessage>(
    sessionId: SessionId,
    message: M,
    branchId?: BranchId,
  ) => Effect.Effect<ExtractExtensionReply<M>>
  readonly getUiSnapshots: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<ReadonlyArray<ExtensionUiSnapshot>>
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
          spawn: SpawnExtensionRef
          projection?: ExtensionProjectionConfig
        }> = []
        for (const ext of extensions) {
          if (ext.setup.spawn !== undefined) {
            spawns.push({
              extensionId: ext.manifest.id,
              spawn: ext.setup.spawn,
              projection: ext.setup.projection,
            })
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
        const spawnSemaphore = yield* Semaphore.make(1)

        const getOrSpawnActors = (sessionId: SessionId, branchId?: BranchId) =>
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
              const turnControl = yield* Effect.serviceOption(ExtensionTurnControl)
              const spawnLayer =
                turnControl._tag === "Some"
                  ? Layer.succeed(ExtensionTurnControl, turnControl.value)
                  : ExtensionTurnControl.Test()

              const entries: ActorEntry[] = []
              for (const { extensionId, spawn, projection } of spawns) {
                const spawnEffect: Effect.Effect<ExtensionRef | undefined> = spawn({
                  sessionId,
                  branchId,
                }).pipe(
                  Effect.tap((ref) => ref.start),
                  // @effect-diagnostics-next-line strictEffectProvide:off
                  Effect.provide(spawnLayer),
                  Effect.catchDefect((defect) =>
                    Effect.logWarning("extension.start.failed").pipe(
                      Effect.annotateLogs({ extensionId, error: String(defect) }),
                      Effect.as(undefined),
                    ),
                  ),
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ) as any
                const ref = yield* spawnEffect
                if (ref !== undefined) {
                  entries.push({ ref, projection })
                }
              }

              yield* Ref.update(actorsRef, (current) => {
                const next = new Map(current)
                next.set(sessionId, { _tag: "ready", entries })
                return next
              })
              yield* Deferred.succeed(gate, entries)
              return entries
            }),
          )

        const findEntry = (entries: ReadonlyArray<ActorEntry>, extensionId: string) =>
          entries.find((entry) => entry.ref.id === extensionId)

        return {
          publish: (event, ctx) =>
            Effect.withSpan("ExtensionStateRuntime.publish", {
              attributes: { "extension.event": event._tag },
            })(
              Effect.gen(function* () {
                let changed = false
                const entries = yield* getOrSpawnActors(ctx.sessionId, ctx.branchId)
                for (const { ref } of entries) {
                  const actorChanged = yield* ref
                    .publish(event, ctx)
                    .pipe(
                      Effect.catchDefect((defect) =>
                        Effect.logWarning("extension.publish.failed").pipe(
                          Effect.annotateLogs({ actorId: ref.id, error: String(defect) }),
                          Effect.as(false),
                        ),
                      ),
                    )
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
                  const { state } = yield* ref.snapshot.pipe(
                    Effect.catchDefect(() => Effect.succeed({ state: undefined, epoch: 0 })),
                  )
                  if (state === undefined) continue
                  const derived = yield* Effect.sync(() => derive(state, ctx)).pipe(
                    Effect.catchDefect(() => Effect.as(Effect.void, undefined)),
                  )
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
                const entry = findEntry(entries, message.extensionId)
                if (entry === undefined) return
                yield* entry.ref.send(message, branchId)
              }),
            ),

          ask: (sessionId, message, branchId) =>
            Effect.withSpan("ExtensionStateRuntime.ask", {
              attributes: {
                "extension.id": message.extensionId,
                "extension.message": message._tag,
              },
            })(
              Effect.gen(function* () {
                const entries = yield* getOrSpawnActors(sessionId, branchId)
                const entry = findEntry(entries, message.extensionId)
                if (entry === undefined) {
                  return yield* Effect.die(
                    new Error(`extension "${message.extensionId}" is not loaded`),
                  )
                }
                return yield* entry.ref.ask(message, branchId)
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
                  const { state, epoch } = yield* ref.snapshot.pipe(
                    Effect.catchDefect(() => Effect.succeed({ state: undefined, epoch: 0 })),
                  )
                  if (state === undefined) continue
                  const derived = yield* Effect.sync(() => derive(state, undefined)).pipe(
                    Effect.catchDefect(() => Effect.as(Effect.void, undefined)),
                  )
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

          terminateAll: (sessionId) =>
            Effect.withSpan("ExtensionStateRuntime.terminateAll")(
              Effect.gen(function* () {
                const slot = (yield* Ref.get(actorsRef)).get(sessionId)
                if (slot !== undefined && slot._tag === "ready") {
                  for (const { ref } of slot.entries) {
                    yield* ref.stop.pipe(Effect.catchDefect(() => Effect.void))
                  }
                }
                yield* Ref.update(actorsRef, (current) => {
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
