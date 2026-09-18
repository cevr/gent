/**
 * Durable message persistence. Summaries, window markers and turn messages
 * all reach storage through `persistMessageReceived`, so the once-only
 * guarantee is proved once, here.
 */
import { describe, expect, it } from "effect-bun-test"
import { Clock, Effect, Layer, Ref } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { type AgentEvent, EventEnvelope, EventId, EventPublisher } from "../../../src/domain/event"
import { BranchId, MessageId, SessionId } from "../../../src/domain/ids"
import { dateFromMillis, Message } from "../../../src/domain/message"
import { MessageStorage } from "../../../src/storage/message-storage"
import { SqliteStorage } from "../../../src/storage/sqlite-storage"
import { ensureStorageParents } from "../../../src/test-utils"
import { persistMessageReceived } from "../../../src/runtime/agent/turn-persistence"

const sessionId = SessionId.make("durable-persist-session")
const branchId = BranchId.make("durable-persist-branch")
const createdAt = dateFromMillis(1_767_225_600_000)

/** Keeps every appended and delivered event so a test can count them. */
const recordingPublisher = Effect.map(
  Ref.make<{ appended: ReadonlyArray<AgentEvent>; delivered: number }>({
    appended: [],
    delivered: 0,
  }),
  (state) => ({
    state,
    layer: Layer.succeed(
      EventPublisher,
      EventPublisher.of({
        append: (event) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            const next = yield* Ref.updateAndGet(state, (current) => ({
              ...current,
              appended: [...current.appended, event],
            }))
            return EventEnvelope.make({
              id: EventId.make(next.appended.length),
              event,
              createdAt: at,
            })
          }),
        deliver: () => Ref.update(state, (c) => ({ ...c, delivered: c.delivered + 1 })),
        publish: (event) => Ref.update(state, (c) => ({ ...c, appended: [...c.appended, event] })),
      }),
    ),
  }),
)

const summaryMessage = Message.cases.regular.make({
  id: MessageId.make("durable-persist-summary"),
  sessionId,
  branchId,
  role: "user",
  parts: [Prompt.textPart({ text: "window summary" })],
  createdAt,
  metadata: { customType: "context-window" },
})

describe("durable message persistence", () => {
  it.live("a repeated persist of the same durable message stores and appends it once", () =>
    Effect.gen(function* () {
      const publisher = yield* recordingPublisher
      yield* Effect.gen(function* () {
        yield* ensureStorageParents({ sessionId, branchId })
        const first = yield* persistMessageReceived({ message: summaryMessage })
        const second = yield* persistMessageReceived({ message: summaryMessage })
        expect(first.id).toBe(summaryMessage.id)
        expect(second.id).toBe(summaryMessage.id)

        const stored = yield* (yield* MessageStorage).listMessages(branchId)
        expect(stored.filter((message) => message.id === summaryMessage.id)).toHaveLength(1)

        const recorded = yield* Ref.get(publisher.state)
        const received = recorded.appended.filter(
          (event) => event._tag === "MessageReceived" && event.message.id === summaryMessage.id,
        )
        expect(received).toHaveLength(1)
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the storage layer for this operation.
        Effect.provide(
          Layer.mergeAll(
            SqliteStorage.TestWithSql(() => Layer.empty, {}),
            publisher.layer,
          ),
        ),
      )
    }),
  )
})
