/**
 * Ranking at the seams that actually ship.
 *
 * The scorer has its own tests, but a scorer nobody calls ranks nothing. These
 * exercise the two contributions a reader's keystrokes really reach: the `/`
 * items the session registry builds, and the `$` items the skills extension
 * returns over the transport. Disconnecting either from the ranking has to
 * fail here, which is the whole reason these are separate from the unit tests
 * — those call the scorer directly and so cannot notice a caller that stopped
 * calling it.
 *
 * `@` is deliberately absent. FFF ranks files, and this change left that path
 * untouched.
 */
import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Option } from "effect"
import { slashAutocompleteItems } from "../src/session"
import { builtinClientModules } from "../src/extensions/builtins"
import { runAutocompleteContributions } from "../src/extensions/loader-boundary"
import { BranchId, SessionId } from "@gent/core/protocol"
import type { Command } from "../src/commands"
import type {
  AnyExtensionClientModule,
  AutocompleteContribution,
} from "../src/extensions/client-facets"
import {
  makeClientExtensionRuntime,
  runClientExtensionSetup,
} from "./extension-test-harness-boundary"

/**
 * The registration order that produced the bug: `/fork` and `/auth` carry "ag"
 * in their titles and register before `/agents` carries it in its name.
 */
const commands: ReadonlyArray<Command> = [
  { id: "message.fork", title: "Fork from Message", slash: "fork", onSelect: () => {} },
  { id: "auth.manage", title: "Manage API Keys", slash: "auth", onSelect: () => {} },
  { id: "agents.view", title: "Agents", slash: "agents", aliases: ["tree"], onSelect: () => {} },
  { id: "session.model", title: "Set Model", slash: "model", onSelect: () => {} },
  { id: "session.think", title: "Set Reasoning", slash: "think", onSelect: () => {} },
]

const ids = (items: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<string> =>
  items.map((item) => item.id)

describe("slash autocomplete contribution", () => {
  test("puts the command named by the filter first", () => {
    // Before ranking this answered `fork, auth, agents` in registration order,
    // so the preselected row — the one Tab completes and Enter runs — was the
    // wrong command.
    expect(ids(slashAutocompleteItems(commands, "ag"))[0]).toBe("agents")
  })

  test("drops commands that match only through their title", () => {
    const ranked = ids(slashAutocompleteItems(commands, "ag"))
    expect(ranked).not.toContain("fork")
    expect(ranked).not.toContain("auth")
  })

  test("still offers aliases", () => {
    expect(ids(slashAutocompleteItems(commands, "tre"))).toContain("tree")
  })

  test("ranks a partially typed name onto its command", () => {
    expect(ids(slashAutocompleteItems(commands, "mod"))[0]).toBe("model")
    expect(ids(slashAutocompleteItems(commands, "thi"))[0]).toBe("think")
  })

  test("offers every command when nothing is typed yet", () => {
    // One row per slash name plus the alias.
    expect(ids(slashAutocompleteItems(commands, ""))).toEqual([
      "fork",
      "auth",
      "agents",
      "tree",
      "model",
      "think",
    ])
  })

  test("offers nothing for a filter no command matches", () => {
    expect(slashAutocompleteItems(commands, "zzzz")).toEqual([])
  })
})

/** The shipped `$` contribution, found by id among the builtin modules. */
const skillsModule = (): Effect.Effect<AnyExtensionClientModule> =>
  Option.match(
    Option.fromNullishOr(builtinClientModules.find((module) => module.id === "@gent/skills-ui")),
    {
      onNone: () => Effect.die("@gent/skills-ui is not registered"),
      onSome: (module) => Effect.succeed(module),
    },
  )

/**
 * Runs the real skills contribution against a transport returning `names`.
 *
 * The transport needs an active session: the contribution asks it for one
 * before issuing the request, and without it the call fails as
 * `NoActiveSessionError` long before any ranking happens.
 */
const skillItemsFor = (
  names: ReadonlyArray<string>,
  filter: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const runtime = makeClientExtensionRuntime({
      currentSession: () => ({
        sessionId: SessionId.make("sess-1"),
        branchId: BranchId.make("branch-1"),
      }),
      requestReply: names.map((name) => ({
        name,
        description: `The ${name} skill`,
        level: "global",
        content: "",
        filePath: `/tmp/${name}.md`,
      })),
    })
    const contributions = yield* runClientExtensionSetup(runtime, yield* skillsModule())
    const contribution = yield* Option.match(
      Option.fromNullishOr(contributions.autocomplete?.[0]),
      {
        onNone: () => Effect.die("skills extension contributed no autocomplete"),
        onSome: (entry) => Effect.succeed(entry satisfies AutocompleteContribution),
      },
    )
    const failures: Array<string> = []
    const items = yield* Effect.promise(() =>
      runAutocompleteContributions([contribution], filter, runtime, (prefix, reason) => {
        failures.push(`${prefix}: ${reason}`)
      }),
    )
    yield* Effect.promise(() => runtime.dispose())
    // A failing contribution answers with no rows, which would read as a
    // ranking result rather than the breakage it is.
    if (failures.length > 0) return yield* Effect.die(failures.join("; "))
    return ids(items)
  })

describe("skills autocomplete contribution", () => {
  it.live("puts the closest skill name first rather than the first listed", () =>
    Effect.gen(function* () {
      // Plain substring filtering answered in host order, so `$tes` led with
      // whichever skill happened to be listed first. `test` is the closest.
      const names = ["code-style", "stacked", "test", "tdd", "teach"]
      expect((yield* skillItemsFor(names, "tes"))[0]).toBe("test")
    }),
  )

  it.live("ranks a prefix above a mid-word match", () =>
    Effect.gen(function* () {
      const names = ["impeccable", "effect", "code-review"]
      expect((yield* skillItemsFor(names, "eff"))[0]).toBe("effect")
    }),
  )

  it.live("finds a skill by letters scattered through its name", () =>
    Effect.gen(function* () {
      const names = ["code-review", "counsel", "test"]
      expect(yield* skillItemsFor(names, "crv")).toContain("code-review")
    }),
  )

  it.live("offers nothing when no skill matches", () =>
    Effect.gen(function* () {
      expect(yield* skillItemsFor(["effect", "test"], "zzzz")).toEqual([])
    }),
  )

  it.live("offers every skill before anything is typed", () =>
    Effect.gen(function* () {
      expect(yield* skillItemsFor(["effect", "test"], "")).toEqual(["effect", "test"])
    }),
  )
})
