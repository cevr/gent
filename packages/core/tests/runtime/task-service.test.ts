import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer, Ref, Stream } from "effect"
import { TaskService } from "@gent/core/runtime/task-service"
import { TaskStorage } from "@gent/core/storage/task-storage"
import { Storage } from "@gent/core/storage/sqlite-storage"
import {
  Agents,
  SubagentRunnerService,
  type AgentName,
  type SubagentResult,
} from "@gent/core/domain/agent"
import { EventStore, SubagentSpawned, type EventEnvelope } from "@gent/core/domain/event"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import type { BranchId, SessionId, TaskId } from "@gent/core/domain/ids"

const sessionId = "task-test-session" as SessionId
const branchId = "task-test-branch" as BranchId

/**
 * Build a test layer for TaskService with a controllable SubagentRunner.
 * The runner blocks on a Deferred — tests resolve it to simulate completion,
 * or leave it pending to test stop/interrupt.
 */
const makeLayerWithInterruptFlag = (
  runnerDeferred: Deferred.Deferred<SubagentResult>,
  interruptedRef: Ref.Ref<boolean>,
) => {
  const storageLayer = Storage.MemoryWithSql()
  const taskStorageLayer = Layer.provide(TaskStorage.Live, storageLayer)
  const registryLayer = ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "test-agents" },
        kind: "builtin",
        sourcePath: "test",
        setup: { agents: Object.values(Agents), tools: [] },
      },
    ]),
  )
  const runnerLayer = Layer.succeed(SubagentRunnerService, {
    run: () =>
      Deferred.await(runnerDeferred).pipe(Effect.onInterrupt(() => Ref.set(interruptedRef, true))),
  })

  const baseDeps = Layer.mergeAll(
    storageLayer,
    taskStorageLayer,
    EventStore.Memory,
    registryLayer,
    runnerLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  )

  return Layer.provideMerge(TaskService.Live, baseDeps)
}

const makeLayer = (runnerDeferred: Deferred.Deferred<SubagentResult>) => {
  const storageLayer = Storage.MemoryWithSql()
  const taskStorageLayer = Layer.provide(TaskStorage.Live, storageLayer)
  const registryLayer = ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "test-agents" },
        kind: "builtin",
        sourcePath: "test",
        setup: { agents: Object.values(Agents), tools: [] },
      },
    ]),
  )
  const runnerLayer = Layer.succeed(SubagentRunnerService, {
    run: () => Deferred.await(runnerDeferred),
  })

  const baseDeps = Layer.mergeAll(
    storageLayer,
    taskStorageLayer,
    EventStore.Memory,
    registryLayer,
    runnerLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  )

  return Layer.provideMerge(TaskService.Live, baseDeps)
}

describe("TaskService", () => {
  describe("stop lifecycle", () => {
    it.live("stop while running: fiber interrupted, stopped status, TaskStopped event", () =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<SubagentResult>()
        const interruptedRef = yield* Ref.make(false)
        const layer = makeLayerWithInterruptFlag(deferred, interruptedRef)

        yield* Effect.gen(function* () {
          const taskService = yield* TaskService
          const eventStore = yield* EventStore

          // Subscribe to events before any operations
          const eventsRef = yield* Ref.make<EventEnvelope[]>([])
          yield* Effect.forkChild(
            eventStore.subscribe({ sessionId, branchId }).pipe(
              Stream.runForEach((env) => Ref.update(eventsRef, (curr) => [...curr, env])),
              Effect.catchCause(() => Effect.void),
            ),
          )

          // Create and run a task
          const task = yield* taskService.create({
            sessionId,
            branchId,
            subject: "Test task",
            prompt: "Do something",
            agentType: "explore" as AgentName,
          })

          yield* taskService.run(task.id)

          // Let the run fiber start
          yield* Effect.sleep("10 millis")

          // Stop while running
          const stopped = yield* taskService.stop(task.id)
          expect(stopped).toBeDefined()
          expect(stopped!.status).toBe("stopped")

          // Verify the runner was actually interrupted (not just status set)
          yield* Effect.sleep("10 millis")
          expect(yield* Ref.get(interruptedRef)).toBe(true)

          // Verify final status in storage
          const final = yield* taskService.get(task.id)
          expect(final).toBeDefined()
          expect(final!.status).toBe("stopped")

          // Check TaskStopped event was published
          const events = yield* Ref.get(eventsRef)
          const stopEvents = events.filter((e) => e.event._tag === "TaskStopped")
          expect(stopEvents.length).toBeGreaterThanOrEqual(1)
          const stopEvent = stopEvents[0]!.event as { taskId: TaskId }
          expect(stopEvent.taskId).toBe(task.id)
        }).pipe(Effect.provide(layer))
      }),
    )

    it.live("stop pending task: no fiber to interrupt, transitions to stopped", () =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<SubagentResult>()
        const layer = makeLayer(deferred)

        yield* Effect.gen(function* () {
          const taskService = yield* TaskService

          const task = yield* taskService.create({
            sessionId,
            branchId,
            subject: "Pending task",
          })

          // Stop without ever running
          const stopped = yield* taskService.stop(task.id)
          expect(stopped).toBeDefined()
          expect(stopped!.status).toBe("stopped")
        }).pipe(Effect.provide(layer))
      }),
    )

    it.live("concurrent tasks get distinct child sessions via toolCallId correlation", () =>
      Effect.gen(function* () {
        // Two deferreds — one per task. Runner publishes SubagentSpawned with
        // the task's toolCallId before resolving, simulating the real runner.
        const deferred1 = yield* Deferred.make<SubagentResult>()
        const deferred2 = yield* Deferred.make<SubagentResult>()
        const callCount = yield* Ref.make(0)

        const storageLayer = Storage.MemoryWithSql()
        const taskStorageLayer = Layer.provide(TaskStorage.Live, storageLayer)
        const registryLayer = ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: "test-agents" },
              kind: "builtin",
              sourcePath: "test",
              setup: { agents: Object.values(Agents), tools: [] },
            },
          ]),
        )

        const runnerLayer = Layer.succeed(SubagentRunnerService, {
          run: (params) =>
            Effect.gen(function* () {
              const n = yield* Ref.getAndUpdate(callCount, (c) => c + 1)
              const childSessionId = n === 0 ? ("child-A" as SessionId) : ("child-B" as SessionId)

              // Publish SubagentSpawned like the real runner does
              const eventStore = yield* EventStore
              yield* eventStore.publish(
                new SubagentSpawned({
                  parentSessionId: params.parentSessionId,
                  childSessionId,
                  agentName: params.agent.name,
                  prompt: params.prompt,
                  toolCallId: params.toolCallId,
                }),
              )

              const deferred = n === 0 ? deferred1 : deferred2
              return yield* Deferred.await(deferred)
            }),
        })

        const baseDeps = Layer.mergeAll(
          storageLayer,
          taskStorageLayer,
          EventStore.Memory,
          registryLayer,
          runnerLayer,
          RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        )
        const layer = Layer.provideMerge(TaskService.Live, baseDeps)

        yield* Effect.gen(function* () {
          const taskService = yield* TaskService

          const task1 = yield* taskService.create({
            sessionId,
            branchId,
            subject: "Task A",
            prompt: "Do A",
            agentType: "explore" as AgentName,
          })
          const task2 = yield* taskService.create({
            sessionId,
            branchId,
            subject: "Task B",
            prompt: "Do B",
            agentType: "explore" as AgentName,
          })

          yield* taskService.run(task1.id)
          yield* taskService.run(task2.id)

          // Let fibers start — SubagentSpawned events are published by the fake runner
          yield* Effect.sleep("50 millis")

          // Both tasks should have captured their own child session via captureAndTrack
          const t1Mid = yield* taskService.get(task1.id)
          const t2Mid = yield* taskService.get(task2.id)
          const meta1Mid = t1Mid!.metadata as { childSessionId?: string } | undefined
          const meta2Mid = t2Mid!.metadata as { childSessionId?: string } | undefined
          // Correlation: each task captured its own child via toolCallId filter
          expect(meta1Mid?.childSessionId).toBe("child-A")
          expect(meta2Mid?.childSessionId).toBe("child-B")

          // Resolve both
          yield* Deferred.succeed(deferred1, {
            _tag: "success" as const,
            text: "result A",
            sessionId: "child-A" as SessionId,
            agentName: "explore" as AgentName,
          })
          yield* Deferred.succeed(deferred2, {
            _tag: "success" as const,
            text: "result B",
            sessionId: "child-B" as SessionId,
            agentName: "explore" as AgentName,
          })

          yield* Effect.sleep("50 millis")

          const t1 = yield* taskService.get(task1.id)
          const t2 = yield* taskService.get(task2.id)
          expect(t1!.status).toBe("completed")
          expect(t2!.status).toBe("completed")

          // Final metadata still has correct child sessions
          const meta1 = t1!.metadata as { childSessionId?: string } | undefined
          const meta2 = t2!.metadata as { childSessionId?: string } | undefined
          expect(meta1?.childSessionId).toBe("child-A")
          expect(meta2?.childSessionId).toBe("child-B")
        }).pipe(Effect.provide(layer))
      }),
    )
  })
})
