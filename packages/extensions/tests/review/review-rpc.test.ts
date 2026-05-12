/**
 * Review tool RPC acceptance test — exercises the `review` tool through a
 * real agent turn (LLM emits the tool call, runtime dispatches it inside the
 * per-request scope and through the AgentRunner Test stub). The existing
 * `review-tool.test.ts` calls the executor directly via `runToolWithCtx`,
 * which bypasses the scope boundary production uses.
 *
 * Maps W37 S6 C13 (audit L5-P1-1).
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { AgentRunResult, SessionId } from "@gent/core/extensions/api"
import type { AgentName } from "@gent/core/extensions/api"
import { e2ePreset } from "../helpers/test-preset"

describe("ReviewExtension via model turn", () => {
  it.live(
    "review tool call routes through per-request scope and returns subagent output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("review", {
              description: "test refactor",
              content: "diff --git a/x.ts b/x.ts\n+const x = 1",
              mode: "report",
            }),
            textStep("reviewed"),
          ])
          const subagentRunner = {
            run: (params: { prompt: string; agent: { name: AgentName } }) => {
              const isSynth = params.prompt.includes("Synthesize")
              const text = isSynth
                ? '[{"file":"x.ts","severity":"low","type":"suggestion","text":"could be const"}]'
                : "found nothing critical"
              return Effect.succeed(
                AgentRunResult.cases.success.make({
                  text,
                  sessionId: SessionId.make(isSynth ? "review-synth" : "review-worker"),
                  agentName: params.agent.name,
                  persistence: "ephemeral" as const,
                }),
              )
            },
          }
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner,
          })

          const toolEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                (envelope.event._tag === "ToolCallSucceeded" ||
                  envelope.event._tag === "ToolCallFailed") &&
                (envelope.event as { readonly toolName?: string }).toolName === "review",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "review this diff",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("x.ts")
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
