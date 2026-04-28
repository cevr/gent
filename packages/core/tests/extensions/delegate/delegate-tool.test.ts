import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { DelegateTool } from "@gent/extensions/delegate/delegate-tool"
import { AgentName, AgentRunResult } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { ModelId } from "@gent/core/domain/model"
import { SessionId } from "@gent/core/domain/ids"

const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>

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
          Effect.succeed(
            AgentRunResult.Success.make({
              text: "",
              sessionId: SessionId.make("s1"),
              agentName: AgentName.make("test"),
            }),
          )),
      resolveDualModelPair: () =>
        Effect.succeed([
          ModelId.make("anthropic/claude-opus-4-6"),
          ModelId.make("openai/gpt-5.4"),
        ] as const),
    },
    extension: {
      request: () => Effect.succeed({} as never),
    },
  })

describe("Delegate Tool", () => {
  it.live("delegates to subagent and returns output", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.Success.make({
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        ),
    })

    return narrowR(
      DelegateTool.effect({ agent: "explore", task: "hello" }, ctx).pipe(
        Effect.map((result) => {
          expect(result.output).toBe("explore:hello")
          expect(result.metadata?.sessionId).toBeUndefined()
        }),
      ),
    )
  })

  it.live("delegates to any registered agent when no caller allow-list applies", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.Success.make({
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        ),
    })

    return narrowR(
      DelegateTool.effect({ agent: "cowork", task: "hello" }, ctx).pipe(
        Effect.map((result) => {
          // Delegate is fire-and-forget ephemeral by design — no durable session ref is shown.
          expect(result.output).toBe("cowork:hello")
        }),
      ),
    )
  })

  it.live("chain mode omits session refs for ephemeral helper runs", () => {
    let stepIdx = 0
    const ctx = makeCtx({
      agentRun: (params) => {
        const idx = stepIdx++
        return Effect.succeed(
          AgentRunResult.Success.make({
            text: `step-${idx}`,
            sessionId: SessionId.make(`session-${idx}`),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      DelegateTool.effect(
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
      ),
    )
  })

  it.live("parallel mode omits session refs for ephemeral helper runs", () => {
    let callIdx = 0
    const ctx = makeCtx({
      agentRun: (params) => {
        const idx = callIdx++
        return Effect.succeed(
          AgentRunResult.Success.make({
            text: `result-${idx}`,
            sessionId: SessionId.make(`session-${idx}`),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      DelegateTool.effect(
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
      ),
    )
  })

  it.live("foreground single delegates with ephemeral persistence", () => {
    let capturedRunSpec: { persistence?: string } | undefined
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedRunSpec = params.runSpec
        return Effect.succeed(
          AgentRunResult.Success.make({
            text: "ok",
            sessionId: SessionId.make("s"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      DelegateTool.effect({ agent: "explore", task: "go" }, ctx).pipe(
        Effect.map(() => {
          expect(capturedRunSpec?.persistence).toBe("ephemeral")
        }),
      ),
    )
  })

  it.live("chain mode delegates with ephemeral persistence per step", () => {
    const captured: Array<{ persistence?: string }> = []
    const ctx = makeCtx({
      agentRun: (params) => {
        captured.push(params.runSpec ?? {})
        return Effect.succeed(
          AgentRunResult.Success.make({
            text: "x",
            sessionId: SessionId.make("s"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      DelegateTool.effect(
        {
          chain: [
            { agent: "explore", task: "a" },
            { agent: "explore", task: "b" },
          ],
        },
        ctx,
      ).pipe(
        Effect.map(() => {
          expect(captured.length).toBe(2)
          expect(captured.every((r) => r.persistence === "ephemeral")).toBe(true)
        }),
      ),
    )
  })

  it.live("parallel mode delegates with ephemeral persistence per task", () => {
    const captured: Array<{ persistence?: string }> = []
    const ctx = makeCtx({
      agentRun: (params) => {
        captured.push(params.runSpec ?? {})
        return Effect.succeed(
          AgentRunResult.Success.make({
            text: "x",
            sessionId: SessionId.make("s"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      DelegateTool.effect(
        {
          tasks: [
            { agent: "explore", task: "a" },
            { agent: "explore", task: "b" },
          ],
        },
        ctx,
      ).pipe(
        Effect.map(() => {
          expect(captured.length).toBe(2)
          expect(captured.every((r) => r.persistence === "ephemeral")).toBe(true)
        }),
      ),
    )
  })
})
