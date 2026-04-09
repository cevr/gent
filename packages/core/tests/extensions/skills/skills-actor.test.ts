/**
 * Integration test: exercises SkillsExtension through ExtensionStateRuntime.ask —
 * the same path the TUI's `ctx.ask(SkillsProtocol.ListSkills())` takes.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, type Layer } from "effect"
import type { SessionId, BranchId } from "@gent/core/domain/ids"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { setupExtension } from "@gent/core/runtime/extensions/loader"
import { SkillsExtension } from "@gent/core/extensions/skills"
import { SkillsProtocol } from "@gent/core/extensions/skills/protocol"
import { Skill, Skills } from "@gent/core/extensions/skills/skills"
import { makeActorRuntimeLayer } from "../helpers/actor-runtime-layer"

const sessionId = "skills-test-session" as SessionId
const branchId = "skills-test-branch" as BranchId

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

const setupSkillsExtension = Effect.gen(function* () {
  const loaded = yield* setupExtension(
    { extension: SkillsExtension, kind: "builtin", sourcePath: "builtin" },
    "/test/cwd",
    "/test/home",
  )
  // Override the live Skills layer with test data
  return {
    ...loaded,
    setup: {
      ...loaded.setup,
      layer: Skills.Test(testSkills) as Layer.Layer<never, never, object>,
    },
  } satisfies LoadedExtension
})

describe("SkillsExtension actor via ExtensionStateRuntime", () => {
  it.live("ListSkills returns skills from the Skills service", () =>
    Effect.gen(function* () {
      const ext = yield* setupSkillsExtension
      const layer = makeSkillsRuntimeLayer([ext])

      return yield* Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const reply = yield* runtime.ask(sessionId, SkillsProtocol.ListSkills(), branchId)

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
        const runtime = yield* ExtensionStateRuntime
        const reply = yield* runtime.ask(
          sessionId,
          SkillsProtocol.GetSkillContent({ name: "react" }),
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
        const runtime = yield* ExtensionStateRuntime
        const reply = yield* runtime.ask(
          sessionId,
          SkillsProtocol.GetSkillContent({ name: "nonexistent" }),
          branchId,
        )

        expect(reply).toBeNull()
      }).pipe(Effect.provide(layer))
    }),
  )
})
