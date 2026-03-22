import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { PlanTool } from "@gent/core/tools/plan"
import { Agents, SubagentRunnerService, type SubagentResult } from "@gent/core/domain/agent"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"

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
import { PromptPresenter } from "@gent/core/domain/prompt-presenter"
import { EventStore } from "@gent/core/domain/event"
import { Storage } from "@gent/core/storage/sqlite-storage"
import type { ToolContext } from "@gent/core/domain/tool"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

describe("Plan Workflow", () => {
  test("runs all 5 phases and returns approved plan", async () => {
    const calls: Array<{ prompt: string }> = []
    let callIdx = 0

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        calls.push({ prompt: params.prompt })
        callIdx++
        return Effect.succeed({
          _tag: "success" as const,
          text: `phase-${callIdx}-output`,
          sessionId: `session-${callIdx}`,
          agentName: params.agent.name,
        } as SubagentResult & { _tag: "success" })
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,

      TestExtRegistry,
      PromptPresenter.Test([], ["yes"]),
      EventStore.Test(),
      BunServices.layer,
    )

    const result = await Effect.runPromise(
      PlanTool.execute({ prompt: "implement caching" }, ctx).pipe(Effect.provide(layer)),
    )

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
  })

  test("includes context and files in plan prompt", async () => {
    const calls: Array<{ prompt: string }> = []

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        calls.push({ prompt: params.prompt })
        return Effect.succeed({
          _tag: "success" as const,
          text: "output",
          sessionId: "s1",
          agentName: params.agent.name,
        } as SubagentResult & { _tag: "success" })
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,

      TestExtRegistry,
      PromptPresenter.Test([], ["yes"]),
      EventStore.Test(),
      BunServices.layer,
    )

    await Effect.runPromise(
      PlanTool.execute(
        {
          prompt: "add auth",
          context: "Using JWT tokens",
          files: ["src/auth.ts", "src/middleware.ts"],
        },
        ctx,
      ).pipe(Effect.provide(layer)),
    )

    // Planning prompts should include context and files
    expect(calls[0]!.prompt).toContain("JWT tokens")
    expect(calls[0]!.prompt).toContain("src/auth.ts")
  })

  test("returns rejected when user rejects plan", async () => {
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: "output",
          sessionId: "s1",
          agentName: params.agent.name,
        } as SubagentResult & { _tag: "success" }),
    })

    const layer = Layer.mergeAll(
      runnerLayer,

      TestExtRegistry,
      PromptPresenter.Test([], ["no"]),
      EventStore.Test(),
      BunServices.layer,
    )

    const result = await Effect.runPromise(
      PlanTool.execute({ prompt: "refactor" }, ctx).pipe(Effect.provide(layer)),
    )

    expect(result.decision).toBe("no")
  })

  test("uses different models for adversarial planning", async () => {
    const models: string[] = []

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        if (params.overrides?.modelId !== undefined) {
          models.push(params.overrides.modelId)
        }
        return Effect.succeed({
          _tag: "success" as const,
          text: "output",
          sessionId: "s1",
          agentName: params.agent.name,
        } as SubagentResult & { _tag: "success" })
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,

      TestExtRegistry,
      PromptPresenter.Test([], ["yes"]),
      EventStore.Test(),
      BunServices.layer,
    )

    await Effect.runPromise(PlanTool.execute({ prompt: "test" }, ctx).pipe(Effect.provide(layer)))

    // Should have at least 2 different models used
    const uniqueModels = new Set(models)
    expect(uniqueModels.size).toBe(2)
  })

  test("fix mode synthesizes an execution plan in batches and executes batch-by-batch", async () => {
    const calls: string[] = []

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        calls.push(params.prompt)
        if (params.prompt.includes("Evaluate whether the implementation is complete")) {
          return Effect.succeed({
            _tag: "success" as const,
            text: "VERDICT: done",
            sessionId: "eval-session",
            agentName: params.agent.name,
          } as SubagentResult & { _tag: "success" })
        }
        if (
          params.prompt.includes(
            "Synthesize these two revised implementation plans into one execution plan organized into batches",
          )
        ) {
          return Effect.succeed({
            _tag: "success" as const,
            text: "Batch 1: update auth\n- Files: src/auth.ts\n- Changes: add validation",
            sessionId: "synth-session",
            agentName: params.agent.name,
          } as SubagentResult & { _tag: "success" })
        }
        return Effect.succeed({
          _tag: "success" as const,
          text: "ok",
          sessionId: "s1",
          agentName: params.agent.name,
        } as SubagentResult & { _tag: "success" })
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,
      TestExtRegistry,
      PromptPresenter.Test([], ["yes"]),
      EventStore.Test(),
      BunServices.layer,
      Storage.Test(),
    )

    const result = await Effect.runPromise(
      PlanTool.execute({ prompt: "implement caching", mode: "fix" }, ctx).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result.reason).toBe("done")
    expect(
      calls.some((prompt) =>
        prompt.includes("Organize the output into a small number of ordered batches"),
      ),
    ).toBe(true)
    expect(
      calls.some((prompt) => prompt.includes("Work through the plan batch by batch, in order")),
    ).toBe(true)
  })
})
