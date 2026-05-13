import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"
import { ResearchTool } from "../../src/research/research-tool.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { AgentRunResult, SessionId, type ExtensionContextService } from "@gent/core/extensions/api"

import { BunFileSystem } from "@effect/platform-bun"
import { GitReader } from "../../src/librarian/index.js"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
import { AllBuiltinAgents } from "../helpers/builtin-agents.js"

const TEST_HOME = "/tmp/test-research-fixture"

/** Pre-create cache dirs so ensureRepo skips cloning */
const ensureRepoFixtures = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  for (const repo of ["effect-ts/effect", "zio/zio"]) {
    yield* fs.makeDirectory(path.join(TEST_HOME, ".cache", "repo", repo), { recursive: true })
  }
})

const makeCtx = (overrides: {
  agentRun: (
    params: Parameters<ExtensionContextService["Agent"]["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
}) =>
  testToolContext({
    home: TEST_HOME,
    Agent: {
      run: overrides.agentRun,
      listAgents: () => Effect.succeed(AllBuiltinAgents),
    },
  })

const platformLayer = Layer.mergeAll(BunFileSystem.layer, Path.layer, GitReader.Test)
const withRepoFixtures = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  ensureRepoFixtures.pipe(Effect.andThen(effect))

describe("ResearchTool", () => {
  it.live("single repo returns direct response", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "Effect uses fibers for concurrency. See src/Fiber.ts:42.",
            sessionId: SessionId.make("research-1"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        ),
    })

    return narrowR(
      runToolWithCtx(
        ResearchTool,
        { question: "How does Effect handle concurrency?", repos: ["effect-ts/effect"] },
        ctx,
      ).pipe(
        withRepoFixtures,
        Effect.map((result) => {
          expect(result.response).toContain("Effect uses fibers")
          expect(result.repos).toEqual(["effect-ts/effect"])
        }),
        Effect.provide(platformLayer),
      ),
    )
  })

  it.live("multiple repos triggers synthesis with model B", () => {
    let synthesisModelId: string | undefined
    const prompts: string[] = []
    const ctx = makeCtx({
      agentRun: (params) => {
        prompts.push(params.prompt)
        if (params.runSpec?.overrides?.modelId !== undefined) {
          synthesisModelId = params.runSpec.overrides.modelId
        }
        if (params.prompt.includes("Synthesize")) {
          return Effect.succeed(
            AgentRunResult.cases.success.make({
              text: "Comparative analysis: both use fiber-based concurrency.",
              sessionId: SessionId.make("synthesis"),
              agentName: params.agent.name,
              persistence: "ephemeral" as const,
            }),
          )
        }
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: `Findings for ${params.prompt.includes("effect-ts") ? "effect" : "zio"}.`,
            sessionId: SessionId.make("worker"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(
        ResearchTool,
        {
          question: "Compare concurrency models",
          repos: ["effect-ts/effect", "zio/zio"],
        },
        ctx,
      ).pipe(
        withRepoFixtures,
        Effect.map((result) => {
          expect(result.response).toContain("Comparative analysis")
          expect(result.repoCount).toBe(2)
          expect(synthesisModelId).toBe("openai/gpt-5.4")
          expect(prompts.some((p) => p.includes("Synthesize"))).toBe(true)
        }),
        Effect.provide(platformLayer),
      ),
    )
  })

  it.live("includes focus in research prompts", () => {
    let capturedPrompt = ""
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "Found scheduler patterns.",
            sessionId: SessionId.make("focus"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(
        ResearchTool,
        {
          question: "How does the scheduler work?",
          repos: ["effect-ts/effect"],
          focus: "src/internal/scheduler",
        },
        ctx,
      ).pipe(
        withRepoFixtures,
        Effect.map(() => {
          expect(capturedPrompt).toContain("src/internal/scheduler")
          expect(capturedPrompt).toContain("How does the scheduler work?")
        }),
        Effect.provide(platformLayer),
      ),
    )
  })

  it.live("rejects empty repos", () =>
    narrowR(
      runToolWithCtx(
        ResearchTool,
        { question: "test", repos: [] },
        makeCtx({ agentRun: () => Effect.die("unreachable") }),
      ).pipe(
        withRepoFixtures,
        Effect.map((result) => {
          expect(result.error).toBe("At least one repository spec required")
        }),
        Effect.provide(platformLayer),
      ),
    ),
  )

  it.live("rejects too many repos", () =>
    narrowR(
      runToolWithCtx(
        ResearchTool,
        { question: "test", repos: ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"] },
        makeCtx({ agentRun: () => Effect.die("unreachable") }),
      ).pipe(
        withRepoFixtures,
        Effect.map((result) => {
          expect(result.error).toBe("Too many repos (max 5)")
        }),
        Effect.provide(platformLayer),
      ),
    ),
  )
})
