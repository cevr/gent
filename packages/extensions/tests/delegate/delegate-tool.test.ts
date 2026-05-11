import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"
import { DelegateTool } from "../../src/delegate/delegate-tool.js"
import {
  AgentName,
  AgentRunResult,
  SessionId,
  type ExtensionContextService,
} from "@gent/core/extensions/api"
import { AllBuiltinAgents } from "../helpers/builtin-agents.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { getToolEffect } from "@gent/core-internal/domain/capability/tool"

const makeCtx = (overrides: {
  agentRun?: (
    params: Parameters<ExtensionContextService["Agent"]["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
}) =>
  testToolContext({
    Agent: {
      get: (name) => Effect.succeed(AllBuiltinAgents.find((a) => a.name === name)),
      run:
        overrides.agentRun ??
        (() =>
          Effect.succeed(
            AgentRunResult.cases.success.make({
              text: "",
              sessionId: SessionId.make("s1"),
              agentName: AgentName.make("test"),
            }),
          )),
      listAgents: () => Effect.succeed(AllBuiltinAgents),
    },
  })

describe("Delegate Tool", () => {
  it.live("delegates to subagent and returns output", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.cases.success.make({
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        ),
    })

    return narrowR(
      getToolEffect(DelegateTool)({ agent: AgentName.make("explore"), todo: "hello" }, ctx).pipe(
        Effect.map((result) => {
          if (!("output" in result) || result.output === undefined) {
            throw new Error("expected delegate output")
          }
          expect(result.output).toBe("explore:hello")
          if (result.metadata !== undefined && "sessionId" in result.metadata) {
            expect(result.metadata.sessionId).toBeUndefined()
          }
        }),
      ),
    )
  })

  it.live("delegates to any registered agent when no caller allow-list applies", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.cases.success.make({
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        ),
    })

    return narrowR(
      getToolEffect(DelegateTool)({ agent: AgentName.make("cowork"), todo: "hello" }, ctx).pipe(
        Effect.map((result) => {
          if (!("output" in result) || result.output === undefined) {
            throw new Error("expected delegate output")
          }
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
          AgentRunResult.cases.success.make({
            text: `step-${idx}`,
            sessionId: SessionId.make(`session-${idx}`),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      getToolEffect(DelegateTool)(
        {
          chain: [
            { agent: AgentName.make("explore"), todo: "first" },
            { agent: AgentName.make("explore"), todo: "second" },
          ],
        },
        ctx,
      ).pipe(
        Effect.map((result) => {
          if (!("output" in result) || result.output === undefined) {
            throw new Error("expected delegate output")
          }
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
          AgentRunResult.cases.success.make({
            text: `result-${idx}`,
            sessionId: SessionId.make(`session-${idx}`),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      getToolEffect(DelegateTool)(
        {
          todos: [
            { agent: AgentName.make("explore"), todo: "a" },
            { agent: AgentName.make("explore"), todo: "b" },
          ],
        },
        ctx,
      ).pipe(
        Effect.map((result) => {
          if (!("output" in result) || result.output === undefined) {
            throw new Error("expected delegate output")
          }
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
          AgentRunResult.cases.success.make({
            text: "ok",
            sessionId: SessionId.make("s"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      getToolEffect(DelegateTool)({ agent: AgentName.make("explore"), todo: "go" }, ctx).pipe(
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
          AgentRunResult.cases.success.make({
            text: "x",
            sessionId: SessionId.make("s"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      getToolEffect(DelegateTool)(
        {
          chain: [
            { agent: AgentName.make("explore"), todo: "a" },
            { agent: AgentName.make("explore"), todo: "b" },
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

  it.live("parallel mode delegates with ephemeral persistence per todo", () => {
    const captured: Array<{ persistence?: string }> = []
    const ctx = makeCtx({
      agentRun: (params) => {
        captured.push(params.runSpec ?? {})
        return Effect.succeed(
          AgentRunResult.cases.success.make({
            text: "x",
            sessionId: SessionId.make("s"),
            agentName: params.agent.name,
            persistence: "ephemeral" as const,
          }),
        )
      },
    })

    return narrowR(
      getToolEffect(DelegateTool)(
        {
          todos: [
            { agent: AgentName.make("explore"), todo: "a" },
            { agent: AgentName.make("explore"), todo: "b" },
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
