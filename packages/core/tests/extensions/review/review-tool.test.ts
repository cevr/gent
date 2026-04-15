import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { ReviewTool } from "@gent/core/extensions/review/review-tool"
import { type AgentRunResult } from "@gent/core/domain/agent"
import { Agents } from "@gent/core/extensions/all-agents"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { SessionId } from "@gent/core/domain/ids"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const makeCtx = (overrides: {
  agentRun: (
    params: Parameters<ExtensionHostContext.Agent["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
}) =>
  testToolContext({
    agent: {
      get: (name) => Effect.succeed(Object.values(Agents).find((a) => a.name === name)),
      require: (name) => {
        const agent = Object.values(Agents).find((a) => a.name === name)
        return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
      },
      run: overrides.agentRun,
      resolveDualModelPair: () =>
        Effect.succeed(["anthropic/claude-opus-4-6", "openai/gpt-5.4"] as const),
    },
    interaction: {
      approve: dieStub("interaction.approve"),
      present: dieStub("interaction.present"),
      confirm: dieStub("interaction.confirm"),
      review: dieStub("interaction.review"),
    },
  })

// RuntimePlatform needed — resolveReviewInput carries it in the type even when content is provided
const runtimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

describe("ReviewTool", () => {
  it.live("passes description to runner", () => {
    let capturedPrompt = ""
    const capturedOverrides: Array<Record<string, unknown> | undefined> = []
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedPrompt = params.prompt
        capturedOverrides.push(params.overrides as Record<string, unknown> | undefined)
        return Effect.succeed({
          _tag: "success" as const,
          text: "[]",
          sessionId: SessionId.of("child"),
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        })
      },
    })

    return ReviewTool.execute(
      { description: "refactored auth module", content: "diff --git a/auth.ts b/auth.ts" },
      ctx,
    ).pipe(
      Effect.map(() => {
        expect(capturedPrompt).toContain("refactored auth module")
        const reviewOverrides = capturedOverrides.find(
          (overrides) => overrides?.["deniedTools"] !== undefined,
        )
        expect(reviewOverrides?.["allowedTools"]).toEqual(["grep", "glob", "read", "memory_search"])
        expect(reviewOverrides?.["deniedTools"]).toEqual(["bash"])
      }),
      Effect.provide(runtimePlatformLayer),
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
    const ctx = makeCtx({
      agentRun: () =>
        Effect.succeed({
          _tag: "success" as const,
          text: jsonOutput,
          sessionId: SessionId.of("child"),
          agentName: "review-worker",
          persistence: "ephemeral" as const,
        }),
    })

    return ReviewTool.execute({ description: "test", content: "fake diff" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.comments.length).toBe(1)
        expect(result.comments[0]!.severity).toBe("high")
        expect(result.summary?.high).toBe(1)
      }),
      Effect.provide(runtimePlatformLayer),
    )
  })

  it.live("parse failure fails the tool with ReviewError", () => {
    const ctx = makeCtx({
      agentRun: () =>
        Effect.succeed({
          _tag: "success" as const,
          text: "not valid json",
          sessionId: SessionId.of("child"),
          agentName: "review-worker",
          persistence: "ephemeral" as const,
        }),
    })

    return ReviewTool.execute({ description: "test", content: "fake diff" }, ctx).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe("ReviewError")
        expect(error.message).toContain("not valid JSON")
      }),
      Effect.provide(runtimePlatformLayer),
    )
  })

  it.live("fix mode runs single review+execute cycle", () => {
    const prompts: string[] = []
    const ctx = makeCtx({
      agentRun: (params) =>
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
              sessionId: SessionId.of("synth"),
              agentName: params.agent.name,
              persistence: "ephemeral" as const,
            }
          }
          if (params.prompt.includes("Fix the issues identified")) {
            return {
              _tag: "success" as const,
              text: "Applied fixes.",
              sessionId: SessionId.of("exec"),
              agentName: params.agent.name,
              persistence: "durable" as const,
            }
          }
          return {
            _tag: "success" as const,
            text: "[]",
            sessionId: SessionId.of("child"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }
        }),
    })

    return ReviewTool.execute({ description: "test", content: "fake diff", mode: "fix" }, ctx).pipe(
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
      Effect.provide(runtimePlatformLayer),
    )
  })

  it.live("omits session ref for ephemeral review-worker output", () => {
    const jsonOutput = JSON.stringify([
      { file: "a.ts", severity: "low", type: "style", text: "minor" },
    ])
    const ctx = makeCtx({
      agentRun: () =>
        Effect.succeed({
          _tag: "success" as const,
          text: jsonOutput,
          sessionId: SessionId.of("child"),
          agentName: "review-worker",
          persistence: "ephemeral" as const,
        }),
    })

    return ReviewTool.execute({ description: "test", content: "fake diff" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.session).toBeUndefined()
      }),
      Effect.provide(runtimePlatformLayer),
    )
  })
})
