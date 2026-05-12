/**
 * Delegate tool RPC acceptance test — exercises the `delegate` tool through
 * a real agent turn (LLM emits the tool call, runtime dispatches it inside
 * the per-request scope). The existing `delegate-tool.test.ts` calls the
 * executor directly via `runToolWithCtx`, which bypasses the scope boundary
 * production uses.
 *
 * Maps W36 C5 (audit L5-P2-1).
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { AgentRunResult, SessionId } from "@gent/core/extensions/api"
import type { AgentName } from "@gent/core/extensions/api"
import { e2ePreset } from "../helpers/test-preset"

describe("DelegateExtension via model turn", () => {
  it.live(
    "delegate tool call routes through per-request scope and returns subagent output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("delegate", { agent: "explore", todo: "summarise repo layout" }),
            textStep("delegated"),
          ])
          const subagentRunner = {
            run: (params: { prompt: string; agent: { name: AgentName } }) =>
              Effect.succeed(
                AgentRunResult.cases.success.make({
                  text: `subagent:${params.agent.name}:${params.prompt}`,
                  sessionId: SessionId.make("delegate-child-session"),
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
                (envelope.event as { readonly toolName?: string }).toolName === "delegate",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "delegate this task",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("subagent:explore:summarise repo layout")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
