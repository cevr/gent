import { describe, it, expect } from "effect-bun-test"
import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { Cause, Effect, FileSystem, Layer, Path } from "effect"
import type { GentExtension } from "../../src/domain/extension.js"
import { ExtensionSetupContext } from "../../src/domain/extension-setup-context.js"
import { discoverExtensions, setupExtension } from "../../src/runtime/extensions/loader"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"

const fsLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  BunGentPlatformLive,
)

describe("setupExtension", () => {
  it.live("seals runtime-loaded setup failures to ExtensionLoadError", () =>
    Effect.gen(function* () {
      const badSetup = Effect.fail("boom") as unknown as GentExtension["setup"]
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-loader") },
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
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("Extension setup failed: boom")
      }
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("runtime-loaded setup receives host process facade", () =>
    Effect.gen(function* () {
      const sawProcessAuthority = yield* Effect.sync(() => ({ value: false }))
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-public-setup") },
        setup: Effect.gen(function* () {
          const ctx = yield* ExtensionSetupContext
          sawProcessAuthority.value =
            "runProcess" in ctx.Process && "parentEnv" in ctx.Process && "signalPid" in ctx.Process
          return {}
        }),
      }

      yield* setupExtension(
        {
          extension,
          scope: "project",
          sourcePath: "/tmp/test-public-setup.ts",
        },
        "/tmp/project",
        "/tmp/home",
      )

      expect(sawProcessAuthority.value).toBe(true)
    }).pipe(Effect.provide(fsLayer)),
  )

  // Blocking advisory: raw hand-rolled `{ manifest, setup }` (no `defineExtension`)
  // must yield the setup Tag to read context. There is no ctx-as-param escape.
  it.live("raw hand-rolled setup yields ExtensionSetupContext Tag to read narrowed shape", () =>
    Effect.gen(function* () {
      const captured = yield* Effect.sync(() => ({
        cwd: undefined as string | undefined,
        source: undefined as string | undefined,
        home: undefined as string | undefined,
        hasReadAuthority: false as boolean,
      }))
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-raw-setup") },
        setup: Effect.gen(function* () {
          const ctx = yield* ExtensionSetupContext
          captured.cwd = ctx.cwd
          captured.source = ctx.source
          captured.home = ctx.home
          captured.hasReadAuthority = "readFileString" in ctx.host || "writeFileString" in ctx.host
          return {}
        }),
      }

      yield* setupExtension(
        {
          extension,
          scope: "user",
          sourcePath: "/tmp/raw-setup.ts",
        },
        "/tmp/project-cwd",
        "/tmp/home-dir",
      )

      // Loader-built narrowed shape is observable from raw setup
      expect(captured.cwd).toBe("/tmp/project-cwd")
      expect(captured.source).toBe("/tmp/raw-setup.ts")
      expect(captured.home).toBe("/tmp/home-dir")
      // Public ctx.host strips read/write authority; only narrowed facts remain
      expect(captured.hasReadAuthority).toBe(false)
    }).pipe(Effect.provide(fsLayer)),
  )

  // Blocking advisory: malformed runtime-loaded modules whose `setup` is not
  // an Effect (e.g. a function, raw object, or `null`) must be rejected at
  // discovery — `loadExtensionFile`'s `isGentExtension` guard returns false
  // and the file is skipped rather than crashing later.
  it.scopedLive("malformed setup values that are not Effects are skipped at discovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-loader-test-" })

      const fnSetupPath = path.join(dir, "fn-setup.ts")
      const objectSetupPath = path.join(dir, "object-setup.ts")
      const nullSetupPath = path.join(dir, "null-setup.ts")
      const validPath = path.join(dir, "valid.ts")

      // `setup` as a thunk — old contract, must be rejected now.
      yield* fs.writeFileString(
        fnSetupPath,
        `export default { manifest: { id: "fn-setup" }, setup: () => ({ tools: [] }) }`,
      )
      // `setup` as a plain object — never valid.
      yield* fs.writeFileString(
        objectSetupPath,
        `export default { manifest: { id: "object-setup" }, setup: { tools: [] } }`,
      )
      // `setup` as null — never valid.
      yield* fs.writeFileString(
        nullSetupPath,
        `export default { manifest: { id: "null-setup" }, setup: null }`,
      )
      // Sanity sibling: a no-extension file is also skipped but for a different reason.
      yield* fs.writeFileString(validPath, `export const notAnExtension = 42`)

      const result = yield* discoverExtensions({
        userDir: dir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })

      // None of the malformed files load — they hit `loadExtensionFile`'s
      // `candidates.length === 0` branch via the `isGentExtension` guard.
      expect(result.loaded).toHaveLength(0)
      expect(result.skipped.length).toBeGreaterThanOrEqual(4)
      for (const target of [fnSetupPath, objectSetupPath, nullSetupPath, validPath]) {
        const entry = result.skipped.find((s) => s.path === target)
        expect(entry).toBeDefined()
        expect(entry?.error).toContain("No GentExtension found")
      }
    }).pipe(Effect.provide(fsLayer)),
  )
})
