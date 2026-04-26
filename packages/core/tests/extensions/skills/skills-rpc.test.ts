/**
 * Skills RPC acceptance test — exercises SkillsExtension through the full
 * RPC path with per-request scopes, matching production behavior.
 *
 * Unlike skills-actor.test.ts (which bypasses RPC), this test goes through
 * Gent.test → RpcServer → extension.ask → MachineEngine.
 */
import { describe, it, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, type Layer } from "effect"
import type { LoadedExtension } from "../../../src/domain/extension.js"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { setupExtension } from "../../../src/runtime/extensions/loader"
import { SkillsExtension } from "@gent/extensions/skills"
import { SkillsProtocol } from "@gent/extensions/skills/protocol"
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
  it.live(
    "ListSkills via RPC returns skill entries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupSkillsExtension
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const reply = (yield* client.extension.ask({
            sessionId,
            branchId,
            message: SkillsProtocol.ListSkills.make(),
          })) as ReadonlyArray<{ name: string; description: string; level: string }>

          expect(Array.isArray(reply)).toBe(true)
          expect(reply).toHaveLength(2)
          expect(reply.map((s) => s.name)).toEqual(["effect-v4", "react"])
        }),
      ),
    { timeout: 10_000 },
  )

  it.live(
    "GetSkillContent via RPC returns single skill",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupSkillsExtension
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const reply = (yield* client.extension.ask({
            sessionId,
            branchId,
            message: SkillsProtocol.GetSkillContent.make({ name: "effect-v4" }),
          })) as { name: string; content: string } | null

          expect(reply).not.toBeNull()
          expect(reply!.name).toBe("effect-v4")
          expect(reply!.content).toBe("Use Effect.fn for tracing")
        }),
      ),
    { timeout: 10_000 },
  )

  it.live(
    "GetSkillContent via RPC returns null for unknown skill",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupSkillsExtension
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const reply = yield* client.extension.ask({
            sessionId,
            branchId,
            message: SkillsProtocol.GetSkillContent.make({ name: "nonexistent" }),
          })

          expect(reply).toBeNull()
        }),
      ),
    { timeout: 10_000 },
  )
})
