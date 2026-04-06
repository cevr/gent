import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { PlanTool } from "@gent/core/extensions/plan-tool"
import { Agents, AgentRunnerService, type AgentRunResult } from "@gent/core/domain/agent"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"

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

const RuntimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
  cwd: "/tmp",
  home: "/tmp",
  extensions: {
    send: () => Effect.die("not wired"),
    ask: () => Effect.die("not wired"),
  },
}

describe("Plan Tool", () => {
  it.live("runs all 5 phases and returns approved plan", () => {
    const calls: Array<{ prompt: string }> = []
    let callIdx = 0

    const runnerLayer = Layer.succeed(AgentRunnerService, {
      run: (params) => {
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

    const layer = Layer.mergeAll(
      runnerLayer,

      TestExtRegistry,
      PromptPresenter.Test([], ["yes"]),
      EventStore.Test(),
      BunServices.layer,
      RuntimePlatformLayer,
    )

    return PlanTool.execute({ prompt: "implement caching" }, ctx).pipe(
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
      Effect.provide(layer),
    )
  })

  it.live("includes context and files in plan prompt", () => {
    const calls: Array<{ prompt: string }> = []

    const runnerLayer = Layer.succeed(AgentRunnerService, {
      run: (params) => {
        calls.push({ prompt: params.prompt })
        return Effect.succeed({
          _tag: "success" as const,
          text: "output",
          sessionId: "s1",
          agentName: params.agent.name,
        } as AgentRunResult & { _tag: "success" })
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,

      TestExtRegistry,
      PromptPresenter.Test([], ["yes"]),
      EventStore.Test(),
      BunServices.layer,
      RuntimePlatformLayer,
    )

    return PlanTool.execute(
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
      Effect.provide(layer),
    )
  })

  it.live("returns rejected when user rejects plan", () => {
    const runnerLayer = Layer.succeed(AgentRunnerService, {
      run: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: "output",
          sessionId: "s1",
          agentName: params.agent.name,
        } as AgentRunResult & { _tag: "success" }),
    })

    const layer = Layer.mergeAll(
      runnerLayer,

      TestExtRegistry,
      PromptPresenter.Test([], ["no"]),
      EventStore.Test(),
      BunServices.layer,
      RuntimePlatformLayer,
    )

    return PlanTool.execute({ prompt: "refactor" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.decision).toBe("no")
      }),
      Effect.provide(layer),
    )
  })

  it.live("uses different models for adversarial planning", () => {
    const models: string[] = []

    const runnerLayer = Layer.succeed(AgentRunnerService, {
      run: (params) => {
        if (params.overrides?.modelId !== undefined) {
          models.push(params.overrides.modelId)
        }
        return Effect.succeed({
          _tag: "success" as const,
          text: "output",
          sessionId: "s1",
          agentName: params.agent.name,
        } as AgentRunResult & { _tag: "success" })
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,

      TestExtRegistry,
      PromptPresenter.Test([], ["yes"]),
      EventStore.Test(),
      BunServices.layer,
      RuntimePlatformLayer,
    )

    return PlanTool.execute({ prompt: "test" }, ctx).pipe(
      Effect.map(() => {
        // Should have at least 2 different models used
        const uniqueModels = new Set(models)
        expect(uniqueModels.size).toBe(2)
      }),
      Effect.provide(layer),
    )
  })

  it.live("fix mode runs single plan+execute cycle", () => {
    const calls: string[] = []

    const runnerLayer = Layer.succeed(AgentRunnerService, {
      run: (params) =>
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

    const layer = Layer.mergeAll(
      runnerLayer,
      TestExtRegistry,
      PromptPresenter.Test([], ["yes"]),
      EventStore.Test(),
      BunServices.layer,
      RuntimePlatformLayer,
      Storage.Test(),
    )

    return PlanTool.execute({ prompt: "implement caching", mode: "fix" }, ctx).pipe(
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
      Effect.provide(layer),
    )
  })
})
