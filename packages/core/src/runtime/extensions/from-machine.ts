/**
 * fromMachine — wraps an effect-machine Machine into an ExtensionActor.
 *
 * Parity with fromReducer: handleEvent, handleIntent, persistence,
 * version tracking via Ref, projection externalization.
 *
 * Uses ActorRef.call for atomic change detection — sends event through
 * the queue and gets back a ProcessEventResult receipt. No more before/yield/after.
 */

import { Effect, Ref, Schema } from "effect"
import { Machine } from "effect-machine"
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
import { buildProjectionConfig } from "./extension-actor-shared.js"

export interface FromMachineConfig<
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
  Intent = void,
  R = never,
> {
  /** Actor/extension id */
  readonly id: string
  /** The built machine to wrap */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly built: Machine.Machine<State, Event, R, any, any, any>
  /** Map AgentEvent to machine event. Return undefined to skip. */
  readonly mapEvent?: (event: AgentEvent) => Event | undefined
  /** Map intent to machine event for handleIntent support. Receives current state for conditional mapping. Return undefined to skip. */
  readonly mapIntent?: (intent: Intent, state: State) => Event | undefined
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
 * Create a SpawnActor factory + projection config from an effect-machine Machine.
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

      // Load persisted state before spawn so we can hydrate
      let hydratedState: State | undefined
      let initialVersion = 0
      if (config.persist === true && storage._tag === "Some" && config.stateSchema !== undefined) {
        const loaded = yield* storage.value
          .loadExtensionState({ sessionId: ctx.sessionId, extensionId: config.id })
          .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
        if (loaded !== undefined) {
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(config.stateSchema as Schema.Any),
          )(loaded.stateJson).pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
          if (decoded !== undefined) {
            hydratedState = decoded as State
            initialVersion = loaded.version
          }
        }
      }

      const ref = yield* Machine.spawn(config.built, {
        id: spawnId,
        ...(hydratedState !== undefined ? { hydrate: hydratedState } : {}),
      })
      if (initialVersion > 0) {
        yield* Ref.set(versionRef, initialVersion)
      }

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

      // Dispatch event through actor, handle version + persist + afterTransition
      const dispatch = (machineEvent: Event, branchId: BranchId | undefined) =>
        Effect.gen(function* () {
          const result = yield* ref.call(machineEvent).pipe(
            Effect.catchDefect(() =>
              Effect.succeed({
                transitioned: false,
                previousState: undefined,
                newState: undefined,
                lifecycleRan: false,
                isFinal: false,
                hasReply: false,
                postponed: false,
              }),
            ),
          )
          if (!result.transitioned) return false
          yield* Ref.update(versionRef, (v) => v + 1)
          if (config.persist === true) {
            yield* persistState().pipe(Effect.catchDefect(() => Effect.void))
          }
          if (config.afterTransition !== undefined && result.previousState !== undefined) {
            const effects = config.afterTransition(
              result.previousState as State,
              result.newState as State,
            )
            if (effects.length > 0) {
              yield* runEffects(effects, branchId)
            }
          }
          return true
        })

      const actor: ExtensionActor = {
        id: config.id,

        init: Effect.void,

        handleEvent: (event: AgentEvent, reduceCtx) =>
          Effect.gen(function* () {
            const mapped = config.mapEvent !== undefined ? config.mapEvent(event) : undefined
            if (mapped === undefined) return false
            return yield* dispatch(mapped, reduceCtx.branchId)
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
              const currentState = (yield* ref.snapshot) as State
              const mapped = mapIntent(validated, currentState)
              if (mapped === undefined) return false
              return yield* dispatch(mapped, branchId)
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

  const projection = buildProjectionConfig<State>({
    derive: config.derive,
    deriveUi: config.deriveUi,
    uiModelSchema: config.uiModelSchema as Schema.Any | undefined,
  })

  return { spawnActor, projection }
}
