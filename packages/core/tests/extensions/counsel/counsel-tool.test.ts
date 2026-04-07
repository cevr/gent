import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { CounselTool } from "@gent/core/extensions/counsel/counsel-tool"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import type { AgentRunResult } from "@gent/core/domain/agent"
import type { SessionId } from "@gent/core/domain/ids"

const makeCtx = (overrides: {
  agentRun: (
    params: Parameters<ExtensionHostContext.Agent["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
}) =>
  testToolContext({
    agent: {
      get: () => Effect.succeed(undefined),
      require: () => Effect.die("require not wired"),
      run: overrides.agentRun,
      resolveDualModelPair: () =>
        Effect.succeed(["anthropic/claude-opus-4-6", "openai/gpt-5.4"] as const),
    },
  })

describe("CounselTool", () => {
  it.live("standard mode uses medium reasoning and model B", () => {
    let capturedOverrides: Record<string, unknown> | undefined
    let capturedPrompt = ""
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedOverrides = params.overrides as Record<string, unknown> | undefined
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "Looks good, minor concern about error handling.",
          sessionId: "counsel-session" as SessionId,
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        })
      },
    })

    return CounselTool.execute({ prompt: "Is this approach sound?" }, ctx).pipe(
      Effect.map((result) => {
        expect(capturedPrompt).toContain("Is this approach sound?")
        expect(capturedOverrides?.["modelId"]).toBe("openai/gpt-5.4")
        expect(capturedOverrides?.["reasoningEffort"]).toBe("medium")
        expect(capturedOverrides?.["allowedTools"]).toEqual([
          "grep",
          "glob",
          "read",
          "memory_search",
        ])
        expect(capturedOverrides?.["systemPromptAddendum"]).toContain("focused second opinion")
        expect(result.mode).toBe("standard")
        expect(result.response).toBe("Looks good, minor concern about error handling.")
      }),
    )
  })

  it.live("deep mode uses high reasoning and expanded tools", () => {
    let capturedOverrides: Record<string, unknown> | undefined
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedOverrides = params.overrides as Record<string, unknown> | undefined
        return Effect.succeed({
          _tag: "success" as const,
          text: "After thorough analysis...",
          sessionId: "counsel-deep" as SessionId,
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        })
      },
    })

    return CounselTool.execute({ prompt: "Review this architecture", mode: "deep" }, ctx).pipe(
      Effect.map((result) => {
        expect(capturedOverrides?.["modelId"]).toBe("openai/gpt-5.4")
        expect(capturedOverrides?.["reasoningEffort"]).toBe("high")
        expect(capturedOverrides?.["allowedTools"]).toEqual([
          "grep",
          "glob",
          "read",
          "memory_search",
          "websearch",
          "webfetch",
        ])
        expect(capturedOverrides?.["systemPromptAddendum"]).toContain("thorough second opinion")
        expect(result.mode).toBe("deep")
        expect(result.response).toBe("After thorough analysis...")
      }),
    )
  })

  it.live("includes context in prompt when provided", () => {
    let capturedPrompt = ""
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "Noted.",
          sessionId: "counsel-ctx" as SessionId,
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        })
      },
    })

    return CounselTool.execute(
      { prompt: "Is this safe?", context: "We removed the auth middleware" },
      ctx,
    ).pipe(
      Effect.map(() => {
        expect(capturedPrompt).toContain("Is this safe?")
        expect(capturedPrompt).toContain("We removed the auth middleware")
        expect(capturedPrompt).toContain("## Context")
      }),
    )
  })

  it.live("returns error on agent failure", () => {
    const ctx = makeCtx({
      agentRun: () =>
        Effect.succeed({
          _tag: "error" as const,
          error: "Model unavailable",
        }),
    })

    return CounselTool.execute({ prompt: "help" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.error).toBe("Model unavailable")
      }),
    )
  })

  it.live("uses counsel-worker agent with ephemeral persistence", () => {
    let capturedAgent: { name: string; persistence?: string } | undefined
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedAgent = { name: params.agent.name, persistence: params.agent.persistence }
        return Effect.succeed({
          _tag: "success" as const,
          text: "Opinion here.",
          sessionId: "ephemeral-session" as SessionId,
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        })
      },
    })

    return CounselTool.execute({ prompt: "thoughts?" }, ctx).pipe(
      Effect.map(() => {
        expect(capturedAgent?.name).toBe("counsel-worker")
        expect(capturedAgent?.persistence).toBe("ephemeral")
      }),
    )
  })
})
