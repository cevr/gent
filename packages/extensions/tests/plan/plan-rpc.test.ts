/**
 * Plan tool RPC acceptance test — exercises the `plan` tool through a real
 * agent turn (LLM emits the tool call, runtime dispatches it inside the
 * per-request scope, fans out 7 subagent runs via the AgentRunner Test stub,
 * and finally yields ctx.Interaction.review which auto-approves via the
 * ApprovalService Test default). The existing `plan-tool.test.ts` calls the
 * executor directly via `runToolWithCtx`, which bypasses the scope boundary
 * production uses.
 *
 * Plan-only mode composes the highest fan-out of any extension: 2 parallel
 * plan + 2 cross-review + 2 incorporate + 1 synthesize = 7 ephemeral
 * subagent runs, then a review-mode prompt that touches FileSystem inside
 * the per-request scope. This is the densest scope-leak surface in the
 * extension catalogue.
 *
 * Maps W37 S6 C15 (audit L5-P1-3).
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { AgentRunResult, SessionId } from "@gent/core/extensions/api"
import type { AgentName } from "@gent/core/extensions/api"
import { e2ePreset } from "../helpers/test-preset"

describe("PlanExtension via model turn", () => {
  it.live(
    "plan tool (plan-only) routes 7 subagent runs + review through per-request scope",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("plan", {
              prompt: "implement caching",
              mode: "plan-only",
            }),
            textStep("planned"),
          ])
          const phaseFor = (prompt: string): string => {
            if (prompt.includes("Synthesize these two")) return "synthesize"
            if (prompt.includes("Revise your implementation plan")) return "incorporate"
            if (prompt.includes("Review this implementation plan")) return "review"
            if (prompt.includes("Design an implementation plan")) return "plan"
            return "other"
          }
          const subagentRunner = {
            run: (params: { prompt: string; agent: { name: AgentName } }) =>
              Effect.succeed(
                AgentRunResult.cases.success.make({
                  text: `${phaseFor(params.prompt)} output for caching`,
                  sessionId: SessionId.make(`plan-${phaseFor(params.prompt)}`),
                  agentName: params.agent.name,
                  persistence: "ephemeral" as const,
                }),
              ),
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
                (envelope.event as { readonly toolName?: string }).toolName === "plan",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "plan caching work",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"mode": "plan-only"')
            expect(succeeded.event.output).toContain('"decision": "yes"')
            expect(succeeded.event.output).toContain("synthesize output for caching")
          }
        }).pipe(Effect.timeout("15 seconds")),
      ),
    20_000,
  )
})
