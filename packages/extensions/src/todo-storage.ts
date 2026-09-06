/**
 * TodoStorage — todo extension persistence service.
 *
 * Contributed by @gent/todo extension via setup.layer.
 * When the extension is disabled, TodoStorage is absent and callers degrade gracefully.
 *
 * Owns its own DDL — no dependency on host Storage service.
 */

import { Clock, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { AgentName, DateFromNumber, SessionId, type BranchId } from "@gent/core/extensions/api"
import { SqlClient } from "effect/unstable/sql"
import {
  Todo,
  TodoStatus,
  TodoTransitionError,
  isValidTodoTransition,
  TodoId,
  type TodoId as TodoIdType,
} from "./todo/domain.js"

export class TodoStorageError extends Schema.TaggedError<TodoStorageError>()("TodoStorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const MetadataJson = Schema.fromJsonString(Schema.Unknown)
const JsonValueSchema = Schema.Unknown
type JsonValue = Schema.Schema.Type<typeof JsonValueSchema>
const NullableTodoId = Schema.NullOr(TodoId)
type NullableTodoId = typeof NullableTodoId.Type
const NullableString = Schema.NullOr(Schema.String)
type NullableString = typeof NullableString.Type
const NullableJsonValue = Schema.NullOr(JsonValueSchema)
type NullableJsonValue = typeof NullableJsonValue.Type
const decodeMetadataJson = Schema.decodeUnknownEffect(MetadataJson)
const encodeMetadataJson = Schema.encodeSync(MetadataJson)
const decodeTodoDate = Schema.decodeUnknownEffect(DateFromNumber)

const mapError = (message: string) => (cause: JsonValue) => new TodoStorageError({ message, cause })

const TodoRow = Schema.Struct({
  id: Todo.fields.id,
  session_id: SessionId,
  branch_id: Todo.fields.branchId,
  parent_id: Schema.NullOr(Todo.fields.id),
  subject: Schema.String,
  description: Schema.NullOr(Schema.String),
  status: TodoStatus,
  owner: Schema.NullOr(Schema.String),
  agent_type: Schema.NullOr(Schema.String),
  prompt: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  metadata: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})
type TodoRow = typeof TodoRow.Type
const decodeTodoRow = Schema.decodeUnknownEffect(TodoRow)

const encodeTodoMetadata = (metadata: JsonValue) =>
  Effect.try({
    try: () => encodeMetadataJson(metadata),
    catch: () => new TodoStorageError({ message: "Todo metadata is not JSON-serializable" }),
  })

const mapUpdateError = (message: string) => (cause: JsonValue) => {
  if (Schema.is(TodoTransitionError)(cause)) return cause
  return mapError(message)(cause)
}

const decodeTodoMetadata = (metadata: TodoRow["metadata"]) =>
  Option.match(Option.fromNullishOr(metadata), {
    onNone: () => Effect.void,
    onSome: decodeMetadataJson,
  })
type TodoUpdates = Record<string, string | number | NullableJsonValue>

// SQLite represents missing nullable values with null at this adapter boundary.
// oxlint-disable-next-line effect/noNullish -- SQLite nullable column contract requires SQL NULL.
const sqlNull = () => null

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
]

const requiredTodoEdgeColumns = ["todo_id", "blocked_by_id"]

const todoFromRow = (input: TodoRow) =>
  Effect.gen(function* () {
    const row = yield* decodeTodoRow(input)
    const metadata = yield* decodeTodoMetadata(row.metadata)
    const createdAt = yield* decodeTodoDate(row.created_at)
    const updatedAt = yield* decodeTodoDate(row.updated_at)
    return Todo.make({
      id: row.id,
      sessionId: row.session_id,
      branchId: row.branch_id,
      parentId: Option.getOrUndefined(Option.fromNullishOr(row.parent_id)),
      subject: row.subject,
      description: Option.getOrUndefined(Option.fromNullishOr(row.description)),
      status: row.status,
      owner: Option.getOrUndefined(
        Option.fromNullishOr(row.owner).pipe(Option.map((value) => SessionId.make(value))),
      ),
      agentType: Option.getOrUndefined(
        Option.fromNullishOr(row.agent_type).pipe(Option.map((value) => AgentName.make(value))),
      ),
      prompt: Option.getOrUndefined(Option.fromNullishOr(row.prompt)),
      cwd: Option.getOrUndefined(Option.fromNullishOr(row.cwd)),
      metadata,
      createdAt,
      updatedAt,
    })
  })

const tableColumns = Effect.fn("TodoStorage.tableColumns")(function* (
  table: "todos" | "todo_edges",
) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`)
  return new Set(rows.map((row) => row.name))
})

const tableHasForeignKey = Effect.fn("TodoStorage.tableHasForeignKey")(function* (
  table: "todos" | "todo_edges",
  parentTable: string,
  fromColumns: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql.unsafe<{
    id: number
    table: string
    from: string
  }>(`PRAGMA foreign_key_list(${table})`)
  const ids = new Map<number, Set<string>>()
  for (const row of rows) {
    if (row.table !== parentTable) continue
    const columns = Option.getOrElse(Option.fromNullishOr(ids.get(row.id)), () => new Set<string>())
    columns.add(row.from)
    ids.set(row.id, columns)
  }
  return Array.from(ids.values()).some((columns) =>
    fromColumns.every((column) => columns.has(column)),
  )
})

const todosTableNeedsReset = Effect.fn("TodoStorage.todosTableNeedsReset")(function* () {
  const columns = yield* tableColumns("todos")
  if (columns.size === 0) return false
  if (requiredTodoColumns.some((column) => !columns.has(column))) return true
  return !(yield* tableHasForeignKey("todos", "branches", ["branch_id", "session_id"]))
})

const todoEdgesTableNeedsReset = Effect.fn("TodoStorage.todoEdgesTableNeedsReset")(function* () {
  const columns = yield* tableColumns("todo_edges")
  if (columns.size === 0) return false
  if (requiredTodoEdgeColumns.some((column) => !columns.has(column))) return true
  const hasTodoFk = yield* tableHasForeignKey("todo_edges", "todos", ["todo_id"])
  const hasBlockedByFk = yield* tableHasForeignKey("todo_edges", "todos", ["blocked_by_id"])
  return !hasTodoFk || !hasBlockedByFk
})

const resetIncompatibleTodoTables = Effect.fn("TodoStorage.resetIncompatibleTodoTables")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const resetTodos = yield* todosTableNeedsReset()
    const resetTodoEdges = yield* todoEdgesTableNeedsReset()
    if (!resetTodos && !resetTodoEdges) return

    yield* Effect.acquireUseRelease(
      sql.unsafe(`PRAGMA foreign_keys = OFF`),
      () =>
        Effect.gen(function* () {
          yield* sql.unsafe(`DROP TABLE IF EXISTS todo_edges`)
          yield* sql.unsafe(`DROP TABLE IF EXISTS todos`)
        }).pipe(sql.withTransaction),
      () => sql.unsafe(`PRAGMA foreign_keys = ON`),
    )
  },
)

/**
 * Read slice of the TodoStorage surface — list/get queries + dependency reads.
 * The separate Tag keeps callers from depending on write methods without
 * requiring public read-only branding ceremony.
 *
 * Why two Tags, not one: `TodoStorage` and `TodoStorageReadOnly`
 * share a single underlying service value — `TodoStorage.Live`
 * builds the substrate once and registers both Tags pointing at it. This is a
 * structural narrowing, not a parallel API: there is one source of truth, but
 * two access surfaces.
 */
export interface TodoStorageReadOnlyService {
  readonly getTodo: (id: TodoId) => Effect.Effect<Option.Option<Todo>, TodoStorageError>
  readonly listTodos: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Todo>, TodoStorageError>
  readonly getTodoDeps: (todoId: TodoId) => Effect.Effect<ReadonlyArray<TodoId>, TodoStorageError>
}

export interface TodoStorageService extends TodoStorageReadOnlyService {
  readonly createTodo: (todo: Todo) => Effect.Effect<Todo, TodoStorageError>
  readonly updateTodo: (
    id: TodoId,
    fields: Partial<{
      status: TodoStatus
      parentId: NullableTodoId
      description: NullableString
      owner: NullableString
      metadata: NullableJsonValue
    }>,
  ) => Effect.Effect<Option.Option<Todo>, TodoStorageError | TodoTransitionError>
  readonly deleteTodo: (id: TodoId) => Effect.Effect<void, TodoStorageError>
  readonly addTodoDep: (
    todoId: TodoId,
    blockedById: TodoId,
  ) => Effect.Effect<void, TodoStorageError>
  readonly removeTodoDep: (
    todoId: TodoId,
    blockedById: TodoId,
  ) => Effect.Effect<void, TodoStorageError>
}

/**
 * Read Tag onto the TodoStorage substrate. Provided alongside `TodoStorage`
 * by `TodoStorage.Live`.
 */
export class TodoStorageReadOnly extends Context.Service<
  TodoStorageReadOnly,
  TodoStorageReadOnlyService
>()("@gent/extensions/src/todo-storage/TodoStorageReadOnly") {}

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

  const selectTodoById = (id: TodoIdType) =>
    sql<TodoRow>`SELECT id, session_id, branch_id, parent_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM todos WHERE id = ${id}`.pipe(
      Effect.flatMap((rows) =>
        Option.match(Option.fromNullishOr(rows[0]), {
          onNone: () => Effect.succeed(Option.none<Todo>()),
          onSome: (value) => todoFromRow(value).pipe(Effect.asSome),
        }),
      ),
    )

  yield* resetIncompatibleTodoTables().pipe(
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
        if (Predicate.isNotUndefined(todo.parentId)) {
          yield* ensureParentForNewTodo(todo.parentId, todo.sessionId, todo.branchId)
        }
        const meta = yield* Option.match(Option.fromNullishOr(todo.metadata), {
          onNone: () => Effect.succeed(sqlNull()),
          onSome: encodeTodoMetadata,
        })
        yield* sql`INSERT INTO todos (id, session_id, branch_id, parent_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at) VALUES (${todo.id}, ${todo.sessionId}, ${todo.branchId}, ${Option.getOrElse(Option.fromNullishOr(todo.parentId), sqlNull)}, ${todo.subject}, ${Option.getOrElse(Option.fromNullishOr(todo.description), sqlNull)}, ${todo.status}, ${Option.getOrElse(Option.fromNullishOr(todo.owner), sqlNull)}, ${Option.getOrElse(Option.fromNullishOr(todo.agentType), sqlNull)}, ${Option.getOrElse(Option.fromNullishOr(todo.prompt), sqlNull)}, ${Option.getOrElse(Option.fromNullishOr(todo.cwd), sqlNull)}, ${meta}, ${todo.createdAt.getTime()}, ${todo.updatedAt.getTime()})`
        return todo
      },
      Effect.mapError(mapError("Failed to create todo")),
    ),

    getTodo: Effect.fn("TodoStorage.getTodo")(
      function* (id) {
        return yield* selectTodoById(id)
      },
      Effect.mapError(mapError("Failed to get todo")),
    ),

    listTodos: Effect.fn("TodoStorage.listTodos")(
      function* (sessionId, branchId) {
        const rows = yield* Option.match(Option.fromNullishOr(branchId), {
          onNone: () =>
            sql<TodoRow>`SELECT id, session_id, branch_id, parent_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM todos WHERE session_id = ${sessionId} ORDER BY created_at ASC`,
          onSome: (value) =>
            sql<TodoRow>`SELECT id, session_id, branch_id, parent_id, subject, description, status, owner, agent_type, prompt, cwd, metadata, created_at, updated_at FROM todos WHERE session_id = ${sessionId} AND branch_id = ${value} ORDER BY created_at ASC`,
        })
        return yield* Effect.forEach(rows, todoFromRow)
      },
      Effect.mapError(mapError("Failed to list todos")),
    ),

    updateTodo: Effect.fn("TodoStorage.updateTodo")(
      function* (id, fields) {
        const now = yield* Clock.currentTimeMillis

        const updates: TodoUpdates = {
          updated_at: now,
        }

        if (Predicate.isNotUndefined(fields.status)) {
          updates["status"] = fields.status
        }
        if ("parentId" in fields) {
          updates["parent_id"] = Option.getOrElse(Option.fromNullishOr(fields.parentId), sqlNull)
        }
        if ("description" in fields) {
          updates["description"] = Option.getOrElse(
            Option.fromNullishOr(fields.description),
            sqlNull,
          )
        }
        if ("owner" in fields) {
          updates["owner"] = Option.getOrElse(Option.fromNullishOr(fields.owner), sqlNull)
        }
        if ("metadata" in fields) {
          updates["metadata"] = yield* Option.match(Option.fromNullishOr(fields.metadata), {
            onNone: () => Effect.succeed(sqlNull()),
            onSome: encodeTodoMetadata,
          })
        }

        return yield* Effect.gen(function* () {
          const existing = yield* selectTodoById(id)
          if (Option.isNone(existing)) return existing
          yield* Option.match(Option.fromNullishOr(fields.parentId), {
            onNone: () => Effect.void,
            onSome: (parentId) => ensureNoParentCycle(id, parentId),
          })
          if (
            Predicate.isNotUndefined(fields.status) &&
            !isValidTodoTransition(existing.value.status, fields.status)
          ) {
            return yield* new TodoTransitionError({
              message: `Invalid todo transition: ${existing.value.status} → ${fields.status}`,
              from: existing.value.status,
              to: fields.status,
            })
          }
          yield* sql`UPDATE todos SET ${sql.update(updates)} WHERE id = ${id}`
          return yield* selectTodoById(id)
        }).pipe(sql.withTransaction)
      },
      Effect.mapError(mapUpdateError("Failed to update todo")),
    ),

    deleteTodo: Effect.fn("TodoStorage.deleteTodo")(
      function* (id) {
        yield* Effect.gen(function* () {
          yield* sql`DELETE FROM todo_edges WHERE todo_id = ${id} OR blocked_by_id = ${id}`
          yield* sql`DELETE FROM todos WHERE id = ${id}`
        }).pipe(sql.withTransaction)
      },
      Effect.mapError(mapError("Failed to delete todo")),
    ),

    addTodoDep: (todoId, blockedById) =>
      ensureNoDependencyCycle(todoId, blockedById).pipe(
        Effect.andThen(
          sql`INSERT OR IGNORE INTO todo_edges (todo_id, blocked_by_id) VALUES (${todoId}, ${blockedById})`,
        ),
        Effect.asVoid,
        Effect.mapError(mapError("Failed to add todo dep")),
        Effect.withSpan("TodoStorage.addTodoDep"),
      ),

    removeTodoDep: (todoId, blockedById) =>
      sql`DELETE FROM todo_edges WHERE todo_id = ${todoId} AND blocked_by_id = ${blockedById}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapError("Failed to remove todo dep")),
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
   * from the same underlying service value. The read Tag is a structurally
   * narrower projection; it is not a public capability system.
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
        Context.add(TodoStorageReadOnly, {
          getTodo: service.getTodo,
          listTodos: service.listTodos,
          getTodoDeps: service.getTodoDeps,
        } satisfies TodoStorageReadOnlyService),
      )
    }),
  )
}
