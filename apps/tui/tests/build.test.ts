import { BunServices } from "@effect/platform-bun"
import { runProcess } from "@gent/core/extensions/api"
import { GentReleaseFacts } from "@gent/core/host"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Logger, Path, References, Schema } from "effect"
import { buildRelease } from "../scripts/build"

const decodeDefine = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      release: Schema.optionalKey(GentReleaseFacts),
    }),
  ),
)

const git = (cwd: string, args: ReadonlyArray<string>) =>
  runProcess("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], {
    cwd,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    extendEnv: true,
  }).pipe(
    Effect.map(({ exitCode, stdout, stderr }) => {
      expect(exitCode, stderr).toBe(0)
      return stdout.trim()
    }),
  )

const TurboBuild = Schema.fromJsonString(
  Schema.Struct({
    tasks: Schema.Record(
      Schema.String,
      Schema.Struct({
        cache: Schema.optionalKey(Schema.Boolean),
        dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  }),
)

const RootBuild = Schema.fromJsonString(
  Schema.Struct({
    packageManager: Schema.String,
    scripts: Schema.Record(Schema.String, Schema.String),
  }),
)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("build release", () => {
  it.scopedLive("the task that embeds the checkout release never replays a cached build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../..", import.meta.url))
      const config = yield* fs
        .readFileString(path.join(root, "turbo.json"))
        .pipe(Effect.flatMap(Schema.decodeEffect(TurboBuild)))
      expect(config.tasks["@gent/tui#build"]?.cache).toBe(false)
      expect(config.tasks["@gent/tui#build"]?.dependsOn).toContain("^build")
      expect(config.tasks["install:global"]?.cache).toBe(false)
      expect(config.tasks["test:e2e"]?.cache).toBe(false)
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live(
    "root builds recapture the release after a commit outside the TUI sources",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* path.fromFileUrl(new URL("../../..", import.meta.url))
        const directory = yield* makeTempDirectoryScoped("gent-build-commit-")
        const manifest = yield* fs
          .readFileString(path.join(root, "package.json"))
          .pipe(Effect.flatMap(Schema.decodeEffect(RootBuild)))
        yield* fs.makeDirectory(path.join(directory, "apps/tui/scripts"), { recursive: true })
        yield* fs.writeFileString(
          path.join(directory, "package.json"),
          encodeJson({
            name: "gent-build-fixture",
            private: true,
            packageManager: manifest.packageManager,
            workspaces: ["apps/*"],
            scripts: { build: manifest.scripts["build"] },
          }),
        )
        yield* fs.writeFileString(
          path.join(directory, "apps/tui/package.json"),
          encodeJson({ name: "@gent/tui", scripts: { build: "bun scripts/build.ts" } }),
        )
        yield* fs.copyFile(path.join(root, "turbo.json"), path.join(directory, "turbo.json"))
        yield* fs.copyFile(
          path.join(root, "apps/tui/turbo.json"),
          path.join(directory, "apps/tui/turbo.json"),
        )
        // Keep real turbo, git and the production release step; only the compiler
        // is outside this fixture's boundary. The separate build step test pins the define.
        yield* fs.writeFileString(
          path.join(directory, "apps/tui/scripts/build.ts"),
          [
            'import { BunRuntime, BunServices } from "@effect/platform-bun"',
            'import { Effect } from "effect"',
            `import { buildRelease } from ${encodeJson(path.join(root, "apps/tui/scripts/build.ts"))}`,
            'BunRuntime.runMain(buildRelease(import.meta.dir + "/..", { id: "fixture", version: "0.0.0" }).pipe(Effect.provide(BunServices.layer)))',
          ].join("\n"),
        )
        yield* fs.writeFileString(
          path.join(directory, ".gitignore"),
          "node_modules/\n.turbo/\n**/.turbo/\napps/tui/bin/\n",
        )
        yield* fs.symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"))
        yield* git(directory, ["init", "-q"])
        yield* git(directory, ["add", "."])
        yield* git(directory, ["commit", "-q", "--no-verify", "-m", "fixture"])
        const first = yield* git(directory, ["rev-parse", "HEAD"])
        const build = () =>
          runProcess("bun", ["run", "build", "--cache-dir=.turbo/cache", "--ui=stream"], {
            cwd: directory,
            env: { TURBO_TELEMETRY_DISABLED: "1", NO_COLOR: "1" },
            extendEnv: true,
          }).pipe(Effect.timeout("20 seconds"))
        const before = yield* build()
        expect(before.exitCode, before.stderr).toBe(0)
        expect(before.stdout + before.stderr).toContain(`Release: ${first} clean`)
        yield* fs.writeFileString(
          path.join(directory, "README.md"),
          "A change outside TUI source.\n",
        )
        yield* git(directory, ["add", "README.md"])
        yield* git(directory, ["commit", "-q", "--no-verify", "-m", "docs: advance checkout"])
        const second = yield* git(directory, ["rev-parse", "HEAD"])
        expect(second).not.toBe(first)
        const after = yield* build()
        expect(after.exitCode, after.stderr).toBe(0)
        expect(after.stdout + after.stderr).toContain(`Release: ${second} clean`)
        expect(after.stdout + after.stderr).not.toContain(`Release: ${first} clean`)
        expect(yield* git(directory, ["status", "--porcelain=v1"])).toBe("")
      }).pipe(Effect.scoped, Effect.timeout("50 seconds"), Effect.provide(BunServices.layer)),
    55_000,
  )

  it.live(
    "clean, tracked, untracked and ignored checkouts print and embed the same clean flag",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        for (const fixture of [
          { name: "clean", file: "", clean: true, label: "clean" },
          { name: "tracked", file: "source.ts", clean: false, label: "dirty" },
          { name: "untracked", file: "new.ts", clean: false, label: "dirty" },
          { name: "ignored", file: "cache/generated.ts", clean: true, label: "clean" },
        ]) {
          const directory = yield* makeTempDirectoryScoped(`gent-build-${fixture.name}-`)
          yield* fs.writeFileString(`${directory}/.gitignore`, "cache/\n")
          yield* fs.writeFileString(`${directory}/source.ts`, "export const value = 1\n")
          yield* git(directory, ["init", "-q"])
          yield* git(directory, ["add", ".gitignore", "source.ts"])
          yield* git(directory, ["commit", "-q", "--no-verify", "-m", "fixture"])
          const commit = yield* git(directory, ["rev-parse", "HEAD"])
          if (fixture.file.length > 0) {
            yield* fs.makeDirectory(`${directory}/cache`, { recursive: true })
            yield* fs.writeFileString(`${directory}/${fixture.file}`, "export const value = 2\n")
          }
          const lines: Array<string> = []
          const logger = Logger.make(({ message }) => {
            lines.push(String(message))
          })
          const { define } = yield* buildRelease(directory, {
            id: "fixture-build",
            version: "0.0.0",
          }).pipe(
            Effect.provide(
              Layer.merge(
                Logger.layer([logger]),
                Layer.succeed(References.MinimumLogLevel, "Info"),
              ),
            ),
          )
          expect(decodeDefine(define), fixture.name).toEqual({
            id: "fixture-build",
            version: "0.0.0",
            release: {
              commit,
              clean: fixture.clean,
              checkout: yield* fs.realPath(directory),
            },
          })
          expect(lines, fixture.name).toEqual([`Release: ${commit} ${fixture.label}`])
        }
      }).pipe(Effect.scoped, Effect.timeout("15 seconds"), Effect.provide(BunServices.layer)),
    20_000,
  )
})
