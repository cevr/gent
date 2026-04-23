/**
 * defineExtension regression locks.
 *
 * Locks the contract that the public `defineExtension` bucket API returns
 * `ExtensionContributions` from `setup()` that the runtime registry consumes.
 * Each contribution kind round-trips, lifecycle effects compose in registration
 * order, and the result wires into `ExtensionRegistry`.
 *
 * Tied to planify Commit 1 / C8 — without this, `defineExtension` is a paper API.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import { defineExtension, defineResource, tool } from "@gent/core/extensions/api"
import { buildResourceLayer } from "@gent/core/runtime/extensions/resource-host"
import { PermissionRule } from "@gent/core/domain/permission"
import type { ExtensionSetupContext } from "../../src/domain/extension.js"
import { resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { compileRuntimeSlots } from "@gent/core/runtime/extensions/runtime-slots"
import { testSetupCtx } from "@gent/core/test-utils"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"

const stubHostCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const stubProjectionCtx = {
  sessionId: SessionId.of("test-session"),
  branchId: BranchId.of("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.of("test-session"),
    branchId: BranchId.of("test-branch"),
    agent: Agents.cowork,
    allTools: [],
    agentName: "cowork",
  },
}

const setupOf = (ext: ReturnType<typeof defineExtension>) => ext.setup(testSetupCtx())

describe("defineExtension", () => {
  it.live("empty extension produces empty contribution buckets", () =>
    Effect.gen(function* () {
      const ext = defineExtension({ id: "empty" })
      const contributions = yield* setupOf(ext)
      expect(contributions.capabilities ?? []).toEqual([])
      expect(contributions.agents ?? []).toEqual([])
      expect(contributions.modelDrivers ?? []).toEqual([])
      expect(contributions.resources ?? []).toEqual([])
      expect(contributions.externalDrivers ?? []).toEqual([])
      expect(contributions.projections ?? []).toEqual([])
    }),
  )

  it.live("each kind round-trips into its corresponding bucket", () =>
    Effect.gen(function* () {
      // C7: PermissionRule + PromptSection are now bundled on the Capability
      // they decorate (here: `myTool.permissionRules`, `myTool.prompt`).
      const myTool = tool({
        id: "echo",
        description: "echo",
        params: Schema.Struct({}),
        permissionRules: [new PermissionRule({ tool: "echo", action: "allow" })],
        prompt: { id: "rules", content: "rule one", priority: 50 },
        execute: () => Effect.succeed("ok"),
      })
      const myLayer = Layer.empty
      const ext = defineExtension({
        id: "all-kinds",
        capabilities: [myTool],
        agents: [Agents.cowork],
        projections: [
          {
            id: "prompt-suffix",
            query: () => Effect.succeed(" [suffix]"),
            systemPrompt: (suffix, input) => Effect.succeed(`${input.basePrompt}${suffix}`),
          },
        ],
        resources: [
          defineResource({
            scope: "process",
            layer: myLayer,
            subscriptions: [{ pattern: "agent:*", handler: () => Effect.void }],
            schedule: [
              {
                id: "test-job",
                cron: "0 0 * * *",
                target: { kind: "headless-agent", agent: "cowork" as never, prompt: "hi" },
              },
            ],
          }),
        ],
      })
      const contributions = yield* setupOf(ext)
      // After C4.4, `tool(...)` lowers into a Capability(audiences:["model"]).
      const modelCaps = (contributions.capabilities ?? []).filter((c) =>
        c.audiences.includes("model"),
      )
      expect(modelCaps[0]?.id).toBe("echo")
      expect(modelCaps[0]?.permissionRules?.[0]?.tool).toBe("echo")
      expect(modelCaps[0]?.prompt?.id).toBe("rules")
      expect((contributions.agents ?? [])[0]?.name).toBe("cowork")
      expect((contributions.projections ?? [])[0]?.id).toBe("prompt-suffix")
      const resources = contributions.resources ?? []
      expect(resources).toHaveLength(1)
      expect(resources[0]!.schedule?.[0]?.id).toBe("test-job")
      expect(resources[0]!.subscriptions?.[0]?.pattern).toBe("agent:*")
    }),
  )

  it.live(
    "Resource.start and Resource.stop run at scope build/teardown via buildResourceLayer in declaration / reverse order",
    () =>
      Effect.gen(function* () {
        const log: string[] = []
        const append = (s: string) => Effect.sync(() => log.push(s))
        const ext = defineExtension({
          id: "lifecycle",
          resources: [
            defineResource({
              scope: "process",
              layer: Layer.empty,
              start: append("startup-1"),
              stop: append("shutdown-1"),
            }),
            defineResource({
              scope: "process",
              layer: Layer.empty,
              start: append("startup-2"),
              stop: append("shutdown-2"),
            }),
          ],
        })
        const contributions = yield* setupOf(ext)
        const loaded = {
          manifest: { id: ext.manifest.id },
          scope: "builtin" as const,
          sourcePath: "builtin",
          contributions,
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(buildResourceLayer([loaded], "process"))
          }),
        )
        // Strict ordering — no sorting. Codex C3.4 review flagged that the
        // prior `slice(...).sort()` masked a real ordering bug. Lifecycle
        // is now sequenced through one Effect, so this is deterministic.
        expect(log).toEqual(["startup-1", "startup-2", "shutdown-2", "shutdown-1"])
      }),
  )

  it.live("multiple Resource subscriptions accumulate", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "multi",
        resources: [
          defineResource({
            scope: "process",
            layer: Layer.empty,
            subscriptions: [
              { pattern: "a:*", handler: () => Effect.void },
              { pattern: "b:*", handler: () => Effect.void },
            ],
          }),
        ],
      })
      const contributions = yield* setupOf(ext)
      const resources = contributions.resources ?? []
      expect(resources).toHaveLength(1)
      expect(resources[0]!.subscriptions).toHaveLength(2)
    }),
  )

  it.live("Effect-returning bucket factory is awaited", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "effectful",
        capabilities: () =>
          Effect.gen(function* () {
            yield* Effect.void
            return [
              tool({
                id: "from-effect",
                description: "from effect",
                params: Schema.Struct({}),
                execute: () => Effect.void,
              }),
            ]
          }),
      })
      const contributions = yield* setupOf(ext)
      expect((contributions.capabilities ?? [])[0]?.id).toBe("from-effect")
    }),
  )

  it.live("setup context is forwarded to per-bucket factory", () =>
    Effect.gen(function* () {
      let captured: ExtensionSetupContext | undefined
      const ext = defineExtension({
        id: "captures-ctx",
        capabilities: ({ ctx }) => {
          captured = ctx
          return []
        },
      })
      yield* setupOf(ext)
      expect(captured?.cwd).toBeDefined()
      expect(captured?.home).toBeDefined()
      expect(captured?.spawner).toBeDefined()
    }),
  )

  it.live("defineExtension result wires through ExtensionRegistry + explicit prompt slots", () =>
    Effect.gen(function* () {
      const myTool = tool({
        id: "from-define",
        description: "test",
        params: Schema.Struct({}),
        execute: () => Effect.succeed("hi"),
      })
      const ext = defineExtension({
        id: "wired",
        capabilities: [myTool],
        projections: [
          {
            id: "prompt",
            query: () => Effect.succeed("!!"),
            systemPrompt: (suffix, input) => Effect.succeed(`${input.basePrompt}${suffix}`),
          },
        ],
      })
      const contributions = yield* setupOf(ext)
      const loaded = {
        manifest: { id: "wired" },
        scope: "builtin" as const,
        sourcePath: "/test/wired",
        contributions,
      }
      const resolved = resolveExtensions([loaded])
      expect(resolved.modelCapabilities.get("from-define")?.id).toBe("from-define")

      const compiled = compileRuntimeSlots([loaded])
      const result = yield* compiled.resolveSystemPrompt(
        { basePrompt: "yo", agent: Agents.cowork },
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      expect(result).toBe("yo!!")
    }),
  )

  it.live("bucket factory error becomes ExtensionLoadError", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "boom",
        capabilities: () => Effect.fail("nope"),
      })
      const exit = yield* Effect.exit(setupOf(ext))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = JSON.stringify(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("capabilities factory failed: nope")
      }
    }),
  )
})
