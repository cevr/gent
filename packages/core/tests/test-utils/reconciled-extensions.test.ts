import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { tool } from "@gent/core/extensions/api"
import { testExtensionRegistryLayer } from "@gent/core-internal/test-utils/reconciled-extensions"
import { ExtensionId } from "@gent/core-internal/domain/ids"

describe("reconcileTestExtensions", () => {
  it.live("degrades same-scope collisions before building helper registries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          testExtensionRegistryLayer([
            {
              manifest: { id: ExtensionId.make("ext-a") },
              scope: "builtin",
              sourcePath: "test-a",
              contributions: {
                tools: [
                  tool({
                    id: "conflict",
                    description: "tool a",
                    params: {} as never,
                    output: Schema.Void,
                    execute: () => undefined as never,
                  }),
                ],
              },
            },
            {
              manifest: { id: ExtensionId.make("ext-b") },
              scope: "builtin",
              sourcePath: "test-b",
              contributions: {
                tools: [
                  tool({
                    id: "conflict",
                    description: "tool b",
                    params: {} as never,
                    output: Schema.Void,
                    execute: () => undefined as never,
                  }),
                ],
              },
            },
          ]),
        )

        const registry = yield* Effect.service(ExtensionRegistry).pipe(Effect.provide(context))
        const tools = yield* registry.listModelCapabilities()
        const failed = registry.getResolved().failedExtensions

        expect(tools).toEqual([])
        expect(failed.map((failure) => failure.manifest.id).sort()).toEqual([
          ExtensionId.make("ext-a"),
          ExtensionId.make("ext-b"),
        ])
        expect(failed.every((failure) => failure.phase === "validation")).toBe(true)
      }),
    ),
  )
})
