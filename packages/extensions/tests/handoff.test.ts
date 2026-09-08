import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { narrowR } from "../../core/tests/helpers/effect"
import { HandoffTool } from "../src/handoff-tool.js"
import { AgentRunResult, SessionId, type ExtensionContextService } from "@gent/core/extensions/api"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { runToolWithCtx } from "@gent/core-internal/test-utils"

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const makeCtx = (overrides: {
  agentRun?: (
    params: Parameters<ExtensionContextService["Agent"]["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
  approve?: ExtensionContextService["Interaction"]["approve"]
}) =>
  testToolContext({
    Agent: {
      run:
        overrides.agentRun ??
        ((params) =>
          Effect.succeed(
            AgentRunResult.cases.success.make({
              text: `response from ${params.agent.name}`,
              sessionId: SessionId.make("child-session"),
              agentName: params.agent.name,
            }),
          )),
      listAgents: Effect.die("agent.listAgents not wired in test"),
    },
    Interaction: {
      approve: overrides.approve ?? dieStub("interaction.approve"),
      present: dieStub("interaction.present"),
      confirm: dieStub("interaction.confirm"),
      review: dieStub("interaction.review"),
    },
  })

describe("HandoffTool", () => {
  it.live("returns handoff confirmed when user accepts", () => {
    const ctx = makeCtx({
      approve: () => Effect.succeed({ approved: true }),
    })

    return narrowR(
      runToolWithCtx(
        HandoffTool,
        {
          context: "Current task: implement auth. Key files: src/auth.ts",
          reason: "context window filling up",
        },
        ctx,
      ).pipe(
        Effect.map((result) => {
          expect(result.handoff).toBe(true)
          expect(result.summary).toContain("implement auth")
          expect(result.parentSessionId).toBe(SessionId.make("test-session"))
        }),
      ),
    )
  })

  it.live("returns handoff rejected when user declines", () => {
    const ctx = makeCtx({
      approve: () => Effect.succeed({ approved: false }),
    })

    return narrowR(
      runToolWithCtx(
        HandoffTool,
        {
          context: "Current task: implement auth",
        },
        ctx,
      ).pipe(
        Effect.map((result) => {
          expect(result.handoff).toBe(false)
          expect(result.reason).toBe("User rejected handoff")
        }),
      ),
    )
  })
})
