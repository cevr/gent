/**
 * TaskProjection regression locks.
 *
 * Locks the contract that the task list UI snapshot is derived from
 * `TaskStorage` on demand — no actor mirror, no event reduction. The
 * projection's `query` is read-only; output shape matches `TaskUiModel`
 * so the existing TUI snapshot reader is unchanged.
 *
 * Tied to planify Commit 3 — the smallest end-to-end test of the projection
 * model. If the projection drifts from on-disk state, every later commit's
 * use of the projection model becomes suspect.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { Session, Branch } from "@gent/core/domain/message"
import { Task } from "@gent/core/domain/task"
import { SessionId, BranchId, TaskId } from "@gent/core/domain/ids"
import { TaskStorage } from "@gent/extensions/task-tools-storage"
import { TaskProjection } from "@gent/extensions/task-tools/projection"

const baseLayer = Storage.TestWithSql()
const taskStorageLayer = Layer.provide(TaskStorage.Live, baseLayer)
const testLayer = Layer.merge(baseLayer, taskStorageLayer)

const test = it.live.layer(testLayer)

const sessionId = SessionId.of("s1")
const branchId = BranchId.of("b1")
const otherBranchId = BranchId.of("b2")

const setup = Effect.gen(function* () {
  const storage = yield* Storage
  const taskStorage = yield* TaskStorage
  const now = new Date()
  yield* storage.createSession(
    new Session({ id: sessionId, name: "S", createdAt: now, updatedAt: now }),
  )
  yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
  yield* storage.createBranch(new Branch({ id: otherBranchId, sessionId, createdAt: now }))
  return { taskStorage }
})

const makeTask = (id: string, branch: BranchId, status: Task["status"] = "pending") => {
  const now = new Date()
  return new Task({
    id: TaskId.of(id),
    sessionId,
    branchId: branch,
    subject: `Task ${id}`,
    status,
    createdAt: now,
    updatedAt: now,
  })
}

const ctx = (branch?: BranchId) => ({
  sessionId,
  branchId: branch,
  cwd: "/tmp",
  home: "/tmp",
})

describe("TaskProjection", () => {
  test("query returns empty tasks when storage is empty", () =>
    Effect.gen(function* () {
      yield* setup
      const result = yield* TaskProjection.query(ctx(branchId))
      expect(result.tasks).toEqual([])
    }))

  test("query returns tasks from storage in creation order", () =>
    Effect.gen(function* () {
      const { taskStorage } = yield* setup
      yield* taskStorage.createTask(makeTask("t1", branchId))
      yield* taskStorage.createTask(makeTask("t2", branchId))
      yield* taskStorage.createTask(makeTask("t3", branchId, "in_progress"))
      const result = yield* TaskProjection.query(ctx(branchId))
      expect(result.tasks).toEqual([
        { id: "t1", subject: "Task t1", status: "pending" },
        { id: "t2", subject: "Task t2", status: "pending" },
        { id: "t3", subject: "Task t3", status: "in_progress" },
      ])
    }))

  test("query honors branchId filter — other branches excluded", () =>
    Effect.gen(function* () {
      const { taskStorage } = yield* setup
      yield* taskStorage.createTask(makeTask("on-b1", branchId))
      yield* taskStorage.createTask(makeTask("on-b2", otherBranchId))
      const onB1 = yield* TaskProjection.query(ctx(branchId))
      expect(onB1.tasks.map((t) => t.id)).toEqual(["on-b1"])
      const onB2 = yield* TaskProjection.query(ctx(otherBranchId))
      expect(onB2.tasks.map((t) => t.id)).toEqual(["on-b2"])
    }))

  test("query without branchId returns all session tasks across branches", () =>
    Effect.gen(function* () {
      const { taskStorage } = yield* setup
      yield* taskStorage.createTask(makeTask("on-b1", branchId))
      yield* taskStorage.createTask(makeTask("on-b2", otherBranchId))
      const all = yield* TaskProjection.query(ctx())
      expect(all.tasks.map((t) => t.id).sort()).toEqual(["on-b1", "on-b2"])
    }))

  test("projection id is stable for collision detection", () =>
    Effect.sync(() => {
      expect(TaskProjection.id).toBe("task-list")
    }))

  test("query reflects updates after task is mutated", () =>
    Effect.gen(function* () {
      const { taskStorage } = yield* setup
      yield* taskStorage.createTask(makeTask("t1", branchId))
      const before = yield* TaskProjection.query(ctx(branchId))
      expect(before.tasks[0]?.status).toBe("pending")
      yield* taskStorage.updateTask(TaskId.of("t1"), { status: "completed" })
      const after = yield* TaskProjection.query(ctx(branchId))
      expect(after.tasks[0]?.status).toBe("completed")
    }))
})
