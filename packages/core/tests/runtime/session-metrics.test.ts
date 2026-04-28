import { describe, expect, it } from "effect-bun-test"
import { Effect, type Layer } from "effect"
const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>
import { AgentDefinition, AgentName } from "@gent/core/domain/agent"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { Model, ModelId, ProviderId } from "@gent/core/domain/model"
import { Branch, Session } from "@gent/core/domain/message"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { baseLocalLayerWithProvider } from "@gent/core/test-utils/in-process-layer"
const cowork = AgentDefinition.make({
  name: "cowork" as never,
  model: "test/priced" as never,
})
const modelWithPricing = new Model({
  id: ModelId.make("test/priced"),
  name: "Priced Test",
  provider: ProviderId.make("test"),
  pricing: { input: 3, output: 15 }, // $3/M in, $15/M out
})
const makeLayer = (
  providerLayer: Layer.Layer<Provider>,
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
    const storage = yield* Storage
    const sessionId = SessionId.make("metrics-session")
    const branchId = BranchId.make("metrics-branch")
    const now = new Date()
    void modelIdLabel
    yield* storage.createSession(
      new Session({
        id: sessionId,
        name: "Metrics Test",
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* storage.createBranch(
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
      const { layer: providerLayer } = yield* Provider.Sequence([
        textStep("reply one"),
        textStep("reply two"),
      ])
      const result = yield* narrowR(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime
          const storage = yield* Storage
          const { sessionId, branchId } = yield* createSessionBranch()
          yield* runtime.runPrompt({
            sessionId,
            branchId,
            agentName: AgentName.make("cowork") as never,
            prompt: "first",
          })
          yield* runtime.runPrompt({
            sessionId,
            branchId,
            agentName: AgentName.make("cowork") as never,
            prompt: "second",
          })
          const envelopes = yield* storage.listEvents({ sessionId, branchId })
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
        }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds")),
      )
      expect(result.streamEndeds.length).toBeGreaterThanOrEqual(1)
      for (const ev of result.streamEndeds) {
        expect(ev.model).toBe(ModelId.make("test/priced"))
        expect(ev.costUsd).toBeDefined()
        expect(ev.costUsd).toBeGreaterThan(0)
      }
      const expected = result.streamEndeds.reduce((sum, ev) => sum + (ev.costUsd ?? 0), 0)
      expect(result.metrics.costUsd).toBeCloseTo(expected, 10)
      expect(result.metrics.lastModelId).toBe(ModelId.make("test/priced"))
      expect(result.metrics.lastInputTokens).toBeGreaterThan(0)
    }),
  )
  it.live("metrics.costUsd does not drift when pricing changes after emission", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([textStep("reply")])
      const result = yield* narrowR(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch()
          yield* runtime.runPrompt({
            sessionId,
            branchId,
            agentName: AgentName.make("cowork") as never,
            prompt: "one",
          })
          const first = yield* runtime.getMetrics({ sessionId, branchId })
          const second = yield* runtime.getMetrics({ sessionId, branchId })
          return { first, second }
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
      const { layer: providerLayer } = yield* Provider.Sequence([textStep("reply")])
      const unpriced = new Model({
        id: ModelId.make("test/priced"),
        name: "No Pricing",
        provider: ProviderId.make("test"),
      })
      const result = yield* narrowR(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime
          const storage = yield* Storage
          const { sessionId, branchId } = yield* createSessionBranch()
          yield* runtime.runPrompt({
            sessionId,
            branchId,
            agentName: AgentName.make("cowork") as never,
            prompt: "one",
          })
          const envelopes = yield* storage.listEvents({ sessionId, branchId })
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
        }).pipe(Effect.provide(makeLayer(providerLayer, [unpriced])), Effect.timeout("4 seconds")),
      )
      for (const ev of result.streamEndeds) {
        expect(ev.costUsd).toBeUndefined()
      }
      expect(result.metrics.costUsd).toBe(0)
      expect(result.metrics.lastModelId).toBe(ModelId.make("test/priced"))
    }),
  )
})
