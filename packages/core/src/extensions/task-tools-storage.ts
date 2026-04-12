/**
 * TaskStorage — task-tools extension persistence service.
 *
 * Contributed by @gent/task-tools extension via setup.layer.
 * When the extension is disabled, TaskStorage is absent and callers degrade gracefully.
 *
 * Owns its own DDL — no dependency on host Storage service.
 */

import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Task } from "../domain/task.js"
import type { SessionId, BranchId, TaskId } from "../domain/ids.js"
import { SqlClient } from "effect/unstable/sql"

export class TaskStorageError extends Schema.TaggedErrorClass<TaskStorageError>()(
  "TaskStorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const MetadataJson = Schema.fromJsonString(Schema.Unknown)
const encodeMetadataJson = Schema.encodeSync(MetadataJson)

const mapError = (message: string) => (e: unknown) => new TaskStorageError({ message, cause: e })

const safeJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

interface TaskRow {
  id: TaskId
  session_id: SessionId
  branch_id: BranchId
  subject: string
  description: string | null
  status: string
  owner: string | null
  agent_type: string | null
  prompt: string | null
  cwd: string | null
  metadata: string | null
  created_at: number
  updated_at: number
}

const taskFromRow = (row: TaskRow) =>
  new Task({
    id: row.id,
    sessionId: row.session_id,
    branchId: row.branch_id,
    subject: row.subject,
    description: row.description ?? undefined,
    status: row.status as Task["status"],
    owner: (row.owner ?? undefined) as SessionId | undefined,
    agentType: (row.agent_type ?? undefined) as Task["agentType"],
    prompt: row.prompt ?? undefined,
    cwd: row.cwd ?? undefined,
    metadata: row.metadata !== null ? safeJsonParse(row.metadata) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  })

export interface TaskStorageService {
  readonly createTask: (task: Task) => Effect.Effect<Task, TaskStorageError>
  readonly getTask: (id: TaskId) => Effect.Effect<Task | undefined, TaskStorageError>
  readonly listTasks: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, TaskStorageError>
  readonly updateTask: (
    id: TaskId,
    fields: Partial<{
      status: string
      description: string | null
      owner: string | null
      metadata: unknown | null
    }>,
  ) => Effect.Effect<Task | undefined, TaskStorageError>
  readonly deleteTask: (id: TaskId) => Effect.Effect<void, TaskStorageError>
  readonly addTaskDep: (
    taskId: TaskId,
    blockedById: TaskId,
  ) => Effect.Effect<void, TaskStorageError>
  readonly removeTaskDep: (
    taskId: TaskId,
    blockedById: TaskId,
  ) => Effect.Effect<void, TaskStorageError>
  readonly getTaskDeps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TaskId>, TaskStorageError>
}

export class TaskStorage extends Context.Service<TaskStorage, TaskStorageService>()(
  "@gent/core/src/extensions/task-tools-storage/TaskStorage",
) {
  /** Runs its own DDL — only requires SqlClient, not host Storage */
  static Live: Layer.Layer<TaskStorage, never, SqlClient.SqlClient> = Layer.effect(
    TaskStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      // Extension-owned DDL — fatal if this fails
      yield* Effect.all([
        sql.unsafe(`
          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            owner TEXT,
            agent_type TEXT,
            prompt TEXT,
            cwd TEXT,
            metadata TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          )
        `),
        sql.unsafe(`
          CREATE TABLE IF NOT EXISTS task_deps (
            task_id TEXT NOT NULL,
            blocked_by_id TEXT NOT NULL,
            PRIMARY KEY (task_id, blocked_by_id),
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (blocked_by_id) REFERENCES tasks(id) ON DELETE CASCADE
          )
        `),
        sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)`),
        sql.unsafe(
          `CREATE INDEX IF NOT EXISTS idx_tasks_session_branch ON tasks(session_id, branch_id)`,
        ),
      ]).pipe(Effect.orDie)

      return {
        createTask: Effect.fn("TaskStorage.createTask")(
          function* (task) {
            const meta =
              task.metadata === undefined
                ? null
                : yield* Effect.try({
                    try: () => encodeMetadataJson(task.metadata),
                    catch: () =>
                      new TaskStorageError({ message: "Task metadata is not JSON-serializable" }),
                  })
            yield* sql`INSERT INTO tasks (id, session_id, branch_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at) VALUES (${task.id}, ${task.sessionId}, ${task.branchId}, ${task.subject}, ${task.description ?? null}, ${task.status}, ${task.owner ?? null}, ${task.agentType ?? null}, ${task.prompt ?? null}, ${task.cwd ?? null}, ${meta}, ${task.createdAt.getTime()}, ${task.updatedAt.getTime()})`
            return task
          },
          Effect.mapError(mapError("Failed to create task")),
        ),

        getTask: Effect.fn("TaskStorage.getTask")(
          function* (id) {
            const rows =
              yield* sql<TaskRow>`SELECT id, session_id, branch_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM tasks WHERE id = ${id}`
            const row = rows[0]
            if (row === undefined) return undefined
            return taskFromRow(row)
          },
          Effect.mapError(mapError("Failed to get task")),
        ),

        listTasks: Effect.fn("TaskStorage.listTasks")(
          function* (sessionId, branchId) {
            const rows =
              branchId !== undefined
                ? yield* sql<TaskRow>`SELECT id, session_id, branch_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM tasks WHERE session_id = ${sessionId} AND branch_id = ${branchId} ORDER BY created_at ASC`
                : yield* sql<TaskRow>`SELECT id, session_id, branch_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM tasks WHERE session_id = ${sessionId} ORDER BY created_at ASC`
            return rows.map(taskFromRow)
          },
          Effect.mapError(mapError("Failed to list tasks")),
        ),

        updateTask: Effect.fn("TaskStorage.updateTask")(
          function* (id, fields) {
            const now = yield* Clock.currentTimeMillis
            const VALID_STATUSES = new Set([
              "pending",
              "in_progress",
              "completed",
              "failed",
              "stopped",
            ])
            if (fields.status !== undefined && !VALID_STATUSES.has(fields.status)) {
              return yield* new TaskStorageError({
                message: `Invalid task status: ${fields.status}`,
              })
            }

            const sets: string[] = ["updated_at = ?"]
            const params: (string | number | null)[] = [now]

            if (fields.status !== undefined) {
              sets.push("status = ?")
              params.push(fields.status)
            }
            if ("description" in fields) {
              sets.push("description = ?")
              params.push(fields.description ?? null)
            }
            if ("owner" in fields) {
              sets.push("owner = ?")
              params.push(fields.owner ?? null)
            }
            if ("metadata" in fields) {
              sets.push("metadata = ?")
              if (fields.metadata === null || fields.metadata === undefined) {
                params.push(null)
              } else {
                params.push(
                  yield* Effect.try({
                    try: () => encodeMetadataJson(fields.metadata),
                    catch: () =>
                      new TaskStorageError({ message: "Metadata is not JSON-serializable" }),
                  }),
                )
              }
            }

            params.push(id)
            yield* sql.unsafe(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, params)

            const rows =
              yield* sql<TaskRow>`SELECT id, session_id, branch_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM tasks WHERE id = ${id}`
            const row = rows[0]
            if (row === undefined) return undefined
            return taskFromRow(row)
          },
          Effect.mapError(mapError("Failed to update task")),
        ),

        deleteTask: Effect.fn("TaskStorage.deleteTask")(
          function* (id) {
            yield* sql`DELETE FROM task_deps WHERE task_id = ${id} OR blocked_by_id = ${id}`
            yield* sql`DELETE FROM tasks WHERE id = ${id}`
          },
          Effect.mapError(mapError("Failed to delete task")),
        ),

        addTaskDep: (taskId, blockedById) =>
          sql`INSERT OR IGNORE INTO task_deps (task_id, blocked_by_id) VALUES (${taskId}, ${blockedById})`.pipe(
            Effect.asVoid,
            Effect.mapError(mapError("Failed to add task dep")),
            Effect.withSpan("TaskStorage.addTaskDep"),
          ),

        removeTaskDep: (taskId, blockedById) =>
          sql`DELETE FROM task_deps WHERE task_id = ${taskId} AND blocked_by_id = ${blockedById}`.pipe(
            Effect.asVoid,
            Effect.mapError(mapError("Failed to remove task dep")),
            Effect.withSpan("TaskStorage.removeTaskDep"),
          ),

        getTaskDeps: Effect.fn("TaskStorage.getTaskDeps")(
          function* (taskId) {
            const rows = yield* sql<{
              blocked_by_id: TaskId
            }>`SELECT blocked_by_id FROM task_deps WHERE task_id = ${taskId}`
            return rows.map((r) => r.blocked_by_id)
          },
          Effect.mapError(mapError("Failed to get task deps")),
        ),
      } satisfies TaskStorageService
    }),
  )
}
