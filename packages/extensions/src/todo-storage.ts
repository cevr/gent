/**
 * TodoStorage — todo extension persistence service.
 *
 * Contributed by @gent/todo extension via setup.layer.
 * When the extension is disabled, TodoStorage is absent and callers degrade gracefully.
 *
 * Owns its own DDL — no dependency on host Storage service.
 */

import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import {
  AgentName,
  CapabilityError,
  ReadOnlyBrand,
  SessionId,
  dateFromMillis,
  withReadOnly,
  type BranchId,
  type ReadOnly,
} from "@gent/core/extensions/api"
import { requireCapabilityWrite } from "@gent/core-internal/domain/capability-access"
import { SqlClient } from "effect/unstable/sql"
import {
  Todo,
  TodoStatus,
  TodoTransitionError,
  isValidTodoTransition,
  type TodoId,
} from "./todo/domain.js"
import { TODO_EXTENSION_ID } from "./todo/identity.js"

export class TodoStorageError extends Schema.TaggedErrorClass<TodoStorageError>()(
  "TodoStorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const MetadataJson = Schema.fromJsonString(Schema.Unknown)
const decodeMetadataJson = Schema.decodeUnknownOption(MetadataJson)
const encodeMetadataJson = Schema.encodeSync(MetadataJson)

const mapError = (message: string) => (e: unknown) => new TodoStorageError({ message, cause: e })

interface TodoRow {
  id: TodoId
  session_id: SessionId
  branch_id: BranchId
  parent_id: TodoId | null
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

const isTodoStatus = Schema.is(TodoStatus)
const encodeTodoMetadata = (metadata: unknown) =>
  Effect.try({
    try: () => encodeMetadataJson(metadata),
    catch: () => new TodoStorageError({ message: "Todo metadata is not JSON-serializable" }),
  })

const requireTodoWrite = (operation: string) =>
  requireCapabilityWrite({
    tag: "todo",
    extensionId: TODO_EXTENSION_ID,
    capabilityId: operation,
    operation,
  })

const mapWriteError = (message: string) => (e: unknown) =>
  Schema.is(CapabilityError)(e) ? e : mapError(message)(e)

const mapUpdateError = (message: string) => (e: unknown) =>
  Schema.is(CapabilityError)(e) || Schema.is(TodoTransitionError)(e) ? e : mapError(message)(e)

const decodeTodoMetadata = (metadata: string | null) =>
  metadata === null ? undefined : Option.getOrUndefined(decodeMetadataJson(metadata))

const requiredTodoColumns = [
  "id",
  "session_id",
  "branch_id",
  "parent_id",
  "subject",
  "description",
  "status",
  "owner",
  "agent_type",
  "prompt",
  "cwd",
  "metadata",
  "created_at",
  "updated_at",
] as const

const requiredTodoEdgeColumns = ["todo_id", "blocked_by_id"] as const

const selectTodoById = (sql: SqlClient.SqlClient, id: TodoId) =>
  sql<TodoRow>`SELECT id, session_id, branch_id, parent_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM todos WHERE id = ${id}`.pipe(
    Effect.map((rows) => {
      const row = rows[0]
      return row === undefined ? undefined : todoFromRow(row)
    }),
  )

const todoFromRow = (row: TodoRow) =>
  Todo.make({
    id: row.id,
    sessionId: row.session_id,
    branchId: row.branch_id,
    parentId: row.parent_id ?? undefined,
    subject: row.subject,
    description: row.description ?? undefined,
    status: isTodoStatus(row.status) ? row.status : "pending",
    owner: row.owner !== null ? SessionId.make(row.owner) : undefined,
    agentType: row.agent_type !== null ? AgentName.make(row.agent_type) : undefined,
    prompt: row.prompt ?? undefined,
    cwd: row.cwd ?? undefined,
    metadata: decodeTodoMetadata(row.metadata),
    createdAt: dateFromMillis(row.created_at),
    updatedAt: dateFromMillis(row.updated_at),
  })

const tableColumns = Effect.fn("TodoStorage.tableColumns")(function* (
  sql: SqlClient.SqlClient,
  table: "todos" | "todo_edges",
) {
  const rows = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`)
  return new Set(rows.map((row) => row.name))
})

const tableHasForeignKey = Effect.fn("TodoStorage.tableHasForeignKey")(function* (
  sql: SqlClient.SqlClient,
  table: "todos" | "todo_edges",
  parentTable: string,
  fromColumns: ReadonlyArray<string>,
) {
  const rows = yield* sql.unsafe<{
    id: number
    table: string
    from: string
  }>(`PRAGMA foreign_key_list(${table})`)
  const ids = new Map<number, Set<string>>()
  for (const row of rows) {
    if (row.table !== parentTable) continue
    const columns = ids.get(row.id) ?? new Set<string>()
    columns.add(row.from)
    ids.set(row.id, columns)
  }
  return Array.from(ids.values()).some((columns) =>
    fromColumns.every((column) => columns.has(column)),
  )
})

const todosTableNeedsReset = Effect.fn("TodoStorage.todosTableNeedsReset")(function* (
  sql: SqlClient.SqlClient,
) {
  const columns = yield* tableColumns(sql, "todos")
  if (columns.size === 0) return false
  if (requiredTodoColumns.some((column) => !columns.has(column))) return true
  return !(yield* tableHasForeignKey(sql, "todos", "branches", ["branch_id", "session_id"]))
})

const todoEdgesTableNeedsReset = Effect.fn("TodoStorage.todoEdgesTableNeedsReset")(function* (
  sql: SqlClient.SqlClient,
) {
  const columns = yield* tableColumns(sql, "todo_edges")
  if (columns.size === 0) return false
  if (requiredTodoEdgeColumns.some((column) => !columns.has(column))) return true
  const hasTodoFk = yield* tableHasForeignKey(sql, "todo_edges", "todos", ["todo_id"])
  const hasBlockedByFk = yield* tableHasForeignKey(sql, "todo_edges", "todos", ["blocked_by_id"])
  return !hasTodoFk || !hasBlockedByFk
})

const resetIncompatibleTodoTables = Effect.fn("TodoStorage.resetIncompatibleTodoTables")(function* (
  sql: SqlClient.SqlClient,
) {
  const resetTodos = yield* todosTableNeedsReset(sql)
  const resetTodoEdges = yield* todoEdgesTableNeedsReset(sql)
  if (!resetTodos && !resetTodoEdges) return

  yield* Effect.acquireUseRelease(
    sql.unsafe(`PRAGMA foreign_keys = OFF`),
    () =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(`DROP TABLE IF EXISTS todo_edges`)
          yield* sql.unsafe(`DROP TABLE IF EXISTS todos`)
        }),
      ),
    () => sql.unsafe(`PRAGMA foreign_keys = ON`),
  )
})

/**
 * Read-only slice of the TodoStorage surface — list/get queries +
 * dependency reads. Projections and `request({ intent: "read" })`
 * capabilities yield this branded sub-Tag instead of `TodoStorage`
 * so the type system blocks accidental write dependencies in read
 * contexts.
 *
 * Why two Tags, not one: `TodoStorage` and `TodoStorageReadOnly`
 * share a single underlying service value — `TodoStorage.Live`
 * builds the substrate once and registers both Tags pointing at
 * it (the read-only Tag wrapped with `withReadOnly`). This is a
 * structural narrowing, not a parallel API: there is one source
 * of truth, but two access surfaces. Read-intent code yields the
 * branded sub-Tag and is statically barred from calling write
 * methods, while write-intent code yields the full Tag.
 */
export interface TodoStorageReadOnlyService {
  readonly getTodo: (id: TodoId) => Effect.Effect<Todo | undefined, TodoStorageError>
  readonly listTodos: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Todo>, TodoStorageError>
  readonly getTodoDeps: (todoId: TodoId) => Effect.Effect<ReadonlyArray<TodoId>, TodoStorageError>
}

export interface TodoStorageService extends TodoStorageReadOnlyService {
  readonly createTodo: (todo: Todo) => Effect.Effect<Todo, TodoStorageError | CapabilityError>
  readonly updateTodo: (
    id: TodoId,
    fields: Partial<{
      status: TodoStatus
      parentId: TodoId | null
      description: string | null
      owner: string | null
      metadata: unknown | null
    }>,
  ) => Effect.Effect<Todo | undefined, TodoStorageError | CapabilityError | TodoTransitionError>
  readonly deleteTodo: (id: TodoId) => Effect.Effect<void, TodoStorageError | CapabilityError>
  readonly addTodoDep: (
    todoId: TodoId,
    blockedById: TodoId,
  ) => Effect.Effect<void, TodoStorageError | CapabilityError>
  readonly removeTodoDep: (
    todoId: TodoId,
    blockedById: TodoId,
  ) => Effect.Effect<void, TodoStorageError | CapabilityError>
}

/**
 * Read-only branded Tag onto the TodoStorage substrate. Projections
 * and read-intent request capabilities yield this instead of
 * `TodoStorage`. Provided alongside `TodoStorage` by `TodoStorage.Live`.
 */
export class TodoStorageReadOnly extends Context.Service<
  TodoStorageReadOnly,
  ReadOnly<TodoStorageReadOnlyService>
>()("@gent/extensions/src/todo-storage/TodoStorageReadOnly") {
  // Brand on the Tag identifier — see `domain/read-only.ts`.
  declare readonly [ReadOnlyBrand]: true
}

/**
 * Construct the underlying TodoStorage service value. Module-local —
 * `TodoStorage.Live` is the only consumer; the constructor itself is
 * not part of the public surface.
 */
const makeTodoStorageService: Effect.Effect<
  TodoStorageService,
  TodoStorageError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* resetIncompatibleTodoTables(sql).pipe(
    Effect.mapError(mapError("Failed to reset incompatible todo tables")),
  )

  const todosCreateSql = `
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        parent_id TEXT,
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
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE SET NULL
      )
    `

  yield* sql.unsafe(todosCreateSql).pipe(Effect.mapError(mapError("Failed to create todos table")))
  yield* sql
    .unsafe(
      `
          CREATE TABLE IF NOT EXISTS todo_edges (
            todo_id TEXT NOT NULL,
            blocked_by_id TEXT NOT NULL,
            PRIMARY KEY (todo_id, blocked_by_id),
            FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
            FOREIGN KEY (blocked_by_id) REFERENCES todos(id) ON DELETE CASCADE
          )
        `,
    )
    .pipe(Effect.mapError(mapError("Failed to create todo dependencies table")))

  yield* sql
    .unsafe(`CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id)`)
    .pipe(Effect.mapError(mapError("Failed to create todo session index")))
  yield* sql
    .unsafe(`CREATE INDEX IF NOT EXISTS idx_todos_session_branch ON todos(session_id, branch_id)`)
    .pipe(Effect.mapError(mapError("Failed to create todo session branch index")))
  yield* sql
    .unsafe(`CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id)`)
    .pipe(Effect.mapError(mapError("Failed to create todo parent index")))

  const ensureSameGraph = Effect.fn("TodoStorage.ensureSameGraph")(function* (
    todoId: TodoId,
    relatedId: TodoId,
    relation: string,
  ) {
    const rows = yield* sql<{
      same_graph: number
    }>`
      SELECT EXISTS (
        SELECT 1
        FROM todos todo
        JOIN todos related
          ON related.id = ${relatedId}
         AND related.session_id = todo.session_id
         AND related.branch_id = todo.branch_id
        WHERE todo.id = ${todoId}
      ) AS same_graph
    `
    if (rows[0]?.same_graph !== 1) {
      return yield* new TodoStorageError({
        message: `Invalid todo ${relation}: todos must exist in the same session branch`,
      })
    }
  })

  const ensureParentForNewTodo = Effect.fn("TodoStorage.ensureParentForNewTodo")(function* (
    parentId: TodoId,
    sessionId: SessionId,
    branchId: BranchId,
  ) {
    const rows = yield* sql<{ present: number }>`
      SELECT EXISTS (
        SELECT 1
        FROM todos
        WHERE id = ${parentId}
          AND session_id = ${sessionId}
          AND branch_id = ${branchId}
      ) AS present
    `
    if (rows[0]?.present !== 1) {
      return yield* new TodoStorageError({
        message: "Invalid todo parent: parent must exist in the same session branch",
      })
    }
  })

  const ensureNoParentCycle = Effect.fn("TodoStorage.ensureNoParentCycle")(function* (
    todoId: TodoId,
    parentId: TodoId,
  ) {
    if (todoId === parentId) {
      return yield* new TodoStorageError({ message: "Invalid todo parent: self nesting is cyclic" })
    }
    yield* ensureSameGraph(todoId, parentId, "parent")
    const rows = yield* sql<{ cyclic: number }>`
      WITH RECURSIVE ancestors(id, parent_id) AS (
        SELECT id, parent_id FROM todos WHERE id = ${parentId}
        UNION ALL
        SELECT todos.id, todos.parent_id
        FROM todos
        JOIN ancestors ON todos.id = ancestors.parent_id
      )
      SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ${todoId}) AS cyclic
    `
    if (rows[0]?.cyclic === 1) {
      return yield* new TodoStorageError({ message: "Invalid todo parent: nesting cycle detected" })
    }
  })

  const ensureNoDependencyCycle = Effect.fn("TodoStorage.ensureNoDependencyCycle")(function* (
    todoId: TodoId,
    blockedById: TodoId,
  ) {
    if (todoId === blockedById) {
      return yield* new TodoStorageError({
        message: "Invalid todo dependency: self dependency is cyclic",
      })
    }
    yield* ensureSameGraph(todoId, blockedById, "dependency")
    const rows = yield* sql<{ cyclic: number }>`
      WITH RECURSIVE blockers(id) AS (
        SELECT blocked_by_id FROM todo_edges WHERE todo_id = ${blockedById}
        UNION
        SELECT todo_edges.blocked_by_id
        FROM todo_edges
        JOIN blockers ON todo_edges.todo_id = blockers.id
      )
      SELECT EXISTS(SELECT 1 FROM blockers WHERE id = ${todoId}) AS cyclic
    `
    if (rows[0]?.cyclic === 1) {
      return yield* new TodoStorageError({
        message: "Invalid todo dependency: dependency cycle detected",
      })
    }
  })

  return {
    createTodo: Effect.fn("TodoStorage.createTodo")(
      function* (todo) {
        yield* requireTodoWrite("TodoStorage.createTodo")
        if (todo.parentId !== undefined) {
          yield* ensureParentForNewTodo(todo.parentId, todo.sessionId, todo.branchId)
        }
        const meta = todo.metadata === undefined ? null : yield* encodeTodoMetadata(todo.metadata)
        yield* sql`INSERT INTO todos (id, session_id, branch_id, parent_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at) VALUES (${todo.id}, ${todo.sessionId}, ${todo.branchId}, ${todo.parentId ?? null}, ${todo.subject}, ${todo.description ?? null}, ${todo.status}, ${todo.owner ?? null}, ${todo.agentType ?? null}, ${todo.prompt ?? null}, ${todo.cwd ?? null}, ${meta}, ${todo.createdAt.getTime()}, ${todo.updatedAt.getTime()})`
        return todo
      },
      Effect.mapError(mapWriteError("Failed to create todo")),
    ),

    getTodo: Effect.fn("TodoStorage.getTodo")(
      function* (id) {
        return yield* selectTodoById(sql, id)
      },
      Effect.mapError(mapError("Failed to get todo")),
    ),

    listTodos: Effect.fn("TodoStorage.listTodos")(
      function* (sessionId, branchId) {
        const rows =
          branchId !== undefined
            ? yield* sql<TodoRow>`SELECT id, session_id, branch_id, parent_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM todos WHERE session_id = ${sessionId} AND branch_id = ${branchId} ORDER BY created_at ASC`
            : yield* sql<TodoRow>`SELECT id, session_id, branch_id, parent_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM todos WHERE session_id = ${sessionId} ORDER BY created_at ASC`
        return rows.map(todoFromRow)
      },
      Effect.mapError(mapError("Failed to list todos")),
    ),

    updateTodo: Effect.fn("TodoStorage.updateTodo")(
      function* (id, fields) {
        yield* requireTodoWrite("TodoStorage.updateTodo")
        const now = yield* Clock.currentTimeMillis

        const updates: Record<string, string | number | null> = {
          updated_at: now,
        }

        if (fields.status !== undefined) {
          updates["status"] = fields.status
        }
        if ("parentId" in fields) {
          updates["parent_id"] = fields.parentId ?? null
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
              : yield* encodeTodoMetadata(fields.metadata)
        }

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* selectTodoById(sql, id)
            if (existing === undefined) return undefined
            if (fields.parentId !== undefined && fields.parentId !== null) {
              yield* ensureNoParentCycle(id, fields.parentId)
            }
            if (
              fields.status !== undefined &&
              !isValidTodoTransition(existing.status, fields.status)
            ) {
              return yield* new TodoTransitionError({
                message: `Invalid todo transition: ${existing.status} → ${fields.status}`,
                from: existing.status,
                to: fields.status,
              })
            }
            yield* sql`UPDATE todos SET ${sql.update(updates)} WHERE id = ${id}`
            return yield* selectTodoById(sql, id)
          }),
        )
      },
      Effect.mapError(mapUpdateError("Failed to update todo")),
    ),

    deleteTodo: Effect.fn("TodoStorage.deleteTodo")(
      function* (id) {
        yield* requireTodoWrite("TodoStorage.deleteTodo")
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM todo_edges WHERE todo_id = ${id} OR blocked_by_id = ${id}`
            yield* sql`DELETE FROM todos WHERE id = ${id}`
          }),
        )
      },
      Effect.mapError(mapWriteError("Failed to delete todo")),
    ),

    addTodoDep: (todoId, blockedById) =>
      requireTodoWrite("TodoStorage.addTodoDep").pipe(
        Effect.andThen(ensureNoDependencyCycle(todoId, blockedById)),
        Effect.andThen(
          sql`INSERT OR IGNORE INTO todo_edges (todo_id, blocked_by_id) VALUES (${todoId}, ${blockedById})`,
        ),
        Effect.asVoid,
        Effect.mapError(mapWriteError("Failed to add todo dep")),
        Effect.withSpan("TodoStorage.addTodoDep"),
      ),

    removeTodoDep: (todoId, blockedById) =>
      requireTodoWrite("TodoStorage.removeTodoDep").pipe(
        Effect.andThen(
          sql`DELETE FROM todo_edges WHERE todo_id = ${todoId} AND blocked_by_id = ${blockedById}`,
        ),
        Effect.asVoid,
        Effect.mapError(mapWriteError("Failed to remove todo dep")),
        Effect.withSpan("TodoStorage.removeTodoDep"),
      ),

    getTodoDeps: Effect.fn("TodoStorage.getTodoDeps")(
      function* (todoId) {
        const rows = yield* sql<{
          blocked_by_id: TodoId
        }>`SELECT blocked_by_id FROM todo_edges WHERE todo_id = ${todoId}`
        return rows.map((r) => r.blocked_by_id)
      },
      Effect.mapError(mapError("Failed to get todo deps")),
    ),
  } satisfies TodoStorageService
})

export class TodoStorage extends Context.Service<TodoStorage, TodoStorageService>()(
  "@gent/extensions/src/todo-storage/TodoStorage",
) {
  /**
   * Runs its own DDL — only requires SqlClient, not host Storage.
   *
   * Provides BOTH `TodoStorage` (write surface) and `TodoStorageReadOnly`
   * (read-only branded Tag) from the same underlying service value —
   * the read-only Tag is a structurally narrower projection that
   * downstream projections and read-intent capabilities can yield
   * without picking up the write methods.
   */
  static Live: Layer.Layer<
    TodoStorage | TodoStorageReadOnly,
    TodoStorageError,
    SqlClient.SqlClient
  > = Layer.effectContext(
    Effect.gen(function* () {
      const service = yield* makeTodoStorageService
      return Context.empty().pipe(
        Context.add(TodoStorage, service),
        Context.add(
          TodoStorageReadOnly,
          withReadOnly({
            getTodo: service.getTodo,
            listTodos: service.listTodos,
            getTodoDeps: service.getTodoDeps,
          } satisfies TodoStorageReadOnlyService),
        ),
      )
    }),
  )
}
