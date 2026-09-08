import { describe, expect, it } from "effect-bun-test"
import { Effect, Stream } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import * as Prompt from "effect/unstable/ai/Prompt"
import { narrowR } from "../helpers/effect"
import { AgentDefinition, AgentName } from "@gent/core-internal/domain/agent"
import { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import { Model, ModelId, ProviderId } from "@gent/core-internal/domain/model"
import { dateFromMillis, Branch, Message, Session } from "@gent/core-internal/domain/message"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { baseLocalLayerWithProvider } from "@gent/core-internal/test-utils/in-process-layer"

const CONTEXT_LIMIT_TOKENS = 40_000
const modelId = ModelId.make("test/small-window")
const agent = AgentDefinition.make({ name: AgentName.make("cowork"), model: modelId })
const smallWindowModel = new Model({
  id: modelId,
  name: "Small Window",
  provider: ProviderId.make("test"),
  contextLength: CONTEXT_LIMIT_TOKENS,
})
const sessionId = SessionId.make("degrade-session")
const branchId = BranchId.make("degrade-branch")

/** Older history that overflows the small window several times over. */
const seedOverflowingHistory = Effect.gen(function* () {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const messages = yield* MessageStorage
  const now = dateFromMillis(1_767_225_600_000)
  yield* sessions.createSession(
    new Session({ id: sessionId, name: "Degrade Test", createdAt: now, updatedAt: now }),
  )
  yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
  const roles: ReadonlyArray<"user" | "assistant"> = ["user", "assistant"]
  for (let exchange = 0; exchange < 6; exchange += 1) {
    for (const role of roles) {
      const ordinal = exchange * roles.length + roles.indexOf(role)
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make(`old-${ordinal}`),
          sessionId,
          branchId,
          role,
          parts: [Prompt.textPart({ text: `old-${ordinal} ${"x".repeat(40_000)}` })],
          createdAt: dateFromMillis(1_000 + ordinal),
        }),
      )
    }
  }
})

describe("context compaction degrade path", () => {
  it.live("a failing summary model does not cost the turn; the notice names the omission", () =>
    Effect.gen(function* () {
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fail(
              AiError.make({
                module: "DegradeTest",
                method: "streamText",
                reason: new AiError.UnknownError({ description: "summary provider down" }),
              }),
            ),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("reply after degrade"),
            finishPart({ finishReason: "stop", usage: { inputTokens: 10, outputTokens: 3 } }),
          ]),
        )
      })
      const layer = baseLocalLayerWithProvider(providerLayer, {
        agents: [agent],
        extraLayers: [ModelRegistry.Test([smallWindowModel])],
      })
      const result = yield* narrowR(
        Effect.gen(function* () {
          yield* seedOverflowingHistory
          const runtime = yield* SessionRuntime
          yield* runtime.runPrompt({
            sessionId,
            branchId,
            agentName: agent.name,
            prompt: "continue",
          })
          const events = (yield* (yield* EventStorage).listEvents({ sessionId, branchId })).map(
            (envelope) => envelope.event,
          )
          const durable = yield* (yield* MessageStorage).listMessages(branchId)
          const metrics = yield* runtime.getMetrics({ sessionId, branchId })
          return { events, durable, metrics }
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer), Effect.timeout("8 seconds")),
      )
      expect(calls).toBe(2)
      const notices = result.events.filter((event) => event._tag === "ErrorOccurred")
      expect(notices).toHaveLength(1)
      expect(notices[0]?.error).toContain("Context compaction failed")
      expect(notices[0]?.error).toContain("older messages omitted")
      expect(result.events.some((event) => event._tag === "TurnCompleted")).toBe(true)
      expect(
        result.durable.some((message) => message.metadata?.customType === "model-compaction"),
      ).toBe(false)
      const last = result.durable.at(-1)
      expect(last?.role).toBe("assistant")
      expect(result.metrics.context?.omittedMessages).toBeGreaterThan(0)
      expect(result.metrics.context?.compactions).toBe(0)
    }),
  )
})
