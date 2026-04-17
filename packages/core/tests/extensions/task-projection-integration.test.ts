/**
 * TaskProjection × EventPublisherLive end-to-end integration.
 *
 * Locks the actual product wiring (the unit tests in `task-projection.test.ts`
 * only assert that the projection's `query` reads storage correctly):
 *
 *   1. `TaskService.create` writes storage and publishes `TaskCreated`
 *   2. `EventPublisherLive` appends `TaskCreated` to `BaseEventStore`
 *   3. `EventPublisherLive` evaluates `ProjectionRegistry.evaluateUi(ctx)`
 *   4. `TaskProjection` reads the new task from `TaskStorage` on demand
 *   5. `EventPublisherLive` appends an `ExtensionUiSnapshot` carrying the
 *      task model (matches `TaskUiModel` shape)
 *
 * If this regresses, the projection model is broken end-to-end even when its
 * unit tests pass — a property the C3 counsel review explicitly called out
 * as missing.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Ref } from "effect"
import {
  type AgentEvent,
  BaseEventStore,
  ExtensionUiSnapshot,
  TaskCreated,
} from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { Session, Branch } from "@gent/core/domain/message"
import { SessionId, BranchId } from "@gent/core/domain/ids"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { WorkflowRuntime } from "@gent/core/runtime/extensions/workflow-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { TaskService } from "@gent/extensions/task-tools-service"
import { TaskStorage } from "@gent/extensions/task-tools-storage"
import { TaskProjection } from "@gent/extensions/task-tools/projection"
import { TASK_TOOLS_EXTENSION_ID } from "@gent/extensions/task-tools/identity"

const sessionId = SessionId.of("s1")
const branchId = BranchId.of("b1")

// Recording BaseEventStore — captures published events in order so we can
// assert the TaskCreated → ExtensionUiSnapshot sequence.
const makeRecordingBaseEventStore = (sink: Ref.Ref<ReadonlyArray<AgentEvent>>) =>
  Layer.succeed(BaseEventStore, {
    publish: (event: AgentEvent) => Ref.update(sink, (xs) => [...xs, event]),
    subscribe: () => Effect.void as never,
    removeSession: () => Effect.void,
  })

// Loaded TaskExtension in registry form — only the projection contribution
// matters for this test (UI snapshot emission goes through the projection
// registry inside EventPublisherLive).
const taskExtensionRegistry = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: TASK_TOOLS_EXTENSION_ID },
      kind: "builtin" as const,
      sourcePath: "test",
      setup: { projections: [TaskProjection] },
    },
  ]),
)

const setupSession = Effect.gen(function* () {
  const storage = yield* Storage
  const now = new Date()
  yield* storage.createSession(
    new Session({ id: sessionId, name: "S", createdAt: now, updatedAt: now }),
  )
  yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
})

describe("TaskProjection × EventPublisherLive integration", () => {
  it.live("TaskService.create publishes TaskCreated then ExtensionUiSnapshot", () =>
    Effect.gen(function* () {
      const sink = yield* Ref.make<ReadonlyArray<AgentEvent>>([])

      const storageLayer = Storage.TestWithSql()
      const taskStorageLayer = Layer.provide(TaskStorage.Live, storageLayer)
      const taskServiceLayer = Layer.provide(TaskService.Live, taskStorageLayer)
      const baseEventStoreLayer = makeRecordingBaseEventStore(sink)
      const stateRuntimeLayer = WorkflowRuntime.fromExtensions([]).pipe(
        Layer.provideMerge(ExtensionTurnControl.Test()),
      )
      const runtimePlatformLayer = RuntimePlatform.Test({
        cwd: "/tmp",
        home: "/tmp",
        platform: "test",
      })
      const eventPublisherLayer = Layer.provide(
        EventPublisherLive,
        Layer.mergeAll(
          baseEventStoreLayer,
          stateRuntimeLayer,
          taskExtensionRegistry,
          runtimePlatformLayer,
        ),
      )

      const layer = Layer.mergeAll(
        storageLayer,
        taskStorageLayer,
        taskServiceLayer,
        baseEventStoreLayer,
        eventPublisherLayer,
      )

      yield* Effect.gen(function* () {
        yield* setupSession
        // TaskService.create publishes TaskCreated through EventPublisher.
        // Use Effect.serviceOption to satisfy the EventPublisher requirement
        // captured by TaskService.create.
        const taskService = yield* TaskService
        const publisher = yield* EventPublisher
        yield* taskService
          .create({ sessionId, branchId, subject: "do the thing" })
          .pipe(Effect.provideService(EventPublisher, publisher))

        const events = yield* Ref.get(sink)
        // Order: TaskCreated published first; then EventPublisherLive
        // evaluates projections and appends one ExtensionUiSnapshot.
        expect(events.length).toBe(2)
        const [first, second] = events
        expect(first?._tag).toBe("TaskCreated")
        expect(first instanceof TaskCreated).toBe(true)
        expect(second instanceof ExtensionUiSnapshot).toBe(true)
        const snapshot = second as ExtensionUiSnapshot
        expect(snapshot.extensionId).toBe(TASK_TOOLS_EXTENSION_ID)
        expect(snapshot.sessionId).toBe(sessionId)
        expect(snapshot.branchId).toBe(branchId)
        // Model shape matches TaskUiModel ({ tasks: TaskEntry[] }) with the
        // newly created task derived from on-disk storage.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const model = snapshot.model as { readonly tasks: ReadonlyArray<{ subject: string }> }
        expect(model.tasks.length).toBe(1)
        expect(model.tasks[0]?.subject).toBe("do the thing")
      }).pipe(Effect.provide(layer))
    }),
  )
})
