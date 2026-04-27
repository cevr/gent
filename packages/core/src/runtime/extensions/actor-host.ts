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
import type { Behavior } from "../../domain/actor.js"
import { ActorEngine } from "./actor-engine.js"
import type { ResolvedExtensions } from "./registry.js"

export interface ActorSpawnFailure {
  readonly extensionId: string
  readonly error: string
}

/**
 * Namespace separator embedded into engine-level persistence keys so
 * the storage round-trip can split `${extensionId}/${behaviorKey}`
 * back into its parts. `/` is not legal in extension ids (manifest id
 * uses dashed lowercase; behavior keys are author-controlled
 * identifiers — neither contains a forward slash) so a single split
 * on the first separator is unambiguous.
 */
export const PERSISTENCE_KEY_SEPARATOR = "/"

/**
 * Build the namespaced persistence key the engine sees. Behaviors
 * declare flat `persistence.key`; the host overlays the extension id
 * so two extensions can innocently both name a behavior `counter`
 * without colliding on snapshot or restore.
 */
export const namespacePersistenceKey = (extensionId: string, behaviorKey: string): string =>
  `${extensionId}${PERSISTENCE_KEY_SEPARATOR}${behaviorKey}`

const withNamespacedPersistenceKey = <M, S>(
  behavior: Behavior<M, S, never>,
  extensionId: string,
): Behavior<M, S, never> => {
  if (behavior.persistence === undefined) return behavior
  return {
    ...behavior,
    persistence: {
      ...behavior.persistence,
      key: namespacePersistenceKey(extensionId, behavior.persistence.key),
    },
  }
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
        const namespaced = withNamespacedPersistenceKey(behavior, ext.manifest.id)
        yield* engine.spawn(namespaced).pipe(
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
