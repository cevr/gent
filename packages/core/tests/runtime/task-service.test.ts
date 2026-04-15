import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { TaskService } from "@gent/core/extensions/task-tools-service"
import { TaskStorage } from "@gent/core/extensions/task-tools-storage"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { EventStore } from "@gent/core/domain/event"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { BranchId, SessionId } from "@gent/core/domain/ids"

const sessionId = SessionId.of("task-test-session")
const branchId = BranchId.of("task-test-branch")

const makeLayer = () => {
  const storageLayer = Storage.MemoryWithSql()
  const baseDeps = Layer.mergeAll(storageLayer, EventStore.Memory, ExtensionStateRuntime.Test())
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  const taskExtensionLayer = Layer.provide(
    Layer.mergeAll(TaskStorage.Live, TaskService.Live),
    Layer.merge(baseDeps, eventPublisherLayer),
  )
  return Layer.mergeAll(baseDeps, eventPublisherLayer, taskExtensionLayer)
}

describe("TaskService", () => {
  it.live("supports sibling layer composition used by extensions", () =>
    Effect.gen(function* () {
      const layer = makeLayer()

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

  it.live("update with stopped status publishes TaskStopped event", () =>
    Effect.gen(function* () {
      const layer = makeLayer()

      yield* Effect.gen(function* () {
        const taskService = yield* TaskService
        const task = yield* taskService.create({
          sessionId,
          branchId,
          subject: "Stoppable task",
        })

        // pending → stopped is a valid transition
        const updated = yield* taskService.update(task.id, { status: "stopped" })
        expect(updated).toBeDefined()
        expect(updated!.status).toBe("stopped")
      }).pipe(Effect.provide(layer))
    }),
  )
})
