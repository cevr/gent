import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, FileSystem } from "effect"
import { BunServices } from "@effect/platform-bun"
import { FinderTool } from "@gent/core/tools/finder"
import { CodeReviewTool } from "@gent/core/tools/code-review"
import { HandoffTool } from "@gent/core/tools/handoff"
import { CounselTool } from "@gent/core/tools/counsel"
import { Agents, SubagentRunnerService } from "@gent/core/domain/agent"
import { HandoffHandler } from "@gent/core/domain/interaction-handlers"
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

const mockRunnerSuccess = Layer.succeed(SubagentRunnerService, {
  run: (params) =>
    Effect.succeed({
      _tag: "success" as const,
      text: `response from ${params.agent.name}`,
      sessionId: "child-session" as SessionId,
      agentName: params.agent.name,
    }),
})

const mockRunnerError = Layer.succeed(SubagentRunnerService, {
  run: () =>
    Effect.succeed({
      _tag: "error" as const,
      error: "runner failed",
    }),
})

const mockRunnerErrorWithSession = Layer.succeed(SubagentRunnerService, {
  run: () =>
    Effect.succeed({
      _tag: "error" as const,
      error: "runner failed",
      sessionId: "error-session" as SessionId,
    }),
})

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

describe("FinderTool", () => {
  it.live("success → { found: true, response }", () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    return FinderTool.execute({ query: "find auth module" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.found).toBe(true)
        expect(result.response).toContain("response from")
      }),
      Effect.provide(layer),
    )
  })

  it.live("error → { found: false, error }", () => {
    const layer = Layer.mergeAll(mockRunnerError, platformLayer)
    return FinderTool.execute({ query: "find something" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.found).toBe(false)
        expect(result.error).toBe("runner failed")
      }),
      Effect.provide(layer),
    )
  })
})

describe("CodeReviewTool", () => {
  it.live("passes description to runner", () => {
    let capturedPrompt = ""
    const capturedOverrides: Array<Record<string, unknown> | undefined> = []
    const capturingRunner = Layer.succeed(SubagentRunnerService, {
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
    const runner = Layer.succeed(SubagentRunnerService, {
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
    const runner = Layer.succeed(SubagentRunnerService, {
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
    const runner = Layer.succeed(SubagentRunnerService, {
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
})

describe("HandoffTool", () => {
  it.live("returns handoff confirmed when user accepts", () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer, HandoffHandler.Test(["confirm"]))
    return HandoffTool.execute(
      {
        context: "Current task: implement auth. Key files: src/auth.ts",
        reason: "context window filling up",
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.handoff).toBe(true)
        expect(result.summary).toContain("implement auth")
        expect(result.parentSessionId).toBe("test-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("returns handoff rejected when user declines", () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer, HandoffHandler.Test(["reject"]))
    return HandoffTool.execute(
      {
        context: "Current task: implement auth",
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.handoff).toBe(false)
        expect(result.reason).toBe("User rejected handoff")
      }),
      Effect.provide(layer),
    )
  })
})

describe("Session refs in subagent output", () => {
  it.live("FinderTool appends session ref to response", () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    return FinderTool.execute({ query: "find something" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.response).toContain("\n\nFull session: session://child-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("CodeReviewTool includes session ref on structured output", () => {
    const jsonOutput = JSON.stringify([
      { file: "a.ts", severity: "low", type: "style", text: "minor" },
    ])
    const runner = Layer.succeed(SubagentRunnerService, {
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

  it.live("error path includes session ref when sessionId present", () => {
    const layer = Layer.mergeAll(mockRunnerErrorWithSession, platformLayer)
    return FinderTool.execute({ query: "find something" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.found).toBe(false)
        expect(result.error).toContain("session://error-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("error path omits session ref when sessionId absent", () => {
    const layer = Layer.mergeAll(mockRunnerError, platformLayer)
    return FinderTool.execute({ query: "find something" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.error).toBe("runner failed")
        expect(result.error).not.toContain("session://")
      }),
      Effect.provide(layer),
    )
  })
})

describe("CounselTool", () => {
  it.live("always routes to deepwork reviewer", () => {
    let capturedAgent = ""
    const capturingRunner = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        capturedAgent = params.agent.name
        return Effect.succeed({
          _tag: "success" as const,
          text: "review from deepwork",
          sessionId: "counsel-session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    const coworkCtx: ToolContext = { ...ctx, agentName: "cowork" }
    return CounselTool.execute({ prompt: "review this code" }, coworkCtx).pipe(
      Effect.map((result) => {
        expect(capturedAgent).toBe("deepwork")
        expect(result.review).toContain("review from deepwork")
        expect(result.review).toContain("session://counsel-session")
        expect(result.reviewer).toBe("deepwork")
      }),
      Effect.provide(layer),
    )
  })

  it.live("includes adversarial framing in prompt", () => {
    let capturedPrompt = ""
    const capturingRunner = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "looks fine",
          sessionId: "session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    return CounselTool.execute({ prompt: "review auth module" }, ctx).pipe(
      Effect.map(() => {
        expect(capturedPrompt).toContain("adversarial peer reviewer")
        expect(capturedPrompt).toContain("review auth module")
      }),
      Effect.provide(layer),
    )
  })

  it.live("inlines file contents when provided", () => {
    let capturedPrompt = ""
    const capturingRunner = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "review result",
          sessionId: "session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory()
      const filePath = `${tmpDir}/auth.ts`
      yield* fs.writeFileString(filePath, "export const secret = 42")
      yield* CounselTool.execute({ prompt: "review this", files: [filePath] }, ctx)
    }).pipe(
      Effect.scoped,
      Effect.map(() => {
        expect(capturedPrompt).toContain("export const secret = 42")
      }),
      Effect.provide(layer),
    )
  })

  it.live("returns error with session ref on failure", () => {
    const layer = Layer.mergeAll(mockRunnerErrorWithSession, platformLayer)
    return CounselTool.execute({ prompt: "review" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.error).toContain("runner failed")
        expect(result.error).toContain("session://error-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("spawns agent with restricted read-only tools", () => {
    let capturedAllowedActions: readonly string[] | undefined
    let capturedDeniedTools: readonly string[] | undefined
    const capturingRunner = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        capturedAllowedActions = params.agent.allowedActions
        capturedDeniedTools = params.agent.deniedTools
        return Effect.succeed({
          _tag: "success" as const,
          text: "review",
          sessionId: "session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    return CounselTool.execute({ prompt: "review" }, ctx).pipe(
      Effect.map(() => {
        expect(capturedAllowedActions).toBeDefined()
        expect(capturedAllowedActions).toContain("read")
        expect(capturedAllowedActions).not.toContain("edit")
        expect(capturedAllowedActions).not.toContain("exec")
        expect(capturedDeniedTools).toBeDefined()
        expect(capturedDeniedTools).toContain("bash")
      }),
      Effect.provide(layer),
    )
  })

  it.live("works from any agent (always routes to deepwork)", () => {
    let capturedAgent = ""
    const capturingRunner = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        capturedAgent = params.agent.name
        return Effect.succeed({
          _tag: "success" as const,
          text: "review result",
          sessionId: "session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    const explorerCtx: ToolContext = { ...ctx, agentName: "explore" }
    return CounselTool.execute({ prompt: "review" }, explorerCtx).pipe(
      Effect.map((result) => {
        expect(capturedAgent).toBe("deepwork")
        expect(result.reviewer).toBe("deepwork")
      }),
      Effect.provide(layer),
    )
  })
})
