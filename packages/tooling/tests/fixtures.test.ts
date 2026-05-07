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
import { Effect } from "effect"
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
    const code = d.code ?? d.rule_id ?? ""
    return code === codeForm || code === ruleId || code.endsWith(`(${tail})`)
  }).length
}

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
    rule: "gent/no-define-extension-throw",
    invalid: "no-define-extension-throw.invalid.ts",
    valid: "no-define-extension-throw.valid.ts",
  },
  {
    rule: "gent/no-r-equals-never-comment",
    invalid: "no-r-equals-never-comment.invalid.ts",
    valid: "no-r-equals-never-comment.valid.ts",
  },
  {
    rule: "gent/brand-constructor-callers",
    invalid: "brand-constructor-callers.invalid.ts",
    valid: "brand-constructor-callers.valid.ts",
  },
  {
    rule: "gent/no-scope-brand-cast",
    invalid: "no-scope-brand-cast.invalid.ts",
    valid: "no-scope-brand-cast.valid.ts",
  },
  {
    rule: "gent/no-make-unsafe",
    invalid: "no-make-unsafe.invalid.ts",
    valid: "no-make-unsafe.valid.ts",
    expectedCount: 3,
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
    expectedCount: 8,
  },
  {
    rule: "gent/no-promise-control-flow-in-tests",
    invalid: "test-module-control-flow/tests/no-promise-control-flow-in-tests.invalid.module.ts",
    valid: "test-module-control-flow/tests/no-promise-control-flow-in-tests.valid.module.ts",
    expectedCount: 10,
  },
  {
    rule: "gent/no-projection-writes",
    invalid: "no-projection-writes.invalid.ts",
    valid: "no-projection-writes.valid.ts",
    // 3 forms × 1 write each = 3 reports
    expectedCount: 3,
  },
  {
    rule: "gent/no-bun-outside-adapter",
    invalid: "no-bun-outside-adapter.invalid.ts",
    // valid file lives at `runtime/gent-platform-bun.ts` — the canonical
    // GentPlatform live impl. That path is the only allowlist entry.
    valid: "runtime/gent-platform-bun.ts",
    // 5 distinct Bun.* member expressions in the invalid fixture
    expectedCount: 5,
  },
  {
    rule: "gent/no-hand-rolled-tagged-union",
    invalid: "no-hand-rolled-tagged-union.invalid.ts",
    valid: "no-hand-rolled-tagged-union.valid.ts",
    // 4 hand-rolled `_tag` unions in the invalid fixture
    expectedCount: 4,
  },
]

const assertProcessed = (run: OxlintRun, fixtureFile: string): void => {
  // Sanity: oxlint must have actually loaded the file. A diagnostic-less
  // result on a known-invalid fixture or a `number_of_files` mismatch
  // indicates a config error or ignore-pattern oversight, not a passing
  // test.
  const seen = run.report.diagnostics.some((d) => d.filename === fixtureFile)
  if (!seen && run.report.number_of_files < CASES.length) {
    throw new Error(`oxlint did not process fixture "${fixtureFile}". stderr:\n${run.stderr}`)
  }
}

effectDescribe("custom lint rules", () => {
  // Memoize the two oxlint invocations so each `it.live` test reuses the
  // result instead of re-spawning oxlint per assertion. Without this,
  // adding a CASES entry adds 2× per-test runs and pushes the suite
  // toward the test budget. `Effect.cached` produces a `Effect<Effect<...>>`
  // — yield once at module init, then reuse the inner effect across tests.
  const loadRunsRef: { current: Effect.Effect<readonly [OxlintRun, OxlintRun]> | undefined } = {
    current: undefined,
  }
  const loadRuns = Effect.gen(function* () {
    if (loadRunsRef.current === undefined) {
      loadRunsRef.current = yield* Effect.cached(
        Effect.all(
          [
            Effect.promise(() => runOxlint(CASES.map((c) => c.invalid))),
            Effect.promise(() => runOxlint(CASES.map((c) => c.valid))),
          ],
          { concurrency: "unbounded" },
        ),
      )
    }
    return yield* loadRunsRef.current
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
        if (c.expectedCount !== undefined) {
          expect(violations).toBe(c.expectedCount)
        } else {
          expect(violations).toBeGreaterThan(0)
        }
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

  it.live("gent/no-bun-outside-adapter allows adapter files", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => runOxlint(["runtime/fallback-adapter.ts"]))
      expect(run.exitCode).toBe(0)
      expect(countViolations(run.report.diagnostics, "gent/no-bun-outside-adapter")).toBe(0)
    }),
  )
})
