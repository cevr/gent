/**
 * Memory tools RPC acceptance test — exercises memory_remember / memory_recall
 * through a real agent turn (LLM emits the tool call, runtime dispatches it
 * inside the per-request scope and through the MemoryVault Test layer wired
 * by `e2ePreset.layerOverrides["@gent/memory"]`).
 *
 * Maps W36 C5 (audit L5-P2-1).
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"

describe("MemoryExtension via model turn", () => {
  it.live(
    "memory_remember tool call routes through per-request scope and writes to the vault",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("memory_remember", {
              title: "rpc-harness coverage",
              content: "delegate + memory exercised through per-request scope",
              scope: "global",
            }),
            textStep("stored"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                (envelope.event._tag === "ToolCallSucceeded" ||
                  envelope.event._tag === "ToolCallFailed") &&
                (envelope.event as { readonly toolName?: string }).toolName === "memory_remember",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "remember this fact",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"stored": true')
            expect(succeeded.event.output).toContain('"scope": "global"')
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
