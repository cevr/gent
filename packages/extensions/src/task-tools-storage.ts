/**
 * TaskStorage — task-tools extension persistence service.
 *
 * Contributed by @gent/task-tools extension via setup.layer.
 * When the extension is disabled, TaskStorage is absent and callers degrade gracefully.
 *
 * Owns its own DDL — no dependency on host Storage service.
 */

import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import {
  Task,
  TaskStatus,
  SessionId,
  type BranchId,
  type TaskId,
  type ReadOnly,
  ReadOnlyBrand,
  withReadOnly,
} from "@gent/core/extensions/api"
import { SqlClient } from "effect/unstable/sql"

export class TaskStorageError extends Schema.TaggedErrorClass<TaskStorageError>()(
  "TaskStorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const MetadataJson = Schema.fromJsonString(Schema.Unknown)
const decodeMetadataJson = Schema.decodeUnknownOption(MetadataJson)
const encodeMetadataJson = Schema.encodeSync(MetadataJson)

const mapError = (message: string) => (e: unknown) => new TaskStorageError({ message, cause: e })

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

const isTaskStatus = Schema.is(TaskStatus)
const encodeTaskMetadata = (metadata: unknown) =>
  Effect.try({
    try: () => encodeMetadataJson(metadata),
    catch: () => new TaskStorageError({ message: "Task metadata is not JSON-serializable" }),
  })

const decodeTaskMetadata = (metadata: string | null) =>
  metadata === null ? undefined : Option.getOrUndefined(decodeMetadataJson(metadata))

const selectTaskById = (sql: SqlClient.SqlClient, id: TaskId) =>
  sql<TaskRow>`SELECT id, session_id, branch_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM tasks WHERE id = ${id}`.pipe(
    Effect.map((rows) => {
      const row = rows[0]
      return row === undefined ? undefined : taskFromRow(row)
    }),
  )

const taskFromRow = (row: TaskRow) =>
  new Task({
    id: row.id,
    sessionId: row.session_id,
    branchId: row.branch_id,
    subject: row.subject,
    description: row.description ?? undefined,
    status: isTaskStatus(row.status) ? row.status : "pending",
    owner: row.owner !== null ? SessionId.make(row.owner) : undefined,
    agentType: row.agent_type ?? undefined,
    prompt: row.prompt ?? undefined,
    cwd: row.cwd ?? undefined,
    metadata: decodeTaskMetadata(row.metadata),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  })

/**
 * Read-only slice of the TaskStorage surface — list/get queries +
 * dependency reads. Projections (and `request({ intent: "read" })`
 * capabilities once B11.5 lands) yield this branded sub-Tag instead
 * of `TaskStorage` so the type system blocks accidental write
 * dependencies in read contexts.
 *
 * The Live layer for `TaskStorage` provides BOTH this Tag and the
 * write-capable `TaskStorage` Tag from the same underlying state —
 * see `TaskStorage.Live` below.
 */
export interface TaskStorageReadOnlyService {
  readonly getTask: (id: TaskId) => Effect.Effect<Task | undefined, TaskStorageError>
  readonly listTasks: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, TaskStorageError>
  readonly getTaskDeps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TaskId>, TaskStorageError>
}

export interface TaskStorageService extends TaskStorageReadOnlyService {
  readonly createTask: (task: Task) => Effect.Effect<Task, TaskStorageError>
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
}

/**
 * Read-only branded Tag onto the TaskStorage substrate. Projections
 * and read-intent request capabilities yield this instead of
 * `TaskStorage`. Provided alongside `TaskStorage` by `TaskStorage.Live`.
 */
export class TaskStorageReadOnly extends Context.Service<
  TaskStorageReadOnly,
  ReadOnly<TaskStorageReadOnlyService>
>()("@gent/core/src/extensions/task-tools-storage/TaskStorageReadOnly") {
  // Brand on the Tag identifier — see `domain/read-only.ts`.
  declare readonly [ReadOnlyBrand]: true
}

/**
 * Construct the underlying TaskStorage service value. Module-local —
 * `TaskStorage.Live` is the only consumer; the constructor itself is
 * not part of the public surface.
 */
const makeTaskStorageService: Effect.Effect<TaskStorageService, never, SqlClient.SqlClient> =
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
          const meta = task.metadata === undefined ? null : yield* encodeTaskMetadata(task.metadata)
          yield* sql`INSERT INTO tasks (id, session_id, branch_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at) VALUES (${task.id}, ${task.sessionId}, ${task.branchId}, ${task.subject}, ${task.description ?? null}, ${task.status}, ${task.owner ?? null}, ${task.agentType ?? null}, ${task.prompt ?? null}, ${task.cwd ?? null}, ${meta}, ${task.createdAt.getTime()}, ${task.updatedAt.getTime()})`
          return task
        },
        Effect.mapError(mapError("Failed to create task")),
      ),

      getTask: Effect.fn("TaskStorage.getTask")(
        function* (id) {
          return yield* selectTaskById(sql, id)
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
          if (fields.status !== undefined && !isTaskStatus(fields.status)) {
            return yield* new TaskStorageError({
              message: `Invalid task status: ${fields.status}`,
            })
          }

          const updates: Record<string, string | number | null> = {
            updated_at: now,
          }

          if (fields.status !== undefined) {
            updates["status"] = fields.status
          }
          if ("description" in fields) {
            updates["description"] = fields.description ?? null
          }
          if ("owner" in fields) {
            updates["owner"] = fields.owner ?? null
          }
          if ("metadata" in fields) {
            updates["metadata"] =
              fields.metadata === null || fields.metadata === undefined
                ? null
                : yield* encodeTaskMetadata(fields.metadata)
          }

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE tasks SET ${sql.update(updates)} WHERE id = ${id}`
              return yield* selectTaskById(sql, id)
            }),
          )
        },
        Effect.mapError(mapError("Failed to update task")),
      ),

      deleteTask: Effect.fn("TaskStorage.deleteTask")(
        function* (id) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM task_deps WHERE task_id = ${id} OR blocked_by_id = ${id}`
              yield* sql`DELETE FROM tasks WHERE id = ${id}`
            }),
          )
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
  })

export class TaskStorage extends Context.Service<TaskStorage, TaskStorageService>()(
  "@gent/core/src/extensions/task-tools-storage/TaskStorage",
) {
  /**
   * Runs its own DDL — only requires SqlClient, not host Storage.
   *
   * Provides BOTH `TaskStorage` (write surface) and `TaskStorageReadOnly`
   * (read-only branded Tag) from the same underlying service value —
   * the read-only Tag is a structurally narrower projection that
   * downstream projections and read-intent capabilities can yield
   * without picking up the write methods.
   */
  static Live: Layer.Layer<TaskStorage | TaskStorageReadOnly, never, SqlClient.SqlClient> =
    Layer.effectContext(
      Effect.gen(function* () {
        const service = yield* makeTaskStorageService
        return Context.empty().pipe(
          Context.add(TaskStorage, service),
          Context.add(
            TaskStorageReadOnly,
            withReadOnly({
              getTask: service.getTask,
              listTasks: service.listTasks,
              getTaskDeps: service.getTaskDeps,
            } satisfies TaskStorageReadOnlyService),
          ),
        )
      }),
    )
}
