import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { TaskCreateTool } from "@gent/core/tools/task-create"
import { TaskListTool } from "@gent/core/tools/task-list"
import { TaskGetTool } from "@gent/core/tools/task-get"
import { TaskUpdateTool } from "@gent/core/tools/task-update"
import { DelegateTool } from "@gent/core/tools/delegate"
import { SubagentRunnerService, Agents } from "@gent/core/domain/agent"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { EventStore } from "@gent/core/domain/event"
import { Session, Branch } from "@gent/core/domain/message"
import type { ToolContext } from "@gent/core/domain/tool"
import type { SessionId } from "@gent/core/domain/ids"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { TaskService } from "@gent/core/runtime/task-service"

const platformLayer = BunServices.layer

const mockRunnerSuccess = Layer.succeed(SubagentRunnerService, {
  run: (params) =>
    Effect.succeed({
      _tag: "success" as const,
      text: `done: ${params.prompt}`,
      sessionId: "child-session" as SessionId,
      agentName: params.agent.name,
    }),
})

const ctx: ToolContext = {
  sessionId: "s1" as SessionId,
  branchId: "b1",
  toolCallId: "tc1",
}

// Build a full layer with real Storage + TaskService
const TestExtRegistry = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin",
      sourcePath: "test",
      setup: { agents: Object.values(Agents) },
    },
  ]),
)
const baseDeps = Layer.mergeAll(
  Storage.Test(),
  EventStore.Memory,
  TestExtRegistry,
  mockRunnerSuccess,
  platformLayer,
)
const taskServiceLayer = Layer.provide(TaskService.Live, baseDeps)
const layer = Layer.mergeAll(baseDeps, taskServiceLayer)

const setup = Effect.gen(function* () {
  const storage = yield* Storage
  const now = new Date()
  yield* storage.createSession(
    new Session({
      id: "s1" as SessionId,
      name: "Test",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* storage.createBranch(
    new Branch({
      id: "b1",
      sessionId: "s1" as SessionId,
      createdAt: now,
    }),
  )
})

describe("TaskCreateTool", () => {
  it.live("creates a task and returns id", () =>
    Effect.gen(function* () {
      yield* setup
      const result = yield* TaskCreateTool.execute({ subject: "Fix auth bug" }, ctx)
      expect(result.taskId).toBeDefined()
      expect(result.subject).toBe("Fix auth bug")
      expect(result.status).toBe("pending")
    }).pipe(Effect.provide(layer)),
  )

  it.live("creates task with dependencies", () =>
    Effect.gen(function* () {
      yield* setup
      const t1 = yield* TaskCreateTool.execute({ subject: "First" }, ctx)
      const t2 = yield* TaskCreateTool.execute(
        {
          subject: "Second",
          blockedBy: [t1.taskId],
        },
        ctx,
      )
      expect(t2.blockedBy).toEqual([t1.taskId])
      expect(t2.status).toBe("pending")
    }).pipe(Effect.provide(layer)),
  )
})

describe("TaskListTool", () => {
  it.live("lists tasks for session", () =>
    Effect.gen(function* () {
      yield* setup
      yield* TaskCreateTool.execute({ subject: "Task A" }, ctx)
      yield* TaskCreateTool.execute({ subject: "Task B" }, ctx)
      const result = yield* TaskListTool.execute({}, ctx)
      expect(result.tasks.length).toBe(2)
      expect(result.summary.total).toBe(2)
      expect(result.summary.pending).toBe(2)
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns empty for no tasks", () =>
    Effect.gen(function* () {
      yield* setup
      const result = yield* TaskListTool.execute({}, ctx)
      expect(result.tasks.length).toBe(0)
      expect(result.summary).toBe("No tasks")
    }).pipe(Effect.provide(layer)),
  )
})

describe("TaskGetTool", () => {
  it.live("returns task details", () =>
    Effect.gen(function* () {
      yield* setup
      const created = yield* TaskCreateTool.execute(
        {
          subject: "Review code",
          description: "Full review of auth module",
        },
        ctx,
      )
      const result = yield* TaskGetTool.execute({ taskId: created.taskId }, ctx)
      expect(result.subject).toBe("Review code")
      expect(result.description).toBe("Full review of auth module")
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns error for missing task", () =>
    Effect.gen(function* () {
      yield* setup
      const result = yield* TaskGetTool.execute({ taskId: "nonexistent" }, ctx)
      expect(result.error).toContain("not found")
    }).pipe(Effect.provide(layer)),
  )
})

describe("TaskUpdateTool", () => {
  it.live("updates task status", () =>
    Effect.gen(function* () {
      yield* setup
      const created = yield* TaskCreateTool.execute({ subject: "Fix it" }, ctx)
      // Must follow valid transition: pending → in_progress → completed
      yield* TaskUpdateTool.execute({ taskId: created.taskId, status: "in_progress" }, ctx)
      const result = yield* TaskUpdateTool.execute(
        { taskId: created.taskId, status: "completed" },
        ctx,
      )
      expect(result.status).toBe("completed")
    }).pipe(Effect.provide(layer)),
  )

  it.live("publishes completed event when status becomes completed", () =>
    Effect.gen(function* () {
      yield* setup
      const eventStore = yield* EventStore
      const created = yield* TaskCreateTool.execute({ subject: "Ship it" }, ctx)
      // Valid transition: pending → in_progress → completed
      yield* TaskUpdateTool.execute({ taskId: created.taskId, status: "in_progress" }, ctx)
      yield* TaskUpdateTool.execute({ taskId: created.taskId, status: "completed" }, ctx)
      const envelopes = yield* eventStore
        .subscribe({ sessionId: "s1" as SessionId })
        .pipe(Stream.take(3), Stream.runCollect)
      const events = Array.from(envelopes, (envelope) => envelope.event._tag)
      expect(events).toContain("TaskCompleted")
    }).pipe(Effect.provide(layer)),
  )
})

describe("TaskService.remove", () => {
  it.live("publishes deleted event", () =>
    Effect.gen(function* () {
      yield* setup
      const eventStore = yield* EventStore
      const taskService = yield* TaskService
      const created = yield* taskService.create({
        sessionId: "s1" as SessionId,
        branchId: "b1",
        subject: "Ephemeral debug task",
      })
      yield* taskService.remove(created.id)
      const envelopes = yield* eventStore
        .subscribe({ sessionId: "s1" as SessionId })
        .pipe(Stream.take(2), Stream.runCollect)
      const events = Array.from(envelopes, (envelope) => envelope.event._tag)
      expect(events).toContain("TaskDeleted")
    }).pipe(Effect.provide(layer)),
  )
})

describe("DelegateTool background mode", () => {
  it.live("returns running status via background param", () =>
    Effect.gen(function* () {
      yield* setup
      const result = yield* DelegateTool.execute(
        {
          agent: "explore" as const,
          task: "analyze the codebase",
          background: true,
        },
        ctx,
      )
      expect(result.taskId).toBeDefined()
      expect(result.status).toBe("running")
    }).pipe(Effect.provide(layer)),
  )
})
