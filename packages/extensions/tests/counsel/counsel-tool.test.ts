import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"
import { CounselTool } from "../../src/counsel/counsel-tool.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { AgentRunResult, SessionId, type ExtensionContextService } from "@gent/core/extensions/api"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
import { AllBuiltinAgents } from "../helpers/builtin-agents.js"

const makeCtx = (overrides: {
  agentRun: (
    params: Parameters<ExtensionContextService["Agent"]["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
}) =>
  testToolContext({
    Agent: {
      get: () => Effect.void.pipe(Effect.as(undefined)),
      run: overrides.agentRun,
      listAgents: () => Effect.succeed(AllBuiltinAgents),
    },
  })

describe("CounselTool", () => {
  it.live("standard mode uses medium reasoning and model B", () => {
    let capturedOverrides: Record<string, unknown> | undefined
    let capturedPrompt = ""
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedOverrides = params.runSpec?.overrides as Record<string, unknown> | undefined
        capturedPrompt = params.prompt
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "Looks good, minor concern about error handling.",
            sessionId: SessionId.make("counsel-session"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(CounselTool, { prompt: "Is this approach sound?" }, ctx).pipe(
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
      ),
    )
  })

  it.live("deep mode uses high reasoning and expanded tools", () => {
    let capturedOverrides: Record<string, unknown> | undefined
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedOverrides = params.runSpec?.overrides as Record<string, unknown> | undefined
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "After thorough analysis...",
            sessionId: SessionId.make("counsel-deep"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(CounselTool, { prompt: "Review this architecture", mode: "deep" }, ctx).pipe(
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
      ),
    )
  })

  it.live("includes context in prompt when provided", () => {
    let capturedPrompt = ""
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "Noted.",
            sessionId: SessionId.make("counsel-ctx"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(
        CounselTool,
        { prompt: "Is this safe?", context: "We removed the auth middleware" },
        ctx,
      ).pipe(
        Effect.map(() => {
          expect(capturedPrompt).toContain("Is this safe?")
          expect(capturedPrompt).toContain("We removed the auth middleware")
          expect(capturedPrompt).toContain("## Context")
        }),
      ),
    )
  })

  it.live("returns error on agent failure", () => {
    const ctx = makeCtx({
      agentRun: () =>
        Effect.succeed(
          AgentRunResult.cases.error.make({
            error: "Model unavailable",
          }),
        ),
    })

    return narrowR(
      runToolWithCtx(CounselTool, { prompt: "help" }, ctx).pipe(
        Effect.map((result) => {
          expect(result.error).toBe("Model unavailable")
        }),
      ),
    )
  })

  it.live("uses counsel-worker agent with ephemeral persistence via runSpec", () => {
    let capturedAgent: { name: string } | undefined
    let capturedRunPersistence: string | undefined
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedAgent = { name: params.agent.name }
        capturedRunPersistence = params.runSpec?.persistence
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "Opinion here.",
            sessionId: SessionId.make("ephemeral-session"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(CounselTool, { prompt: "thoughts?" }, ctx).pipe(
        Effect.map(() => {
          expect(capturedAgent?.name).toBe("counsel-worker")
          expect(capturedRunPersistence).toBe("ephemeral")
        }),
      ),
    )
  })
})
