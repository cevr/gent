/**
 * Background delegation admits a durable child and returns at once. The
 * child's completion must come back as a message on the parent branch,
 * which wakes the parent for another turn. Nothing else carries the result.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/test-utils/sequence-steps"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { e2ePreset } from "../helpers/test-preset"

describe("background delegation with a real child", () => {
  it.live(
    "the child's completion lands on the parent branch and wakes it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("delegate", { todo: "Reply with the single word pong", background: true }),
            textStep("child started"),
            textStep("pong"),
            textStep("parent read pong"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner: "live",
          })
          yield* client.message.send({ sessionId, branchId, content: "delegate this task" })
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "user" && message.metadata?.customType === "child-completion",
              ) && current.runtime._tag === "Idle",
            8_000,
            "child completion delivered to the parent",
          )
          const completion = snapshot.messages.find(
            (message) => message.metadata?.customType === "child-completion",
          )
          expect(completion).toBeDefined()
          const last = snapshot.messages.at(-1)
          expect(last?.role).toBe("assistant")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})
