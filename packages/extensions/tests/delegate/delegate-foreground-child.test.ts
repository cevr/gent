/**
 * Foreground delegation runs a real ephemeral child. The child's loop
 * state must land in the child's own storage: a write against the
 * parent database has no matching session row and fails the foreign
 * key, which surfaced live as "Failed to persist loop queue".
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"
import { isToolResultFor } from "../helpers/tool-event.js"

describe("foreground delegation with a real child", () => {
  it.live(
    "returns the child's text from an ephemeral run of the current agent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("delegate", { todo: "Reply with the single word pong" }),
            textStep("pong"),
            textStep("child said pong"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner: "live",
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("delegate")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({ sessionId, branchId, content: "delegate this task" })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).not.toContain("Failed to persist")
            expect(succeeded.event.output).toContain("pong")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
