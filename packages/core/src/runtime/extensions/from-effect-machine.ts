/**
 * fromEffectMachine — wraps an effect-machine BuiltMachine into an ExtensionActor.
 *
 * Full actor semantics: spawn/task/guards/child actors. The machine receives
 * AgentEvents via actor.send() and exposes state via actor.snapshot.
 */

import { Effect } from "effect"
import { Machine, type ActorRef, type BuiltMachine } from "effect-machine"
import type { AgentEvent } from "../../domain/event.js"
import type { ExtensionActor, ExtensionReduceContext, SpawnActor } from "../../domain/extension.js"

export interface FromEffectMachineOptions {
  /** Actor/extension id */
  readonly id: string
  /** Map AgentEvent to machine event. Return undefined to skip. */
  readonly mapEvent?: (event: AgentEvent) => unknown | undefined
}

/**
 * Create a SpawnActor factory from an effect-machine BuiltMachine.
 */
export const fromEffectMachine =
  <
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    State extends { readonly _tag: string },
    Event,
    R,
  >(
    built: BuiltMachine<State, Event, R>,
    options: FromEffectMachineOptions,
  ): SpawnActor =>
  // @effect-diagnostics *:off
  (ctx) =>
    Effect.gen(function* () {
      const spawnId = `${options.id}-${ctx.sessionId}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spawnEffect = (Machine.spawn as any)(built, spawnId) as Effect.Effect<
        ActorRef<State, Event>
      >
      const ref = yield* spawnEffect
      let version = 0

      const actor: ExtensionActor = {
        id: options.id,

        init: Effect.void,

        handleEvent: (event: AgentEvent, _reduceCtx: ExtensionReduceContext) => {
          const mapped =
            options.mapEvent !== undefined ? options.mapEvent(event) : (event as unknown)
          if (mapped === undefined) return Effect.succeed(false)
          return ref.send(mapped as Event).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                version++
              }),
            ),
            Effect.as(true),
            Effect.catchDefect(() => Effect.succeed(false)),
          )
        },

        getState: Effect.gen(function* () {
          const state = yield* ref.snapshot
          return { state, version }
        }),

        terminate: ref.stop,
      }

      return actor
    })
