import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { narrowR } from "../helpers/effect"
import * as AiTool from "effect/unstable/ai/Tool"
import type {
  ExtensionLoadError,
  GentExtension,
  LoadedExtension,
} from "../../src/domain/extension.js"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
  setupDiscoveredExtensions,
  validateLoadedExtensions,
} from "../../src/runtime/extensions/activation"
import { defineResource, defineScheduledJob } from "@gent/core-internal/domain/contribution"
import type { ExtensionContributions } from "@gent/core-internal/domain/contribution"
import { tool } from "@gent/core/extensions/api"
import { GentToolMetadataTag, getToolMetadata } from "@gent/core-internal/domain/capability/tool"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import type { PromptSection } from "@gent/core-internal/domain/prompt"

const fsLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  BunGentPlatformLive,
)

const makeBuiltin = (
  id: string,
  setup: () => Effect.Effect<ExtensionContributions, ExtensionLoadError>,
): GentExtension => ({
  manifest: { id: ExtensionId.make(id) },
  setup: () => setup(),
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
      const good = makeBuiltin("good-ext", () =>
        Effect.succeed({
          tools: [
            tool({
              id: "good_tool",
              description: "good",
              params: {} as never,
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
        }),
      )
      const bad = makeBuiltin("bad-ext", () =>
        Effect.sync(() => {
          throw new Error("setup boom")
        }),
      )

      const result = yield* setupBuiltinExtensions({
        extensions: [good, bad],
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

  it.live("discovered setup failure is isolated instead of crashing activation", () =>
    Effect.gen(function* () {
      const result = yield* setupDiscoveredExtensions({
        extensions: [
          {
            extension: makeBuiltin("good-ext", () => Effect.succeed({})),
            scope: "user",
            sourcePath: "/tmp/good.ts",
          },
          {
            extension: makeBuiltin("bad-ext", () =>
              Effect.sync(() => {
                throw new Error("setup boom")
              }),
            ),
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
                params: {} as never,
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
                params: {} as never,
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
                params: {} as never,
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
  const rawToolLeaf = (id: string, description: string | undefined): never =>
    tool({
      id,
      description: description ?? "",
      params: Schema.Unknown,
      output: Schema.Void,
      execute: () => Effect.void,
    }) as never

  const rawNativeToolLeaf = (id: string): never =>
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
    return AiTool.dynamic(id, {
      description: "native with copied Gent metadata but no private brand",
      parameters: Schema.Unknown,
    }).annotate(GentToolMetadataTag, getToolMetadata(legit)) as never
  }

  const rawRpcLeaf = (id: string): never =>
    ({
      id,
      intent: "read",
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
              params: {} as never,
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
        makeLoaded("missing-desc", { tools: [rawToolLeaf("describeless", undefined)] }),
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

  it.scopedLive("reconciler owns startup and scheduler degradation in one result", () =>
    narrowR(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()

        const result = yield* reconcileLoadedExtensions({
          extensions: [
            makeLoaded("healthy-ext", {
              tools: [
                tool({
                  id: "healthy_tool",
                  description: "healthy",
                  params: {} as never,
                  output: Schema.Void,
                  execute: () => Effect.void,
                }),
              ],
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                }) as never,
              ],
              scheduledJobs: [
                defineScheduledJob({
                  id: "reflect",
                  cron: "0 21 * * 1-5",
                  target: {
                    agent: "memory:reflect" as never,
                    prompt: "Reflect.",
                  },
                }),
              ],
            }),
          ],
          failedExtensions: [
            {
              manifest: { id: ExtensionId.make("broken-setup") },
              scope: "user",
              sourcePath: "/tmp/broken.ts",
              phase: "setup",
              error: "setup boom",
            },
          ],
          home,
          command: ["/usr/local/bin/gent"],
          env: { HOME: home },
          schedulerRuntime: {
            install: (_entryPath, _schedule, name) =>
              name.includes("reflect")
                ? Effect.fail(new Error("cron install boom") as never)
                : Effect.void,
            remove: () => Effect.void,
          },
        })

        expect(result.resolved.extensions.map((ext) => ext.manifest.id)).toEqual([
          ExtensionId.make("healthy-ext"),
        ])
        expect(result.resolved.modelCapabilities.size).toBe(1)
        expect(result.resolved.failedExtensions).toEqual([
          {
            manifest: { id: ExtensionId.make("broken-setup") },
            scope: "user",
            sourcePath: "/tmp/broken.ts",
            phase: "setup",
            error: "setup boom",
          },
        ])
        expect(result.scheduledJobFailures).toHaveLength(1)
        expect(result.scheduledJobFailures[0]).toMatchObject({
          extensionId: ExtensionId.make("healthy-ext"),
          jobId: "reflect",
        })
        expect(result.scheduledJobFailures[0]?.error).toContain("cron install boom")
        expect(result.resolved.extensionStatuses).toEqual([
          {
            manifest: { id: ExtensionId.make("healthy-ext") },
            scope: "builtin",
            sourcePath: "builtin",
            status: "active",
            scheduledJobFailures: [{ jobId: "reflect", error: "Error: cron install boom" }],
          },
          {
            manifest: { id: ExtensionId.make("broken-setup") },
            scope: "user",
            sourcePath: "/tmp/broken.ts",
            phase: "setup",
            error: "setup boom",
            status: "failed",
          },
        ])
      }).pipe(Effect.provide(fsLayer)),
    ),
  )

  it.scopedLive("resource startup failure deactivates only the owning extension", () =>
    narrowR(
      Effect.gen(function* () {
        const healthy = makeLoaded("healthy-ext", {
          tools: [
            tool({
              id: "healthy_tool",
              description: "healthy",
              params: {} as never,
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
          resources: [
            defineResource({
              scope: "process",
              layer: Layer.empty as Layer.Layer<unknown>,
              start: Effect.void,
            }) as never,
          ],
        })
        const broken = makeLoaded("broken-resource", {
          tools: [
            tool({
              id: "broken_tool",
              description: "broken",
              params: {} as never,
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
          resources: [
            defineResource({
              scope: "process",
              layer: Layer.empty as Layer.Layer<unknown>,
              start: Effect.fail(new Error("resource start boom") as never),
            }) as never,
          ],
        })

        const result = yield* reconcileLoadedExtensions({
          extensions: [healthy, broken],
          home: "/tmp",
          command: undefined,
        })

        expect(result.resolved.extensions.map((ext) => ext.manifest.id)).toEqual([
          ExtensionId.make("healthy-ext"),
        ])
        expect(result.resolved.failedExtensions).toHaveLength(1)
        expect(result.resolved.failedExtensions[0]).toMatchObject({
          manifest: { id: ExtensionId.make("broken-resource") },
          phase: "startup",
        })
        expect(result.resolved.failedExtensions[0]?.error).toContain("resource start boom")
        expect([...result.resolved.modelCapabilities.keys()]).toEqual(["healthy_tool"])
      }),
    ),
  )
})
