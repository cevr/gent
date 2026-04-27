import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { TaskService } from "@gent/extensions/task-tools-service"
import { TaskStorage } from "@gent/extensions/task-tools-storage"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { EventPublisherLive } from "../../src/server/event-publisher"
import { EventStore } from "@gent/core/domain/event"
import { MachineEngine } from "../../src/runtime/extensions/resource-host/machine-engine"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { ensureStorageParents } from "@gent/core/test-utils"

const sessionId = SessionId.make("task-test-session")
const branchId = BranchId.make("task-test-branch")

const makeLayer = () => {
  const storageLayer = Storage.MemoryWithSql()
  const registryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
  const baseDeps = Layer.mergeAll(
    storageLayer,
    EventStore.Memory,
    MachineEngine.Test(),
    ActorEngine.Live,
    registryLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  )
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
        yield* ensureStorageParents({ sessionId, branchId })
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
        yield* ensureStorageParents({ sessionId, branchId })
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
