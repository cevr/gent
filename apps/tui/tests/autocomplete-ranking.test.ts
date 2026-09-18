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
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { ghostCompletion, rankAutocompleteItems, scoreSubsequence } from "../src/autocomplete"
import type { AutocompleteItem } from "../src/extensions/client-facets.js"

/** The live slash corpus: core registry commands plus extension contributions. */
const commands: ReadonlyArray<AutocompleteItem> = [
  { id: "new", label: "/new", description: "New Session" },
  { id: "sessions", label: "/sessions", description: "Open Sessions" },
  { id: "branch", label: "/branch", description: "Create Branch" },
  { id: "fork", label: "/fork", description: "Fork from Message" },
  { id: "think", label: "/think", description: "Pick the reasoning level for this session" },
  { id: "model", label: "/model", description: "Pick the model for this session" },
  { id: "auth", label: "/auth", description: "Manage API Keys" },
  { id: "btw", label: "/btw", description: "Side question" },
  { id: "driver", label: "/driver", description: "Driver override" },
  { id: "thread", label: "/thread", description: "Thread over sessions" },
  { id: "agents", label: "/agents", description: "Agents" },
]

/** Real skill names, which is where near-miss prefixes actually bite. */
const skills: ReadonlyArray<AutocompleteItem> = [
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

const ids = (items: ReadonlyArray<AutocompleteItem>): ReadonlyArray<string> =>
  items.map((item) => item.id)

describe("rankAutocompleteItems", () => {
  test("puts the named command first even when titles match the filter", () => {
    // The regression this exists for. "Fork from Message" and "Manage API Keys"
    // both contain "ag", and both register before /agents, so the unranked list
    // led with /fork — which is the command Tab completed and Enter ran.
    expect(ids(rankAutocompleteItems(commands, "ag"))[0]).toBe("agents")
  })

  test("drops a command matched only through its description", () => {
    // "Fork from Message" and "Manage API Keys" both contain "ag", and both
    // used to be listed for `/ag`. The description penalty is wide enough that
    // neither survives: a command is offered for the letters in its name, and
    // a description match alone is not evidence the reader meant it.
    const ranked = ids(rankAutocompleteItems(commands, "ag"))
    expect(ranked[0]).toBe("agents")
    expect(ranked).not.toContain("fork")
    expect(ranked).not.toContain("auth")
  })

  test("completes a partial name to the command that starts with it", () => {
    expect(ids(rankAutocompleteItems(commands, "mod"))[0]).toBe("model")
    expect(ids(rankAutocompleteItems(commands, "ne"))[0]).toBe("new")
    expect(ids(rankAutocompleteItems(commands, "br"))[0]).toBe("branch")
    expect(ids(rankAutocompleteItems(commands, "au"))[0]).toBe("auth")
  })

  test("prefers the shorter exact-prefix name when two commands share a start", () => {
    // Both /think and /thread start with "th"; the shorter one is the closer
    // match, so it leads and the ghost offers it.
    expect(ids(rankAutocompleteItems(commands, "th"))[0]).toBe("think")
  })

  test("ranks skills by nearness of name, not by list position", () => {
    expect(ids(rankAutocompleteItems(skills, "eff"))[0]).toBe("effect")
    expect(ids(rankAutocompleteItems(skills, "bib"))[0]).toBe("bible")
    expect(ids(rankAutocompleteItems(skills, "tes"))[0]).toBe("test")
  })

  test("matches letters scattered through a name, not only substrings", () => {
    // A subsequence match is the point of fuzzy ranking: "crv" finds
    // code-review, which no substring test would return.
    expect(ids(rankAutocompleteItems(skills, "crv"))).toContain("code-review")
  })

  test("returns nothing when the filter matches nothing", () => {
    expect(rankAutocompleteItems(commands, "zzz")).toEqual([])
    expect(rankAutocompleteItems(skills, "qqq")).toEqual([])
  })

  test("returns every item untouched for an empty filter", () => {
    // No filter is not a ranking question, and reordering here would shuffle
    // the popup the moment it opens.
    expect(rankAutocompleteItems(commands, "")).toEqual(commands)
  })

  test("ignores case in both directions", () => {
    expect(ids(rankAutocompleteItems(commands, "AG"))[0]).toBe("agents")
    expect(ids(rankAutocompleteItems(commands, "Mod"))[0]).toBe("model")
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
    Option.fromNullishOr(rankAutocompleteItems(commands, filter)[0])

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
