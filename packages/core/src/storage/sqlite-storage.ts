import type { PlatformError } from "effect"
import { Context, Effect, Layer, Schema, FileSystem, Path } from "effect"
import type { Message, Session, Branch } from "../domain/message.js"
import type { AgentEvent, EventEnvelope } from "../domain/event.js"
import type { SessionId, BranchId, MessageId } from "../domain/ids.js"
import type { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { CheckpointStorage } from "./checkpoint-storage.js"
import { InteractionStorage } from "./interaction-storage.js"
import { InteractionPendingReader } from "./interaction-pending-reader.js"
import { SearchStorage } from "./search-storage.js"
import { SessionStorage } from "./session-storage.js"
import { BranchStorage } from "./branch-storage.js"
import { MessageStorage } from "./message-storage.js"
import { EventStorage } from "./event-storage.js"
import { RelationshipStorage } from "./relationship-storage.js"
import { ActorPersistenceStorage } from "./actor-persistence-storage.js"
import { StorageError } from "../domain/storage-error.js"
export { StorageError }

import { initSchema, configureSqliteConnection } from "./schema.js"
import { makeStorageImpl } from "./sqlite/impl.js"
// Storage Service Interface

export interface StorageService {
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageError, R>

  // Sessions
  readonly createSession: (session: Session) => Effect.Effect<Session, StorageError>
  readonly getSession: (id: SessionId) => Effect.Effect<Session | undefined, StorageError>
  readonly getLastSessionByCwd: (cwd: string) => Effect.Effect<Session | undefined, StorageError>
  readonly listSessions: () => Effect.Effect<ReadonlyArray<Session>, StorageError>
  readonly listFirstBranches: () => Effect.Effect<
    ReadonlyArray<{ sessionId: SessionId; branchId: BranchId | undefined }>,
    StorageError
  >
  readonly updateSession: (session: Session) => Effect.Effect<Session, StorageError>
  /**
   * Deletes the session and every descendant. SELECT + DELETE execute inside
   * the same transaction so a child created mid-delete is either picked up
   * (commits before the tx) or rejected by the missing-parent FK (commits
   * after). Returns the full set of session ids the cascade actually removed
   * so in-memory cleanup uses the same snapshot.
   */
  readonly deleteSession: (id: SessionId) => Effect.Effect<ReadonlyArray<SessionId>, StorageError>

  // Branches
  readonly createBranch: (branch: Branch) => Effect.Effect<Branch, StorageError>
  readonly getBranch: (id: BranchId) => Effect.Effect<Branch | undefined, StorageError>
  readonly listBranches: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Branch>, StorageError>
  readonly deleteBranch: (id: BranchId) => Effect.Effect<void, StorageError>
  readonly updateBranchSummary: (
    branchId: BranchId,
    summary: string,
  ) => Effect.Effect<void, StorageError>
  readonly countMessages: (branchId: BranchId) => Effect.Effect<number, StorageError>
  readonly countMessagesByBranches: (
    branchIds: readonly BranchId[],
  ) => Effect.Effect<ReadonlyMap<BranchId, number>, StorageError>

  // Messages
  readonly createMessage: (message: Message) => Effect.Effect<Message, StorageError>
  readonly createMessageIfAbsent: (message: Message) => Effect.Effect<Message, StorageError>
  readonly getMessage: (id: MessageId) => Effect.Effect<Message | undefined, StorageError>
  readonly listMessages: (branchId: BranchId) => Effect.Effect<ReadonlyArray<Message>, StorageError>
  readonly deleteMessages: (
    branchId: BranchId,
    afterMessageId?: MessageId,
  ) => Effect.Effect<void, StorageError>
  readonly updateMessageTurnDuration: (
    messageId: MessageId,
    durationMs: number,
  ) => Effect.Effect<void, StorageError>

  // Events
  readonly appendEvent: (
    event: AgentEvent,
    options?: { traceId?: string },
  ) => Effect.Effect<EventEnvelope, StorageError>
  readonly listEvents: (params: {
    sessionId: SessionId
    branchId?: BranchId
    afterId?: number
  }) => Effect.Effect<ReadonlyArray<EventEnvelope>, StorageError>
  readonly getLatestEventId: (params: {
    sessionId: SessionId
    branchId?: BranchId
  }) => Effect.Effect<number | undefined, StorageError>
  readonly getLatestEventTag: (params: {
    sessionId: SessionId
    branchId: BranchId
    tags: ReadonlyArray<string>
  }) => Effect.Effect<string | undefined, StorageError>
  readonly getLatestEvent: (params: {
    sessionId: SessionId
    branchId: BranchId
    tags: ReadonlyArray<string>
  }) => Effect.Effect<AgentEvent | undefined, StorageError>

  // Session tree
  readonly getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  readonly getSessionAncestors: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  /** Returns branches + messages within a single session (not cross-session tree) */
  readonly getSessionDetail: (sessionId: SessionId) => Effect.Effect<
    {
      session: Session
      branches: ReadonlyArray<{
        branch: Branch
        messages: ReadonlyArray<Message>
      }>
    },
    StorageError
  >

  // Actor persistence (profile-scoped, key-namespaced).
  readonly saveActorState: (params: {
    profileId: string
    persistenceKey: string
    stateJson: string
  }) => Effect.Effect<void, StorageError>
  readonly loadActorState: (params: {
    profileId: string
    persistenceKey: string
  }) => Effect.Effect<{ stateJson: string; updatedAt: number } | undefined, StorageError>
  readonly listActorStatesForProfile: (profileId: string) => Effect.Effect<
    ReadonlyArray<{
      profileId: string
      persistenceKey: string
      stateJson: string
      updatedAt: number
    }>,
    StorageError
  >
  readonly deleteActorStatesForProfile: (profileId: string) => Effect.Effect<void, StorageError>
}

const mapStartupError = (error: unknown): StorageError =>
  Schema.is(StorageError)(error)
    ? error
    : new StorageError({ message: "Failed to initialize SQLite storage", cause: error })

const makeStorage = Effect.gen(function* () {
  yield* configureSqliteConnection().pipe(Effect.mapError(mapStartupError))
  yield* initSchema.pipe(Effect.mapError(mapStartupError))
  return yield* makeStorageImpl
})

const memorySqliteClientLayer: Layer.Layer<SqliteClient.SqliteClient | SqlClient.SqlClient, never> =
  Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))

/**
 * Build focused sub-Tag layers from a layer that provides Storage.
 * Called at composition roots (dependencies.ts, test layers) to wire
 * sub-Tags alongside the existing Storage Tag. NOT wired inside Storage
 * class methods to prevent ephemeral compositor leakage.
 */
/** Build focused sub-Tag layers from a StorageService value (no extra scope). */
const subTagLayersFromService = (
  s: StorageService,
): Layer.Layer<
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | ActorPersistenceStorage
> =>
  Layer.mergeAll(
    SessionStorage.fromStorage(s),
    BranchStorage.fromStorage(s),
    MessageStorage.fromStorage(s),
    EventStorage.fromStorage(s),
    RelationshipStorage.fromStorage(s),
    ActorPersistenceStorage.fromStorage(s),
  )

/**
 * Build focused sub-Tag layers from a layer that provides Storage.
 * Called at composition roots (dependencies.ts, test layers) to wire
 * sub-Tags alongside the existing Storage Tag.
 */
export const subTagLayers = <E, R>(
  base: Layer.Layer<Storage, E, R>,
): Layer.Layer<
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | ActorPersistenceStorage,
  E,
  R
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const s = yield* Storage
      return subTagLayersFromService(s)
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off — layer composition helper, not a runtime call
      Effect.provide(base),
    ),
  )

/**
 * Layer that derives sub-Tags from Storage already in context.
 * Use with `Layer.provideMerge` when Storage is already provided — this
 * avoids double-instantiating the base layer (no `base` argument needed).
 */
const subTagsFromContext: Layer.Layer<
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | ActorPersistenceStorage,
  never,
  Storage
> = Layer.unwrap(
  Effect.gen(function* () {
    const s = yield* Storage
    return subTagLayersFromService(s)
  }),
)

export class Storage extends Context.Service<Storage, StorageService>()(
  "@gent/core/src/storage/sqlite-storage/Storage",
) {
  static Live = (
    dbPath: string,
  ): Layer.Layer<
    Storage,
    StorageError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > =>
    Layer.effect(
      Storage,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.dirname(dbPath)
        yield* fs.makeDirectory(dir, { recursive: true })
        return yield* makeStorage
      }),
    ).pipe(Layer.provide(Layer.orDie(SqliteClient.layer({ filename: dbPath }))))
  // Load-bearing: `deleteSession`'s atomic SELECT+DELETE relies on @effect/sql-sqlite-bun's
  // single-connection + Semaphore(1) serialization. If this layer is ever swapped for a
  // pooled/multi-connection driver, the cascade tx must switch to BEGIN IMMEDIATE (or an
  // equivalent write-lock) to preserve the invariant that no child row is committed between
  // the recursive SELECT and the DELETE.

  /** Live layer that also exposes SqlClient and focused storage services */
  static LiveWithSql = (
    dbPath: string,
  ): Layer.Layer<
    | Storage
    | SqlClient.SqlClient
    | CheckpointStorage
    | InteractionStorage
    | SearchStorage
    | SessionStorage
    | BranchStorage
    | MessageStorage
    | EventStorage
    | RelationshipStorage
    | ActorPersistenceStorage,
    StorageError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > => {
    const base = Layer.effect(
      Storage,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.dirname(dbPath)
        yield* fs.makeDirectory(dir, { recursive: true })
        return yield* makeStorage
      }),
    ).pipe(Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename: dbPath }))))
    const interactionStorage = Layer.provide(InteractionStorage.Live, base)
    return Layer.mergeAll(
      base,
      Layer.provide(subTagsFromContext, base),
      Layer.provide(CheckpointStorage.Live, base),
      interactionStorage,
      Layer.provide(InteractionPendingReader.Live, interactionStorage),
      Layer.provide(SearchStorage.Live, base),
    )
  }

  static Memory = (): Layer.Layer<Storage, StorageError> =>
    Layer.effect(Storage, makeStorage).pipe(Layer.provide(memorySqliteClientLayer))

  /** Memory layer that also exposes SqlClient and focused storage services */
  static MemoryWithSql = (): Layer.Layer<
    | Storage
    | SqlClient.SqlClient
    | CheckpointStorage
    | InteractionStorage
    | SearchStorage
    | SessionStorage
    | BranchStorage
    | MessageStorage
    | EventStorage
    | RelationshipStorage
    | ActorPersistenceStorage,
    StorageError
  > => {
    const base = Layer.effect(Storage, makeStorage).pipe(
      Layer.provideMerge(memorySqliteClientLayer),
    )
    const interactionStorage = Layer.provide(InteractionStorage.Live, base)
    return Layer.mergeAll(
      base,
      Layer.provide(subTagsFromContext, base),
      Layer.provide(CheckpointStorage.Live, base),
      interactionStorage,
      Layer.provide(InteractionPendingReader.Live, interactionStorage),
      Layer.provide(SearchStorage.Live, base),
    )
  }

  static Test = (): Layer.Layer<Storage, StorageError> => Storage.Memory()

  /** Test layer that also exposes SqlClient and focused storage services */
  static TestWithSql = (): Layer.Layer<
    | Storage
    | SqlClient.SqlClient
    | CheckpointStorage
    | InteractionStorage
    | SearchStorage
    | SessionStorage
    | BranchStorage
    | MessageStorage
    | EventStorage
    | RelationshipStorage
    | ActorPersistenceStorage,
    StorageError
  > => Storage.MemoryWithSql()
}
