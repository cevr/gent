import type { PlatformError } from "effect"
import { Effect, Layer, FileSystem, Path } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunCrypto } from "@effect/platform-bun"
import type { MessageStorage as ClusterMessageStorage } from "effect/unstable/cluster"
import { fromSqlClient as encoreSqlMessageStorage } from "effect-encore"
import { InteractionStorage } from "./interaction-storage.js"
import { SearchStorage } from "./search-storage.js"
import { SessionStorage } from "./session-storage.js"
import { BranchStorage } from "./branch-storage.js"
import { MessageStorage } from "./message-storage.js"
import { AgentLoopQueueStorage } from "./agent-loop-queue-storage.js"
import { EventStorage } from "./event-storage.js"
import { RelationshipStorage } from "./relationship-storage.js"
import { SessionOperationStorage } from "./session-operation-storage.js"
import { ToolCallBindingStorage } from "./tool-call-binding-storage.js"
import { ResourceGraphStorage } from "./resource-graph-storage.js"
import { StorageError } from "../domain/storage-error.js"
import { GentPlatform } from "../runtime/gent-platform.js"
export { StorageError }

import { makeStorageInitLive, type FeatureMigrations } from "./schema.js"

export type StorageTransaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | StorageError, R>

// `makeStorageTransaction` yields `SqlClient` once at layer-build time and
// returns a closure that wraps each mutation in a transaction. Callers do not
// thread `SqlClient` as a parameter and do not surface it on per-method
// R-channels; the closure binds it through lexical scope (see project memory
// "No context params — yield directly"). The factory shape lets the Live
// layer construction yield sql at the top and produce a `storageTransaction`
// helper bound to that sql for the lifetime of the layer.
export const makeStorageTransaction: Effect.Effect<StorageTransaction, never, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | StorageError, R> =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.catchIf(SqlError.isSqlError, (error) =>
            Effect.fail(
              new StorageError({ message: "Failed to run storage transaction", cause: error }),
            ),
          ),
        )
  })

const memorySqliteClientLayer: Layer.Layer<SqliteClient.SqliteClient | SqlClient.SqlClient, never> =
  Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))

type FocusedStorage =
  | SqlClient.SqlClient
  | InteractionStorage
  | SearchStorage
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | AgentLoopQueueStorage
  | EventStorage
  | RelationshipStorage
  | SessionOperationStorage
  | ToolCallBindingStorage
  | ResourceGraphStorage
  | ClusterMessageStorage.MessageStorage

/**
 * Repositories an extension adds to the same database.
 *
 * Core assembles the kernel's tables. A feature that owns tables of its own
 * supplies them here, built over the same SQL client and the same interaction
 * storage, so core never has to name them.
 */
export type ExtraRepositories<A, E, R> = (
  base: Layer.Layer<SqlClient.SqlClient, E, R>,
  interactionStorage: Layer.Layer<InteractionStorage, E, R>,
) => Layer.Layer<A, E, R | GentPlatform>

const provideFocusedRepositories = <A, E, R>(
  base: Layer.Layer<SqlClient.SqlClient, E, R>,
  extra: ExtraRepositories<A, E, R>,
): Layer.Layer<FocusedStorage | A, E, R | GentPlatform> => {
  const interactionStorage = Layer.provide(InteractionStorage.Live, base)
  return Layer.mergeAll(
    extra(base, interactionStorage),
    base,
    Layer.provide(SessionStorage.Live, base),
    Layer.provide(BranchStorage.Live, base),
    Layer.provide(MessageStorage.Live, base),
    Layer.provide(AgentLoopQueueStorage.Live, base),
    Layer.provide(EventStorage.Live, base),
    Layer.provide(RelationshipStorage.Live, base),
    Layer.provide(SessionOperationStorage.Live, base),
    Layer.provide(ToolCallBindingStorage.Live, base),
    Layer.provide(ResourceGraphStorage.Live, base),
    Layer.provide(encoreSqlMessageStorage(), Layer.merge(base, BunCrypto.layer)),
    interactionStorage,
    Layer.provide(SearchStorage.Live, base),
  )
}

const ensureDbDirectory = (dbPath: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = path.dirname(dbPath)
      yield* fs.makeDirectory(dir, { recursive: true })
    }),
  )

const makeLiveSqliteLayer = (
  dbPath: string,
  featureMigrations: FeatureMigrations,
): Layer.Layer<
  SqlClient.SqlClient,
  StorageError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  makeStorageInitLive(featureMigrations).pipe(
    Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename: dbPath }))),
    Layer.provideMerge(ensureDbDirectory(dbPath)),
  )

const makeMemorySqliteLayer = (
  featureMigrations: FeatureMigrations,
): Layer.Layer<SqlClient.SqlClient, StorageError> =>
  makeStorageInitLive(featureMigrations).pipe(Layer.provideMerge(memorySqliteClientLayer))

export const SqliteStorage = {
  // Load-bearing: `deleteSession`'s atomic SELECT+DELETE relies on @effect/sql-sqlite-bun's
  // single-connection + Semaphore(1) serialization. If this layer is ever swapped for a
  // pooled/multi-connection driver, the cascade tx must switch to BEGIN IMMEDIATE (or an
  // equivalent write-lock) to preserve the invariant that no child row is committed between
  // the recursive SELECT and the DELETE.
  LiveWithSql: <A>(
    dbPath: string,
    extra: ExtraRepositories<
      A,
      StorageError | PlatformError.PlatformError,
      FileSystem.FileSystem | Path.Path
    >,
    featureMigrations: FeatureMigrations,
  ): Layer.Layer<
    FocusedStorage | A,
    StorageError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | GentPlatform
  > => provideFocusedRepositories(makeLiveSqliteLayer(dbPath, featureMigrations), extra),

  MemoryWithSql: <A>(
    extra: ExtraRepositories<A, StorageError, never>,
    featureMigrations: FeatureMigrations,
  ): Layer.Layer<FocusedStorage | A, StorageError, GentPlatform> =>
    provideFocusedRepositories(makeMemorySqliteLayer(featureMigrations), extra),

  // `TestWithSql` is the closed-context variant: it self-provides
  // `GentPlatform.Test()` so storage tests can yield it without wiring a
  // platform layer themselves. Production callers use `LiveWithSql` /
  // `MemoryWithSql` and supply the live `GentPlatform`.
  TestWithSql: <A>(
    extra: ExtraRepositories<A, StorageError, never>,
    featureMigrations: FeatureMigrations,
  ): Layer.Layer<FocusedStorage | A, StorageError> =>
    Layer.provide(
      provideFocusedRepositories(makeMemorySqliteLayer(featureMigrations), extra),
      GentPlatform.Test(),
    ),
}
