import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import { ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { tool } from "@gent/core/extensions/api"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import type { FailedExtension, LoadedExtension } from "@gent/core-internal/domain/extension"
import { reconcileLoadedExtensions } from "@gent/core-internal/runtime/extensions/activation"
import { DriverRegistry } from "@gent/core-internal/runtime/extensions/driver-registry"

const testExtensionRegistryLayer = (
  extensions: ReadonlyArray<LoadedExtension>,
  failedExtensions: ReadonlyArray<FailedExtension> = [],
  home = "/tmp",
) =>
  Layer.unwrap(
    reconcileLoadedExtensions({
      extensions,
      failedExtensions,
      home,
      // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
      command: undefined,
    }).pipe(
      Effect.map((result) => result.resolved),
      Effect.map((resolved) =>
        Layer.merge(
          ExtensionRegistry.fromResolved(resolved),
          DriverRegistry.fromResolved({
            modelDrivers: resolved.modelDrivers,
            externalDrivers: resolved.externalDrivers,
          }),
        ),
      ),
    ),
  ).pipe(Layer.provide(BunServices.layer))

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
                    params: Schema.Struct({}),
                    output: Schema.Void,
                    execute: () => Effect.void,
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
                    params: Schema.Struct({}),
                    output: Schema.Void,
                    execute: () => Effect.void,
                  }),
                ],
              },
            },
          ]),
        )

        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        const registry = yield* Effect.service(ExtensionRegistry).pipe(Effect.provide(context))
        const tools = [...registry.getResolved().modelCapabilities.values()]
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
