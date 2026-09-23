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
 * oxlint invocation and the valid fixtures in another. Each per-rule test
 * filters the shared report by `filename` instead of re-spawning oxlint.
 *
 * @module
 */

import { expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { describe as effectDescribe, it } from "effect-bun-test"
import {
  runOxlint,
  type Diagnostic,
  type OxlintReport,
  type OxlintRun,
} from "../src/fixture-runner"

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

const LIVE_RULES_REQUIRING_FIXTURES = [
  "gent/no-runpromise-outside-boundary",
  "gent/no-define-extension-throw",
] satisfies ReadonlyArray<string>

interface RuleCase {
  readonly rule: string
  readonly invalid: string
  readonly valid: string
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
    rule: "gent/no-runpromise-outside-boundary",
    invalid: "no-runpromise-outside-boundary.invalid.ts",
    valid: "no-runpromise-outside-boundary-boundary.ts",
    // 3 Effect statics + 3 runtime instance + 3 nested member access
    expectedCount: 9,
  },
  {
    // A shipped extension reads only the two authoring entries.
    rule: "gent/core-entry-boundary",
    invalid: "packages/extensions/src/core-entry-boundary.invalid.ts",
    valid: "packages/extensions/src/core-entry-boundary.valid.ts",
    // protocol, host, test-utils, a core path, two relative paths that resolve
    // into core source, a re-export, an export-all of host, and a dynamic import
    expectedCount: 9,
  },
  {
    // A client extension also reads protocol; the loader is host code.
    rule: "gent/core-entry-boundary",
    invalid: "apps/tui/src/extensions/core-entry-boundary.invalid.ts",
    valid: "apps/tui/src/extensions/loader-boundary.ts",
    // a protocol subpath, host, test-utils, a relative path to core's host,
    // a core re-export, a dynamic import
    expectedCount: 6,
  },
  {
    // The TUI host reads no extension module; a client extension owns that view.
    rule: "gent/core-entry-boundary",
    invalid: "apps/tui/src/tui-host-boundary.invalid.ts",
    valid: "apps/tui/src/tui-host-boundary.valid.ts",
    // a subpath import, a type import, a re-export of the root, a dynamic import
    expectedCount: 4,
  },
  {
    // A reference extension is held to the same two entries.
    rule: "gent/core-entry-boundary",
    invalid: "examples/extensions/core-entry-boundary.invalid.ts",
    valid: "examples/extensions/core-entry-boundary.valid.ts",
    // core source, host, test-utils
    expectedCount: 3,
  },
  {
    // Product code never reads the test entry; tests may.
    rule: "gent/core-entry-boundary",
    invalid: "packages/sdk/src/core-entry-boundary.invalid.ts",
    valid: "packages/sdk/tests/core-entry-boundary.valid.ts",
    // an import and a re-export of test-utils, and a relative path that
    // resolves into core's test-utils; the host import is allowed
    expectedCount: 3,
  },
  {
    // A test outside core reads core through its entries, never its source.
    rule: "gent/core-entry-boundary",
    invalid: "packages/extensions/tests/core-entry-boundary.invalid.ts",
    valid: "packages/extensions/tests/core-entry-boundary.valid.ts",
    // an import and a re-export that resolve into core source
    expectedCount: 2,
  },
  {
    // Core product code reaches the harness by relative path; still rejected.
    rule: "gent/core-entry-boundary",
    invalid: "packages/core/src/runtime/core-entry-boundary.invalid.ts",
    valid: "packages/core/src/runtime/core-entry-boundary.valid.ts",
    // an import and a re-export that resolve into core's test-utils
    expectedCount: 2,
  },
  {
    // The harness itself reads its sibling files and core internals.
    rule: "gent/core-entry-boundary",
    invalid: "packages/core/src/runtime/core-entry-boundary.invalid.ts",
    valid: "packages/core/src/test-utils/core-entry-boundary.valid.ts",
    expectedCount: 2,
  },
  {
    rule: "gent/no-define-extension-throw",
    invalid: "no-define-extension-throw.invalid.ts",
    valid: "no-define-extension-throw.valid.ts",
    expectedCount: 1,
  },
  {
    rule: "gent/no-dynamic-imports",
    invalid: "no-dynamic-imports.invalid.ts",
    valid: "no-dynamic-imports.valid.ts",
    expectedCount: 7,
  },
  {
    rule: "gent/no-promise-control-flow-in-tests",
    invalid: "no-promise-control-flow-in-tests.invalid.test.ts",
    valid: "no-promise-control-flow-in-tests.valid.test.ts",
    expectedCount: 11,
  },
  {
    rule: "gent/no-promise-control-flow-in-tests",
    invalid: "test-module-control-flow/tests/no-promise-control-flow-in-tests.invalid.module.ts",
    valid: "test-module-control-flow/tests/no-promise-control-flow-in-tests.valid.module.ts",
    expectedCount: 10,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "no-bun-outside-adapter.invalid.ts",
    // valid file lives at `runtime/gent-platform-bun.ts` — the canonical
    // GentPlatform live impl. That path is the only allowlist entry.
    valid: "runtime/gent-platform-bun.ts",
    // 5 Bun.* member expressions + 4 process host probes + 3 os host facts
    expectedCount: 12,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "runtime/retired-adapter.ts",
    valid: "runtime/fallback-adapter.ts",
    // Bun.Glob and Bun.randomUUIDv7, banned even in an adapter
    expectedCount: 2,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "packages/sdk/src/host-facts.invalid.ts",
    valid: "packages/sdk/src/host-facts.valid.ts",
    // process.platform, process.pid, Bun.spawn: the SDK is not exempt
    expectedCount: 3,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "apps/server/src/main.ts",
    valid: "apps/server/src/launch.valid.ts",
    // process.execPath: the server launcher is not exempt
    expectedCount: 1,
  },
  {
    rule: "gent/no-hand-rolled-tagged-union",
    invalid: "no-hand-rolled-tagged-union.invalid.ts",
    valid: "no-hand-rolled-tagged-union.valid.ts",
    // 4 hand-rolled `_tag` unions in the invalid fixture
    expectedCount: 4,
  },
  {
    rule: "gent/no-sleep",
    invalid: "no-sleep.invalid.test.ts",
    valid: "no-sleep.valid.test.ts",
    // 4 unguarded sleeps + 1 malformed-carveout sleep
    expectedCount: 5,
  },
  {
    rule: "gent/no-die-in-test-helpers",
    invalid: "no-die-in-test-helpers.invalid.test.ts",
    valid: "no-die-in-test-helpers.valid.test.ts",
    // 3 unguarded Effect.die/dieMessage + 1 malformed-carveout die
    expectedCount: 4,
  },
  {
    rule: "gent/no-with-wrapper-call",
    invalid: "no-with-wrapper-call.invalid.ts",
    valid: "no-with-wrapper-call.valid.ts",
    // Calls: withX(innerCall()), withX(...)(innerCall()), withX(innerCall(), arg),
    // withX(arrow), withX(arg, function). Definitions: an Effect parameter,
    // a curried Effect parameter, a callback parameter, and an Effect parameter
    // inside Effect.fn and inside Effect.fnUntraced.
    expectedCount: 10,
  },
  {
    rule: "gent/no-inert-it",
    invalid: "no-inert-it.invalid.test.ts",
    valid: "no-inert-it.valid.test.ts",
    // Arrow body + function reference + the renamed import
    expectedCount: 3,
  },
]

const assertProcessed = (run: OxlintRun, fixtureFile: string): void => {
  // Sanity: oxlint must have actually loaded the file. A diagnostic-less
  // result on a known-invalid fixture or a `number_of_files` mismatch
  // indicates a config error or ignore-pattern oversight, not a passing
  // test.
  const seen = run.report.diagnostics.some((d) => d.filename === fixtureFile)
  expect(
    seen || run.report.number_of_files >= CASES.length,
    `oxlint did not process fixture "${fixtureFile}". stderr:\n${run.stderr}`,
  ).toBeTrue()
}

effectDescribe("custom lint rules", () => {
  // Memoize the two oxlint invocations so each `it.live` test reuses the
  // result instead of re-spawning oxlint per assertion. Without this,
  // adding a CASES entry adds 2× per-test runs and pushes the suite
  // toward the test budget. `Effect.cached` produces a `Effect<Effect<...>>`
  // — yield once at module init, then reuse the inner effect across tests.
  type Runs = Effect.Effect<readonly [OxlintRun, OxlintRun], Schema.SchemaError>
  interface LoadRunsRef {
    current: Option.Option<Runs>
  }
  const loadRunsRef: LoadRunsRef = { current: Option.none() }
  const loadRuns: Runs = Effect.gen(function* () {
    const cached = loadRunsRef.current
    if (Option.isSome(cached)) return yield* cached.value
    const created = yield* Effect.cached(
      Effect.all([runOxlint(CASES.map((c) => c.invalid)), runOxlint(CASES.map((c) => c.valid))], {
        concurrency: "unbounded",
      }),
    )
    loadRunsRef.current = Option.some(created)
    return yield* created
  })

  for (const c of CASES) {
    it.live(`${c.rule} fires on invalid fixture`, () =>
      Effect.gen(function* () {
        const [invalidRun] = yield* loadRuns
        assertProcessed(invalidRun, c.invalid)
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
      Effect.gen(function* () {
        const [, validRun] = yield* loadRuns
        // The valid fixture set should produce zero diagnostics overall;
        // exit-code 0 is the global signal. Per-file: zero violations of
        // this specific rule.
        const fileDiagnostics = filterByFile(validRun.report, c.valid)
        const violations = countViolations(fileDiagnostics, c.rule)
        expect(violations).toBe(0)
      }),
    )
  }

  it.live("valid fixture set passes oxlint cleanly", () =>
    Effect.gen(function* () {
      const [, validRun] = yield* loadRuns
      expect(validRun.exitCode).toBe(0)
      expect(validRun.report.diagnostics.length).toBe(0)
    }),
  )

  it.live("live custom rules have positive and negative fixtures", () =>
    Effect.gen(function* () {
      const rules = new Map(CASES.map((c) => [c.rule, c]))
      for (const rule of LIVE_RULES_REQUIRING_FIXTURES) {
        const ruleCase = Option.fromNullishOr(rules.get(rule))
        expect(Option.isSome(ruleCase)).toBeTrue()
        if (Option.isSome(ruleCase)) {
          expect(ruleCase.value.invalid).toMatch(/\.invalid/)
          expect(ruleCase.value.valid).toMatch(/\.valid|boundary|platform-bun/)
        }
      }
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
