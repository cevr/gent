/**
 * Skills RPC acceptance test — exercises SkillsExtension through the full
 * request(...) path with per-request scopes, matching production behavior.
 */
import { describe, it, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, type Layer } from "effect"
import { ref } from "@gent/core/extensions/api"
import type { LoadedExtension } from "../../../src/domain/extension.js"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { setupExtension } from "../../../src/runtime/extensions/loader"
import { compileExtensionReactions } from "../../../src/runtime/extensions/extension-reactions"
import { ActorEngine } from "../../../src/runtime/extensions/actor-engine"
import { SessionId, BranchId } from "@gent/core/domain/ids"
import { AgentName } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { SkillsExtension } from "@gent/extensions/skills"
import { SkillsRpc } from "@gent/extensions/skills/protocol"
import { Skill, Skills } from "@gent/extensions/skills/skills"
import { defineResource } from "@gent/core/domain/contribution"
import { Gent } from "@gent/sdk"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { e2ePreset } from "../helpers/test-preset"

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

const setupSkillsExtension = Effect.provide(
  Effect.gen(function* () {
    const loaded = yield* setupExtension(
      { extension: SkillsExtension, scope: "builtin", sourcePath: "builtin" },
      "/test/cwd",
      "/test/home",
    )
    return {
      ...loaded,
      contributions: {
        ...loaded.contributions,
        resources: (loaded.contributions.resources ?? []).map((r) =>
          r.tag === Skills
            ? defineResource({
                ...r,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
                layer: Skills.Test(testSkills) as Layer.Layer<Skills>,
              })
            : r,
        ),
      },
    } satisfies LoadedExtension
  }),
  BunServices.layer,
)

describe("SkillsExtension via RPC", () => {
  it.live("turn projection contributes loaded skills to the prompt", () =>
    Effect.gen(function* () {
      const ext = yield* setupSkillsExtension
      const compiled = compileExtensionReactions([ext])

      const result = yield* compiled
        .resolveTurnProjection({
          sessionId,
          branchId,
          cwd: "/test/cwd",
          home: "/test/home",
          turn: {
            sessionId,
            branchId,
            agent: Agents["cowork"]!,
            allTools: [],
            agentName: AgentName.make("cowork"),
          },
        })
        .pipe(Effect.provide(Skills.Test(testSkills)))

      const section = result.promptSections.find((s) => s.id === "skills")
      expect(section?.content).toContain("effect-v4")
      expect(section?.content).toContain("react")
    }).pipe(Effect.provide(ActorEngine.Live)),
  )

  it.live(
    "ListSkills via request RPC returns skill entries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupSkillsExtension
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

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
          const ext = yield* setupSkillsExtension
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

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
          const ext = yield* setupSkillsExtension
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

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
