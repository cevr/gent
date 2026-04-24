import { describe, it, expect } from "effect-bun-test"
import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { Effect, Layer, Path } from "effect"
import { defineResource } from "@gent/core/domain/contribution"
import type { GentExtension } from "../../src/domain/extension.js"
import { setupExtension } from "../../src/runtime/extensions/loader"
import { reducerActor } from "./helpers/reducer-actor"

const fsLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
)

describe("setupExtension", () => {
  it.live("seals runtime-loaded setup failures to ExtensionLoadError", () =>
    Effect.gen(function* () {
      const badSetup = (() => Effect.fail("boom")) as GentExtension["setup"]
      const extension: GentExtension = {
        manifest: { id: "@gent/test-loader" },
        setup: badSetup,
      }

      const exit = yield* Effect.exit(
        setupExtension(
          {
            extension,
            scope: "user",
            sourcePath: "/tmp/test-loader.ts",
          },
          "/tmp/project",
          "/tmp/home",
        ),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = JSON.stringify(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("Extension setup failed: boom")
      }
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("rejects raw-loaded extensions whose contributions violate package shape", () =>
    Effect.gen(function* () {
      // Raw `{ manifest, setup }` bypasses `defineExtension`, so the only
      // validation barrier is the loader's defensive `validatePackageShape`
      // call. Two `Resource.machine` entries is a cross-bucket violation —
      // without the defensive call this slips through and silently drops one.
      const rawSetup = (() =>
        Effect.succeed({
          resources: [
            defineResource({
              scope: "process",
              layer: Layer.empty as Layer.Layer<unknown>,
              machine: reducerActor({
                id: "first",
                initial: { n: 0 },
                reduce: (state) => ({ state }),
              }),
            }),
            defineResource({
              scope: "process",
              layer: Layer.empty as Layer.Layer<unknown>,
              machine: reducerActor({
                id: "second",
                initial: { n: 0 },
                reduce: (state) => ({ state }),
              }),
            }),
          ],
        })) as GentExtension["setup"]

      const extension: GentExtension = {
        manifest: { id: "@gent/test-raw" },
        setup: rawSetup,
      }

      const exit = yield* Effect.exit(
        setupExtension(
          {
            extension,
            scope: "user",
            sourcePath: "/tmp/test-raw.ts",
          },
          "/tmp/project",
          "/tmp/home",
        ),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = JSON.stringify(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("at most one Resource may declare")
      }
    }).pipe(Effect.provide(fsLayer)),
  )
})
