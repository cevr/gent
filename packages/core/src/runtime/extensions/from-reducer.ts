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
  ExtensionReduceContext,
  ReduceResult,
  SpawnActor,
} from "../../domain/extension.js"
import type { SessionId, BranchId } from "../../domain/ids.js"
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
}

const interpretEffects = (
  effects: ReadonlyArray<ExtensionEffect>,
  sessionId: SessionId,
  branchId: BranchId | undefined,
  turnControl: ExtensionTurnControlService,
  eventBus: ExtensionEventBusService,
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
          // Persistence wired in Batch 4
          break
      }
    }
  })

/**
 * Create a SpawnActor factory from a pure reducer config.
 *
 * Services (ExtensionTurnControl, ExtensionEventBus) are acquired at spawn
 * time and closed over — the returned actor's methods have no service requirements.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fromReducer =
  <State, Intent = void>(config: FromReducerConfig<State, Intent>): SpawnActor =>
  (ctx) =>
    Effect.gen(function* () {
      const turnControl = yield* ExtensionTurnControl
      const eventBus = yield* ExtensionEventBus
      const stateRef = yield* Ref.make<State>(config.initial)
      const versionRef = yield* Ref.make(0)

      const runEffects = (effects: ReadonlyArray<ExtensionEffect>) =>
        interpretEffects(effects, ctx.sessionId, ctx.branchId, turnControl, eventBus).pipe(
          Effect.catchDefect(() => Effect.void),
        )

      const actor: ExtensionActor = {
        id: config.id,

        init: Effect.void,

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
            }
            if (effects !== undefined && effects.length > 0) {
              yield* runEffects(effects)
            }
          }),

        handleIntent: (() => {
          const handler = config.handleIntent
          if (handler === undefined) return undefined
          return (intent: unknown) =>
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
              }
              if (effects !== undefined && effects.length > 0) {
                yield* runEffects(effects)
              }
            })
        })(),

        snapshot: Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          const version = yield* Ref.get(versionRef)
          return { state, version }
        }),

        derive: (() => {
          const deriveFn = config.derive
          if (deriveFn === undefined) return undefined
          return (state: unknown, deriveCtx: ExtensionDeriveContext) =>
            deriveFn(state as State, deriveCtx)
        })(),

        terminate: Effect.void,
      }

      return actor
    })
