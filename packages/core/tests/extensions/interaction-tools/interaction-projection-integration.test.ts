/**
 * InteractionProjection × EventPublisherLive end-to-end integration.
 *
 * Locks the actual product wiring (the unit tests in
 * `interaction-projection.test.ts` only assert that the projection's
 * `query` reads storage correctly):
 *
 *   1. `InteractionStorage.persist` writes a pending row
 *   2. An `InteractionPresented` event is published through `EventPublisher`
 *   3. `EventPublisherLive` appends `InteractionPresented` to `BaseEventStore`
 *   4. `EventPublisherLive` evaluates `ProjectionRegistry.evaluateUi(ctx)`
 *   5. `InteractionProjection` reads the pending row from
 *      `InteractionPendingReader` and emits a UI snapshot
 *   6. `EventPublisherLive` appends an `ExtensionUiSnapshot` carrying the
 *      `{ requestId, text, metadata? }` model
 *
 * If this regresses, cold-start hydration (TUI fetching `getSessionSnapshot`
 * after restart) or live event-driven hydration (TUI consuming the appended
 * `ExtensionUiSnapshot`) will silently miss pending interactions even when
 * the projection's unit tests still pass.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Ref } from "effect"
import {
  type AgentEvent,
  BaseEventStore,
  ExtensionUiSnapshot,
  InteractionPresented,
} from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { Session, Branch } from "@gent/core/domain/message"
import { SessionId, BranchId } from "@gent/core/domain/ids"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { projection as projectionContribution } from "@gent/core/domain/contribution"
import { WorkflowRuntime } from "@gent/core/runtime/extensions/workflow-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { InteractionStorage } from "@gent/core/storage/interaction-storage"
import { encodeInteractionParams } from "@gent/core/domain/interaction-request"
import {
  InteractionProjection,
  type InteractionUiModel,
} from "@gent/extensions/interaction-tools/projection"

const sessionId = SessionId.of("019d97f0-0000-7000-aaaa-000000000001")
const branchId = BranchId.of("019d97f0-0000-7001-aaaa-000000000001")
const INTERACTION_TOOLS_EXTENSION_ID = "@gent/interaction-tools"

const makeRecordingBaseEventStore = (sink: Ref.Ref<ReadonlyArray<AgentEvent>>) =>
  Layer.succeed(BaseEventStore, {
    publish: (event: AgentEvent) => Ref.update(sink, (xs) => [...xs, event]),
    subscribe: () => Effect.void as never,
    removeSession: () => Effect.void,
  })

const interactionExtensionRegistry = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: INTERACTION_TOOLS_EXTENSION_ID },
      kind: "builtin" as const,
      sourcePath: "test",
      contributions: [projectionContribution(InteractionProjection)],
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

describe("InteractionProjection × EventPublisherLive integration", () => {
  it.live("InteractionPresented triggers ExtensionUiSnapshot reflecting pending row", () =>
    Effect.gen(function* () {
      const sink = yield* Ref.make<ReadonlyArray<AgentEvent>>([])

      const storageLayer = Storage.TestWithSql()
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
          interactionExtensionRegistry,
          runtimePlatformLayer,
        ),
      )

      const layer = Layer.mergeAll(storageLayer, baseEventStoreLayer, eventPublisherLayer)

      yield* Effect.gen(function* () {
        yield* setupSession

        // Persist a pending interaction directly (simulates ApprovalService).
        const storage = yield* InteractionStorage
        const paramsJson = yield* encodeInteractionParams({
          text: "Approve deploy?",
          metadata: { type: "prompt", mode: "confirm" },
        })
        yield* storage.persist({
          requestId: "req-int-1",
          type: "approval",
          sessionId,
          branchId,
          paramsJson,
          status: "pending",
          createdAt: 1,
        })

        // Publish the InteractionPresented event — EventPublisherLive will
        // append the event AND evaluate projections, appending the snapshot.
        const publisher = yield* EventPublisher
        yield* publisher.publish(
          new InteractionPresented({
            sessionId,
            branchId,
            requestId: "req-int-1",
            text: "Approve deploy?",
            metadata: { type: "prompt", mode: "confirm" },
          }),
        )

        const events = yield* Ref.get(sink)
        expect(events.length).toBe(2)
        const [first, second] = events
        expect(first instanceof InteractionPresented).toBe(true)
        expect(second instanceof ExtensionUiSnapshot).toBe(true)

        const snapshot = second as ExtensionUiSnapshot
        expect(snapshot.extensionId).toBe(INTERACTION_TOOLS_EXTENSION_ID)
        expect(snapshot.sessionId).toBe(sessionId)
        expect(snapshot.branchId).toBe(branchId)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const model = snapshot.model as InteractionUiModel
        expect(model.requestId).toBe("req-int-1")
        expect(model.text).toBe("Approve deploy?")
        expect(model.metadata).toEqual({ type: "prompt", mode: "confirm" })
      }).pipe(Effect.provide(layer))
    }),
  )
})
