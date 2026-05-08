import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { TodoStorage, TodoStorageError, TodoStorageReadOnly } from "../../src/todo-storage.js"
import { dateFromMillis, Session, Branch } from "@gent/core-internal/domain/message"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { Todo, TodoId, TodoTransitionError } from "../../src/todo/domain.js"
import { capabilityAccessNeedsLayer } from "@gent/core-internal/test-utils"

const FIXED_NOW = dateFromMillis(1_767_225_600_000)

// Single in-memory db: TestWithSql exposes both Storage and SqlClient.
// TodoStorage.Live consumes SqlClient, so we provide TestWithSql to it.
const baseLayer = SqliteStorage.TestWithSql()
const todoStorageLayer = Layer.provide(TodoStorage.Live, baseLayer)
const testLayer = Layer.mergeAll(
  baseLayer,
  todoStorageLayer,
  capabilityAccessNeedsLayer([{ tag: "todo", access: "write" }]),
)

const test = it.live.layer(testLayer)

const setup = Effect.gen(function* () {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const todoStorage = yield* TodoStorage
  const now = FIXED_NOW
  const session = new Session({
    id: SessionId.make("s1"),
    name: "Test",
    createdAt: now,
    updatedAt: now,
  })
  const branch = new Branch({
    id: BranchId.make("b1"),
    sessionId: session.id,
    createdAt: now,
  })
  yield* sessionStorage.createSession(session)
  yield* branchStorage.createBranch(branch)
  return { storage: todoStorage, session, branch }
})

const makeTodo = (id: string, overrides?: Partial<ConstructorParameters<typeof Todo>[0]>) => {
  const now = FIXED_NOW
  return Todo.make({
    id: TodoId.make(id),
    sessionId: SessionId.make("s1"),
    branchId: BranchId.make("b1"),
    subject: `Todo ${id}`,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
}

describe("Todo Storage", () => {
  test("createTodo + getTodo roundtrip", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const todo = makeTodo("t1", { description: "Do something", cwd: "/tmp" })
      yield* storage.createTodo(todo)
      const got = yield* storage.getTodo(TodoId.make("t1"))
      expect(got).toBeDefined()
      expect(got!.id).toBe(TodoId.make("t1"))
      expect(got!.subject).toBe("Todo t1")
      expect(got!.description).toBe("Do something")
      expect(got!.status).toBe("pending")
      expect(got!.cwd).toBe("/tmp")
    }))

  test("getTodo returns undefined for missing", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const got = yield* storage.getTodo(TodoId.make("nonexistent"))
      expect(got).toBeUndefined()
    }))

  test("listTodos by session", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1"))
      yield* storage.createTodo(makeTodo("t2"))
      const todos = yield* storage.listTodos(SessionId.make("s1"))
      expect(todos.length).toBe(2)
    }))

  test("listTodos by session + branch", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1"))
      const todos = yield* storage.listTodos(SessionId.make("s1"), BranchId.make("b1"))
      expect(todos.length).toBe(1)
      const empty = yield* storage.listTodos(SessionId.make("s1"), BranchId.make("other"))
      expect(empty.length).toBe(0)
    }))

  test("updateTodo changes status", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1"))
      const updated = yield* storage.updateTodo(TodoId.make("t1"), { status: "in_progress" })
      expect(updated).toBeDefined()
      expect(updated!.status).toBe("in_progress")
    }))

  test("updateTodo rejects terminal status transitions at the write boundary", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1", { status: "stopped" }))

      const error = yield* storage
        .updateTodo(TodoId.make("t1"), { status: "completed" })
        .pipe(Effect.flip)
      const stored = yield* storage.getTodo(TodoId.make("t1"))

      expect(Schema.is(TodoTransitionError)(error)).toBe(true)
      expect(stored?.status).toBe("stopped")
    }))

  test("updateTodo returns undefined for missing", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const updated = yield* storage.updateTodo(TodoId.make("nonexistent"), { status: "completed" })
      expect(updated).toBeUndefined()
    }))

  test("deleteTodo removes todo", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1"))
      yield* storage.deleteTodo(TodoId.make("t1"))
      const got = yield* storage.getTodo(TodoId.make("t1"))
      expect(got).toBeUndefined()
    }))

  test("todo with metadata roundtrips", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1", { metadata: { key: "value", count: 42 } }))
      const got = yield* storage.getTodo(TodoId.make("t1"))
      expect(got).toBeDefined()
      const meta = got!.metadata as Record<string, unknown>
      expect(meta["key"]).toBe("value")
      expect(meta["count"]).toBe(42)
    }))

  test("nested todos roundtrip through create, list, and update", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("parent"))
      yield* storage.createTodo(makeTodo("child", { parentId: TodoId.make("parent") }))

      const child = yield* storage.getTodo(TodoId.make("child"))
      expect(child?.parentId).toBe(TodoId.make("parent"))

      const todos = yield* storage.listTodos(SessionId.make("s1"), BranchId.make("b1"))
      expect(todos.find((todo) => todo.id === TodoId.make("child"))?.parentId).toBe(
        TodoId.make("parent"),
      )

      yield* storage.updateTodo(TodoId.make("child"), { parentId: null })
      const moved = yield* storage.getTodo(TodoId.make("child"))
      expect(moved?.parentId).toBeUndefined()
    }))

  test("nested todos must stay inside the same session branch", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const branchStorage = yield* BranchStorage
      yield* branchStorage.createBranch(
        new Branch({
          id: BranchId.make("b2"),
          sessionId: SessionId.make("s1"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* storage.createTodo(makeTodo("parent", { branchId: BranchId.make("b2") }))

      const error = yield* storage
        .createTodo(makeTodo("child", { parentId: TodoId.make("parent") }))
        .pipe(Effect.flip)

      expect(Schema.is(TodoStorageError)(error)).toBe(true)
      expect(yield* storage.getTodo(TodoId.make("child"))).toBeUndefined()
    }))

  test("moving a todo under its descendant is rejected", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("parent"))
      yield* storage.createTodo(makeTodo("child", { parentId: TodoId.make("parent") }))

      const error = yield* storage
        .updateTodo(TodoId.make("parent"), { parentId: TodoId.make("child") })
        .pipe(Effect.flip)
      const parent = yield* storage.getTodo(TodoId.make("parent"))

      expect(Schema.is(TodoStorageError)(error)).toBe(true)
      expect(parent?.parentId).toBeUndefined()
    }))
})

describe("Todo Dependencies", () => {
  test("addTodoDep + getTodoDeps", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1"))
      yield* storage.createTodo(makeTodo("t2"))
      yield* storage.addTodoDep(TodoId.make("t2"), TodoId.make("t1"))
      const deps = yield* storage.getTodoDeps(TodoId.make("t2"))
      expect(deps).toEqual([TodoId.make("t1")])
    }))

  test("removeTodoDep", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1"))
      yield* storage.createTodo(makeTodo("t2"))
      yield* storage.addTodoDep(TodoId.make("t2"), TodoId.make("t1"))
      yield* storage.removeTodoDep(TodoId.make("t2"), TodoId.make("t1"))
      const deps = yield* storage.getTodoDeps(TodoId.make("t2"))
      expect(deps.length).toBe(0)
    }))

  test("deleting todo removes its own deps", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1"))
      yield* storage.createTodo(makeTodo("t2"))
      yield* storage.addTodoDep(TodoId.make("t2"), TodoId.make("t1"))
      yield* storage.deleteTodo(TodoId.make("t2"))
      // After deleting t2, its dep entries should also be gone
      const deps = yield* storage.getTodoDeps(TodoId.make("t2"))
      expect(deps.length).toBe(0)
    }))

  test("deleteTodo rolls back dependency deletion when todo delete fails", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* storage.createTodo(makeTodo("t1"))
      yield* storage.createTodo(makeTodo("t2"))
      yield* storage.addTodoDep(TodoId.make("t2"), TodoId.make("t1"))
      yield* sql.unsafe(`
        CREATE TRIGGER fail_todo_delete
        BEFORE DELETE ON todos
        WHEN old.id = 't1'
        BEGIN
          SELECT RAISE(ABORT, 'forced todo delete failure');
        END
      `)

      const error = yield* Effect.flip(storage.deleteTodo(TodoId.make("t1")))

      expect(error._tag).toBe("TodoStorageError")
      expect(yield* storage.getTodo(TodoId.make("t1"))).toBeDefined()
      expect(yield* storage.getTodoDeps(TodoId.make("t2"))).toEqual([TodoId.make("t1")])
    }))

  test("duplicate dep is idempotent", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("t1"))
      yield* storage.createTodo(makeTodo("t2"))
      yield* storage.addTodoDep(TodoId.make("t2"), TodoId.make("t1"))
      yield* storage.addTodoDep(TodoId.make("t2"), TodoId.make("t1"))
      const deps = yield* storage.getTodoDeps(TodoId.make("t2"))
      expect(deps.length).toBe(1)
    }))

  test("dependency edges must form a DAG", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("first"))
      yield* storage.createTodo(makeTodo("second"))
      yield* storage.addTodoDep(TodoId.make("first"), TodoId.make("second"))

      const error = yield* storage
        .addTodoDep(TodoId.make("second"), TodoId.make("first"))
        .pipe(Effect.flip)

      expect(Schema.is(TodoStorageError)(error)).toBe(true)
      expect(yield* storage.getTodoDeps(TodoId.make("second"))).toEqual([])
    }))

  test("dependency edges reject self cycles", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTodo(makeTodo("self"))

      const error = yield* storage
        .addTodoDep(TodoId.make("self"), TodoId.make("self"))
        .pipe(Effect.flip)

      expect(Schema.is(TodoStorageError)(error)).toBe(true)
      expect(yield* storage.getTodoDeps(TodoId.make("self"))).toEqual([])
    }))
})

describe("Composite branch FK", () => {
  test("deleting the parent branch cascades its todos", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const branchStorage = yield* BranchStorage
      yield* storage.createTodo(makeTodo("t1"))
      yield* storage.createTodo(makeTodo("t2"))

      yield* branchStorage.deleteBranch(BranchId.make("b1"))

      const remaining = yield* storage.listTodos(SessionId.make("s1"))
      expect(remaining.length).toBe(0)
    }))

  test("creating a todo whose branch does not exist is rejected", () =>
    Effect.gen(function* () {
      yield* setup
      const todoStorage = yield* TodoStorage
      const result = yield* Effect.flip(
        todoStorage.createTodo(makeTodo("t1", { branchId: BranchId.make("nonexistent-branch") })),
      )
      expect(result._tag).toBe("TodoStorageError")
      const present = yield* todoStorage.getTodo(TodoId.make("t1"))
      expect(present).toBeUndefined()
    }))
})

describe("TodoStorageReadOnly", () => {
  test("TodoStorage.Live provides the read-only Tag with working read methods", () =>
    Effect.gen(function* () {
      // Setup session/branch + write via the wide Tag, then read back through
      // the read-only Tag — proves both Tags resolve to the same state.
      yield* setup
      const writer = yield* TodoStorage
      yield* writer.createTodo(makeTodo("ro1", { description: "read-only proof" }))

      const reader = yield* TodoStorageReadOnly
      const got = yield* reader.getTodo(TodoId.make("ro1"))
      expect(got).toBeDefined()
      expect(got!.description).toBe("read-only proof")

      const listed = yield* reader.listTodos(SessionId.make("s1"))
      expect(listed.some((t) => t.id === "ro1")).toBe(true)

      // getTodoDeps reachable from the read-only surface
      const deps = yield* reader.getTodoDeps(TodoId.make("ro1"))
      expect(deps.length).toBe(0)
    }))
})
