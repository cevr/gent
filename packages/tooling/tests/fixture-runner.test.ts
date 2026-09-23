/**
 * Lint fixture verification.
 *
 * For each custom oxlint rule scaffolded in , runs `oxlint` against a
 * positive fixture (must error) and a negative fixture (must pass). Verifies
 * each rule actually fires on the cases its docstring claims.
 *
 * Fixtures + their dedicated `.oxlintrc.json` live in `../fixtures/`. The
 * fixtures-local config enables every rule under test as `error` so the test
 * needs no CLI flag plumbing.
 *
 * To keep the suite fast, the invalid fixtures are linted in one batched
 * oxlint invocation and the valid fixtures in another, once, while the file
 * registers its tests. Each per-rule test filters the shared report by
 * `filename` instead of re-spawning oxlint. When a run produces no report, a
 * single test fails with the reason and the per-rule tests are not registered.
 *
 * @module
 */

import { expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, FileSystem, Option, Path, Schema } from "effect"
import { describe as effectDescribe, it } from "effect-bun-test"
import {
  runOxlint,
  type Diagnostic,
  type OxlintReport,
  type OxlintRun,
} from "../src/fixture-runner"
import gentRules from "../src/gent-rules"

const filterByFile = (report: OxlintReport, fixtureFile: string): ReadonlyArray<Diagnostic> =>
  report.diagnostics.filter((d) => d.filename === fixtureFile)

const countViolations = (diagnostics: ReadonlyArray<Diagnostic>, ruleId: string): number => {
  // JSON output writes the rule id as `code: "gent(rule-name)"`. Compare
  // against both that shape and the bare prefixed form for resilience.
  const tail = ruleId.replace(/^gent\//, "")
  const codeForm = `gent(${tail})`
  return diagnostics.filter((d) => {
    const code = Option.getOrElse(
      Option.firstSomeOf([Option.fromNullishOr(d.code), Option.fromNullishOr(d.rule_id)]),
      () => "",
    )
    return code === codeForm || code === ruleId || code.endsWith(`(${tail})`)
  }).length
}

const readTextFile = Effect.fn("Tooling.readTextFile")(function* (relativePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.readFileString(path.resolve(import.meta.dir, "..", "..", "..", relativePath))
})

const TypeScriptConfig = Schema.Struct({
  compilerOptions: Schema.Struct({
    plugins: Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        diagnosticSeverity: Schema.optional(
          Schema.Struct({ extendsNativeError: Schema.optional(Schema.String) }),
        ),
      }),
    ),
  }),
})

const readTypeScriptConfig = (relativePath: string) =>
  readTextFile(relativePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TypeScriptConfig))),
  )

interface RuleCase {
  readonly rule: string
  readonly invalid: string
  /** One or more files the rule must leave alone. */
  readonly valid: ReadonlyArray<string>
  /**
   * Exact diagnostic count expected on the invalid fixture. When omitted,
   * the test asserts `> 0`. Set this when the invalid fixture covers a
   * specific enumerated set of cases — silently dropping a case on rule
   * regression should fail the test, not pass it.
   */
  readonly expectedCount?: number
}

const CASES: ReadonlyArray<RuleCase> = [
  {
    rule: "gent/no-positional-log-error",
    invalid: "no-positional-log-error.invalid.ts",
    valid: ["no-positional-log-error.valid.ts"],
    // logWarning and logError, each with an error as a positional argument
    expectedCount: 2,
  },
  {
    rule: "gent/no-runpromise-outside-boundary",
    invalid: "no-runpromise-outside-boundary.invalid.ts",
    valid: ["no-runpromise-outside-boundary-boundary.ts"],
    // 3 Effect statics + 3 runtime instance + 3 nested member access
    expectedCount: 9,
  },
  {
    // A shipped extension reads only the two authoring entries.
    rule: "gent/core-entry-boundary",
    invalid: "packages/extensions/src/core-entry-boundary.invalid.ts",
    valid: ["packages/extensions/src/core-entry-boundary.valid.ts"],
    // protocol, host, test-utils, a core path, two relative paths that resolve
    // into core source, a re-export, an export-all of host, a dynamic import,
    // and a `typeof import` of host
    expectedCount: 10,
  },
  {
    // A client extension also reads protocol; the loader is host code.
    rule: "gent/core-entry-boundary",
    invalid: "apps/tui/src/extensions/core-entry-boundary.invalid.ts",
    valid: ["apps/tui/src/extensions/loader-boundary.ts"],
    // a protocol subpath, host, test-utils, a relative path to core's host,
    // a core re-export, and a dynamic import
    expectedCount: 6,
  },
  {
    // A client extension reaches the TUI only through @gent/tui/extensions;
    // only the builtin roster may name its sibling client extensions.
    rule: "gent/core-entry-boundary",
    invalid: "apps/tui/src/extensions/owner-rule.invalid.client.tsx",
    valid: ["apps/tui/src/extensions/builtins.tsx"],
    // the client provider, the extension host, a host utility, the facet
    // module by path, a type import, a re-export, a dynamic import,
    // `typeof import`, and a sibling client extension
    expectedCount: 9,
  },
  {
    // The TUI host reads no extension module; a client extension owns that view.
    rule: "gent/core-entry-boundary",
    invalid: "apps/tui/src/tui-host-boundary.invalid.ts",
    valid: ["apps/tui/src/tui-host-boundary.valid.ts"],
    // a subpath import, a type import, a re-export of the root, a dynamic import
    expectedCount: 4,
  },
  {
    // A reference extension is held to the same two entries.
    rule: "gent/core-entry-boundary",
    invalid: "examples/extensions/core-entry-boundary.invalid.ts",
    valid: ["examples/extensions/core-entry-boundary.valid.ts"],
    // core source, host, test-utils
    expectedCount: 3,
  },
  {
    // Product code never reads the test entry; tests may.
    rule: "gent/core-entry-boundary",
    invalid: "packages/sdk/src/core-entry-boundary.invalid.ts",
    valid: ["packages/sdk/tests/core-entry-boundary.valid.ts"],
    // an import and a re-export of test-utils, and a relative path that
    // resolves into core's test-utils; the host import is allowed
    expectedCount: 3,
  },
  {
    // A test outside core reads core through its entries, never its source.
    rule: "gent/core-entry-boundary",
    invalid: "packages/extensions/tests/core-entry-boundary.invalid.ts",
    valid: ["packages/extensions/tests/core-entry-boundary.valid.ts"],
    // an import and a re-export that resolve into core source
    expectedCount: 2,
  },
  {
    // Core product code reaches the harness by relative path; still rejected.
    // The harness itself reads its sibling files and core internals.
    rule: "gent/core-entry-boundary",
    invalid: "packages/core/src/runtime/core-entry-boundary.invalid.ts",
    valid: [
      "packages/core/src/runtime/core-entry-boundary.valid.ts",
      "packages/core/src/test-utils/core-entry-boundary.valid.ts",
    ],
    // an import and a re-export that resolve into core's test-utils
    expectedCount: 2,
  },
  {
    // A workspace imports only what its manifest declares, and stays in its root.
    rule: "gent/declared-workspace-imports",
    invalid: "workspaces/core/src/declared-workspace-imports.invalid.ts",
    valid: ["workspaces/sdk/src/declared-workspace-imports.valid.ts"],
    // import, type import, a specifier on a later line, a relative path into
    // the SDK, a re-export, an export-all, import(), require(), typeof import()
    expectedCount: 9,
  },
  {
    rule: "gent/no-define-extension-throw",
    invalid: "no-define-extension-throw.invalid.ts",
    valid: ["no-define-extension-throw.valid.ts"],
    expectedCount: 1,
  },
  {
    rule: "gent/no-dynamic-imports",
    invalid: "no-dynamic-imports.invalid.ts",
    valid: ["no-dynamic-imports.valid.ts"],
    expectedCount: 7,
  },
  {
    rule: "gent/no-promise-control-flow-in-tests",
    invalid: "no-promise-control-flow-in-tests.invalid.test.ts",
    valid: ["no-promise-control-flow-in-tests.valid.test.ts"],
    // four chain methods, one on a capitalised promise variable, and three
    // runPromise edges
    expectedCount: 7,
  },
  {
    rule: "gent/no-promise-control-flow-in-tests",
    invalid: "test-module-control-flow/tests/no-promise-control-flow-in-tests.invalid.module.ts",
    valid: ["test-module-control-flow/tests/no-promise-control-flow-in-tests.valid.module.ts"],
    // `.then`, `.catch` and `.finally` on one chain
    expectedCount: 3,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "no-bun-outside-adapter.invalid.ts",
    // valid file lives at `runtime/gent-platform-bun.ts` — the canonical
    // GentPlatform live impl. That path is the only allowlist entry.
    valid: ["runtime/gent-platform-bun.ts"],
    // 5 Bun.* member expressions + 4 process host probes + 3 os host facts
    expectedCount: 12,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "runtime/retired-adapter.ts",
    valid: ["runtime/fallback-adapter.ts"],
    // Bun.Glob and Bun.randomUUIDv7, banned even in an adapter
    expectedCount: 2,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "packages/sdk/src/host-facts.invalid.ts",
    valid: ["packages/sdk/src/host-facts.valid.ts"],
    // process.platform, process.pid, Bun.spawn: the SDK is not exempt
    expectedCount: 3,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "packages/core/src/runtime/host-facts.invalid.ts",
    valid: ["packages/core/src/runtime/host-facts.valid.ts"],
    // Eight host module imports (os, bun, crypto and url, with and without
    // node:, and a side-effect import), process.cwd and globalThis.process.cwd,
    // a hand-rolled file path, a dynamic import, three require forms, and
    // bare createHash, randomBytes and fileURLToPath calls
    expectedCount: 18,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "packages/extensions/src/host-facts.invalid.ts",
    // The test harness backs the platform, so it is exempt
    valid: ["packages/core/src/test-utils/host-facts.valid.ts"],
    // os import, process.cwd, and bare createHash, randomBytes and fileURLToPath
    expectedCount: 5,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "apps/server/src/main.ts",
    valid: ["apps/server/src/launch.valid.ts"],
    // process.execPath: the server launcher is not exempt
    expectedCount: 1,
  },
  {
    rule: "gent/no-hand-rolled-tagged-union",
    invalid: "no-hand-rolled-tagged-union.invalid.ts",
    valid: ["no-hand-rolled-tagged-union.valid.ts"],
    // 4 hand-rolled `_tag` unions in the invalid fixture
    expectedCount: 4,
  },
  {
    rule: "gent/no-sleep",
    invalid: "no-sleep.invalid.test.ts",
    valid: ["no-sleep.valid.test.ts"],
    // 4 unguarded sleeps + 1 malformed-carveout sleep
    expectedCount: 5,
  },
  {
    rule: "gent/no-die-in-test-helpers",
    invalid: "no-die-in-test-helpers.invalid.test.ts",
    valid: ["no-die-in-test-helpers.valid.test.ts"],
    // 3 unguarded Effect.die/dieMessage + 1 malformed-carveout die
    expectedCount: 4,
  },
  {
    rule: "gent/no-with-wrapper-call",
    invalid: "no-with-wrapper-call.invalid.ts",
    valid: ["no-with-wrapper-call.valid.ts"],
    // Calls: withX(innerCall()), withX(...)(innerCall()), withX(innerCall(), arg),
    // withX(arrow), withX(arg, function). Definitions: an Effect parameter,
    // a curried Effect parameter, a callback parameter, and an Effect parameter
    // inside Effect.fn and inside Effect.fnUntraced.
    expectedCount: 10,
  },
  {
    rule: "gent/no-inert-it",
    invalid: "no-inert-it.invalid.test.ts",
    valid: ["no-inert-it.valid.test.ts"],
    // Arrow body + function reference + the renamed import + a namespace import
    expectedCount: 4,
  },
]

/** Each fixture file once: a run lints a path it is given once, however many cases name it. */
const INVALID_FIXTURES = [...new Set(CASES.map((c) => c.invalid))]
const VALID_FIXTURES = [...new Set(CASES.flatMap((c) => c.valid))]

/** The tests that read the two reports: one pair per rule, then the whole sets. */
const registerRuleCases = (invalidRun: OxlintRun, validRun: OxlintRun): void => {
  for (const c of CASES) {
    it.live(`${c.rule} fires on invalid fixture`, () =>
      Effect.sync(() => {
        // oxlint exits non-zero when ANY fixture has violations — and our
        // invalid set always does, so we just need to assert the per-file
        // diagnostics.
        expect(invalidRun.exitCode).not.toBe(0)
        const fileDiagnostics = filterByFile(invalidRun.report, c.invalid)
        const violations = countViolations(fileDiagnostics, c.rule)
        Option.match(Option.fromNullishOr(c.expectedCount), {
          onNone: () => expect(violations).toBeGreaterThan(0),
          onSome: (expectedCount) => expect(violations).toBe(expectedCount),
        })
      }),
    )

    it.live(`${c.rule} does not fire on valid fixture`, () =>
      Effect.sync(() => {
        // The valid fixture set should produce zero diagnostics overall;
        // exit-code 0 is the global signal. Per-file: zero violations of
        // this specific rule.
        const violations = c.valid.map((file) =>
          countViolations(filterByFile(validRun.report, file), c.rule),
        )
        expect(violations).toEqual(c.valid.map(() => 0))
      }),
    )
  }

  it.live("every fixture file is linted, so a silent one is a pass on evidence", () =>
    Effect.sync(() => {
      // A valid fixture reports nothing either way; only the file count shows
      // that oxlint read it instead of ignoring or missing the path.
      expect(
        [invalidRun.report.number_of_files, validRun.report.number_of_files],
        `stderr:\n${invalidRun.stderr}\n${validRun.stderr}`,
      ).toEqual([INVALID_FIXTURES.length, VALID_FIXTURES.length])
    }),
  )

  it.live("valid fixture set passes oxlint cleanly", () =>
    Effect.sync(() => {
      expect(validRun.exitCode).toBe(0)
      expect(validRun.report.diagnostics.length).toBe(0)
    }),
  )
}

/**
 * Both fixture sets, linted once while this file registers its tests. The
 * per-rule tests exist only when both runs produced a report; otherwise the
 * one test below reports why, instead of every rule failing on a missing
 * report.
 */
const fixtureRuns = Effect.runSyncExit(
  Effect.all([runOxlint(INVALID_FIXTURES), runOxlint(VALID_FIXTURES)]),
)

effectDescribe("custom lint rules", () => {
  it.live("oxlint reports on both fixture sets", () =>
    Exit.match(fixtureRuns, {
      onFailure: (cause) => Effect.failCause(cause),
      onSuccess: () => Effect.void,
    }),
  )

  if (Exit.isSuccess(fixtureRuns)) {
    const [invalidRun, validRun] = fixtureRuns.value
    registerRuleCases(invalidRun, validRun)
  }

  it.live("every rule the plugin defines has a positive and a negative fixture", () =>
    Effect.gen(function* () {
      const covered = new Set(CASES.map((c) => c.rule))
      const uncovered = Object.keys(gentRules.rules)
        .map((name) => `gent/${name}`)
        .filter((rule) => !covered.has(rule))
      expect(uncovered).toEqual([])
      yield* Effect.void
    }),
  )

  it.live("retired all-errors-are-tagged surface is covered by extendsNativeError", () =>
    Effect.gen(function* () {
      const [tsconfigJson, oxlintConfig] = yield* Effect.all(
        [readTypeScriptConfig("tsconfig.json"), readTextFile(".oxlintrc.json")],
        { concurrency: "unbounded" },
      )

      const effectPlugin = Option.fromNullishOr(
        tsconfigJson.compilerOptions.plugins.find(
          (plugin) => plugin.name === "@effect/language-service",
        ),
      )
      const extendsNativeError = Option.flatMap(effectPlugin, (plugin) =>
        Option.flatMap(Option.fromNullishOr(plugin.diagnosticSeverity), (severity) =>
          Option.fromNullishOr(severity.extendsNativeError),
        ),
      )
      expect(Option.getOrElse(extendsNativeError, () => "missing")).toBe("error")

      expect(oxlintConfig).not.toContain("gent/all-errors-are-tagged")
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
