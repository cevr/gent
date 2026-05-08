import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { TodoService } from "../../src/todo-service.js"
import { EventStore } from "@gent/core-internal/domain/event"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { SqlClient } from "effect/unstable/sql"
import { layer, narrowR, setup, withTodoWrite } from "./helpers.js"

describe("TodoService.remove", () => {
  it.live("publishes state change on delete", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const eventStore = yield* EventStore
        const todoService = yield* TodoService
        const eventsFiber = yield* Effect.forkChild(
          eventStore.subscribe({ sessionId: SessionId.make("s1") }).pipe(
            Stream.filter(
              (envelope) =>
                envelope.event._tag === "ExtensionStateChanged" &&
                envelope.event.extensionId === "@gent/todo",
            ),
            Stream.take(1),
            Stream.runCollect,
          ),
        )
        yield* Effect.yieldNow
        const created = yield* todoService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Ephemeral debug todo",
        })
        yield* todoService.remove(created.id)
        const envelopes = yield* Fiber.join(eventsFiber)
        const events = Array.from(envelopes, (envelope) => envelope.event._tag)
        expect(events).toContain("ExtensionStateChanged")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )

  it.live("removes dependency edges referencing the deleted todo", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const todoService = yield* TodoService
        const blocker = yield* todoService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Blocker",
        })
        const blocked = yield* todoService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Blocked",
        })

        yield* todoService.addDep(blocked.id, blocker.id)
        expect(yield* todoService.getDeps(blocked.id)).toEqual([blocker.id])

        yield* todoService.remove(blocker.id)
        expect(yield* todoService.getDeps(blocked.id)).toEqual([])
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )

  it.live("returns storage failures as typed errors instead of defects", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const todoService = yield* TodoService
        const sql = yield* SqlClient.SqlClient
        const todo = yield* todoService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Delete failure stays typed",
        })

        yield* sql.unsafe(`
        CREATE TRIGGER fail_todo_service_delete
        BEFORE DELETE ON todos
        WHEN OLD.id = '${todo.id}'
        BEGIN
          SELECT RAISE(ABORT, 'typed service failure');
        END;
      `)

        const error = yield* todoService.remove(todo.id).pipe(Effect.flip)

        expect(error._tag).toBe("TodoStorageError")
        expect(error.message).toBe("Failed to delete todo")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )
})
