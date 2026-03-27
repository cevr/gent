import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { Session, Branch } from "@gent/core/domain/message"
import { Task } from "@gent/core/domain/task"
import type { SessionId, BranchId, TaskId } from "@gent/core/domain/ids"

const test = it.live.layer(Storage.Test())

const setup = Effect.gen(function* () {
  const storage = yield* Storage
  const now = new Date()
  const session = new Session({
    id: "s1" as SessionId,
    name: "Test",
    createdAt: now,
    updatedAt: now,
  })
  const branch = new Branch({
    id: "b1" as BranchId,
    sessionId: session.id,
    createdAt: now,
  })
  yield* storage.createSession(session)
  yield* storage.createBranch(branch)
  return { storage, session, branch }
})

const makeTask = (id: string, overrides?: Partial<ConstructorParameters<typeof Task>[0]>) => {
  const now = new Date()
  return new Task({
    id: id as TaskId,
    sessionId: "s1" as SessionId,
    branchId: "b1" as BranchId,
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
      const got = yield* storage.getTask("t1" as TaskId)
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
      const got = yield* storage.getTask("nonexistent" as TaskId)
      expect(got).toBeUndefined()
    }))

  test("listTasks by session", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      const tasks = yield* storage.listTasks("s1" as SessionId)
      expect(tasks.length).toBe(2)
    }))

  test("listTasks by session + branch", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      const tasks = yield* storage.listTasks("s1" as SessionId, "b1" as BranchId)
      expect(tasks.length).toBe(1)
      const empty = yield* storage.listTasks("s1" as SessionId, "other" as BranchId)
      expect(empty.length).toBe(0)
    }))

  test("updateTask changes status", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      const updated = yield* storage.updateTask("t1" as TaskId, { status: "in_progress" })
      expect(updated).toBeDefined()
      expect(updated!.status).toBe("in_progress")
    }))

  test("updateTask returns undefined for missing", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      const updated = yield* storage.updateTask("nonexistent" as TaskId, { status: "completed" })
      expect(updated).toBeUndefined()
    }))

  test("deleteTask removes task", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.deleteTask("t1" as TaskId)
      const got = yield* storage.getTask("t1" as TaskId)
      expect(got).toBeUndefined()
    }))

  test("task with metadata roundtrips", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1", { metadata: { key: "value", count: 42 } }))
      const got = yield* storage.getTask("t1" as TaskId)
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
      yield* storage.addTaskDep("t2" as TaskId, "t1" as TaskId)
      const deps = yield* storage.getTaskDeps("t2" as TaskId)
      expect(deps).toEqual(["t1"])
    }))

  test("getTaskDependents", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.createTask(makeTask("t3"))
      yield* storage.addTaskDep("t2" as TaskId, "t1" as TaskId)
      yield* storage.addTaskDep("t3" as TaskId, "t1" as TaskId)
      const dependents = yield* storage.getTaskDependents("t1" as TaskId)
      expect(dependents.length).toBe(2)
      expect(dependents).toContain("t2")
      expect(dependents).toContain("t3")
    }))

  test("removeTaskDep", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep("t2" as TaskId, "t1" as TaskId)
      yield* storage.removeTaskDep("t2" as TaskId, "t1" as TaskId)
      const deps = yield* storage.getTaskDeps("t2" as TaskId)
      expect(deps.length).toBe(0)
    }))

  test("deleting task removes its own deps", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep("t2" as TaskId, "t1" as TaskId)
      // Deleting t2 (the task with the dep) removes the dep row
      yield* storage.deleteTask("t2" as TaskId)
      const dependents = yield* storage.getTaskDependents("t1" as TaskId)
      expect(dependents.length).toBe(0)
    }))

  test("duplicate dep is idempotent", () =>
    Effect.gen(function* () {
      const { storage } = yield* setup
      yield* storage.createTask(makeTask("t1"))
      yield* storage.createTask(makeTask("t2"))
      yield* storage.addTaskDep("t2" as TaskId, "t1" as TaskId)
      yield* storage.addTaskDep("t2" as TaskId, "t1" as TaskId)
      const deps = yield* storage.getTaskDeps("t2" as TaskId)
      expect(deps.length).toBe(1)
    }))
})
