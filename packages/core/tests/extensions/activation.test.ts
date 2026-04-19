import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Path, Schema } from "effect"
import * as Fs from "node:fs"
import * as NodePath from "node:path"
import * as Os from "node:os"
import type {
  ExtensionLoadError,
  GentExtension,
  LoadedExtension,
} from "@gent/core/domain/extension"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
  setupDiscoveredExtensions,
  validateLoadedExtensions,
} from "@gent/core/runtime/extensions/activation"
import { defineResource, tool } from "@gent/core/domain/contribution"
import type { ExtensionContributions } from "@gent/core/domain/contribution"

const fsLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
)

const makeBuiltin = (
  id: string,
  setup: () => Effect.Effect<ExtensionContributions, ExtensionLoadError>,
): GentExtension => ({
  manifest: { id },
  setup: () => setup(),
})

const makeLoaded = (id: string, contributions: ExtensionContributions): LoadedExtension => ({
  manifest: { id },
  kind: "builtin",
  sourcePath: "builtin",
  contributions,
})

describe("extension activation isolation", () => {
  it.live("builtin setup failure is isolated instead of crashing activation", () =>
    Effect.gen(function* () {
      const good = makeBuiltin("good-ext", () =>
        Effect.succeed({
          capabilities: [
            tool({
              name: "good_tool",
              description: "good",
              params: {} as never,
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

      expect(result.active.map((ext) => ext.manifest.id)).toEqual(["good-ext"])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]!.manifest.id).toBe("bad-ext")
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
            kind: "user",
            sourcePath: "/tmp/good.ts",
          },
          {
            extension: makeBuiltin("bad-ext", () =>
              Effect.sync(() => {
                throw new Error("setup boom")
              }),
            ),
            kind: "project",
            sourcePath: "/tmp/bad.ts",
          },
        ],
        cwd: "/tmp",
        home: "/tmp",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual(["good-ext"])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]).toMatchObject({
        manifest: { id: "bad-ext" },
        kind: "project",
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
            capabilities: [
              tool({
                name: "healthy_tool",
                description: "healthy",
                params: {} as never,
                execute: () => Effect.void,
              }),
            ],
          }),
          makeLoaded("collider-a", {
            capabilities: [
              tool({
                name: "shared_tool",
                description: "a",
                params: {} as never,
                execute: () => Effect.void,
              }),
            ],
          }),
          makeLoaded("collider-b", {
            capabilities: [
              tool({
                name: "shared_tool",
                description: "b",
                params: {} as never,
                execute: () => Effect.void,
              }),
            ],
          }),
        ])

        expect(result.active.map((ext) => ext.manifest.id)).toEqual(["healthy-ext"])
        expect(result.failed).toHaveLength(2)
        expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
          "collider-a",
          "collider-b",
        ])
        expect(result.failed.every((ext) => ext.phase === "validation")).toBe(true)
        expect(result.failed.every((ext) => ext.error.includes("shared_tool"))).toBe(true)
      }),
  )

  // C4.4 BLOCK: validation must catch capability/capability AND tool/capability
  // collisions in addition to tool/tool. After the C4.4 tool bridge, a
  // capability with `audiences:["model"]` becomes a tool by `cap.id` — the
  // resolver overwrites silently in last-write-wins order without this check.

  it.live("validation catches same-scope capability/capability tool-name collision", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("collider-a", {
          capabilities: [
            {
              id: "shared_cap",
              description: "a",
              audiences: ["model"],
              intent: "write",
              input: Schema.Unknown,
              output: Schema.Unknown,
              effect: () => Effect.succeed(undefined),
            },
          ],
        }),
        makeLoaded("collider-b", {
          capabilities: [
            {
              id: "shared_cap",
              description: "b",
              audiences: ["model"],
              intent: "write",
              input: Schema.Unknown,
              output: Schema.Unknown,
              effect: () => Effect.succeed(undefined),
            },
          ],
        }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
        "collider-a",
        "collider-b",
      ])
      expect(result.failed.every((ext) => ext.error.includes("shared_cap"))).toBe(true)
    }),
  )

  it.live("validation catches same-scope tool/capability tool-name collision", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("legacy-tool", {
          capabilities: [
            tool({
              name: "shared_name",
              description: "legacy",
              params: {} as never,
              execute: () => Effect.void,
            }),
          ],
        }),
        makeLoaded("capability-tool", {
          capabilities: [
            {
              id: "shared_name",
              description: "capability",
              audiences: ["model"],
              intent: "write",
              input: Schema.Unknown,
              output: Schema.Unknown,
              effect: () => Effect.succeed(undefined),
            },
          ],
        }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
        "capability-tool",
        "legacy-tool",
      ])
    }),
  )

  it.live("validation does NOT collide capability(non-model) with same-name tool", () =>
    Effect.gen(function* () {
      // A capability that doesn't surface as a tool (no `model` audience)
      // must NOT trigger a "tool" collision against a same-name legacy tool.
      // The tool list is "things audience-authorized as model"; cross-audience
      // sharing of an id is fine.
      const result = yield* validateLoadedExtensions([
        makeLoaded("legacy-tool", {
          capabilities: [
            tool({
              name: "shared_name",
              description: "legacy",
              params: {} as never,
              execute: () => Effect.void,
            }),
          ],
        }),
        makeLoaded("rpc-only", {
          capabilities: [
            {
              id: "shared_name",
              audiences: ["agent-protocol"],
              intent: "read",
              input: Schema.Unknown,
              output: Schema.Unknown,
              effect: () => Effect.succeed(undefined),
            },
          ],
        }),
      ])

      expect(result.active.map((ext) => ext.manifest.id).sort()).toEqual([
        "legacy-tool",
        "rpc-only",
      ])
      expect(result.failed).toEqual([])
    }),
  )

  it.live("validation rejects model-audience capability with empty description", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("missing-desc", {
          capabilities: [
            {
              id: "describeless",
              audiences: ["model"],
              intent: "write",
              input: Schema.Unknown,
              output: Schema.Unknown,
              effect: () => Effect.succeed(undefined),
            },
          ],
        }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe("missing-desc")
      expect(result.failed[0]?.error).toContain("describeless")
      expect(result.failed[0]?.error).toContain("description")
    }),
  )

  it.live("validation rejects model-audience capability with whitespace-only description", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("blank-desc", {
          capabilities: [
            {
              id: "blanky",
              description: "   \t\n",
              audiences: ["model"],
              intent: "write",
              input: Schema.Unknown,
              output: Schema.Unknown,
              effect: () => Effect.succeed(undefined),
            },
          ],
        }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe("blank-desc")
    }),
  )

  it.live("validation accepts non-model capability without description", () =>
    Effect.gen(function* () {
      // Non-model capabilities don't ship to the LLM, so empty description
      // is fine (the field is optional). Only `audiences:["model"]` requires.
      const result = yield* validateLoadedExtensions([
        makeLoaded("rpc-no-desc", {
          capabilities: [
            {
              id: "internal",
              audiences: ["agent-protocol"],
              intent: "read",
              input: Schema.Unknown,
              output: Schema.Unknown,
              effect: () => Effect.succeed(undefined),
            },
          ],
        }),
      ])

      expect(result.active.map((ext) => ext.manifest.id)).toEqual(["rpc-no-desc"])
      expect(result.failed).toEqual([])
    }),
  )

  it.live("reconciler owns startup and scheduler degradation in one result", () =>
    Effect.gen(function* () {
      const home = Fs.mkdtempSync(NodePath.join(Os.tmpdir(), "gent-reconcile-"))

      const result = yield* reconcileLoadedExtensions({
        extensions: [
          makeLoaded("healthy-ext", {
            capabilities: [
              tool({
                name: "healthy_tool",
                description: "healthy",
                params: {} as never,
                execute: () => Effect.void,
              }),
            ],
            resources: [
              defineResource({
                scope: "process",
                layer: Layer.empty,
                schedule: [
                  {
                    id: "reflect",
                    cron: "0 21 * * 1-5",
                    target: {
                      kind: "headless-agent",
                      agent: "memory:reflect" as never,
                      prompt: "Reflect.",
                    },
                  },
                ],
              }),
            ],
          }),
        ],
        failedExtensions: [
          {
            manifest: { id: "broken-setup" },
            kind: "user",
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

      expect(result.resolved.extensions.map((ext) => ext.manifest.id)).toEqual(["healthy-ext"])
      expect(result.resolved.tools.size).toBe(1)
      expect(result.resolved.failedExtensions).toEqual([
        {
          manifest: { id: "broken-setup" },
          kind: "user",
          sourcePath: "/tmp/broken.ts",
          phase: "setup",
          error: "setup boom",
        },
      ])
      expect(result.scheduledJobFailures).toHaveLength(1)
      expect(result.scheduledJobFailures[0]).toMatchObject({
        extensionId: "healthy-ext",
        jobId: "reflect",
      })
      expect(result.scheduledJobFailures[0]?.error).toContain("cron install boom")
      expect(result.resolved.extensionStatuses).toEqual([
        {
          manifest: { id: "healthy-ext" },
          kind: "builtin",
          sourcePath: "builtin",
          status: "active",
          scheduledJobFailures: [{ jobId: "reflect", error: "Error: cron install boom" }],
        },
        {
          manifest: { id: "broken-setup" },
          kind: "user",
          sourcePath: "/tmp/broken.ts",
          phase: "setup",
          error: "setup boom",
          status: "failed",
        },
      ])
    }).pipe(Effect.provide(fsLayer)),
  )
})
