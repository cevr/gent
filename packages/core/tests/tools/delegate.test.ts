import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { DelegateTool } from "@gent/core/tools/delegate"
import type { ToolContext } from "@gent/core/domain/tool"
import { Agents, SubagentRunnerService } from "@gent/core/domain/agent"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"

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

const RuntimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

describe("Delegate Tool", () => {
  it.live("delegates to subagent and returns output", () => {
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: `${params.agent.name}:${params.prompt}`,
          sessionId: "child-session",
          agentName: params.agent.name,
        }),
    })

    const layer = Layer.mergeAll(runnerLayer, TestExtRegistry, RuntimePlatformLayer)

    return DelegateTool.execute({ agent: "explore", task: "hello" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.output).toBe("explore:hello\n\nFull session: session://child-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("chain mode appends session refs for all steps", () => {
    let stepIdx = 0
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        const idx = stepIdx++
        return Effect.succeed({
          _tag: "success" as const,
          text: `step-${idx}`,
          sessionId: `session-${idx}`,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(runnerLayer, TestExtRegistry, RuntimePlatformLayer)
    return DelegateTool.execute(
      {
        chain: [
          { agent: "explore", task: "first" },
          { agent: "explore", task: "second" },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.output).toContain("Full sessions: session://session-0, session://session-1")
      }),
      Effect.provide(layer),
    )
  })

  it.live("parallel mode appends session refs for successes", () => {
    let callIdx = 0
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        const idx = callIdx++
        return Effect.succeed({
          _tag: "success" as const,
          text: `result-${idx}`,
          sessionId: `session-${idx}`,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(runnerLayer, TestExtRegistry, RuntimePlatformLayer)
    return DelegateTool.execute(
      {
        tasks: [
          { agent: "explore", task: "a" },
          { agent: "explore", task: "b" },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.output).toContain("2/2 succeeded")
        expect(result.output).toContain("Full sessions:")
        expect(result.output).toContain("session://session-")
      }),
      Effect.provide(layer),
    )
  })
})
