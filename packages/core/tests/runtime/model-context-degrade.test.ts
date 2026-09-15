import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { narrowR } from "../helpers/effect"
import { AgentDefinition, AgentName } from "../../src/domain/agent"
import { ActorCommandId, BranchId, MessageId, SessionId } from "../../src/domain/ids"
import { Model, ModelId, ProviderId } from "../../src/domain/model"
import { dateFromMillis, Branch, Message, Session } from "../../src/domain/message"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { textStep } from "../../src/test-utils/sequence-steps"
import {
  ModelCompactionError,
  ModelContextCompactor,
} from "../../src/runtime/model-context-compactor"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { EventStorage } from "../../src/storage/event-storage"
import { BranchStorage } from "../../src/storage/branch-storage"
import { MessageStorage } from "../../src/storage/message-storage"
import { SessionStorage } from "../../src/storage/session-storage"
import { baseLocalLayerWithProvider } from "../../src/test-utils/in-process-layer"

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

describe("context compaction degrade path", () => {
  it.live("a failing compactor does not cost the turn; the notice names the omission", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("reply after degrade"),
      ])
      const layer = baseLocalLayerWithProvider(providerLayer, {
        agents: [agent],
        extraLayers: [ModelRegistry.Test([smallWindowModel]), failingCompactor],
      })
      const result = yield* narrowR(
        Effect.gen(function* () {
          yield* seedOverflowingHistory
          const runtime = yield* SessionRuntime
          yield* runtime.sendUserMessage({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("turn:continue"),
            content: "continue",
            agentOverride: agent.name,
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
      expect(yield* controls.callCount).toBe(1)
      // The notice text is the projection's; tests/runtime/agent/turn-window.test.ts reads it.
      expect(result.events.filter((event) => event._tag === "ErrorOccurred")).toHaveLength(1)
      expect(result.events.some((event) => event._tag === "TurnCompleted")).toBe(true)
      expect(
        result.durable.some((message) => message.metadata?.customType === "context-window"),
      ).toBe(false)
      const last = result.durable.at(-1)
      expect(last?.role).toBe("assistant")
      expect(result.metrics.context?.omittedMessages).toBeGreaterThan(0)
      expect(result.metrics.context?.compactions).toBe(0)
    }),
  )
})
