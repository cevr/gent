import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { Task, TaskId } from "@gent/extensions/task-tools/domain"
import { TaskService } from "@gent/extensions/task-tools-service"
import { TaskStorage } from "@gent/extensions/task-tools-storage"
import { FIXTURE_DATE, layer, narrowR, setup, withTaskWrite } from "./helpers.js"

describe("TaskStorage metadata boundary", () => {
  it.live("decodes invalid stored metadata to undefined instead of crashing", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const taskService = yield* TaskService
        const taskStorage = yield* TaskStorage
        const sql = yield* SqlClient.SqlClient
        const created = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Metadata decode",
          metadata: { ok: true },
        })

        yield* sql`UPDATE tasks SET metadata = ${"{not-json"} WHERE id = ${created.id}`

        const loaded = yield* taskStorage.getTask(created.id)
        const listed = yield* taskStorage.listTasks(SessionId.make("s1"))

        expect(loaded?.metadata).toBeUndefined()
        expect(listed[0]?.metadata).toBeUndefined()
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )

  it.live("clears metadata when updated to null", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const taskService = yield* TaskService
        const created = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Metadata clear",
          metadata: { keep: false },
        })

        const updated = yield* taskService.update(created.id, { metadata: null })
        const reloaded = yield* taskService.get(created.id)

        expect(updated?.metadata).toBeUndefined()
        expect(reloaded?.metadata).toBeUndefined()
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )

  it.live("rejects non-serializable metadata", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const taskStorage = yield* TaskStorage
        const badMetadata: Record<string, unknown> = {}
        badMetadata["self"] = badMetadata
        const now = FIXTURE_DATE
        const result = yield* taskStorage
          .createTask(
            Task.make({
              id: TaskId.make("task-bad-metadata"),
              sessionId: SessionId.make("s1"),
              branchId: BranchId.make("b1"),
              subject: "Bad metadata",
              status: "pending",
              metadata: badMetadata,
              createdAt: now,
              updatedAt: now,
            }),
          )
          .pipe(Effect.flip)

        expect(result._tag).toBe("TaskStorageError")
        expect(result.message).toBe("Failed to create task")
        expect(String(result.cause)).toContain("JSON-serializable")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )
})

describe("TaskStorage.deleteTask", () => {
  it.live("rolls back dependency deletion when task delete fails", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const taskService = yield* TaskService
        const taskStorage = yield* TaskStorage
        const sql = yield* SqlClient.SqlClient
        const blocker = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Delete blocker",
        })
        const blocked = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Delete blocked",
        })

        yield* taskService.addDep(blocked.id, blocker.id)
        yield* sql.unsafe(`
        CREATE TRIGGER fail_task_delete_before
        BEFORE DELETE ON tasks
        WHEN OLD.id = '${blocker.id}'
        BEGIN
          SELECT RAISE(ABORT, 'boom');
        END;
      `)

        const result = yield* taskStorage.deleteTask(blocker.id).pipe(Effect.flip)

        expect(result._tag).toBe("TaskStorageError")
        expect(yield* taskService.getDeps(blocked.id)).toEqual([blocker.id])
        expect((yield* taskService.get(blocker.id))?.id).toBe(blocker.id)
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )
})
