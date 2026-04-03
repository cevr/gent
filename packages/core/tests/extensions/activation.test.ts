import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import type {
  ExtensionLoadError,
  ExtensionSetup,
  GentExtension,
  LoadedExtension,
} from "@gent/core/domain/extension"
import {
  activateLoadedExtensions,
  setupBuiltinExtensions,
  validateLoadedExtensions,
} from "@gent/core/runtime/extensions/activation"
import { ExtensionRegistry } from "@gent/core/runtime/extensions/registry"

const makeBuiltin = (
  id: string,
  setup: () => Effect.Effect<ExtensionSetup, ExtensionLoadError>,
): GentExtension => ({
  manifest: { id },
  setup: () => setup(),
})

const makeLoaded = (id: string, setup: ExtensionSetup): LoadedExtension => ({
  manifest: { id },
  kind: "builtin",
  sourcePath: "builtin",
  setup,
})

describe("extension activation isolation", () => {
  it.live("builtin setup failure is isolated instead of crashing activation", () =>
    Effect.gen(function* () {
      const good = makeBuiltin("good-ext", () =>
        Effect.succeed({
          tools: [
            {
              name: "good_tool",
              action: "read",
              description: "good",
              params: {} as never,
              execute: () => Effect.void,
            },
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
    }),
  )

  it.live(
    "validation collisions fail the conflicting extensions instead of crashing host activation",
    () =>
      Effect.gen(function* () {
        const result = yield* validateLoadedExtensions([
          makeLoaded("healthy-ext", {
            tools: [
              {
                name: "healthy_tool",
                action: "read",
                description: "healthy",
                params: {} as never,
                execute: () => Effect.void,
              },
            ],
          }),
          makeLoaded("collider-a", {
            tools: [
              {
                name: "shared_tool",
                action: "read",
                description: "a",
                params: {} as never,
                execute: () => Effect.void,
              },
            ],
          }),
          makeLoaded("collider-b", {
            tools: [
              {
                name: "shared_tool",
                action: "read",
                description: "b",
                params: {} as never,
                execute: () => Effect.void,
              },
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

  it.live("startup failure is isolated and exposed through registry diagnostics", () =>
    Effect.gen(function* () {
      return yield* activateLoadedExtensions([
        makeLoaded("healthy-ext", {
          tools: [
            {
              name: "healthy_tool",
              action: "read",
              description: "healthy",
              params: {} as never,
              execute: () => Effect.void,
            },
          ],
        }),
        makeLoaded("failing-ext", {
          tools: [
            {
              name: "failing_tool",
              action: "read",
              description: "failing",
              params: {} as never,
              execute: () => Effect.void,
            },
          ],
          onStartup: Effect.sync(() => {
            throw new Error("startup boom")
          }),
        }),
      ])
    }).pipe(
      Effect.flatMap((result) =>
        Effect.gen(function* () {
          const registry = yield* ExtensionRegistry
          const tools = yield* registry.listTools()
          const failed = yield* registry.listFailedExtensions()

          expect(tools.map((tool) => tool.name)).toEqual(["healthy_tool"])
          expect(failed).toHaveLength(1)
          expect(failed[0]!.manifest.id).toBe("failing-ext")
          expect(failed[0]!.phase).toBe("startup")
          expect(failed[0]!.error).toContain("startup boom")
        }).pipe(Effect.provide(ExtensionRegistry.LiveWithFailures(result.active, result.failed))),
      ),
    ),
  )
})
