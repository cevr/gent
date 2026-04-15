import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Ref } from "effect"
import {
  BaseEventStore,
  EventStore,
  InteractionPresented,
  InteractionResolved,
  type AgentEvent,
  type EventStoreService,
} from "@gent/core/domain/event"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import {
  INTERACTION_TOOLS_EXTENSION_ID,
  interactionActor,
} from "@gent/core/extensions/interaction-tools"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"

const sessionId = SessionId.of("s-interaction")
const branchId = BranchId.of("b-interaction")

const interactionExtension: LoadedExtension = {
  manifest: { id: INTERACTION_TOOLS_EXTENSION_ID },
  kind: "builtin",
  sourcePath: "builtin",
  setup: { actor: interactionActor },
}

const makeLayer = () => {
  const published = Effect.runSync(Ref.make<AgentEvent[]>([]))
  const stateRuntimeLayer = ExtensionStateRuntime.Live([interactionExtension]).pipe(
    Layer.provideMerge(ExtensionTurnControl.Test()),
  )
  const baseService: EventStoreService = {
    publish: (event) => Ref.update(published, (events) => [...events, event]).pipe(Effect.asVoid),
    subscribe: () => Effect.void as never,
    removeSession: () => Effect.void,
  }
  const baseLayer = Layer.merge(
    Layer.succeed(BaseEventStore, baseService),
    Layer.succeed(EventStore, baseService),
  )
  const servicesLayer = Storage.Test()
  const combinedBase = Layer.mergeAll(baseLayer, stateRuntimeLayer, servicesLayer)
  const eventPublisherLayer = Layer.provide(EventPublisherLive, combinedBase)
  return Layer.mergeAll(combinedBase, eventPublisherLayer)
}

describe("Interaction actor snapshot", () => {
  it.live("InteractionPresented populates actor snapshot", () => {
    const layer = makeLayer()
    return Effect.gen(function* () {
      const publisher = yield* EventPublisher
      const stateRuntime = yield* ExtensionStateRuntime

      yield* publisher.publish(
        new InteractionPresented({
          sessionId,
          branchId,
          requestId: "req-1",
          text: "Deploy to production?",
          metadata: { type: "prompt", mode: "confirm" },
        }),
      )

      const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const snap = snapshots.find((s) => s.extensionId === INTERACTION_TOOLS_EXTENSION_ID)
      expect(snap).toBeDefined()

      const model = snap!.model as { requestId?: string; text?: string; metadata?: unknown }
      expect(model.requestId).toBe("req-1")
      expect(model.text).toBe("Deploy to production?")
      expect(model.metadata).toEqual({ type: "prompt", mode: "confirm" })
    }).pipe(Effect.provide(layer))
  })

  it.live("InteractionResolved clears actor snapshot", () => {
    const layer = makeLayer()
    return Effect.gen(function* () {
      const publisher = yield* EventPublisher
      const stateRuntime = yield* ExtensionStateRuntime

      yield* publisher.publish(
        new InteractionPresented({
          sessionId,
          branchId,
          requestId: "req-2",
          text: "Approve?",
        }),
      )

      // Verify it's pending
      const before = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const snapBefore = before.find((s) => s.extensionId === INTERACTION_TOOLS_EXTENSION_ID)
      expect((snapBefore!.model as { requestId?: string }).requestId).toBe("req-2")

      // Resolve
      yield* publisher.publish(
        new InteractionResolved({
          sessionId,
          branchId,
          requestId: "req-2",
          approved: true,
        }),
      )

      // Verify it's cleared
      const after = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const snapAfter = after.find((s) => s.extensionId === INTERACTION_TOOLS_EXTENSION_ID)
      const model = snapAfter?.model as { requestId?: string } | undefined
      expect(model?.requestId).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.live("resolving wrong requestId does not clear snapshot", () => {
    const layer = makeLayer()
    return Effect.gen(function* () {
      const publisher = yield* EventPublisher
      const stateRuntime = yield* ExtensionStateRuntime

      yield* publisher.publish(
        new InteractionPresented({
          sessionId,
          branchId,
          requestId: "req-3",
          text: "Proceed?",
        }),
      )

      // Resolve with wrong requestId
      yield* publisher.publish(
        new InteractionResolved({
          sessionId,
          branchId,
          requestId: "req-wrong",
          approved: false,
        }),
      )

      // Snapshot should still show req-3
      const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const snap = snapshots.find((s) => s.extensionId === INTERACTION_TOOLS_EXTENSION_ID)
      expect((snap!.model as { requestId?: string }).requestId).toBe("req-3")
    }).pipe(Effect.provide(layer))
  })
})
