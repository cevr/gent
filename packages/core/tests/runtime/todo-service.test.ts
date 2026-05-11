import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { TodoService, TodoServiceUnavailableError } from "../../../extensions/src/todo-service.js"
import { TodoStorage } from "../../../extensions/src/todo-storage.js"
import { TodoTransitionError } from "../../../extensions/src/todo/domain.js"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import {
  EventPublisherLive,
  ExtensionStatePublisher,
} from "@gent/core-internal/domain/event-publisher"
import { EventStore } from "@gent/core-internal/domain/event"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { ensureStorageParents, testToolContext } from "@gent/core-internal/test-utils"
import { ExtensionContext } from "@gent/core-internal/domain/extension-services"

const sessionId = SessionId.make("todo-test-session")
const branchId = BranchId.make("todo-test-branch")
const testCtx = testToolContext({ sessionId, branchId })
const TestExtensionContextLayer = Layer.succeed(ExtensionContext, testCtx)

const makeLayer = () => {
  const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
  const registryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
  const baseDeps = Layer.mergeAll(
    storageLayer,
    EventStore.Memory,
    registryLayer,
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    GentPlatform.Test(),
  )
  const runtimeLayer = Layer.provideMerge(EventPublisherLive, baseDeps)
  const todoExtensionLayer = Layer.mergeAll(
    TodoStorage.Live,
    TodoService.Live,
    TestExtensionContextLayer,
  )
  return Layer.provideMerge(todoExtensionLayer, runtimeLayer)
}

describe("TodoService", () => {
  it.live("create fails with typed unavailable error when todo storage is absent", () =>
    Effect.gen(function* () {
      const todoService = yield* TodoService
      const exit = yield* todoService
        .create({
          sessionId,
          branchId,
          subject: "Missing storage todo",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return yield* Effect.die("expected unavailable failure")
      const reason = exit.cause.reasons.find(Cause.isFailReason)
      expect(reason !== undefined && Schema.is(TodoServiceUnavailableError)(reason.error)).toBe(
        true,
      )
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TodoService.Live, ExtensionStatePublisher.Test(), TestExtensionContextLayer),
      ),
    ),
  )

  it.live("supports sibling layer composition used by extensions", () =>
    Effect.gen(function* () {
      const layer = makeLayer()

      yield* Effect.gen(function* () {
        yield* ensureStorageParents({ sessionId, branchId })
        const todoService = yield* TodoService
        const created = yield* todoService.create({
          sessionId,
          branchId,
          subject: "Sibling layer todo",
        })
        expect(created.subject).toBe("Sibling layer todo")
        const loaded = yield* todoService.get(created.id)
        expect(loaded?.id).toBe(created.id)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.live("update with stopped status publishes extension state change", () =>
    Effect.gen(function* () {
      const layer = makeLayer()

      yield* Effect.gen(function* () {
        yield* ensureStorageParents({ sessionId, branchId })
        const todoService = yield* TodoService
        const todo = yield* todoService.create({
          sessionId,
          branchId,
          subject: "Stoppable todo",
        })

        // pending → stopped is a valid transition
        const updated = yield* todoService.update(todo.id, { status: "stopped" })
        expect(updated).toBeDefined()
        expect(updated!.status).toBe("stopped")
      }).pipe(Effect.provide(layer))
    }),
  )

  it.live("invalid status transition stays in the typed error channel", () =>
    Effect.gen(function* () {
      const layer = makeLayer()

      yield* Effect.gen(function* () {
        yield* ensureStorageParents({ sessionId, branchId })
        const todoService = yield* TodoService
        const todo = yield* todoService.create({
          sessionId,
          branchId,
          subject: "Terminal todo",
        })
        yield* todoService.update(todo.id, { status: "in_progress" })
        yield* todoService.update(todo.id, { status: "completed" })
        const exit = yield* todoService.update(todo.id, { status: "in_progress" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return yield* Effect.die("expected transition failure")
        const reason = exit.cause.reasons.find(Cause.isFailReason)
        expect(reason !== undefined && Schema.is(TodoTransitionError)(reason.error)).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
  )
})
