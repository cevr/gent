import { describe, it, expect } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { TaskCreateTool } from "@gent/extensions/task-tools/task-create"
import { TaskListTool } from "@gent/extensions/task-tools/task-list"
import { TaskGetTool } from "@gent/extensions/task-tools/task-get"
import { TaskUpdateTool } from "@gent/extensions/task-tools/task-update"
import { DelegateTool } from "@gent/extensions/delegate/delegate-tool"
import { AllBuiltinAgents } from "@gent/extensions/all-agents"
import { Task } from "@gent/core/extensions/api"
import { getToolEffect } from "@gent/core/domain/capability/tool"
import { EventStore } from "@gent/core/domain/event"
import { dateFromMillis, Session, Branch } from "@gent/core/domain/message"
import { BranchId, SessionId, TaskId, ToolCallId } from "@gent/core/domain/ids"
import { BranchStorage } from "@gent/core/storage/branch-storage"
import { SessionStorage } from "@gent/core/storage/session-storage"
import { createToolTestLayer, testToolContext } from "@gent/core/test-utils/extension-harness"
import { toolPreset } from "../helpers/test-preset.js"
import { TaskService } from "@gent/extensions/task-tools-service"
import { TaskExtension } from "@gent/extensions/task-tools"
import { TaskStorage } from "@gent/extensions/task-tools-storage"

import type { AgentRunner } from "@gent/core/domain/agent"
import { AgentName, AgentRunResult } from "@gent/core/domain/agent"

const narrowR = <A, E, R>(e: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)
const FIXTURE_DATE = dateFromMillis(0)

const mockRunnerSuccess: AgentRunner = {
  run: (params) =>
    Effect.succeed(
      AgentRunResult.Success.make({
        text: `done: ${params.prompt}`,
        sessionId: SessionId.make("child-session"),
        agentName: params.agent.name,
        persistence: "ephemeral",
      }),
    ),
}

const makeCtx = Effect.succeed(
  testToolContext({
    sessionId: SessionId.make("s1"),
    branchId: BranchId.make("b1"),
    toolCallId: ToolCallId.make("tc1"),
    agent: {
      get: (name) => Effect.succeed(AllBuiltinAgents.find((a) => a.name === name)),
      require: (name) => {
        const agent = AllBuiltinAgents.find((a) => a.name === name)
        return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
      },
      run: (params) =>
        Effect.succeed(
          AgentRunResult.Success.make({
            text: `done: ${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
            persistence: "ephemeral",
          }),
        ),
      resolveDualModelPair: dieStub("agent.resolveDualModelPair"),
    },
  }),
)

const layer = createToolTestLayer({
  ...toolPreset,
  extensions: [TaskExtension],
  subagentRunner: mockRunnerSuccess,
})

const setup = Effect.gen(function* () {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const now = FIXTURE_DATE
  yield* sessionStorage.createSession(
    new Session({
      id: SessionId.make("s1"),
      name: "Test",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* branchStorage.createBranch(
    new Branch({
      id: BranchId.make("b1"),
      sessionId: SessionId.make("s1"),
      createdAt: now,
    }),
  )
})

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
      }).pipe(Effect.provide(layer)),
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
      }).pipe(Effect.provide(layer)),
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
      }).pipe(Effect.provide(layer)),
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
      }).pipe(Effect.provide(layer)),
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
      }).pipe(Effect.provide(layer)),
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
      }).pipe(Effect.provide(layer)),
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
        // Must follow valid transition: pending → in_progress → completed
        yield* getToolEffect(TaskUpdateTool)({ taskId: created.taskId, status: "in_progress" }, ctx)
        const result = yield* getToolEffect(TaskUpdateTool)(
          { taskId: created.taskId, status: "completed" },
          ctx,
        )
        expect(result.status).toBe("completed")
      }).pipe(Effect.provide(layer)),
    ),
  )

  it.live("publishes completed event when status becomes completed", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const eventStore = yield* EventStore
        const eventsFiber = yield* Effect.forkChild(
          eventStore.subscribe({ sessionId: SessionId.make("s1") }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "TaskCompleted"),
            Stream.take(1),
            Stream.runCollect,
          ),
        )
        yield* Effect.yieldNow
        const created = yield* getToolEffect(TaskCreateTool)({ subject: "Ship it" }, ctx)
        // Valid transition: pending → in_progress → completed
        yield* getToolEffect(TaskUpdateTool)({ taskId: created.taskId, status: "in_progress" }, ctx)
        yield* getToolEffect(TaskUpdateTool)({ taskId: created.taskId, status: "completed" }, ctx)
        const envelopes = yield* Fiber.join(eventsFiber)
        const events = Array.from(envelopes, (envelope) => envelope.event._tag)
        expect(events).toContain("TaskCompleted")
      }).pipe(Effect.provide(layer)),
    ),
  )
})

describe("TaskService.remove", () => {
  it.live("publishes deleted event", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const eventStore = yield* EventStore
        const taskService = yield* TaskService
        const eventsFiber = yield* Effect.forkChild(
          eventStore.subscribe({ sessionId: SessionId.make("s1") }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "TaskDeleted"),
            Stream.take(1),
            Stream.runCollect,
          ),
        )
        yield* Effect.yieldNow
        const created = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Ephemeral debug task",
        })
        yield* taskService.remove(created.id)
        const envelopes = yield* Fiber.join(eventsFiber)
        const events = Array.from(envelopes, (envelope) => envelope.event._tag)
        expect(events).toContain("TaskDeleted")
      }).pipe(Effect.provide(layer)),
    ),
  )

  it.live("removes dependency edges referencing the deleted task", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const taskService = yield* TaskService
        const blocker = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Blocker",
        })
        const blocked = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Blocked",
        })

        yield* taskService.addDep(blocked.id, blocker.id)
        expect(yield* taskService.getDeps(blocked.id)).toEqual([blocker.id])

        yield* taskService.remove(blocker.id)
        expect(yield* taskService.getDeps(blocked.id)).toEqual([])
      }).pipe(Effect.provide(layer)),
    ),
  )
})

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
      }).pipe(Effect.provide(layer)),
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
      }).pipe(Effect.provide(layer)),
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
      }).pipe(Effect.provide(layer)),
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
      }).pipe(Effect.provide(layer)),
    ),
  )
})

describe("DelegateTool background mode", () => {
  it.live("returns running status via background param", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const ctx = yield* makeCtx
        const result = yield* getToolEffect(DelegateTool)(
          {
            agent: AgentName.make("explore"),
            task: "analyze the codebase",
            background: true,
          },
          ctx,
        )
        if (!("taskId" in result) || result.taskId === undefined) {
          throw new Error("expected background delegate task")
        }
        expect(result.taskId).toBeDefined()
        expect(result.status).toBe("running")
      }).pipe(Effect.provide(layer)),
    ),
  )
})
