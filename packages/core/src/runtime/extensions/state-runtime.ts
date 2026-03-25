import { ServiceMap, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import type { AgentEvent, ExtensionUiSnapshot } from "../../domain/event.js"
import { ExtensionUiSnapshot as ExtensionUiSnapshotClass } from "../../domain/event.js"
import type {
  ExtensionActor,
  ExtensionDeriveContext,
  ExtensionProjectionConfig,
  ExtensionReduceContext,
  LoadedExtension,
  SpawnActor,
  TurnProjection,
} from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import { ExtensionEventBus } from "./event-bus.js"
import { ExtensionTurnControl } from "./turn-control.js"

// Errors

export class StaleIntentError extends Schema.TaggedErrorClass<StaleIntentError>()(
  "@gent/core/StaleIntentError",
  {
    extensionId: Schema.String,
    expectedEpoch: Schema.Number,
    actualEpoch: Schema.Number,
  },
) {}

// ── Actor entries ──

interface ActorEntry {
  readonly actor: ExtensionActor
  readonly projection?: ExtensionProjectionConfig
}

// Service

export interface ExtensionStateRuntimeService {
  /** Feed an event to all registered actors for a session. Returns true if any changed. */
  readonly reduce: (event: AgentEvent, ctx: ExtensionReduceContext) => Effect.Effect<boolean>

  /** Get turn-time projections (toolPolicy + promptSections) from all extension actors */
  readonly deriveAll: (
    sessionId: SessionId,
    ctx: ExtensionDeriveContext,
  ) => Effect.Effect<ReadonlyArray<{ extensionId: string; projection: TurnProjection }>>

  /** Handle a typed intent from the client (epoch-validated, schema-validated) */
  readonly handleIntent: (
    sessionId: SessionId,
    extensionId: string,
    intent: unknown,
    epoch: number,
    branchId?: BranchId,
  ) => Effect.Effect<void, StaleIntentError>

  /** Get current UI snapshots for all extensions with uiModels */
  readonly getUiSnapshots: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<ReadonlyArray<ExtensionUiSnapshot>>

  /** Terminate all actors for a session (call on session delete) */
  readonly terminateAll: (sessionId: SessionId) => Effect.Effect<void>
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
        const spawnActors: Array<{
          extensionId: string
          spawn: SpawnActor
          projection?: ExtensionProjectionConfig
        }> = []
        for (const ext of extensions) {
          if (ext.setup.spawnActor !== undefined) {
            spawnActors.push({
              extensionId: ext.manifest.id,
              spawn: ext.setup.spawnActor,
              projection: ext.setup.projection,
            })
          }
        }

        // Session-scoped actors
        const actorsRef = yield* Ref.make<Map<SessionId, ActorEntry[]>>(new Map())

        // Serialized actor spawn — prevents double-init on concurrent access
        const spawnSemaphore = yield* Semaphore.make(1)

        const getOrSpawnActors = (sessionId: SessionId, branchId?: BranchId) =>
          spawnSemaphore.withPermits(1)(
            Effect.gen(function* () {
              // Re-check after acquiring semaphore
              const existing = (yield* Ref.get(actorsRef)).get(sessionId)
              if (existing !== undefined) return existing

              // Yield services lazily — they're available at call time (reduce),
              // not at layer-build time. Provide them to spawn calls.
              const turnControl = yield* Effect.serviceOption(ExtensionTurnControl)
              const eventBus = yield* Effect.serviceOption(ExtensionEventBus)
              const spawnLayer = Layer.mergeAll(
                ...[
                  turnControl._tag === "Some"
                    ? Layer.succeed(ExtensionTurnControl, turnControl.value)
                    : ExtensionTurnControl.Test(),
                  eventBus._tag === "Some"
                    ? Layer.succeed(ExtensionEventBus, eventBus.value)
                    : ExtensionEventBus.Test(),
                ],
              )

              const entries: ActorEntry[] = []
              for (const { spawn, projection } of spawnActors) {
                const spawnEffect: Effect.Effect<ExtensionActor | undefined> = spawn({
                  sessionId,
                  branchId,
                }).pipe(
                  Effect.tap((a) => a.init),
                  // @effect-diagnostics-next-line strictEffectProvide:off
                  Effect.provide(spawnLayer),
                  Effect.catchDefect((defect) =>
                    Effect.logWarning(`Actor init failed: ${defect}`).pipe(Effect.as(undefined)),
                  ),
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ) as any
                const actor = yield* spawnEffect
                if (actor !== undefined) {
                  entries.push({ actor, projection })
                }
              }

              yield* Ref.update(actorsRef, (actors) => {
                const next = new Map(actors)
                next.set(sessionId, entries)
                return next
              })
              return entries
            }),
          )

        return {
          reduce: (event, ctx) =>
            Effect.gen(function* () {
              let changed = false
              const entries = yield* getOrSpawnActors(ctx.sessionId, ctx.branchId)
              for (const { actor } of entries) {
                const actorChanged = yield* actor
                  .handleEvent(event, ctx)
                  .pipe(
                    Effect.catchDefect((defect) =>
                      Effect.logWarning(`Actor ${actor.id} handleEvent failed: ${defect}`).pipe(
                        Effect.as(false),
                      ),
                    ),
                  )
                if (actorChanged) changed = true
              }

              return changed
            }),

          deriveAll: (sessionId, ctx) =>
            Effect.gen(function* () {
              const entries = yield* getOrSpawnActors(sessionId)
              const results: Array<{ extensionId: string; projection: TurnProjection }> = []
              for (const { actor, projection } of entries) {
                if (projection?.deriveTurn === undefined) continue
                const { state } = yield* actor.getState.pipe(
                  Effect.catchDefect(() => Effect.succeed({ state: undefined, version: 0 })),
                )
                if (state !== undefined) {
                  results.push({
                    extensionId: actor.id,
                    projection: projection.deriveTurn(state, ctx),
                  })
                }
              }

              return results
            }),

          handleIntent: (sessionId, extensionId, intent, epoch, branchId) =>
            Effect.gen(function* () {
              const entries = (yield* Ref.get(actorsRef)).get(sessionId) ?? []
              const entry = entries.find((a) => a.actor.id === extensionId)
              if (entry?.actor.handleIntent !== undefined) {
                // Epoch validation: reject stale intents
                const { version } = yield* entry.actor.getState.pipe(
                  Effect.catchDefect(() => Effect.succeed({ state: undefined, version: 0 })),
                )
                if (epoch < version) {
                  return yield* new StaleIntentError({
                    extensionId,
                    expectedEpoch: version,
                    actualEpoch: epoch,
                  })
                }
                yield* entry.actor
                  .handleIntent(intent, branchId)
                  .pipe(Effect.catchDefect(() => Effect.void))
              }
            }),

          getUiSnapshots: (sessionId, branchId) =>
            Effect.gen(function* () {
              const snapshots: ExtensionUiSnapshot[] = []
              const entries = yield* getOrSpawnActors(sessionId, branchId)
              for (const { actor, projection } of entries) {
                if (projection === undefined) continue
                const { state, version } = yield* actor.getState.pipe(
                  Effect.catchDefect(() => Effect.succeed({ state: undefined, version: 0 })),
                )
                if (state === undefined) continue
                if (projection.deriveUi === undefined) continue
                const uiModel = projection.deriveUi(state)
                if (uiModel !== undefined) {
                  snapshots.push(
                    new ExtensionUiSnapshotClass({
                      sessionId,
                      branchId,
                      extensionId: actor.id,
                      epoch: version,
                      model: uiModel,
                    }),
                  )
                }
              }

              return snapshots
            }),

          terminateAll: (sessionId) =>
            Effect.gen(function* () {
              const actors = (yield* Ref.get(actorsRef)).get(sessionId) ?? []
              for (const { actor } of actors) {
                yield* actor.terminate.pipe(Effect.catchDefect(() => Effect.void))
              }
              yield* Ref.update(actorsRef, (map) => {
                const next = new Map(map)
                next.delete(sessionId)
                return next
              })
            }),
        }
      }),
    )

  static Live = (extensions: ReadonlyArray<LoadedExtension>): Layer.Layer<ExtensionStateRuntime> =>
    ExtensionStateRuntime.fromExtensions(extensions)

  static Test = (): Layer.Layer<ExtensionStateRuntime> => ExtensionStateRuntime.fromExtensions([])
}
