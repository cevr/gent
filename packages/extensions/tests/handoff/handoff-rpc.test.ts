import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Schema, Stream } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"
import { isToolResultFor } from "../helpers/tool-event.js"

const largeContext = `Current task: migrate the actor mailbox to bounded queues.\n${"Key decision: use Effect.Queue.bounded(...). ".repeat(100)}`

describe("HandoffExtension via model turn", () => {
  it.live(
    "approval preserves the full supplied handoff without a second model run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("handoff", {
              context: largeContext,
              reason: "context window filling up",
            }),
            textStep("handed-off"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("handoff")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "hand off to a new session",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"handoff": true')
            expect(succeeded.event.output).toContain(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(largeContext),
            )
            expect(succeeded.event.output).toContain('"reason": "context window filling up"')
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
