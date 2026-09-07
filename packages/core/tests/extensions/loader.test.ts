import { describe, it, expect } from "effect-bun-test"
import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { Cause, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { LoadedArtifactIdentity } from "../../src/domain/extension.js"
import type { GentExtension } from "../../src/domain/extension.js"
import { ExtensionSetupContext } from "../../src/domain/extension-setup-context.js"
import { discoverExtensions, setupExtension } from "../../src/runtime/extensions/loader"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { ProcessRunnerLive } from "../../src/utils/run-process"

const childProcessSpawnerLive = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
)

const fsLayer = Layer.provideMerge(
  Layer.mergeAll(BunFileSystem.layer, Path.layer, ProcessRunnerLive, BunGentPlatformLive),
  childProcessSpawnerLive,
)

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("setupExtension", () => {
  it.scopedLive("requires user trust before project module code runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: path.resolve(import.meta.dir, "../../.."),
        prefix: ".tmp-project-trust-",
      })
      const userDir = path.join(directory, "home/.gent/extensions")
      const projectDir = path.join(directory, "project/.gent/extensions")
      yield* fs.makeDirectory(userDir, { recursive: true })
      yield* fs.makeDirectory(projectDir, { recursive: true })
      const projectRoot = yield* fs.realPath(path.join(directory, "project"))
      const marker = path.join(directory, "import-ran")
      yield* fs.writeFileString(
        path.join(projectDir, "entry.ts"),
        `import { writeFileSync } from "node:fs";
import { Effect } from "effect";
writeFileSync(${encodeJson(marker)}, "ran");
export default { manifest: { id: "trusted-project" }, setup: Effect.succeed({}) };`,
      )
      const grant = encodeJson({ trustedProjects: [projectRoot] })
      yield* fs.writeFileString(path.join(projectDir, "../config.json"), grant)
      const denied = yield* discoverExtensions({ userDir, projectDir })
      expect(denied.loaded).toHaveLength(0)
      expect(denied.skipped[0]?.error).toContain("not trusted")
      expect(yield* fs.exists(marker)).toBe(false)
      yield* fs.writeFileString(path.join(userDir, "../config.json"), grant)
      const allowed = yield* discoverExtensions({ userDir, projectDir })
      expect(allowed.loaded.map((entry) => entry.extension.manifest.id)).toEqual([
        ExtensionId.make("trusted-project"),
      ])
      expect(yield* fs.readFileString(marker)).toBe("ran")
      yield* fs.writeFileString(path.join(userDir, "../config.json"), "invalid JSON")
      const revoked = yield* discoverExtensions({ userDir, projectDir })
      expect(revoked.loaded).toHaveLength(0)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("preserves the explicit loaded artifact identity", () =>
    Effect.gen(function* () {
      const artifactIdentity = LoadedArtifactIdentity.make("@gent/test-loader@artifact-1")
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-loader-artifact") },
        artifactIdentity,
        setup: Effect.succeed({}),
      }

      const loaded = yield* setupExtension(
        {
          extension,
          scope: "user",
          sourcePath: "/tmp/test-loader-artifact.ts",
        },
        "/tmp/project",
        "/tmp/home",
      )

      expect(loaded.artifactIdentity).toBe(artifactIdentity)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("seals runtime-loaded setup failures to ExtensionLoadError", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- This malformed runtime setup is a boundary rejection fixture.
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

  it.scopedLive("does not infer identity from mutable package metadata or cached modules", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repositoryRoot = path.resolve(import.meta.dir, "../../..")
      const packageDir = yield* fs.makeTempDirectoryScoped({
        directory: repositoryRoot,
        prefix: ".tmp-loader-package-",
      })
      yield* fs.writeFileString(
        path.join(packageDir, "package.json"),
        encodeJson({ name: "@gent/test-pinned", version: "1.2.3" }),
      )
      const extensionPath = path.join(packageDir, "extension.ts")
      yield* fs.writeFileString(
        extensionPath,
        'import { Effect } from "effect"\nexport default { manifest: { id: "@gent/test-pinned-v1" }, setup: Effect.succeed({}) }\n',
      )

      const first = yield* discoverExtensions({
        userDir: packageDir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })
      expect(first.loaded).toHaveLength(1)
      expect(first.loaded[0]?.extension.artifactIdentity).toBeUndefined()

      // The module path remains cached even though the source file changes.
      // The loader must not attach a new identity to the old export.
      yield* fs.writeFileString(
        extensionPath,
        'import { Effect } from "effect"\nexport default { manifest: { id: "@gent/test-pinned-v2" }, setup: Effect.succeed({}) }\n',
      )
      const second = yield* discoverExtensions({
        userDir: packageDir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })
      expect(second.loaded[0]?.extension.artifactIdentity).toBeUndefined()

      // A changed manifest is also not a proof that the already imported
      // module changed. Replay remains explicitly unsupported.
      yield* fs.writeFileString(
        path.join(packageDir, "package.json"),
        encodeJson({ name: "@gent/test-pinned", version: "2.0.0" }),
      )
      const third = yield* discoverExtensions({
        userDir: packageDir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })
      expect(third.loaded[0]?.extension.artifactIdentity).toBeUndefined()
    }).pipe(Effect.provide(fsLayer)),
  )

  // Blocking advisory: raw hand-rolled `{ manifest, setup }` (no `defineExtension`)
  // must yield the setup Tag to read context. There is no ctx-as-param escape.
  it.live("raw hand-rolled setup yields ExtensionSetupContext Tag to read narrowed shape", () =>
    Effect.gen(function* () {
      const captured = yield* Effect.sync(() => ({
        cwd: "",
        source: "",
        home: "",
        hasReadAuthority: false,
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
