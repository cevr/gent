/**
 * SessionCwdRegistry — fast `sessionId → cwd` lookup for the per-cwd
 * EventPublisher router.
 *
 * The router needs to know which `SessionProfile` (= which cwd) an event
 * belongs to so it can dispatch through THAT profile's `ActorRouter` and
 * pulseTags index, not the server's primary cwd. This service caches
 * `(sessionId → cwd)` writes from session-creation paths and falls back to
 * `Storage.getSession` for cold-cache lookups (recovery / out-of-band publish).
 *
 * Writes are eager at the two business-meaningful spots:
 *   1. `SessionCommands.createSession` — top-level user session creation.
 *   2. `agent-runner.childRun` — ephemeral subagent session creation.
 *
 * Reads are sync from the in-memory map; on miss the registry hits storage
 * once and memoizes. On `None` from storage (genuinely missing row) the
 * caller decides the fallback (the router uses the server's primary cwd).
 */

import { Context, Effect, Layer, Ref } from "effect"
import type { SessionId } from "../domain/ids.js"
import { Storage, type StorageService, type StorageError } from "../storage/sqlite-storage.js"

export interface SessionCwdRegistryService {
  /** Record the cwd for a sessionId (idempotent — last writer wins). */
  readonly record: (sessionId: SessionId, cwd: string) => Effect.Effect<void>
  /**
   * Resolve the cwd for a sessionId. Synchronous when the cache is warm;
   * falls back to a single storage read on miss and memoizes the result.
   * Returns `undefined` if the storage row does not exist.
   * Propagates `StorageError` on transient failures (fail-closed).
   */
  readonly lookup: (sessionId: SessionId) => Effect.Effect<string | undefined, StorageError>
  /** Drop the cached entry for a sessionId (paired with session deletion). */
  readonly forget: (sessionId: SessionId) => Effect.Effect<void>
}

export class SessionCwdRegistry extends Context.Service<
  SessionCwdRegistry,
  SessionCwdRegistryService
>()("@gent/core/src/runtime/session-cwd-registry/SessionCwdRegistry") {
  static Live: Layer.Layer<SessionCwdRegistry, never, Storage> = Layer.effect(
    SessionCwdRegistry,
    Effect.gen(function* () {
      const storage = yield* Storage
      const cacheRef = yield* Ref.make<Map<SessionId, string>>(new Map())
      return makeRegistry(cacheRef, storage)
    }),
  )

  /** Pure in-memory variant for tests (no storage fallback). */
  static Test = (initial?: ReadonlyMap<SessionId, string>): Layer.Layer<SessionCwdRegistry> =>
    Layer.effect(
      SessionCwdRegistry,
      Effect.gen(function* () {
        const cacheRef = yield* Ref.make<Map<SessionId, string>>(new Map(initial ?? []))
        return {
          record: (sessionId, cwd) =>
            Ref.update(cacheRef, (m) => {
              const next = new Map(m)
              next.set(sessionId, cwd)
              return next
            }),
          lookup: (sessionId) => Ref.get(cacheRef).pipe(Effect.map((m) => m.get(sessionId))),
          forget: (sessionId) =>
            Ref.update(cacheRef, (m) => {
              const next = new Map(m)
              next.delete(sessionId)
              return next
            }),
        }
      }),
    )
}

const makeRegistry = (
  cacheRef: Ref.Ref<Map<SessionId, string>>,
  storage: StorageService,
): SessionCwdRegistryService => {
  const record: SessionCwdRegistryService["record"] = (sessionId, cwd) =>
    Ref.update(cacheRef, (m) => {
      const next = new Map(m)
      next.set(sessionId, cwd)
      return next
    })

  const lookup: SessionCwdRegistryService["lookup"] = (sessionId) =>
    Effect.gen(function* () {
      const cache = yield* Ref.get(cacheRef)
      const cached = cache.get(sessionId)
      if (cached !== undefined) return cached
      // Cold cache — single storage read, memoize on hit. Storage errors
      // propagate (fail-closed): the caller must distinguish "not found"
      // from "storage failed" to avoid wrong-runtime delivery.
      const session = yield* storage.getSession(sessionId)
      if (session === undefined || session === null) return undefined
      const cwd = session.cwd
      if (cwd === undefined || cwd === null) return undefined
      yield* Ref.update(cacheRef, (m) => {
        const next = new Map(m)
        next.set(sessionId, cwd)
        return next
      })
      return cwd
    })

  const forget: SessionCwdRegistryService["forget"] = (sessionId) =>
    Ref.update(cacheRef, (m) => {
      const next = new Map(m)
      next.delete(sessionId)
      return next
    })

  return { record, lookup, forget }
}
