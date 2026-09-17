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

import { Cause, Context, Deferred, Effect, Exit, Fiber, Ref } from "effect"
import { ToolResultFailure } from "../../domain/tool-output.js"

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
  /** Completes when the turn now running is interrupted; work races it to stop. */
  readonly awaitInterrupt: Effect.Effect<void>
}

export const makeTurnInterruption: Effect.Effect<TurnInterruption> = Effect.gen(function* () {
  // One latch per turn: a bit can only be polled, a latch can also be raced.
  const latch = yield* Ref.make(yield* Deferred.make<void>())
  return {
    interrupted: Ref.get(latch).pipe(Effect.flatMap(Deferred.isDone)),
    interrupt: Ref.get(latch).pipe(Effect.flatMap((turn) => Deferred.succeed(turn, void 0))),
    beginTurn: Deferred.make<void>().pipe(Effect.flatMap((turn) => Ref.set(latch, turn))),
    awaitInterrupt: Ref.get(latch).pipe(Effect.flatMap(Deferred.await)),
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

/**
 * The running turn's interrupt, as a tool call sees it. The loop provides it
 * for every call it dispatches; a tool run with no turn -- a test, a direct
 * host call -- is never interrupted.
 */
export const TurnInterruptSignal = Context.Reference<Effect.Effect<void>>(
  "@gent/core/src/runtime/agent/turn-interruption/TurnInterruptSignal",
  { defaultValue: () => Effect.never },
)

/**
 * A tool stops with its turn, and its call still gets a result. The interrupt
 * waits for the tool to exit: a tool that runs uninterruptible and cancels its
 * own work reports what it chose to; any other tool reports the interrupt.
 */
export const stopWithTurn = <A, E, R>(execute: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const interruption = yield* TurnInterruptSignal
    const fiber = yield* Effect.forkChild(execute)
    const exit = yield* Effect.raceFirst(
      Fiber.await(fiber),
      interruption.pipe(Effect.andThen(Fiber.interrupt(fiber)), Effect.andThen(Fiber.await(fiber))),
    )
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
      return yield* new ToolResultFailure({
        message: "The turn was interrupted.",
        result: { error: "The turn was interrupted.", reason: "Interrupted" },
      })
    }
    return yield* exit
  })
