import { describe, it, expect } from "effect-bun-test"
import { beforeAll } from "bun:test"
import { Effect, Layer, Path } from "effect"
import { ResearchTool } from "@gent/extensions/research/research-tool"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import type { AgentRunResult } from "@gent/core/domain/agent"
import { SessionId } from "@gent/core/domain/ids"
import { BunFileSystem } from "@effect/platform-bun"
import { mkdirSync } from "node:fs"
import { GitReader } from "@gent/extensions/librarian/git-reader"

const TEST_HOME = "/tmp/test-research-" + Date.now()

/** Pre-create cache dirs so ensureRepo skips cloning */
beforeAll(() => {
  for (const repo of ["effect-ts/effect", "zio/zio"]) {
    mkdirSync(`${TEST_HOME}/.cache/repo/${repo}`, { recursive: true })
  }
})

const makeCtx = (overrides: {
  agentRun: (
    params: Parameters<ExtensionHostContext.Agent["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
}) =>
  testToolContext({
    home: TEST_HOME,
    agent: {
      get: () => Effect.succeed(undefined),
      require: () => Effect.die("require not wired"),
      run: overrides.agentRun,
      resolveDualModelPair: () =>
        Effect.succeed(["anthropic/claude-opus-4-6", "openai/gpt-5.4"] as const),
    },
  })

const platformLayer = Layer.mergeAll(BunFileSystem.layer, Path.layer, GitReader.Test)

describe("ResearchTool", () => {
  it.live("single repo returns direct response", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: "Effect uses fibers for concurrency. See src/Fiber.ts:42.",
          sessionId: SessionId.of("research-1"),
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        }),
    })

    return ResearchTool.execute(
      { question: "How does Effect handle concurrency?", repos: ["effect-ts/effect"] },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.response).toContain("Effect uses fibers")
        expect(result.repos).toEqual(["effect-ts/effect"])
      }),
      Effect.provide(platformLayer),
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
          return Effect.succeed({
            _tag: "success" as const,
            text: "Comparative analysis: both use fiber-based concurrency.",
            sessionId: SessionId.of("synthesis"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          })
        }
        return Effect.succeed({
          _tag: "success" as const,
          text: `Findings for ${params.prompt.includes("effect-ts") ? "effect" : "zio"}.`,
          sessionId: SessionId.of("worker"),
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        })
      },
    })

    return ResearchTool.execute(
      {
        question: "Compare concurrency models",
        repos: ["effect-ts/effect", "zio/zio"],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.response).toContain("Comparative analysis")
        expect(result.repoCount).toBe(2)
        expect(synthesisModelId).toBe("openai/gpt-5.4")
        expect(prompts.some((p) => p.includes("Synthesize"))).toBe(true)
      }),
      Effect.provide(platformLayer),
    )
  })

  it.live("includes focus in research prompts", () => {
    let capturedPrompt = ""
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "Found scheduler patterns.",
          sessionId: SessionId.of("focus"),
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        })
      },
    })

    return ResearchTool.execute(
      {
        question: "How does the scheduler work?",
        repos: ["effect-ts/effect"],
        focus: "src/internal/scheduler",
      },
      ctx,
    ).pipe(
      Effect.map(() => {
        expect(capturedPrompt).toContain("src/internal/scheduler")
        expect(capturedPrompt).toContain("How does the scheduler work?")
      }),
      Effect.provide(platformLayer),
    )
  })

  it.live("rejects empty repos", () =>
    ResearchTool.execute(
      { question: "test", repos: [] },
      makeCtx({ agentRun: () => Effect.die("unreachable") }),
    ).pipe(
      Effect.map((result) => {
        expect(result.error).toBe("At least one repository spec required")
      }),
      Effect.provide(platformLayer),
    ),
  )

  it.live("rejects too many repos", () =>
    ResearchTool.execute(
      { question: "test", repos: ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"] },
      makeCtx({ agentRun: () => Effect.die("unreachable") }),
    ).pipe(
      Effect.map((result) => {
        expect(result.error).toBe("Too many repos (max 5)")
      }),
      Effect.provide(platformLayer),
    ),
  )
})
