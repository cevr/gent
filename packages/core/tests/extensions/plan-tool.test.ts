import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { AgentName, AgentRunResult } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { PlanTool } from "@gent/extensions/plan-tool"
import type { ToolContext } from "@gent/core/domain/tool"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { ModelId } from "@gent/core/domain/model"
import { testToolContext } from "@gent/core/test-utils/extension-harness"

// Tool .effect inherits R=any from the AnyCapabilityContribution cast in tool().
// Tests provide everything via ctx; narrow R for it.live compatibility.
const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const makeCtx = (overrides: {
  agentRun?: (
    params: Parameters<ExtensionHostContext.Agent["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
  reviewDecision?: "yes" | "no" | "edit"
}): ToolContext => {
  const base = testToolContext({
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    toolCallId: ToolCallId.make("test-call"),
    cwd: "/tmp",
    home: "/tmp",
  })
  const agentRun =
    overrides.agentRun ??
    (() =>
      Effect.succeed(
        AgentRunResult.Success.make({
          text: "output",
          sessionId: SessionId.make("s1"),
          agentName: AgentName.make("test"),
        }),
      ))
  return {
    ...base,
    extension: {
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
        Effect.succeed([
          ModelId.make("anthropic/claude-opus-4-6"),
          ModelId.make("openai/gpt-5.4"),
        ] as const),
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
    const parentToolCallIds: Array<unknown> = []
    let callIdx = 0

    const ctx = makeCtx({
      agentRun: (params) => {
        calls.push({ prompt: params.prompt })
        parentToolCallIds.push(params.runSpec?.parentToolCallId)
        callIdx++
        return Effect.succeed(
          AgentRunResult.Success.make({
            text: `phase-${callIdx}-output`,
            sessionId: SessionId.make(`session-${callIdx}`),
            agentName: params.agent.name,
          }),
        )
      },
    })

    return narrowR(
      PlanTool.effect({ prompt: "implement caching" }, ctx).pipe(
        Effect.map((result) => {
          // 2 parallel plans + 2 cross-reviews + 2 incorporations + 1 synthesis = 7 subagent calls
          expect(calls.length).toBe(7)
          expect(parentToolCallIds.every((id) => id === "test-call")).toBe(true)

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
      ),
    )
  })

  it.live("includes context and files in plan prompt", () => {
    const calls: Array<{ prompt: string }> = []

    const ctx = makeCtx({
      agentRun: (params) => {
        calls.push({ prompt: params.prompt })
        return Effect.succeed(
          AgentRunResult.Success.make({
            text: "output",
            sessionId: SessionId.make("s1"),
            agentName: params.agent.name,
          }),
        )
      },
    })

    return narrowR(
      PlanTool.effect(
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
      ),
    )
  })

  it.live("returns rejected when user rejects plan", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.Success.make({
            text: "output",
            sessionId: SessionId.make("s1"),
            agentName: params.agent.name,
          }),
        ),
      reviewDecision: "no",
    })

    return narrowR(
      PlanTool.effect({ prompt: "refactor" }, ctx).pipe(
        Effect.map((result) => {
          expect(result.decision).toBe("no")
        }),
      ),
    )
  })

  it.live("uses different models for adversarial planning", () => {
    const models: string[] = []

    const ctx = makeCtx({
      agentRun: (params) => {
        if (params.runSpec?.overrides?.modelId !== undefined) {
          models.push(params.runSpec.overrides.modelId)
        }
        return Effect.succeed(
          AgentRunResult.Success.make({
            text: "output",
            sessionId: SessionId.make("s1"),
            agentName: params.agent.name,
          }),
        )
      },
    })

    return narrowR(
      PlanTool.effect({ prompt: "test" }, ctx).pipe(
        Effect.map(() => {
          // Should have at least 2 different models used
          const uniqueModels = new Set(models)
          expect(uniqueModels.size).toBe(2)
        }),
      ),
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
            return AgentRunResult.Success.make({
              text: "Batch 1: update auth\n- Files: src/auth.ts\n- Changes: add validation",
              sessionId: SessionId.make("synth-session"),
              agentName: params.agent.name,
            })
          }
          if (params.prompt.includes("Execute this implementation plan")) {
            return AgentRunResult.Success.make({
              text: "Executed batch 1 successfully.",
              sessionId: SessionId.make("exec-session"),
              agentName: params.agent.name,
            })
          }
          return AgentRunResult.Success.make({
            text: "ok",
            sessionId: SessionId.make("s1"),
            agentName: params.agent.name,
          })
        }),
    })

    return narrowR(
      PlanTool.effect({ prompt: "implement caching", mode: "fix" }, ctx).pipe(
        Effect.map((result) => {
          // Single cycle: plan phases + execute (no evaluator loop)
          expect(result.output).toBe("Executed batch 1 successfully.")
          expect(
            calls.some((prompt) =>
              prompt.includes("Organize the output into a small number of ordered batches"),
            ),
          ).toBe(true)
          expect(
            calls.some((prompt) =>
              prompt.includes("Work through the plan batch by batch, in order"),
            ),
          ).toBe(true)
          // No evaluator calls
          expect(
            calls.some((prompt) =>
              prompt.includes("Evaluate whether the implementation is complete"),
            ),
          ).toBe(false)
        }),
      ),
    )
  })
})
