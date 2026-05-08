import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { TodoCreateTool, TodoGetTool, TodoListTool, TodoUpdateTool } from "../../src/todo/tools.js"
import { EventStore } from "@gent/core-internal/domain/event"
import { SessionId } from "@gent/core-internal/domain/ids"
import { TodoId } from "../../src/todo/domain.js"
import { getToolEffect } from "@gent/core-internal/domain/capability/tool"
import { layer, makeCtx, narrowR, setup, withTodoWrite } from "./helpers.js"

describe("TodoCreateTool", () => {
  it.live("creates a todo and returns id", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const result = yield* getToolEffect(TodoCreateTool)({ subject: "Fix auth bug" }, ctx)
        expect(result.todoId).toBeDefined()
        expect(result.subject).toBe("Fix auth bug")
        expect(result.status).toBe("pending")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )

  it.live("creates todo with dependencies", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const t1 = yield* getToolEffect(TodoCreateTool)({ subject: "First" }, ctx)
        const t2 = yield* getToolEffect(TodoCreateTool)(
          {
            subject: "Second",
            blockedBy: [t1.todoId],
          },
          ctx,
        )
        expect(t2.blockedBy).toEqual([t1.todoId])
        expect(t2.status).toBe("pending")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )
})

describe("TodoListTool", () => {
  it.live("lists todos for session", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        yield* getToolEffect(TodoCreateTool)({ subject: "Todo A" }, ctx)
        yield* getToolEffect(TodoCreateTool)({ subject: "Todo B" }, ctx)
        const result = yield* getToolEffect(TodoListTool)({}, ctx)
        expect(result.todos.length).toBe(2)
        if (typeof result.summary === "string") {
          throw new Error("expected todo summary counts")
        }
        expect(result.summary.total).toBe(2)
        expect(result.summary.pending).toBe(2)
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )

  it.live("returns empty for no todos", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const result = yield* getToolEffect(TodoListTool)({}, ctx)
        expect(result.todos.length).toBe(0)
        expect(result.summary).toBe("No todos")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )
})

describe("TodoGetTool", () => {
  it.live("returns todo details", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const created = yield* getToolEffect(TodoCreateTool)(
          {
            subject: "Review code",
            description: "Full review of auth module",
          },
          ctx,
        )
        const result = yield* getToolEffect(TodoGetTool)({ todoId: created.todoId }, ctx)
        if ("error" in result && result.error !== undefined) {
          throw new Error(result.error)
        }
        expect(result.subject).toBe("Review code")
        expect(result.description).toBe("Full review of auth module")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )

  it.live("returns error for missing todo", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const result = yield* getToolEffect(TodoGetTool)(
          { todoId: TodoId.make("nonexistent") },
          ctx,
        )
        expect(result.error).toContain("not found")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )
})

describe("TodoUpdateTool", () => {
  it.live("updates todo status", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const created = yield* getToolEffect(TodoCreateTool)({ subject: "Fix it" }, ctx)
        yield* getToolEffect(TodoUpdateTool)({ todoId: created.todoId, status: "in_progress" }, ctx)
        const result = yield* getToolEffect(TodoUpdateTool)(
          { todoId: created.todoId, status: "completed" },
          ctx,
        )
        expect(result.status).toBe("completed")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )

  it.live("publishes state change when status becomes completed", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const eventStore = yield* EventStore
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
        const created = yield* getToolEffect(TodoCreateTool)({ subject: "Ship it" }, ctx)
        yield* getToolEffect(TodoUpdateTool)({ todoId: created.todoId, status: "in_progress" }, ctx)
        yield* getToolEffect(TodoUpdateTool)({ todoId: created.todoId, status: "completed" }, ctx)
        const envelopes = yield* Fiber.join(eventsFiber)
        const events = Array.from(envelopes, (envelope) => envelope.event._tag)
        expect(events).toContain("ExtensionStateChanged")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )

  it.live("returns a typed error for invalid status transitions", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const created = yield* getToolEffect(TodoCreateTool)({ subject: "Already done" }, ctx)
        yield* getToolEffect(TodoUpdateTool)({ todoId: created.todoId, status: "in_progress" }, ctx)
        yield* getToolEffect(TodoUpdateTool)({ todoId: created.todoId, status: "completed" }, ctx)

        const result = yield* getToolEffect(TodoUpdateTool)(
          { todoId: created.todoId, status: "in_progress" },
          ctx,
        )

        expect(result.error).toContain("Invalid todo transition")
      }).pipe(withTodoWrite, Effect.provide(layer)),
    ),
  )
})
