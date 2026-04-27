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
 * Spawn failures are logged and skipped (rather than failing the
 * whole layer). A failing actor is in the same category as a failing
 * extension contribution — the runtime should keep running with the
 * actors that did spawn cleanly. Persistence-key collisions and
 * decode errors land here as warnings annotated with the extension id.
 */

import { Cause, Effect, Layer } from "effect"
import { ActorEngine } from "./actor-engine.js"
import type { ResolvedExtensions } from "./registry.js"

/**
 * Spawn every contributed `Behavior` into the engine. Internal — used
 * only by `ActorHost.fromResolved`.
 */
const spawnContributedActors = (
  resolved: ResolvedExtensions,
): Effect.Effect<void, never, ActorEngine> =>
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    for (const ext of resolved.extensions) {
      const behaviors = ext.contributions.actors ?? []
      for (const behavior of behaviors) {
        yield* engine.spawn(behavior).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("actor-host.spawn.failed").pipe(
              Effect.annotateLogs({
                extensionId: ext.manifest.id,
                error: String(Cause.squash(cause)),
              }),
            ),
          ),
        )
      }
    }
  })

/**
 * Layer that spawns every extension's `actors` into the running
 * `ActorEngine`. Composed into the runtime layer alongside
 * `ActorEngine.Live`.
 */
export const ActorHost = {
  fromResolved: (resolved: ResolvedExtensions): Layer.Layer<never, never, ActorEngine> =>
    Layer.effectDiscard(spawnContributedActors(resolved)),
}
