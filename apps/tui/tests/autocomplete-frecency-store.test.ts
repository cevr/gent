/**
 * The store is the impure edge, and its whole contract is that it degrades.
 * A missing file, an empty one, and a corrupt one all have to answer "no
 * history" rather than fail, because the alternative is a popup that breaks
 * when a cache file does. These exercise each of those three states against a
 * real filesystem, plus the round-trip that has to work when nothing is wrong.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  readFrecencyStore,
  writeFrecencyStore,
} from "../src/components/autocomplete-frecency-store"
import {
  emptyFrecencyStore,
  frecencyLookup,
  recordPick,
  type FrecencyStoreValue,
} from "../src/components/autocomplete-frecency"

const storeTest = it.scopedLive.layer(BunServices.layer)
const NOW = 1_800_000_000_000

const orEmpty = (value: Option.Option<FrecencyStoreValue>): FrecencyStoreValue =>
  Option.getOrElse(value, () => emptyFrecencyStore())

describe("autocomplete frecency store", () => {
  storeTest("picks round-trip under the supplied home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      expect(Option.isNone(yield* readFrecencyStore(home))).toBe(true)

      yield* writeFrecencyStore(home, recordPick(emptyFrecencyStore(), "$", "test", NOW))

      const written = `${home}/.cache/gent/autocomplete-frecency.json`
      expect(yield* fs.exists(written)).toBe(true)

      const loaded = yield* readFrecencyStore(home)
      expect(frecencyLookup(orEmpty(loaded), NOW)("$", "test")).toBeCloseTo(1, 10)
    }),
  )

  storeTest("reads no history when the file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      expect(Option.isNone(yield* readFrecencyStore(home))).toBe(true)
    }),
  )

  storeTest("reads no history from an empty file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${home}/.cache/gent`, { recursive: true })
      yield* fs.writeFileString(`${home}/.cache/gent/autocomplete-frecency.json`, "")
      expect(Option.isNone(yield* readFrecencyStore(home))).toBe(true)
    }),
  )

  storeTest("reads no history from a corrupt file rather than failing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${home}/.cache/gent`, { recursive: true })
      yield* fs.writeFileString(
        `${home}/.cache/gent/autocomplete-frecency.json`,
        "{ this is not json",
      )
      expect(Option.isNone(yield* readFrecencyStore(home))).toBe(true)
    }),
  )

  storeTest("reads no history from JSON of the wrong shape", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${home}/.cache/gent`, { recursive: true })
      yield* fs.writeFileString(
        `${home}/.cache/gent/autocomplete-frecency.json`,
        '{"entries":{"$test":{"count":"lots"}}}',
      )
      expect(Option.isNone(yield* readFrecencyStore(home))).toBe(true)
    }),
  )

  storeTest("a second home keeps its own history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const first = yield* fs.makeTempDirectoryScoped()
      const second = yield* fs.makeTempDirectoryScoped()

      yield* writeFrecencyStore(first, recordPick(emptyFrecencyStore(), "$", "test", NOW))

      expect(Option.isNone(yield* readFrecencyStore(second))).toBe(true)
      expect(
        frecencyLookup(orEmpty(yield* readFrecencyStore(first)), NOW)("$", "test"),
      ).toBeCloseTo(1, 10)
    }),
  )
})
