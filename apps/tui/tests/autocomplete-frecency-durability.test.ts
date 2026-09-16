/**
 * A pick must survive a writer that is not this process, and a filter too
 * short to mean anything must not be steered by history at all.
 *
 * Both were gaps in the shipped feature rather than regressions. The write
 * replaced the file in place, so a second `gent` could interleave with it;
 * and ranking applied pick history at any filter length, which entrenched a
 * favourite at one and two characters where the matcher separates rows by
 * hundredths of a point.
 *
 * **Not tested here: that a reader never sees a half-written file.** It was
 * attempted and the test could not fail — 20,000 concurrent reads against 200
 * overwrites of a megabyte store produced zero torn reads, because Bun's
 * `write` is not observably partial to a same-process reader. A test that
 * passes with the fix reverted proves nothing, so it was deleted rather than
 * kept for the look of coverage. The rename is justified by the syscall
 * instead: `rename(2)` is atomic against readers in *other* processes, which
 * is the case the in-process semaphore cannot reach.
 */
import { describe, expect, it } from "effect-bun-test"
import { test } from "bun:test"
import { Effect, FileSystem, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  clearFrecencyStore,
  frecencyPaths,
  frecencySnapshot,
  readFrecencyStore,
  recordFrecencyPick,
  setFrecencySnapshot,
  writeFrecencyStore,
} from "../src/components/autocomplete-frecency-store"
import { emptyFrecencyStore, frecencyLookup } from "../src/components/autocomplete-frecency"
import { rankAutocompleteItems } from "../src/components/autocomplete-ranking"
import type { AutocompleteItem } from "../src/extensions/client-facets.js"

const durabilityTest = it.scopedLive.layer(BunServices.layer)
const NOW = 1_800_000_000_000

describe("the store survives a writer outside this process", () => {
  durabilityTest("never leaves a temp file next to the store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      setFrecencySnapshot(emptyFrecencyStore())

      yield* recordFrecencyPick(home, "/", "tree", NOW)
      const paths = yield* frecencyPaths(home)
      const present = yield* fs.readDirectory(paths.directory)
      expect(present).toEqual(["autocomplete-frecency.json"])
    }),
  )

  durabilityTest("folds a pick written by another process since this one loaded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      setFrecencySnapshot(emptyFrecencyStore())

      // Stand in for the other process: write straight to the file, behind
      // this process's back, after its snapshot is already seeded.
      yield* recordFrecencyPick(home, "/", "mine", NOW)
      yield* writeFrecencyStore(home, {
        entries: {
          $theirs: { count: 3, lastAt: NOW },
          "/mine": { count: 1, lastAt: NOW },
        },
      })

      yield* recordFrecencyPick(home, "/", "mine", NOW + 1)
      const keys = Object.keys(
        Option.getOrElse(yield* readFrecencyStore(home), () => emptyFrecencyStore()).entries,
      ).sort()
      expect(keys).toEqual(["$theirs", "/mine"])
    }),
  )
})

describe("forgetting every pick", () => {
  durabilityTest("removes the file and empties the snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      setFrecencySnapshot(emptyFrecencyStore())

      yield* recordFrecencyPick(home, "/", "tree", NOW)
      expect(Object.keys(frecencySnapshot().entries).length).toBe(1)

      yield* clearFrecencyStore(home)

      expect(Object.keys(frecencySnapshot().entries).length).toBe(0)
      expect(Option.isNone(yield* readFrecencyStore(home))).toBe(true)
      const paths = yield* frecencyPaths(home)
      expect(yield* fs.exists(paths.file)).toBe(false)
    }),
  )

  durabilityTest("ranks by match quality again after a reset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      setFrecencySnapshot(emptyFrecencyStore())

      const items: ReadonlyArray<AutocompleteItem> = [
        { id: "think", label: "/think", description: "reasoning" },
        { id: "thread", label: "/thread", description: "sessions" },
      ]
      yield* recordFrecencyPick(home, "/", "thread", NOW)
      const withHistory = rankAutocompleteItems(items, "thr", {
        prefix: "/",
        frecency: frecencyLookup(frecencySnapshot(), NOW),
      })
      expect(withHistory[0]?.id).toBe("thread")

      yield* clearFrecencyStore(home)
      const afterReset = rankAutocompleteItems(items, "thi", {
        prefix: "/",
        frecency: frecencyLookup(frecencySnapshot(), NOW),
      })
      expect(afterReset[0]?.id).toBe("think")
    }),
  )
})

describe("a filter too short to mean anything ignores pick history", () => {
  const items: ReadonlyArray<AutocompleteItem> = [
    { id: "tdd", label: "$tdd", description: "test driven" },
    { id: "test", label: "$test", description: "testing" },
  ]
  const heavy = () => frecencyLookup({ entries: { $test: { count: 50, lastAt: NOW } } }, NOW)

  test("leaves one character ranked purely by match quality", () => {
    const ranked = rankAutocompleteItems(items, "t", { prefix: "$", frecency: heavy() })
    expect(ranked[0]?.id).toBe("tdd")
  })

  test("leaves two characters ranked purely by match quality", () => {
    const ranked = rankAutocompleteItems(items, "td", { prefix: "$", frecency: heavy() })
    expect(ranked[0]?.id).toBe("tdd")
  })

  test("applies history from three characters on", () => {
    const ranked = rankAutocompleteItems(items, "tes", { prefix: "$", frecency: heavy() })
    expect(ranked[0]?.id).toBe("test")
  })
})
