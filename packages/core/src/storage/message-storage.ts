/**
 * MessageStorage — focused service for message CRUD.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

import { Predicate, Context, Effect, Layer, Option, Schema } from "effect"
import { Model } from "effect/unstable/schema"
import { MessageRole, type Message } from "../domain/message.js"
import { messagePartsSearchText } from "../domain/message-part-display.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient, SqlModel } from "effect/unstable/sql"
import {
  decodeMessageChunkRow,
  decodeStoredPromptPart,
  decodeStoredMessage,
  encodeStoredMessage,
  groupMessageChunkRows,
  toSqlNull,
} from "./sqlite/rows.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"
import { GentPlatform } from "../runtime/gent-platform.js"

class MessageTable extends Model.Class<MessageTable>("MessageTable")({
  id: Model.GeneratedByApp(MessageId),
  session_id: SessionId,
  branch_id: BranchId,
  kind: Schema.Literals(["regular", "interjection"]),
  role: MessageRole,
  created_at: Schema.Finite,
  turn_duration_ms: Schema.NullOr(Schema.Finite),
  metadata: Schema.NullOr(Schema.String),
}) {}

/**
 * Sanitize user input for safe FTS5 MATCH queries.
 * Removes special syntax chars and wraps each token in double quotes
 * so they're treated as literal terms (quoting neutralizes FTS5 operators).
 */
export const sanitizeFts5Query = (raw: string): string => {
  // Remove FTS5 special characters: *, ^, quotes, parentheses, colons, plus, minus, braces
  const cleaned = raw.replace(/[*^"'(){}:+-]/g, " ")
  return cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" ")
}

interface MessageSearchResult {
  readonly sessionId: string
  // oxlint-disable-next-line effect/noNullish -- This storage result mirrors a nullable SQL session name.
  readonly sessionName: string | null
  readonly branchId: string
  readonly snippet: string
  readonly createdAt: number
}

interface MessageSearchOptions {
  readonly sessionId?: string
  readonly dateAfter?: number
  readonly dateBefore?: number
  readonly limit?: number
}

interface MessageStorageService {
  readonly createMessage: (message: Message) => Effect.Effect<Message, StorageError>
  readonly createMessageIfAbsent: (message: Message) => Effect.Effect<Message, StorageError>
  // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
  readonly getMessage: (id: MessageId) => Effect.Effect<Message | undefined, StorageError>
  readonly listMessages: (branchId: BranchId) => Effect.Effect<ReadonlyArray<Message>, StorageError>
  /** Full-text search over the workspace's messages; the same store writes the index. */
  readonly searchMessages: (
    query: string,
    options?: MessageSearchOptions,
  ) => Effect.Effect<ReadonlyArray<MessageSearchResult>, StorageError>
  readonly updateMessageTurnDuration: (
    messageId: MessageId,
    durationMs: number,
  ) => Effect.Effect<void, StorageError>
}

export class MessageStorage extends Context.Service<MessageStorage, MessageStorageService>()(
  "@gent/core/src/storage/message-storage/MessageStorage",
) {
  static Live: Layer.Layer<MessageStorage, never, SqlClient.SqlClient | GentPlatform> =
    Layer.effect(
      MessageStorage,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const platform = yield* GentPlatform
        const messageRepository = yield* SqlModel.makeRepository(MessageTable, {
          tableName: "messages",
          spanPrefix: "MessageStorage",
          idColumn: "id",
        })
        const mapError = (message: string) => (cause: unknown) =>
          new StorageError({ message, cause })
        const insertContent = Effect.fn("MessageStorage.insertContent")(function* (
          messageId: MessageId,
          partJsons: ReadonlyArray<string>,
        ) {
          yield* sql`DELETE FROM message_chunks WHERE message_id = ${messageId}`
          yield* Effect.forEach(
            partJsons,
            (partJson, ordinal) =>
              Effect.gen(function* () {
                const chunkId = platform.hash("sha256", partJson)
                const part = yield* decodeStoredPromptPart(partJson)
                yield* sql`INSERT OR IGNORE INTO content_chunks (id, part_type, part_json) VALUES (${chunkId}, ${part.type}, ${partJson})`
                yield* sql`INSERT INTO message_chunks (message_id, ordinal, chunk_id) VALUES (${messageId}, ${ordinal}, ${chunkId})`
              }),
            { discard: true },
          )
          yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
        })
        const indexSearch = (
          message: Pick<Message, "id" | "sessionId" | "branchId" | "role" | "parts">,
        ) =>
          Effect.gen(function* () {
            yield* sql`DELETE FROM messages_fts WHERE message_id = ${message.id}`
            yield* sql`INSERT INTO messages_fts(content, message_id, session_id, branch_id, role) VALUES (${messagePartsSearchText(message.parts)}, ${message.id}, ${message.sessionId}, ${message.branchId}, ${message.role})`
          })
        const ensureMessageWorkspace = Effect.fn("MessageStorage.ensureMessageWorkspace")(
          function* (message: Pick<Message, "sessionId" | "branchId">) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<{ id: BranchId }>`SELECT b.id
            FROM branches b
            JOIN sessions s ON s.id = b.session_id
            WHERE b.id = ${message.branchId}
              AND b.session_id = ${message.sessionId}
              AND s.workspace_id = ${workspaceId}`
            if (rows.length === 0) {
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
                yield* messageRepository.insertVoid({
                  id: message.id,
                  session_id: message.sessionId,
                  branch_id: message.branchId,
                  kind: message._tag,
                  role: message.role,
                  created_at: message.createdAt.getTime(),
                  turn_duration_ms: toSqlNull(message.turnDurationMs),
                  metadata: metadataJson,
                })
                yield* insertContent(message.id, partJsons)
                yield* indexSearch(message)
                yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId} AND workspace_id = ${yield* CurrentWorkspaceId}`
              }).pipe(sql.withTransaction)
              return message
            },
            Effect.mapError(mapError("Failed to create message")),
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
                  yield* insertContent(message.id, partJsons)
                  yield* indexSearch(message)
                  yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId} AND workspace_id = ${yield* CurrentWorkspaceId}`
                }
              }).pipe(sql.withTransaction)
              return message
            },
            Effect.mapError(mapError("Failed to create message if absent")),
          ),

          getMessage: Effect.fn("MessageStorage.getMessage")(
            function* (id) {
              const workspaceId = yield* CurrentWorkspaceId
              const rawRows = yield* sql`SELECT
              m.id,
              m.session_id,
              m.branch_id,
              m.kind,
              m.role,
              m.created_at,
              m.turn_duration_ms,
              m.metadata,
              mc.ordinal as chunk_ordinal,
              c.part_json as chunk_part_json
            FROM messages m
            LEFT JOIN message_chunks mc ON mc.message_id = m.id
            LEFT JOIN content_chunks c ON c.id = mc.chunk_id
            JOIN sessions s ON s.id = m.session_id
            WHERE m.id = ${id} AND s.workspace_id = ${workspaceId}
            ORDER BY mc.ordinal ASC`
              const rows = yield* Effect.forEach(rawRows, (row) => decodeMessageChunkRow(row))
              const grouped = groupMessageChunkRows(rows)
              const entry = grouped[0]
              // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
              if (Predicate.isUndefined(entry)) return undefined
              return yield* decodeStoredMessage(entry.row, entry.partJsons)
            },
            Effect.mapError(mapError("Failed to get message")),
          ),

          searchMessages: Effect.fn("MessageStorage.searchMessages")(
            function* (query, options) {
              const limit = Option.getOrElse(Option.fromUndefinedOr(options?.limit), () => 20)
              const ftsQuery = sanitizeFts5Query(query)
              if (ftsQuery.length === 0) return []
              const workspaceId = yield* CurrentWorkspaceId
              const conditions = [sql`s.workspace_id = ${workspaceId}`]
              if (!Predicate.isUndefined(options?.sessionId)) {
                conditions.push(sql`m.session_id = ${options.sessionId}`)
              }
              if (!Predicate.isUndefined(options?.dateAfter)) {
                conditions.push(sql`m.created_at > ${options.dateAfter}`)
              }
              if (!Predicate.isUndefined(options?.dateBefore)) {
                conditions.push(sql`m.created_at < ${options.dateBefore}`)
              }
              const rows = yield* sql<{
                session_id: string
                // oxlint-disable-next-line effect/noNullish -- Raw SQL rows preserve the database NULL representation.
                session_name: string | null
                branch_id: string
                snippet_text: string
                created_at: number
              }>`SELECT
                  m.session_id,
                  s.name as session_name,
                  m.branch_id,
                  snippet(messages_fts, 0, '>>>', '<<<', '...', 40) as snippet_text,
                  m.created_at
                FROM messages_fts fts
                JOIN messages m ON m.id = fts.message_id
                JOIN sessions s ON s.id = m.session_id
                WHERE messages_fts MATCH ${ftsQuery}
                  AND ${sql.and(conditions)}
                ORDER BY m.created_at DESC
                LIMIT ${limit}`
              return rows.map((row) => ({
                sessionId: row.session_id,
                sessionName: row.session_name,
                branchId: row.branch_id,
                snippet: row.snippet_text,
                createdAt: row.created_at,
              }))
            },
            Effect.mapError(mapError("Failed to search messages")),
          ),

          listMessages: Effect.fn("MessageStorage.listMessages")(
            function* (branchId) {
              const workspaceId = yield* CurrentWorkspaceId
              const rawRows = yield* sql`SELECT
              m.id,
              m.session_id,
              m.branch_id,
              m.kind,
              m.role,
              m.created_at,
              m.turn_duration_ms,
              m.metadata,
              mc.ordinal as chunk_ordinal,
              c.part_json as chunk_part_json
            FROM messages m
            LEFT JOIN message_chunks mc ON mc.message_id = m.id
            LEFT JOIN content_chunks c ON c.id = mc.chunk_id
            JOIN sessions s ON s.id = m.session_id
            WHERE m.branch_id = ${branchId} AND s.workspace_id = ${workspaceId}
            ORDER BY m.created_at ASC, m.insertion_order ASC, mc.ordinal ASC`
              const rows = yield* Effect.forEach(rawRows, (row) => decodeMessageChunkRow(row))
              return yield* Effect.forEach(groupMessageChunkRows(rows), ({ row, partJsons }) =>
                decodeStoredMessage(row, partJsons),
              )
            },
            Effect.mapError(mapError("Failed to list messages")),
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
            Effect.mapError(mapError("Failed to update message turn duration")),
          ),
        } satisfies MessageStorageService
      }),
    )
}
