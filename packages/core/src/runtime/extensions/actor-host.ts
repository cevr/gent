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

import { Cause, Context, Effect, Layer, Ref, Schedule } from "effect"
import type { Duration } from "effect"
import type { Behavior, JsonValueT } from "../../domain/actor.js"
import {
  ActorPersistenceStorage,
  type ActorPersistenceStorageService,
} from "../../storage/actor-persistence-storage.js"
import { ActorEngine } from "./actor-engine.js"
import type { ResolvedExtensions } from "./registry.js"

export interface ActorSpawnFailure {
  readonly extensionId: string
  readonly error: string
}

/**
 * Namespace separator embedded into engine-level persistence keys.
 * ASCII unit separator (U+001F) is a non-printable control character
 * that no real `ExtensionId` ever contains (the storage layer enforces
 * `/^@?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/` via
 * `extension-storage.validateExtensionId`) and that no behavior author
 * would put in a key, so the encoding is unambiguous: split on the
 * first occurrence yields `(extensionId, behaviorKey)` exactly. A
 * printable separator like `/` would alias scoped ids such as
 * `@gent/memory` against behavior keys that themselves contain a
 * slash, breaking the storage round-trip.
 */
export const PERSISTENCE_KEY_SEPARATOR = "\x1f"

/**
 * Build the namespaced persistence key the engine sees. Behaviors
 * declare flat `persistence.key`; the host overlays the extension id
 * so two extensions can innocently both name a behavior `counter`
 * without colliding on snapshot or restore.
 */
export const namespacePersistenceKey = (extensionId: string, behaviorKey: string): string =>
  `${extensionId}${PERSISTENCE_KEY_SEPARATOR}${behaviorKey}`

/**
 * Inverse of `namespacePersistenceKey`. Splits on the first `\x1f`,
 * which is unambiguous because the separator is illegal in both
 * `ExtensionId` and any reasonable author-chosen behavior key.
 * Returns `undefined` for malformed input so storage callers can
 * log + skip without an exception.
 */
export const parseNamespacedPersistenceKey = (
  namespaced: string,
): { readonly extensionId: string; readonly behaviorKey: string } | undefined => {
  const idx = namespaced.indexOf(PERSISTENCE_KEY_SEPARATOR)
  if (idx < 0) return undefined
  return {
    extensionId: namespaced.slice(0, idx),
    behaviorKey: namespaced.slice(idx + 1),
  }
}

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

/**
 * Persistence wire-up for the host. When present, the host:
 *  - consults `loadActorState(profileId, namespacedKey)` at spawn-time
 *    and threads the result into `engine.spawn(b, { restoredState })`
 *  - forks a periodic writer that calls `engine.snapshot()` and
 *    upserts each row through `saveActorState`
 *
 * Absent when the runtime has no SQLite backing (in-memory test
 * harnesses); in that mode actors are pure state with no durability.
 */
export interface ActorHostPersistence {
  readonly profileId: string
  /**
   * Period between background snapshot writes. Defaults to 30s in the
   * profile composer; tunable per-profile if the durability/IO trade
   * needs adjustment.
   */
  readonly writeInterval: Duration.Input
}

const recordSpawnFailure = (
  failuresRef: Ref.Ref<ReadonlyArray<ActorSpawnFailure>>,
  extensionId: string,
  cause: Cause.Cause<unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const error = String(Cause.squash(cause))
    yield* Ref.update(failuresRef, (xs) => [...xs, { extensionId, error }])
    yield* Effect.logWarning("actor-host.spawn.failed").pipe(
      Effect.annotateLogs({ extensionId, error }),
    )
  })

const spawnWithoutPersistence = (
  resolved: ResolvedExtensions,
  failuresRef: Ref.Ref<ReadonlyArray<ActorSpawnFailure>>,
): Effect.Effect<void, never, ActorEngine> =>
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    for (const ext of resolved.extensions) {
      const behaviors = ext.contributions.actors ?? []
      for (const behavior of behaviors) {
        const namespaced = withNamespacedPersistenceKey(behavior, ext.manifest.id)
        yield* engine
          .spawn(namespaced)
          .pipe(
            Effect.catchCause((cause) => recordSpawnFailure(failuresRef, ext.manifest.id, cause)),
          )
      }
    }
  })

/**
 * Hydrate one durable behavior's restoredState from
 * `ActorPersistenceStorage`. Returns `undefined` for ephemeral
 * behaviors, missing rows, malformed JSON, and storage errors —
 * a misencoded snapshot must not block the actor from starting at
 * all; the actor falls back to `initialState`.
 */
const loadRestoredState = (
  storage: ActorPersistenceStorageService,
  profileId: string,
  extensionId: string,
  namespaced: Behavior<unknown, unknown, never>,
): Effect.Effect<JsonValueT | undefined> => {
  if (namespaced.persistence === undefined) return Effect.succeed(undefined)
  const key = namespaced.persistence.key
  return storage.loadActorState({ profileId, persistenceKey: key }).pipe(
    Effect.flatMap((row) => {
      if (row === undefined) return Effect.succeed<JsonValueT | undefined>(undefined)
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stateJson is the encoded form of behavior.persistence.state; engine decodes via Schema before use, so any decode mismatch surfaces as ActorRestoreError there
        return Effect.succeed(JSON.parse(row.stateJson) as JsonValueT)
      } catch (e) {
        return Effect.logWarning("actor-host.restore.parse-failed").pipe(
          Effect.annotateLogs({ extensionId, persistenceKey: key, error: String(e) }),
          Effect.as<JsonValueT | undefined>(undefined),
        )
      }
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("actor-host.restore.load-failed").pipe(
        Effect.annotateLogs({
          extensionId,
          persistenceKey: key,
          error: String(Cause.squash(cause)),
        }),
        Effect.as<JsonValueT | undefined>(undefined),
      ),
    ),
  )
}

const spawnWithPersistence = (
  resolved: ResolvedExtensions,
  failuresRef: Ref.Ref<ReadonlyArray<ActorSpawnFailure>>,
  persistence: ActorHostPersistence,
): Effect.Effect<void, never, ActorEngine | ActorPersistenceStorage> =>
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    const storage = yield* ActorPersistenceStorage
    for (const ext of resolved.extensions) {
      const behaviors = ext.contributions.actors ?? []
      for (const behavior of behaviors) {
        const namespaced = withNamespacedPersistenceKey(behavior, ext.manifest.id)
        const restoredState = yield* loadRestoredState(
          storage,
          persistence.profileId,
          ext.manifest.id,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- erase Behavior generics for the load helper; persistence schema pin is on the engine side
          namespaced as Behavior<unknown, unknown, never>,
        )
        yield* engine
          .spawn(namespaced, restoredState !== undefined ? { restoredState } : undefined)
          .pipe(
            Effect.catchCause((cause) => recordSpawnFailure(failuresRef, ext.manifest.id, cause)),
          )
      }
    }
  })

/**
 * Periodic durable-snapshot loop. Walks every live durable actor via
 * `engine.snapshot()` and upserts each row through
 * `ActorPersistenceStorage.saveActorState`. Runs as a forked fiber on
 * the host scope so teardown stops the writer cleanly.
 *
 * Failures are logged + skipped (per row, not per cycle) — a single
 * encode/IO failure must not stall the rest. The semaphore in
 * `actor-engine.snapshotForActor` guarantees each row is the post-state
 * of a completed `receive`, so we never persist a torn intermediate.
 */
const runPeriodicWriter = (
  persistence: ActorHostPersistence,
): Effect.Effect<void, never, ActorEngine | ActorPersistenceStorage> =>
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    const storage = yield* ActorPersistenceStorage
    const writeOnce = Effect.gen(function* () {
      const snap = yield* engine
        .snapshot()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("actor-host.snapshot.failed").pipe(
              Effect.annotateLogs({ error: String(Cause.squash(cause)) }),
              Effect.as(new Map<string, unknown>()),
            ),
          ),
        )
      for (const [persistenceKey, state] of snap) {
        yield* storage
          .saveActorState({
            profileId: persistence.profileId,
            persistenceKey,
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- snapshot rows are already-encoded JsonValueT from the engine; storage needs the textual form
            stateJson: JSON.stringify(state),
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("actor-host.persist.write-failed").pipe(
                Effect.annotateLogs({
                  persistenceKey,
                  error: String(Cause.squash(cause)),
                }),
              ),
            ),
          )
      }
    })
    yield* writeOnce.pipe(Effect.repeat(Schedule.spaced(persistence.writeInterval)))
  })

/**
 * Layer that spawns every extension's `actors` into the running
 * `ActorEngine` and exposes the resulting failure list as
 * `ActorHostFailures`. Composed into the runtime layer alongside
 * `ActorEngine.Live`.
 *
 * `fromResolved(resolved)` — pure in-memory mode (no durability).
 * `fromResolvedWithPersistence(resolved, persistence)` — wires
 * `ActorPersistenceStorage`: spawn-time hydrate from
 * `(profileId, namespacedKey)` rows + forked periodic writer.
 */
export const ActorHost = {
  fromResolved: (
    resolved: ResolvedExtensions,
  ): Layer.Layer<ActorHostFailures, never, ActorEngine> =>
    Layer.effect(
      ActorHostFailures,
      Effect.gen(function* () {
        const failuresRef = yield* Ref.make<ReadonlyArray<ActorSpawnFailure>>([])
        yield* spawnWithoutPersistence(resolved, failuresRef)
        return { snapshot: Ref.get(failuresRef) }
      }),
    ),
  fromResolvedWithPersistence: (
    resolved: ResolvedExtensions,
    persistence: ActorHostPersistence,
  ): Layer.Layer<ActorHostFailures, never, ActorEngine | ActorPersistenceStorage> =>
    Layer.effect(
      ActorHostFailures,
      Effect.gen(function* () {
        const failuresRef = yield* Ref.make<ReadonlyArray<ActorSpawnFailure>>([])
        yield* spawnWithPersistence(resolved, failuresRef, persistence)
        // Periodic snapshot writer runs for the lifetime of the host
        // scope. `forkScoped` ties it to layer teardown so profile
        // close stops the writer cleanly.
        yield* Effect.forkScoped(runPeriodicWriter(persistence))
        return { snapshot: Ref.get(failuresRef) }
      }),
    ),
}
