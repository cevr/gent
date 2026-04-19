import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { HandoffTool } from "@gent/extensions/handoff-tool"
import { HandoffExtension } from "@gent/extensions/handoff"
import { HandoffProtocol, HANDOFF_EXTENSION_ID } from "@gent/extensions/handoff-protocol"
import { type AgentRunResult } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { spawnMachineExtensionRef } from "@gent/core/runtime/extensions/spawn-machine-ref"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { TurnCompleted } from "@gent/core/domain/event"
import { SessionId, BranchId } from "@gent/core/domain/ids"
import { testSetupCtx } from "@gent/core/test-utils"

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const makeCtx = (overrides: {
  agentRun?: (
    params: Parameters<ExtensionHostContext.Agent["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
  approve?: ExtensionHostContext.Interaction["approve"]
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
        ((params) =>
          Effect.succeed({
            _tag: "success" as const,
            text: `response from ${params.agent.name}`,
            sessionId: "child-session",
            agentName: params.agent.name,
          })),
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

    return HandoffTool.execute(
      {
        context: "Current task: implement auth. Key files: src/auth.ts",
        reason: "context window filling up",
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.handoff).toBe(true)
        expect(result.summary).toContain("implement auth")
        expect(result.parentSessionId).toBe("test-session")
      }),
    )
  })

  it.live("returns handoff rejected when user declines", () => {
    const ctx = makeCtx({
      approve: () => Effect.succeed({ approved: false }),
    })

    return HandoffTool.execute(
      {
        context: "Current task: implement auth",
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.handoff).toBe(false)
        expect(result.reason).toBe("User rejected handoff")
      }),
    )
  })
})

// ============================================================================
// Cooldown workflow protocol (C8b regression lock)
//
// Pin the cooldown semantics that the handoff actor used to expose via
// `getUiSnapshot`: `Suppress(n)` sets the counter to N; `GetCooldown` reads
// it; every `TurnCompleted` decrements it. Workflows have no UI snapshot per
// `composability-not-flags`, so the only legitimate cross-call read is the
// typed `GetCooldown` reply. This test exists because before C8b nothing
// directly exercised the protocol — the hole counsel flagged.
// ============================================================================

describe("Handoff cooldown workflow", () => {
  it.live("Suppress → GetCooldown → TurnCompleted decrement round-trips through the workflow", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.of("handoff-cooldown-session")
      const branchId = BranchId.of("handoff-cooldown-branch")

      // The workflow is lowered into setup.actor by `defineExtension`, so we
      // can drive it through the same actor boundary used in production.
      const contributions = yield* HandoffExtension.setup(testSetupCtx())
      const actorDef = (contributions.resources ?? []).find((r) => r.machine !== undefined)?.machine
      expect(actorDef).toBeDefined()

      const actor = yield* spawnMachineExtensionRef(HANDOFF_EXTENSION_ID, actorDef!, {
        sessionId,
        branchId,
      }).pipe(Effect.provide(ExtensionTurnControl.Test()))

      yield* actor.start

      // Initial cooldown is 0.
      const initial = yield* actor.ask(HandoffProtocol.GetCooldown())
      expect(initial).toBe(0)

      // Suppress(5) sets cooldown to 5.
      yield* actor.send(HandoffProtocol.Suppress({ count: 5 }))
      const afterSuppress = yield* actor.ask(HandoffProtocol.GetCooldown())
      expect(afterSuppress).toBe(5)

      // Each TurnCompleted decrements the counter.
      yield* actor.publish(new TurnCompleted({ sessionId, branchId, durationMs: 0 }), {
        sessionId,
        branchId,
      })
      const afterOne = yield* actor.ask(HandoffProtocol.GetCooldown())
      expect(afterOne).toBe(4)

      yield* actor.publish(new TurnCompleted({ sessionId, branchId, durationMs: 0 }), {
        sessionId,
        branchId,
      })
      yield* actor.publish(new TurnCompleted({ sessionId, branchId, durationMs: 0 }), {
        sessionId,
        branchId,
      })
      const afterThree = yield* actor.ask(HandoffProtocol.GetCooldown())
      expect(afterThree).toBe(2)

      // Suppress(2) re-arms the counter (overwrite, not add).
      yield* actor.send(HandoffProtocol.Suppress({ count: 2 }))
      const reArmed = yield* actor.ask(HandoffProtocol.GetCooldown())
      expect(reArmed).toBe(2)

      // Decrement clamps at zero.
      yield* actor.publish(new TurnCompleted({ sessionId, branchId, durationMs: 0 }), {
        sessionId,
        branchId,
      })
      yield* actor.publish(new TurnCompleted({ sessionId, branchId, durationMs: 0 }), {
        sessionId,
        branchId,
      })
      yield* actor.publish(new TurnCompleted({ sessionId, branchId, durationMs: 0 }), {
        sessionId,
        branchId,
      })
      const drained = yield* actor.ask(HandoffProtocol.GetCooldown())
      expect(drained).toBe(0)
    }),
  )
})
