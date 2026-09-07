import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, Layer, Schema } from "effect"
import { ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { defineExtension, defineResource, tool } from "@gent/core/extensions/api"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { createToolTestLayer } from "../../src/test-utils/extension-harness"

class ResourceInstance extends Context.Service<ResourceInstance, { readonly id: number }>()(
  "@gent/core/tests/test-utils/extension-tool-layer.test/ResourceInstance",
) {}

describe("extension tool test layer", () => {
  it.live("uses the started resource instance and releases it once", () =>
    Effect.gen(function* () {
      let acquired = 0
      let released = 0
      let started = 0
      const extension = defineExtension({
        id: "resource-instance",
        resources: [
          defineResource({
            id: "test/resource-instance",
            scope: "process",
            tag: ResourceInstance,
            layer: Layer.effect(
              ResourceInstance,
              Effect.acquireRelease(
                Effect.sync(() => ({ id: ++acquired })),
                () =>
                  Effect.sync(() => {
                    released++
                  }),
              ),
            ),
            start: Effect.gen(function* () {
              started = (yield* ResourceInstance).id
            }),
          }),
        ],
      })
      yield* Effect.gen(function* () {
        const instance = yield* ResourceInstance
        expect(instance.id).toBe(started)
        expect(acquired).toBe(1)
        expect(released).toBe(0)
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- The nested scope is the test boundary whose cleanup is under test.
        Effect.provide(createToolTestLayer({ agents: [], extensions: [extension] })),
        Effect.scoped,
      )
      expect(released).toBe(1)
    }),
  )

  it.scopedLive("excludes both extensions when tools collide in the same scope", () =>
    Effect.gen(function* () {
      const registry = yield* ExtensionRegistry
      const resolved = registry.getResolved()
      expect([...resolved.modelCapabilities.values()]).toEqual([])
      expect(resolved.failedExtensions.map((failure) => failure.manifest.id).sort()).toEqual([
        ExtensionId.make("ext-a"),
        ExtensionId.make("ext-b"),
      ])
      expect(resolved.failedExtensions.every((failure) => failure.phase === "validation")).toBe(
        true,
      )
    }).pipe(
      Effect.provide(
        createToolTestLayer({
          agents: [],
          extensions: ["ext-a", "ext-b"].map((id) =>
            defineExtension({
              id,
              tools: [
                tool({
                  id: "conflict",
                  description: id,
                  params: Schema.Struct({}),
                  output: Schema.Void,
                  execute: () => Effect.void,
                }),
              ],
            }),
          ),
        }),
      ),
    ),
  )
})
