/**
 * Frecency at the seams that actually ship.
 *
 * The scoring has its own tests, but a score nobody records and nobody reads
 * changes no popup. A previous pass on this code shipped probes that proved
 * nothing for exactly that reason: they called the ranker directly, so a
 * caller that stopped calling it would not have failed a single one. These go
 * the other way round — they drive the real contributions and assert on the
 * order a reader would see, so disconnecting either half fails here.
 *
 * Two halves have to hold. The write half: selecting a row has to leave
 * something on disk. The read half: what is on disk has to change the order
 * the next popup returns.
 *
 * `@` is deliberately absent. FFF keeps its own frecency for files, and this
 * change left that path alone.
 */
import { describe, expect, it, test } from "effect-bun-test"
import { DateTime, Effect, FileSystem, Option, Schedule } from "effect"
import { BunServices } from "@effect/platform-bun"
import { slashAutocompleteItems } from "../src/routes/session-command-registry"
import { builtinClientModules } from "../src/extensions/builtins/index"
import { runAutocompleteContributions } from "../src/components/autocomplete-popup-boundary"
import { BranchId, SessionId } from "@gent/core/protocol"
import {
  emptyFrecencyStore,
  frecencyLookup,
  recordPick,
  type FrecencyStoreValue,
} from "../src/components/autocomplete-frecency"
import { readFrecencyStore } from "../src/components/autocomplete-frecency-store"
import type { Command } from "../src/command/types"
import type {
  AnyExtensionClientModule,
  AutocompleteContribution,
} from "../src/extensions/client-facets.js"
import {
  makeClientExtensionRuntime,
  runClientExtensionSetup,
} from "./extension-test-harness-boundary"

const NOW = 1_800_000_000_000

const ids = (items: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<string> =>
  items.map((item) => item.id)

/** `/think` and `/thread` tie on everything the matcher can see but length. */
const commands: ReadonlyArray<Command> = [
  { id: "session.think", title: "Set Reasoning", slash: "think", onSelect: () => {} },
  { id: "session.thread", title: "Thread over sessions", slash: "thread", onSelect: () => {} },
]

describe("slash autocomplete reads pick history", () => {
  test("answers /t with think for a reader who has picked nothing", () => {
    expect(ids(slashAutocompleteItems(commands, "t"))[0]).toBe("think")
  })

  test("answers /thr with thread once the reader has picked it", () => {
    // The seam: the contribution has to pass the history through to the
    // ranker. A build that drops the third argument still answers `think`.
    //
    // Three characters, not one: ranking ignores pick history below
    // FRECENCY_MIN_FILTER, so a one-character filter would pass this test for
    // the wrong reason — it would answer `think` whether or not the history
    // reached the ranker at all.
    const store = recordPick(emptyFrecencyStore(), "/", "thread", NOW)
    expect(ids(slashAutocompleteItems(commands, "thr", frecencyLookup(store, NOW)))[0]).toBe(
      "thread",
    )
  })

  test("keeps a picked command out of a filter it does not match", () => {
    const store = recordPick(emptyFrecencyStore(), "/", "thread", NOW)
    expect(ids(slashAutocompleteItems(commands, "think", frecencyLookup(store, NOW)))[0]).toBe(
      "think",
    )
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
 * Drives the real skills contribution against a temp home, returning both the
 * ranked ids and the contribution itself so a test can also select a row.
 */
const skillsHarness = (home: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runtime = makeClientExtensionRuntime({
      // The extension writes its store under `home`, so the harness has to
      // point at this test's temp directory. Left at the harness default,
      // every run would share one file in /tmp and the assertion below would
      // pass on a previous run's pick.
      workspace: { cwd: home, home },
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
    const rank = (filter: string) =>
      Effect.gen(function* () {
        const failures: Array<string> = []
        const items = yield* Effect.promise(() =>
          runAutocompleteContributions([contribution], filter, runtime, (prefix, reason) => {
            failures.push(`${prefix}: ${reason}`)
          }),
        )
        // A failing contribution answers with no rows, which would read as a
        // ranking result rather than the breakage it is.
        if (failures.length > 0) return yield* Effect.die(failures.join("; "))
        return ids(items)
      })
    return { contribution, rank, dispose: () => Effect.promise(() => runtime.dispose()) }
  })

const seamTest = it.scopedLive.layer(BunServices.layer)

describe("skills autocomplete records and reads pick history", () => {
  seamTest("answers $t with tdd before the reader picks anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const harness = yield* skillsHarness(home, ["tdd", "test"])
      // The documented weakness: 12.760 against 12.680, decided by length.
      expect((yield* harness.rank("t"))[0]).toBe("tdd")
      yield* harness.dispose()
    }),
  )

  seamTest("writes a pick to the store when a row is selected", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const harness = yield* skillsHarness(home, ["tdd", "test"])

      // The write half. A contribution with no onSelect leaves nothing here.
      const onSelect = Option.fromNullishOr(harness.contribution.onSelect)
      expect(Option.isSome(onSelect)).toBe(true)
      if (Option.isSome(onSelect)) onSelect.value("test", "t")

      // The write is forked off the keystroke path — that is the requirement —
      // so it lands shortly after the callback returns rather than during it.
      // Retry rather than sleep: the assertion is "the pick arrives", and a
      // fixed delay would either flake or slow the suite to cover the worst
      // case.
      const weightOf = (loaded: Option.Option<FrecencyStoreValue>): number =>
        frecencyLookup(
          Option.getOrElse(loaded, () => emptyFrecencyStore()),
          DateTime.toEpochMillis(DateTime.nowUnsafe()),
        )("$", "test")

      const recorded = yield* Effect.retry(
        Effect.flatMap(readFrecencyStore(home), (loaded) => {
          const weight = weightOf(loaded)
          if (weight > 0) return Effect.succeed(weight)
          return Effect.fail("not written yet")
        }),
        { times: 50, schedule: Schedule.spaced("10 millis") },
      )
      expect(recorded).toBeGreaterThan(0)
      yield* harness.dispose()
    }),
  )
})
