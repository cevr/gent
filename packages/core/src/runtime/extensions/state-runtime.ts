import { ServiceMap, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import type { AgentEvent, ExtensionUiSnapshot } from "../../domain/event.js"
import { ExtensionUiSnapshot as ExtensionUiSnapshotClass } from "../../domain/event.js"
import type {
  ExtensionActor,
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionReduceContext,
  ExtensionStateMachine,
  LoadedExtension,
  SpawnActor,
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

// ── Legacy projection machine entries ──

interface ExtensionEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly machine: ExtensionStateMachine<any, any>
  state: unknown
  epoch: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MachineList = ReadonlyArray<ExtensionStateMachine<any, any>>

const initEntries = (machines: MachineList): ExtensionEntry[] =>
  machines.map((machine) => ({ machine, state: machine.initial, epoch: 0 }))

// ── Actor entries ──

interface ActorEntry {
  readonly actor: ExtensionActor
}

// Service

export interface ExtensionStateRuntimeService {
  /** Feed an event to all registered state machines + actors for a session. Returns true if any changed. */
  readonly reduce: (event: AgentEvent, ctx: ExtensionReduceContext) => Effect.Effect<boolean>

  /** Get current projections from all extensions (machines + actors) */
  readonly deriveAll: (
    sessionId: SessionId,
    ctx: ExtensionDeriveContext,
  ) => Effect.Effect<ReadonlyArray<{ extensionId: string; projection: ExtensionProjection }>>

  /** Handle a typed intent from the client (epoch-validated, schema-validated) */
  readonly handleIntent: (
    sessionId: SessionId,
    extensionId: string,
    intent: unknown,
    epoch: number,
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
        // Collect legacy machines from extensions
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const machines: ExtensionStateMachine<any, any>[] = []
        const spawnActors: Array<{ extensionId: string; spawn: SpawnActor }> = []
        for (const ext of extensions) {
          if (ext.setup.stateMachine !== undefined) {
            machines.push(ext.setup.stateMachine)
          }
          if (ext.setup.spawnActor !== undefined) {
            spawnActors.push({ extensionId: ext.manifest.id, spawn: ext.setup.spawnActor })
          }
        }

        // Session-scoped state: legacy machines
        const sessionsRef = yield* Ref.make<Map<SessionId, ExtensionEntry[]>>(new Map())
        // Session-scoped actors
        const actorsRef = yield* Ref.make<Map<SessionId, ActorEntry[]>>(new Map())

        const getOrInitSession = (sessionId: SessionId) =>
          Ref.modify(sessionsRef, (sessions) => {
            const existing = sessions.get(sessionId)
            if (existing !== undefined) return [existing, sessions]
            const entries = initEntries(machines)
            const next = new Map(sessions)
            next.set(sessionId, entries)
            return [entries, next]
          })

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
              for (const { spawn } of spawnActors) {
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
                  entries.push({ actor })
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
              // Legacy machines
              const entries = yield* getOrInitSession(ctx.sessionId)
              let changed = false
              const updated = entries.map((entry) => {
                const nextState = entry.machine.reduce(entry.state, event, ctx)
                if (nextState === entry.state) return entry
                changed = true
                return { ...entry, state: nextState, epoch: entry.epoch + 1 }
              })
              if (changed) {
                yield* Ref.update(sessionsRef, (sessions) => {
                  const next = new Map(sessions)
                  next.set(ctx.sessionId, updated)
                  return next
                })
              }

              // Actors — supervised dispatch, track version changes
              const actors = yield* getOrSpawnActors(ctx.sessionId, ctx.branchId)
              for (const { actor } of actors) {
                const before = yield* actor.snapshot.pipe(
                  Effect.catchDefect(() => Effect.succeed({ state: undefined, version: -1 })),
                )
                yield* actor
                  .handleEvent(event, ctx)
                  .pipe(
                    Effect.catchDefect((defect) =>
                      Effect.logWarning(`Actor ${actor.id} handleEvent failed: ${defect}`),
                    ),
                  )
                const after = yield* actor.snapshot.pipe(
                  Effect.catchDefect(() => Effect.succeed({ state: undefined, version: -1 })),
                )
                if (after.version !== before.version) changed = true
              }

              return changed
            }),

          deriveAll: (sessionId, ctx) =>
            Effect.gen(function* () {
              // Legacy machines
              const entries = yield* getOrInitSession(sessionId)
              const machineResults = entries.map((entry) => ({
                extensionId: entry.machine.id,
                projection: entry.machine.derive(entry.state, ctx),
              }))

              // Actors (lazy spawn on first access)
              const actors = yield* getOrSpawnActors(sessionId)
              const actorResults: Array<{ extensionId: string; projection: ExtensionProjection }> =
                []
              for (const { actor } of actors) {
                if (actor.derive !== undefined) {
                  const { state } = yield* actor.snapshot.pipe(
                    Effect.catchDefect(() => Effect.succeed({ state: undefined, version: 0 })),
                  )
                  if (state !== undefined) {
                    actorResults.push({
                      extensionId: actor.id,
                      projection: actor.derive(state, ctx),
                    })
                  }
                }
              }

              return [...machineResults, ...actorResults]
            }),

          handleIntent: (sessionId, extensionId, intent, epoch) =>
            Effect.gen(function* () {
              // Try legacy machines first
              const entries = yield* getOrInitSession(sessionId)
              const idx = entries.findIndex((e) => e.machine.id === extensionId)
              if (idx !== -1) {
                const entry = entries[idx]
                if (entry === undefined) return
                if (epoch < entry.epoch) {
                  return yield* new StaleIntentError({
                    extensionId,
                    expectedEpoch: entry.epoch,
                    actualEpoch: epoch,
                  })
                }

                const handler = entry.machine.handleIntent
                if (handler === undefined) return

                let validatedIntent: unknown = intent
                if (entry.machine.intentSchema !== undefined) {
                  validatedIntent = yield* Schema.decodeUnknownEffect(
                    entry.machine.intentSchema as Schema.Any,
                  )(intent).pipe(
                    Effect.catchEager(() =>
                      Effect.fail(
                        new StaleIntentError({
                          extensionId,
                          expectedEpoch: entry.epoch,
                          actualEpoch: epoch,
                        }),
                      ),
                    ),
                  )
                }

                const result = handler(entry.state, validatedIntent)
                yield* Ref.update(sessionsRef, (sessions) => {
                  const current = sessions.get(sessionId)
                  if (current === undefined) return sessions
                  const next = new Map(sessions)
                  next.set(
                    sessionId,
                    current.map((e, i) =>
                      i === idx ? { ...e, state: result.state, epoch: e.epoch + 1 } : e,
                    ),
                  )
                  return next
                })

                if (result.effects !== undefined) {
                  for (const eff of result.effects) {
                    yield* eff.pipe(Effect.catchDefect(() => Effect.void))
                  }
                }
                return
              }

              // Try actors
              const actors = (yield* Ref.get(actorsRef)).get(sessionId) ?? []
              const actorEntry = actors.find((a) => a.actor.id === extensionId)
              if (actorEntry?.actor.handleIntent !== undefined) {
                yield* actorEntry.actor
                  .handleIntent(intent)
                  .pipe(Effect.catchDefect(() => Effect.void))
              }
            }),

          getUiSnapshots: (sessionId, branchId) =>
            Effect.gen(function* () {
              const snapshots: ExtensionUiSnapshot[] = []

              // Legacy machines
              const entries = yield* getOrInitSession(sessionId)
              for (const entry of entries) {
                if (entry.machine.uiModelSchema === undefined) continue
                const projection = entry.machine.derive(entry.state, {
                  agent: undefined as never,
                  allTools: [],
                })
                if (projection.uiModel !== undefined) {
                  const validated =
                    entry.machine.uiModelSchema !== undefined
                      ? Schema.decodeUnknownSync(entry.machine.uiModelSchema as Schema.Any)(
                          projection.uiModel,
                        )
                      : projection.uiModel
                  snapshots.push(
                    new ExtensionUiSnapshotClass({
                      sessionId,
                      branchId,
                      extensionId: entry.machine.id,
                      epoch: entry.epoch,
                      model: validated,
                    }),
                  )
                }
              }

              // Actors (lazy spawn on first access)
              const actors = yield* getOrSpawnActors(sessionId, branchId)
              for (const { actor } of actors) {
                if (actor.derive === undefined) continue
                const { state, version } = yield* actor.snapshot.pipe(
                  Effect.catchDefect(() => Effect.succeed({ state: undefined, version: 0 })),
                )
                if (state === undefined) continue
                const projection = actor.derive(state, { agent: undefined as never, allTools: [] })
                if (projection.uiModel !== undefined) {
                  snapshots.push(
                    new ExtensionUiSnapshotClass({
                      sessionId,
                      branchId,
                      extensionId: actor.id,
                      epoch: version,
                      model: projection.uiModel,
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
              yield* Ref.update(sessionsRef, (map) => {
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
