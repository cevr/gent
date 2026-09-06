/**
 * Admission bookkeeping for work that uses one live resource generation.
 *
 * This module does not acquire resources or own their contexts. The host owns
 * those scopes separately and can retire them after this lease set drains.
 */

import { Deferred, Effect, Option, Ref, Schema, type Scope } from "effect"
import { ResourceGenerationId } from "../../../domain/resource-generation.js"

/** A use rejected after graceful admission closure. */
export class ResourceLeaseClosedError extends Schema.TaggedError<ResourceLeaseClosedError>()(
  "ResourceLeaseClosedError",
  {
    generationId: ResourceGenerationId,
  },
) {}

/** A use rejected after its generation was cancelled or retired. */
export class ResourceLeaseStaleGenerationError extends Schema.TaggedError<ResourceLeaseStaleGenerationError>()(
  "ResourceLeaseStaleGenerationError",
  {
    generationId: ResourceGenerationId,
  },
) {}

export type ResourceLeaseAdmissionError =
  | ResourceLeaseClosedError
  | ResourceLeaseStaleGenerationError

type LeasePhase = "open" | "closed" | "stale"

interface LeaseState {
  readonly phase: LeasePhase
  readonly active: number
}

/**
 * A generation-scoped admission gate.
 *
 * Admission is atomic with the active-use count. Closing the gate prevents
 * later uses, while existing uses continue until their per-use scopes close.
 */
export interface ResourceLeaseSet {
  readonly generationId: ResourceGenerationId
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ResourceLeaseAdmissionError, Exclude<R, Scope.Scope>>
  readonly closeAdmission: Effect.Effect<void>
  readonly awaitDrained: Effect.Effect<void>
  readonly cancel: Effect.Effect<void>
}

/**
 * Creates admission bookkeeping for one process-local generation.
 *
 * The parent scope cancels the generation and waits for every admitted use,
 * including the finalizers registered in each use's fresh scope.
 */
export const makeResourceLeaseSet = (
  generationId: ResourceGenerationId,
): Effect.Effect<ResourceLeaseSet, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<LeaseState>({ phase: "open", active: 0 })
    const cancelled = yield* Deferred.make<void>()
    const drained = yield* Deferred.make<void>()

    const signalDrained = (shouldSignal: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (shouldSignal) yield* Deferred.succeed(drained, void 0)
      })

    const release = Effect.uninterruptible(
      Effect.gen(function* () {
        const shouldSignal = yield* Ref.modify(state, (current) => {
          const active = current.active - 1
          const next: LeaseState = {
            phase: current.phase,
            active,
          }
          return [current.phase !== "open" && active === 0, next] satisfies readonly [
            boolean,
            LeaseState,
          ]
        })
        yield* signalDrained(shouldSignal)
      }),
    )

    const closeAdmission: Effect.Effect<void> = Effect.uninterruptible(
      Effect.gen(function* () {
        const shouldSignal = yield* Ref.modify(state, (current) => {
          if (current.phase !== "open") {
            return [false, current] satisfies readonly [boolean, LeaseState]
          }
          const next: LeaseState = {
            phase: "closed",
            active: current.active,
          }
          return [current.active === 0, next] satisfies readonly [boolean, LeaseState]
        })
        yield* signalDrained(shouldSignal)
      }),
    )

    const cancelTransition = Effect.uninterruptible(
      Effect.gen(function* () {
        const shouldSignal = yield* Ref.modify(state, (current) => {
          if (current.phase === "stale") {
            return [false, current] satisfies readonly [boolean, LeaseState]
          }
          const next: LeaseState = {
            phase: "stale",
            active: current.active,
          }
          return [current.active === 0, next] satisfies readonly [boolean, LeaseState]
        })
        yield* Deferred.succeed(cancelled, void 0)
        yield* signalDrained(shouldSignal)
      }),
    )
    const cancel: Effect.Effect<void> = cancelTransition.pipe(
      Effect.andThen(Deferred.await(drained)),
    )

    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const rejection = yield* Ref.modify(state, (current) => {
            if (current.phase === "open") {
              const next: LeaseState = {
                phase: current.phase,
                active: current.active + 1,
              }
              return [Option.none<ResourceLeaseAdmissionError>(), next] satisfies readonly [
                Option.Option<ResourceLeaseAdmissionError>,
                LeaseState,
              ]
            }
            if (current.phase === "closed") {
              return [
                Option.some<ResourceLeaseAdmissionError>(
                  new ResourceLeaseClosedError({ generationId }),
                ),
                current,
              ] satisfies readonly [Option.Option<ResourceLeaseAdmissionError>, LeaseState]
            }
            return [
              Option.some<ResourceLeaseAdmissionError>(
                new ResourceLeaseStaleGenerationError({ generationId }),
              ),
              current,
            ] satisfies readonly [Option.Option<ResourceLeaseAdmissionError>, LeaseState]
          })

          if (Option.isSome(rejection)) return yield* rejection.value
        }),
        () => {
          const cancellation = Deferred.await(cancelled).pipe(Effect.andThen(Effect.interrupt))
          return Effect.raceFirst(Effect.scoped(effect), cancellation)
        },
        () => release,
      )

    yield* Effect.addFinalizer(() => cancel)

    return {
      generationId,
      run,
      closeAdmission,
      awaitDrained: Deferred.await(drained),
      cancel,
    }
  })
