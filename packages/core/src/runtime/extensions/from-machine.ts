/**
 * fromMachine — wraps an effect-machine BuiltMachine into an ExtensionActor.
 *
 * Full parity with fromReducer: handleEvent, handleIntent, persistence,
 * atomic version tracking via Ref, projection externalization.
 */

import { Effect, Ref, Schema } from "effect"
import { Machine, type ActorRef, type BuiltMachine } from "effect-machine"
import type { AgentEvent } from "../../domain/event.js"
import type {
  ExtensionActor,
  ExtensionDeriveContext,
  ExtensionEffect,
  ExtensionProjection,
  ExtensionProjectionConfig,
  SpawnActor,
} from "../../domain/extension.js"
import type { BranchId } from "../../domain/ids.js"
import { ExtensionEventBus } from "./event-bus.js"
import { ExtensionTurnControl } from "./turn-control.js"
import { Storage } from "../../storage/sqlite-storage.js"

export interface FromMachineConfig<
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
  Intent = void,
  R = never,
> {
  /** Actor/extension id */
  readonly id: string
  /** The built machine to wrap */
  readonly built: BuiltMachine<State, Event, R>
  /** Map AgentEvent to machine event. Return undefined to skip. */
  readonly mapEvent?: (event: AgentEvent) => Event | undefined
  /** Map intent to machine event for handleIntent support */
  readonly mapIntent?: (intent: Intent) => Event
  /** Intent schema for validation */
  readonly intentSchema?: Schema.Schema<Intent>
  /** Full derive — turn + UI projection from one function */
  readonly derive?: (state: State, ctx: ExtensionDeriveContext) => ExtensionProjection
  /** Context-free UI model derivation — preferred over derive for UI snapshots */
  readonly deriveUi?: (state: State) => unknown
  /** Schema for the uiModel returned by derive/deriveUi */
  readonly uiModelSchema?: Schema.Schema<unknown>
  /** Schema for serializing/deserializing state to/from JSON */
  readonly stateSchema?: Schema.Schema<State>
  /** If true, state is persisted on state change and hydrated on init */
  readonly persist?: boolean
  /** Compute extension effects after a state transition. Called with (before, after). */
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<ExtensionEffect>
}

export interface FromMachineResult {
  readonly spawnActor: SpawnActor
  readonly projection?: ExtensionProjectionConfig
}

/**
 * Create a SpawnActor factory + projection config from an effect-machine BuiltMachine.
 */
export const fromMachine = <
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
  Intent = void,
  R = never,
>(
  config: FromMachineConfig<State, Event, Intent, R>,
): FromMachineResult => {
  const spawnActor: SpawnActor = (ctx) =>
    Effect.gen(function* () {
      const turnControl = yield* ExtensionTurnControl
      const eventBus = yield* ExtensionEventBus
      const storage = yield* Effect.serviceOption(Storage)
      const versionRef = yield* Ref.make(0)

      const spawnId = `${config.id}-${ctx.sessionId}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spawnEffect = (Machine.spawn as any)(config.built, spawnId) as Effect.Effect<
        ActorRef<State, Event>
      >
      const ref = yield* spawnEffect

      // Persistence: save state to storage
      const persistState = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (storage._tag !== "Some" || config.stateSchema === undefined) return
          const state = yield* ref.snapshot
          const version = yield* Ref.get(versionRef)
          const encoded = Schema.encodeSync(
            Schema.fromJsonString(config.stateSchema as Schema.Any),
          )(state)
          yield* storage.value
            .saveExtensionState({
              sessionId: ctx.sessionId,
              extensionId: config.id,
              stateJson: encoded,
              version,
            })
            .pipe(Effect.catchEager(() => Effect.void))
        })

      const runEffects = (
        effects: ReadonlyArray<ExtensionEffect>,
        branchId: BranchId | undefined,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (const effect of effects) {
            switch (effect._tag) {
              case "QueueFollowUp":
                if (branchId !== undefined) {
                  yield* turnControl
                    .queueFollowUp({
                      sessionId: ctx.sessionId,
                      branchId,
                      content: effect.content,
                      metadata: effect.metadata,
                    })
                    .pipe(Effect.catchDefect(() => Effect.void))
                }
                break
              case "Interject":
                if (branchId !== undefined) {
                  yield* turnControl
                    .interject({ sessionId: ctx.sessionId, branchId, content: effect.content })
                    .pipe(Effect.catchDefect(() => Effect.void))
                }
                break
              case "EmitEvent":
                yield* eventBus
                  .emit(effect.channel, effect.payload)
                  .pipe(Effect.catchDefect(() => Effect.void))
                break
              case "Persist":
                if (config.persist === true) {
                  yield* persistState().pipe(Effect.catchDefect(() => Effect.void))
                }
                break
            }
          }
        }).pipe(Effect.catchDefect(() => Effect.void))

      const actor: ExtensionActor = {
        id: config.id,

        // Hydrate persisted state on init
        init:
          config.persist === true
            ? Effect.gen(function* () {
                if (storage._tag !== "Some" || config.stateSchema === undefined) return
                const loaded = yield* storage.value
                  .loadExtensionState({ sessionId: ctx.sessionId, extensionId: config.id })
                  .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
                if (loaded === undefined) return
                const decoded = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(config.stateSchema as Schema.Any),
                )(loaded.stateJson).pipe(
                  Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))),
                )
                if (decoded === undefined) return
                // Hydrate by directly setting the SubscriptionRef's value
                ref.state.value = decoded
                yield* Ref.set(versionRef, loaded.version)
              })
            : Effect.void,

        // @effect-diagnostics *:off
        handleEvent: (event: AgentEvent, reduceCtx) =>
          Effect.gen(function* () {
            const mapped = config.mapEvent !== undefined ? config.mapEvent(event) : undefined
            if (mapped === undefined) return false

            const before = yield* ref.snapshot
            yield* ref.send(mapped).pipe(Effect.catchDefect(() => Effect.void))
            // Yield to let the machine fiber process the queued event
            yield* Effect.yieldNow
            const after = yield* ref.snapshot

            const changed = before !== after
            if (changed) {
              yield* Ref.update(versionRef, (v) => v + 1)
              if (config.persist === true) {
                yield* persistState().pipe(Effect.catchDefect(() => Effect.void))
              }
              // Run extension effects from afterTransition hook
              if (config.afterTransition !== undefined) {
                const effects = config.afterTransition(before, after)
                if (effects.length > 0) {
                  yield* runEffects(effects, reduceCtx.branchId)
                }
              }
            }
            return changed
          }),

        handleIntent: (() => {
          const mapIntent = config.mapIntent
          if (mapIntent === undefined) return undefined
          return (intent: unknown, branchId?: BranchId) =>
            Effect.gen(function* () {
              let validated: Intent = intent as Intent
              if (config.intentSchema !== undefined) {
                validated = yield* Schema.decodeUnknownEffect(config.intentSchema as Schema.Any)(
                  intent,
                ).pipe(Effect.orDie)
              }

              const machineEvent = mapIntent(validated)
              const before = yield* ref.snapshot
              yield* ref.send(machineEvent).pipe(Effect.catchDefect(() => Effect.void))
              // Yield to let the machine fiber process the queued event
              yield* Effect.yieldNow
              const after = yield* ref.snapshot

              const changed = before !== after
              if (changed) {
                yield* Ref.update(versionRef, (v) => v + 1)
                if (config.persist === true) {
                  yield* persistState().pipe(Effect.catchDefect(() => Effect.void))
                }
                if (config.afterTransition !== undefined) {
                  const effects = config.afterTransition(before, after)
                  if (effects.length > 0) {
                    yield* runEffects(effects, branchId)
                  }
                }
              }
              return changed
            })
        })(),

        getState: Effect.gen(function* () {
          const state = yield* ref.snapshot
          const version = yield* Ref.get(versionRef)
          return { state, version }
        }),

        terminate: ref.stop,
      }

      return actor
    })

  // Build projection config — split into turn-time and UI boundaries
  const projection: ExtensionProjectionConfig | undefined = (() => {
    const deriveFn = config.derive
    const deriveUiFn = config.deriveUi
    if (deriveFn === undefined && deriveUiFn === undefined) return undefined

    let deriveTurn: ExtensionProjectionConfig["deriveTurn"]
    if (deriveFn !== undefined) {
      deriveTurn = (state: unknown, deriveCtx: ExtensionDeriveContext) => {
        const { uiModel: _, ...turn } = deriveFn(state as State, deriveCtx)
        return turn
      }
    }

    let deriveUi: ExtensionProjectionConfig["deriveUi"]
    if (deriveUiFn !== undefined) {
      deriveUi = (state: unknown) => deriveUiFn(state as State)
    } else if (deriveFn !== undefined) {
      deriveUi = (state: unknown) =>
        deriveFn(state as State, { agent: undefined as never, allTools: [] }).uiModel
    }

    return { deriveTurn, deriveUi, uiModelSchema: config.uiModelSchema }
  })()

  return { spawnActor, projection }
}
