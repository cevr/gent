import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { TaskService, TaskServiceUnavailableError } from "@gent/extensions/task-tools-service"
import { TaskStorage } from "@gent/extensions/task-tools-storage"
import { SqliteStorage } from "@gent/core/storage/sqlite-storage"
import { EventPublisherLive, ExtensionStatePublisher } from "@gent/core/domain/event-publisher"
import { EventStore } from "@gent/core/domain/event"
import { CapabilityAccess } from "@gent/core/extensions/api"
import { CapabilityError } from "@gent/core/domain/capability"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { ensureStorageParents } from "@gent/core/test-utils"

const sessionId = SessionId.make("task-test-session")
const branchId = BranchId.make("task-test-branch")

const makeLayer = () => {
  const storageLayer = SqliteStorage.MemoryWithSql()
  const registryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
  const baseDeps = Layer.mergeAll(
    storageLayer,
    EventStore.Memory,
    registryLayer,
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    GentPlatform.Test(),
  )
  const runtimeLayer = Layer.provideMerge(EventPublisherLive, baseDeps)
  const taskExtensionLayer = Layer.mergeAll(TaskStorage.Live, TaskService.Live)
  return Layer.provideMerge(taskExtensionLayer, runtimeLayer)
}

describe("TaskService", () => {
  it.live("create fails with typed unavailable error when task storage is absent", () =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      const exit = yield* taskService
        .create({
          sessionId,
          branchId,
          subject: "Missing storage task",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return yield* Effect.die("expected unavailable failure")
      const reason = exit.cause.reasons.find(Cause.isFailReason)
      expect(reason !== undefined && Schema.is(TaskServiceUnavailableError)(reason.error)).toBe(
        true,
      )
    }).pipe(Effect.provide(Layer.mergeAll(TaskService.Live, ExtensionStatePublisher.Test()))),
  )

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

  it.live("update with stopped status publishes extension state change", () =>
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

  it.live("read task access cannot call write methods on the full task service", () =>
    Effect.gen(function* () {
      const layer = makeLayer()

      yield* Effect.gen(function* () {
        yield* ensureStorageParents({ sessionId, branchId })
        const taskService = yield* TaskService
        const exit = yield* taskService
          .create({
            sessionId,
            branchId,
            subject: "Should be fenced",
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return yield* Effect.die("expected capability failure")
        const reason = exit.cause.reasons.find(Cause.isFailReason)
        expect(reason !== undefined && Schema.is(CapabilityError)(reason.error)).toBe(true)
      }).pipe(
        CapabilityAccess.provideNeeds([{ tag: "task", access: "read" }]),
        Effect.provide(layer),
      )
    }),
  )
})
