/**
 * Lint fixture verification.
 *
 * For each custom oxlint rule scaffolded in C0, runs `oxlint` against a
 * positive fixture (must error) and a negative fixture (must pass). Verifies
 * each rule actually fires on the cases its docstring claims.
 *
 * Fixtures + their dedicated `.oxlintrc.json` live in `../fixtures/`. The
 * fixtures-local config enables every rule under test as `error` so the test
 * needs no CLI flag plumbing.
 *
 * @module
 */

import { describe, expect, test } from "bun:test"
import { resolve as pathResolve } from "node:path"

interface Diagnostic {
  readonly code?: string
  readonly rule_id?: string
  readonly message: string
}

interface OxlintReport {
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly number_of_files: number
}

interface OxlintRun {
  readonly report: OxlintReport
  readonly exitCode: number | null
  readonly stderr: string
}

const FIXTURES_DIR = pathResolve(import.meta.dir, "..", "fixtures")
const FIXTURES_CONFIG = pathResolve(FIXTURES_DIR, ".oxlintrc.json")

const runOxlint = async (fixtureFile: string): Promise<OxlintRun> => {
  const proc = Bun.spawn(["bunx", "oxlint", "-c", FIXTURES_CONFIG, "--format=json", fixtureFile], {
    cwd: FIXTURES_DIR,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const report = JSON.parse(stdout) as OxlintReport
  return { report, exitCode, stderr }
}

const countViolations = (report: OxlintReport, ruleId: string): number => {
  // JSON output writes the rule id as `code: "gent(rule-name)"`. Compare
  // against both that shape and the bare prefixed form for resilience.
  const tail = ruleId.replace(/^gent\//, "")
  const codeForm = `gent(${tail})`
  return report.diagnostics.filter((d) => {
    const code = d.code ?? d.rule_id ?? ""
    return code === codeForm || code === ruleId || code.endsWith(`(${tail})`)
  }).length
}

interface RuleCase {
  readonly rule: string
  readonly invalid: string
  readonly valid: string
}

const CASES: ReadonlyArray<RuleCase> = [
  {
    rule: "gent/no-runpromise-outside-boundary",
    invalid: "no-runpromise-outside-boundary.invalid.ts",
    valid: "no-runpromise-outside-boundary-boundary.ts",
  },
  {
    rule: "gent/all-errors-are-tagged",
    invalid: "all-errors-are-tagged.invalid.ts",
    valid: "all-errors-are-tagged.valid.ts",
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
]

const assertOxlintProcessed = (run: OxlintRun, fixtureFile: string): void => {
  // Sanity: oxlint must have actually loaded the file. A stderr containing
  // "Failed to parse" or `number_of_files: 0` indicates a config error or
  // ignore-pattern oversight, not a passing test.
  if (run.report.number_of_files === 0) {
    throw new Error(`oxlint did not process fixture "${fixtureFile}". stderr:\n${run.stderr}`)
  }
}

describe("custom lint rules", () => {
  for (const c of CASES) {
    test(`${c.rule} fires on invalid fixture`, async () => {
      const run = await runOxlint(c.invalid)
      assertOxlintProcessed(run, c.invalid)
      // oxlint exits non-zero when violations are found
      expect(run.exitCode).not.toBe(0)
      const violations = countViolations(run.report, c.rule)
      expect(violations).toBeGreaterThan(0)
    }, 30_000)

    test(`${c.rule} does not fire on valid fixture`, async () => {
      const run = await runOxlint(c.valid)
      assertOxlintProcessed(run, c.valid)
      expect(run.exitCode).toBe(0)
      const violations = countViolations(run.report, c.rule)
      expect(violations).toBe(0)
    }, 30_000)
  }
})
