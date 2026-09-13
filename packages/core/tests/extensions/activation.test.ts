import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, FileSystem, Layer, Path, Predicate, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import type {
  ExtensionLoadError,
  GentExtension,
  LoadedExtension,
} from "../../src/domain/extension.js"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"
import type { DiscoveredExtension } from "../../src/runtime/extensions/loader"
import { setupExtensions, validateLoadedExtensions } from "../../src/runtime/extensions/activation"
import type { ExtensionContributions } from "../../src/domain/contribution"
import { defineExtension, defineResource, ExtensionHost, tool } from "@gent/core/extensions/api"
import { registerContributions } from "../../src/domain/extension-host.js"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { ConfigService } from "../../src/runtime/config-service"
import { GentToolMetadataTag, getToolMetadata } from "../../src/domain/capability/tool"
import { ExtensionId } from "../../src/domain/ids"
import type { PromptSection } from "../../src/domain/prompt"
import { ProcessRunnerLive } from "../../src/runtime/run-process"

const childProcessSpawnerLive = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
)

const fsLayer = Layer.provideMerge(
  Layer.mergeAll(BunFileSystem.layer, Path.layer, ProcessRunnerLive, BunGentPlatformLive),
  childProcessSpawnerLive,
)

const builtin = (extension: ReturnType<typeof makeBuiltin>): DiscoveredExtension => ({
  extension,
  scope: "builtin",
  sourcePath: "builtin",
})

const makeBuiltin = (
  id: string,
  setup: Effect.Effect<ExtensionContributions, ExtensionLoadError>,
): GentExtension => ({
  manifest: { id: ExtensionId.make(id) },
  setup: setup.pipe(Effect.flatMap(registerContributions)),
})

const makeLoaded = (id: string, contributions: ExtensionContributions): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope: "builtin",
  sourcePath: "builtin",
  contributions,
})

describe("extension activation isolation", () => {
  it.live("builtin setup failure is isolated instead of crashing activation", () =>
    Effect.gen(function* () {
      const good = makeBuiltin(
        "good-ext",
        Effect.succeed({
          tools: [
            tool({
              id: "good_tool",
              description: "good",
              params: Schema.Struct({}),
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
        }),
      )
      const bad = makeBuiltin("bad-ext", Effect.die(new Error("setup boom")))

      const result = yield* setupExtensions({
        extensions: [good, bad].map(builtin),
        cwd: "/tmp",
        home: "/tmp",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("good-ext")])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]!.manifest.id).toBe(ExtensionId.make("bad-ext"))
      expect(result.failed[0]!.phase).toBe("setup")
      expect(result.failed[0]!.error).toContain("setup boom")
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("does not infer builtin identity without a compiled build token", () =>
    Effect.gen(function* () {
      const extension = makeBuiltin("compiled-artifact", Effect.succeed({}))
      const result = yield* setupExtensions({
        extensions: [builtin(extension)],
        cwd: "/tmp",
        home: "/tmp",
        disabled: new Set(),
      })
      expect(result.active[0]?.artifactIdentity).toBeUndefined()
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("discovered setup failure is isolated instead of crashing activation", () =>
    Effect.gen(function* () {
      const result = yield* setupExtensions({
        extensions: [
          {
            extension: makeBuiltin("good-ext", Effect.succeed({})),
            scope: "user",
            sourcePath: "/tmp/good.ts",
          },
          {
            extension: makeBuiltin("bad-ext", Effect.die(new Error("setup boom"))),
            scope: "project",
            sourcePath: "/tmp/bad.ts",
          },
        ],
        cwd: "/tmp",
        home: "/tmp",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("good-ext")])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]).toMatchObject({
        manifest: { id: ExtensionId.make("bad-ext") },
        scope: "project",
        sourcePath: "/tmp/bad.ts",
        phase: "setup",
      })
      expect(result.failed[0]?.error).toContain("setup boom")
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live(
    "validation collisions fail the conflicting extensions instead of crashing host activation",
    () =>
      Effect.gen(function* () {
        const result = yield* validateLoadedExtensions([
          makeLoaded("healthy-ext", {
            tools: [
              tool({
                id: "healthy_tool",
                description: "healthy",
                params: Schema.Struct({}),
                output: Schema.Void,
                execute: () => Effect.void,
              }),
            ],
          }),
          makeLoaded("collider-a", {
            tools: [
              tool({
                id: "shared_tool",
                description: "a",
                params: Schema.Struct({}),
                output: Schema.Void,
                execute: () => Effect.void,
              }),
            ],
          }),
          makeLoaded("collider-b", {
            tools: [
              tool({
                id: "shared_tool",
                description: "b",
                params: Schema.Struct({}),
                output: Schema.Void,
                execute: () => Effect.void,
              }),
            ],
          }),
        ])

        expect(result.active.map((ext) => ext.manifest.id)).toEqual([
          ExtensionId.make("healthy-ext"),
        ])
        expect(result.failed).toHaveLength(2)
        expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
          ExtensionId.make("collider-a"),
          ExtensionId.make("collider-b"),
        ])
        expect(result.failed.every((ext) => ext.phase === "validation")).toBe(true)
        expect(result.failed.every((ext) => ext.error.includes("shared_tool"))).toBe(true)
      }),
  )

  //  BLOCK: validation must catch cross-bucket capability collisions in
  // addition to tool/tool. The resolver overwrites silently in last-write-wins
  // order without this check.

  // Validation still owns semantic tool checks after authoring has produced a
  // native Effect tool. Description checks live here because runtime-loaded
  // extensions can pass schema-valid but model-hostile tool metadata.
  const rawToolLeaf = (id: string, description?: string) => {
    let normalizedDescription = ""
    if (!Predicate.isUndefined(description)) normalizedDescription = description
    return tool({
      id,
      description: normalizedDescription,
      params: Schema.Unknown,
      output: Schema.Void,
      execute: () => Effect.void,
    })
  }

  const rawNativeToolLeaf = (id: string): never =>
    // oxlint-disable-next-line effect/noAs -- This invalid native tool is a runtime validation fixture.
    AiTool.dynamic(id, {
      description: "native but missing Gent metadata",
      parameters: Schema.Unknown,
    }) as never

  const metadataSpoofedToolLeaf = (
    id: string,
    metadata: {
      readonly id?: string
      readonly prompt?: PromptSection
    } = {},
  ): never => {
    const legit = tool({
      id: metadata.id ?? "legit",
      description: "legit",
      params: Schema.Unknown,
      output: Schema.Void,
      prompt: metadata.prompt,
      execute: () => Effect.void,
    })
    // oxlint-disable-next-line effect/noAs -- This metadata-spoofed native tool is a runtime validation fixture.
    return AiTool.dynamic(id, {
      description: "native with copied Gent metadata but no private brand",
      parameters: Schema.Unknown,
    }).annotate(GentToolMetadataTag, getToolMetadata(legit)) as never
  }

  const rawRpcLeaf = (id: string): never =>
    // oxlint-disable-next-line effect/noAs -- This invalid RPC leaf is a runtime validation fixture.
    ({
      id,
      public: true,
      input: Schema.Unknown,
      output: Schema.Unknown,
      effect: () => Effect.void,
    }) as never

  it.live("validation catches same-scope tool/tool name collision", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("collider-a", { tools: [rawToolLeaf("shared_cap", "a")] }),
        makeLoaded("collider-b", { tools: [rawToolLeaf("shared_cap", "b")] }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
        ExtensionId.make("collider-a"),
        ExtensionId.make("collider-b"),
      ])
      expect(result.failed.every((ext) => ext.error.includes("shared_cap"))).toBe(true)
    }),
  )

  it.live("validation does NOT collide rpc(non-model) with same-name tool", () =>
    Effect.gen(function* () {
      // A capability that doesn't surface as a tool (no `model` audience)
      // must NOT trigger a "tool" collision against a same-name tool.
      // The tool list is "things audience-authorized as model"; cross-audience
      // sharing of an id is fine.
      const result = yield* validateLoadedExtensions([
        makeLoaded("model-tool", {
          tools: [
            tool({
              id: "shared_name",
              description: "model",
              params: Schema.Struct({}),
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
        }),
        makeLoaded("rpc-only", { requests: [rawRpcLeaf("shared_name")] }),
      ])

      expect(result.active.map((ext) => ext.manifest.id).sort()).toEqual([
        ExtensionId.make("model-tool"),
        ExtensionId.make("rpc-only"),
      ])
      expect(result.failed).toEqual([])
    }),
  )

  it.live("validation rejects model tool with empty description", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("missing-desc", { tools: [rawToolLeaf("describeless")] }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe(ExtensionId.make("missing-desc"))
      expect(result.failed[0]?.error).toBe(
        'Tool "describeless" is missing a non-empty description (the LLM tool schema requires one).',
      )
    }),
  )

  it.live("validation rejects model tool with whitespace-only description", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("blank-desc", { tools: [rawToolLeaf("blanky", "   \t\n")] }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe(ExtensionId.make("blank-desc"))
    }),
  )

  it.live("validation rejects native Effect tools without Gent metadata", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("raw-native-tool", { tools: [rawNativeToolLeaf("raw_tool")] }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe(ExtensionId.make("raw-native-tool"))
      expect(result.failed[0]?.error).toBe(
        "Tool must be created with `tool({...})` so Gent metadata is attached.",
      )
    }),
  )

  it.live("validation rejects metadata-spoofed native Effect tools", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("metadata-spoof", { tools: [metadataSpoofedToolLeaf("spoofed_tool")] }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe(ExtensionId.make("metadata-spoof"))
      expect(result.failed[0]?.error).toBe(
        "Tool must be created with `tool({...})` so Gent metadata is attached.",
      )
    }),
  )

  it.live("validation ignores metadata-spoofed tools when checking tool collisions", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("healthy-ext", {
          tools: [
            tool({
              id: "shared_cap",
              description: "healthy",
              params: Schema.Unknown,
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
        }),
        makeLoaded("metadata-spoof", {
          tools: [metadataSpoofedToolLeaf("spoofed_native", { id: "shared_cap" })],
        }),
      ])

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("healthy-ext")])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe(ExtensionId.make("metadata-spoof"))
      expect(result.failed[0]?.error).toBe(
        "Tool must be created with `tool({...})` so Gent metadata is attached.",
      )
    }),
  )

  it.live("validation ignores metadata-spoofed tools when checking prompt collisions", () =>
    Effect.gen(function* () {
      const prompt = { id: "shared_prompt", content: "rules", priority: 50 }
      const result = yield* validateLoadedExtensions([
        makeLoaded("healthy-ext", {
          tools: [
            tool({
              id: "healthy_tool",
              description: "healthy",
              params: Schema.Unknown,
              output: Schema.Void,
              prompt,
              execute: () => Effect.void,
            }),
          ],
        }),
        makeLoaded("metadata-spoof", {
          tools: [metadataSpoofedToolLeaf("spoofed_native", { prompt })],
        }),
      ])

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("healthy-ext")])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe(ExtensionId.make("metadata-spoof"))
      expect(result.failed[0]?.error).toBe(
        "Tool must be created with `tool({...})` so Gent metadata is attached.",
      )
    }),
  )

  it.live("validation accepts non-model capability without description", () =>
    Effect.gen(function* () {
      // RPC requests don't ship to the LLM as tools, so empty description is
      // fine. Only model-callable tool leaves require a description.
      const result = yield* validateLoadedExtensions([
        makeLoaded("rpc-no-desc", { requests: [rawRpcLeaf("internal")] }),
      ])

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("rpc-no-desc")])
      expect(result.failed).toEqual([])
    }),
  )

  it.scopedLive("live Profile isolates setup and scheduler failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const context = yield* Layer.build(
        SessionProfileCache.Live({
          home,
          platform: "test",
          extensions: [
            makeBuiltin(
              "healthy-ext",
              Effect.succeed({
                tools: [
                  tool({
                    id: "healthy_tool",
                    description: "healthy",
                    params: Schema.Struct({}),
                    output: Schema.Void,
                    execute: () => Effect.void,
                  }),
                ],
              }),
            ),
            makeBuiltin("broken-setup", Effect.die(new Error("setup boom"))),
          ],
        }),
      )
      const cache = Context.get(context, SessionProfileCache)
      const profile = yield* cache.resolve(home)
      expect(profile.resolved.extensions.map((ext) => ext.manifest.id)).toEqual([
        ExtensionId.make("healthy-ext"),
      ])
      expect([...profile.resolved.modelCapabilities.keys()]).toEqual(["healthy_tool"])
      expect(profile.resolved.failedExtensions).toHaveLength(1)
      expect(profile.resolved.failedExtensions[0]).toMatchObject({
        manifest: { id: ExtensionId.make("broken-setup") },
        phase: "setup",
      })
      expect(profile.resolved.failedExtensions[0]?.error).toContain("setup boom")
      expect(profile.resolved.extensionStatuses[0]).toMatchObject({ status: "active" })
    }).pipe(Effect.provide(Layer.merge(fsLayer, ConfigService.Test()))),
  )

  it.scopedLive("a failed resource start suspends only its extension and keeps siblings live", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      let released = 0
      const healthy = defineExtension({
        id: "healthy",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The fixture erases a resource with no service output at the contribution boundary.
            defineResource({
              id: "test/healthy",
              scope: "process",
              layer: Layer.effectDiscard(
                Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    released++
                  }),
                ),
              ),
            }) as never,
          )
        }),
      })
      const broken = defineExtension({
        id: "broken",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The fixture erases a resource with no service output at the contribution boundary.
            defineResource({
              id: "test/broken",
              scope: "process",
              layer: Layer.empty,
              start: Effect.die("resource start boom"),
            }) as never,
          )
        }),
      })
      const context = yield* Layer.build(
        SessionProfileCache.Live({
          home,
          platform: "test",
          extensions: [healthy, broken],
        }),
      )
      const cache = Context.get(context, SessionProfileCache)
      const profile = yield* cache.resolve(home)
      expect(profile.resolved.extensions.map((ext) => ext.manifest.id)).toEqual([
        ExtensionId.make("healthy"),
      ])
      expect(profile.resolved.failedExtensions).toMatchObject([
        { manifest: { id: ExtensionId.make("broken") }, phase: "startup" },
      ])
      expect(profile.resolved.failedExtensions[0]?.error).toContain("resource start boom")
      // The healthy resource stays acquired until the server scope closes.
      expect(released).toBe(0)
    }).pipe(Effect.provide(Layer.merge(fsLayer, ConfigService.Test()))),
  )
})
