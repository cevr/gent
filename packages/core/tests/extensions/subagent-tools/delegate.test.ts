import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { DelegateTool } from "@gent/core/extensions/subagent-tools/delegate"
import type { ToolContext } from "@gent/core/domain/tool"
import { createToolTestLayer } from "@gent/core/test-utils/extension-harness"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

describe("Delegate Tool", () => {
  it.live("delegates to subagent and returns output", () => {
    const layer = createToolTestLayer({
      subagentRunner: {
        run: (params) =>
          Effect.succeed({
            _tag: "success" as const,
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: "child-session",
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
      },
    })

    return DelegateTool.execute({ agent: "explore", task: "hello" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.output).toBe("explore:hello")
        expect(result.metadata?.sessionId).toBeUndefined()
      }),
      Effect.provide(layer),
    )
  })

  it.live("delegates to any registered agent when no caller allow-list applies", () => {
    const layer = createToolTestLayer({
      subagentRunner: {
        run: (params) =>
          Effect.succeed({
            _tag: "success" as const,
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: "child-session",
            agentName: params.agent.name,
            persistence: "durable" as const,
          }),
      },
    })

    return DelegateTool.execute({ agent: "cowork", task: "hello" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.output).toBe("cowork:hello\n\nFull session: session://child-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("chain mode omits session refs for ephemeral helper runs", () => {
    let stepIdx = 0
    const layer = createToolTestLayer({
      subagentRunner: {
        run: (params) => {
          const idx = stepIdx++
          return Effect.succeed({
            _tag: "success" as const,
            text: `step-${idx}`,
            sessionId: `session-${idx}`,
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          })
        },
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
      Effect.provide(layer),
    )
  })

  it.live("parallel mode omits session refs for ephemeral helper runs", () => {
    let callIdx = 0
    const layer = createToolTestLayer({
      subagentRunner: {
        run: (params) => {
          const idx = callIdx++
          return Effect.succeed({
            _tag: "success" as const,
            text: `result-${idx}`,
            sessionId: `session-${idx}`,
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          })
        },
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
      Effect.provide(layer),
    )
  })
})
