import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { TaskCreateTool } from "@gent/extensions/task-tools/task-create"
import { TaskListTool } from "@gent/extensions/task-tools/task-list"
import { TaskGetTool } from "@gent/extensions/task-tools/task-get"
import { TaskUpdateTool } from "@gent/extensions/task-tools/task-update"
import { EventStore } from "@gent/core/domain/event"
import { SessionId } from "@gent/core/domain/ids"
import { TaskId } from "@gent/extensions/task-tools/domain"
import { getToolEffect } from "@gent/core/domain/capability/tool"
import { layer, makeCtx, narrowR, setup, withTaskWrite } from "./helpers.js"

describe("TaskCreateTool", () => {
  it.live("creates a task and returns id", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const result = yield* getToolEffect(TaskCreateTool)({ subject: "Fix auth bug" }, ctx)
        expect(result.taskId).toBeDefined()
        expect(result.subject).toBe("Fix auth bug")
        expect(result.status).toBe("pending")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )

  it.live("creates task with dependencies", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const t1 = yield* getToolEffect(TaskCreateTool)({ subject: "First" }, ctx)
        const t2 = yield* getToolEffect(TaskCreateTool)(
          {
            subject: "Second",
            blockedBy: [t1.taskId],
          },
          ctx,
        )
        expect(t2.blockedBy).toEqual([t1.taskId])
        expect(t2.status).toBe("pending")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )
})

describe("TaskListTool", () => {
  it.live("lists tasks for session", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        yield* getToolEffect(TaskCreateTool)({ subject: "Task A" }, ctx)
        yield* getToolEffect(TaskCreateTool)({ subject: "Task B" }, ctx)
        const result = yield* getToolEffect(TaskListTool)({}, ctx)
        expect(result.tasks.length).toBe(2)
        if (typeof result.summary === "string") {
          throw new Error("expected task summary counts")
        }
        expect(result.summary.total).toBe(2)
        expect(result.summary.pending).toBe(2)
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )

  it.live("returns empty for no tasks", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const result = yield* getToolEffect(TaskListTool)({}, ctx)
        expect(result.tasks.length).toBe(0)
        expect(result.summary).toBe("No tasks")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )
})

describe("TaskGetTool", () => {
  it.live("returns task details", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const created = yield* getToolEffect(TaskCreateTool)(
          {
            subject: "Review code",
            description: "Full review of auth module",
          },
          ctx,
        )
        const result = yield* getToolEffect(TaskGetTool)({ taskId: created.taskId }, ctx)
        if ("error" in result && result.error !== undefined) {
          throw new Error(result.error)
        }
        expect(result.subject).toBe("Review code")
        expect(result.description).toBe("Full review of auth module")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )

  it.live("returns error for missing task", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const result = yield* getToolEffect(TaskGetTool)(
          { taskId: TaskId.make("nonexistent") },
          ctx,
        )
        expect(result.error).toContain("not found")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )
})

describe("TaskUpdateTool", () => {
  it.live("updates task status", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const created = yield* getToolEffect(TaskCreateTool)({ subject: "Fix it" }, ctx)
        yield* getToolEffect(TaskUpdateTool)({ taskId: created.taskId, status: "in_progress" }, ctx)
        const result = yield* getToolEffect(TaskUpdateTool)(
          { taskId: created.taskId, status: "completed" },
          ctx,
        )
        expect(result.status).toBe("completed")
      }).pipe(withTaskWrite, Effect.provide(layer)),
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
                envelope.event.extensionId === "@gent/task-tools",
            ),
            Stream.take(1),
            Stream.runCollect,
          ),
        )
        yield* Effect.yieldNow
        const created = yield* getToolEffect(TaskCreateTool)({ subject: "Ship it" }, ctx)
        yield* getToolEffect(TaskUpdateTool)({ taskId: created.taskId, status: "in_progress" }, ctx)
        yield* getToolEffect(TaskUpdateTool)({ taskId: created.taskId, status: "completed" }, ctx)
        const envelopes = yield* Fiber.join(eventsFiber)
        const events = Array.from(envelopes, (envelope) => envelope.event._tag)
        expect(events).toContain("ExtensionStateChanged")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )

  it.live("returns a typed error for invalid status transitions", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const created = yield* getToolEffect(TaskCreateTool)({ subject: "Already done" }, ctx)
        yield* getToolEffect(TaskUpdateTool)({ taskId: created.taskId, status: "in_progress" }, ctx)
        yield* getToolEffect(TaskUpdateTool)({ taskId: created.taskId, status: "completed" }, ctx)

        const result = yield* getToolEffect(TaskUpdateTool)(
          { taskId: created.taskId, status: "in_progress" },
          ctx,
        )

        expect(result.error).toContain("Invalid task transition")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )
})
