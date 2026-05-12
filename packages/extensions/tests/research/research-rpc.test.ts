/**
 * Research tool RPC acceptance test — exercises the `research` tool through
 * a real agent turn (LLM emits the tool call, runtime dispatches it inside
 * the per-request scope and through the AgentRunner Test stub). The existing
 * `research-tool.test.ts` calls the executor directly via `runToolWithCtx`,
 * which bypasses the scope boundary production uses.
 *
 * The harness's default `home` is `/tmp`. We pre-create the repo cache dir
 * so `fetchRepo` short-circuits the clone path (matches the direct-test
 * fixture).
 *
 * Maps W37 S6 C13 (audit L5-P1-1).
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Fiber, Layer, Path, Stream } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { AgentRunResult, SessionId } from "@gent/core/extensions/api"
import type { AgentName } from "@gent/core/extensions/api"
import { GitReader } from "../../src/librarian/index.js"
import { e2ePreset } from "../helpers/test-preset"

const ensureRepoCache = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.join("/tmp", ".cache", "repo", "effect-ts/effect"), {
    recursive: true,
  })
}).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, Path.layer)))

describe("ResearchExtension via model turn", () => {
  it.live(
    "research tool call routes through per-request scope and returns subagent output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* ensureRepoCache
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("research", {
              question: "How does Effect handle concurrency?",
              repos: ["effect-ts/effect"],
            }),
            textStep("researched"),
          ])
          const subagentRunner = {
            run: (params: { prompt: string; agent: { name: AgentName } }) =>
              Effect.succeed(
                AgentRunResult.cases.success.make({
                  text: "Effect uses fibers for concurrency. See src/Fiber.ts:42.",
                  sessionId: SessionId.make("research-child-session"),
                  agentName: params.agent.name,
                  persistence: "ephemeral" as const,
                }),
              ),
          }
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner,
            extraLayers: [GitReader.Test],
          })

          const toolEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                (envelope.event._tag === "ToolCallSucceeded" ||
                  envelope.event._tag === "ToolCallFailed") &&
                (envelope.event as { readonly toolName?: string }).toolName === "research",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "research effect concurrency",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("fibers")
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
