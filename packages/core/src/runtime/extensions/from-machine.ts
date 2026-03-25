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
  ExtensionProjection,
  ExtensionProjectionConfig,
  SpawnActor,
} from "../../domain/extension.js"
import type { BranchId } from "../../domain/ids.js"
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
  /** Derive projections from machine state */
  readonly derive?: (state: State, ctx: ExtensionDeriveContext) => ExtensionProjection
  /** Schema for the uiModel returned by derive() */
  readonly uiModelSchema?: Schema.Schema<unknown>
  /** Schema for serializing/deserializing state to/from JSON */
  readonly stateSchema?: Schema.Schema<State>
  /** If true, state is persisted on state change and hydrated on init */
  readonly persist?: boolean
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
        handleEvent: (event: AgentEvent, _reduceCtx) =>
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
            }
            return changed
          }),

        handleIntent: (() => {
          const mapIntent = config.mapIntent
          if (mapIntent === undefined) return undefined
          return (intent: unknown, _branchId?: BranchId) =>
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

  // Build projection config from derive function
  const projection: ExtensionProjectionConfig | undefined = (() => {
    const deriveFn = config.derive
    if (deriveFn === undefined) return undefined
    return {
      derive: (state: unknown, deriveCtx: ExtensionDeriveContext) =>
        deriveFn(state as State, deriveCtx),
      uiModelSchema: config.uiModelSchema,
    }
  })()

  return { spawnActor, projection }
}
