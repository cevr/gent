import { expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, it } from "effect-bun-test"
import { discoverTestPackages } from "../src/workspace-test-packages"

const REPO_ROOT = decodeURIComponent(new URL("../../..", import.meta.url).pathname).replace(
  /\/$/,
  "",
)

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const manifest = (name: string, scripts: Record<string, string>) =>
  encodeJson({ name, version: "0.0.0", private: true, scripts })

const makeFixtureRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-workspace-test-packages-" })
  const write = (relative: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, relative)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, relative), text)))

  yield* write("packages/fast/package.json", manifest("@fixture/fast", { test: "bun test" }))
  yield* write(
    "packages/slow/package.json",
    manifest("@fixture/slow", { "test:e2e": "bun test --timeout=30000" }),
  )
  yield* write("packages/silent/package.json", encodeJson({ name: "@fixture/silent" }))
  yield* write("packages/no-manifest/README.md", "no package.json here")
  yield* write("apps/app/package.json", manifest("@fixture/app", { test: "bun test" }))
  yield* write(
    "packages/nested/deep/package.json",
    manifest("@fixture/nested-deep", { test: "bun test" }),
  )
  return root
})

describe("workspace test package discovery", () => {
  it.scopedLive("keeps only the direct workspace packages that declare a test script", () =>
    Effect.gen(function* () {
      const root = yield* makeFixtureRoot
      const packages = yield* discoverTestPackages(root)
      expect(packages).toEqual([
        { name: "@fixture/fast", cwd: "packages/fast" },
        { name: "@fixture/app", cwd: "apps/app" },
      ])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("an absent workspace directory contributes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-workspace-empty-" })
      expect(yield* discoverTestPackages(root)).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live("the repo's own manifests select the fast suite and skip e2e and core-internal", () =>
    Effect.gen(function* () {
      const packages = yield* discoverTestPackages(REPO_ROOT)
      const names = packages.map((entry) => entry.name)
      expect(names).toEqual([
        "@gent/core",
        "@gent/extensions",
        "@gent/sdk",
        "@gent/tooling",
        "@gent/tui",
      ])
      expect(names).not.toContain("@gent/e2e")
      expect(names).not.toContain("@gent/core-internal")
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
