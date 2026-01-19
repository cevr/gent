import { Context, Effect, Layer, Schema } from "effect"
import {
  Message,
  Session,
  Branch,
  Checkpoint,
  CompactionCheckpoint,
  PlanCheckpoint,
  MessagePart,
  TodoItem,
} from "@gent/core"
import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Database } from "bun:sqlite"

// Schema decoders
const decodeMessageParts = Schema.decodeUnknownSync(Schema.Array(MessagePart))
const decodeTodoItem = Schema.decodeUnknownSync(TodoItem)

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
  readonly getLastSessionByCwd: (
    cwd: string
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
  readonly updateMessageTurnDuration: (
    messageId: string,
    durationMs: number
  ) => Effect.Effect<void, StorageError>

  // Checkpoints
  readonly createCheckpoint: (
    checkpoint: Checkpoint
  ) => Effect.Effect<Checkpoint, StorageError>
  readonly getLatestCheckpoint: (
    branchId: string
  ) => Effect.Effect<Checkpoint | undefined, StorageError>
  readonly listMessagesAfter: (
    branchId: string,
    afterMessageId: string
  ) => Effect.Effect<ReadonlyArray<Message>, StorageError>
  readonly listMessagesSince: (
    branchId: string,
    sinceTimestamp: Date
  ) => Effect.Effect<ReadonlyArray<Message>, StorageError>

  // Todos
  readonly listTodos: (
    branchId: string
  ) => Effect.Effect<ReadonlyArray<TodoItem>, StorageError>
  readonly replaceTodos: (
    branchId: string,
    todos: ReadonlyArray<TodoItem>
  ) => Effect.Effect<void, StorageError>
}

const makeStorage = (db: Database): StorageService => {
  // Initialize schema
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      cwd TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Migration: add cwd column to existing sessions table
  try {
    db.run(`ALTER TABLE sessions ADD COLUMN cwd TEXT`)
  } catch {
    // Column already exists - ignore
  }

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
      turn_duration_ms INTEGER,
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      _tag TEXT NOT NULL,
      summary TEXT,
      plan_path TEXT,
      first_kept_message_id TEXT,
      message_count INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `)

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branch_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_branches_session ON branches(session_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_checkpoints_branch ON checkpoints(branch_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_todos_branch ON todos(branch_id)`)

  return {
    // Sessions
    createSession: (session) =>
      Effect.try({
        try: () => {
          db.run(
            `INSERT INTO sessions (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [
              session.id,
              session.name ?? null,
              session.cwd ?? null,
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
              `SELECT id, name, cwd, created_at, updated_at FROM sessions WHERE id = ?`
            )
            .get(id) as
            | {
                id: string
                name: string | null
                cwd: string | null
                created_at: number
                updated_at: number
              }
            | null
          if (!row) return undefined
          return new Session({
            id: row.id,
            name: row.name ?? undefined,
            cwd: row.cwd ?? undefined,
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

    getLastSessionByCwd: (cwd) =>
      Effect.try({
        try: () => {
          const row = db
            .query(
              `SELECT id, name, cwd, created_at, updated_at FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1`
            )
            .get(cwd) as
            | {
                id: string
                name: string | null
                cwd: string | null
                created_at: number
                updated_at: number
              }
            | null
          if (!row) return undefined
          return new Session({
            id: row.id,
            name: row.name ?? undefined,
            cwd: row.cwd ?? undefined,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
          })
        },
        catch: (e) =>
          new StorageError({
            message: "Failed to get last session by cwd",
            cause: e,
          }),
      }),

    listSessions: () =>
      Effect.try({
        try: () => {
          const rows = db
            .query(
              `SELECT id, name, cwd, created_at, updated_at FROM sessions ORDER BY updated_at DESC`
            )
            .all() as Array<{
            id: string
            name: string | null
            cwd: string | null
            created_at: number
            updated_at: number
          }>
          return rows.map(
            (row) =>
              new Session({
                id: row.id,
                name: row.name ?? undefined,
                cwd: row.cwd ?? undefined,
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
            `INSERT INTO messages (id, session_id, branch_id, role, parts, created_at, turn_duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              message.id,
              message.sessionId,
              message.branchId,
              message.role,
              JSON.stringify(message.parts),
              message.createdAt.getTime(),
              message.turnDurationMs ?? null,
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
              `SELECT id, session_id, branch_id, role, parts, created_at, turn_duration_ms FROM messages WHERE id = ?`
            )
            .get(id) as
            | {
                id: string
                session_id: string
                branch_id: string
                role: "user" | "assistant" | "system" | "tool"
                parts: string
                created_at: number
                turn_duration_ms: number | null
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
            turnDurationMs: row.turn_duration_ms ?? undefined,
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
              `SELECT id, session_id, branch_id, role, parts, created_at, turn_duration_ms FROM messages WHERE branch_id = ? ORDER BY created_at ASC`
            )
            .all(branchId) as Array<{
            id: string
            session_id: string
            branch_id: string
            role: "user" | "assistant" | "system" | "tool"
            parts: string
            created_at: number
            turn_duration_ms: number | null
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
              turnDurationMs: row.turn_duration_ms ?? undefined,
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

    updateMessageTurnDuration: (messageId, durationMs) =>
      Effect.try({
        try: () => {
          db.run(
            `UPDATE messages SET turn_duration_ms = ? WHERE id = ?`,
            [durationMs, messageId]
          )
        },
        catch: (e) =>
          new StorageError({
            message: "Failed to update message turn duration",
            cause: e,
          }),
      }),

    // Checkpoints
    createCheckpoint: (checkpoint) =>
      Effect.try({
        try: () => {
          if (checkpoint._tag === "CompactionCheckpoint") {
            db.run(
              `INSERT INTO checkpoints (id, branch_id, _tag, summary, first_kept_message_id, message_count, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                checkpoint.id,
                checkpoint.branchId,
                checkpoint._tag,
                checkpoint.summary,
                checkpoint.firstKeptMessageId,
                checkpoint.messageCount,
                checkpoint.tokenCount,
                checkpoint.createdAt.getTime(),
              ]
            )
          } else {
            db.run(
              `INSERT INTO checkpoints (id, branch_id, _tag, plan_path, message_count, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                checkpoint.id,
                checkpoint.branchId,
                checkpoint._tag,
                checkpoint.planPath,
                checkpoint.messageCount,
                checkpoint.tokenCount,
                checkpoint.createdAt.getTime(),
              ]
            )
          }
          return checkpoint
        },
        catch: (e) =>
          new StorageError({
            message: "Failed to create checkpoint",
            cause: e,
          }),
      }),

    getLatestCheckpoint: (branchId) =>
      Effect.try({
        try: () => {
          const row = db
            .query(
              `SELECT id, branch_id, _tag, summary, plan_path, first_kept_message_id, message_count, token_count, created_at FROM checkpoints WHERE branch_id = ? ORDER BY created_at DESC LIMIT 1`
            )
            .get(branchId) as
            | {
                id: string
                branch_id: string
                _tag: string
                summary: string | null
                plan_path: string | null
                first_kept_message_id: string | null
                message_count: number
                token_count: number
                created_at: number
              }
            | null
          if (!row) return undefined
          if (row._tag === "CompactionCheckpoint") {
            if (row.summary === null || row.first_kept_message_id === null) {
              throw new Error("Corrupt CompactionCheckpoint: missing summary or firstKeptMessageId")
            }
            return new CompactionCheckpoint({
              id: row.id,
              branchId: row.branch_id,
              summary: row.summary,
              firstKeptMessageId: row.first_kept_message_id,
              messageCount: row.message_count,
              tokenCount: row.token_count,
              createdAt: new Date(row.created_at),
            })
          } else {
            if (row.plan_path === null) {
              throw new Error("Corrupt PlanCheckpoint: missing planPath")
            }
            return new PlanCheckpoint({
              id: row.id,
              branchId: row.branch_id,
              planPath: row.plan_path,
              messageCount: row.message_count,
              tokenCount: row.token_count,
              createdAt: new Date(row.created_at),
            })
          }
        },
        catch: (e) =>
          new StorageError({
            message: "Failed to get latest checkpoint",
            cause: e,
          }),
      }),

    listMessagesAfter: (branchId, afterMessageId) =>
      Effect.try({
        try: () => {
          // First get the created_at of the afterMessageId
          const afterMsg = db
            .query(`SELECT created_at FROM messages WHERE id = ?`)
            .get(afterMessageId) as { created_at: number } | null
          if (!afterMsg) return []

          const rows = db
            .query(
              `SELECT id, session_id, branch_id, role, parts, created_at, turn_duration_ms FROM messages WHERE branch_id = ? AND created_at > ? ORDER BY created_at ASC`
            )
            .all(branchId, afterMsg.created_at) as Array<{
            id: string
            session_id: string
            branch_id: string
            role: "user" | "assistant" | "system" | "tool"
            parts: string
            created_at: number
            turn_duration_ms: number | null
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
              turnDurationMs: row.turn_duration_ms ?? undefined,
            })
          })
        },
        catch: (e) =>
          new StorageError({
            message: "Failed to list messages after",
            cause: e,
          }),
      }),

    listMessagesSince: (branchId, sinceTimestamp) =>
      Effect.try({
        try: () => {
          const rows = db
            .query(
              `SELECT id, session_id, branch_id, role, parts, created_at, turn_duration_ms FROM messages WHERE branch_id = ? AND created_at > ? ORDER BY created_at ASC`
            )
            .all(branchId, sinceTimestamp.getTime()) as Array<{
            id: string
            session_id: string
            branch_id: string
            role: "user" | "assistant" | "system" | "tool"
            parts: string
            created_at: number
            turn_duration_ms: number | null
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
              turnDurationMs: row.turn_duration_ms ?? undefined,
            })
          })
        },
        catch: (e) =>
          new StorageError({
            message: "Failed to list messages since",
            cause: e,
          }),
      }),

    // Todos
    listTodos: (branchId) =>
      Effect.try({
        try: () => {
          const rows = db
            .query(
              `SELECT id, content, status, priority, created_at, updated_at FROM todos WHERE branch_id = ? ORDER BY created_at ASC`
            )
            .all(branchId) as Array<{
            id: string
            content: string
            status: string
            priority: string | null
            created_at: number
            updated_at: number
          }>
          return rows.map((row) =>
            decodeTodoItem({
              id: row.id,
              content: row.content,
              status: row.status,
              priority: row.priority ?? undefined,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            })
          )
        },
        catch: (e) =>
          new StorageError({
            message: "Failed to list todos",
            cause: e,
          }),
      }),

    replaceTodos: (branchId, todos) =>
      Effect.try({
        try: () => {
          db.run(`DELETE FROM todos WHERE branch_id = ?`, [branchId])
          const stmt = db.prepare(
            `INSERT INTO todos (id, branch_id, content, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          for (const todo of todos) {
            stmt.run(
              todo.id,
              branchId,
              todo.content,
              todo.status,
              todo.priority ?? null,
              todo.createdAt.getTime(),
              todo.updatedAt.getTime()
            )
          }
        },
        catch: (e) =>
          new StorageError({
            message: "Failed to replace todos",
            cause: e,
          }),
      }),
  }
}

export class Storage extends Context.Tag("Storage")<Storage, StorageService>() {
  static Live = (dbPath: string): Layer.Layer<Storage, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.scoped(
      Storage,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.dirname(dbPath)
        yield* fs.makeDirectory(dir, { recursive: true })
        const db = new Database(dbPath)
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))
        return makeStorage(db)
      })
    )

  static Test = (): Layer.Layer<Storage> =>
    Layer.scoped(
      Storage,
      Effect.gen(function* () {
        const db = new Database(":memory:")
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))
        return makeStorage(db)
      })
    )
}
