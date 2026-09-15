import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem } from "effect"
import { searchFiles } from "../src/utils/file-finder"

/**
 * The finder keeps its frecency and history databases where the caller says.
 * A build that memoizes the directory on the first call reuses it for every
 * later workspace, so the second directory here is never written.
 */
const finderTest = it.scopedLive.layer(BunServices.layer)

describe("file finder db dir", () => {
  finderTest("each search writes the db dir it was handed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const first = yield* fs.makeTempDirectoryScoped()
      const second = yield* fs.makeTempDirectoryScoped()
      const cwd = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${cwd}/alpha.ts`, "export const a = 1\n")

      const firstDbDir = `${first}/.gent/fff`
      const secondDbDir = `${second}/.gent/fff`
      yield* fs.makeDirectory(firstDbDir, { recursive: true })
      yield* fs.makeDirectory(secondDbDir, { recursive: true })

      // Distinct cwds: the finder cache is keyed by cwd, so each call builds
      // its own finder and has to honour the db dir passed with it.
      const secondCwd = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${secondCwd}/beta.ts`, "export const b = 2\n")

      yield* Effect.option(searchFiles(cwd, firstDbDir, "alpha", 5))
      yield* Effect.option(searchFiles(secondCwd, secondDbDir, "beta", 5))

      const wrote = (dir: string) => Effect.map(fs.readDirectory(dir), (names) => names.length > 0)

      expect(yield* Effect.orElseSucceed(wrote(firstDbDir), () => false)).toBe(true)
      expect(yield* Effect.orElseSucceed(wrote(secondDbDir), () => false)).toBe(true)
    }),
  )
})
