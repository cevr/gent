/**
 * Frecency is arithmetic on a pick history, and the arithmetic is the part
 * that has to be right: how fast a pick fades, how much a fade-resistant
 * favourite may lift a row, and — the one that matters most — how little it
 * may lift it. These pin all three at a fixed instant, which is the reason
 * the scoring module takes `now` as an argument rather than reading a clock.
 */
import { describe, expect, test } from "bun:test"
import {
  HALF_LIFE_MS,
  MAX_ENTRIES,
  decayedWeight,
  emptyFrecencyStore,
  frecencyLookup,
  noFrecency,
  recordPick,
} from "../src/components/autocomplete-frecency"
import { frecencyBonus, rankAutocompleteItems } from "../src/components/autocomplete-ranking"
import type { AutocompleteItem } from "../src/extensions/client-facets.js"

const NOW = 1_800_000_000_000
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
