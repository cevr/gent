import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { CodeReviewTool } from "@gent/core/tools/code-review"
import { Agents, AgentRunnerService } from "@gent/core/domain/agent"
import type { ToolContext } from "@gent/core/domain/tool"
import type { SessionId } from "@gent/core/domain/ids"
import { EventStore } from "@gent/core/domain/event"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

const TestExtRegistry = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin",
      sourcePath: "test",
      setup: { agents: Object.values(Agents) },
    },
  ]),
)

const runtimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

const platformLayer = Layer.mergeAll(BunServices.layer, runtimePlatformLayer, TestExtRegistry)

const workflowTestLayer = Layer.mergeAll(TestExtRegistry, EventStore.Test(), Storage.Test())

describe("CodeReviewTool", () => {
  it.live("passes description to runner", () => {
    let capturedPrompt = ""
    const capturedOverrides: Array<Record<string, unknown> | undefined> = []
    const capturingRunner = Layer.succeed(AgentRunnerService, {
      run: (params) => {
        capturedPrompt = params.prompt
        capturedOverrides.push(params.overrides as Record<string, unknown> | undefined)
        return Effect.succeed({
          _tag: "success" as const,
          text: "[]",
          sessionId: "child" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer, workflowTestLayer)
    return CodeReviewTool.execute(
      { description: "refactored auth module", content: "diff --git a/auth.ts b/auth.ts" },
      ctx,
    ).pipe(
      Effect.map(() => {
        expect(capturedPrompt).toContain("refactored auth module")
        const reviewOverrides = capturedOverrides.find(
          (overrides) => overrides?.["deniedTools"] !== undefined,
        )
        expect(reviewOverrides?.["allowedActions"]).toEqual(["read"])
        expect(reviewOverrides?.["deniedTools"]).toEqual(["bash"])
      }),
      Effect.provide(layer),
    )
  })

  it.live("parses structured JSON review output", () => {
    const jsonOutput = JSON.stringify([
      {
        file: "src/auth.ts",
        line: 10,
        severity: "high",
        type: "bug",
        text: "Missing null check",
      },
    ])
    const runner = Layer.succeed(AgentRunnerService, {
      run: () =>
        Effect.succeed({
          _tag: "success" as const,
          text: jsonOutput,
          sessionId: "child" as SessionId,
          agentName: "reviewer",
        }),
    })
    const layer = Layer.mergeAll(runner, platformLayer, workflowTestLayer)
    return CodeReviewTool.execute({ description: "test", content: "fake diff" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.comments.length).toBe(1)
        expect(result.comments[0]!.severity).toBe("high")
        expect(result.summary?.high).toBe(1)
      }),
      Effect.provide(layer),
    )
  })

  it.live("falls back to raw text on parse failure", () => {
    const runner = Layer.succeed(AgentRunnerService, {
      run: () =>
        Effect.succeed({
          _tag: "success" as const,
          text: "not valid json",
          sessionId: "child" as SessionId,
          agentName: "reviewer",
        }),
    })
    const layer = Layer.mergeAll(runner, platformLayer, workflowTestLayer)
    return CodeReviewTool.execute({ description: "test", content: "fake diff" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.comments.length).toBe(0)
        expect(result.raw).toBe("not valid json")
      }),
      Effect.provide(layer),
    )
  })

  it.live("fix mode runs single review+execute cycle", () => {
    const prompts: string[] = []
    const runner = Layer.succeed(AgentRunnerService, {
      run: (params) =>
        Effect.sync(() => {
          prompts.push(params.prompt)
          if (params.prompt.includes("Synthesize these adversarial reviews")) {
            return {
              _tag: "success" as const,
              text: JSON.stringify([
                {
                  file: "src/auth.ts",
                  severity: "high",
                  type: "bug",
                  text: "Missing null check",
                },
              ]),
              sessionId: "synth" as SessionId,
              agentName: params.agent.name,
            }
          }
          if (params.prompt.includes("Fix the issues identified")) {
            return {
              _tag: "success" as const,
              text: "Applied fixes.",
              sessionId: "exec" as SessionId,
              agentName: params.agent.name,
            }
          }
          return {
            _tag: "success" as const,
            text: "[]",
            sessionId: "child" as SessionId,
            agentName: params.agent.name,
          }
        }),
    })
    const layer = Layer.mergeAll(runner, platformLayer, workflowTestLayer)
    return CodeReviewTool.execute(
      { description: "test", content: "fake diff", mode: "fix" },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.output).toBe("Applied fixes.")
        expect(
          prompts.some((prompt) => prompt.includes("Work through the findings in small batches")),
        ).toBe(true)
        // No evaluator loop
        expect(
          prompts.some((prompt) =>
            prompt.includes("Evaluate whether the review findings have been addressed"),
          ),
        ).toBe(false)
      }),
      Effect.provide(layer),
    )
  })

  it.live("includes session ref on structured output", () => {
    const jsonOutput = JSON.stringify([
      { file: "a.ts", severity: "low", type: "style", text: "minor" },
    ])
    const runner = Layer.succeed(AgentRunnerService, {
      run: () =>
        Effect.succeed({
          _tag: "success" as const,
          text: jsonOutput,
          sessionId: "child" as SessionId,
          agentName: "reviewer",
        }),
    })
    const layer = Layer.mergeAll(runner, platformLayer, workflowTestLayer)
    return CodeReviewTool.execute({ description: "test", content: "fake diff" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.session).toBe("session://child")
      }),
      Effect.provide(layer),
    )
  })
})
