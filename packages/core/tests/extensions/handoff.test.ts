import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { HandoffTool } from "@gent/extensions/handoff-tool"
import { HandoffExtension, CooldownMsg, CooldownService } from "@gent/extensions/handoff"
import { HANDOFF_EXTENSION_ID } from "@gent/extensions/handoff-protocol"
import { AgentRunResult } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import type { ActorRef } from "@gent/core/domain/actor"
import { ActorEngine, type ActorEngineService } from "@gent/core/runtime/extensions/actor-engine"
import { ActorHost } from "@gent/core/runtime/extensions/actor-host"
import { Receptionist } from "@gent/core/runtime/extensions/receptionist"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ResolvedExtensions } from "../../src/runtime/extensions/registry"
import { testSetupCtx } from "@gent/core/test-utils"
import { SessionId } from "@gent/core/domain/ids"

const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
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
      get: (name) => Effect.succeed(Object.values(Agents).find((a) => a.name === name)),
      require: (name) => {
        const agent = Object.values(Agents).find((a) => a.name === name)
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
      HandoffTool.effect(
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
      HandoffTool.effect(
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
// Cooldown actor (C8b regression lock — re-pinned to actor primitive in W10-1a)
//
// Pin the cooldown semantics from the old FSM implementation:
// `Suppress(n)` SETS the counter to N (overwrite, not add);
// `GetCooldown` reads it; every `TurnCompleted` decrements until zero.
// ============================================================================

describe("Handoff cooldown actor", () => {
  it.live("Suppress → GetCooldown → TurnCompleted decrement round-trips through the actor", () =>
    Effect.gen(function* () {
      const contributions = yield* HandoffExtension.setup(testSetupCtx())
      const actors = contributions.actors ?? []
      expect(actors.length).toBe(1)

      const loaded = {
        manifest: { id: HANDOFF_EXTENSION_ID },
        contributions: { actors },
        scope: "builtin" as const,
        sourcePath: "test",
        sealedRequirements: undefined,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub: ActorHost only reads `manifest.id` + `contributions.actors`
      } as unknown as LoadedExtension
      const resolved = {
        extensions: [loaded],
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub: ActorHost only walks `extensions`
      } as unknown as ResolvedExtensions

      const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

      const askCooldown = (
        engine: ActorEngineService,
        ref: ActorRef<CooldownMsg>,
      ): Effect.Effect<number, never> =>
        engine
          .ask(ref, CooldownMsg.GetCooldown.make({}))
          .pipe(Effect.catchEager(() => Effect.succeed(0)))

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const reg = yield* Receptionist
          const refs = yield* reg.find(CooldownService)
          expect(refs.length).toBe(1)
          const ref = refs[0]!

          // Initial cooldown is 0.
          expect(yield* askCooldown(engine, ref)).toBe(0)

          // Suppress(5) sets cooldown to 5.
          yield* engine.tell(ref, CooldownMsg.Suppress.make({ count: 5 }))
          expect(yield* askCooldown(engine, ref)).toBe(5)

          // Each TurnCompleted decrements the counter.
          yield* engine.tell(ref, CooldownMsg.TurnCompleted.make({}))
          expect(yield* askCooldown(engine, ref)).toBe(4)

          yield* engine.tell(ref, CooldownMsg.TurnCompleted.make({}))
          yield* engine.tell(ref, CooldownMsg.TurnCompleted.make({}))
          expect(yield* askCooldown(engine, ref)).toBe(2)

          // Suppress(2) re-arms (overwrite, not add).
          yield* engine.tell(ref, CooldownMsg.Suppress.make({ count: 2 }))
          expect(yield* askCooldown(engine, ref)).toBe(2)

          // Decrement clamps at zero.
          yield* engine.tell(ref, CooldownMsg.TurnCompleted.make({}))
          yield* engine.tell(ref, CooldownMsg.TurnCompleted.make({}))
          yield* engine.tell(ref, CooldownMsg.TurnCompleted.make({}))
          expect(yield* askCooldown(engine, ref)).toBe(0)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})
