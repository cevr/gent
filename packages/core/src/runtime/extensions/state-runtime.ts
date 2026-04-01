import { ServiceMap, Deferred, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import type { AgentEvent, ExtensionUiSnapshot } from "../../domain/event.js"
import { ExtensionUiSnapshot as ExtensionUiSnapshotClass } from "../../domain/event.js"
import type {
  ExtensionActor,
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionProjectionConfig,
  ExtensionReduceContext,
  LoadedExtension,
  SpawnActor,
  TurnProjection,
} from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
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

        // Session-scoped actors with Deferred readiness.
        // Registration happens under a semaphore (fast), but spawn+init runs
        // outside the lock. This prevents re-entrant deadlocks where extension
        // actor spawn publishes events that trigger reduce → getOrSpawnActors.
        type ActorSlot =
          | { readonly _tag: "ready"; readonly entries: ActorEntry[] }
          | { readonly _tag: "pending"; readonly gate: Deferred.Deferred<ActorEntry[]> }
        const actorsRef = yield* Ref.make<Map<SessionId, ActorSlot>>(new Map())
        const spawnSemaphore = yield* Semaphore.make(1)

        const getOrSpawnActors = (sessionId: SessionId, branchId?: BranchId) =>
          Effect.withSpan("ExtensionStateRuntime.spawnActors")(
            Effect.gen(function* () {
              // Phase 1: under semaphore, check or register a Deferred placeholder.
              // Returns { _tag: "owner", gate } if we created the placeholder,
              // or the existing slot if already initialized/pending.
              const result = yield* spawnSemaphore.withPermits(1)(
                Effect.gen(function* () {
                  const existing = (yield* Ref.get(actorsRef)).get(sessionId)
                  if (existing !== undefined) return existing
                  const gate = yield* Deferred.make<ActorEntry[]>()
                  const slot: ActorSlot = { _tag: "pending", gate }
                  yield* Ref.update(actorsRef, (m) => {
                    const next = new Map(m)
                    next.set(sessionId, slot)
                    return next
                  })
                  // Return a sentinel so the caller knows it owns init
                  return { _tag: "owner" as const, gate }
                }),
              )

              // Fast path: already initialized
              if ("entries" in result && result._tag === "ready") return result.entries

              // Another fiber is initializing — wait for it
              if ("gate" in result && result._tag === "pending") {
                return yield* Deferred.await(result.gate)
              }

              // We own the init (result._tag === "owner")
              const gate = (result as { _tag: "owner"; gate: Deferred.Deferred<ActorEntry[]> }).gate

              // Phase 2: outside semaphore, spawn + init actors
              const turnControl = yield* Effect.serviceOption(ExtensionTurnControl)
              const spawnLayer =
                turnControl._tag === "Some"
                  ? Layer.succeed(ExtensionTurnControl, turnControl.value)
                  : ExtensionTurnControl.Test()

              const entries: ActorEntry[] = []
              for (const { extensionId, spawn, projection } of spawnActors) {
                const spawnEffect: Effect.Effect<ExtensionActor | undefined> = spawn({
                  sessionId,
                  branchId,
                }).pipe(
                  Effect.tap((a) => a.init),
                  // @effect-diagnostics-next-line strictEffectProvide:off
                  Effect.provide(spawnLayer),
                  Effect.catchDefect((defect) =>
                    Effect.logWarning("actor.init.failed").pipe(
                      Effect.annotateLogs({ extensionId, error: String(defect) }),
                      Effect.as(undefined),
                    ),
                  ),
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ) as any
                const actor = yield* spawnEffect
                if (actor !== undefined) {
                  entries.push({ actor, projection })
                }
              }

              // Phase 3: publish entries + complete the gate
              yield* Ref.update(actorsRef, (m) => {
                const next = new Map(m)
                next.set(sessionId, { _tag: "ready", entries })
                return next
              })
              yield* Deferred.succeed(gate, entries)
              return entries
            }),
          )

        return {
          reduce: (event, ctx) =>
            Effect.withSpan("ExtensionStateRuntime.reduce", {
              attributes: { "extension.event": event._tag },
            })(
              Effect.gen(function* () {
                let changed = false
                const entries = yield* getOrSpawnActors(ctx.sessionId, ctx.branchId)
                for (const { actor } of entries) {
                  const actorChanged = yield* actor
                    .handleEvent(event, ctx)
                    .pipe(
                      Effect.catchDefect((defect) =>
                        Effect.logWarning("actor.handleEvent.failed").pipe(
                          Effect.annotateLogs({ actorId: actor.id, error: String(defect) }),
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
                for (const { actor, projection } of entries) {
                  const deriveFn = projection?.derive
                  if (deriveFn === undefined) continue
                  const { state } = yield* actor.getState.pipe(
                    Effect.catchDefect(() => Effect.succeed({ state: undefined, version: 0 })),
                  )
                  if (state !== undefined) {
                    // @effect-diagnostics-next-line effectSucceedWithVoid:off
                    const derived = yield* Effect.sync(() => deriveFn(state, ctx)).pipe(
                      Effect.catchDefect(() => Effect.succeed(undefined)),
                    )
                    if (derived !== undefined) {
                      const { uiModel: _, ...turn } = derived
                      results.push({ extensionId: actor.id, projection: turn })
                    }
                  }
                }

                return results
              }),
            ),

          handleIntent: (sessionId, extensionId, intent, epoch, branchId) =>
            Effect.withSpan("ExtensionStateRuntime.handleIntent", {
              attributes: { "extension.id": extensionId },
            })(
              Effect.gen(function* () {
                const entries = yield* getOrSpawnActors(sessionId, branchId)
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
            ),

          getUiSnapshots: (sessionId, branchId) =>
            Effect.withSpan("ExtensionStateRuntime.getUiSnapshots")(
              Effect.gen(function* () {
                const snapshots: ExtensionUiSnapshot[] = []
                const entries = yield* getOrSpawnActors(sessionId, branchId)
                for (const entry of entries) {
                  const { actor, projection } = entry
                  if (projection === undefined || projection.derive === undefined) continue
                  const deriveFn = projection.derive
                  const { state, version } = yield* actor.getState.pipe(
                    Effect.catchDefect(() => Effect.succeed({ state: undefined, version: 0 })),
                  )
                  if (state === undefined) continue
                  // @effect-diagnostics-next-line effectSucceedWithVoid:off
                  const derived = yield* Effect.sync(() => deriveFn(state, undefined)).pipe(
                    Effect.catchDefect(() => Effect.succeed(undefined)),
                  )
                  let uiModel = (derived as ExtensionProjection | undefined)?.uiModel
                  if (uiModel !== undefined) {
                    // Validate against schema if provided
                    if (projection.uiModelSchema !== undefined) {
                      const validated = yield* Schema.decodeUnknownEffect(
                        projection.uiModelSchema as Schema.Any,
                      )(uiModel).pipe(
                        Effect.catchEager(() =>
                          Effect.logWarning("extension.uiModel.schemaValidation.failed").pipe(
                            Effect.annotateLogs({ actorId: actor.id }),
                            Effect.as(undefined),
                          ),
                        ),
                      )
                      uiModel = validated
                    }
                  }
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
            ),

          terminateAll: (sessionId) =>
            Effect.withSpan("ExtensionStateRuntime.terminateAll")(
              Effect.gen(function* () {
                const slot = (yield* Ref.get(actorsRef)).get(sessionId)
                if (slot !== undefined && slot._tag === "ready") {
                  for (const { actor } of slot.entries) {
                    yield* actor.terminate.pipe(Effect.catchDefect(() => Effect.void))
                  }
                }
                yield* Ref.update(actorsRef, (map) => {
                  const next = new Map(map)
                  next.delete(sessionId)
                  return next
                })
              }),
            ),
        }
      }),
    )

  static Live = (extensions: ReadonlyArray<LoadedExtension>): Layer.Layer<ExtensionStateRuntime> =>
    ExtensionStateRuntime.fromExtensions(extensions)

  static Test = (): Layer.Layer<ExtensionStateRuntime> => ExtensionStateRuntime.fromExtensions([])
}
