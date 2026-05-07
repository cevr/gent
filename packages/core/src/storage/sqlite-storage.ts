import type { PlatformError } from "effect"
import { Effect, Layer, FileSystem, Path } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { MessageStorage as ClusterMessageStorage } from "effect/unstable/cluster"
import type { EncoreMessageStorage } from "effect-encore"
import { fromSqlClient as encoreSqlMessageStorage } from "effect-encore"
import { InteractionStorage } from "./interaction-storage.js"
import { InteractionPendingReader } from "./interaction-pending-reader.js"
import { SearchStorage } from "./search-storage.js"
import { SessionStorage } from "./session-storage.js"
import { BranchStorage } from "./branch-storage.js"
import { MessageStorage } from "./message-storage.js"
import { AgentLoopQueueStorage } from "./agent-loop-queue-storage.js"
import { EventStorage } from "./event-storage.js"
import { RelationshipStorage } from "./relationship-storage.js"
import { StorageTransaction } from "./storage-transaction.js"
import { StorageError } from "../domain/storage-error.js"
export { StorageError }

import { StorageInitLive } from "./schema.js"

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
  | StorageTransaction
  | InteractionPendingReader
  | ClusterMessageStorage.MessageStorage
  | EncoreMessageStorage

const provideFocusedRepositories = <E, R>(
  base: Layer.Layer<SqlClient.SqlClient, E, R>,
): Layer.Layer<FocusedStorage, E, R> => {
  const interactionStorage = Layer.provide(InteractionStorage.Live, base)
  return Layer.mergeAll(
    base,
    Layer.provide(SessionStorage.Live, base),
    Layer.provide(BranchStorage.Live, base),
    Layer.provide(MessageStorage.Live, base),
    Layer.provide(AgentLoopQueueStorage.Live, base),
    Layer.provide(EventStorage.Live, base),
    Layer.provide(RelationshipStorage.Live, base),
    Layer.provide(StorageTransaction.Live, base),
    Layer.provide(encoreSqlMessageStorage(), base),
    interactionStorage,
    Layer.provide(InteractionPendingReader.Live, interactionStorage),
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
): Layer.Layer<
  SqlClient.SqlClient,
  StorageError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  StorageInitLive.pipe(
    Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename: dbPath }))),
    Layer.provideMerge(ensureDbDirectory(dbPath)),
  )

const makeMemorySqliteLayer: Layer.Layer<SqlClient.SqlClient, StorageError> = StorageInitLive.pipe(
  Layer.provideMerge(memorySqliteClientLayer),
)

export const SqliteStorage = {
  // Load-bearing: `deleteSession`'s atomic SELECT+DELETE relies on @effect/sql-sqlite-bun's
  // single-connection + Semaphore(1) serialization. If this layer is ever swapped for a
  // pooled/multi-connection driver, the cascade tx must switch to BEGIN IMMEDIATE (or an
  // equivalent write-lock) to preserve the invariant that no child row is committed between
  // the recursive SELECT and the DELETE.
  LiveWithSql: (
    dbPath: string,
  ): Layer.Layer<
    FocusedStorage,
    StorageError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > => provideFocusedRepositories(makeLiveSqliteLayer(dbPath)),

  MemoryWithSql: (): Layer.Layer<FocusedStorage, StorageError> =>
    provideFocusedRepositories(makeMemorySqliteLayer),

  TestWithSql: (): Layer.Layer<FocusedStorage, StorageError> =>
    provideFocusedRepositories(makeMemorySqliteLayer),
}
