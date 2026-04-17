/**
 * Lint fixture verification.
 *
 * For each rule scaffolded in C0, runs `oxlint` against a positive fixture
 * (must error) and a negative fixture (must pass). Verifies the rule is
 * actually firing on the cases its docstring claims.
 *
 * Approach: spawn `oxlint` as a child process with `--no-ignore` and
 * `--ignore-pattern=''` so it processes files inside `lint/fixtures/`
 * (which the main config excludes from ordinary runs).
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
}

const REPO_ROOT = pathResolve(import.meta.dir, "..")

const runOxlint = async (fixturePath: string, _ruleId: string): Promise<OxlintReport> => {
  const proc = Bun.spawn(
    ["bunx", "oxlint", "-c", "lint/fixtures/.oxlintrc.json", "--format=json", fixturePath],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, _stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  // oxlint's `default` format writes diagnostics to stderr; `json` writes to stdout
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return JSON.parse(stdout) as OxlintReport
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
    invalid: "lint/fixtures/no-runpromise-outside-boundary.invalid.ts",
    valid: "lint/fixtures/no-runpromise-outside-boundary-boundary.ts",
  },
  {
    rule: "gent/all-errors-are-tagged",
    invalid: "lint/fixtures/all-errors-are-tagged.invalid.ts",
    valid: "lint/fixtures/all-errors-are-tagged.valid.ts",
  },
  {
    rule: "gent/no-define-extension-throw",
    invalid: "lint/fixtures/no-define-extension-throw.invalid.ts",
    valid: "lint/fixtures/no-define-extension-throw.valid.ts",
  },
  {
    rule: "gent/no-r-equals-never-comment",
    invalid: "lint/fixtures/no-r-equals-never-comment.invalid.ts",
    valid: "lint/fixtures/no-r-equals-never-comment.valid.ts",
  },
  {
    rule: "gent/brand-constructor-callers",
    invalid: "lint/fixtures/brand-constructor-callers.invalid.ts",
    valid: "lint/fixtures/brand-constructor-callers.valid.ts",
  },
]

describe("custom lint rules", () => {
  for (const c of CASES) {
    test(`${c.rule} fires on invalid fixture`, async () => {
      const report = await runOxlint(c.invalid, c.rule)
      const violations = countViolations(report, c.rule)
      expect(violations).toBeGreaterThan(0)
    }, 30_000)

    test(`${c.rule} does not fire on valid fixture`, async () => {
      const report = await runOxlint(c.valid, c.rule)
      const violations = countViolations(report, c.rule)
      expect(violations).toBe(0)
    }, 30_000)
  }
})
