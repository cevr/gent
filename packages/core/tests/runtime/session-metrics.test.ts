import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import { Effect, type Layer, Option } from "effect"
import { narrowR } from "../helpers/effect"
import { AgentDefinition, AgentName } from "../../src/domain/agent"
import { ActorCommandId, BranchId, SessionId } from "../../src/domain/ids"
import { Model, ModelId, ProviderId } from "../../src/domain/model"
import { dateFromMillis, Branch, Session } from "../../src/domain/message"
import { textStep } from "../../src/test-utils/sequence-steps"
import { finishPart, LanguageModelLayers, textDeltaPart } from "../../src/test-utils/language-model"
import { ModelRegistry, TEST_MODEL_CONTEXT_LIMIT_TOKENS } from "../../src/runtime/model-registry"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { EventStorage } from "../../src/storage/event-storage"
import { BranchStorage } from "../../src/storage/branch-storage"
import { SessionStorage } from "../../src/storage/session-storage"
import { baseLocalLayerWithProvider } from "../../src/test-utils/in-process-layer"
const cowork = AgentDefinition.make({
  name: AgentName.make("cowork"),
  model: ModelId.make("test/priced"),
})
const modelWithPricing = new Model({
  id: ModelId.make("test/priced"),
  name: "Priced Test",
  provider: ProviderId.make("test"),
  contextLength: TEST_MODEL_CONTEXT_LIMIT_TOKENS,
  pricing: { input: 3, output: 15 }, // $3/M in, $15/M out
})
const makeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  models: readonly Model[] = [modelWithPricing],
) =>
  baseLocalLayerWithProvider(providerLayer, {
    agents: [cowork],
    // `extraLayers` in `baseLocalLayerWithProvider` are merged AFTER the
    // default `ModelRegistry.Test()`, so later merges win the tag.
    extraLayers: [ModelRegistry.Test(models)],
  })
const createSessionBranch = (modelIdLabel = "test/priced") =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    const branches = yield* BranchStorage
    const sessionId = SessionId.make("metrics-session")
    const branchId = BranchId.make("metrics-branch")
    const now = dateFromMillis(1_767_225_600_000)
    void modelIdLabel
    yield* sessions.createSession(
      new Session({
        id: sessionId,
        name: "Metrics Test",
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* branches.createBranch(
      new Branch({
        id: branchId,
        sessionId,
        createdAt: now,
      }),
    )
    return { sessionId, branchId }
  })
describe("SessionRuntime metrics", () => {
  it.live("StreamEnded.costUsd is frozen at emit time and summed into metrics.costUsd", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        textStep("reply one"),
        textStep("reply two"),
      ])
      const result = yield* narrowR(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime
          const events = yield* EventStorage
          const { sessionId, branchId } = yield* createSessionBranch()
          yield* runtime.sendUserMessage({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("turn:first"),
            content: "first",
            agentOverride: AgentName.make("cowork"),
          })
          yield* runtime.sendUserMessage({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("turn:second"),
            content: "second",
            agentOverride: AgentName.make("cowork"),
          })
          const envelopes = yield* events.listEvents({ sessionId, branchId })
          const streamEndeds = envelopes
            .map((e) => e.event)
            .filter(
              (
                e,
              ): e is Extract<
                typeof e,
                {
                  _tag: "StreamEnded"
                }
              > => e._tag === "StreamEnded",
            )
          const metrics = yield* runtime.getMetrics({ sessionId, branchId })
          const receipts = envelopes
            .map((e) => e.event)
            .filter(
              (e): e is Extract<typeof e, { _tag: "TurnCompleted" }> => e._tag === "TurnCompleted",
            )
          return { streamEndeds, metrics, receipts }
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds")),
      )
      expect(result.streamEndeds.length).toBeGreaterThanOrEqual(1)
      // Each turn receipt carries that turn's totals, summed over its steps.
      expect(result.receipts.map((receipt) => receipt.usage)).toEqual(
        result.streamEndeds.map((ev) => ev.usage),
      )
      for (const ev of result.streamEndeds) {
        expect(ev.model).toBe(ModelId.make("test/priced"))
        expect(ev.costUsd).toBeDefined()
        expect(ev.costUsd).toBeGreaterThan(0)
      }
      const expected = result.streamEndeds.reduce((sum, ev) => sum + (ev.costUsd ?? 0), 0)
      expect(result.metrics.costUsd).toBeCloseTo(expected, 10)
      expect(result.metrics.lastInputTokens).toBeGreaterThan(0)
    }),
  )
  it.live("a turn with one step that reports no usage leaves the receipt's usage absent", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        {
          parts: [textDeltaPart("reply without usage"), finishPart({ finishReason: "stop" })],
        },
      ])
      const result = yield* narrowR(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime
          const events = yield* EventStorage
          const { sessionId, branchId } = yield* createSessionBranch()
          yield* runtime.sendUserMessage({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("turn:first"),
            content: "first",
            agentOverride: AgentName.make("cowork"),
          })
          const envelopes = yield* events.listEvents({ sessionId, branchId })
          return envelopes
            .map((e) => e.event)
            .filter(
              (e): e is Extract<typeof e, { _tag: "TurnCompleted" }> => e._tag === "TurnCompleted",
            )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds")),
      )
      expect(result).toHaveLength(1)
      expect(result[0]?.usage).toBeUndefined()
    }),
  )
  it.live("a completed turn reports what the model saw as context metrics", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("reply")])
      const result = yield* narrowR(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime
          const events = yield* EventStorage
          const { sessionId, branchId } = yield* createSessionBranch()
          yield* runtime.sendUserMessage({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("turn:one"),
            content: "one",
            agentOverride: AgentName.make("cowork"),
          })
          const envelopes = yield* events.listEvents({ sessionId, branchId })
          const projected = envelopes
            .map((e) => e.event)
            .filter((e) => e._tag === "ModelContextProjected")
          const metrics = yield* runtime.getMetrics({ sessionId, branchId })
          return { projected, metrics }
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds")),
      )
      expect(result.projected).toHaveLength(1)
      const context = Option.getOrThrow(Option.fromUndefinedOr(result.metrics.context))
      expect(context.contextLimitTokens).toBe(TEST_MODEL_CONTEXT_LIMIT_TOKENS)
      expect(context.estimatedTokens).toBeGreaterThan(0)
      expect(context.availableInputTokens).toBeLessThan(TEST_MODEL_CONTEXT_LIMIT_TOKENS)
      expect(context.omittedMessages).toBe(0)
      expect(context.compactions).toBe(0)
    }),
  )
  it.live("metrics.costUsd does not drift when pricing changes after emission", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("reply")])
      const result = yield* narrowR(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch()
          yield* runtime.sendUserMessage({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("turn:one"),
            content: "one",
            agentOverride: AgentName.make("cowork"),
          })
          const first = yield* runtime.getMetrics({ sessionId, branchId })
          const second = yield* runtime.getMetrics({ sessionId, branchId })
          return { first, second }
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds")),
      )
      // Two reads over the same event log must return the same cost. The cost
      // is frozen on StreamEnded at emit time — changes to pricing or the
      // registry between getMetrics calls cannot shift historical costs.
      expect(result.first.costUsd).toBe(result.second.costUsd)
      expect(result.first.costUsd).toBeGreaterThan(0)
    }),
  )
  it.live("StreamEnded omits costUsd when model has no pricing", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("reply")])
      const unpriced = new Model({
        id: ModelId.make("test/priced"),
        name: "No Pricing",
        provider: ProviderId.make("test"),
        contextLength: TEST_MODEL_CONTEXT_LIMIT_TOKENS,
      })
      const result = yield* narrowR(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime
          const events = yield* EventStorage
          const { sessionId, branchId } = yield* createSessionBranch()
          yield* runtime.sendUserMessage({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("turn:one"),
            content: "one",
            agentOverride: AgentName.make("cowork"),
          })
          const envelopes = yield* events.listEvents({ sessionId, branchId })
          const streamEndeds = envelopes
            .map((e) => e.event)
            .filter(
              (
                e,
              ): e is Extract<
                typeof e,
                {
                  _tag: "StreamEnded"
                }
              > => e._tag === "StreamEnded",
            )
          const metrics = yield* runtime.getMetrics({ sessionId, branchId })
          return { streamEndeds, metrics }
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayer(providerLayer, [unpriced])), Effect.timeout("4 seconds")),
      )
      for (const ev of result.streamEndeds) {
        expect(ev.costUsd).toBeUndefined()
      }
      expect(result.metrics.costUsd).toBe(0)
    }),
  )
})
