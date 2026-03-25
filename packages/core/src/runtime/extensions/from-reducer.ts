/**
 * fromReducer — wraps a pure reducer into an ExtensionActor.
 *
 * This is the simple-path constructor for extensions that don't need
 * full effect-machine actors. The reducer is pure (state, event, ctx) → ReduceResult,
 * and effects are interpreted by the framework.
 */

import { Effect, Ref, Schema } from "effect"
import type { AgentEvent } from "../../domain/event.js"
import type {
  ExtensionActor,
  ExtensionDeriveContext,
  ExtensionEffect,
  ExtensionProjection,
  ExtensionProjectionConfig,
  ExtensionReduceContext,
  ReduceResult,
  SpawnActor,
} from "../../domain/extension.js"
import type { SessionId, BranchId } from "../../domain/ids.js"
import { Storage } from "../../storage/sqlite-storage.js"
import type { ExtensionEventBusService } from "./event-bus.js"
import { ExtensionEventBus } from "./event-bus.js"
import type { ExtensionTurnControlService } from "./turn-control.js"
import { ExtensionTurnControl } from "./turn-control.js"

export interface FromReducerConfig<State, Intent = void> {
  readonly id: string
  readonly initial: State
  readonly reduce: (
    state: State,
    event: AgentEvent,
    ctx: ExtensionReduceContext,
  ) => ReduceResult<State>
  readonly derive?: (state: State, ctx: ExtensionDeriveContext) => ExtensionProjection
  readonly handleIntent?: (state: State, intent: Intent) => ReduceResult<State>
  readonly intentSchema?: Schema.Schema<Intent>
  /** Schema for the uiModel returned by derive() — used for transport encoding/validation */
  readonly uiModelSchema?: Schema.Schema<unknown>
  /** Schema for serializing/deserializing state to/from JSON (required for persistence) */
  readonly stateSchema?: Schema.Schema<State>
  /** If true, state is persisted on Persist effect and hydrated on init */
  readonly persist?: boolean
}

const interpretEffects = (
  effects: ReadonlyArray<ExtensionEffect>,
  sessionId: SessionId,
  branchId: BranchId | undefined,
  turnControl: ExtensionTurnControlService,
  eventBus: ExtensionEventBusService,
  persistFn?: () => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const effect of effects) {
      switch (effect._tag) {
        case "QueueFollowUp":
          if (branchId !== undefined) {
            yield* turnControl
              .queueFollowUp({
                sessionId,
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
              .interject({ sessionId, branchId, content: effect.content })
              .pipe(Effect.catchDefect(() => Effect.void))
          }
          break
        case "EmitEvent":
          yield* eventBus
            .emit(effect.channel, effect.payload)
            .pipe(Effect.catchDefect(() => Effect.void))
          break
        case "Persist":
          if (persistFn !== undefined) {
            yield* persistFn().pipe(Effect.catchDefect(() => Effect.void))
          }
          break
      }
    }
  })

export interface FromReducerResult {
  readonly spawnActor: SpawnActor
  readonly projection?: ExtensionProjectionConfig
}

/**
 * Create a SpawnActor factory + projection config from a pure reducer config.
 *
 * Services (ExtensionTurnControl, ExtensionEventBus) are acquired at spawn
 * time and closed over — the returned actor's methods have no service requirements.
 */
export const fromReducer = <State, Intent = void>(
  config: FromReducerConfig<State, Intent>,
): FromReducerResult => {
  const spawnActor: SpawnActor = (ctx) =>
    Effect.gen(function* () {
      const turnControl = yield* ExtensionTurnControl
      const eventBus = yield* ExtensionEventBus
      const storage = yield* Effect.serviceOption(Storage)
      const stateRef = yield* Ref.make<State>(config.initial)
      const versionRef = yield* Ref.make(0)

      // Persistence: save state to storage
      const persistState = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (storage._tag !== "Some" || config.stateSchema === undefined) return
          const state = yield* Ref.get(stateRef)
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
      ) =>
        interpretEffects(
          effects,
          ctx.sessionId,
          branchId,
          turnControl,
          eventBus,
          config.persist === true ? persistState : undefined,
        ).pipe(Effect.catchDefect(() => Effect.void))

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
                yield* Ref.set(stateRef, decoded as State)
                yield* Ref.set(versionRef, loaded.version)
              })
            : Effect.void,

        handleEvent: (event: AgentEvent, reduceCtx: ExtensionReduceContext) =>
          Effect.gen(function* () {
            // Atomic read-reduce-write: Ref.modify returns the result, writes the new state
            const { changed, effects } = yield* Ref.modify(stateRef, (current) => {
              const result = config.reduce(current, event, reduceCtx)
              const didChange = result.state !== current
              return [{ changed: didChange, effects: result.effects }, result.state]
            })
            if (changed) {
              yield* Ref.update(versionRef, (v) => v + 1)
              // Auto-persist on state change when persist: true
              if (config.persist === true) {
                yield* persistState().pipe(Effect.catchDefect(() => Effect.void))
              }
            }
            if (effects !== undefined && effects.length > 0) {
              // Use current call-time branchId, not spawn-time branchId
              yield* runEffects(effects, reduceCtx.branchId)
            }
            return changed
          }),

        handleIntent: (() => {
          const handler = config.handleIntent
          if (handler === undefined) return undefined
          return (intent: unknown, branchId?: BranchId) =>
            Effect.gen(function* () {
              let validated: Intent = intent as Intent
              if (config.intentSchema !== undefined) {
                validated = yield* Schema.decodeUnknownEffect(config.intentSchema as Schema.Any)(
                  intent,
                ).pipe(Effect.orDie)
              }

              const { changed, effects } = yield* Ref.modify(stateRef, (current) => {
                const result = handler(current, validated)
                const didChange = result.state !== current
                return [{ changed: didChange, effects: result.effects }, result.state]
              })
              if (changed) {
                yield* Ref.update(versionRef, (v) => v + 1)
                if (config.persist === true) {
                  yield* persistState().pipe(Effect.catchDefect(() => Effect.void))
                }
              }
              if (effects !== undefined && effects.length > 0) {
                // Use call-time branchId, not spawn-time branchId
                yield* runEffects(effects, branchId)
              }
              return changed
            })
        })(),

        getState: Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          const version = yield* Ref.get(versionRef)
          return { state, version }
        }),

        terminate: Effect.void,
      }

      return actor
    })

  // Build projection config from derive function (externalized from actor)
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
