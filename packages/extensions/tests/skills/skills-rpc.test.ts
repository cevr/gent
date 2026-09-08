/**
 * Skills RPC acceptance test — exercises SkillsExtension through the full
 * request(...) path with per-request scopes, matching production behavior.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Option, Schema } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"
import { ref } from "@gent/core/extensions/api"
import { textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { SkillsExtension } from "../../src/skills/index.js"
import { SkillEntry, SkillsRpc } from "../../src/skills/protocol.js"
import { Skill, Skills } from "../../src/skills/skills.js"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { collectTestContributions } from "@gent/core-internal/test-utils"
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

const skillsLayerOverride = { "@gent/skills": () => Skills.Test(testSkills) }

describe("SkillsExtension via RPC", () => {
  it.live("turn projection contributes loaded skills to the prompt", () =>
    narrowR(
      Effect.gen(function* () {
        const contributions = yield* collectTestContributions(SkillsExtension.setup)

        const turnProjection = Option.fromUndefinedOr(
          contributions.hooks?.find((slot) => slot.kind === "turnProjection"),
        )
        if (Option.isNone(turnProjection)) {
          return yield* Effect.die(new Error("expected skills turn projection"))
        }
        const result = yield* narrowR(
          turnProjection.value.hook
            .handler()
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
            .pipe(Effect.provide(Skills.Test(testSkills)), Effect.orDie),
        )

        const section = Option.flatMap(Option.fromUndefinedOr(result.promptSections), (sections) =>
          Option.fromUndefinedOr(sections.find((s) => s.id === "skills")),
        )
        if (Option.isNone(section)) {
          return yield* Effect.die(new Error("expected skills prompt section"))
        }
        expect(section.value.content).toContain("effect-v4")
        expect(section.value.content).toContain("react")
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

          const rawReply = yield* client.extension.request({
            sessionId,
            extensionId: ref(SkillsRpc.ListSkills).extensionId,
            capabilityId: ref(SkillsRpc.ListSkills).capabilityId,
            input: {},
            branchId,
          })
          const reply = yield* Schema.decodeUnknownEffect(Schema.Array(SkillEntry))(rawReply)

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

          const rawReply = yield* client.extension.request({
            sessionId,
            extensionId: ref(SkillsRpc.GetSkillContent).extensionId,
            capabilityId: ref(SkillsRpc.GetSkillContent).capabilityId,
            input: { name: "effect-v4" },
            branchId,
          })
          const reply = yield* Schema.decodeUnknownEffect(Schema.NullOr(SkillEntry))(rawReply)

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
            input: { name: "nonexistent" },
            branchId,
          })

          expect(reply).toBeNull()
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
