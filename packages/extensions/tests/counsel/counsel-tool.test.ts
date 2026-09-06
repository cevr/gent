import { describe, it, expect } from "effect-bun-test"
import { Effect, Option } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"
import { CounselTool } from "../../src/counsel/counsel-tool.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import {
  AgentRunResult,
  ModelId,
  SessionId,
  type ExtensionContextService,
  type RunSpec,
} from "@gent/core/extensions/api"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
import { AllBuiltinAgents } from "../helpers/builtin-agents.js"

const makeCtx = (overrides: {
  agentRun: (
    params: Parameters<ExtensionContextService["Agent"]["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
}) =>
  testToolContext({
    Agent: {
      run: overrides.agentRun,
      listAgents: Effect.succeed(AllBuiltinAgents),
    },
  })

type RunOverrides = NonNullable<RunSpec["overrides"]>

describe("CounselTool", () => {
  it.live("standard mode uses medium reasoning and model B", () => {
    let capturedOverrides = Option.none<RunOverrides>()
    let capturedPrompt = ""
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedOverrides = Option.fromNullishOr(params.runSpec?.overrides)
        capturedPrompt = params.prompt
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "Looks good, minor concern about error handling.",
            sessionId: SessionId.make("counsel-session"),
            agentName: params.agent.name,
            persistence: "ephemeral",
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(CounselTool, { prompt: "Is this approach sound?" }, ctx).pipe(
        Effect.map((result) => {
          const overrides = Option.getOrThrow(capturedOverrides)
          expect(capturedPrompt).toContain("Is this approach sound?")
          expect(overrides["modelId"]).toBe(ModelId.make("openai/gpt-5.4"))
          expect(overrides["reasoningEffort"]).toBe("medium")
          expect(overrides["allowedTools"]).toEqual(["grep", "glob", "read", "memory_search"])
          expect(overrides["systemPromptAddendum"]).toContain("focused second opinion")
          expect(result.mode).toBe("standard")
          expect(result.response).toBe("Looks good, minor concern about error handling.")
        }),
      ),
    )
  })

  it.live("deep mode uses high reasoning and expanded tools", () => {
    let capturedOverrides = Option.none<RunOverrides>()
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedOverrides = Option.fromNullishOr(params.runSpec?.overrides)
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "After thorough analysis...",
            sessionId: SessionId.make("counsel-deep"),
            agentName: params.agent.name,
            persistence: "ephemeral",
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(CounselTool, { prompt: "Review this architecture", mode: "deep" }, ctx).pipe(
        Effect.map((result) => {
          const overrides = Option.getOrThrow(capturedOverrides)
          expect(overrides["modelId"]).toBe(ModelId.make("openai/gpt-5.4"))
          expect(overrides["reasoningEffort"]).toBe("high")
          expect(overrides["allowedTools"]).toEqual([
            "grep",
            "glob",
            "read",
            "memory_search",
            "websearch",
            "webfetch",
          ])
          expect(overrides["systemPromptAddendum"]).toContain("thorough second opinion")
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
            persistence: "ephemeral",
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
    let capturedAgent = Option.none<{ name: string }>()
    let capturedRunPersistence = Option.none<string>()
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedAgent = Option.some({ name: params.agent.name })
        capturedRunPersistence = Option.fromUndefinedOr(params.runSpec?.persistence)
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "Opinion here.",
            sessionId: SessionId.make("ephemeral-session"),
            agentName: params.agent.name,
            persistence: "ephemeral",
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(CounselTool, { prompt: "thoughts?" }, ctx).pipe(
        Effect.map(() => {
          expect(Option.map(capturedAgent, (agent) => agent.name)).toEqual(
            Option.some("counsel-worker"),
          )
          expect(capturedRunPersistence).toEqual(Option.some("ephemeral"))
        }),
      ),
    )
  })
})
