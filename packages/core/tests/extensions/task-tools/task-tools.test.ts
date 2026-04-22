import { describe, it, expect } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { TaskCreateTool } from "@gent/extensions/task-tools/task-create"
import { TaskListTool } from "@gent/extensions/task-tools/task-list"
import { TaskGetTool } from "@gent/extensions/task-tools/task-get"
import { TaskUpdateTool } from "@gent/extensions/task-tools/task-update"
import { DelegateTool } from "@gent/extensions/delegate/delegate-tool"
import { Agents } from "@gent/extensions/all-agents"
import { EventStore } from "@gent/core/domain/event"
import { Session, Branch } from "@gent/core/domain/message"
import type { ToolContext } from "@gent/core/domain/tool"
import { SessionId } from "@gent/core/domain/ids"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { createToolTestLayer, testToolContext } from "@gent/core/test-utils/extension-harness"
import { toolPreset } from "../helpers/test-preset.js"
import { TaskService } from "@gent/extensions/task-tools-service"
import { TaskExtension } from "@gent/extensions/task-tools"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import type {
  CapabilityError,
  CapabilityNotFoundError,
  CapabilityRef,
} from "@gent/core/domain/capability"

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const mockRunnerSuccess = {
  run: (params) =>
    Effect.succeed({
      _tag: "success" as const,
      text: `done: ${params.prompt}`,
      sessionId: SessionId.of("child-session"),
      agentName: params.agent.name,
    }),
}

const makeCtx = Effect.gen(function* () {
  const runtime = yield* MachineEngine
  const registry = yield* ExtensionRegistry
  const ctxBase = { sessionId: SessionId.of("s1"), branchId: "b1", cwd: "/tmp", home: "/tmp" }
  const request = <I, O>(ref: CapabilityRef<I, O>, input: I) => {
    const e = registry
      .getResolved()
      .capabilities.run(ref.extensionId, ref.capabilityId, "agent-protocol", input, ctxBase, {
        intent: ref.intent,
      })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return e as Effect.Effect<O, CapabilityError | CapabilityNotFoundError>
  }
  return testToolContext({
    sessionId: SessionId.of("s1"),
    branchId: "b1",
    toolCallId: "tc1",
    agent: {
      get: (name) => Effect.succeed(Object.values(Agents).find((a) => a.name === name)),
      require: (name) => {
        const agent = Object.values(Agents).find((a) => a.name === name)
        return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
      },
      run: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: `done: ${params.prompt}`,
          sessionId: SessionId.of("child-session"),
          agentName: params.agent.name,
        }),
      resolveDualModelPair: dieStub("agent.resolveDualModelPair"),
    },
    extension: {
      send: (message, branchId) => runtime.send(SessionId.of("s1"), message, branchId ?? "b1"),
      ask: (message, branchId) => runtime.execute(SessionId.of("s1"), message, branchId ?? "b1"),
      request,
    },
  }) as ToolContext
})

const layer = createToolTestLayer({
  ...toolPreset,
  extensions: [TaskExtension],
  subagentRunner: mockRunnerSuccess,
})

const setup = Effect.gen(function* () {
  const storage = yield* Storage
  const now = new Date()
  yield* storage.createSession(
    new Session({
      id: SessionId.of("s1"),
      name: "Test",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* storage.createBranch(
    new Branch({
      id: "b1",
      sessionId: SessionId.of("s1"),
      createdAt: now,
    }),
  )
})

describe("TaskCreateTool", () => {
  it.live("creates a task and returns id", () =>
    Effect.gen(function* () {
      yield* setup
      const ctx = yield* makeCtx
      const result = yield* TaskCreateTool.effect({ subject: "Fix auth bug" }, ctx)
      expect(result.taskId).toBeDefined()
      expect(result.subject).toBe("Fix auth bug")
      expect(result.status).toBe("pending")
    }).pipe(Effect.provide(layer)),
  )

  it.live("creates task with dependencies", () =>
    Effect.gen(function* () {
      yield* setup
      const ctx = yield* makeCtx
      const t1 = yield* TaskCreateTool.effect({ subject: "First" }, ctx)
      const t2 = yield* TaskCreateTool.effect(
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
      const ctx = yield* makeCtx
      yield* TaskCreateTool.effect({ subject: "Task A" }, ctx)
      yield* TaskCreateTool.effect({ subject: "Task B" }, ctx)
      const result = yield* TaskListTool.effect({}, ctx)
      expect(result.tasks.length).toBe(2)
      expect(result.summary.total).toBe(2)
      expect(result.summary.pending).toBe(2)
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns empty for no tasks", () =>
    Effect.gen(function* () {
      yield* setup
      const ctx = yield* makeCtx
      const result = yield* TaskListTool.effect({}, ctx)
      expect(result.tasks.length).toBe(0)
      expect(result.summary).toBe("No tasks")
    }).pipe(Effect.provide(layer)),
  )
})

describe("TaskGetTool", () => {
  it.live("returns task details", () =>
    Effect.gen(function* () {
      yield* setup
      const ctx = yield* makeCtx
      const created = yield* TaskCreateTool.effect(
        {
          subject: "Review code",
          description: "Full review of auth module",
        },
        ctx,
      )
      const result = yield* TaskGetTool.effect({ taskId: created.taskId }, ctx)
      expect(result.subject).toBe("Review code")
      expect(result.description).toBe("Full review of auth module")
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns error for missing task", () =>
    Effect.gen(function* () {
      yield* setup
      const ctx = yield* makeCtx
      const result = yield* TaskGetTool.effect({ taskId: "nonexistent" }, ctx)
      expect(result.error).toContain("not found")
    }).pipe(Effect.provide(layer)),
  )
})

describe("TaskUpdateTool", () => {
  it.live("updates task status", () =>
    Effect.gen(function* () {
      yield* setup
      const ctx = yield* makeCtx
      const created = yield* TaskCreateTool.effect({ subject: "Fix it" }, ctx)
      // Must follow valid transition: pending → in_progress → completed
      yield* TaskUpdateTool.effect({ taskId: created.taskId, status: "in_progress" }, ctx)
      const result = yield* TaskUpdateTool.effect(
        { taskId: created.taskId, status: "completed" },
        ctx,
      )
      expect(result.status).toBe("completed")
    }).pipe(Effect.provide(layer)),
  )

  it.live("publishes completed event when status becomes completed", () =>
    Effect.gen(function* () {
      yield* setup
      const ctx = yield* makeCtx
      const eventStore = yield* EventStore
      const eventsFiber = yield* Effect.forkChild(
        eventStore.subscribe({ sessionId: SessionId.of("s1") }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "TaskCompleted"),
          Stream.take(1),
          Stream.runCollect,
        ),
      )
      yield* Effect.yieldNow
      const created = yield* TaskCreateTool.effect({ subject: "Ship it" }, ctx)
      // Valid transition: pending → in_progress → completed
      yield* TaskUpdateTool.effect({ taskId: created.taskId, status: "in_progress" }, ctx)
      yield* TaskUpdateTool.effect({ taskId: created.taskId, status: "completed" }, ctx)
      const envelopes = yield* Fiber.join(eventsFiber)
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
      const eventsFiber = yield* Effect.forkChild(
        eventStore.subscribe({ sessionId: SessionId.of("s1") }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "TaskDeleted"),
          Stream.take(1),
          Stream.runCollect,
        ),
      )
      yield* Effect.yieldNow
      const created = yield* taskService.create({
        sessionId: SessionId.of("s1"),
        branchId: "b1",
        subject: "Ephemeral debug task",
      })
      yield* taskService.remove(created.id)
      const envelopes = yield* Fiber.join(eventsFiber)
      const events = Array.from(envelopes, (envelope) => envelope.event._tag)
      expect(events).toContain("TaskDeleted")
    }).pipe(Effect.provide(layer)),
  )
})

describe("DelegateTool background mode", () => {
  it.live("returns running status via background param", () =>
    Effect.gen(function* () {
      yield* setup
      const ctx = yield* makeCtx
      const result = yield* DelegateTool.effect(
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
