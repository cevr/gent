import { BunServices } from "@effect/platform-bun"
import { runProcess } from "@gent/core/extensions/api"
import { GentReleaseFacts } from "@gent/core/host"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Logger, References, Schema } from "effect"
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

describe("build release", () => {
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
