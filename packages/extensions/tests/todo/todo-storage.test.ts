import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { Todo, TodoId } from "../../src/todo/domain.js"
import { TodoService } from "../../src/todo-service.js"
import { TodoStorage } from "../../src/todo-storage.js"
import { FIXTURE_DATE, layer, narrowR, setup, withTodoWrite } from "./helpers.js"

describe("TodoStorage metadata boundary", () => {
  it.live("decodes invalid stored metadata to undefined instead of crashing", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const todoService = yield* TodoService
        const todoStorage = yield* TodoStorage
        const sql = yield* SqlClient.SqlClient
        const created = yield* todoService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Metadata decode",
          metadata: { ok: true },
        })

        yield* sql`UPDATE todos SET metadata = ${"{not-json"} WHERE id = ${created.id}`

        const loaded = yield* todoStorage.getTodo(created.id)
        const listed = yield* todoStorage.listTodos(SessionId.make("s1"))

        expect(loaded?.metadata).toBeUndefined()
        expect(listed[0]?.metadata).toBeUndefined()
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )

  it.live("clears metadata when updated to null", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const todoService = yield* TodoService
        const created = yield* todoService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Metadata clear",
          metadata: { keep: false },
        })

        const updated = yield* todoService.update(created.id, { metadata: null })
        const reloaded = yield* todoService.get(created.id)

        expect(updated?.metadata).toBeUndefined()
        expect(reloaded?.metadata).toBeUndefined()
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )

  it.live("rejects non-serializable metadata", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const todoStorage = yield* TodoStorage
        const badMetadata: Record<string, unknown> = {}
        badMetadata["self"] = badMetadata
        const now = FIXTURE_DATE
        const result = yield* todoStorage
          .createTodo(
            Todo.make({
              id: TodoId.make("todo-bad-metadata"),
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

        expect(result._tag).toBe("TodoStorageError")
        expect(result.message).toBe("Failed to create todo")
        expect(String(result.cause)).toContain("JSON-serializable")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )
})

describe("TodoStorage.deleteTodo", () => {
  it.live("rolls back dependency deletion when todo delete fails", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const todoService = yield* TodoService
        const todoStorage = yield* TodoStorage
        const sql = yield* SqlClient.SqlClient
        const blocker = yield* todoService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Delete blocker",
        })
        const blocked = yield* todoService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Delete blocked",
        })

        yield* todoService.addDep(blocked.id, blocker.id)
        yield* sql.unsafe(`
        CREATE TRIGGER fail_todo_delete_before
        BEFORE DELETE ON todos
        WHEN OLD.id = '${blocker.id}'
        BEGIN
          SELECT RAISE(ABORT, 'boom');
        END;
      `)

        const result = yield* todoStorage.deleteTodo(blocker.id).pipe(Effect.flip)

        expect(result._tag).toBe("TodoStorageError")
        expect(yield* todoService.getDeps(blocked.id)).toEqual([blocker.id])
        expect((yield* todoService.get(blocker.id))?.id).toBe(blocker.id)
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )
})
