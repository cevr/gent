/**
 * ActorHost — spawns extension-contributed `Behavior` values into the
 * `ActorEngine` at runtime startup.
 *
 * Each extension's `actors` bucket is a list of `Behavior<M, S, never>`
 * values. The host iterates the resolved extension list and calls
 * `ActorEngine.spawn(behavior)` for each one. Spawn lifetime is bound
 * to the host layer's scope: when the runtime tears down, the engine's
 * scope-close interrupts every spawned actor fiber.
 *
 * Failure surfacing: a failing spawn does not collapse the layer — the
 * runtime should keep running with the actors that did spawn cleanly.
 * Failures are recorded into an `ActorHostFailures` snapshot so the
 * profile composer can route them into `RuntimeProfile.failed` and
 * make them visible to status / health surfaces. Pure log-and-skip
 * would leave the failure invisible to the rest of the system.
 */

import { Cause, Context, Effect, Layer, Ref } from "effect"
import { ActorEngine } from "./actor-engine.js"
import type { ResolvedExtensions } from "./registry.js"

export interface ActorSpawnFailure {
  readonly extensionId: string
  readonly error: string
}

interface ActorHostFailuresService {
  readonly snapshot: Effect.Effect<ReadonlyArray<ActorSpawnFailure>>
}

/**
 * Snapshot of every spawn failure observed at host startup. Read once
 * by the profile composer after the runtime layer is built. A failing
 * spawn is recorded here AND logged; the recording is the
 * programmatic signal the rest of the system observes.
 */
export class ActorHostFailures extends Context.Service<
  ActorHostFailures,
  ActorHostFailuresService
>()("@gent/core/src/runtime/extensions/actor-host/ActorHostFailures") {}

const spawnContributedActors = (
  resolved: ResolvedExtensions,
  failuresRef: Ref.Ref<ReadonlyArray<ActorSpawnFailure>>,
): Effect.Effect<void, never, ActorEngine> =>
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    for (const ext of resolved.extensions) {
      const behaviors = ext.contributions.actors ?? []
      for (const behavior of behaviors) {
        yield* engine.spawn(behavior).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const error = String(Cause.squash(cause))
              yield* Ref.update(failuresRef, (xs) => [
                ...xs,
                { extensionId: ext.manifest.id, error },
              ])
              yield* Effect.logWarning("actor-host.spawn.failed").pipe(
                Effect.annotateLogs({ extensionId: ext.manifest.id, error }),
              )
            }),
          ),
        )
      }
    }
  })

/**
 * Layer that spawns every extension's `actors` into the running
 * `ActorEngine` and exposes the resulting failure list as
 * `ActorHostFailures`. Composed into the runtime layer alongside
 * `ActorEngine.Live`.
 */
export const ActorHost = {
  fromResolved: (
    resolved: ResolvedExtensions,
  ): Layer.Layer<ActorHostFailures, never, ActorEngine> =>
    Layer.effect(
      ActorHostFailures,
      Effect.gen(function* () {
        const failuresRef = yield* Ref.make<ReadonlyArray<ActorSpawnFailure>>([])
        yield* spawnContributedActors(resolved, failuresRef)
        return { snapshot: Ref.get(failuresRef) }
      }),
    ),
}
