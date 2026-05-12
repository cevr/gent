/**
 * Handoff tool RPC acceptance test — exercises the `handoff` tool through a
 * real agent turn (LLM emits the tool call, runtime dispatches it inside the
 * per-request scope, conditionally fans out one summarizer subagent run when
 * context is large, and yields ctx.Interaction.approve which auto-approves
 * via the ApprovalService Test default). The existing `handoff.test.ts`
 * calls the executor directly via `runToolWithCtx`, which bypasses the
 * scope boundary production uses.
 *
 * Uses >2000-char context to trip the summarizer branch so the subagent
 * fan-out + Interaction.approve combination both ride through the
 * per-request scope edge.
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

const largeContext = `Current task: migrate the actor mailbox to bounded queues.\n${"Key decision: use Effect.Queue.bounded(...). ".repeat(100)}`

describe("HandoffExtension via model turn", () => {
  it.live(
    "handoff tool routes summarizer subagent + approval through per-request scope",
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
          const subagentRunner = {
            run: (params: { prompt: string; agent: { name: AgentName } }) =>
              Effect.succeed(
                AgentRunResult.cases.success.make({
                  text: `Distilled: actor mailbox migration to bounded queues`,
                  sessionId: SessionId.make("summarizer-child-session"),
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
                (envelope.event as { readonly toolName?: string }).toolName === "handoff",
            ),
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
            expect(succeeded.event.output).toContain("actor mailbox migration")
            expect(succeeded.event.output).toContain('"reason": "context window filling up"')
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
