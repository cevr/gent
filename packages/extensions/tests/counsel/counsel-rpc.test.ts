/**
 * Counsel tool RPC acceptance test — exercises the `counsel` tool through a
 * real agent turn (LLM emits the tool call, runtime dispatches it inside the
 * per-request scope and through the AgentRunner Test stub). The existing
 * `counsel-tool.test.ts` calls the executor directly via `runToolWithCtx`,
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

describe("CounselExtension via model turn", () => {
  it.live(
    "counsel tool call routes through per-request scope and returns subagent output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("counsel", {
              prompt: "is the actor mailbox bounded correctly?",
              mode: "standard",
            }),
            textStep("counselled"),
          ])
          const subagentRunner = {
            run: (params: { prompt: string; agent: { name: AgentName } }) =>
              Effect.succeed(
                AgentRunResult.cases.success.make({
                  text: `counsel:${params.agent.name}:${params.prompt.slice(0, 32)}`,
                  sessionId: SessionId.make("counsel-child-session"),
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
                (envelope.event as { readonly toolName?: string }).toolName === "counsel",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "get a second opinion",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("counsel:counsel-worker")
            expect(succeeded.event.output).toContain('"mode": "standard"')
          }
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})
