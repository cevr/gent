/**
 * ActorPersistenceStorage — profile-scoped durable state for actors.
 *
 * Why profile-scoped (not session-scoped): `ActorEngine.Live` is composed
 * into the per-cwd `RuntimeProfile` and lives longer than any single
 * session. Folding actor state into the per-session `agent_loop_checkpoints`
 * table forces wrong shapes (duplication-per-session, concurrent
 * multi-session writes to the same row). Actors live across sessions;
 * the storage surface must reflect that.
 *
 * Keys are the engine-level `${extensionId}/${behaviorKey}` form
 * (see `actor-host.PERSISTENCE_KEY_SEPARATOR`). The `profileId` slot
 * scopes the row to a single `RuntimeProfile` so multiple cwds on the
 * same DB do not collide.
 */

import type { Effect } from "effect"
import { Context, Layer } from "effect"
import type { StorageError } from "./sqlite-storage.js"

export interface ActorPersistenceRecord {
  readonly profileId: string
  readonly persistenceKey: string
  readonly stateJson: string
  readonly updatedAt: number
}

export interface ActorPersistenceStorageService {
  /**
   * Upsert encoded state for `(profileId, persistenceKey)`. Writes
   * `updatedAt` to the current clock; `stateJson` is the result of
   * `Schema.encodeUnknownEffect(behavior.persistence.state)` followed
   * by `JSON.stringify`.
   */
  readonly saveActorState: (params: {
    readonly profileId: string
    readonly persistenceKey: string
    readonly stateJson: string
  }) => Effect.Effect<void, StorageError>
  /**
   * Load encoded state for `(profileId, persistenceKey)`. Returns
   * `undefined` when no prior snapshot exists — caller falls back to
   * `behavior.initialState`.
   */
  readonly loadActorState: (params: {
    readonly profileId: string
    readonly persistenceKey: string
  }) => Effect.Effect<
    { readonly stateJson: string; readonly updatedAt: number } | undefined,
    StorageError
  >
  /**
   * Snapshot of every persisted actor row for a profile. Used at
   * profile startup to seed `restoredState` for each contributed
   * behavior whose `persistence.key` matches a known row.
   */
  readonly listActorStatesForProfile: (
    profileId: string,
  ) => Effect.Effect<ReadonlyArray<ActorPersistenceRecord>, StorageError>
  /**
   * Drop every actor row for a profile. Intended for test teardown
   * and operator-driven profile reset; not part of the normal
   * lifecycle.
   */
  readonly deleteActorStatesForProfile: (profileId: string) => Effect.Effect<void, StorageError>
}

export class ActorPersistenceStorage extends Context.Service<
  ActorPersistenceStorage,
  ActorPersistenceStorageService
>()("@gent/core/src/storage/actor-persistence-storage/ActorPersistenceStorage") {
  static fromStorage = (s: ActorPersistenceStorageService): Layer.Layer<ActorPersistenceStorage> =>
    Layer.succeed(ActorPersistenceStorage, s)
}
