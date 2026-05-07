import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { HandoffTool } from "@gent/extensions/handoff-tool"
import { HandoffCooldown, HandoffExtension } from "@gent/extensions/handoff"
import { AgentRunResult } from "@gent/core/domain/agent"
import { AllBuiltinAgents } from "@gent/extensions/all-agents"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { testSetupCtx } from "@gent/core/test-utils"
import { SessionId } from "@gent/core/domain/ids"
import { getToolEffect } from "@gent/core/domain/capability/tool"

const narrowR = <A, E, R>(e: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const makeCtx = (overrides: {
  agentRun?: (
    params: Parameters<ExtensionHostContext.Agent["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
  approve?: ExtensionHostContext.Interaction["approve"]
}) =>
  testToolContext({
    agent: {
      get: (name) => Effect.succeed(AllBuiltinAgents.find((a) => a.name === name)),
      require: (name) => {
        const agent = AllBuiltinAgents.find((a) => a.name === name)
        return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
      },
      run:
        overrides.agentRun ??
        ((params) =>
          Effect.succeed(
            AgentRunResult.Success.make({
              text: `response from ${params.agent.name}`,
              sessionId: SessionId.make("child-session"),
              agentName: params.agent.name,
            }),
          )),
      resolveDualModelPair: dieStub("agent.resolveDualModelPair"),
    },
    interaction: {
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
      getToolEffect(HandoffTool)(
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
      getToolEffect(HandoffTool)(
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

// ============================================================================
// Cooldown service
//
// Pin the cooldown semantics from the old FSM implementation:
// suppress(n) SETS the counter to N (overwrite, not add);
// get() reads it; every turnCompleted() decrements until zero.
// ============================================================================

describe("HandoffCooldown", () => {
  it.live("suppress and turnCompleted preserve cooldown semantics", () =>
    Effect.gen(function* () {
      const contributions = yield* HandoffExtension.setup(testSetupCtx())
      expect((contributions.resources ?? []).length).toBe(1)

      const program = Effect.gen(function* () {
        const cooldown = yield* HandoffCooldown

        // Initial cooldown is 0.
        expect(yield* cooldown.get()).toBe(0)

        // suppress(5) sets cooldown to 5.
        yield* cooldown.suppress(5)
        expect(yield* cooldown.get()).toBe(5)

        // Each turnCompleted decrements the counter.
        yield* cooldown.turnCompleted()
        expect(yield* cooldown.get()).toBe(4)

        yield* cooldown.turnCompleted()
        yield* cooldown.turnCompleted()
        expect(yield* cooldown.get()).toBe(2)

        // suppress(2) re-arms (overwrite, not add).
        yield* cooldown.suppress(2)
        expect(yield* cooldown.get()).toBe(2)

        // Decrement clamps at zero.
        yield* cooldown.turnCompleted()
        yield* cooldown.turnCompleted()
        yield* cooldown.turnCompleted()
        expect(yield* cooldown.get()).toBe(0)
      })

      return yield* program.pipe(Effect.provide(HandoffCooldown.Live))
    }),
  )
})
