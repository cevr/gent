import { describe, it, expect } from "effect-bun-test"
import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { Effect, Layer, Path } from "effect"
import type { GentExtension } from "../../src/domain/extension.js"
import { setupExtension } from "@gent/core/runtime/extensions/loader"

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
})
