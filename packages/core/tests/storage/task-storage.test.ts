import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { TaskStorage } from "@gent/core/extensions/task-tools-storage"
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
    id: SessionId.of("s1"),
    name: "Test",
    createdAt: now,
    updatedAt: now,
  })
  const branch = new Branch({
    id: BranchId.of("b1"),
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
    id: TaskId.of(id),
    sessionId: SessionId.of("s1"),
    branchId: BranchId.of("b1"),
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
      const got = yield* storage.getTask(TaskId.of("t1"))
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
      const got = yield* storage.getTask(TaskId.of("nonexistent"))
      expect(got).toBeUndefined()
    }))

  test("listTasks by session", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      const tasks = yield* storage.listTasks(SessionId.of("s1"))
      expect(tasks.length).toBe(2)
    }))

  test("listTasks by session + branch", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      const tasks = yield* storage.listTasks(SessionId.of("s1"), BranchId.of("b1"))
      expect(tasks.length).toBe(1)
      const empty = yield* storage.listTasks(SessionId.of("s1"), BranchId.of("other"))
      expect(empty.length).toBe(0)
    }))

  test("updateTask changes status", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      const updated = yield* storage.updateTask(TaskId.of("t1"), { status: "in_progress" })
      expect(updated).toBeDefined()
      expect(updated!.status).toBe("in_progress")
    }))

  test("updateTask returns undefined for missing", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const updated = yield* storage.updateTask(TaskId.of("nonexistent"), { status: "completed" })
      expect(updated).toBeUndefined()
    }))

  test("deleteTask removes task", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.deleteTask(TaskId.of("t1"))
      const got = yield* storage.getTask(TaskId.of("t1"))
      expect(got).toBeUndefined()
    }))

  test("task with metadata roundtrips", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1", { metadata: { key: "value", count: 42 } }))
      const got = yield* storage.getTask(TaskId.of("t1"))
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
      yield* storage.addTaskDep(TaskId.of("t2"), TaskId.of("t1"))
      const deps = yield* storage.getTaskDeps(TaskId.of("t2"))
      expect(deps).toEqual(["t1"])
    }))

  test("removeTaskDep", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep(TaskId.of("t2"), TaskId.of("t1"))
      yield* storage.removeTaskDep(TaskId.of("t2"), TaskId.of("t1"))
      const deps = yield* storage.getTaskDeps(TaskId.of("t2"))
      expect(deps.length).toBe(0)
    }))

  test("deleting task removes its own deps", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep(TaskId.of("t2"), TaskId.of("t1"))
      yield* storage.deleteTask(TaskId.of("t2"))
      // After deleting t2, its dep entries should also be gone
      const deps = yield* storage.getTaskDeps(TaskId.of("t2"))
      expect(deps.length).toBe(0)
    }))

  test("duplicate dep is idempotent", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep(TaskId.of("t2"), TaskId.of("t1"))
      yield* storage.addTaskDep(TaskId.of("t2"), TaskId.of("t1"))
      const deps = yield* storage.getTaskDeps(TaskId.of("t2"))
      expect(deps.length).toBe(1)
    }))
})
