import { Context, Effect, Layer, Schema, ParseResult } from "effect"
import {
  Message,
  Session,
  Branch,
  Compaction,
  MessagePart,
} from "@gent/core"

import { Database } from "bun:sqlite"

// Schema decoder for MessagePart array
const decodeMessageParts = Schema.decodeUnknownSync(Schema.Array(MessagePart))

// Storage Error

export class StorageError extends Schema.TaggedError<StorageError>()(
  "StorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

// Storage Service Interface

export interface StorageService {
  // Sessions
  readonly createSession: (
    session: Session
  ) => Effect.Effect<Session, StorageError>
  readonly getSession: (
    id: string
  ) => Effect.Effect<Session | undefined, StorageError>
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<Session>,
    StorageError
  >
  readonly updateSession: (
    session: Session
  ) => Effect.Effect<Session, StorageError>
  readonly deleteSession: (id: string) => Effect.Effect<void, StorageError>

  // Branches
  readonly createBranch: (branch: Branch) => Effect.Effect<Branch, StorageError>
  readonly getBranch: (
    id: string
  ) => Effect.Effect<Branch | undefined, StorageError>
  readonly listBranches: (
    sessionId: string
  ) => Effect.Effect<ReadonlyArray<Branch>, StorageError>

  // Messages
  readonly createMessage: (
    message: Message
  ) => Effect.Effect<Message, StorageError>
  readonly getMessage: (
    id: string
  ) => Effect.Effect<Message | undefined, StorageError>
  readonly listMessages: (
    branchId: string
  ) => Effect.Effect<ReadonlyArray<Message>, StorageError>
  readonly deleteMessages: (
    branchId: string,
    afterMessageId?: string
  ) => Effect.Effect<void, StorageError>

  // Compactions
  readonly createCompaction: (
    compaction: Compaction
  ) => Effect.Effect<Compaction, StorageError>
  readonly getLatestCompaction: (
    branchId: string
  ) => Effect.Effect<Compaction | undefined, StorageError>
}

export class Storage extends Context.Tag("Storage")<Storage, StorageService>() {
  static Live = (dbPath: string): Layer.Layer<Storage> =>
    Layer.scoped(
      Storage,
      Effect.gen(function* () {
        const db = new Database(dbPath)

        // Initialize schema
        db.run(`
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            name TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)

        db.run(`
          CREATE TABLE IF NOT EXISTS branches (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            parent_branch_id TEXT,
            parent_message_id TEXT,
            name TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          )
        `)

        db.run(`
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            role TEXT NOT NULL,
            parts TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
          )
        `)

        db.run(`
          CREATE TABLE IF NOT EXISTS compactions (
            id TEXT PRIMARY KEY,
            branch_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            token_count INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
          )
        `)

        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branch_id)`)
        db.run(`CREATE INDEX IF NOT EXISTS idx_branches_session ON branches(session_id)`)
        db.run(`CREATE INDEX IF NOT EXISTS idx_compactions_branch ON compactions(branch_id)`)

        // Cleanup on scope close
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => db.close())
        )

        const service: StorageService = {
          // Sessions
          createSession: (session) =>
            Effect.try({
              try: () => {
                db.run(
                  `INSERT INTO sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
                  [
                    session.id,
                    session.name ?? null,
                    session.createdAt.getTime(),
                    session.updatedAt.getTime(),
                  ]
                )
                return session
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to create session",
                  cause: e,
                }),
            }),

          getSession: (id) =>
            Effect.try({
              try: () => {
                const row = db
                  .query(
                    `SELECT id, name, created_at, updated_at FROM sessions WHERE id = ?`
                  )
                  .get(id) as
                  | {
                      id: string
                      name: string | null
                      created_at: number
                      updated_at: number
                    }
                  | null
                if (!row) return undefined
                return new Session({
                  id: row.id,
                  name: row.name ?? undefined,
                  createdAt: new Date(row.created_at),
                  updatedAt: new Date(row.updated_at),
                })
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to get session",
                  cause: e,
                }),
            }),

          listSessions: () =>
            Effect.try({
              try: () => {
                const rows = db
                  .query(
                    `SELECT id, name, created_at, updated_at FROM sessions ORDER BY updated_at DESC`
                  )
                  .all() as Array<{
                  id: string
                  name: string | null
                  created_at: number
                  updated_at: number
                }>
                return rows.map(
                  (row) =>
                    new Session({
                      id: row.id,
                      name: row.name ?? undefined,
                      createdAt: new Date(row.created_at),
                      updatedAt: new Date(row.updated_at),
                    })
                )
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to list sessions",
                  cause: e,
                }),
            }),

          updateSession: (session) =>
            Effect.try({
              try: () => {
                db.run(
                  `UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?`,
                  [
                    session.name ?? null,
                    session.updatedAt.getTime(),
                    session.id,
                  ]
                )
                return session
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to update session",
                  cause: e,
                }),
            }),

          deleteSession: (id) =>
            Effect.try({
              try: () => {
                db.run(`DELETE FROM sessions WHERE id = ?`, [id])
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to delete session",
                  cause: e,
                }),
            }),

          // Branches
          createBranch: (branch) =>
            Effect.try({
              try: () => {
                db.run(
                  `INSERT INTO branches (id, session_id, parent_branch_id, parent_message_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                  [
                    branch.id,
                    branch.sessionId,
                    branch.parentBranchId ?? null,
                    branch.parentMessageId ?? null,
                    branch.name ?? null,
                    branch.createdAt.getTime(),
                  ]
                )
                return branch
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to create branch",
                  cause: e,
                }),
            }),

          getBranch: (id) =>
            Effect.try({
              try: () => {
                const row = db
                  .query(
                    `SELECT id, session_id, parent_branch_id, parent_message_id, name, created_at FROM branches WHERE id = ?`
                  )
                  .get(id) as
                  | {
                      id: string
                      session_id: string
                      parent_branch_id: string | null
                      parent_message_id: string | null
                      name: string | null
                      created_at: number
                    }
                  | null
                if (!row) return undefined
                return new Branch({
                  id: row.id,
                  sessionId: row.session_id,
                  parentBranchId: row.parent_branch_id ?? undefined,
                  parentMessageId: row.parent_message_id ?? undefined,
                  name: row.name ?? undefined,
                  createdAt: new Date(row.created_at),
                })
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to get branch",
                  cause: e,
                }),
            }),

          listBranches: (sessionId) =>
            Effect.try({
              try: () => {
                const rows = db
                  .query(
                    `SELECT id, session_id, parent_branch_id, parent_message_id, name, created_at FROM branches WHERE session_id = ? ORDER BY created_at ASC`
                  )
                  .all(sessionId) as Array<{
                  id: string
                  session_id: string
                  parent_branch_id: string | null
                  parent_message_id: string | null
                  name: string | null
                  created_at: number
                }>
                return rows.map(
                  (row) =>
                    new Branch({
                      id: row.id,
                      sessionId: row.session_id,
                      parentBranchId: row.parent_branch_id ?? undefined,
                      parentMessageId: row.parent_message_id ?? undefined,
                      name: row.name ?? undefined,
                      createdAt: new Date(row.created_at),
                    })
                )
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to list branches",
                  cause: e,
                }),
            }),

          // Messages
          createMessage: (message) =>
            Effect.try({
              try: () => {
                db.run(
                  `INSERT INTO messages (id, session_id, branch_id, role, parts, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                  [
                    message.id,
                    message.sessionId,
                    message.branchId,
                    message.role,
                    JSON.stringify(message.parts),
                    message.createdAt.getTime(),
                  ]
                )
                return message
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to create message",
                  cause: e,
                }),
            }),

          getMessage: (id) =>
            Effect.try({
              try: () => {
                const row = db
                  .query(
                    `SELECT id, session_id, branch_id, role, parts, created_at FROM messages WHERE id = ?`
                  )
                  .get(id) as
                  | {
                      id: string
                      session_id: string
                      branch_id: string
                      role: "user" | "assistant" | "system"
                      parts: string
                      created_at: number
                    }
                  | null
                if (!row) return undefined
                const parts = decodeMessageParts(JSON.parse(row.parts))
                return new Message({
                  id: row.id,
                  sessionId: row.session_id,
                  branchId: row.branch_id,
                  role: row.role,
                  parts,
                  createdAt: new Date(row.created_at),
                })
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to get message",
                  cause: e,
                }),
            }),

          listMessages: (branchId) =>
            Effect.try({
              try: () => {
                const rows = db
                  .query(
                    `SELECT id, session_id, branch_id, role, parts, created_at FROM messages WHERE branch_id = ? ORDER BY created_at ASC`
                  )
                  .all(branchId) as Array<{
                  id: string
                  session_id: string
                  branch_id: string
                  role: "user" | "assistant" | "system"
                  parts: string
                  created_at: number
                }>
                return rows.map((row) => {
                  const parts = decodeMessageParts(JSON.parse(row.parts))
                  return new Message({
                    id: row.id,
                    sessionId: row.session_id,
                    branchId: row.branch_id,
                    role: row.role,
                    parts,
                    createdAt: new Date(row.created_at),
                  })
                })
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to list messages",
                  cause: e,
                }),
            }),

          deleteMessages: (branchId, afterMessageId) =>
            Effect.try({
              try: () => {
                if (afterMessageId) {
                  const msg = db
                    .query(`SELECT created_at FROM messages WHERE id = ?`)
                    .get(afterMessageId) as { created_at: number } | null
                  if (msg) {
                    db.run(
                      `DELETE FROM messages WHERE branch_id = ? AND created_at > ?`,
                      [branchId, msg.created_at]
                    )
                  }
                } else {
                  db.run(`DELETE FROM messages WHERE branch_id = ?`, [branchId])
                }
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to delete messages",
                  cause: e,
                }),
            }),

          // Compactions
          createCompaction: (compaction) =>
            Effect.try({
              try: () => {
                db.run(
                  `INSERT INTO compactions (id, branch_id, summary, message_count, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                  [
                    compaction.id,
                    compaction.branchId,
                    compaction.summary,
                    compaction.messageCount,
                    compaction.tokenCount,
                    compaction.createdAt.getTime(),
                  ]
                )
                return compaction
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to create compaction",
                  cause: e,
                }),
            }),

          getLatestCompaction: (branchId) =>
            Effect.try({
              try: () => {
                const row = db
                  .query(
                    `SELECT id, branch_id, summary, message_count, token_count, created_at FROM compactions WHERE branch_id = ? ORDER BY created_at DESC LIMIT 1`
                  )
                  .get(branchId) as
                  | {
                      id: string
                      branch_id: string
                      summary: string
                      message_count: number
                      token_count: number
                      created_at: number
                    }
                  | null
                if (!row) return undefined
                return new Compaction({
                  id: row.id,
                  branchId: row.branch_id,
                  summary: row.summary,
                  messageCount: row.message_count,
                  tokenCount: row.token_count,
                  createdAt: new Date(row.created_at),
                })
              },
              catch: (e) =>
                new StorageError({
                  message: "Failed to get latest compaction",
                  cause: e,
                }),
            }),
        }

        return service
      })
    )

  static Test = (): Layer.Layer<Storage> => Storage.Live(":memory:")
}
