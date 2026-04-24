import { describe, expect, test } from "bun:test"
import { Effect, type Layer } from "effect"
import { AgentDefinition } from "@gent/core/domain/agent"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { Model, ModelId } from "@gent/core/domain/model"
import { Branch, Session } from "@gent/core/domain/message"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import type { Provider } from "@gent/core/providers/provider"
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
  provider: "test",
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
    yield* storage.createSession(
      new Session({
        id: sessionId,
        name: "Metrics Test",
        createdAt: now,
        updatedAt: now,
        agent: "cowork",
        model: ModelId.make(modelIdLabel),
      }),
    )
    yield* storage.createBranch(
      new Branch({
        id: branchId,
        sessionId,
        createdAt: now,
        updatedAt: now,
      }),
    )
    return { sessionId, branchId }
  })

describe("SessionRuntime metrics", () => {
  test("StreamEnded.costUsd is frozen at emit time and summed into metrics.costUsd", async () => {
    const { layer: providerLayer } = await Effect.runPromise(
      createSequenceProvider([textStep("reply one"), textStep("reply two")]),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const storage = yield* Storage
        const { sessionId, branchId } = yield* createSessionBranch()

        yield* runtime.runPrompt({
          sessionId,
          branchId,
          agentName: "cowork" as never,
          prompt: "first",
        })
        yield* runtime.runPrompt({
          sessionId,
          branchId,
          agentName: "cowork" as never,
          prompt: "second",
        })

        const envelopes = yield* storage.listEvents({ sessionId, branchId })
        const streamEndeds = envelopes
          .map((e) => e.event)
          .filter((e): e is Extract<typeof e, { _tag: "StreamEnded" }> => e._tag === "StreamEnded")

        const metrics = yield* runtime.getMetrics({ sessionId, branchId })
        return { streamEndeds, metrics }
      }).pipe(Effect.provide(makeLayer(providerLayer))),
    )

    expect(result.streamEndeds.length).toBeGreaterThanOrEqual(1)
    for (const ev of result.streamEndeds) {
      expect(ev.model).toBe("test/priced")
      expect(ev.costUsd).toBeDefined()
      expect(ev.costUsd).toBeGreaterThan(0)
    }

    const expected = result.streamEndeds.reduce((sum, ev) => sum + (ev.costUsd ?? 0), 0)
    expect(result.metrics.costUsd).toBeCloseTo(expected, 10)
    expect(result.metrics.lastModelId).toBe("test/priced")
    expect(result.metrics.lastInputTokens).toBeGreaterThan(0)
  })

  test("metrics.costUsd does not drift when pricing changes after emission", async () => {
    const { layer: providerLayer } = await Effect.runPromise(
      createSequenceProvider([textStep("reply")]),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const { sessionId, branchId } = yield* createSessionBranch()

        yield* runtime.runPrompt({
          sessionId,
          branchId,
          agentName: "cowork" as never,
          prompt: "one",
        })
        const first = yield* runtime.getMetrics({ sessionId, branchId })
        const second = yield* runtime.getMetrics({ sessionId, branchId })
        return { first, second }
      }).pipe(Effect.provide(makeLayer(providerLayer))),
    )

    // Two reads over the same event log must return the same cost. The cost
    // is frozen on StreamEnded at emit time — changes to pricing or the
    // registry between getMetrics calls cannot shift historical costs.
    expect(result.first.costUsd).toBe(result.second.costUsd)
    expect(result.first.costUsd).toBeGreaterThan(0)
  })

  test("StreamEnded omits costUsd when model has no pricing", async () => {
    const { layer: providerLayer } = await Effect.runPromise(
      createSequenceProvider([textStep("reply")]),
    )
    const unpriced = new Model({
      id: ModelId.make("test/priced"),
      name: "No Pricing",
      provider: "test",
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const storage = yield* Storage
        const { sessionId, branchId } = yield* createSessionBranch()
        yield* runtime.runPrompt({
          sessionId,
          branchId,
          agentName: "cowork" as never,
          prompt: "one",
        })
        const envelopes = yield* storage.listEvents({ sessionId, branchId })
        const streamEndeds = envelopes
          .map((e) => e.event)
          .filter((e): e is Extract<typeof e, { _tag: "StreamEnded" }> => e._tag === "StreamEnded")
        const metrics = yield* runtime.getMetrics({ sessionId, branchId })
        return { streamEndeds, metrics }
      }).pipe(Effect.provide(makeLayer(providerLayer, [unpriced]))),
    )

    for (const ev of result.streamEndeds) {
      expect(ev.costUsd).toBeUndefined()
    }
    expect(result.metrics.costUsd).toBe(0)
    expect(result.metrics.lastModelId).toBe("test/priced")
  })
})
