import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { type AgentRunResult } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { PlanTool } from "@gent/extensions/plan-tool"
import type { ToolContext } from "@gent/core/domain/tool"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { testToolContext } from "@gent/core/test-utils/extension-harness"

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const makeCtx = (overrides: {
  agentRun?: (
    params: Parameters<ExtensionHostContext.Agent["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
  reviewDecision?: "yes" | "no" | "edit"
}): ToolContext => {
  const base = testToolContext({
    sessionId: "test-session",
    branchId: "test-branch",
    toolCallId: "test-call",
    cwd: "/tmp",
    home: "/tmp",
  })
  const agentRun =
    overrides.agentRun ??
    (() =>
      Effect.succeed({
        _tag: "success" as const,
        text: "output",
        sessionId: "s1",
        agentName: "test",
      }))
  return {
    ...base,
    extension: {
      send: dieStub("extension.send"),
      ask: dieStub("extension.ask"),
      request: dieStub("extension.request"),
    },
    agent: {
      get: (name) => Effect.succeed(Object.values(Agents).find((a) => a.name === name)),
      require: (name) => {
        const agent = Object.values(Agents).find((a) => a.name === name)
        return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
      },
      run: agentRun,
      resolveDualModelPair: () =>
        Effect.succeed(["anthropic/claude-opus-4-6", "openai/gpt-5.4"] as const),
    },
    session: {
      ...base.session,
      listMessages: dieStub("session.listMessages"),
      getSession: dieStub("session.getSession"),
      getDetail: dieStub("session.getDetail"),
      renameCurrent: dieStub("session.renameCurrent"),
      estimateContextPercent: dieStub("session.estimateContextPercent"),
      search: dieStub("session.search"),
    },
    interaction: {
      approve: dieStub("interaction.approve"),
      present: dieStub("interaction.present"),
      confirm: dieStub("interaction.confirm"),
      review: () =>
        Effect.succeed({
          decision: overrides.reviewDecision ?? "yes",
          path: "/tmp/test-plan.md",
        }),
    },
  }
}

describe("Plan Tool", () => {
  it.live("runs all 5 phases and returns approved plan", () => {
    const calls: Array<{ prompt: string }> = []
    let callIdx = 0

    const ctx = makeCtx({
      agentRun: (params) => {
        calls.push({ prompt: params.prompt })
        callIdx++
        return Effect.succeed({
          _tag: "success" as const,
          text: `phase-${callIdx}-output`,
          sessionId: `session-${callIdx}`,
          agentName: params.agent.name,
        } as AgentRunResult & { _tag: "success" })
      },
    })

    return PlanTool.effect({ prompt: "implement caching" }, ctx).pipe(
      Effect.map((result) => {
        // 2 parallel plans + 2 cross-reviews + 2 incorporations + 1 synthesis = 7 subagent calls
        expect(calls.length).toBe(7)

        // First two calls are parallel planning
        expect(calls[0]!.prompt).toContain("implement caching")
        expect(calls[1]!.prompt).toContain("implement caching")

        // Next two are cross-reviews
        expect(calls[2]!.prompt).toContain("Review this implementation plan")
        expect(calls[3]!.prompt).toContain("Review this implementation plan")

        // Next two are incorporations
        expect(calls[4]!.prompt).toContain("Revise your implementation plan")
        expect(calls[5]!.prompt).toContain("Revise your implementation plan")

        // Last is synthesis
        expect(calls[6]!.prompt).toContain("Synthesize these two")

        expect(result.decision).toBe("yes")
        expect(result.plan).toBeDefined()
      }),
    )
  })

  it.live("includes context and files in plan prompt", () => {
    const calls: Array<{ prompt: string }> = []

    const ctx = makeCtx({
      agentRun: (params) => {
        calls.push({ prompt: params.prompt })
        return Effect.succeed({
          _tag: "success" as const,
          text: "output",
          sessionId: "s1",
          agentName: params.agent.name,
        } as AgentRunResult & { _tag: "success" })
      },
    })

    return PlanTool.effect(
      {
        prompt: "add auth",
        context: "Using JWT tokens",
        files: ["src/auth.ts", "src/middleware.ts"],
      },
      ctx,
    ).pipe(
      Effect.map(() => {
        // Planning prompts should include context and files
        expect(calls[0]!.prompt).toContain("JWT tokens")
        expect(calls[0]!.prompt).toContain("src/auth.ts")
      }),
    )
  })

  it.live("returns rejected when user rejects plan", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: "output",
          sessionId: "s1",
          agentName: params.agent.name,
        } as AgentRunResult & { _tag: "success" }),
      reviewDecision: "no",
    })

    return PlanTool.effect({ prompt: "refactor" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.decision).toBe("no")
      }),
    )
  })

  it.live("uses different models for adversarial planning", () => {
    const models: string[] = []

    const ctx = makeCtx({
      agentRun: (params) => {
        if (params.runSpec?.overrides?.modelId !== undefined) {
          models.push(params.runSpec.overrides.modelId)
        }
        return Effect.succeed({
          _tag: "success" as const,
          text: "output",
          sessionId: "s1",
          agentName: params.agent.name,
        } as AgentRunResult & { _tag: "success" })
      },
    })

    return PlanTool.effect({ prompt: "test" }, ctx).pipe(
      Effect.map(() => {
        // Should have at least 2 different models used
        const uniqueModels = new Set(models)
        expect(uniqueModels.size).toBe(2)
      }),
    )
  })

  it.live("fix mode runs single plan+execute cycle", () => {
    const calls: string[] = []

    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.sync(() => {
          calls.push(params.prompt)
          if (
            params.prompt.includes(
              "Synthesize these two revised implementation plans into one execution plan organized into batches",
            )
          ) {
            return {
              _tag: "success" as const,
              text: "Batch 1: update auth\n- Files: src/auth.ts\n- Changes: add validation",
              sessionId: "synth-session",
              agentName: params.agent.name,
            } as AgentRunResult & { _tag: "success" }
          }
          if (params.prompt.includes("Execute this implementation plan")) {
            return {
              _tag: "success" as const,
              text: "Executed batch 1 successfully.",
              sessionId: "exec-session",
              agentName: params.agent.name,
            } as AgentRunResult & { _tag: "success" }
          }
          return {
            _tag: "success" as const,
            text: "ok",
            sessionId: "s1",
            agentName: params.agent.name,
          } as AgentRunResult & { _tag: "success" }
        }),
    })

    return PlanTool.effect({ prompt: "implement caching", mode: "fix" }, ctx).pipe(
      Effect.map((result) => {
        // Single cycle: plan phases + execute (no evaluator loop)
        expect(result.output).toBe("Executed batch 1 successfully.")
        expect(
          calls.some((prompt) =>
            prompt.includes("Organize the output into a small number of ordered batches"),
          ),
        ).toBe(true)
        expect(
          calls.some((prompt) => prompt.includes("Work through the plan batch by batch, in order")),
        ).toBe(true)
        // No evaluator calls
        expect(
          calls.some((prompt) =>
            prompt.includes("Evaluate whether the implementation is complete"),
          ),
        ).toBe(false)
      }),
    )
  })
})
