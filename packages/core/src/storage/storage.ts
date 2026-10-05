import {
  Array as Arr,
  Clock,
  Context,
  type Crypto,
  DateTime,
  Effect,
  SchemaGetter as Getter,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect"
import { SqlClient, SqlError } from "effect/sql"
import type * as Prompt from "effect/ai/Prompt"
import {
  BranchId,
  type InteractionRequestId,
  MessageId,
  type RequestId,
  SessionId,
  type ToolCallId,
  CurrentWorkspaceId,
  WorkspaceId,
} from "../domain/ids.js"
import {
  decodeToolBindingIdentity,
  encodeToolBindingIdentity,
  type ToolBindingIdentity,
  ToolCallBindingConflictError,
  type ToolCallBindingKey,
  ToolCallGateState,
  ToolCallVerdict,
  validateToolBindingIdentity,
} from "../domain/capability.js"
import { storageError, StorageError, storageErrorExcept } from "../domain/errors.js"
import {
  branchFromRow,
  type BranchRow,
  decodeEvent,
  decodeEventRow,
  decodeMessageChunkRow,
  decodeStoredMessage,
  decodeStoredPromptPart,
  encodeEvent,
  encodeStoredMessage,
  groupMessageChunkRows,
  StorageInitLive,
  MESSAGE_CHUNK_SELECT,
  type MessageChunkRow,
  SESSION_COLUMNS,
  BRANCH_COLUMNS,
  sessionFromRow,
  type SessionRow,
  storedReasoningLevel,
  toSqlNull,
} from "./schema.js"
import {
  type Branch,
  emptyLoopQueueState,
  LoopQueueState,
  type LoopQueueState as LoopQueueStateType,
  type Message,
  Session,
  SessionAdmission,
} from "../domain/message.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { toolImageDigests } from "../runtime/tool-image.js"
import {
  AgentEvent,
  EventEnvelope,
  EventId,
  getEventBranchId,
  getEventSessionId,
} from "../domain/event.js"
import {
  InteractionRequestRecord,
  InteractionRequestStatus,
  type StoredInteractionDecision,
} from "../domain/interaction.js"
import type { MessageStorage as ClusterMessageStorage } from "effect/cluster"
import { fromSqlClient as encoreSqlMessageStorage } from "effect-encore"

const encodeSessionAdmission = Schema.encodeEffect(Schema.fromJsonString(SessionAdmission))
// ── bound lists ─────────────────────────────────────────────────────────────

const encodeListJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Finite]))),
)

/**
 * The `IN` operand for a list of any length, bound as one JSON parameter:
 * `WHERE id IN ${sqlInList(sql, ids)}`. `sql.in` binds one parameter per
 * item, and a hosted SQLite (a Durable Object) refuses a statement with more
 * than 100; a session tree, a branch list or a job list has no such bound.
 */
export const sqlInList = (sql: SqlClient.SqlClient, values: ReadonlyArray<string | number>) =>
  sql`(SELECT value FROM json_each(${encodeListJson(values)}))`

// ── owned tool call ─────────────────────────────────────────────────────────

export interface OwnedToolCallAddress extends ToolCallBindingKey {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

const MessageCallRow = Schema.Struct({ part_json: Schema.NullOr(Schema.String) })

/** One ownership check for binding records and cell execution claims. */
export const makeOwnedToolCallReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return Effect.fn("Storage.loadOwnedToolCall")(function* (params: OwnedToolCallAddress) {
    return yield* Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      const rows = yield* sql<typeof MessageCallRow.Type>`
        SELECT c.part_json
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        LEFT JOIN message_chunks mc ON mc.message_id = m.id
        LEFT JOIN content_chunks c ON c.id = mc.chunk_id
        WHERE m.id = ${params.assistantMessageId}
          AND m.session_id = ${params.sessionId}
          AND m.branch_id = ${params.branchId}
          AND m.role = 'assistant'
          AND s.workspace_id = ${workspaceId}
        ORDER BY mc.ordinal ASC
      `
      const calls: Prompt.ToolCallPart[] = []
      for (const rawRow of rows) {
        const row = yield* Schema.decodeEffect(MessageCallRow)(rawRow)
        const json = Option.fromNullishOr(row.part_json)
        if (Option.isNone(json)) continue
        const part = yield* decodeStoredPromptPart(json.value)
        if (part.type === "tool-call" && part.id === params.toolCallId) calls.push(part)
      }
      if (calls.length !== 1) return Option.none<Prompt.ToolCallPart>()
      return Option.fromUndefinedOr(calls[0])
    }).pipe(
      Effect.mapError(
        (cause) => new StorageError({ message: "Failed to read owned tool call", cause }),
      ),
    )
  })
})

// ── session-storage ─────────────────────────────────────────────────────────

/**
 * SessionStorage — focused service for session CRUD.
 *
 * Consumers yield only the narrow Tag they need; `SqliteStorage` provides
 * all focused storage Tags from one SQLite client.
 */

export interface SessionStorageService {
  readonly createSession: (session: Session) => Effect.Effect<Session, StorageError>
  // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
  readonly getSession: (id: SessionId) => Effect.Effect<Session | undefined, StorageError>
  readonly listSessions: Effect.Effect<ReadonlyArray<Session>, StorageError>
  /**
   * Each write sets only the columns it names, so two writers that touch
   * different fields of one session (a rename and a `/model` switch) never
   * restore each other's old value.
   */
  readonly renameSession: (
    id: SessionId,
    name: string,
    updatedAt: Date,
  ) => Effect.Effect<void, StorageError>
  readonly updateSessionSettings: (
    id: SessionId,
    settings: Pick<Session, "modelId" | "reasoningLevel" | "reasoningAuto">,
    updatedAt: Date,
  ) => Effect.Effect<void, StorageError>
  readonly setActiveBranch: (
    id: SessionId,
    branchId: BranchId,
    updatedAt: Date,
  ) => Effect.Effect<void, StorageError>
  /**
   * The sessions a delete of `id` removes: the session, everything it
   * spawned, and a spawn's own handoffs. In a root thread (its first session
   * has no parent, or is gone), a handoff that continues the deleted session
   * is the conversation the user kept working in: it stays. In a spawned
   * thread it goes with the session it continues, as side work its parent
   * started; kept, it would lose its parent and so the bound of its parent
   * run. Empty when the session does not exist. `deleteSession` removes this
   * set.
   */
  readonly deletionSet: (id: SessionId) => Effect.Effect<ReadonlyArray<SessionId>, StorageError>
  /**
   * Deletes the session and every descendant, returning each session the
   * cascade actually removed with the branches it had. Callers use the
   * returned set (not a pre-read tree snapshot) to clean in-memory runtime
   * state, so a child created between pre-collect and the durable tx is still
   * cleaned.
   */
  readonly deleteSession: (
    id: SessionId,
  ) => Effect.Effect<ReadonlyArray<DeletedSession>, StorageError>
}

/**
 * Whether `branchId` is a branch of `sessionId` in the current workspace: the
 * check a write makes before it names a branch.
 */
const branchInSession = Effect.fn("Storage.branchInSession")(function* (
  sql: SqlClient.SqlClient,
  branchId: BranchId,
  sessionId: SessionId,
) {
  const workspaceId = yield* CurrentWorkspaceId
  const rows = yield* sql<{ id: BranchId }>`SELECT b.id
    FROM branches b
    JOIN sessions s ON s.id = b.session_id
    WHERE b.id = ${branchId}
      AND b.session_id = ${sessionId}
      AND s.workspace_id = ${workspaceId}`
  return rows.length > 0
})

/** A session a delete removed, with the branches it had. */
interface DeletedSession {
  readonly sessionId: SessionId
  readonly branchIds: ReadonlyArray<BranchId>
}

export class SessionStorage extends Context.Service<SessionStorage, SessionStorageService>()(
  "@gent/core/src/storage/storage/SessionStorage",
) {
  static Live: Layer.Layer<SessionStorage, never, SqlClient.SqlClient> = Layer.effect(
    SessionStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      /** The one delete-set rule; see `SessionStorageService.deletionSet`. */
      const deletionSetOf = (id: SessionId) =>
        Effect.gen(function* () {
          const workspaceId = yield* CurrentWorkspaceId
          const rows = yield* sql<{ id: SessionId }>`
            WITH RECURSIVE
              target(id, thread_id, spawned) AS (
                SELECT s.id, s.thread_id, EXISTS (
                  SELECT 1 FROM sessions start
                  WHERE start.id = s.thread_id AND start.workspace_id = ${workspaceId}
                    AND start.parent_session_id IS NOT NULL
                )
                FROM sessions s WHERE s.id = ${id} AND s.workspace_id = ${workspaceId}
              ),
              descendants(id) AS (
                SELECT id FROM target
                UNION
                SELECT sessions.id
                FROM sessions
                JOIN descendants ON sessions.parent_session_id = descendants.id
                WHERE sessions.workspace_id = ${workspaceId}
                  AND (
                    sessions.thread_id IS NOT (SELECT thread_id FROM target)
                    OR (SELECT spawned FROM target)
                  )
              )
            SELECT id FROM descendants
          `
          return rows.map((row) => row.id)
        })

      return {
        createSession: Effect.fn("SessionStorage.createSession")(
          function* (session) {
            const workspaceId = yield* CurrentWorkspaceId
            if (
              !Predicate.isUndefined(session.parentBranchId) &&
              Predicate.isUndefined(session.parentSessionId)
            ) {
              return yield* new StorageError({
                message: "Cannot create session with parentBranchId without parentSessionId",
              })
            }
            if (
              !Predicate.isUndefined(session.parentBranchId) &&
              !Predicate.isUndefined(session.parentSessionId)
            ) {
              if (!(yield* branchInSession(sql, session.parentBranchId, session.parentSessionId))) {
                return yield* new StorageError({
                  message: `Parent branch not found in parent session: ${session.parentBranchId}`,
                })
              }
            }
            // A session with no thread of its own starts one. Only a create
            // with `continueThread` (the TUI `/handoff`) passes the parent's
            // thread; a spawn stays out of it by saying nothing.
            const stored = Option.match(Option.fromUndefinedOr(session.threadId), {
              onNone: () => new Session({ ...session, threadId: session.id }),
              onSome: () => session,
            })
            yield* sql`INSERT INTO sessions ${sql.insert({
              id: session.id,
              workspace_id: workspaceId,
              name: toSqlNull(session.name),
              cwd: toSqlNull(session.cwd),
              model_id: toSqlNull(session.modelId),
              reasoning_level: toSqlNull(Option.getOrUndefined(storedReasoningLevel(session))),
              active_branch_id: toSqlNull(session.activeBranchId),
              parent_session_id: toSqlNull(session.parentSessionId),
              parent_branch_id: toSqlNull(session.parentBranchId),
              thread_id: stored.threadId,
              admission_json: toSqlNull(
                Option.getOrUndefined(
                  yield* Option.match(Option.fromUndefinedOr(session.admission), {
                    onNone: () => Effect.succeedNone,
                    onSome: (admission) => Effect.asSome(encodeSessionAdmission(admission)),
                  }),
                ),
              ),
              created_at: session.createdAt.getTime(),
              updated_at: session.updatedAt.getTime(),
            })}`
            return stored
          },
          Effect.mapError(storageError("Failed to create session")),
        ),

        getSession: Effect.fn("SessionStorage.getSession")(
          function* (id) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`SELECT ${sql.literal(SESSION_COLUMNS)} FROM sessions WHERE id = ${id} AND workspace_id = ${workspaceId}`
            const row = rows[0]
            // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
            if (Predicate.isUndefined(row)) return undefined
            return yield* sessionFromRow(row)
          },
          Effect.mapError(storageError("Failed to get session")),
        ),

        listSessions: Effect.suspend(
          Effect.fn("SessionStorage.listSessions")(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`SELECT ${sql.literal(SESSION_COLUMNS)} FROM sessions WHERE workspace_id = ${workspaceId} ORDER BY updated_at DESC`
            return yield* Effect.forEach(rows, sessionFromRow)
          }),
        ).pipe(Effect.mapError(storageError("Failed to list sessions"))),

        renameSession: Effect.fn("SessionStorage.renameSession")(
          function* (id, name, updatedAt) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql`UPDATE sessions SET name = ${name}, updated_at = ${updatedAt.getTime()} WHERE id = ${id} AND workspace_id = ${workspaceId}`
          },
          Effect.mapError(storageError("Failed to rename session")),
        ),

        updateSessionSettings: Effect.fn("SessionStorage.updateSessionSettings")(
          function* (id, settings, updatedAt) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql`UPDATE sessions SET model_id = ${toSqlNull(settings.modelId)}, reasoning_level = ${toSqlNull(Option.getOrUndefined(storedReasoningLevel(settings)))}, updated_at = ${updatedAt.getTime()} WHERE id = ${id} AND workspace_id = ${workspaceId}`
          },
          Effect.mapError(storageError("Failed to update session settings")),
        ),

        setActiveBranch: Effect.fn("SessionStorage.setActiveBranch")(
          function* (id, branchId, updatedAt) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql`UPDATE sessions SET active_branch_id = ${branchId}, updated_at = ${updatedAt.getTime()} WHERE id = ${id} AND workspace_id = ${workspaceId}`
          },
          Effect.mapError(storageError("Failed to set active branch")),
        ),

        deletionSet: Effect.fn("SessionStorage.deletionSet")(
          function* (id) {
            return yield* deletionSetOf(id)
          },
          Effect.mapError(storageError("Failed to read the sessions a delete removes")),
        ),

        deleteSession: Effect.fn("SessionStorage.deleteSession")(
          function* (id) {
            return yield* Effect.gen(function* () {
              // A root thread's handoff that stays is detached from the parent it no longer has.
              const cascadedIds = yield* deletionSetOf(id)
              if (cascadedIds.length === 0) return []
              const cascaded = sqlInList(sql, cascadedIds)
              const branchRows = yield* sql<{ id: BranchId; session_id: SessionId }>`
                SELECT id, session_id FROM branches WHERE session_id IN ${cascaded}`
              yield* sql`UPDATE sessions SET parent_session_id = NULL, parent_branch_id = NULL
                WHERE parent_session_id IN ${cascaded} AND id NOT IN ${cascaded}`
              // Queues, branches, messages and their chunk links cascade by foreign key.
              yield* sql`DELETE FROM sessions WHERE id IN ${cascaded}`
              yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
              return cascadedIds.map((sessionId): DeletedSession => ({
                sessionId,
                branchIds: branchRows
                  .filter((row) => row.session_id === sessionId)
                  .map((row) => row.id),
              }))
            }).pipe(sql.withTransaction)
          },
          Effect.mapError(storageError("Failed to delete session")),
        ),
      } satisfies SessionStorageService
    }),
  )
}

// ── branch-storage ──────────────────────────────────────────────────────────

/**
 * BranchStorage — focused service for branch CRUD + message counting.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

export interface BranchStorageService {
  readonly createBranch: (branch: Branch) => Effect.Effect<Branch, StorageError>
  // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
  readonly getBranch: (id: BranchId) => Effect.Effect<Branch | undefined, StorageError>
  readonly listBranches: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Branch>, StorageError>
  readonly countMessagesByBranches: (
    branchIds: readonly BranchId[],
  ) => Effect.Effect<ReadonlyMap<BranchId, number>, StorageError>
}

export class BranchStorage extends Context.Service<BranchStorage, BranchStorageService>()(
  "@gent/core/src/storage/storage/BranchStorage",
) {
  static Live: Layer.Layer<BranchStorage, never, SqlClient.SqlClient> = Layer.effect(
    BranchStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return {
        createBranch: Effect.fn("BranchStorage.createBranch")(
          function* (branch) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionRows = yield* sql<{ id: SessionId }>`
              SELECT id FROM sessions
              WHERE id = ${branch.sessionId} AND workspace_id = ${workspaceId}
            `
            if (sessionRows.length === 0) {
              return yield* new StorageError({
                message: `Session not found in current workspace: ${branch.sessionId}`,
              })
            }
            if (!Predicate.isUndefined(branch.parentBranchId)) {
              if (!(yield* branchInSession(sql, branch.parentBranchId, branch.sessionId))) {
                return yield* new StorageError({
                  message: `Parent branch not found in session: ${branch.parentBranchId}`,
                })
              }
            }
            yield* sql`INSERT INTO branches ${sql.insert({
              id: branch.id,
              session_id: branch.sessionId,
              parent_branch_id: toSqlNull(branch.parentBranchId),
              parent_message_id: toSqlNull(branch.parentMessageId),
              name: toSqlNull(branch.name),
              created_at: branch.createdAt.getTime(),
            })}`
            return branch
          },
          Effect.mapError(storageError("Failed to create branch")),
        ),

        getBranch: Effect.fn("BranchStorage.getBranch")(
          function* (id) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<BranchRow>`SELECT ${sql.literal(BRANCH_COLUMNS)}
              FROM branches b
              JOIN sessions s ON s.id = b.session_id
              WHERE b.id = ${id} AND s.workspace_id = ${workspaceId}`
            const row = rows[0]
            // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
            if (Predicate.isUndefined(row)) return undefined
            return yield* branchFromRow(row)
          },
          Effect.mapError(storageError("Failed to get branch")),
        ),

        listBranches: Effect.fn("BranchStorage.listBranches")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<BranchRow>`SELECT ${sql.literal(BRANCH_COLUMNS)}
              FROM branches b
              JOIN sessions s ON s.id = b.session_id
              WHERE b.session_id = ${sessionId} AND s.workspace_id = ${workspaceId}
              ORDER BY b.created_at ASC`
            return yield* Effect.forEach(rows, branchFromRow)
          },
          Effect.mapError(storageError("Failed to list branches")),
        ),

        countMessagesByBranches: Effect.fn("BranchStorage.countMessagesByBranches")(
          function* (branchIds) {
            if (branchIds.length === 0) return new Map<BranchId, number>()
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<{
              branch_id: BranchId
              count: number
            }>`SELECT m.branch_id, COUNT(*) as count
              FROM messages m
              JOIN sessions s ON s.id = m.session_id
              WHERE m.branch_id IN ${sqlInList(sql, branchIds)}
                AND s.workspace_id = ${workspaceId}
              GROUP BY m.branch_id`
            const result = new Map<BranchId, number>()
            for (const row of rows) {
              result.set(row.branch_id, row.count)
            }
            return result
          },
          Effect.mapError(storageError("Failed to count messages by branches")),
        ),
      } satisfies BranchStorageService
    }),
  )
}

// ── message-storage ─────────────────────────────────────────────────────────

/**
 * MessageStorage — focused service for message CRUD.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

interface MessageStorageService {
  readonly createMessage: (message: Message) => Effect.Effect<Message, StorageError>
  readonly createMessageIfAbsent: (message: Message) => Effect.Effect<Message, StorageError>
  // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
  readonly getMessage: (id: MessageId) => Effect.Effect<Message | undefined, StorageError>
  readonly listMessages: (branchId: BranchId) => Effect.Effect<ReadonlyArray<Message>, StorageError>
  readonly updateMessageTurnDuration: (
    messageId: MessageId,
    durationMs: number,
  ) => Effect.Effect<void, StorageError>
  /** Whether any stored message, in any workspace, holds the tool image of this digest. */
  readonly toolImageReferenced: (sha256: string) => Effect.Effect<boolean, StorageError>
}

export class MessageStorage extends Context.Service<MessageStorage, MessageStorageService>()(
  "@gent/core/src/storage/storage/MessageStorage",
) {
  static Live: Layer.Layer<MessageStorage, never, SqlClient.SqlClient | GentPlatform> =
    Layer.effect(
      MessageStorage,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const platform = yield* GentPlatform
        const insertContent = Effect.fn("MessageStorage.insertContent")(function* (
          message: Message,
          partJsons: ReadonlyArray<string>,
        ) {
          const messageId = message.id
          // Each tool image the message holds, counted in the same transaction
          // as the message, so the blob sweep never takes an image a stored
          // message references.
          yield* Effect.forEach(
            toolImageDigests(message.parts),
            (sha256) =>
              sql`INSERT OR IGNORE INTO tool_image_references (sha256, message_id) VALUES (${sha256}, ${messageId})`,
            { discard: true },
          )
          // Called only for a message row this transaction just inserted: it
          // has no chunks yet, and an insert orphans none. The session delete
          // cascade is the one path that orphans chunks, and it sweeps them.
          yield* Effect.forEach(
            partJsons,
            (partJson, ordinal) =>
              Effect.gen(function* () {
                const chunkId = platform.hash("sha256", partJson)
                yield* sql`INSERT OR IGNORE INTO content_chunks (id, part_json) VALUES (${chunkId}, ${partJson})`
                yield* sql`INSERT INTO message_chunks (message_id, ordinal, chunk_id) VALUES (${messageId}, ${ordinal}, ${chunkId})`
              }),
            { discard: true },
          )
        })
        const ensureMessageWorkspace = Effect.fn("MessageStorage.ensureMessageWorkspace")(
          function* (message: Pick<Message, "sessionId" | "branchId">) {
            if (!(yield* branchInSession(sql, message.branchId, message.sessionId))) {
              return yield* new StorageError({
                message: `Branch not found in current workspace: ${message.branchId}`,
              })
            }
          },
        )

        return {
          createMessage: Effect.fn("MessageStorage.createMessage")(
            function* (message) {
              yield* ensureMessageWorkspace(message)
              const { partJsons, metadataJson } = yield* encodeStoredMessage(message)
              yield* Effect.gen(function* () {
                yield* sql`INSERT INTO messages ${sql.insert({
                  id: message.id,
                  session_id: message.sessionId,
                  branch_id: message.branchId,
                  kind: message._tag,
                  role: message.role,
                  created_at: message.createdAt.getTime(),
                  turn_duration_ms: toSqlNull(message.turnDurationMs),
                  metadata: metadataJson,
                })}`
                yield* insertContent(message, partJsons)
                yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId} AND workspace_id = ${yield* CurrentWorkspaceId}`
              }).pipe(sql.withTransaction)
              return message
            },
            Effect.mapError(storageError("Failed to create message")),
          ),

          createMessageIfAbsent: Effect.fn("MessageStorage.createMessageIfAbsent")(
            function* (message) {
              yield* ensureMessageWorkspace(message)
              const { partJsons, metadataJson } = yield* encodeStoredMessage(message)
              yield* Effect.gen(function* () {
                yield* sql`INSERT OR IGNORE INTO messages (id, session_id, branch_id, kind, role, created_at, turn_duration_ms, metadata) VALUES (${message.id}, ${message.sessionId}, ${message.branchId}, ${message._tag}, ${message.role}, ${message.createdAt.getTime()}, ${toSqlNull(message.turnDurationMs)}, ${metadataJson})`
                const rows = yield* sql<{
                  changed: number
                }>`SELECT changes() as changed`
                if ((rows[0]?.changed ?? 0) > 0) {
                  yield* insertContent(message, partJsons)
                  yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId} AND workspace_id = ${yield* CurrentWorkspaceId}`
                }
              }).pipe(sql.withTransaction)
              return message
            },
            Effect.mapError(storageError("Failed to create message if absent")),
          ),

          getMessage: Effect.fn("MessageStorage.getMessage")(
            function* (id) {
              const workspaceId = yield* CurrentWorkspaceId
              const rawRows = yield* sql`${sql.literal(MESSAGE_CHUNK_SELECT)}
            WHERE m.id = ${id} AND s.workspace_id = ${workspaceId}
            ORDER BY mc.ordinal ASC`
              const rows = yield* Effect.forEach(rawRows, (row) => decodeMessageChunkRow(row))
              const grouped = groupMessageChunkRows(rows)
              const entry = grouped[0]
              // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
              if (Predicate.isUndefined(entry)) return undefined
              return yield* decodeStoredMessage(entry.row, entry.partJsons)
            },
            Effect.mapError(storageError("Failed to get message")),
          ),

          listMessages: Effect.fn("MessageStorage.listMessages")(
            function* (branchId) {
              const workspaceId = yield* CurrentWorkspaceId
              const rawRows = yield* sql`${sql.literal(MESSAGE_CHUNK_SELECT)}
            WHERE m.branch_id = ${branchId} AND s.workspace_id = ${workspaceId}
            ORDER BY m.created_at ASC, m.insertion_order ASC, mc.ordinal ASC`
              const rows = yield* Effect.forEach(rawRows, (row) => decodeMessageChunkRow(row))
              return yield* Effect.forEach(groupMessageChunkRows(rows), ({ row, partJsons }) =>
                decodeStoredMessage(row, partJsons),
              )
            },
            Effect.mapError(storageError("Failed to list messages")),
          ),

          // Every workspace's messages count: the blob store is the data directory's.
          toolImageReferenced: Effect.fn("MessageStorage.toolImageReferenced")(
            function* (sha256) {
              const rows = yield* sql<{
                readonly found: number
              }>`SELECT 1 AS found FROM tool_image_references WHERE sha256 = ${sha256} LIMIT 1`
              return rows.length > 0
            },
            Effect.mapError(storageError("Failed to read tool image references")),
          ),

          updateMessageTurnDuration: Effect.fn("MessageStorage.updateMessageTurnDuration")(
            function* (messageId, durationMs) {
              const workspaceId = yield* CurrentWorkspaceId
              yield* sql`UPDATE messages
              SET turn_duration_ms = ${durationMs}
              WHERE id = ${messageId}
                AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ${workspaceId})`
            },
            Effect.asVoid,
            Effect.mapError(storageError("Failed to update message turn duration")),
          ),
        } satisfies MessageStorageService
      }),
    )
}

// ── event-storage ───────────────────────────────────────────────────────────

/**
 * EventStorage — focused service for agent event persistence + queries.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

const LatestEventIdRow = Schema.Struct({ id: Schema.Finite })
const decodeLatestEventIdRow = Schema.decodeUnknownEffect(LatestEventIdRow)

export class EventDecodeError extends Schema.TaggedError<EventDecodeError>()("EventDecodeError", {
  eventId: EventId,
  operation: Schema.Literals(["listEvents", "listToolResultWindow"]),
  error: Schema.String,
}) {}

type EventDecodeOperation = typeof EventDecodeError.fields.operation.Type

export type EventStorageError = StorageError | EventDecodeError
const isEventDecodeError = Schema.is(EventDecodeError)

/**
 * A retired event type stays in the table after its feature is removed. Replay
 * skips those rows with a warning instead of making the whole session
 * unloadable; a known tag with a bad payload is corruption and still fails.
 */
const isKnownEventTag = (tag: string): boolean => Object.hasOwn(AgentEvent.cases, tag)

const decodePersistedEvent = Effect.fn("EventStorage.decodePersistedEvent")(function* (params: {
  eventId: EventId
  eventJson: string
  operation: EventDecodeOperation
}) {
  return yield* decodeEvent(params.eventJson).pipe(
    Effect.tapCause((cause) =>
      Effect.logWarning("event decode failed").pipe(
        Effect.annotateLogs({
          event_id: params.eventId,
          operation: params.operation,
          error: String(cause),
        }),
      ),
    ),
    Effect.mapError(
      (error) =>
        new EventDecodeError({
          eventId: params.eventId,
          operation: params.operation,
          error: String(error),
        }),
    ),
  )
})

/**
 * Turn raw event rows into envelopes, dropping rows whose tag no longer
 * exists. Both replay reads share this: the only difference between them is
 * which operation a decode failure reports.
 */
const rowsToEnvelopes = Effect.fn("EventStorage.rowsToEnvelopes")(function* (
  rawRows: ReadonlyArray<unknown>,
  operation: EventDecodeOperation,
) {
  const rows = yield* Effect.forEach(rawRows, (row) => decodeEventRow(row))
  const envelopes = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      if (!isKnownEventTag(row.event_tag)) {
        yield* Effect.logWarning("event.retired-tag-skipped").pipe(
          Effect.annotateLogs({ event_id: row.id, event_tag: row.event_tag }),
        )
        return Option.none<EventEnvelope>()
      }
      const decoded = yield* decodePersistedEvent({
        eventId: row.id,
        eventJson: row.event_json,
        operation,
      })
      const fields = {
        id: row.id,
        event: decoded,
        createdAt: row.created_at,
      }
      if (!Predicate.isNull(row.trace_id)) {
        Object.assign(fields, { traceId: row.trace_id })
      }
      return Option.some(EventEnvelope.make(fields))
    }),
  )
  return Arr.getSomes(envelopes)
})

interface EventStorageService {
  readonly appendEvent: (
    event: AgentEvent,
    options?: { traceId?: string },
  ) => Effect.Effect<EventEnvelope, StorageError>
  readonly listEvents: (params: {
    sessionId: SessionId
    branchId?: BranchId
    afterId?: number
  }) => Effect.Effect<ReadonlyArray<EventEnvelope>, EventStorageError>
  readonly getLatestEventId: (params: {
    sessionId: SessionId
    branchId?: BranchId
    // oxlint-disable-next-line effect/noNullish -- Event history lookup uses undefined when no row exists.
  }) => Effect.Effect<number | undefined, StorageError>
  /**
   * Events between one assistant message and the next assistant boundary.
   *
   * The point question a replaying tool step asks: what settled under *this*
   * step. Both bounds are found by id, so the read is the window rather than
   * the transcript. Envelopes, not events -- the publisher's dedup set keys
   * on `envelope.id`.
   */
  readonly listToolResultWindow: (params: {
    sessionId: SessionId
    branchId: BranchId
    assistantMessageId: MessageId
  }) => Effect.Effect<ReadonlyArray<EventEnvelope>, EventStorageError>
}

export class EventStorage extends Context.Service<EventStorage, EventStorageService>()(
  "@gent/core/src/storage/storage/EventStorage",
) {
  static Live: Layer.Layer<EventStorage, never, SqlClient.SqlClient> = Layer.effect(
    EventStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      /** An event on `branchId` or on no branch; every event when no branch is named. */
      const onBranch = (branchId: Option.Option<BranchId>) =>
        Option.match(branchId, {
          onNone: () => sql.literal(""),
          onSome: (branchId) => sql`AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)`,
        })
      const mapEventStorageError = storageErrorExcept(isEventDecodeError)

      return {
        appendEvent: Effect.fn("EventStorage.appendEvent")(
          function* (event, options) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionId = getEventSessionId(event)
            const sessionRows = yield* sql<{ id: SessionId }>`
              SELECT id FROM sessions
              WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
            `
            if (sessionRows.length === 0) {
              return yield* new StorageError({
                message: `Session not found in current workspace: ${sessionId}`,
              })
            }
            const branchId = getEventBranchId(event)
            const createdAt = yield* Clock.currentTimeMillis
            const traceId = options?.traceId
            const eventJson = yield* encodeEvent(event)
            const inserted = yield* sql<{ id: number }>`INSERT INTO events ${sql.insert({
              session_id: sessionId,
              branch_id: toSqlNull(branchId),
              event_tag: event._tag,
              event_json: eventJson,
              created_at: createdAt,
              trace_id: toSqlNull(traceId),
            })} RETURNING id`
            const row = inserted[0]
            if (Predicate.isUndefined(row)) {
              return yield* new StorageError({ message: "Event insert returned no id" })
            }
            return EventEnvelope.make({
              id: EventId.make(row.id),
              event,
              createdAt,
              traceId,
            })
          },
          Effect.mapError(storageError("Failed to append event")),
        ),
        listEvents: Effect.fn("EventStorage.listEvents")(
          function* ({ sessionId, branchId, afterId }) {
            const workspaceId = yield* CurrentWorkspaceId
            const sinceId = afterId ?? 0
            const rawRows =
              yield* sql`SELECT e.id, e.event_tag, e.event_json, e.created_at, e.trace_id
              FROM events e
              JOIN sessions s ON s.id = e.session_id
              WHERE e.session_id = ${sessionId}
                AND s.workspace_id = ${workspaceId}
                ${onBranch(Option.fromUndefinedOr(branchId))}
                AND e.id > ${sinceId}
              ORDER BY e.id ASC`
            return yield* rowsToEnvelopes(rawRows, "listEvents")
          },
          Effect.mapError(mapEventStorageError("Failed to list events")),
        ),

        getLatestEventId: Effect.fn("EventStorage.getLatestEventId")(
          function* ({ sessionId, branchId }) {
            const workspaceId = yield* CurrentWorkspaceId
            const rawRows = yield* sql`SELECT e.id
              FROM events e
              JOIN sessions s ON s.id = e.session_id
              WHERE e.session_id = ${sessionId}
                AND s.workspace_id = ${workspaceId}
                ${onBranch(Option.fromUndefinedOr(branchId))}
              ORDER BY e.id DESC LIMIT 1`
            // oxlint-disable-next-line effect/noNullish -- Event history lookup uses undefined when no row exists.
            if (Predicate.isUndefined(rawRows[0])) return undefined
            const row = yield* decodeLatestEventIdRow(rawRows[0])
            return row.id
          },
          Effect.mapError(storageError("Failed to get latest event id")),
        ),

        listToolResultWindow: Effect.fn("EventStorage.listToolResultWindow")(
          function* ({ sessionId, branchId, assistantMessageId }) {
            const workspaceId = yield* CurrentWorkspaceId
            // `MessageReceived` nests the message, so both bounds read
            // `$.message.*`. Each probe rides idx_events_session_tag.
            const anchorRows = yield* sql<{ id: EventId }>`SELECT e.id
              FROM events e
              JOIN sessions s ON s.id = e.session_id
              WHERE e.session_id = ${sessionId}
                AND s.workspace_id = ${workspaceId}
                ${onBranch(Option.some(branchId))}
                AND e.event_tag = 'MessageReceived'
                AND json_extract(e.event_json, '$.message.id') = ${assistantMessageId}
              ORDER BY e.id DESC LIMIT 1`
            const anchor = anchorRows[0]
            if (Predicate.isUndefined(anchor)) return []
            const boundaryRows = yield* sql<{ id: EventId }>`SELECT e.id
              FROM events e
              JOIN sessions s ON s.id = e.session_id
              WHERE e.session_id = ${sessionId}
                AND s.workspace_id = ${workspaceId}
                ${onBranch(Option.some(branchId))}
                AND e.id > ${anchor.id}
                AND e.event_tag = 'MessageReceived'
                AND json_extract(e.event_json, '$.message.role') = 'assistant'
              ORDER BY e.id ASC LIMIT 1`
            const beforeBoundary = Option.match(Option.fromUndefinedOr(boundaryRows[0]), {
              onNone: () => sql.literal(""),
              onSome: (boundary) => sql`AND e.id < ${boundary.id}`,
            })
            const rawRows =
              yield* sql`SELECT e.id, e.event_tag, e.event_json, e.created_at, e.trace_id
              FROM events e
              JOIN sessions s ON s.id = e.session_id
              WHERE e.session_id = ${sessionId}
                AND s.workspace_id = ${workspaceId}
                ${onBranch(Option.some(branchId))}
                AND e.id > ${anchor.id}
                ${beforeBoundary}
              ORDER BY e.id ASC`
            return yield* rowsToEnvelopes(rawRows, "listToolResultWindow")
          },
          Effect.mapError(mapEventStorageError("Failed to list tool result window")),
        ),
      } satisfies EventStorageService
    }),
  )
}

// ── relationship-storage ────────────────────────────────────────────────────

/**
 * RelationshipStorage — focused service for session tree / relationship queries.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

interface RelationshipStorageService {
  /**
   * The session and its persisted parent chain, nearest first, up to the
   * real root however many handoffs it crosses. The walk stops at a missing
   * or repeated parent, so a broken or cyclic chain ends on a session that
   * still names a parent, and a caller can fail closed on it.
   */
  readonly getSessionAncestors: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  /**
   * Every session of the session's thread, and every session below any of
   * them by parent link, at any depth: delegate children, `/btw` forks and
   * the handoffs of those alike. The thread is read by its key, not from its
   * first session, so a deleted first session (whose handoffs stay, detached)
   * loses none of the rest. One indexed recursive read, so its cost follows
   * the thread's subtree, not the workspace. A parent cycle ends the walk.
   * Empty when the session is not in the workspace.
   */
  readonly getThreadTree: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  /**
   * Every session in one thread, oldest first.
   *
   * A thread is the work itself, not one session's parent line: a session that
   * handed off twice has two children and both continue it. Sessions carry the
   * thread they belong to, so this is one indexed read — a delegate run or a
   * `/btw` fork started its own thread when it was created and is
   * simply not in this one.
   */
  readonly getThreadSessions: (
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
}

/**
 * A session and its parent chain, read by id at every step. `UNION` over ids
 * alone ends on a cycle: a repeated id adds no row. The unary `+` keeps the
 * planner off the workspace index, which would scan the whole workspace.
 * Parameters: the session id, then the workspace id three times.
 */
export const SESSION_ANCESTORS_SQL = `WITH RECURSIVE ancestors(id) AS (
  SELECT id FROM sessions WHERE id = ? AND +workspace_id = ?
  UNION
  SELECT s.parent_session_id
  FROM ancestors a
  JOIN sessions s ON s.id = a.id
  WHERE +s.workspace_id = ? AND s.parent_session_id IS NOT NULL
)
SELECT ${SESSION_COLUMNS}
FROM sessions
WHERE id IN (SELECT id FROM ancestors) AND +workspace_id = ?`

export class RelationshipStorage extends Context.Service<
  RelationshipStorage,
  RelationshipStorageService
>()("@gent/core/src/storage/storage/RelationshipStorage") {
  static Live: Layer.Layer<RelationshipStorage, never, SqlClient.SqlClient> = Layer.effect(
    RelationshipStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return {
        getSessionAncestors: Effect.fn("RelationshipStorage.getSessionAncestors")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql.unsafe<SessionRow>(SESSION_ANCESTORS_SQL, [
              sessionId,
              workspaceId,
              workspaceId,
              workspaceId,
            ])
            const byId = new Map<string, SessionRow>(rows.map((row) => [row.id, row]))
            const chain: SessionRow[] = []
            let next = Option.fromNullishOr(byId.get(sessionId))
            while (Option.isSome(next)) {
              const row = next.value
              chain.push(row)
              byId.delete(row.id)
              next = Option.flatMap(Option.fromNullishOr(row.parent_session_id), (parentId) =>
                Option.fromNullishOr(byId.get(parentId)),
              )
            }
            return yield* Effect.forEach(chain, sessionFromRow)
          },
          Effect.mapError(storageError("Failed to get session ancestors")),
        ),

        getThreadTree: Effect.fn("RelationshipStorage.getThreadTree")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            // The seed is the thread's sessions by key, through
            // `idx_sessions_thread`. `UNION` over ids alone ends on a cycle: a
            // repeated id adds no row. The unary `+` keeps the planner off the
            // workspace index, which would scan every session in the
            // workspace at each step: each step walks `idx_sessions_parent`
            // and the result reads by id.
            const rows = yield* sql<SessionRow>`WITH RECURSIVE tree(id) AS (
            SELECT id FROM sessions
            WHERE workspace_id = ${workspaceId}
              AND thread_id = (
                SELECT thread_id FROM sessions
                WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
              )
            UNION
            SELECT s.id
            FROM tree t
            JOIN sessions s ON s.parent_session_id = t.id
            WHERE +s.workspace_id = ${workspaceId}
          )
          SELECT ${sql.literal(SESSION_COLUMNS)}
          FROM sessions
          WHERE id IN (SELECT id FROM tree) AND +workspace_id = ${workspaceId}
          ORDER BY updated_at DESC`
            return yield* Effect.forEach(rows, sessionFromRow)
          },
          Effect.mapError(storageError("Failed to get thread tree")),
        ),

        getThreadSessions: Effect.fn("RelationshipStorage.getThreadSessions")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<SessionRow>`SELECT ${sql.literal(SESSION_COLUMNS)}
          FROM sessions
          WHERE workspace_id = ${workspaceId}
            AND thread_id = (
              SELECT thread_id FROM sessions
              WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
            )
          ORDER BY created_at ASC`
            return yield* Effect.forEach(rows, sessionFromRow)
          },
          Effect.mapError(storageError("Failed to get thread sessions")),
        ),

        getSessionDetail: Effect.fn("RelationshipStorage.getSessionDetail")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionRows =
              yield* sql<SessionRow>`SELECT ${sql.literal(SESSION_COLUMNS)} FROM sessions WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`
            const sessionRow = sessionRows[0]
            if (Predicate.isUndefined(sessionRow)) {
              return yield* new StorageError({ message: `Session not found: ${sessionId}` })
            }
            const session = yield* sessionFromRow(sessionRow)

            const branchRows = yield* sql<BranchRow>`SELECT ${sql.literal(BRANCH_COLUMNS)}
                FROM branches b
                JOIN sessions s ON s.id = b.session_id
                WHERE b.session_id = ${sessionId} AND s.workspace_id = ${workspaceId}
                ORDER BY b.created_at ASC`
            const branches = yield* Effect.forEach(branchRows, branchFromRow)

            if (branches.length === 0) {
              return { session, branches: [] }
            }

            const branchIds = branches.map((b) => b.id)
            const allMsgRawRows = yield* sql`${sql.literal(MESSAGE_CHUNK_SELECT)}
            WHERE m.branch_id IN ${sqlInList(sql, branchIds)}
              AND s.workspace_id = ${workspaceId}
            ORDER BY m.created_at ASC, m.insertion_order ASC, mc.ordinal ASC`
            const allMsgRows = yield* Effect.forEach(allMsgRawRows, (row) =>
              decodeMessageChunkRow(row),
            )

            const rowsByBranch = new Map<BranchId, Array<MessageChunkRow>>()
            for (const branch of branches) rowsByBranch.set(branch.id, [])
            for (const row of allMsgRows) {
              const bucket = rowsByBranch.get(row.branch_id)
              if (!Predicate.isUndefined(bucket)) bucket.push(row)
            }

            const result = yield* Effect.forEach(branches, (branch) =>
              Effect.gen(function* () {
                const msgRows = rowsByBranch.get(branch.id) ?? []
                const messages = yield* Effect.forEach(
                  groupMessageChunkRows(msgRows),
                  ({ row, partJsons }) => decodeStoredMessage(row, partJsons),
                )
                return { branch, messages }
              }),
            )

            return { session, branches: result }
          },
          Effect.mapError(storageError("Failed to get session detail")),
        ),
      } satisfies RelationshipStorageService
    }),
  )
}

// ── interaction-storage ─────────────────────────────────────────────────────

const InteractionRequestRow = Schema.Struct({
  request_id: Schema.String,
  session_id: SessionId,
  branch_id: BranchId,
  params_json: Schema.String,
  decision_json: Schema.NullOr(Schema.String),
  // Null on rows stored before owners were recorded (migration 021).
  owner_tool_call_id: Schema.NullOr(Schema.String),
  owner_occurrence: Schema.NullOr(Schema.Int),
  // Read raw status string off the wire; the transform coerces
  // unknown values back to "pending".
  status: Schema.String,
  created_at: Schema.Finite,
})
type InteractionRequestRow = typeof InteractionRequestRow.Type
type InteractionRequestRecordEncoded = typeof InteractionRequestRecord.Encoded

const isStatus = Schema.is(InteractionRequestStatus)

const rowToRecord = (row: InteractionRequestRow): InteractionRequestRecordEncoded => {
  let status: InteractionRequestRecordEncoded["status"] = "pending"
  if (isStatus(row.status)) status = row.status
  const record: InteractionRequestRecordEncoded = {
    requestId: row.request_id,
    sessionId: row.session_id,
    branchId: row.branch_id,
    paramsJson: row.params_json,
    status,
    createdAt: row.created_at,
  }
  if (!Predicate.isNull(row.decision_json)) {
    Object.assign(record, { decisionJson: row.decision_json })
  }
  if (!Predicate.isNull(row.owner_tool_call_id) && !Predicate.isNull(row.owner_occurrence)) {
    Object.assign(record, {
      owner: { toolCallId: row.owner_tool_call_id, occurrence: row.owner_occurrence },
    })
  }
  return record
}

const recordToRow = (record: InteractionRequestRecordEncoded): InteractionRequestRow => ({
  request_id: record.requestId,
  session_id: SessionId.make(record.sessionId),
  branch_id: BranchId.make(record.branchId),
  params_json: record.paramsJson,
  decision_json: toSqlNull(record.decisionJson),
  owner_tool_call_id: toSqlNull(record.owner?.toolCallId),
  owner_occurrence: toSqlNull(record.owner?.occurrence),
  status: record.status,
  created_at: record.createdAt,
})

const RowToRecord = InteractionRequestRow.pipe(
  Schema.decodeTo(InteractionRequestRecord, {
    decode: Getter.transform(rowToRecord),
    encode: Getter.transform(recordToRow),
  }),
)

const decodeRow = Schema.decodeUnknownEffect(RowToRecord)

export interface InteractionStorageService {
  /** Startup recovery enumerates owners, then reads each workspace under its own scope. */
  readonly listOpenWorkspaces: Effect.Effect<ReadonlyArray<WorkspaceId>, StorageError>
  readonly persist: (
    record: InteractionRequestRecord,
  ) => Effect.Effect<InteractionRequestRecord, StorageError>
  readonly resolve: (requestId: InteractionRequestId) => Effect.Effect<void, StorageError>
  /**
   * The owning call took the answer and keeps it until the call or its turn
   * ends. The row leaves the pending slot but stays open for recovery.
   */
  readonly take: (requestId: InteractionRequestId) => Effect.Effect<void, StorageError>
  /**
   * Store the answer of a pending request of this session branch. The first
   * answer wins: a later one leaves the row unchanged and gets back the answer
   * already stored. None when the branch has no such row in this workspace,
   * or the row closed without an answer.
   */
  readonly decide: (
    branch: { readonly sessionId: SessionId; readonly branchId: BranchId },
    requestId: InteractionRequestId,
    decisionJson: string,
  ) => Effect.Effect<Option.Option<StoredInteractionDecision>, StorageError>
  /** List open interactions: pending ones, and taken answers a call still keeps.
   *  Pass `scope` to narrow to a specific session+branch. Omit `scope` to scan the
   *  current workspace (startup recovery supplies each persisted workspace id). */
  readonly listOpen: (scope?: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<ReadonlyArray<InteractionRequestRecord>, StorageError>
}

export class InteractionStorage extends Context.Service<
  InteractionStorage,
  InteractionStorageService
>()("@gent/core/src/storage/storage/InteractionStorage") {
  static Live: Layer.Layer<InteractionStorage, never, SqlClient.SqlClient> = Layer.effect(
    InteractionStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return InteractionStorage.of({
        listOpenWorkspaces: Effect.gen(function* () {
          const rows = yield* sql<{ readonly workspace_id: string }>`
              SELECT DISTINCT s.workspace_id
              FROM interaction_requests ir
              JOIN sessions s ON s.id = ir.session_id
              WHERE ir.status IN ('pending', 'taken')
              ORDER BY s.workspace_id
            `
          return yield* Schema.decodeEffect(Schema.Array(WorkspaceId))(
            rows.map((row) => row.workspace_id),
          )
        }).pipe(Effect.mapError(storageError("Failed to list pending interaction workspaces"))),
        persist: Effect.fn("InteractionStorage.persist")(
          function* (record) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionRows = yield* sql<{ id: SessionId }>`SELECT s.id
              FROM sessions s
              JOIN branches b ON b.session_id = s.id
              WHERE s.id = ${record.sessionId}
                AND b.id = ${record.branchId}
                AND s.workspace_id = ${workspaceId}`
            if (sessionRows.length === 0) {
              return yield* new StorageError({
                message: `Interaction session/branch not found in workspace: ${record.sessionId}/${record.branchId}`,
              })
            }
            const ownerCallId = toSqlNull(record.owner?.toolCallId)
            const ownerOccurrence = toSqlNull(record.owner?.occurrence)
            yield* sql`INSERT INTO interaction_requests (request_id, session_id, branch_id, params_json, decision_json, status, created_at, owner_tool_call_id, owner_occurrence) VALUES (${record.requestId}, ${record.sessionId}, ${record.branchId}, ${record.paramsJson}, ${toSqlNull(record.decisionJson)}, ${record.status}, ${record.createdAt}, ${ownerCallId}, ${ownerOccurrence})`
            return record
          },
          Effect.mapError(storageError("Failed to persist interaction request")),
        ),

        decide: Effect.fn("InteractionStorage.decide")(
          function* (branch, requestId, decisionJson) {
            const workspaceId = yield* CurrentWorkspaceId
            // One statement, so two replies that race cannot both store. A
            // reply reaches only the branch it names: another branch's row is
            // never written, and its answer is never read back as a retry.
            const stored = yield* sql`UPDATE interaction_requests
              SET decision_json = ${decisionJson}
              WHERE request_id = ${requestId}
                AND session_id = ${branch.sessionId}
                AND branch_id = ${branch.branchId}
                AND status = 'pending'
                AND decision_json IS NULL
                AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ${workspaceId})
              RETURNING request_id`
            if (stored.length === 1) return Option.some({ first: true, decisionJson })
            const rows = yield* sql<Pick<InteractionRequestRow, "decision_json">>`
              SELECT decision_json FROM interaction_requests
              WHERE request_id = ${requestId}
                AND session_id = ${branch.sessionId}
                AND branch_id = ${branch.branchId}
                AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ${workspaceId})`
            return Option.fromUndefinedOr(rows[0]).pipe(
              Option.flatMap((row) => Option.fromNullishOr(row.decision_json)),
              Option.map((kept) => ({ first: false, decisionJson: kept })),
            )
          },
          Effect.mapError(storageError("Failed to store interaction decision")),
        ),

        take: Effect.fn("InteractionStorage.take")(
          function* (requestId) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql`UPDATE interaction_requests
              SET status = 'taken'
              WHERE request_id = ${requestId}
                AND status = 'pending'
                AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ${workspaceId})`
          },
          Effect.mapError(storageError("Failed to mark interaction answer taken")),
        ),

        resolve: Effect.fn("InteractionStorage.resolve")(
          function* (requestId) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql`UPDATE interaction_requests
              SET status = 'resolved'
              WHERE request_id = ${requestId}
                AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ${workspaceId})`
          },
          Effect.mapError(storageError("Failed to resolve interaction request")),
        ),

        listOpen: Effect.fn("InteractionStorage.listOpen")(
          function* (scope?: { sessionId: SessionId; branchId: BranchId }) {
            const workspaceId = yield* CurrentWorkspaceId
            const inScope = Option.match(Option.fromUndefinedOr(scope), {
              onNone: () => sql.literal(""),
              onSome: (scope) =>
                sql`AND ir.session_id = ${scope.sessionId} AND ir.branch_id = ${scope.branchId}`,
            })
            const rows =
              yield* sql<InteractionRequestRow>`SELECT ir.request_id, ir.session_id, ir.branch_id, ir.params_json, ir.decision_json, ir.owner_tool_call_id, ir.owner_occurrence, ir.status, ir.created_at
              FROM interaction_requests ir
              JOIN sessions s ON s.id = ir.session_id
              WHERE ir.status IN ('pending', 'taken')
                ${inScope}
                AND s.workspace_id = ${workspaceId}
              ORDER BY ir.created_at ASC`
            return yield* Effect.forEach(rows, (row) => decodeRow(row))
          },
          Effect.mapError(storageError("Failed to list pending interaction requests")),
        ),
      })
    }),
  )
}

// ── agent-loop-queue-storage ────────────────────────────────────────────────

/**
 * AgentLoopQueueStorage — durable branch-local queued turns.
 *
 * Actor mailbox persistence only deduplicates delivered operations. The
 * product queue is a runtime datum users can observe and expect to survive
 * worker restart, so it gets its own storage row per branch.
 */

const LoopQueueStateJson = Schema.fromJsonString(LoopQueueState)
const decodeLoopQueueState = Schema.decodeUnknownEffect(LoopQueueStateJson)
const encodeLoopQueueState = Schema.encodeEffect(LoopQueueStateJson)

const QueueRow = Schema.Struct({ queue_json: Schema.String })
const decodeQueueRow = Schema.decodeUnknownEffect(QueueRow)

interface AgentLoopQueueStorageService {
  readonly getQueueState: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<LoopQueueStateType, StorageError>
  readonly putQueueState: (
    sessionId: SessionId,
    branchId: BranchId,
    queue: LoopQueueStateType,
  ) => Effect.Effect<void, StorageError>
}

export class AgentLoopQueueStorage extends Context.Service<
  AgentLoopQueueStorage,
  AgentLoopQueueStorageService
>()("@gent/core/src/storage/storage/AgentLoopQueueStorage") {
  static Live: Layer.Layer<AgentLoopQueueStorage, never, SqlClient.SqlClient> = Layer.effect(
    AgentLoopQueueStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return {
        getQueueState: Effect.fn("AgentLoopQueueStorage.getQueueState")(
          function* (sessionId, branchId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rawRows = yield* sql`SELECT q.queue_json
            FROM agent_loop_queues q
            WHERE q.session_id = ${sessionId}
              AND q.branch_id = ${branchId}
              AND q.workspace_id = ${workspaceId}
            LIMIT 1`
            if (Predicate.isUndefined(rawRows[0])) return emptyLoopQueueState()
            const row = yield* decodeQueueRow(rawRows[0])
            return yield* decodeLoopQueueState(row.queue_json)
          },
          Effect.mapError(storageError("Failed to get agent loop queue")),
        ),

        putQueueState: Effect.fn("AgentLoopQueueStorage.putQueueState")(
          function* (sessionId, branchId, queue) {
            const workspaceId = yield* CurrentWorkspaceId
            const queueJson = yield* encodeLoopQueueState(queue)
            const updatedAt = yield* Clock.currentTimeMillis
            yield* sql`INSERT INTO agent_loop_queues (workspace_id, session_id, branch_id, queue_json, updated_at)
              VALUES (${workspaceId}, ${sessionId}, ${branchId}, ${queueJson}, ${updatedAt})
              ON CONFLICT(workspace_id, session_id, branch_id) DO UPDATE SET
                queue_json = excluded.queue_json,
                updated_at = excluded.updated_at`
          },
          Effect.mapError(storageError("Failed to put agent loop queue")),
        ),
      } satisfies AgentLoopQueueStorageService
    }),
  )
}

// ── session-operation-storage ───────────────────────────────────────────────

const CANCEL_TURN_OPERATION = "turn.cancel"
const MODEL_ATTEMPT_OPERATION = "turn.model-attempt"

const TurnCancellationAddress = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  messageId: MessageId,
})
interface TurnCancellationAddress extends Schema.Schema.Type<typeof TurnCancellationAddress> {}

export const StoredCreateSessionResult = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
  initialPrompt: Schema.optional(Schema.String),
})
export type StoredCreateSessionResult = typeof StoredCreateSessionResult.Type

export const StoredBranchResult = Schema.Struct({
  branchId: BranchId,
})
export type StoredBranchResult = typeof StoredBranchResult.Type

export const StoredSwitchBranchResult = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  toBranchId: BranchId,
})
export type StoredSwitchBranchResult = typeof StoredSwitchBranchResult.Type

/**
 * A mutation whose result is kept per request id, so a retry replays the
 * receipt instead of repeating the work.
 */
export interface DurableOperation<A> {
  readonly name: string
  readonly json: Schema.Codec<A, string>
}

const durableOperation = <A, I>(name: string, result: Schema.Codec<A, I>): DurableOperation<A> => ({
  name,
  json: Schema.fromJsonString(result),
})

export const DurableOperations = {
  createSession: durableOperation("session.create", StoredCreateSessionResult),
  createBranch: durableOperation("branch.create", StoredBranchResult),
  forkBranch: durableOperation("branch.fork", StoredBranchResult),
  switchBranch: durableOperation("branch.switch", StoredSwitchBranchResult),
}

interface OperationSubject {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

interface SessionOperationStorageService {
  /** False: the turn spent its `max`. A successful reservation is never refunded. */
  readonly reserveModelAttempt: (address: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly messageId: MessageId
    readonly max: number
  }) => Effect.Effect<boolean, StorageError>
  readonly cancelTurn: (address: TurnCancellationAddress) => Effect.Effect<void, StorageError>
  readonly isTurnCancelled: (
    address: TurnCancellationAddress,
  ) => Effect.Effect<boolean, StorageError>
  readonly getReceipt: <A>(
    operation: DurableOperation<A>,
    requestId: RequestId,
    // oxlint-disable-next-line effect/noNullish -- Idempotency lookup uses undefined when no row exists.
  ) => Effect.Effect<A | undefined, StorageError>
  readonly saveReceipt: <A>(
    operation: DurableOperation<A>,
    requestId: RequestId,
    result: A,
    subject: OperationSubject,
  ) => Effect.Effect<void, StorageError>
}

export class SessionOperationStorage extends Context.Service<
  SessionOperationStorage,
  SessionOperationStorageService
>()("@gent/core/src/storage/storage/SessionOperationStorage") {
  static Live: Layer.Layer<SessionOperationStorage, never, SqlClient.SqlClient> = Layer.effect(
    SessionOperationStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const getOperation = Effect.fn("SessionOperationStorage.getOperation")(function* <A>(
        operation: string,
        requestId: string,
        decode: (json: string) => Effect.Effect<A, unknown>,
      ) {
        const workspaceId = yield* CurrentWorkspaceId
        const rows = yield* sql<{ result_json: string }>`
          SELECT result_json
          FROM durable_operations
          WHERE workspace_id = ${workspaceId}
            AND operation = ${operation}
            AND request_id = ${requestId}
          LIMIT 1
        `
        const row = rows[0]
        // oxlint-disable-next-line effect/noNullish -- Idempotency lookup uses undefined when no row exists.
        if (Predicate.isUndefined(row)) return undefined
        return yield* decode(row.result_json)
      })

      const saveOperation = Effect.fn("SessionOperationStorage.saveOperation")(function* <A>(
        operation: string,
        requestId: string,
        result: A,
        encode: (value: A) => Effect.Effect<string, unknown>,
        subject: OperationSubject,
      ) {
        const workspaceId = yield* CurrentWorkspaceId
        const resultJson = yield* encode(result)
        const createdAt = (yield* DateTime.nowAsDate).getTime()
        yield* sql`
          INSERT INTO durable_operations (
            workspace_id,
            operation,
            request_id,
            result_json,
            subject_session_id,
            subject_branch_id,
            created_at
          )
          VALUES (
            ${workspaceId},
            ${operation},
            ${requestId},
            ${resultJson},
            ${subject.sessionId},
            ${subject.branchId},
            ${createdAt}
          )
        `
      })

      return {
        reserveModelAttempt: Effect.fn("SessionOperationStorage.reserveModelAttempt")(
          function* (address) {
            if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
              return yield* new StorageError({
                message: "Model admission must commit outside a caller transaction",
              })
            }
            if (!(yield* branchInSession(sql, address.branchId, address.sessionId)))
              return yield* new StorageError({ message: "Model branch does not belong to session" })
            if (address.max === 0) return false
            const workspaceId = yield* CurrentWorkspaceId
            const createdAt = (yield* DateTime.nowAsDate).getTime()
            const reserved = yield* sql`
              INSERT INTO durable_operations (
                workspace_id, operation, request_id, result_json,
                subject_session_id, subject_branch_id, created_at
              ) VALUES (
                ${workspaceId}, ${MODEL_ATTEMPT_OPERATION}, ${address.messageId}, '{"attempts":1}',
                ${address.sessionId}, ${address.branchId}, ${createdAt}
              ) ON CONFLICT(workspace_id, operation, request_id) DO UPDATE SET
                result_json = json_set(durable_operations.result_json, '$.attempts',
                  json_extract(durable_operations.result_json, '$.attempts') + 1)
              WHERE json_extract(durable_operations.result_json, '$.attempts') < ${address.max}
              RETURNING request_id`
            return reserved.length === 1
          },
          Effect.mapError(storageError("Failed to reserve model attempt")),
        ),
        cancelTurn: Effect.fn("SessionOperationStorage.cancelTurn")(
          function* (address) {
            const workspaceId = yield* CurrentWorkspaceId
            if (!(yield* branchInSession(sql, address.branchId, address.sessionId))) {
              return yield* new StorageError({
                message: "Cancellation branch does not belong to session",
              })
            }
            const createdAt = (yield* DateTime.nowAsDate).getTime()
            yield* sql`INSERT INTO durable_operations (
              workspace_id, operation, request_id, result_json,
              subject_session_id, subject_branch_id, created_at
            ) VALUES (
              ${workspaceId}, ${CANCEL_TURN_OPERATION}, ${address.messageId}, '{}',
              ${address.sessionId}, ${address.branchId}, ${createdAt}
            ) ON CONFLICT(workspace_id, operation, request_id) DO NOTHING`
            const owned = yield* sql`SELECT 1 FROM durable_operations
              WHERE workspace_id = ${workspaceId}
                AND operation = ${CANCEL_TURN_OPERATION}
                AND request_id = ${address.messageId}
                AND subject_session_id = ${address.sessionId}
                AND subject_branch_id = ${address.branchId}`
            if (owned.length === 0) {
              return yield* new StorageError({
                message: "Cancellation receipt belongs to another turn",
              })
            }
          },
          Effect.mapError(storageError("Failed to record turn cancellation")),
        ),
        isTurnCancelled: Effect.fn("SessionOperationStorage.isTurnCancelled")(
          function* (address) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql`SELECT 1 FROM durable_operations
              WHERE workspace_id = ${workspaceId}
                AND operation = ${CANCEL_TURN_OPERATION}
                AND request_id = ${address.messageId}
                AND subject_session_id = ${address.sessionId}
                AND subject_branch_id = ${address.branchId}
              LIMIT 1`
            return rows.length > 0
          },
          Effect.mapError(storageError("Failed to read turn cancellation")),
        ),
        getReceipt: Effect.fn("SessionOperationStorage.getReceipt")(
          function* <A>(operation: DurableOperation<A>, requestId: RequestId) {
            return yield* getOperation(
              operation.name,
              requestId,
              Schema.decodeUnknownEffect(operation.json),
            )
          },
          Effect.mapError(storageError("Failed to get operation receipt")),
        ),

        saveReceipt: Effect.fn("SessionOperationStorage.saveReceipt")(
          function* <A>(
            operation: DurableOperation<A>,
            requestId: RequestId,
            result: A,
            subject: OperationSubject,
          ) {
            yield* saveOperation(
              operation.name,
              requestId,
              result,
              Schema.encodeEffect(operation.json),
              subject,
            )
          },
          Effect.mapError(storageError("Failed to save operation receipt")),
        ),
      } satisfies SessionOperationStorageService
    }),
  )
}

// ── tool-call-binding-storage ───────────────────────────────────────────────

const ToolCallBindingRow = Schema.Struct({
  assistant_message_id: Schema.String,
  tool_call_id: Schema.String,
  binding_json: Schema.String,
  created_at: Schema.Finite,
})
type ToolCallBindingRow = typeof ToolCallBindingRow.Type

interface ToolCallBindingStorageWrite extends ToolCallBindingKey {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly binding: ToolBindingIdentity
  readonly createdAt?: number
}

interface ToolCallBindingStorageService {
  readonly save: (
    params: ToolCallBindingStorageWrite,
  ) => Effect.Effect<ToolBindingIdentity, StorageError | ToolCallBindingConflictError>
  readonly get: (
    params: ToolCallBindingKey & {
      readonly sessionId: SessionId
      readonly branchId: BranchId
    },
    // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
  ) => Effect.Effect<ToolBindingIdentity | undefined, StorageError>
}

const mapStorageError = storageErrorExcept(Schema.is(ToolCallBindingConflictError))

export class ToolCallBindingStorage extends Context.Service<
  ToolCallBindingStorage,
  ToolCallBindingStorageService
>()("@gent/core/src/storage/storage/ToolCallBindingStorage") {
  static Live: Layer.Layer<ToolCallBindingStorage, never, SqlClient.SqlClient> = Layer.effect(
    ToolCallBindingStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const readOwnedCall = yield* makeOwnedToolCallReader
      const loadOwnedCall = (params: Parameters<typeof readOwnedCall>[0]) =>
        readOwnedCall(params).pipe(
          Effect.map((call) => Option.getOrUndefined(Option.map(call, (part) => part.name))),
        )

      const loadOwnedRow = Effect.fn("ToolCallBindingStorage.loadOwnedRow")(function* (params: {
        readonly assistantMessageId: MessageId
        readonly toolCallId: ToolCallId
        readonly sessionId: SessionId
        readonly branchId: BranchId
      }) {
        const workspaceId = yield* CurrentWorkspaceId
        const rows = yield* sql<ToolCallBindingRow>`
          SELECT b.assistant_message_id, b.tool_call_id, b.binding_json, b.created_at
          FROM tool_call_bindings b
          JOIN messages m ON m.id = b.assistant_message_id
          JOIN sessions s ON s.id = m.session_id
          WHERE b.assistant_message_id = ${params.assistantMessageId}
            AND b.tool_call_id = ${params.toolCallId}
            AND m.session_id = ${params.sessionId}
            AND m.branch_id = ${params.branchId}
            AND m.role = 'assistant'
            AND s.workspace_id = ${workspaceId}
          LIMIT 1
        `
        return rows[0]
      })

      const save = Effect.fn("ToolCallBindingStorage.save")(function* (
        params: ToolCallBindingStorageWrite,
      ) {
        const validatedBinding = yield* validateToolBindingIdentity(params.binding).pipe(
          Effect.mapError(mapStorageError("Invalid tool call binding identity")),
        )
        const bindingJson = yield* encodeToolBindingIdentity(validatedBinding).pipe(
          Effect.mapError(mapStorageError("Failed to encode tool call binding")),
        )
        const createdAt = params.createdAt ?? (yield* DateTime.nowAsDate).getTime()

        return yield* Effect.gen(function* () {
          const toolName = yield* loadOwnedCall(params)
          if (Predicate.isUndefined(toolName)) {
            return yield* new StorageError({
              message: `Assistant message does not contain the requested tool call in the current workspace and branch: ${params.assistantMessageId}/${params.toolCallId}`,
            })
          }
          if (toolName !== validatedBinding.toolId) {
            return yield* new StorageError({
              message: `Tool call name does not match the binding identity: ${params.toolCallId}`,
            })
          }

          yield* sql`
            INSERT INTO tool_call_bindings (
              assistant_message_id,
              tool_call_id,
              binding_json,
              created_at
            ) VALUES (
              ${params.assistantMessageId},
              ${params.toolCallId},
              ${bindingJson},
              ${createdAt}
            )
            ON CONFLICT (assistant_message_id, tool_call_id) DO NOTHING
          `

          const row = yield* loadOwnedRow(params)
          if (Predicate.isUndefined(row)) {
            return yield* new StorageError({
              message: `Tool call binding disappeared during save: ${params.assistantMessageId}/${params.toolCallId}`,
            })
          }
          const existing = yield* Schema.decodeEffect(ToolCallBindingRow)(row).pipe(
            Effect.mapError(mapStorageError("Failed to decode stored tool call binding row")),
            Effect.flatMap((decoded) =>
              decodeToolBindingIdentity(decoded.binding_json).pipe(
                Effect.mapError(mapStorageError("Failed to decode stored tool binding identity")),
              ),
            ),
          )
          const existingJson = yield* encodeToolBindingIdentity(existing).pipe(
            Effect.mapError(mapStorageError("Failed to encode stored tool binding identity")),
          )
          if (existing.toolId !== toolName) {
            return yield* new StorageError({
              message: `Stored binding does not match the message tool call: ${params.toolCallId}`,
            })
          }
          if (existingJson !== bindingJson) {
            return yield* new ToolCallBindingConflictError({
              assistantMessageId: params.assistantMessageId,
              toolCallId: params.toolCallId,
            })
          }
          return existing
        }).pipe(
          sql.withTransaction,
          Effect.mapError(mapStorageError("Failed to save tool call binding")),
        )
      })

      const get = Effect.fn("ToolCallBindingStorage.get")(function* (
        params: ToolCallBindingKey & {
          readonly sessionId: SessionId
          readonly branchId: BranchId
        },
      ) {
        return yield* Effect.gen(function* () {
          const row = yield* loadOwnedRow(params)
          // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
          if (Predicate.isUndefined(row)) return undefined
          const decoded = yield* Schema.decodeEffect(ToolCallBindingRow)(row).pipe(
            Effect.mapError(storageError("Failed to decode stored tool call binding row")),
          )
          const binding = yield* decodeToolBindingIdentity(decoded.binding_json).pipe(
            Effect.mapError(storageError("Failed to decode stored tool binding identity")),
          )
          const toolName = yield* loadOwnedCall(params)
          if (Predicate.isUndefined(toolName) || toolName !== binding.toolId) {
            return yield* new StorageError({
              message: `Stored binding does not match the message tool call: ${params.toolCallId}`,
            })
          }
          return binding
        }).pipe(Effect.mapError(storageError("Failed to load tool call binding")))
      })

      return ToolCallBindingStorage.of({ save, get })
    }),
  )
}

// ── turn-record-storage ─────────────────────────────────────────────────────

/**
 * The durable position of one turn.
 *
 * A turn is keyed by the user message that opened it. The record is one row:
 * the step whose messages committed, how many continuation instructions the
 * turn has spent, and the tool calls the current step issued and has not
 * settled. A resumed turn reads it in one query; only a turn with no row
 * probes its derived message ids (`resolveTurnPosition`).
 *
 * The row is written after the step's messages commit, in its own
 * transaction. A reader can therefore see a step's messages without the
 * position that names them, so the row is a hint and the messages decide:
 * `resolveTurnPosition` cross-checks both branches against the assistant
 * message before it trusts the step this row reports.
 */

/** One tool call the current step issued. Named so replay can match it. */
export const PendingToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /**
   * The call's last run ended by parking on an interaction, before any work
   * it asked about. Only such a call runs again when its turn resumes; a call
   * without the mark was cut short while it ran, and is reported as
   * interrupted instead. Absent on rows written before the mark existed.
   */
  parked: Schema.optional(Schema.Boolean),
  /**
   * The verdict the `toolCall` hooks gave the parked call. Its next run
   * applies it and is not judged again. Absent when no hook judged the call,
   * and on rows written before the verdict existed.
   */
  verdict: Schema.optional(ToolCallVerdict),
  /**
   * Whether the call passed its gate: `passed` once the user approved its
   * `Ask`, so the next run does not ask that question again. Absent reads as
   * `pending` (a row written before the state existed asks again).
   */
  gate: Schema.optional(ToolCallGateState),
})
export type PendingToolCall = typeof PendingToolCall.Type

export const TurnRecord = Schema.Struct({
  /** The last step whose assistant and tool messages committed. 0 before step 1. */
  step: Schema.Natural,
  /** Continuation instructions this turn has persisted. Capped by the loop. */
  continuations: Schema.Natural,
  /** Tool calls the current step issued and has not settled. */
  pendingToolCalls: Schema.Array(PendingToolCall),
})
export type TurnRecord = typeof TurnRecord.Type

export const emptyTurnRecord: TurnRecord = {
  step: 0,
  continuations: 0,
  pendingToolCalls: [],
}

interface TurnRecordKey {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
}

const TurnRecordRow = Schema.Struct({
  step: Schema.Natural,
  continuations: Schema.Natural,
  pending_tool_calls_json: Schema.String,
})

const decodePending = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(PendingToolCall)))
const encodePending = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(PendingToolCall)))
interface TurnRecordStorageService {
  /** The turn's position, or the empty record when the turn has no row yet. */
  readonly get: (key: TurnRecordKey) => Effect.Effect<TurnRecord, StorageError>
  /** Write the turn's position. Idempotent for one step boundary. */
  readonly put: (key: TurnRecordKey, record: TurnRecord) => Effect.Effect<void, StorageError>
}

export class TurnRecordStorage extends Context.Service<
  TurnRecordStorage,
  TurnRecordStorageService
>()("@gent/core/src/storage/storage/TurnRecordStorage") {
  static Live: Layer.Layer<TurnRecordStorage, never, SqlClient.SqlClient> = Layer.effect(
    TurnRecordStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const get = Effect.fn("TurnRecordStorage.get")(function* (key: TurnRecordKey) {
        return yield* Effect.gen(function* () {
          const workspaceId = yield* CurrentWorkspaceId
          const rows = yield* sql<typeof TurnRecordRow.Type>`
            SELECT t.step, t.continuations, t.pending_tool_calls_json
            FROM turn_records t
            JOIN sessions s ON s.id = t.session_id
            WHERE t.session_id = ${key.sessionId}
              AND t.branch_id = ${key.branchId}
              AND t.message_id = ${key.messageId}
              AND s.workspace_id = ${workspaceId}
            LIMIT 1
          `
          const row = rows[0]
          if (Predicate.isUndefined(row)) return emptyTurnRecord
          const decoded = yield* Schema.decodeEffect(TurnRecordRow)(row)
          const pendingToolCalls = yield* decodePending(decoded.pending_tool_calls_json)
          return {
            step: decoded.step,
            continuations: decoded.continuations,
            pendingToolCalls,
          } satisfies TurnRecord
        }).pipe(Effect.mapError(storageError("Failed to read the turn record")))
      })

      const put = Effect.fn("TurnRecordStorage.put")(function* (
        key: TurnRecordKey,
        record: TurnRecord,
      ) {
        return yield* Effect.gen(function* () {
          // The writer checks what the reader decodes: a negative or
          // fractional count fails here instead of being stored.
          yield* Schema.encodeEffect(TurnRecord)(record)
          const pendingJson = yield* encodePending(record.pendingToolCalls)
          const updatedAt = (yield* DateTime.nowAsDate).getTime()
          yield* sql`
            INSERT INTO turn_records (
              session_id,
              branch_id,
              message_id,
              step,
              continuations,
              pending_tool_calls_json,
              updated_at
            ) VALUES (
              ${key.sessionId},
              ${key.branchId},
              ${key.messageId},
              ${record.step},
              ${record.continuations},
              ${pendingJson},
              ${updatedAt}
            )
            ON CONFLICT (session_id, branch_id, message_id) DO UPDATE SET
              step = excluded.step,
              continuations = excluded.continuations,
              pending_tool_calls_json = excluded.pending_tool_calls_json,
              updated_at = excluded.updated_at
          `
        }).pipe(Effect.mapError(storageError("Failed to write the turn record")))
      })

      return TurnRecordStorage.of({ get, put })
    }),
  )
}

// ── model-catalog-snapshot-storage ──────────────────────────────────────────

/**
 * One models.dev source as last served (`model_catalog_snapshots`): the raw
 * body, its ETag, when the body arrived and when it was last confirmed. The
 * catalog is the process's, not a workspace's, so the row has no workspace.
 */
const ModelCatalogSnapshot = Schema.Struct({
  source: Schema.String,
  body: Schema.String,
  etag: Schema.OptionFromNullOr(Schema.String),
  fetched_at: Schema.Finite,
  checked_at: Schema.Finite,
})
type ModelCatalogSnapshot = typeof ModelCatalogSnapshot.Type
const decodeModelCatalogSnapshot = Schema.decodeUnknownEffect(ModelCatalogSnapshot)

interface ModelCatalogSnapshotStorageService {
  /** The stored snapshot of `source`; none before its first fetch. */
  readonly get: (source: string) => Effect.Effect<Option.Option<ModelCatalogSnapshot>, StorageError>
  /** Store a body that arrived (a 200): the body, its ETag and both times. */
  readonly put: (snapshot: ModelCatalogSnapshot) => Effect.Effect<void, StorageError>
  /** A 304 confirmed the stored body: move `checked_at` only. */
  readonly confirm: (source: string, checkedAt: number) => Effect.Effect<void, StorageError>
}

export class ModelCatalogSnapshotStorage extends Context.Service<
  ModelCatalogSnapshotStorage,
  ModelCatalogSnapshotStorageService
>()("@gent/core/src/storage/storage/ModelCatalogSnapshotStorage") {
  static Live: Layer.Layer<ModelCatalogSnapshotStorage, never, SqlClient.SqlClient> = Layer.effect(
    ModelCatalogSnapshotStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const get = Effect.fn("ModelCatalogSnapshotStorage.get")(
        function* (source: string) {
          const rows = yield* sql`
              SELECT source, body, etag, fetched_at, checked_at
              FROM model_catalog_snapshots
              WHERE source = ${source}
              LIMIT 1
            `
          if (Predicate.isUndefined(rows[0])) return Option.none<ModelCatalogSnapshot>()
          return Option.some(yield* decodeModelCatalogSnapshot(rows[0]))
        },
        Effect.mapError(storageError("Failed to read the model catalog snapshot")),
      )

      const put = Effect.fn("ModelCatalogSnapshotStorage.put")(
        function* (snapshot: ModelCatalogSnapshot) {
          const etag = Option.getOrNull(snapshot.etag)
          yield* sql`
              INSERT INTO model_catalog_snapshots (source, body, etag, fetched_at, checked_at)
              VALUES (${snapshot.source}, ${snapshot.body}, ${etag}, ${snapshot.fetched_at}, ${snapshot.checked_at})
              ON CONFLICT (source) DO UPDATE SET
                body = excluded.body,
                etag = excluded.etag,
                fetched_at = excluded.fetched_at,
                checked_at = excluded.checked_at
            `
        },
        Effect.mapError(storageError("Failed to store the model catalog snapshot")),
      )

      const confirm = Effect.fn("ModelCatalogSnapshotStorage.confirm")(
        function* (source: string, checkedAt: number) {
          yield* sql`
              UPDATE model_catalog_snapshots SET checked_at = ${checkedAt} WHERE source = ${source}
            `
        },
        Effect.mapError(storageError("Failed to confirm the model catalog snapshot")),
      )

      return ModelCatalogSnapshotStorage.of({ get, put, confirm })
    }),
  )
}

// ── sqlite-storage ──────────────────────────────────────────────────────────

export type StorageTransaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | StorageError, R>

// A closure over the layer's `SqlClient` that runs an effect in one
// transaction and reports a SQL failure as a StorageError.
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

type FocusedStorage =
  | SqlClient.SqlClient
  | InteractionStorage
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | AgentLoopQueueStorage
  | EventStorage
  | RelationshipStorage
  | SessionOperationStorage
  | ToolCallBindingStorage
  | TurnRecordStorage
  | ModelCatalogSnapshotStorage
  | ClusterMessageStorage.MessageStorage

/**
 * The kernel's repositories over one SQL client. Each layer appears once in
 * the graph, so the client and every repository build once: a composite
 * reached by two paths builds once per path. An extension that owns tables
 * builds its own repositories as a process Resource over the same client.
 */
const provideFocusedRepositories = <E, R>(
  base: Layer.Layer<SqlClient.SqlClient, E, R>,
): Layer.Layer<FocusedStorage, E, R | GentPlatform | Crypto.Crypto> =>
  Layer.provideMerge(
    Layer.mergeAll(
      SessionStorage.Live,
      BranchStorage.Live,
      MessageStorage.Live,
      AgentLoopQueueStorage.Live,
      EventStorage.Live,
      RelationshipStorage.Live,
      SessionOperationStorage.Live,
      ToolCallBindingStorage.Live,
      TurnRecordStorage.Live,
      ModelCatalogSnapshotStorage.Live,
      encoreSqlMessageStorage(),
      InteractionStorage.Live,
    ),
    base,
  )

export const SqliteStorage = {
  /**
   * The kernel's repositories over a SQLite client the host opens: the Bun
   * host's file or in-memory connection (`BunSqlite`, `gent-platform-bun.ts`)
   * or a host's own (a Durable Object's). The client layer owns the
   * connection and its PRAGMAs; init runs the portable DDL only.
   *
   * Load-bearing: `deleteSession`'s atomic SELECT+DELETE runs in one
   * transaction. The Bun client opens it with BEGIN IMMEDIATE over its one
   * connection, so it holds the write lock from the start and no child row is
   * committed between the recursive SELECT and the DELETE; a Durable Object
   * runs one writer at a time.
   */
  WithSql: <E, R>(
    sql: Layer.Layer<SqlClient.SqlClient, E, R>,
  ): Layer.Layer<FocusedStorage, E | StorageError, R | GentPlatform | Crypto.Crypto> =>
    provideFocusedRepositories(StorageInitLive.pipe(Layer.provideMerge(sql))),
}
