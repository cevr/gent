import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { tool } from "@gent/core/extensions/api"
import { testExtensionRegistryLayer } from "@gent/core/test-utils/reconciled-extensions"

describe("reconcileTestExtensions", () => {
  it.live("degrades same-scope collisions before building helper registries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          testExtensionRegistryLayer([
            {
              manifest: { id: "ext-a" },
              kind: "builtin",
              sourcePath: "test-a",
              contributions: {
                capabilities: [
                  tool({
                    name: "conflict",
                    description: "tool a",
                    params: {} as never,
                    execute: () => undefined as never,
                  }),
                ],
              },
            },
            {
              manifest: { id: "ext-b" },
              kind: "builtin",
              sourcePath: "test-b",
              contributions: {
                capabilities: [
                  tool({
                    name: "conflict",
                    description: "tool b",
                    params: {} as never,
                    execute: () => undefined as never,
                  }),
                ],
              },
            },
          ]),
        )

        const registry = yield* Effect.service(ExtensionRegistry).pipe(Effect.provide(context))
        const tools = yield* registry.listTools()
        const failed = yield* registry.listFailedExtensions()

        expect(tools).toEqual([])
        expect(failed.map((failure) => failure.manifest.id).sort()).toEqual(["ext-a", "ext-b"])
        expect(failed.every((failure) => failure.phase === "validation")).toBe(true)
      }),
    ),
  )
})
