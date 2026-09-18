/**
 * A pick from one surface must survive a pick from another.
 *
 * Two surfaces record picks into one file — the `/` commands registry and the
 * `$` skills extension — and they used to disagree about how. `$` re-read the
 * file on every pick. `/` wrote from a snapshot the module loaded once and
 * never refreshed, so a `$` pick that landed after that load was invisible to
 * it, and the next `/` pick serialized the stale snapshot back over the file.
 * Picks from each surface survived their own kind and were erased by the
 * other's, which is the case a reader hits constantly, because a reader uses
 * both.
 *
 * These drive the shipped record path rather than a re-creation of it, and
 * assert on the file at the path the writers actually use — the store is the
 * subject here, not a vehicle. A previous pass on this code shipped a seam
 * test that passed trivially because its harness wrote somewhere the test
 * never looked; every assertion below reads back through `readFrecencyStore`
 * on the same `home` it wrote with, and the round-trip test names the file.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  emptyFrecencyStore,
  frecencyLookup,
  frecencySnapshot,
  type FrecencyStoreValue,
  readFrecencyStore,
  recordFrecencyPick,
  setFrecencySnapshot,
} from "../src/autocomplete"

const crossWriterTest = it.scopedLive.layer(BunServices.layer)
const NOW = 1_800_000_000_000

const orEmpty = (value: Option.Option<FrecencyStoreValue>): FrecencyStoreValue =>
  Option.getOrElse(value, () => emptyFrecencyStore())

/** The keys the file holds, which is what a lost write actually removes. */
const storedKeys = (home: string) =>
  Effect.map(readFrecencyStore(home), (loaded) => Object.keys(orEmpty(loaded).entries).sort())

describe("a pick from one surface survives a pick from another", () => {
  crossWriterTest("keeps a $ pick when a / pick follows it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      // The reproduction, in the reader's order: /tree, $triage, /thread.
      // Before the fix the last write dropped `$triage`, because the `/`
      // writer folded into a snapshot taken before `$triage` existed.
      yield* recordFrecencyPick(home, "/", "tree", NOW)
      yield* recordFrecencyPick(home, "$", "triage", NOW)
      yield* recordFrecencyPick(home, "/", "thread", NOW)

      expect(yield* storedKeys(home)).toEqual(["$triage", "/thread", "/tree"])
    }),
  )

  crossWriterTest("keeps a / pick when a $ pick follows it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      // The other order, which lost the `/` pick the same way.
      yield* recordFrecencyPick(home, "$", "triage", NOW)
      yield* recordFrecencyPick(home, "/", "tree", NOW)
      yield* recordFrecencyPick(home, "$", "test", NOW)

      expect(yield* storedKeys(home)).toEqual(["$test", "$triage", "/tree"])
    }),
  )

  crossWriterTest("folds a pick into a file another writer changed underneath", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      // A stale in-memory snapshot is the precise trigger: seed it as the old
      // `/` cell did, let another surface write, then record. A writer that
      // folds into the snapshot loses `$triage`; one that reads the file keeps
      // it.
      yield* recordFrecencyPick(home, "/", "tree", NOW)
      const stale = frecencySnapshot()
      yield* recordFrecencyPick(home, "$", "triage", NOW)
      setFrecencySnapshot(stale)

      yield* recordFrecencyPick(home, "/", "thread", NOW)

      expect(yield* storedKeys(home)).toEqual(["$triage", "/thread", "/tree"])
    }),
  )

  crossWriterTest("accumulates concurrent picks instead of overwriting them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      // Picks are forked off the keystroke path, so two can be in flight at
      // once. Unserialized, the later write clobbers the earlier one and the
      // file ends with a single key.
      yield* Effect.all(
        [
          recordFrecencyPick(home, "/", "tree", NOW),
          recordFrecencyPick(home, "$", "triage", NOW),
          recordFrecencyPick(home, "/", "thread", NOW),
          recordFrecencyPick(home, "$", "test", NOW),
        ],
        { concurrency: "unbounded" },
      )

      expect(yield* storedKeys(home)).toEqual(["$test", "$triage", "/thread", "/tree"])
    }),
  )

  crossWriterTest("writes to the file the readers read, under the given home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      yield* recordFrecencyPick(home, "$", "triage", NOW)

      // Name the path. A harness that writes elsewhere must not pass.
      const file = `${home}/.cache/gent/autocomplete-frecency.json`
      expect(yield* fs.exists(file)).toBe(true)

      const loaded = yield* readFrecencyStore(home)
      expect(frecencyLookup(orEmpty(loaded), NOW)("$", "triage")).toBeCloseTo(1, 10)
    }),
  )

  crossWriterTest("refreshes the snapshot ranking reads without awaiting", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      setFrecencySnapshot(emptyFrecencyStore())
      yield* recordFrecencyPick(home, "/", "thread", NOW)

      // Ranking cannot await, so a recorded pick has to be visible in the
      // synchronous snapshot immediately after the write lands.
      expect(frecencyLookup(frecencySnapshot(), NOW)("/", "thread")).toBeCloseTo(1, 10)
    }),
  )
})
