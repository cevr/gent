import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { defineAgent } from "@gent/core/domain/agent"
import {
  EventStore,
  HandoffConfirmed,
  HandoffPresented,
  type EventEnvelope,
} from "@gent/core/domain/event"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { Branch, Message, Session, TextPart } from "@gent/core/domain/message"
import { finalizeTurnPhase } from "@gent/core/runtime/agent/agent-loop-phases"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { Storage } from "@gent/core/storage/sqlite-storage"
import type { HandoffHandlerService } from "@gent/core/domain/interaction-handlers"

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
        manifest: { id: "test-handoff-agent" },
        kind: "builtin",
        sourcePath: "test",
        setup: { agents: [tinyAgent] },
      },
    ]),
  ),
)

describe("finalizeTurnPhase", () => {
  test("publishes TurnCompleted after handoff confirmation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const eventStore = yield* EventStore
        const extensionRegistry = yield* ExtensionRegistry

        const sessionId = "s-handoff" as SessionId
        const branchId = "b-handoff" as BranchId
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
            id: "m-user" as MessageId,
            sessionId,
            branchId,
            role: "user",
            parts: [new TextPart({ type: "text", text: "x".repeat(700_000) })],
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          new Message({
            id: messageId,
            sessionId,
            branchId,
            role: "assistant",
            parts: [new TextPart({ type: "text", text: "" })],
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

        const handoffHandler: HandoffHandlerService = {
          present: Effect.fn("TestHandoffHandler.present")(function* (params) {
            const requestId = "handoff-req-1"
            yield* eventStore.publish(
              new HandoffPresented({
                sessionId: params.sessionId,
                branchId: params.branchId,
                requestId,
                summary: params.summary,
                ...(params.reason !== undefined ? { reason: params.reason } : {}),
              }),
            )
            yield* eventStore.publish(
              new HandoffConfirmed({
                sessionId: params.sessionId,
                branchId: params.branchId,
                requestId,
              }),
            )
            return "confirm" as const
          }),
          peek: () => Effect.succeed(undefined),
          claim: () => Effect.succeed(undefined),
          respond: () => Effect.succeed(undefined),
        }

        const nextSuppress = yield* finalizeTurnPhase({
          storage,
          publishEvent: (event) => eventStore.publish(event).pipe(Effect.orDie),
          sessionId,
          branchId,
          startedAtMs: Date.now() - 100,
          messageId,
          turnInterrupted: false,
          handoffSuppress: 0,
          currentAgent: "tiny",
          extensionRegistry,
          handoffHandler,
        })

        expect(nextSuppress).toBe(0)

        yield* Deferred.await(turnCompletedDeferred)
        yield* Fiber.interrupt(subscriptionFiber)

        const tags = (yield* Ref.get(envelopesRef)).map((envelope) => envelope.event._tag)
        expect(tags).toContain("HandoffPresented")
        expect(tags).toContain("HandoffConfirmed")
        expect(tags).toContain("TurnCompleted")
        expect(tags.indexOf("HandoffPresented")).toBeLessThan(tags.indexOf("HandoffConfirmed"))
        expect(tags.indexOf("HandoffConfirmed")).toBeLessThan(tags.indexOf("TurnCompleted"))
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})
