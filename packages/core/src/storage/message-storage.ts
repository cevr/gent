/**
 * MessageStorage — focused service for message CRUD.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

import { Context, Effect, Layer, Schema } from "effect"
import { Model } from "effect/unstable/schema"
import { MessageRole, type Message } from "../domain/message.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient, SqlModel } from "effect/unstable/sql"
import {
  decodeStoredMessage,
  encodeStoredMessage,
  groupMessageChunkRows,
  indexMessageSearch,
  insertMessageContent,
  type MessageChunkRow,
} from "./sqlite/rows.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

class MessageTable extends Model.Class<MessageTable>("MessageTable")({
  id: Model.GeneratedByApp(MessageId),
  session_id: SessionId,
  branch_id: BranchId,
  kind: Schema.Literals(["regular", "interjection"]),
  role: MessageRole,
  created_at: Schema.Number,
  turn_duration_ms: Schema.NullOr(Schema.Number),
  metadata: Schema.NullOr(Schema.String),
}) {}

export interface MessageStorageService {
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
}

export class MessageStorage extends Context.Service<MessageStorage, MessageStorageService>()(
  "@gent/core/src/storage/message-storage/MessageStorage",
) {
  static Live: Layer.Layer<MessageStorage, never, SqlClient.SqlClient> = Layer.effect(
    MessageStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const messageRepository = yield* SqlModel.makeRepository(MessageTable, {
        tableName: "messages",
        spanPrefix: "MessageStorage",
        idColumn: "id",
      })
      const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })
      const insertContent = (messageId: MessageId, partJsons: ReadonlyArray<string>) =>
        insertMessageContent(messageId, partJsons).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        )
      const indexSearch = (
        message: Pick<Message, "id" | "sessionId" | "branchId" | "role" | "parts">,
      ) => indexMessageSearch(message).pipe(Effect.provideService(SqlClient.SqlClient, sql))
      const ensureMessageWorkspace = Effect.fn("MessageStorage.ensureMessageWorkspace")(function* (
        message: Pick<Message, "sessionId" | "branchId">,
      ) {
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
      })

      return {
        createMessage: Effect.fn("MessageStorage.createMessage")(
          function* (message) {
            yield* ensureMessageWorkspace(message)
            const { partJsons, metadataJson } = yield* encodeStoredMessage(message)
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* messageRepository.insertVoid({
                  id: message.id,
                  session_id: message.sessionId,
                  branch_id: message.branchId,
                  kind: message._tag,
                  role: message.role,
                  created_at: message.createdAt.getTime(),
                  turn_duration_ms: message.turnDurationMs ?? null,
                  metadata: metadataJson,
                })
                yield* insertContent(message.id, partJsons)
                yield* indexSearch(message)
                yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId} AND workspace_id = ${yield* CurrentWorkspaceId}`
              }),
            )
            return message
          },
          Effect.mapError(mapError("Failed to create message")),
        ),

        createMessageIfAbsent: Effect.fn("MessageStorage.createMessageIfAbsent")(
          function* (message) {
            yield* ensureMessageWorkspace(message)
            const { partJsons, metadataJson } = yield* encodeStoredMessage(message)
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT OR IGNORE INTO messages (id, session_id, branch_id, kind, role, created_at, turn_duration_ms, metadata) VALUES (${message.id}, ${message.sessionId}, ${message.branchId}, ${message._tag}, ${message.role}, ${message.createdAt.getTime()}, ${message.turnDurationMs ?? null}, ${metadataJson})`
                const rows = yield* sql<{
                  changed: number
                }>`SELECT changes() as changed`
                if ((rows[0]?.changed ?? 0) > 0) {
                  yield* insertContent(message.id, partJsons)
                  yield* indexSearch(message)
                  yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId} AND workspace_id = ${yield* CurrentWorkspaceId}`
                }
              }),
            )
            return message
          },
          Effect.mapError(mapError("Failed to create message if absent")),
        ),

        getMessage: Effect.fn("MessageStorage.getMessage")(
          function* (id) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<MessageChunkRow>`SELECT
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
            const grouped = groupMessageChunkRows(rows)
            const entry = grouped[0]
            if (entry === undefined) return undefined
            return yield* decodeStoredMessage(entry.row, entry.partJsons)
          },
          Effect.mapError(mapError("Failed to get message")),
        ),

        listMessages: Effect.fn("MessageStorage.listMessages")(
          function* (branchId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<MessageChunkRow>`SELECT
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
            ORDER BY m.created_at ASC, m.id ASC, mc.ordinal ASC`
            return yield* Effect.forEach(groupMessageChunkRows(rows), ({ row, partJsons }) =>
              decodeStoredMessage(row, partJsons),
            )
          },
          Effect.mapError(mapError("Failed to list messages")),
        ),

        deleteMessages: Effect.fn("MessageStorage.deleteMessages")(
          function* (branchId, afterMessageId) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const messageIds: MessageId[] = []
                if (afterMessageId !== undefined) {
                  const msgs = yield* sql<{
                    id: MessageId
                    created_at: number
                  }>`SELECT m.id, m.created_at
                    FROM messages m
                    JOIN sessions s ON s.id = m.session_id
                    WHERE m.id = ${afterMessageId} AND s.workspace_id = ${workspaceId}`
                  const msg = msgs[0]
                  if (msg !== undefined) {
                    const rows = yield* sql<{
                      id: MessageId
                    }>`SELECT m.id
                      FROM messages m
                      JOIN sessions s ON s.id = m.session_id
                      WHERE m.branch_id = ${branchId}
                        AND s.workspace_id = ${workspaceId}
                        AND (m.created_at > ${msg.created_at} OR (m.created_at = ${msg.created_at} AND m.id > ${msg.id}))`
                    messageIds.push(...rows.map((row) => row.id))
                  }
                } else {
                  const rows = yield* sql<{
                    id: MessageId
                  }>`SELECT m.id
                    FROM messages m
                    JOIN sessions s ON s.id = m.session_id
                    WHERE m.branch_id = ${branchId} AND s.workspace_id = ${workspaceId}`
                  messageIds.push(...rows.map((row) => row.id))
                }
                if (messageIds.length === 0) return
                yield* sql`DELETE FROM messages_fts WHERE message_id IN ${sql.in(messageIds)}`
                yield* sql`DELETE FROM message_chunks WHERE message_id IN ${sql.in(messageIds)}`
                yield* sql`DELETE FROM messages WHERE id IN ${sql.in(messageIds)}`
                yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
              }),
            )
          },
          Effect.mapError(mapError("Failed to delete messages")),
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
