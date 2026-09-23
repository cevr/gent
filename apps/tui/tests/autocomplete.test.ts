import { describe, expect, it, test } from "effect-bun-test"
import { Effect, FileSystem, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  clearFrecencyStore,
  decayedWeight,
  emptyFrecencyStore,
  frecencyBonus,
  frecencyLookup,
  frecencyPaths,
  frecencySnapshot,
  type FrecencyStoreValue,
  ghostCompletion,
  HALF_LIFE_MS,
  MAX_ENTRIES,
  noFrecency,
  rankAutocompleteItems,
  readFrecencyStore,
  recordFrecencyPick,
  recordPick,
  scoreSubsequence,
  setFrecencySnapshot,
  writeFrecencyStore,
} from "../src/autocomplete"
import type { AutocompleteItem } from "../src/extensions/client-facets"

// ── autocomplete frecency store ─────────────────────────────────────────────

/**
 * The store is the impure edge, and its whole contract is that it degrades.
 * A missing file, an empty one, and a corrupt one all have to answer "no
 * history" rather than fail, because the alternative is a popup that breaks
 * when a cache file does. These exercise each of those three states against a
 * real filesystem, plus the round-trip that has to work when nothing is wrong.
 */

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

// ── autocomplete frecency ───────────────────────────────────────────────────

/**
 * Frecency is arithmetic on a pick history, and the arithmetic is the part
 * that has to be right: how fast a pick fades, how much a fade-resistant
 * favourite may lift a row, and — the one that matters most — how little it
 * may lift it. These pin all three at a fixed instant, which is the reason
 * the scoring module takes `now` as an argument rather than reading a clock.
 */

const DAY = 24 * 60 * 60 * 1000

const ids = (items: ReadonlyArray<AutocompleteItem>): ReadonlyArray<string> =>
  items.map((item) => item.id)

/** The real tie: both score a boundary hit, and only length separates them. */
const skills: ReadonlyArray<AutocompleteItem> = ["tdd", "test", "teach"].map((name) => ({
  id: name,
  label: name,
  description: `The ${name} skill`,
}))

const commands: ReadonlyArray<AutocompleteItem> = [
  { id: "think", label: "/think", description: "Set Reasoning" },
  { id: "thread", label: "/thread", description: "Thread over sessions" },
]

describe("decayedWeight", () => {
  test("keeps a pick's full weight at the moment it happened", () => {
    expect(decayedWeight({ count: 1, lastAt: NOW }, NOW)).toBeCloseTo(1, 10)
  })

  test("halves a pick's weight after one half-life", () => {
    expect(decayedWeight({ count: 1, lastAt: NOW - HALF_LIFE_MS }, NOW)).toBeCloseTo(0.5, 10)
  })

  test("all but erases a pick from three months ago", () => {
    // The requirement in one assertion: ten minutes ago and three months ago
    // must not count the same.
    const recent = decayedWeight({ count: 1, lastAt: NOW - 10 * 60 * 1000 }, NOW)
    const stale = decayedWeight({ count: 1, lastAt: NOW - 90 * DAY }, NOW)
    expect(recent).toBeGreaterThan(0.99)
    expect(stale).toBeLessThan(0.02)
  })

  test("does not amplify a timestamp from the future", () => {
    // A clock that moved backwards, or a hand-edited file, must not mint score.
    expect(decayedWeight({ count: 3, lastAt: NOW + 10 * DAY }, NOW)).toBeCloseTo(3, 10)
  })
})

describe("recordPick", () => {
  test("counts a first pick as one", () => {
    const store = recordPick(emptyFrecencyStore(), "$", "test", NOW)
    expect(frecencyLookup(store, NOW)("$", "test")).toBeCloseTo(1, 10)
  })

  test("accumulates repeated picks", () => {
    let store = emptyFrecencyStore()
    store = recordPick(store, "$", "test", NOW)
    store = recordPick(store, "$", "test", NOW)
    expect(frecencyLookup(store, NOW)("$", "test")).toBeCloseTo(2, 10)
  })

  test("decays the running count before adding a new pick", () => {
    // Otherwise an old total would sit undecayed forever behind a fresh
    // timestamp, and a row picked twice a year ago would outrank a daily one.
    let store = recordPick(emptyFrecencyStore(), "$", "test", NOW - HALF_LIFE_MS)
    store = recordPick(store, "$", "test", NOW)
    expect(frecencyLookup(store, NOW)("$", "test")).toBeCloseTo(1.5, 10)
  })

  test("keeps prefixes apart", () => {
    const store = recordPick(emptyFrecencyStore(), "$", "model", NOW)
    expect(frecencyLookup(store, NOW)("/", "model")).toBe(0)
  })

  test("bounds the store and drops the faintest rows", () => {
    let store = emptyFrecencyStore()
    for (let index = 0; index < MAX_ENTRIES + 20; index++) {
      // Older as the index grows, so the earliest are the strongest. The last
      // one written is the faintest by weight, but it is also the row just
      // picked, which is always kept — so the eviction to check is a
      // second-faintest row from the middle of the tail.
      store = recordPick(store, "$", `skill-${index}`, NOW - index * DAY)
    }
    expect(Object.keys(store.entries).length).toBe(MAX_ENTRIES)
    expect(frecencyLookup(store, NOW)("$", "skill-0")).toBeGreaterThan(0)
    expect(frecencyLookup(store, NOW)("$", `skill-${MAX_ENTRIES + 18}`)).toBe(0)
  })

  test("keeps the row just picked even when the store is full", () => {
    let store = emptyFrecencyStore()
    for (let index = 0; index < MAX_ENTRIES; index++) {
      store = recordPick(store, "$", `skill-${index}`, NOW)
    }
    store = recordPick(store, "$", "newcomer", NOW)
    expect(frecencyLookup(store, NOW)("$", "newcomer")).toBeGreaterThan(0)
  })
})

describe("frecencyBonus", () => {
  test("gives nothing to a row that was never picked", () => {
    // A reader with no history must rank exactly as they did before.
    expect(frecencyBonus(0)).toBe(0)
  })

  test("never exceeds the boundary bonus the matcher awards", () => {
    // The ceiling that keeps a stale favourite from jumping a better match.
    expect(frecencyBonus(1000)).toBeLessThan(12)
  })

  test("grows with weight but with falling returns", () => {
    const first = frecencyBonus(1) - frecencyBonus(0)
    const tenth = frecencyBonus(10) - frecencyBonus(9)
    expect(first).toBeGreaterThan(tenth)
  })
})

describe("ranking with pick history", () => {
  test("ranks identically to before when the reader has no history", () => {
    // Degrading to today's behaviour is the contract for a missing store.
    const withoutHistory = ids(rankAutocompleteItems(skills, "t"))
    const withEmpty = ids(
      rankAutocompleteItems(skills, "t", {
        prefix: "$",
        frecency: frecencyLookup(emptyFrecencyStore(), NOW),
      }),
    )
    expect(withEmpty).toEqual(withoutHistory)
    expect(ids(rankAutocompleteItems(skills, "t", { prefix: "$", frecency: noFrecency }))).toEqual(
      withoutHistory,
    )
  })

  test("reaches test from $tes after the reader picks it once", () => {
    // `tdd` scores 12.760 and `test` 12.680 — a gap of exactly one character
    // of length charge — so one real pick settles it, from three characters on.
    expect(ids(rankAutocompleteItems(skills, "tes"))[0]).toBe("test")
    const store = recordPick(emptyFrecencyStore(), "$", "test", NOW)
    expect(
      ids(
        rankAutocompleteItems(skills, "tes", { prefix: "$", frecency: frecencyLookup(store, NOW) }),
      )[0],
    ).toBe("test")
  })

  test("leaves $t alone however often test was picked", () => {
    // The deliberate limit. One and two characters name almost nothing, so a
    // single past pick must not decide the row under the cursor — and the
    // ghost line offers that row, which makes a wrong guess there costly.
    let store = emptyFrecencyStore()
    for (let index = 0; index < 50; index++) store = recordPick(store, "$", "test", NOW)
    const lookup = frecencyLookup(store, NOW)
    expect(ids(rankAutocompleteItems(skills, "t", { prefix: "$", frecency: lookup }))[0]).toBe(
      "tdd",
    )
    expect(ids(rankAutocompleteItems(skills, "td", { prefix: "$", frecency: lookup }))[0]).toBe(
      "tdd",
    )
  })

  test("reaches thread from /thr and /thre after a pick", () => {
    // `/t` and `/th` are below FRECENCY_MIN_FILTER and keep answering `think`
    // by match quality alone; the tie only becomes history's to break once
    // the reader has typed enough to mean something.
    expect(ids(rankAutocompleteItems(commands, "thr"))[0]).toBe("thread")
    const store = recordPick(emptyFrecencyStore(), "/", "thread", NOW)
    const lookup = frecencyLookup(store, NOW)
    expect(ids(rankAutocompleteItems(commands, "thr", { prefix: "/", frecency: lookup }))[0]).toBe(
      "thread",
    )
    expect(ids(rankAutocompleteItems(commands, "thre", { prefix: "/", frecency: lookup }))[0]).toBe(
      "thread",
    )
    expect(ids(rankAutocompleteItems(commands, "t", { prefix: "/", frecency: lookup }))[0]).toBe(
      "think",
    )
  })

  test("lets a fully typed name beat a stale popular pick", () => {
    // The failure this feature must not introduce. `pr` is picked constantly;
    // typing `prototype` in full must still select `prototype`.
    const items: ReadonlyArray<AutocompleteItem> = [
      { id: "pr", label: "pr", description: "The pr skill" },
      { id: "prototype", label: "prototype", description: "The prototype skill" },
    ]
    let store = emptyFrecencyStore()
    for (let index = 0; index < 50; index++) store = recordPick(store, "$", "pr", NOW)
    const ranked = ids(
      rankAutocompleteItems(items, "prototype", {
        prefix: "$",
        frecency: frecencyLookup(store, NOW),
      }),
    )
    expect(ranked[0]).toBe("prototype")
  })

  test("lets a precise prefix beat a heavily picked shorter neighbour", () => {
    // Even where both still match, spelling more of the name has to win.
    let store = emptyFrecencyStore()
    for (let index = 0; index < 50; index++) store = recordPick(store, "$", "tdd", NOW)
    const ranked = ids(
      rankAutocompleteItems(skills, "tes", { prefix: "$", frecency: frecencyLookup(store, NOW) }),
    )
    expect(ranked[0]).toBe("test")
  })

  test("does not rescue a row the filter does not match", () => {
    let store = emptyFrecencyStore()
    for (let index = 0; index < 50; index++) store = recordPick(store, "$", "tdd", NOW)
    expect(
      ids(
        rankAutocompleteItems(skills, "teach", {
          prefix: "$",
          frecency: frecencyLookup(store, NOW),
        }),
      ),
    ).not.toContain("tdd")
  })

  test("lets a fresh pick outrank a stale one", () => {
    let store = recordPick(emptyFrecencyStore(), "$", "tdd", NOW - 120 * DAY)
    store = recordPick(store, "$", "test", NOW)
    expect(
      ids(
        rankAutocompleteItems(skills, "tes", { prefix: "$", frecency: frecencyLookup(store, NOW) }),
      )[0],
    ).toBe("test")
  })
})

// ── autocomplete frecency cross writer ──────────────────────────────────────

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

const crossWriterTest = it.scopedLive.layer(BunServices.layer)

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

// ── autocomplete frecency durability ────────────────────────────────────────

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

const durabilityTest = it.scopedLive.layer(BunServices.layer)

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

// ── autocomplete ranking ────────────────────────────────────────────────────

/**
 * Ranking is what decides the popup's first row, and the first row is what
 * Tab completes and what the ghost line offers. So the ordering is the
 * behaviour under test, not an implementation detail: these pin the orders a
 * reader actually sees for the filters they actually type.
 *
 * The corpora are the real ones — the slash commands the session registers
 * plus the extension-contributed ones, and skill names from a real skills
 * directory — because ranking quality is only meaningful against the set it
 * ranks. Invented names would pin nothing.
 */

/** The live slash corpus: core registry commands plus extension contributions. */
const commandsRanking: ReadonlyArray<AutocompleteItem> = [
  { id: "new", label: "/new", description: "New Session" },
  { id: "sessions", label: "/sessions", description: "Open Sessions" },
  { id: "branch", label: "/branch", description: "Create Branch" },
  { id: "fork", label: "/fork", description: "Fork from Message" },
  { id: "think", label: "/think", description: "Pick the reasoning level for this session" },
  { id: "model", label: "/model", description: "Pick the model for this session" },
  { id: "auth", label: "/auth", description: "Manage API Keys" },
  { id: "btw", label: "/btw", description: "Fork here" },
  { id: "driver", label: "/driver", description: "Driver override" },
  { id: "thread", label: "/thread", description: "Thread over sessions" },
  { id: "agents", label: "/agents", description: "Agents" },
]

/** Real skill names, which is where near-miss prefixes actually bite. */
const skillsRanking: ReadonlyArray<AutocompleteItem> = [
  "agent-browser",
  "architecture",
  "bible",
  "bible-study",
  "cli",
  "code-review",
  "code-style",
  "counsel",
  "effect",
  "impeccable",
  "react",
  "repo",
  "research",
  "tdd",
  "teach",
  "test",
  "ui",
  "ui-ux-pro-max",
].map((name) => ({ id: name, label: name, description: `The ${name} skill` }))

describe("rankAutocompleteItems", () => {
  test("puts the named command first even when titles match the filter", () => {
    // The regression this exists for. "Fork from Message" and "Manage API Keys"
    // both contain "ag", and both register before /agents, so the unranked list
    // led with /fork — which is the command Tab completed and Enter ran.
    expect(ids(rankAutocompleteItems(commandsRanking, "ag"))[0]).toBe("agents")
  })

  test("drops a command matched only through its description", () => {
    // "Fork from Message" and "Manage API Keys" both contain "ag", and both
    // used to be listed for `/ag`. The description penalty is wide enough that
    // neither survives: a command is offered for the letters in its name, and
    // a description match alone is not evidence the reader meant it.
    const ranked = ids(rankAutocompleteItems(commandsRanking, "ag"))
    expect(ranked[0]).toBe("agents")
    expect(ranked).not.toContain("fork")
    expect(ranked).not.toContain("auth")
  })

  test("completes a partial name to the command that starts with it", () => {
    expect(ids(rankAutocompleteItems(commandsRanking, "mod"))[0]).toBe("model")
    expect(ids(rankAutocompleteItems(commandsRanking, "ne"))[0]).toBe("new")
    expect(ids(rankAutocompleteItems(commandsRanking, "br"))[0]).toBe("branch")
    expect(ids(rankAutocompleteItems(commandsRanking, "au"))[0]).toBe("auth")
  })

  test("prefers the shorter exact-prefix name when two commands share a start", () => {
    // Both /think and /thread start with "th"; the shorter one is the closer
    // match, so it leads and the ghost offers it.
    expect(ids(rankAutocompleteItems(commandsRanking, "th"))[0]).toBe("think")
  })

  test("ranks skills by nearness of name, not by list position", () => {
    expect(ids(rankAutocompleteItems(skillsRanking, "eff"))[0]).toBe("effect")
    expect(ids(rankAutocompleteItems(skillsRanking, "bib"))[0]).toBe("bible")
    expect(ids(rankAutocompleteItems(skillsRanking, "tes"))[0]).toBe("test")
  })

  test("matches letters scattered through a name, not only substrings", () => {
    // A subsequence match is the point of fuzzy ranking: "crv" finds
    // code-review, which no substring test would return.
    expect(ids(rankAutocompleteItems(skillsRanking, "crv"))).toContain("code-review")
  })

  test("returns nothing when the filter matches nothing", () => {
    expect(rankAutocompleteItems(commandsRanking, "zzz")).toEqual([])
    expect(rankAutocompleteItems(skillsRanking, "qqq")).toEqual([])
  })

  test("returns every item untouched for an empty filter", () => {
    // No filter is not a ranking question, and reordering here would shuffle
    // the popup the moment it opens.
    expect(rankAutocompleteItems(commandsRanking, "")).toEqual(commandsRanking)
  })

  test("ignores case in both directions", () => {
    expect(ids(rankAutocompleteItems(commandsRanking, "AG"))[0]).toBe("agents")
    expect(ids(rankAutocompleteItems(commandsRanking, "Mod"))[0]).toBe("model")
  })

  test("keeps input order between items that score the same", () => {
    const tied: ReadonlyArray<AutocompleteItem> = [
      { id: "alpha", label: "alpha" },
      { id: "alpha", label: "alpha" },
    ]
    expect(rankAutocompleteItems(tied, "alpha")).toEqual(tied)
  })
})

describe("scoreSubsequence", () => {
  test("reports a miss when the letters are not in order", () => {
    expect(scoreSubsequence("ba", "abc")).toBe(-1)
  })

  test("scores an unbroken run above the same letters scattered", () => {
    expect(scoreSubsequence("age", "agents")).toBeGreaterThan(scoreSubsequence("age", "a-g-e-x"))
  })

  test("scores a word-boundary match above a mid-word one", () => {
    expect(scoreSubsequence("rev", "code-review")).toBeGreaterThan(
      scoreSubsequence("rev", "irrelevant"),
    )
  })

  test("scores an empty needle as zero rather than a miss", () => {
    expect(scoreSubsequence("", "anything")).toBe(0)
  })
})

describe("ghostCompletion", () => {
  const top = (filter: string): Option.Option<AutocompleteItem> =>
    Option.fromNullishOr(rankAutocompleteItems(commandsRanking, filter)[0])

  test("offers the winning command's full name", () => {
    expect(ghostCompletion(top("ag"), "ag")).toEqual(Option.some("agents"))
    expect(ghostCompletion(top("mod"), "mod")).toEqual(Option.some("model"))
  })

  test("offers nothing once the name is fully typed", () => {
    expect(ghostCompletion(top("agents"), "agents")).toEqual(Option.none())
  })

  test("offers nothing when the filter matches nothing", () => {
    expect(ghostCompletion(top("zzz"), "zzz")).toEqual(Option.none())
  })

  test("offers nothing for a scattered match that is not a prefix", () => {
    // "mdl" ranks /model, but there is no single remainder to append to "mdl".
    // The popup still shows the row; the ghost stays silent rather than lying.
    const candidate = Option.some<AutocompleteItem>({ id: "model", label: "/model" })
    expect(ghostCompletion(candidate, "mdl")).toEqual(Option.none())
  })

  test("offers nothing for an empty filter", () => {
    const candidate = Option.some<AutocompleteItem>({ id: "model", label: "/model" })
    expect(ghostCompletion(candidate, "")).toEqual(Option.none())
  })

  test("offers the canonical spelling regardless of typed case", () => {
    expect(ghostCompletion(top("AG"), "AG")).toEqual(Option.some("agents"))
  })
})
