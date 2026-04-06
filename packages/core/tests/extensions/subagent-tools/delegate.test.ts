import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { DelegateTool } from "@gent/core/extensions/subagent-tools/delegate"
import { Agents, type AgentRunResult } from "@gent/core/domain/agent"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"

const makeCtx = (overrides: {
  agentRun?: (
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
      run:
        overrides.agentRun ??
        (() =>
          Effect.succeed({
            _tag: "success" as const,
            text: "",
            sessionId: "s1",
            agentName: "test",
          })),
      resolveDualModelPair: () =>
        Effect.succeed(["anthropic/claude-opus-4-6", "openai/gpt-5.4"] as const),
    },
  })

describe("Delegate Tool", () => {
  it.live("delegates to subagent and returns output", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: `${params.agent.name}:${params.prompt}`,
          sessionId: "child-session",
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        }),
    })

    return DelegateTool.execute({ agent: "explore", task: "hello" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.output).toBe("explore:hello")
        expect(result.metadata?.sessionId).toBeUndefined()
      }),
    )
  })

  it.live("delegates to any registered agent when no caller allow-list applies", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: `${params.agent.name}:${params.prompt}`,
          sessionId: "child-session",
          agentName: params.agent.name,
          persistence: "durable" as const,
        }),
    })

    return DelegateTool.execute({ agent: "cowork", task: "hello" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.output).toBe("cowork:hello\n\nFull session: session://child-session")
      }),
    )
  })

  it.live("chain mode omits session refs for ephemeral helper runs", () => {
    let stepIdx = 0
    const ctx = makeCtx({
      agentRun: (params) => {
        const idx = stepIdx++
        return Effect.succeed({
          _tag: "success" as const,
          text: `step-${idx}`,
          sessionId: `session-${idx}`,
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        })
      },
    })

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
        expect(result.output).toBe("step-1")
      }),
    )
  })

  it.live("parallel mode omits session refs for ephemeral helper runs", () => {
    let callIdx = 0
    const ctx = makeCtx({
      agentRun: (params) => {
        const idx = callIdx++
        return Effect.succeed({
          _tag: "success" as const,
          text: `result-${idx}`,
          sessionId: `session-${idx}`,
          agentName: params.agent.name,
          persistence: "ephemeral" as const,
        })
      },
    })

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
        expect(result.output).not.toContain("Full sessions:")
        expect(result.output).not.toContain("session://session-")
      }),
    )
  })
})
