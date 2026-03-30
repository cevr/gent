import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { defineAgent } from "@gent/core/domain/agent"
import { EventStore, type EventEnvelope } from "@gent/core/domain/event"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { Branch, Message, Session, TextPart } from "@gent/core/domain/message"
import { finalizeTurnPhase } from "@gent/core/runtime/agent/agent-loop-phases"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { Storage } from "@gent/core/storage/sqlite-storage"

const tinyAgent = defineAgent({
  name: "tiny",
  kind: "primary",
  model: "test/tiny" as never,
  systemPromptAddendum: "test",
})

const TestLayer = Layer.mergeAll(
  Storage.Test(),
  EventStore.Memory,
  ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "test-agent" },
        kind: "builtin",
        sourcePath: "test",
        setup: { agents: [tinyAgent] },
      },
    ]),
  ),
)

describe("finalizeTurnPhase", () => {
  it.live("publishes TurnCompleted and updates message duration", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const eventStore = yield* EventStore
      const extensionRegistry = yield* ExtensionRegistry

      const sessionId = "s-finalize" as SessionId
      const branchId = "b-finalize" as BranchId
      const messageId = "m-assistant" as MessageId

      yield* storage.createSession(
        new Session({
          id: sessionId,
          cwd: process.cwd(),
          bypass: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      )
      yield* storage.createBranch(
        new Branch({
          id: branchId,
          sessionId,
          createdAt: new Date(),
        }),
      )
      yield* storage.createMessage(
        new Message({
          id: messageId,
          sessionId,
          branchId,
          role: "assistant",
          parts: [new TextPart({ type: "text", text: "response" })],
          createdAt: new Date(),
        }),
      )

      const envelopesRef = yield* Ref.make<EventEnvelope[]>([])
      const turnCompletedDeferred = yield* Deferred.make<void>()
      const subscriptionFiber = yield* Effect.forkChild(
        eventStore.subscribe({ sessionId, branchId }).pipe(
          Stream.runForEach((envelope) =>
            Effect.gen(function* () {
              yield* Ref.update(envelopesRef, (current) => [...current, envelope])
              if (envelope.event._tag === "TurnCompleted") {
                yield* Deferred.succeed(turnCompletedDeferred, undefined)
              }
            }),
          ),
        ),
      )

      yield* finalizeTurnPhase({
        storage,
        publishEvent: (event) => eventStore.publish(event).pipe(Effect.orDie),
        sessionId,
        branchId,
        startedAtMs: Date.now() - 100,
        messageId,
        turnInterrupted: false,
        currentAgent: "tiny",
        extensionRegistry,
      })

      yield* Deferred.await(turnCompletedDeferred)
      yield* Fiber.interrupt(subscriptionFiber)

      const tags = (yield* Ref.get(envelopesRef)).map((envelope) => envelope.event._tag)
      expect(tags).toContain("TurnCompleted")

      // Verify message duration was updated
      const msg = yield* storage.getMessage(messageId)
      expect(msg?.turnDurationMs).toBeGreaterThan(0)
    }).pipe(Effect.provide(TestLayer)),
  )
})
