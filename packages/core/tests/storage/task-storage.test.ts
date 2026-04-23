import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { TaskStorage, TaskStorageReadOnly } from "@gent/extensions/task-tools-storage"
import { Session, Branch } from "@gent/core/domain/message"
import { Task } from "@gent/core/domain/task"
import { SessionId, BranchId, TaskId } from "@gent/core/domain/ids"

// Single in-memory db: TestWithSql exposes both Storage and SqlClient.
// TaskStorage.Live consumes SqlClient, so we provide TestWithSql to it.
const baseLayer = Storage.TestWithSql()
const taskStorageLayer = Layer.provide(TaskStorage.Live, baseLayer)
const testLayer = Layer.merge(baseLayer, taskStorageLayer)

const test = it.live.layer(testLayer)

const setup = Effect.gen(function* () {
  const storage = yield* Storage
  const taskStorage = yield* TaskStorage
  const now = new Date()
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
  yield* storage.createSession(session)
  yield* storage.createBranch(branch)
  return { storage: taskStorage, session, branch }
})

const makeTask = (id: string, overrides?: Partial<ConstructorParameters<typeof Task>[0]>) => {
  const now = new Date()
  return new Task({
    id: TaskId.make(id),
    sessionId: SessionId.make("s1"),
    branchId: BranchId.make("b1"),
    subject: `Task ${id}`,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
}

describe("Task Storage", () => {
  test("createTask + getTask roundtrip", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const task = makeTask("t1", { description: "Do something", cwd: "/tmp" })
      yield* storage.createTask(task)
      const got = yield* storage.getTask(TaskId.make("t1"))
      expect(got).toBeDefined()
      expect(got!.id).toBe("t1")
      expect(got!.subject).toBe("Task t1")
      expect(got!.description).toBe("Do something")
      expect(got!.status).toBe("pending")
      expect(got!.cwd).toBe("/tmp")
    }))

  test("getTask returns undefined for missing", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const got = yield* storage.getTask(TaskId.make("nonexistent"))
      expect(got).toBeUndefined()
    }))

  test("listTasks by session", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      const tasks = yield* storage.listTasks(SessionId.make("s1"))
      expect(tasks.length).toBe(2)
    }))

  test("listTasks by session + branch", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      const tasks = yield* storage.listTasks(SessionId.make("s1"), BranchId.make("b1"))
      expect(tasks.length).toBe(1)
      const empty = yield* storage.listTasks(SessionId.make("s1"), BranchId.make("other"))
      expect(empty.length).toBe(0)
    }))

  test("updateTask changes status", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      const updated = yield* storage.updateTask(TaskId.make("t1"), { status: "in_progress" })
      expect(updated).toBeDefined()
      expect(updated!.status).toBe("in_progress")
    }))

  test("updateTask returns undefined for missing", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const updated = yield* storage.updateTask(TaskId.make("nonexistent"), { status: "completed" })
      expect(updated).toBeUndefined()
    }))

  test("deleteTask removes task", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.deleteTask(TaskId.make("t1"))
      const got = yield* storage.getTask(TaskId.make("t1"))
      expect(got).toBeUndefined()
    }))

  test("task with metadata roundtrips", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1", { metadata: { key: "value", count: 42 } }))
      const got = yield* storage.getTask(TaskId.make("t1"))
      expect(got).toBeDefined()
      const meta = got!.metadata as Record<string, unknown>
      expect(meta.key).toBe("value")
      expect(meta.count).toBe(42)
    }))
})

describe("Task Dependencies", () => {
  test("addTaskDep + getTaskDeps", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep(TaskId.make("t2"), TaskId.make("t1"))
      const deps = yield* storage.getTaskDeps(TaskId.make("t2"))
      expect(deps).toEqual(["t1"])
    }))

  test("removeTaskDep", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep(TaskId.make("t2"), TaskId.make("t1"))
      yield* storage.removeTaskDep(TaskId.make("t2"), TaskId.make("t1"))
      const deps = yield* storage.getTaskDeps(TaskId.make("t2"))
      expect(deps.length).toBe(0)
    }))

  test("deleting task removes its own deps", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep(TaskId.make("t2"), TaskId.make("t1"))
      yield* storage.deleteTask(TaskId.make("t2"))
      // After deleting t2, its dep entries should also be gone
      const deps = yield* storage.getTaskDeps(TaskId.make("t2"))
      expect(deps.length).toBe(0)
    }))

  test("deleteTask rolls back dependency deletion when task delete fails", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep(TaskId.make("t2"), TaskId.make("t1"))
      yield* sql.unsafe(`
        CREATE TRIGGER fail_task_delete
        BEFORE DELETE ON tasks
        WHEN old.id = 't1'
        BEGIN
          SELECT RAISE(ABORT, 'forced task delete failure');
        END
      `)

      const error = yield* Effect.flip(storage.deleteTask(TaskId.make("t1")))

      expect(error._tag).toBe("TaskStorageError")
      expect(yield* storage.getTask(TaskId.make("t1"))).toBeDefined()
      expect(yield* storage.getTaskDeps(TaskId.make("t2"))).toEqual(["t1"])
    }))

  test("duplicate dep is idempotent", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep(TaskId.make("t2"), TaskId.make("t1"))
      yield* storage.addTaskDep(TaskId.make("t2"), TaskId.make("t1"))
      const deps = yield* storage.getTaskDeps(TaskId.make("t2"))
      expect(deps.length).toBe(1)
    }))
})

describe("TaskStorageReadOnly", () => {
  test("TaskStorage.Live provides the read-only Tag with working read methods", () =>
    Effect.gen(function* () {
      // Setup session/branch + write via the wide Tag, then read back through
      // the read-only Tag — proves both Tags resolve to the same state.
      yield* setup
      const writer = yield* TaskStorage
      yield* writer.createTask(makeTask("ro1", { description: "read-only proof" }))

      const reader = yield* TaskStorageReadOnly
      const got = yield* reader.getTask(TaskId.make("ro1"))
      expect(got).toBeDefined()
      expect(got!.description).toBe("read-only proof")

      const listed = yield* reader.listTasks(SessionId.make("s1"))
      expect(listed.some((t) => t.id === "ro1")).toBe(true)

      // getTaskDeps reachable from the read-only surface
      const deps = yield* reader.getTaskDeps(TaskId.make("ro1"))
      expect(deps.length).toBe(0)
    }))
})
