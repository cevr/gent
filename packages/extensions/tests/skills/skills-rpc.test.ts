/**
 * Skills RPC acceptance test — exercises SkillsExtension through the full
 * request(...) path with per-request scopes, matching production behavior.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { ref, type ProjectionTurnContext, type TurnProjection } from "@gent/core/extensions/api"
import { textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { SessionId, BranchId } from "@gent/core-internal/domain/ids"
import { AgentName } from "@gent/core-internal/domain/agent"
import { getBuiltinAgent } from "@gent/extensions/all-agents"
import { SkillsExtension } from "@gent/extensions/skills"
import { SkillsRpc } from "@gent/extensions/skills/protocol"
import { Skill, Skills } from "@gent/extensions/skills/skills"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { testSetupCtx } from "@gent/core-internal/test-utils"
import { e2ePreset } from "../helpers/test-preset"

const narrowR = <A, E, R>(e: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>

const testSkills = [
  new Skill({
    name: "effect-v4",
    description: "Effect v4 patterns",
    filePath: "/global/effect-v4.md",
    content: "Use Effect.fn for tracing",
    level: "global",
  }),
  new Skill({
    name: "react",
    description: "React component patterns",
    filePath: "/local/react.md",
    content: "Use function components",
    level: "local",
  }),
]

const sessionId = SessionId.make("skills-test-session")
const branchId = BranchId.make("skills-test-branch")

const skillsLayerOverride = { "@gent/skills": () => Skills.Test(testSkills) }

describe("SkillsExtension via RPC", () => {
  it.live("turn projection contributes loaded skills to the prompt", () =>
    narrowR(
      Effect.gen(function* () {
        const contributions = yield* SkillsExtension.setup(testSetupCtx())

        const turnProjection = contributions.reactions?.turnProjection
        if (turnProjection === undefined) throw new Error("expected skills turn projection")
        const runTurnProjection = turnProjection as (
          ctx: ProjectionTurnContext,
        ) => Effect.Effect<TurnProjection, never, Skills>

        const result = yield* narrowR(
          runTurnProjection({
            sessionId,
            branchId,
            cwd: "/test/cwd",
            home: "/test/home",
            turn: {
              sessionId,
              branchId,
              agent: getBuiltinAgent("cowork")!,
              allTools: [],
              agentName: AgentName.make("cowork"),
            },
          }).pipe(Effect.provide(Skills.Test(testSkills)), Effect.orDie),
        )

        const section = (result.promptSections ?? []).find((s) => s.id === "skills")
        expect(section?.content).toContain("effect-v4")
        expect(section?.content).toContain("react")
      }),
    ),
  )

  it.live(
    "ListSkills via request RPC returns skill entries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [SkillsExtension],
            layerOverrides: skillsLayerOverride,
          })

          const reply = (yield* client.extension.request({
            sessionId,
            extensionId: ref(SkillsRpc.ListSkills).extensionId,
            capabilityId: ref(SkillsRpc.ListSkills).capabilityId,
            intent: ref(SkillsRpc.ListSkills).intent,
            input: {},
            branchId,
          })) as ReadonlyArray<{ name: string; description: string; level: string }>

          expect(Array.isArray(reply)).toBe(true)
          expect(reply).toHaveLength(2)
          expect(reply.map((s) => s.name)).toEqual(["effect-v4", "react"])
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "GetSkillContent via request RPC returns single skill",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [SkillsExtension],
            layerOverrides: skillsLayerOverride,
          })

          const reply = (yield* client.extension.request({
            sessionId,
            extensionId: ref(SkillsRpc.GetSkillContent).extensionId,
            capabilityId: ref(SkillsRpc.GetSkillContent).capabilityId,
            intent: ref(SkillsRpc.GetSkillContent).intent,
            input: { name: "effect-v4" },
            branchId,
          })) as { name: string; content: string } | null

          expect(reply).not.toBeNull()
          expect(reply!.name).toBe("effect-v4")
          expect(reply!.content).toBe("Use Effect.fn for tracing")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "GetSkillContent via request RPC returns null for unknown skill",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [SkillsExtension],
            layerOverrides: skillsLayerOverride,
          })

          const reply = yield* client.extension.request({
            sessionId,
            extensionId: ref(SkillsRpc.GetSkillContent).extensionId,
            capabilityId: ref(SkillsRpc.GetSkillContent).capabilityId,
            intent: ref(SkillsRpc.GetSkillContent).intent,
            input: { name: "nonexistent" },
            branchId,
          })

          expect(reply).toBeNull()
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
