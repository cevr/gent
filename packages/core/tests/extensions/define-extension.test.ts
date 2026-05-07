/**
 * defineExtension regression locks.
 *
 * Locks the contract that the public `defineExtension` bucket API returns
 * `ExtensionContributions` from `setup()` that the runtime registry consumes.
 * Each contribution kind round-trips, lifecycle effects compose in registration
 * order, and the result wires into `ExtensionRegistry`.
 */
import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Layer, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import { getBuiltinAgent } from "@gent/extensions/all-agents"
import {
  defineExtension,
  defineResource,
  GentToolMetadataTag,
  getToolId,
  getToolMetadata,
  request,
  tool,
  validatePackageShape,
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
    agent: getBuiltinAgent("cowork")!,
    allTools: [],
    agentName: AgentName.make("cowork"),
  },
}

const setupOf = (ext: GentExtension) => ext.setup(testSetupCtx())

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
        output: Schema.String,
        permissionRules: [new PermissionRule({ tool: "echo", action: "allow" })],
        prompt: { id: "rules", content: "rule one", priority: 50 },
        execute: () => Effect.succeed("ok"),
      })
      const myLayer = Layer.empty as Layer.Layer<unknown>
      const ext = defineExtension({
        id: "all-kinds",
        tools: [myTool],
        agents: [getBuiltinAgent("cowork")!],
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
      const modelCapMetadata =
        modelCaps[0] !== undefined ? getToolMetadata(modelCaps[0]) : undefined
      expect(String(modelCaps[0] === undefined ? undefined : getToolId(modelCaps[0]))).toBe("echo")
      expect(modelCapMetadata?.permissionRules?.[0]?.tool).toBe("echo")
      expect(modelCapMetadata?.prompt?.id).toBe("rules")
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
          Layer.build(buildResourceLayer([loaded], "process")).pipe(Effect.asVoid),
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
                output: Schema.Void,
                execute: () => Effect.void,
              }),
            ]
          }),
      })
      const contributions = yield* setupOf(ext)
      expect(
        String(
          (contributions.tools ?? [])[0] === undefined
            ? undefined
            : getToolId((contributions.tools ?? [])[0]!),
        ),
      ).toBe("from-effect")
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
        output: Schema.String,
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
      expect(
        String(
          resolved.modelCapabilities.get("from-define") === undefined
            ? undefined
            : getToolId(resolved.modelCapabilities.get("from-define")!),
        ),
      ).toBe("from-define")

      const compiled = compileExtensionReactions([loaded])
      const result = yield* compiled.resolveSystemPrompt(
        { basePrompt: "yo", agent: getBuiltinAgent("cowork")! },
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
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("tools factory failed: nope")
      }
    }),
  )

  it.live("raw native Effect tools are rejected at defineExtension setup", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "raw-native",
        tools: [
          AiTool.dynamic("raw_tool", {
            description: "native but missing Gent metadata",
            parameters: Schema.Unknown,
          }) as never,
        ],
      })
      const exit = yield* Effect.exit(setupOf(ext))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain(
          "tools[0]: tool must be created with `tool({...})` so Gent metadata is attached",
        )
      }
    }),
  )

  it.live("metadata-spoofed native Effect tools are rejected at defineExtension setup", () =>
    Effect.gen(function* () {
      const legit = tool({
        id: "legit",
        description: "legit",
        params: Schema.Unknown,
        output: Schema.Void,
        execute: () => Effect.void,
      })
      const ext = defineExtension({
        id: "metadata-spoof",
        tools: [
          AiTool.dynamic("spoofed_tool", {
            description: "native with copied Gent metadata but no private brand",
            parameters: Schema.Unknown,
          }).annotate(GentToolMetadataTag, getToolMetadata(legit)) as never,
        ],
      })
      const exit = yield* Effect.exit(setupOf(ext))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain(
          "tools[0]: tool must be created with `tool({...})` so Gent metadata is attached",
        )
      }
    }),
  )

  it.live("unknown runtime-loaded contribution buckets fail activation", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validatePackageShape({ id: ExtensionId.make("unknown-bucket") }, { actors: [] } as never),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("unknown contribution bucket")
        expect(rendered).toContain("actors")
      }
    }),
  )

  it.live("unknown defineExtension buckets fail activation before normalization", () =>
    Effect.gen(function* () {
      const ext = defineExtension({ id: "unknown-bucket", actors: [] } as never)
      const exit = yield* Effect.exit(setupOf(ext))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("unknown contribution bucket")
        expect(rendered).toContain("actors")
      }
    }),
  )

  it.live("defineExtension preserves contribution buckets and client facets", () =>
    Effect.gen(function* () {
      const readSnapshot = request({
        id: "read-snapshot",
        extensionId: ExtensionId.make("helper-state"),
        intent: "read",
        input: Schema.Struct({}),
        output: Schema.Number,
        execute: () => Effect.succeed(1),
      })
      const toolExt = defineExtension({
        id: "helper-tool",
        tools: [
          tool({
            id: "helper-tool-call",
            description: "helper tool",
            params: Schema.Struct({}),
            output: Schema.String,
            execute: () => Effect.succeed("ok"),
          }),
        ],
      })
      const rpcExt = defineExtension({
        id: "helper-rpc",
        requests: [readSnapshot],
      })
      const uiClient = { setup: Effect.succeed([]) }
      const uiExt = defineExtension({
        id: "helper-ui",
        client: uiClient,
      })

      const toolContribs = yield* setupOf(toolExt)
      const requestContribs = yield* setupOf(rpcExt)
      const uiContribs = yield* setupOf(uiExt)

      expect(toolContribs.tools?.map((t) => String(getToolId(t)))).toEqual(["helper-tool-call"])
      expect(requestContribs.requests?.map((r) => String(r.id))).toEqual(["read-snapshot"])
      expect(uiExt.client).toBe(uiClient)
      expect(uiContribs).toEqual({})
    }),
  )
})
