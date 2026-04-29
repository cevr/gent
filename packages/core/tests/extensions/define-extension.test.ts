/**
 * defineExtension regression locks.
 *
 * Locks the contract that the public `defineExtension` bucket API returns
 * `ExtensionContributions` from `setup()` that the runtime registry consumes.
 * Each contribution kind round-trips, lifecycle effects compose in registration
 * order, and the result wires into `ExtensionRegistry`.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import {
  defineExtension,
  defineResource,
  defineStatefulExtension,
  defineToolExtension,
  defineUiExtension,
  request,
  tool,
} from "@gent/core/extensions/api"
import type { GentExtension } from "@gent/core/extensions/api"
import { buildResourceLayer } from "../../src/runtime/extensions/resource-host"
import { PermissionRule } from "@gent/core/domain/permission"
import type { ExtensionSetupContext } from "../../src/domain/extension.js"
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import { BranchId, ExtensionId, SessionId } from "@gent/core/domain/ids"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import { testSetupCtx } from "@gent/core/test-utils"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { AgentName } from "@gent/core/domain/agent"
import { ServiceKey, type Behavior } from "../../src/domain/actor"
import { TaggedEnumClass } from "../../src/domain/schema-tagged-enum-class"

const stubHostCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const stubProjectionCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    agent: Agents["cowork"]!,
    allTools: [],
    agentName: AgentName.make("cowork"),
  },
}

const setupOf = (ext: GentExtension) => ext.setup(testSetupCtx())
const HelperMsg = TaggedEnumClass("HelperMsg", {
  Get: TaggedEnumClass.askVariant<number>()({}),
})
type HelperMsg = Schema.Schema.Type<typeof HelperMsg>
const HelperKey = ServiceKey<HelperMsg>("helper")
const helperBehavior: Behavior<HelperMsg, { readonly count: number }, never> = {
  initialState: { count: 1 },
  serviceKey: HelperKey,
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      if (msg._tag === "Get") yield* ctx.reply(state.count)
      return state
    }),
}

describe("defineExtension", () => {
  it.live("empty extension produces empty contribution buckets", () =>
    Effect.gen(function* () {
      const ext = defineExtension({ id: "empty" })
      const contributions = yield* setupOf(ext)
      expect(contributions.tools ?? []).toEqual([])
      expect(contributions.agents ?? []).toEqual([])
      expect(contributions.modelDrivers ?? []).toEqual([])
      expect(contributions.resources ?? []).toEqual([])
      expect(contributions.externalDrivers ?? []).toEqual([])
      expect(contributions.reactions).toBeUndefined()
    }),
  )

  it.live("client facet is preserved on the shared extension artifact", () =>
    Effect.gen(function* () {
      const client = { setup: Effect.succeed([]) }
      const ext = defineExtension({ id: "shared-client", client })
      const contributions = yield* setupOf(ext)

      expect(ext.client).toBe(client)
      expect(contributions).toEqual({})
    }),
  )

  it.live("each kind round-trips into its corresponding bucket", () =>
    Effect.gen(function* () {
      // PermissionRule + PromptSection are bundled on the Capability
      // they decorate (here: `myTool.permissionRules`, `myTool.prompt`).
      const myTool = tool({
        id: "echo",
        description: "echo",
        params: Schema.Struct({}),
        permissionRules: [new PermissionRule({ tool: "echo", action: "allow" })],
        prompt: { id: "rules", content: "rule one", priority: 50 },
        execute: () => Effect.succeed("ok"),
      })
      const myLayer = Layer.empty as Layer.Layer<unknown>
      const ext = defineExtension({
        id: "all-kinds",
        tools: [myTool],
        agents: [Agents["cowork"]!],
        reactions: {
          systemPrompt: (input) => Effect.succeed(`${input.basePrompt} [suffix]`),
        },
        resources: [
          defineResource({
            scope: "process",
            layer: myLayer,
            schedule: [
              {
                id: "test-job",
                cron: "0 0 * * *",
                target: { agent: "cowork" as never, prompt: "hi" },
              },
            ],
          }) as never,
        ],
      })
      const contributions = yield* setupOf(ext)
      const modelCaps = contributions.tools ?? []
      expect(String(modelCaps[0]?.id)).toBe("echo")
      expect(modelCaps[0]?.permissionRules?.[0]?.tool).toBe("echo")
      expect(modelCaps[0]?.prompt?.id).toBe("rules")
      expect((contributions.agents ?? [])[0]?.name).toBe(AgentName.make("cowork"))
      expect(contributions.reactions?.systemPrompt).toBeDefined()
      const resources = contributions.resources ?? []
      expect(resources).toHaveLength(1)
      expect(resources[0]!.schedule?.[0]?.id).toBe("test-job")
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
              layer: Layer.empty as Layer.Layer<unknown>,
              start: append("startup-1"),
              stop: append("shutdown-1"),
            }) as never,
            defineResource({
              scope: "process",
              layer: Layer.empty as Layer.Layer<unknown>,
              start: append("startup-2"),
              stop: append("shutdown-2"),
            }) as never,
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
        // Strict ordering — no sorting. Codex  review flagged that the
        // prior `slice(...).sort()` masked a real ordering bug. Lifecycle
        // is now sequenced through one Effect, so this is deterministic.
        expect(log).toEqual(["startup-1", "startup-2", "shutdown-2", "shutdown-1"])
      }),
  )

  it.live("Effect-returning bucket factory is awaited", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "effectful",
        tools: () =>
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
      expect(String((contributions.tools ?? [])[0]?.id)).toBe("from-effect")
    }),
  )

  it.live("setup context is forwarded to per-bucket factory", () =>
    Effect.gen(function* () {
      let captured: ExtensionSetupContext | undefined
      const ext = defineExtension({
        id: "captures-ctx",
        tools: ({ ctx }) => {
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
        tools: [myTool],
        reactions: {
          systemPrompt: (input) => Effect.succeed(`${input.basePrompt}!!`),
        },
      })
      const contributions = yield* setupOf(ext)
      const loaded = {
        manifest: { id: ExtensionId.make("wired") },
        scope: "builtin" as const,
        sourcePath: "/test/wired",
        contributions,
      }
      const resolved = resolveExtensions([loaded])
      expect(String(resolved.modelCapabilities.get("from-define")?.id)).toBe("from-define")

      const compiled = compileExtensionReactions([loaded])
      const result = yield* compiled.resolveSystemPrompt(
        { basePrompt: "yo", agent: Agents["cowork"]! },
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      expect(result).toBe("yo!!")
    }),
  )

  it.live("bucket factory error becomes ExtensionLoadError", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "boom",
        tools: () => Effect.fail("nope" as never),
      })
      const exit = yield* Effect.exit(setupOf(ext))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = JSON.stringify(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("tools factory failed: nope")
      }
    }),
  )

  it.live("progressive helpers compile into normal contribution buckets", () =>
    Effect.gen(function* () {
      const readSnapshot = request({
        id: "read-snapshot",
        extensionId: ExtensionId.make("helper-state"),
        intent: "read",
        input: Schema.Struct({}),
        output: Schema.Number,
        execute: () => Effect.succeed(1),
      })
      const toolExt = defineToolExtension({
        id: "helper-tool",
        tools: [
          tool({
            id: "helper-tool-call",
            description: "helper tool",
            params: Schema.Struct({}),
            execute: () => Effect.succeed("ok"),
          }),
        ],
      })
      const statefulExt = defineStatefulExtension({
        id: "helper-state",
        actor: helperBehavior,
        rpc: [readSnapshot],
      })
      const uiClient = { setup: Effect.succeed([]) }
      const uiExt = defineUiExtension({
        id: "helper-ui",
        client: uiClient,
      })

      const toolContribs = yield* setupOf(toolExt)
      const statefulContribs = yield* setupOf(statefulExt)
      const uiContribs = yield* setupOf(uiExt)

      expect(toolContribs.tools?.map((t) => String(t.id))).toEqual(["helper-tool-call"])
      expect(statefulContribs.actors).toHaveLength(1)
      expect(statefulContribs.rpc?.map((r) => String(r.id))).toEqual(["read-snapshot"])
      expect(uiExt.client).toBe(uiClient)
      expect(uiContribs).toEqual({})
    }),
  )
})
