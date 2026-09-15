import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import { readEntries, writeEntries } from "../src/hooks/use-prompt-history"

/**
 * The cache path follows the workspace home the shell mounted with. A build
 * that resolves it from the host `homedir()` instead writes outside the home
 * it was handed, and these round-trips miss the file they just wrote.
 */
const storeTest = it.scopedLive.layer(BunServices.layer)

describe("prompt history store", () => {
  storeTest("entries round-trip under the supplied home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      expect(Option.isNone(yield* readEntries(home))).toBe(true)

      yield* writeEntries(home, ["second prompt", "first prompt"])

      const written = `${home}/.cache/gent/prompt-history.json`
      expect(yield* fs.exists(written)).toBe(true)

      const loaded = yield* readEntries(home)
      expect(Option.getOrElse(loaded, (): ReadonlyArray<string> => [])).toEqual([
        "second prompt",
        "first prompt",
      ])
    }),
  )

  storeTest("a second home keeps its own history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const first = yield* fs.makeTempDirectoryScoped()
      const second = yield* fs.makeTempDirectoryScoped()

      yield* writeEntries(first, ["only in first"])

      expect(Option.isNone(yield* readEntries(second))).toBe(true)
      expect(Option.getOrElse(yield* readEntries(first), (): ReadonlyArray<string> => [])).toEqual([
        "only in first",
      ])
    }),
  )
})
