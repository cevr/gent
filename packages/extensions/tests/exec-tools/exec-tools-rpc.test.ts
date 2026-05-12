/**
 * Exec-tools RPC acceptance test — exercises the `bash` tool through a real
 * agent turn (LLM emits the tool call, runtime dispatches it inside the
 * per-request scope, BunChildProcessSpawner from BunServices spawns a real
 * process). The existing `bash.test.ts` calls the executor directly via
 * `runToolWithCtx`, which bypasses the scope boundary production uses.
 *
 * Uses `echo` (SAFE risk class) so no Interaction.approve gate fires.
 *
 * Maps W37 S6 C14 (audit L5-P1-2).
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"

describe("ExecToolsExtension (bash) via model turn", () => {
  it.live(
    "bash tool call routes through per-request scope and returns stdout",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("bash", { command: "echo rpc-harness-bash-marker" }),
            textStep("ran"),
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
                (envelope.event as { readonly toolName?: string }).toolName === "bash",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "run an echo",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("rpc-harness-bash-marker")
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
