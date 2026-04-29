import { Clock, Effect } from "effect"
import type { Message } from "../../domain/message.js"
import { EventEnvelope, EventId, getEventBranchId, getEventSessionId } from "../../domain/event.js"
import type { BranchId, MessageId, SessionId } from "../../domain/ids.js"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { StorageError } from "../../domain/storage-error.js"
import type { StorageService } from "../sqlite-storage.js"
import { configureSqliteConnection } from "../schema.js"
import {
  decodeEvent,
  encodeEvent,
  encodeStoredMessage,
  expandEventTags,
  groupMessageChunkRows,
  insertMessageContent,
  indexMessageSearch,
  branchFromRow,
  decodeStoredMessage,
  sessionFromRow,
  type BranchRow,
  type EventRow,
  type MessageChunkRow,
  type SessionRow,
} from "./rows.js"

export const mapError = (message: string) => (e: unknown) => new StorageError({ message, cause: e })

export const makeStorageImpl: Effect.Effect<StorageService, StorageError, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // PRAGMA foreign_keys is connection-state, not stored in the DB blob.
    // Deserialized DBs come up with FKs OFF — re-enable on every connection.
    // Idempotent, cheap; runs before any user query.
    yield* Effect.orDie(configureSqliteConnection())
    const insertContent = (messageId: MessageId, partJsons: ReadonlyArray<string>) =>
      insertMessageContent(messageId, partJsons).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      )
    const indexSearch = (
      message: Pick<Message, "id" | "sessionId" | "branchId" | "role" | "parts">,
    ) => indexMessageSearch(message).pipe(Effect.provideService(SqlClient.SqlClient, sql))

    return {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        sql
          .withTransaction(effect)
          .pipe(
            Effect.catchIf(SqlError.isSqlError, (error) =>
              Effect.fail(
                new StorageError({ message: "Failed to run storage transaction", cause: error }),
              ),
            ),
          ),

      // Sessions
      createSession: Effect.fn("Storage.createSession")(
        function* (session) {
          if (session.parentBranchId !== undefined && session.parentSessionId === undefined) {
            return yield* new StorageError({
              message: "Cannot create session with parentBranchId without parentSessionId",
            })
          }
          if (session.parentBranchId !== undefined && session.parentSessionId !== undefined) {
            const parentRows = yield* sql<{
              id: BranchId
            }>`SELECT id FROM branches WHERE id = ${session.parentBranchId} AND session_id = ${session.parentSessionId}`
            if (parentRows.length === 0) {
              return yield* new StorageError({
                message: `Parent branch not found in parent session: ${session.parentBranchId}`,
              })
            }
          }
          yield* sql`INSERT INTO sessions (id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at) VALUES (${session.id}, ${session.name ?? null}, ${session.cwd ?? null}, ${session.reasoningLevel ?? null}, ${session.activeBranchId ?? null}, ${session.parentSessionId ?? null}, ${session.parentBranchId ?? null}, ${session.createdAt.getTime()}, ${session.updatedAt.getTime()})`
          return session
        },
        Effect.mapError(mapError("Failed to create session")),
      ),

      getSession: Effect.fn("Storage.getSession")(
        function* (id) {
          const rows =
            yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${id}`
          const row = rows[0]
          if (row === undefined) return undefined
          return sessionFromRow(row)
        },
        Effect.mapError(mapError("Failed to get session")),
      ),

      getLastSessionByCwd: Effect.fn("Storage.getLastSessionByCwd")(
        function* (cwd) {
          const rows =
            yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE cwd = ${cwd} ORDER BY updated_at DESC LIMIT 1`
          const row = rows[0]
          if (row === undefined) return undefined
          return sessionFromRow(row)
        },
        Effect.mapError(mapError("Failed to get last session by cwd")),
      ),

      listSessions: Effect.fn("Storage.listSessions")(
        function* () {
          const rows =
            yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC`
          return rows.map(sessionFromRow)
        },
        Effect.mapError(mapError("Failed to list sessions")),
      ),

      listFirstBranches: Effect.fn("Storage.listFirstBranches")(
        function* () {
          const rows = yield* sql<{
            session_id: SessionId
            branch_id: BranchId | null
          }>`SELECT s.id AS session_id, b.id AS branch_id
         FROM sessions s
         LEFT JOIN branches b
           ON b.session_id = s.id
           AND b.created_at = (
             SELECT MIN(created_at) FROM branches WHERE session_id = s.id
           )
         ORDER BY s.updated_at DESC`
          return rows.map((row) => ({
            sessionId: row.session_id,
            branchId: row.branch_id ?? undefined,
          }))
        },
        Effect.mapError(mapError("Failed to list first branches")),
      ),

      updateSession: Effect.fn("Storage.updateSession")(
        function* (session) {
          yield* sql`UPDATE sessions SET name = ${session.name ?? null}, reasoning_level = ${session.reasoningLevel ?? null}, active_branch_id = ${session.activeBranchId ?? null}, updated_at = ${session.updatedAt.getTime()} WHERE id = ${session.id}`
          return session
        },
        Effect.mapError(mapError("Failed to update session")),
      ),

      deleteSession: (id) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              // SELECT + DELETE inside one tx keeps the descendant set consistent
              // with the durable cascade. A child created after the tx begins
              // violates the parent FK when it tries to commit, so either it's
              // in our SELECT or it never durably lands. Returning the set lets
              // the caller clean runtime state for exactly the same ids the DB
              // removed — no ghost loops / streams / cwd-registry entries.
              const descendantRows = yield* sql<{ id: SessionId }>`
              WITH RECURSIVE descendants(id) AS (
                SELECT id FROM sessions WHERE id = ${id}
                UNION
                SELECT sessions.id
                FROM sessions
                JOIN descendants ON sessions.parent_session_id = descendants.id
              )
              SELECT id FROM descendants
            `
              const cascadedIds = descendantRows.map((row) => row.id)
              if (cascadedIds.length === 0) return cascadedIds
              yield* sql`DELETE FROM messages_fts WHERE session_id IN ${sql.in(cascadedIds)}`
              yield* sql`DELETE FROM sessions WHERE id IN ${sql.in(cascadedIds)}`
              yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
              return cascadedIds
            }),
          )
          .pipe(
            Effect.mapError(mapError("Failed to delete session")),
            Effect.withSpan("Storage.deleteSession"),
          ),

      // Branches
      createBranch: Effect.fn("Storage.createBranch")(
        function* (branch) {
          if (branch.parentBranchId !== undefined) {
            const parentRows = yield* sql<{
              id: BranchId
            }>`SELECT id FROM branches WHERE id = ${branch.parentBranchId} AND session_id = ${branch.sessionId}`
            if (parentRows.length === 0) {
              return yield* new StorageError({
                message: `Parent branch not found in session: ${branch.parentBranchId}`,
              })
            }
          }
          yield* sql`INSERT INTO branches (id, session_id, parent_branch_id, parent_message_id, name, summary, created_at) VALUES (${branch.id}, ${branch.sessionId}, ${branch.parentBranchId ?? null}, ${branch.parentMessageId ?? null}, ${branch.name ?? null}, ${branch.summary ?? null}, ${branch.createdAt.getTime()})`
          return branch
        },
        Effect.mapError(mapError("Failed to create branch")),
      ),

      getBranch: Effect.fn("Storage.getBranch")(
        function* (id) {
          const rows =
            yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE id = ${id}`
          const row = rows[0]
          if (row === undefined) return undefined
          return branchFromRow(row)
        },
        Effect.mapError(mapError("Failed to get branch")),
      ),

      listBranches: Effect.fn("Storage.listBranches")(
        function* (sessionId) {
          const rows =
            yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE session_id = ${sessionId} ORDER BY created_at ASC`
          return rows.map(branchFromRow)
        },
        Effect.mapError(mapError("Failed to list branches")),
      ),

      updateBranchSummary: (branchId, summary) =>
        sql`UPDATE branches SET summary = ${summary} WHERE id = ${branchId}`.pipe(
          Effect.asVoid,
          Effect.mapError(mapError("Failed to update branch summary")),
          Effect.withSpan("Storage.updateBranchSummary"),
        ),

      deleteBranch: Effect.fn("Storage.deleteBranch")(
        function* (id) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const childBranches = yield* sql<{
                count: number
              }>`SELECT COUNT(*) as count FROM branches WHERE parent_branch_id = ${id}`
              if ((childBranches[0]?.count ?? 0) > 0) {
                return yield* new StorageError({
                  message: `Cannot delete branch with child branches: ${id}`,
                })
              }

              const childSessions = yield* sql<{
                count: number
              }>`SELECT COUNT(*) as count FROM sessions WHERE parent_branch_id = ${id}`
              if ((childSessions[0]?.count ?? 0) > 0) {
                return yield* new StorageError({
                  message: `Cannot delete branch with child sessions: ${id}`,
                })
              }

              const messageRows = yield* sql<{
                id: MessageId
              }>`SELECT id FROM messages WHERE branch_id = ${id}`
              const messageIds = messageRows.map((row) => row.id)
              if (messageIds.length > 0) {
                yield* sql`DELETE FROM messages_fts WHERE message_id IN ${sql.in(messageIds)}`
              }
              yield* sql`DELETE FROM branches WHERE id = ${id}`
              yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
            }),
          )
        },
        Effect.mapError(mapError("Failed to delete branch")),
      ),

      countMessages: Effect.fn("Storage.countMessages")(
        function* (branchId) {
          const rows = yield* sql<{
            count: number
          }>`SELECT COUNT(*) as count FROM messages WHERE branch_id = ${branchId}`
          return rows[0]?.count ?? 0
        },
        Effect.mapError(mapError("Failed to count messages")),
      ),

      countMessagesByBranches: Effect.fn("Storage.countMessagesByBranches")(
        function* (branchIds) {
          if (branchIds.length === 0) return new Map<BranchId, number>()
          const rows = yield* sql<{
            branch_id: BranchId
            count: number
          }>`SELECT branch_id, COUNT(*) as count FROM messages WHERE branch_id IN ${sql.in(branchIds)} GROUP BY branch_id`
          const result = new Map<BranchId, number>()
          for (const row of rows) {
            result.set(row.branch_id, row.count)
          }
          return result
        },
        Effect.mapError(mapError("Failed to count messages by branches")),
      ),

      // Messages
      createMessage: Effect.fn("Storage.createMessage")(
        function* (message) {
          const { legacyPartsJson, partJsons, metadataJson } = yield* encodeStoredMessage(message)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata) VALUES (${message.id}, ${message.sessionId}, ${message.branchId}, ${message._tag}, ${message.role}, ${legacyPartsJson}, ${message.createdAt.getTime()}, ${message.turnDurationMs ?? null}, ${metadataJson})`
              yield* insertContent(message.id, partJsons)
              yield* indexSearch(message)
              yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId}`
            }),
          )
          return message
        },
        Effect.mapError(mapError("Failed to create message")),
      ),

      createMessageIfAbsent: Effect.fn("Storage.createMessageIfAbsent")(
        function* (message) {
          const { legacyPartsJson, partJsons, metadataJson } = yield* encodeStoredMessage(message)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT OR IGNORE INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata) VALUES (${message.id}, ${message.sessionId}, ${message.branchId}, ${message._tag}, ${message.role}, ${legacyPartsJson}, ${message.createdAt.getTime()}, ${message.turnDurationMs ?? null}, ${metadataJson})`
              const rows = yield* sql<{
                changed: number
              }>`SELECT changes() as changed`
              if ((rows[0]?.changed ?? 0) > 0) {
                yield* insertContent(message.id, partJsons)
                yield* indexSearch(message)
                yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId}`
              }
            }),
          )
          return message
        },
        Effect.mapError(mapError("Failed to create message if absent")),
      ),

      getMessage: Effect.fn("Storage.getMessage")(
        function* (id) {
          const rows = yield* sql<MessageChunkRow>`SELECT
            m.id,
            m.session_id,
            m.branch_id,
            m.kind,
            m.role,
            m.parts,
            m.created_at,
            m.turn_duration_ms,
            m.metadata,
            mc.ordinal as chunk_ordinal,
            c.part_json as chunk_part_json
          FROM messages m
          LEFT JOIN message_chunks mc ON mc.message_id = m.id
          LEFT JOIN content_chunks c ON c.id = mc.chunk_id
          WHERE m.id = ${id}
          ORDER BY mc.ordinal ASC`
          const grouped = groupMessageChunkRows(rows)
          const entry = grouped[0]
          if (entry === undefined) return undefined
          return yield* decodeStoredMessage(entry.row, entry.partJsons)
        },
        Effect.mapError(mapError("Failed to get message")),
      ),

      listMessages: Effect.fn("Storage.listMessages")(
        function* (branchId) {
          const rows = yield* sql<MessageChunkRow>`SELECT
            m.id,
            m.session_id,
            m.branch_id,
            m.kind,
            m.role,
            m.parts,
            m.created_at,
            m.turn_duration_ms,
            m.metadata,
            mc.ordinal as chunk_ordinal,
            c.part_json as chunk_part_json
          FROM messages m
          LEFT JOIN message_chunks mc ON mc.message_id = m.id
          LEFT JOIN content_chunks c ON c.id = mc.chunk_id
          WHERE m.branch_id = ${branchId}
          ORDER BY m.created_at ASC, m.id ASC, mc.ordinal ASC`
          return yield* Effect.forEach(groupMessageChunkRows(rows), ({ row, partJsons }) =>
            decodeStoredMessage(row, partJsons),
          )
        },
        Effect.mapError(mapError("Failed to list messages")),
      ),

      deleteMessages: Effect.fn("Storage.deleteMessages")(
        function* (branchId, afterMessageId) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const messageIds: MessageId[] = []
              if (afterMessageId !== undefined) {
                const msgs = yield* sql<{
                  id: MessageId
                  created_at: number
                }>`SELECT id, created_at FROM messages WHERE id = ${afterMessageId}`
                const msg = msgs[0]
                if (msg !== undefined) {
                  const rows = yield* sql<{
                    id: MessageId
                  }>`SELECT id FROM messages WHERE branch_id = ${branchId} AND (created_at > ${msg.created_at} OR (created_at = ${msg.created_at} AND id > ${msg.id}))`
                  messageIds.push(...rows.map((row) => row.id))
                }
              } else {
                const rows = yield* sql<{
                  id: MessageId
                }>`SELECT id FROM messages WHERE branch_id = ${branchId}`
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

      updateMessageTurnDuration: (messageId, durationMs) =>
        sql`UPDATE messages SET turn_duration_ms = ${durationMs} WHERE id = ${messageId}`.pipe(
          Effect.asVoid,
          Effect.mapError(mapError("Failed to update message turn duration")),
          Effect.withSpan("Storage.updateMessageTurnDuration"),
        ),

      // Events
      appendEvent: Effect.fn("Storage.appendEvent")(
        function* (event, options) {
          const sessionId = getEventSessionId(event)
          if (sessionId === undefined) {
            return yield* new StorageError({ message: "Event missing sessionId" })
          }
          const branchId = getEventBranchId(event)
          const createdAt = yield* Clock.currentTimeMillis
          const traceId = options?.traceId
          const eventJson = yield* encodeEvent(event)
          const id = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at, trace_id) VALUES (${sessionId}, ${branchId ?? null}, ${event._tag}, ${eventJson}, ${createdAt}, ${traceId ?? null})`
              const rows = yield* sql<{ id: number }>`SELECT last_insert_rowid() as id`
              return rows[0]?.id ?? 0
            }),
          )
          return EventEnvelope.make({
            id: EventId.make(id),
            event,
            createdAt,
            ...(traceId !== undefined ? { traceId } : {}),
          })
        },
        Effect.mapError(mapError("Failed to append event")),
      ),
      listEvents: Effect.fn("Storage.listEvents")(
        function* ({ sessionId, branchId, afterId }) {
          const sinceId = afterId ?? 0
          const rows =
            branchId !== undefined
              ? yield* sql<EventRow>`SELECT id, event_json, created_at, trace_id FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) AND id > ${sinceId} ORDER BY id ASC`
              : yield* sql<EventRow>`SELECT id, event_json, created_at, trace_id FROM events WHERE session_id = ${sessionId} AND id > ${sinceId} ORDER BY id ASC`
          const envelopes: EventEnvelope[] = []
          for (const row of rows) {
            const decoded = yield* decodeEvent(row.event_json).pipe(Effect.option)
            if (decoded._tag === "Some") {
              envelopes.push(
                EventEnvelope.make({
                  id: EventId.make(row.id),
                  event: decoded.value,
                  createdAt: row.created_at,
                  ...(row.trace_id !== null ? { traceId: row.trace_id } : {}),
                }),
              )
            }
          }
          return envelopes
        },
        Effect.mapError(mapError("Failed to list events")),
      ),

      getLatestEventId: Effect.fn("Storage.getLatestEventId")(
        function* ({ sessionId, branchId }) {
          const rows =
            branchId !== undefined
              ? yield* sql<{
                  id: number
                }>`SELECT id FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) ORDER BY id DESC LIMIT 1`
              : yield* sql<{
                  id: number
                }>`SELECT id FROM events WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1`
          return rows[0]?.id
        },
        Effect.mapError(mapError("Failed to get latest event id")),
      ),

      getLatestEventTag: Effect.fn("Storage.getLatestEventTag")(
        function* ({ sessionId, branchId, tags }) {
          if (tags.length === 0) return undefined
          const expandedTags = expandEventTags(tags)
          const rows = yield* sql<{
            event_tag: string
          }>`SELECT event_tag FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) AND event_tag IN ${sql.in(expandedTags)} ORDER BY id DESC LIMIT 1`
          const eventTag = rows[0]?.event_tag
          switch (eventTag) {
            case "SubagentSpawned":
              return "AgentRunSpawned"
            case "SubagentSucceeded":
              return "AgentRunSucceeded"
            case "SubagentFailed":
              return "AgentRunFailed"
            default:
              return eventTag
          }
        },
        Effect.mapError(mapError("Failed to get latest event tag")),
      ),

      getLatestEvent: Effect.fn("Storage.getLatestEvent")(
        function* ({ sessionId, branchId, tags }) {
          if (tags.length === 0) return undefined
          const expandedTags = expandEventTags(tags)
          const rows = yield* sql<{
            event_json: string
          }>`SELECT event_json FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) AND event_tag IN ${sql.in(expandedTags)} ORDER BY id DESC LIMIT 1`
          const row = rows[0]
          if (row === undefined) return undefined
          const decoded = yield* decodeEvent(row.event_json).pipe(Effect.option)
          return decoded._tag === "Some" ? decoded.value : undefined
        },
        Effect.mapError(mapError("Failed to get latest event")),
      ),

      // Session tree

      getChildSessions: Effect.fn("Storage.getChildSessions")(
        function* (parentSessionId) {
          const rows =
            yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE parent_session_id = ${parentSessionId} ORDER BY created_at ASC`
          return rows.map(sessionFromRow)
        },
        Effect.mapError(mapError("Failed to get child sessions")),
      ),

      getSessionAncestors: Effect.fn("Storage.getSessionAncestors")(
        function* (sessionId) {
          const rows =
            yield* sql<SessionRow>`WITH RECURSIVE ancestors(id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at, depth) AS (
          SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at, 0
          FROM sessions WHERE id = ${sessionId}
          UNION ALL
          SELECT s.id, s.name, s.cwd, s.reasoning_level, s.active_branch_id, s.parent_session_id, s.parent_branch_id, s.created_at, s.updated_at, a.depth + 1
          FROM sessions s
          JOIN ancestors a ON s.id = a.parent_session_id
          WHERE a.depth < 20
        )
        SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at
        FROM ancestors
        ORDER BY depth ASC`
          return rows.map(sessionFromRow)
        },
        Effect.mapError(mapError("Failed to get session ancestors")),
      ),

      getSessionDetail: Effect.fn("Storage.getSessionDetail")(
        function* (sessionId) {
          const sessionRows =
            yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${sessionId}`
          const sessionRow = sessionRows[0]
          if (sessionRow === undefined) {
            return yield* new StorageError({ message: `Session not found: ${sessionId}` })
          }
          const session = sessionFromRow(sessionRow)

          const branchRows =
            yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE session_id = ${sessionId} ORDER BY created_at ASC`
          const branches = branchRows.map(branchFromRow)

          if (branches.length === 0) {
            return { session, branches: [] }
          }

          const branchIds = branches.map((b) => b.id)
          const allMsgRows = yield* sql<MessageChunkRow>`SELECT
            m.id,
            m.session_id,
            m.branch_id,
            m.kind,
            m.role,
            m.parts,
            m.created_at,
            m.turn_duration_ms,
            m.metadata,
            mc.ordinal as chunk_ordinal,
            c.part_json as chunk_part_json
          FROM messages m
          LEFT JOIN message_chunks mc ON mc.message_id = m.id
          LEFT JOIN content_chunks c ON c.id = mc.chunk_id
          WHERE m.branch_id IN ${sql.in(branchIds)}
          ORDER BY m.created_at ASC, m.id ASC, mc.ordinal ASC`

          const rowsByBranch = new Map<BranchId, Array<MessageChunkRow>>()
          for (const branch of branches) rowsByBranch.set(branch.id, [])
          for (const row of allMsgRows) {
            const bucket = rowsByBranch.get(row.branch_id as BranchId)
            if (bucket !== undefined) bucket.push(row)
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
        Effect.mapError(mapError("Failed to get session detail")),
      ),

      saveActorState: Effect.fn("Storage.saveActorState")(
        function* (params: { profileId: string; persistenceKey: string; stateJson: string }) {
          const updatedAt = yield* Clock.currentTimeMillis
          yield* sql`INSERT OR REPLACE INTO actor_persistence (profile_id, persistence_key, state_json, updated_at) VALUES (${params.profileId}, ${params.persistenceKey}, ${params.stateJson}, ${updatedAt})`
        },
        Effect.mapError(mapError("Failed to save actor state")),
      ),

      loadActorState: Effect.fn("Storage.loadActorState")(
        function* (params: { profileId: string; persistenceKey: string }) {
          const rows = yield* sql<{
            state_json: string
            updated_at: number
          }>`SELECT state_json, updated_at FROM actor_persistence WHERE profile_id = ${params.profileId} AND persistence_key = ${params.persistenceKey}`
          const row = rows[0]
          if (row === undefined) return undefined
          return { stateJson: row.state_json, updatedAt: row.updated_at }
        },
        Effect.mapError(mapError("Failed to load actor state")),
      ),

      listActorStatesForProfile: Effect.fn("Storage.listActorStatesForProfile")(
        function* (profileId: string) {
          const rows = yield* sql<{
            profile_id: string
            persistence_key: string
            state_json: string
            updated_at: number
          }>`SELECT profile_id, persistence_key, state_json, updated_at FROM actor_persistence WHERE profile_id = ${profileId}`
          return rows.map((r) => ({
            profileId: r.profile_id,
            persistenceKey: r.persistence_key,
            stateJson: r.state_json,
            updatedAt: r.updated_at,
          }))
        },
        Effect.mapError(mapError("Failed to list actor states")),
      ),

      deleteActorStatesForProfile: Effect.fn("Storage.deleteActorStatesForProfile")(
        function* (profileId: string) {
          yield* sql`DELETE FROM actor_persistence WHERE profile_id = ${profileId}`
        },
        Effect.mapError(mapError("Failed to delete actor states")),
      ),
    } satisfies StorageService
  })
