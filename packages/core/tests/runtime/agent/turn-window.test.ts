import { describe, expect, it } from "effect-bun-test"
import { Clock, Effect, Layer, Option, Predicate, Ref, Result } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { type AgentEvent, EventEnvelope, EventId, EventPublisher } from "../../../src/domain/event"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../../src/domain/ids"
import { dateFromMillis, Message } from "../../../src/domain/message"
import { ModelId } from "../../../src/domain/agent"
import {
  MODEL_OUTPUT_RESERVE_TOKENS,
  ModelContextBudget,
  ModelContextProjectionError,
  projectModelContext,
} from "../../../src/runtime/model-context"
import {
  type CompactionRequest,
  ModelCompactionError,
  ModelContextCompactor,
} from "../../../src/runtime/model-context-compactor"
import { messagesInCurrentWindow, windowDetails } from "../../../src/runtime/model-context-window"
import { projectContextWindow } from "../../../src/runtime/agent/turn-window"

const modelId = ModelId.make("test/window-model")
const createdAt = dateFromMillis(1_767_225_600_000)

/** A publisher that keeps what the projection publishes, so a test can read the notice. */
const recordingPublisher = Effect.map(Ref.make<ReadonlyArray<AgentEvent>>([]), (published) => ({
  published,
  layer: Layer.succeed(
    EventPublisher,
    EventPublisher.of({
      append: (event) =>
        Effect.map(Clock.currentTimeMillis, (at) =>
          EventEnvelope.make({ id: EventId.make(0), event, createdAt: at }),
        ),
      deliver: () => Effect.void,
      publish: (event) => Ref.update(published, (events) => [...events, event]),
    }),
  ),
}))

/** `resolveTurnSource` projects the same way: a projection failure becomes the typed error. */
const projectWith = (budget: ModelContextBudget) => (messages: ReadonlyArray<Message>) =>
  Effect.gen(function* () {
    const projection = projectModelContext(messages, budget)
    if (Result.isFailure(projection)) {
      return yield* new ModelContextProjectionError({ modelId, failure: projection.failure })
    }
    return projection.success
  })

const summaryModel: CompactionRequest["summaryModel"] = () =>
  Effect.die("the summary model is not resolved in these tests")

describe("turn window projection", () => {
  it.scopedLive("a turn whose own steps overflow hands off at a step boundary", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("mid-turn-session")
      const branchId = BranchId.make("mid-turn-branch")
      const prompt = Message.cases.regular.make({
        id: MessageId.make("mid-prompt"),
        sessionId,
        branchId,
        role: "user",
        parts: [Prompt.textPart({ text: "mid-turn prompt" })],
        createdAt,
      })
      // Four completed steps of ~700 tokens each after the only user message.
      const steps = Array.from({ length: 4 }, (_, index) => {
        const id = ToolCallId.make(`mid-call-${index + 1}`)
        const call = Message.cases.regular.make({
          id: MessageId.make(`mid-call-${index + 1}`),
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id,
              name: "read",
              params: { path: id },
              providerExecuted: false,
            }),
          ],
          createdAt: dateFromMillis(createdAt.getTime() + index * 2 + 1),
        })
        const result = Message.cases.regular.make({
          id: MessageId.make(`mid-result-${index + 1}`),
          sessionId,
          branchId,
          role: "tool",
          parts: [
            Prompt.toolResultPart({
              id,
              name: "read",
              isFailure: false,
              providerExecuted: false,
              result: { value: `mid-result-${index + 1} ${"x".repeat(2_800)}` },
            }),
          ],
          createdAt: dateFromMillis(createdAt.getTime() + index * 2 + 2),
        })
        return [call, result]
      }).flat()
      // A 6k window minus the output reserve: one step fits, the turn does not.
      const budget = ModelContextBudget.make({
        contextLimitTokens: 6_000,
        reservedSystemTokens: 0,
        reservedToolTokens: 0,
        reservedOutputTokens: MODEL_OUTPUT_RESERVE_TOKENS,
      })
      const requests: Array<CompactionRequest> = []
      const compactor = Layer.succeed(
        ModelContextCompactor,
        ModelContextCompactor.of({
          compact: (request) => {
            requests.push(request)
            return Effect.succeed({ notice: "mid-turn bounded summary", modelId })
          },
        }),
      )
      const persisted: Array<Message> = []
      const publisher = yield* recordingPublisher

      const { durableMessages, compacted } = yield* projectContextWindow({
        sessionId,
        branchId,
        modelId,
        messages: [prompt, ...steps],
        budget,
        directive: Option.none(),
        project: projectWith(budget),
        persist: (message) => {
          persisted.push(message)
          return Effect.succeed(message)
        },
        summaryModel,
        // oxlint-disable-next-line effect/noInlineProvide -- The compactor and publisher are created by this test.
      }).pipe(Effect.provide(Layer.mergeAll(compactor, publisher.layer)))

      expect(compacted).toBe(true)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.history.map((message) => message.id)).toEqual([
        prompt.id,
        ...steps.slice(0, 6).map((message) => message.id),
      ])
      expect(requests[0]?.kept.map((message) => message.id)).toEqual([
        MessageId.make("mid-call-4"),
        MessageId.make("mid-result-4"),
      ])

      const markers = durableMessages.filter(
        (message) => message.metadata?.customType === "context-window",
      )
      expect(markers).toHaveLength(1)
      expect(persisted).toEqual(markers)
      const marker = markers[0]
      if (Predicate.isUndefined(marker)) return yield* Effect.die("marker missing")
      const details = Option.getOrThrow(windowDetails(marker))
      expect(details.keepFromMessageId).toBe(MessageId.make("mid-call-4"))
      expect(details.summarized?.firstMessageId).toBe(prompt.id)
      expect(details.summarized?.lastMessageId).toBe(MessageId.make("mid-result-3"))
      expect(details.summarized?.count).toBe(7)
      // Every message stays durable; the model view starts at the marker.
      expect(durableMessages.slice(0, -1)).toEqual([prompt, ...steps])
      const view = yield* projectWith(budget)(messagesInCurrentWindow(durableMessages))
      const callIds = view.messages.flatMap((message) =>
        message.parts.filter((part) => part.type === "tool-call").map((part) => part.id),
      )
      expect(callIds).toEqual([ToolCallId.make("mid-call-4")])
      expect(
        view.messages.some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text.includes("mid-turn bounded summary"),
          ),
        ),
      ).toBe(true)
      expect(yield* Ref.get(publisher.published)).toEqual([])
    }),
  )

  it.scopedLive("a failing compactor truncates the window and names the omission", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("degrade-session")
      const branchId = BranchId.make("degrade-branch")
      const roles: ReadonlyArray<"user" | "assistant"> = ["user", "assistant"]
      // Older history that overflows the small window several times over.
      const history = Array.from({ length: 12 }, (_, ordinal) =>
        Message.cases.regular.make({
          id: MessageId.make(`old-${ordinal}`),
          sessionId,
          branchId,
          role: Option.getOrElse(Option.fromUndefinedOr(roles[ordinal % 2]), () => "user"),
          parts: [Prompt.textPart({ text: `old-${ordinal} ${"x".repeat(40_000)}` })],
          createdAt: dateFromMillis(1_000 + ordinal),
        }),
      )
      const current = Message.cases.regular.make({
        id: MessageId.make("continue"),
        sessionId,
        branchId,
        role: "user",
        parts: [Prompt.textPart({ text: "continue" })],
        createdAt,
      })
      const budget = ModelContextBudget.make({
        contextLimitTokens: 40_000,
        reservedSystemTokens: 0,
        reservedToolTokens: 0,
        reservedOutputTokens: MODEL_OUTPUT_RESERVE_TOKENS,
      })
      /** A compactor whose summary model is down; the seam contract says the turn degrades. */
      const failingCompactor = Layer.succeed(
        ModelContextCompactor,
        ModelContextCompactor.of({
          compact: (request) =>
            Effect.fail(
              new ModelCompactionError({
                modelId: request.modelId,
                reason: "SummaryGenerationFailed",
              }),
            ),
        }),
      )
      const persisted: Array<Message> = []
      const publisher = yield* recordingPublisher

      const messages = [...history, current]
      const { durableMessages, compacted } = yield* projectContextWindow({
        sessionId,
        branchId,
        modelId,
        messages,
        budget,
        directive: Option.none(),
        project: projectWith(budget),
        persist: (message) => {
          persisted.push(message)
          return Effect.succeed(message)
        },
        summaryModel,
        // oxlint-disable-next-line effect/noInlineProvide -- The compactor and publisher are created by this test.
      }).pipe(Effect.provide(Layer.mergeAll(failingCompactor, publisher.layer)))

      expect(compacted).toBe(false)
      expect(persisted).toEqual([])
      expect(durableMessages).toEqual(messages)
      expect(
        durableMessages.some((message) => message.metadata?.customType === "context-window"),
      ).toBe(false)
      const omitted = (yield* projectWith(budget)(messages)).omittedMessageIds.length
      expect(omitted).toBeGreaterThan(0)
      const notices = (yield* Ref.get(publisher.published)).filter(
        (event) => event._tag === "ErrorOccurred",
      )
      expect(notices).toHaveLength(1)
      expect(notices[0]?.error).toContain("Context compaction failed (SummaryGenerationFailed)")
      expect(notices[0]?.error).toContain(`continuing with ${omitted} older messages omitted`)
    }),
  )
})
