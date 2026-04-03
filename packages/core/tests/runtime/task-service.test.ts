import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer, Ref, Stream } from "effect"
import { TaskService } from "@gent/core/extensions/task-tools-service"
import { TaskStorage } from "@gent/core/extensions/task-tools-storage"
import { Storage } from "@gent/core/storage/sqlite-storage"
import {
  Agents,
  AgentRunnerService,
  type AgentName,
  type AgentRunResult,
} from "@gent/core/domain/agent"
import { EventStore, AgentRunSpawned, type EventEnvelope } from "@gent/core/domain/event"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import type { BranchId, SessionId, TaskId } from "@gent/core/domain/ids"

const sessionId = "task-test-session" as SessionId
const branchId = "task-test-branch" as BranchId

/**
 * Build a test layer for TaskService with a controllable AgentRunner.
 * The runner blocks on a Deferred — tests resolve it to simulate completion,
 * or leave it pending to test stop/interrupt.
 */
const makeLayerWithInterruptFlag = (
  runnerDeferred: Deferred.Deferred<AgentRunResult>,
  interruptedRef: Ref.Ref<boolean>,
) => {
  const storageLayer = Storage.MemoryWithSql()
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
  const runnerLayer = Layer.succeed(AgentRunnerService, {
    run: () =>
      Deferred.await(runnerDeferred).pipe(Effect.onInterrupt(() => Ref.set(interruptedRef, true))),
  })

  const baseDeps = Layer.mergeAll(
    storageLayer,
    EventStore.Memory,
    registryLayer,
    runnerLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  )
  const taskExtensionLayer = Layer.provide(
    Layer.mergeAll(TaskStorage.Live, TaskService.Live),
    baseDeps,
  )
  return Layer.mergeAll(baseDeps, taskExtensionLayer)
}

const makeLayer = (runnerDeferred: Deferred.Deferred<AgentRunResult>) => {
  const storageLayer = Storage.MemoryWithSql()
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
  const runnerLayer = Layer.succeed(AgentRunnerService, {
    run: () => Deferred.await(runnerDeferred),
  })

  const baseDeps = Layer.mergeAll(
    storageLayer,
    EventStore.Memory,
    registryLayer,
    runnerLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  )
  const taskExtensionLayer = Layer.provide(
    Layer.mergeAll(TaskStorage.Live, TaskService.Live),
    baseDeps,
  )
  return Layer.mergeAll(baseDeps, taskExtensionLayer)
}

const makeLayerWithoutRunner = () => {
  const storageLayer = Storage.MemoryWithSql()
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

  const baseDeps = Layer.mergeAll(
    storageLayer,
    EventStore.Memory,
    registryLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  )
  const taskExtensionLayer = Layer.provide(
    Layer.mergeAll(TaskStorage.Live, TaskService.Live),
    baseDeps,
  )
  return Layer.mergeAll(baseDeps, taskExtensionLayer)
}

describe("TaskService", () => {
  it.live("supports sibling layer composition used by extensions", () =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<AgentRunResult>()
      const layer = makeLayer(deferred)

      yield* Effect.gen(function* () {
        const taskService = yield* TaskService
        const created = yield* taskService.create({
          sessionId,
          branchId,
          subject: "Sibling layer task",
        })
        expect(created.subject).toBe("Sibling layer task")
        const loaded = yield* taskService.get(created.id)
        expect(loaded?.id).toBe(created.id)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.live("resolves runner lazily and fails the task when it is unavailable", () =>
    Effect.gen(function* () {
      const layer = makeLayerWithoutRunner()

      yield* Effect.gen(function* () {
        const taskService = yield* TaskService

        const task = yield* taskService.create({
          sessionId,
          branchId,
          subject: "Task without runner",
          prompt: "Do something",
          agentType: "explore" as AgentName,
        })

        const runResult = yield* taskService.run(task.id)
        expect(runResult.status).toBe("running")

        yield* Effect.sleep("50 millis")

        const failedTask = yield* taskService.get(task.id)
        expect(failedTask).toBeDefined()
        expect(failedTask!.status).toBe("failed")
        expect(failedTask!.metadata).toMatchObject({
          error: "AgentRunnerService not available",
        })
      }).pipe(Effect.provide(layer))
    }),
  )

  it.live("forces durable agent-run persistence for task execution", () =>
    Effect.gen(function* () {
      const persistenceRef = yield* Ref.make<ReadonlyArray<string>>([])

      const storageLayer = Storage.MemoryWithSql()
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
      const runnerLayer = Layer.succeed(AgentRunnerService, {
        run: (params) =>
          Ref.update(persistenceRef, (values) => [...values, params.persistence ?? "missing"]).pipe(
            Effect.as({
              _tag: "success" as const,
              text: "done",
              sessionId: "task-child" as SessionId,
              agentName: "explore" as AgentName,
              persistence: "durable" as const,
            }),
          ),
      })

      const baseDeps = Layer.mergeAll(
        storageLayer,
        EventStore.Memory,
        registryLayer,
        runnerLayer,
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      )
      const taskExtensionLayer = Layer.provide(
        Layer.mergeAll(TaskStorage.Live, TaskService.Live),
        baseDeps,
      )
      const layer = Layer.mergeAll(baseDeps, taskExtensionLayer)

      yield* Effect.gen(function* () {
        const taskService = yield* TaskService
        const task = yield* taskService.create({
          sessionId,
          branchId,
          subject: "Durable task",
          prompt: "Do durable work",
          agentType: "explore" as AgentName,
        })

        yield* taskService.run(task.id)
        yield* Effect.sleep("50 millis")

        expect(yield* Ref.get(persistenceRef)).toEqual(["durable"])
      }).pipe(Effect.provide(layer))
    }),
  )

  describe("stop lifecycle", () => {
    it.live("stop while running: fiber interrupted, stopped status, TaskStopped event", () =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<AgentRunResult>()
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
        const deferred = yield* Deferred.make<AgentRunResult>()
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
        // Two deferreds — one per task. Runner publishes AgentRunSpawned with
        // the task's toolCallId before resolving, simulating the real runner.
        const deferred1 = yield* Deferred.make<AgentRunResult>()
        const deferred2 = yield* Deferred.make<AgentRunResult>()
        const callCount = yield* Ref.make(0)

        const storageLayer = Storage.MemoryWithSql()
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

        const runnerLayer = Layer.succeed(AgentRunnerService, {
          run: (params) =>
            Effect.gen(function* () {
              const n = yield* Ref.getAndUpdate(callCount, (c) => c + 1)
              const childSessionId = n === 0 ? ("child-A" as SessionId) : ("child-B" as SessionId)

              // Publish AgentRunSpawned like the real runner does
              const eventStore = yield* EventStore
              yield* eventStore.publish(
                new AgentRunSpawned({
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
          EventStore.Memory,
          registryLayer,
          runnerLayer,
          RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        )
        const taskExtensionLayer = Layer.provide(
          Layer.mergeAll(TaskStorage.Live, TaskService.Live),
          baseDeps,
        )
        const layer = Layer.mergeAll(baseDeps, taskExtensionLayer)

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

          // Let fibers start — AgentRunSpawned events are published by the fake runner
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
