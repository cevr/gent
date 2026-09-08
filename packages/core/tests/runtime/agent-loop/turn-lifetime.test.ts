import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AgentDefinition, DEFAULT_AGENT_NAME } from "@gent/core-internal/domain/agent"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { textStep } from "@gent/core-internal/debug/provider"

describe("turn lifetime", () => {
  it.scopedLive(
    "keeps a waiting model turn alive beyond the entity idle limit",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("LONG-TURN-COMPLETE"), gated: true },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          extensions: [],
          extensionInputs: [],
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
        })
        const completed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "Wait for the model" })
        yield* TestClock.adjust("10 seconds")
        yield* controls.waitForCall(0)
        yield* TestClock.adjust("2 minutes")
        yield* controls.emitAll(0)
        yield* Fiber.join(completed)
        expect(yield* controls.callCount).toBe(1)
        const messages = yield* client.message.list({ branchId })
        expect(
          messages.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text.includes("LONG-TURN-COMPLETE"),
            ),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("8 seconds")),
    10_000,
  )
})
