import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { TaskCreateTool, TaskListTool, TaskGetTool, TaskUpdateTool, TaskRunTool } from "@gent/tools"
import {
  SubagentRunnerService,
  AgentRegistry,
  EventStore,
  Session,
  Branch,
  type ToolContext,
  type SessionId,
} from "@gent/core"
import { Storage } from "@gent/storage"
import { TaskService } from "@gent/runtime"

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
const baseDeps = Layer.mergeAll(
  Storage.Test(),
  EventStore.Test(),
  AgentRegistry.Live,
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
  test("creates a task and returns id", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        return yield* TaskCreateTool.execute({ subject: "Fix auth bug" }, ctx)
      }).pipe(Effect.provide(layer)),
    )
    expect(result.taskId).toBeDefined()
    expect(result.subject).toBe("Fix auth bug")
    expect(result.status).toBe("pending")
  })

  test("creates task with dependencies", async () => {
    const result = await Effect.runPromise(
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
        return t2
      }).pipe(Effect.provide(layer)),
    )
    expect(result.status).toBe("pending")
  })
})

describe("TaskListTool", () => {
  test("lists tasks for session", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        yield* TaskCreateTool.execute({ subject: "Task A" }, ctx)
        yield* TaskCreateTool.execute({ subject: "Task B" }, ctx)
        return yield* TaskListTool.execute({}, ctx)
      }).pipe(Effect.provide(layer)),
    )
    expect(result.tasks.length).toBe(2)
    expect(result.summary.total).toBe(2)
    expect(result.summary.pending).toBe(2)
  })

  test("returns empty for no tasks", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        return yield* TaskListTool.execute({}, ctx)
      }).pipe(Effect.provide(layer)),
    )
    expect(result.tasks.length).toBe(0)
    expect(result.summary).toBe("No tasks")
  })
})

describe("TaskGetTool", () => {
  test("returns task details", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        const created = yield* TaskCreateTool.execute(
          {
            subject: "Review code",
            description: "Full review of auth module",
          },
          ctx,
        )
        return yield* TaskGetTool.execute({ taskId: created.taskId }, ctx)
      }).pipe(Effect.provide(layer)),
    )
    expect(result.subject).toBe("Review code")
    expect(result.description).toBe("Full review of auth module")
  })

  test("returns error for missing task", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        return yield* TaskGetTool.execute({ taskId: "nonexistent" }, ctx)
      }).pipe(Effect.provide(layer)),
    )
    expect(result.error).toContain("not found")
  })
})

describe("TaskUpdateTool", () => {
  test("updates task status", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        const created = yield* TaskCreateTool.execute({ subject: "Fix it" }, ctx)
        return yield* TaskUpdateTool.execute(
          {
            taskId: created.taskId,
            status: "completed",
          },
          ctx,
        )
      }).pipe(Effect.provide(layer)),
    )
    expect(result.status).toBe("completed")
  })
})

describe("TaskRunTool", () => {
  test("returns running status", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        const created = yield* TaskCreateTool.execute(
          {
            subject: "Run analysis",
            agent: "explore" as const,
            prompt: "analyze the codebase",
          },
          ctx,
        )
        return yield* TaskRunTool.execute({ taskId: created.taskId }, ctx)
      }).pipe(Effect.provide(layer)),
    )
    expect(result.taskId).toBeDefined()
    expect(result.status).toBe("running")
  })
})
