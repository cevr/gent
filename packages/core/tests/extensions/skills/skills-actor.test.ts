/**
 * Actor runtime test: exercises SkillsExtension through direct
 * MachineEngine.execute (bypasses RPC per-request scopes).
 * For RPC acceptance coverage, see skills-rpc.test.ts.
 */
import { describe, it, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, type Layer } from "effect"
import { SessionId, BranchId } from "@gent/core/domain/ids"
import type { LoadedExtension } from "../../../src/domain/extension.js"
import { MachineEngine } from "../../../src/runtime/extensions/resource-host/machine-engine"
import { setupExtension } from "../../../src/runtime/extensions/loader"
import { SkillsExtension } from "@gent/extensions/skills"
import { SkillsProtocol } from "@gent/extensions/skills/protocol"
import { Skill, Skills } from "@gent/extensions/skills/skills"
import { defineResource } from "@gent/core/domain/contribution"
import { makeActorRuntimeLayer } from "../helpers/actor-runtime-layer"

const sessionId = SessionId.make("skills-test-session")
const branchId = BranchId.make("skills-test-branch")

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

const makeSkillsRuntimeLayer = (extensions: LoadedExtension[]) =>
  makeActorRuntimeLayer({ extensions })

const setupSkillsExtension = Effect.provide(
  Effect.gen(function* () {
    const loaded = yield* setupExtension(
      { extension: SkillsExtension, scope: "builtin", sourcePath: "builtin" },
      "/test/cwd",
      "/test/home",
    )
    // Override the live Skills layer with test data — swap the `layer` field
    // on the existing Resource so the machine (and any other Resource fields)
    // are preserved.
    return {
      ...loaded,
      contributions: {
        ...loaded.contributions,
        resources: (loaded.contributions.resources ?? []).map((r) =>
          r.tag === Skills
            ? defineResource({
                ...r,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                layer: Skills.Test(testSkills) as Layer.Layer<Skills>,
              })
            : r,
        ),
      },
    } satisfies LoadedExtension
  }),
  BunServices.layer,
)

describe("SkillsExtension actor via MachineEngine", () => {
  it.live("ListSkills returns skills from the Skills service", () =>
    Effect.gen(function* () {
      const ext = yield* setupSkillsExtension
      const layer = makeSkillsRuntimeLayer([ext])

      return yield* Effect.gen(function* () {
        const runtime = yield* MachineEngine
        const reply = yield* runtime.execute(sessionId, SkillsProtocol.ListSkills.make(), branchId)

        expect(Array.isArray(reply)).toBe(true)
        expect(reply).toHaveLength(2)
        expect(reply.map((s) => s.name)).toEqual(["effect-v4", "react"])
        expect(reply[0]!.description).toBe("Effect v4 patterns")
        expect(reply[1]!.level).toBe("local")
      }).pipe(Effect.provide(layer))
    }),
  )

  it.live("GetSkillContent returns a single skill", () =>
    Effect.gen(function* () {
      const ext = yield* setupSkillsExtension
      const layer = makeSkillsRuntimeLayer([ext])

      return yield* Effect.gen(function* () {
        const runtime = yield* MachineEngine
        const reply = yield* runtime.execute(
          sessionId,
          SkillsProtocol.GetSkillContent.make({ name: "react" }),
          branchId,
        )

        expect(reply).not.toBeNull()
        expect(reply!.name).toBe("react")
        expect(reply!.content).toBe("Use function components")
      }).pipe(Effect.provide(layer))
    }),
  )

  it.live("GetSkillContent returns null for unknown skill", () =>
    Effect.gen(function* () {
      const ext = yield* setupSkillsExtension
      const layer = makeSkillsRuntimeLayer([ext])

      return yield* Effect.gen(function* () {
        const runtime = yield* MachineEngine
        const reply = yield* runtime.execute(
          sessionId,
          SkillsProtocol.GetSkillContent.make({ name: "nonexistent" }),
          branchId,
        )

        expect(reply).toBeNull()
      }).pipe(Effect.provide(layer))
    }),
  )
})
