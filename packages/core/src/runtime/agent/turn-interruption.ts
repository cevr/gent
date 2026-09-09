/**
 * Whether the turn now running has been interrupted.
 *
 * The loop, the turn executor and the branch's tools all need this one bit,
 * but they need different halves of it: the worker interrupts a turn and
 * begins the next one, while a running turn and the tools it dispatches only
 * ask. A shared `Ref.Ref<boolean>` gave every one of them both halves and left
 * the meaning of `true` and `false` to be re-derived at each call site.
 *
 * Naming the two transitions keeps that meaning in one place: `interrupt`
 * stops the turn now running, and `beginTurn` declares that a fresh turn
 * starts uninterrupted.
 *
 * @module
 */

import { Effect, Ref } from "effect"

/** Asks whether the turn now running has been interrupted. */
export interface TurnInterruptionStatus {
  readonly interrupted: Effect.Effect<boolean>
}

/** The full control surface: the read side plus the two transitions. */
export interface TurnInterruption extends TurnInterruptionStatus {
  /** Stop the turn now running. Work that checks `interrupted` will see it. */
  readonly interrupt: Effect.Effect<void>
  /** A fresh turn begins, so it is not interrupted. */
  readonly beginTurn: Effect.Effect<void>
}

export const makeTurnInterruption: Effect.Effect<TurnInterruption> = Effect.gen(function* () {
  const ref = yield* Ref.make(false)
  return {
    interrupted: Ref.get(ref),
    interrupt: Ref.set(ref, true),
    beginTurn: Ref.set(ref, false),
  }
})

/**
 * A status that is never interrupted.
 *
 * Branch work built outside a running loop -- a test that exercises a tool on
 * its own -- has no turn to be interrupted.
 */
export const neverInterrupted: TurnInterruptionStatus = {
  interrupted: Effect.succeed(false),
}
