/**
 * Skills RPC acceptance test — exercises SkillsExtension through the full
 * RPC path with per-request scopes, matching production behavior.
 *
 * Unlike skills-actor.test.ts (which bypasses RPC), this test goes through
 * Gent.test → RpcServer → extension.ask → WorkflowRuntime.
 */
import { describe, it, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, type Layer } from "effect"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { textStep, createSequenceProvider } from "@gent/core/debug/provider"
import { setupExtension } from "@gent/core/runtime/extensions/loader"
import { SkillsExtension } from "@gent/extensions/skills"
import { SkillsProtocol } from "@gent/extensions/skills/protocol"
import { Skill, Skills } from "@gent/extensions/skills/skills"
import { createRpcHarness } from "../helpers/rpc-harness"

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
      { extension: SkillsExtension, kind: "builtin", sourcePath: "builtin" },
      "/test/cwd",
      "/test/home",
    )
    return {
      ...loaded,
      setup: {
        ...loaded.setup,
        layer: Skills.Test(testSkills) as Layer.Layer<never, never, object>,
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
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* createRpcHarness({
            providerLayer,
            extensions: [ext],
          })

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const reply = (yield* client.extension.ask({
            sessionId,
            branchId,
            message: SkillsProtocol.ListSkills(),
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
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* createRpcHarness({
            providerLayer,
            extensions: [ext],
          })

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const reply = (yield* client.extension.ask({
            sessionId,
            branchId,
            message: SkillsProtocol.GetSkillContent({ name: "effect-v4" }),
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
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* createRpcHarness({
            providerLayer,
            extensions: [ext],
          })

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const reply = yield* client.extension.ask({
            sessionId,
            branchId,
            message: SkillsProtocol.GetSkillContent({ name: "nonexistent" }),
          })

          expect(reply).toBeNull()
        }),
      ),
    { timeout: 10_000 },
  )
})
