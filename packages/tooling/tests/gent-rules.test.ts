/**
 * Lint fixture verification.
 *
 * For each custom oxlint rule in `../src/gent-rules.ts`, runs `oxlint` against
 * a positive fixture (must error) and a negative fixture (must pass). Verifies
 * each rule actually fires on the cases its docstring claims.
 *
 * Fixtures + their dedicated `.oxlintrc.json` live in `../fixtures/`. The
 * fixtures-local config enables every rule under test as `error` so the test
 * needs no CLI flag plumbing.
 *
 * To keep the suite fast, the invalid fixtures are linted in one batched
 * oxlint invocation and the valid fixtures in another, inside one test. The
 * test filters the two reports by `filename` into one row per rule and
 * compares the whole table, so a failure names each rule that is off. When a
 * run produces no report, the test fails with the reason.
 *
 * @module
 */

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { describe as effectDescribe, it } from "effect-bun-test"
import gentRules, {
  isTest,
  isTestCode,
  isTestHarness,
  isShippedSource,
  isTestSupport,
  ruleSubject,
} from "../src/gent-rules"

// ── one oxlint run over a fixture set ───────────────────────────────────────

const DiagnosticSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  rule_id: Schema.optional(Schema.String),
  message: Schema.String,
  filename: Schema.optional(Schema.String),
  labels: Schema.optional(
    Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Int }) })),
  ),
})
type Diagnostic = typeof DiagnosticSchema.Type

const OxlintReportSchema = Schema.Struct({
  diagnostics: Schema.Array(DiagnosticSchema),
  number_of_files: Schema.Int,
})
type OxlintReport = typeof OxlintReportSchema.Type

interface OxlintRun {
  readonly report: OxlintReport
  readonly exitCode: number
  readonly stderr: string
}

/** One oxlint run did not produce a report. */
class OxlintRunError extends Schema.TaggedError<OxlintRunError>()("OxlintRunError", {
  message: Schema.String,
}) {}

/** The fixture directory and its lint config, beside the tests directory that holds `testFile`. */
const fixturesBeside = Effect.fn("fixturesBeside")(function* (testFile: URL) {
  const path = yield* Path.Path
  return {
    dir: yield* path.fromFileUrl(new URL("../fixtures", testFile)),
    config: yield* path.fromFileUrl(new URL("../fixtures/.oxlintrc.json", testFile)),
  }
})

/** The bound on one oxlint run over a fixture set; about a second on an idle machine. */
const OXLINT_RUN_BOUND = "20 seconds"

/** How long an oxlint process may ignore SIGTERM from the closing scope before it gets SIGKILL. */
const OXLINT_KILL_GRACE = "2 seconds"

/** The bound on both fixture runs together, past one run's bound plus its kill grace. */
const FIXTURE_LINT_BOUND = "25 seconds"

/** Bun's timeout for the fixture lint test, past `FIXTURE_LINT_BOUND`. */
const FIXTURE_LINT_BACKSTOP_MS = 30_000

const decodeOxlintReport = Schema.decodeUnknownEffect(Schema.fromJsonString(OxlintReportSchema))

/**
 * Lint a fixture set in one oxlint process with a JSON report. Its own bound
 * is the only bound: an overrun is one `OxlintRunError` that names the bound,
 * and the run's scope kills the process, not a test timeout mid-report. The
 * kill escalates to SIGKILL after `OXLINT_KILL_GRACE`, so a process that
 * ignores SIGTERM cannot hold the scope open.
 */
const runOxlint = (
  fixtureFiles: ReadonlyArray<string>,
  /** Where to lint from: the fixture directory and its config by default. */
  at: Option.Option<{ readonly dir: string; readonly config: string }> = Option.none(),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixtures = yield* Option.match(at, {
        onNone: () => fixturesBeside(new URL(import.meta.url)),
        onSome: Effect.succeed,
      })
      const handle = yield* ChildProcess.make(
        "bunx",
        ["oxlint", "--format=json", "-c", fixtures.config, ...fixtureFiles],
        { cwd: fixtures.dir, forceKillAfter: OXLINT_KILL_GRACE },
      )
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          handle.exitCode,
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
        ],
        { concurrency: "unbounded" },
      )
      const report = yield* decodeOxlintReport(stdout).pipe(
        Effect.mapError(
          (error) =>
            new OxlintRunError({
              message: `oxlint exited ${exitCode} without a JSON report: ${error.message}\nstderr:\n${stderr}`,
            }),
        ),
      )
      return { report, exitCode: Number(exitCode), stderr } satisfies OxlintRun
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: OXLINT_RUN_BOUND,
      orElse: () =>
        Effect.fail(
          new OxlintRunError({
            message: `oxlint did not lint ${fixtureFiles.length} fixture files within ${OXLINT_RUN_BOUND}`,
          }),
        ),
    }),
  )

// ── each rule against its fixtures ──────────────────────────────────────────

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
    rule: "gent/no-code-unit-padding",
    invalid: "apps/tui/src/no-code-unit-padding.invalid.ts",
    valid: ["apps/tui/src/no-code-unit-padding.valid.ts"],
    expectedCount: 15,
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
    // Only core's actual authoring entry receives the entry exemption.
    rule: "gent/core-entry-boundary",
    invalid: "examples/extensions/api.ts",
    valid: ["packages/core/src/extensions/api.ts"],
    expectedCount: 2,
  },
  {
    // An extension's filename gives it no host privilege.
    rule: "gent/core-entry-boundary",
    invalid: "examples/extensions/branch-tools.ts",
    valid: ["packages/core/src/extensions/branch-tools.ts"],
    expectedCount: 2,
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
    // A child-session writer admits the depth in its own function, first.
    rule: "gent/child-session-writer-admits",
    invalid: "packages/core/src/server/child-session-writer-admits.invalid.ts",
    valid: [
      "packages/core/src/server/child-session-writer-admits.valid.ts",
      "packages/core/src/storage/child-session-writer-admits.valid.ts",
      "packages/core/src/test-utils/child-session-writer-admits.valid.ts",
    ],
    // no admission, sibling/nested/late admission, renamed constructor,
    // two static string keys and a shadowed admission helper
    expectedCount: 9,
  },
  {
    // Shipped source only: a test may compare whole encodes.
    rule: "gent/no-identity-encode",
    invalid: "packages/core/src/runtime/no-identity-encode.invalid.ts",
    valid: [
      "packages/core/src/runtime/no-identity-encode.valid.ts",
      "packages/core/tests/no-identity-encode.valid.ts",
    ],
    // four identity names, a comparison, `.has` and `.add`, three arrays that
    // carry an object, the unsafe side of a mixed comparison, a binding
    // broken across lines, an encoder called where it is built, and three
    // in-place structs with a field of open or unknown encoding
    expectedCount: 16,
  },
  {
    // A TUI reactive scope tracks the session identity; a handler, a JSX
    // expression and an emitter listener read the record.
    rule: "gent/no-tracked-session-record",
    invalid: "apps/tui/src/no-tracked-session-record.invalid.tsx",
    valid: ["apps/tui/src/no-tracked-session-record.valid.tsx"],
    // an `on` source, a createEffect body, a createMemo, a read past twelve
    // lines into an effect, an aliased accessor, a function handed to `on` by
    // name, a function a tracked scope calls, a createResource source, and a
    // callback an array method runs in a tracked scope, a deps-array source, a
    // function called where it is built, resource source read by name,
    // aliased/namespace trackers, deps/resource source/batch, and a lexically distinct helper
    expectedCount: 19,
  },
]

/** Each fixture file once: a run lints a path it is given once, however many cases name it. */
const INVALID_FIXTURES = [...new Set(CASES.map((c) => c.invalid))]
const VALID_FIXTURES = [...new Set(CASES.flatMap((c) => c.valid))]

/**
 * One row per rule: whether it fires on its invalid fixture, the count when
 * the case pins one, and its violations in each valid fixture.
 */
const ruleRows = (invalidRun: OxlintRun, validRun: OxlintRun) =>
  CASES.map((c) => {
    const violations = countViolations(filterByFile(invalidRun.report, c.invalid), c.rule)
    return {
      rule: c.rule,
      fires: violations > 0,
      count: Option.match(Option.fromNullishOr(c.expectedCount), {
        onNone: () => "unpinned",
        onSome: () => String(violations),
      }),
      valid: c.valid.map((file) => countViolations(filterByFile(validRun.report, file), c.rule)),
    }
  })

/** The rows every rule must produce. */
const expectedRows = CASES.map((c) => ({
  rule: c.rule,
  fires: true,
  count: Option.match(Option.fromNullishOr(c.expectedCount), {
    onNone: () => "unpinned",
    onSome: (expectedCount) => String(expectedCount),
  }),
  valid: c.valid.map(() => 0),
}))

effectDescribe("custom lint rules", () => {
  it.scopedLive(
    "staged fixer routing excludes broken fixtures while keeping the gamut driver",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const repo = yield* path.fromFileUrl(new URL("../../..", import.meta.url))
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-hook-routing-" })
        const fixturePaths = [
          "packages/tooling/fixtures/examples/extensions/api.ts",
          "testbeds/gamut/fixture/src/domain/money.ts",
        ]
        const productPaths = ["testbeds/gamut/gamut.ts", "testbeds/gamut/tests/gamut.test.ts"]
        const files = [...fixturePaths, ...productPaths]
        yield* Effect.forEach(files, (file) =>
          fs
            .makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(path.join(root, file), ""))),
        )
        const config = yield* fs.readFileString(path.join(repo, "lefthook.yml"))
        // Keep the actual job hierarchy and exclusions. Observe the operands
        // instead of running source fixers against deliberately invalid files.
        yield* fs.writeFileString(
          path.join(root, "lefthook.yml"),
          config.replace(/^([ \t]*run:).*\{staged_files\}.*$/gm, "$1 echo {staged_files}"),
        )
        const init = yield* ChildProcess.make("git", ["init", "--quiet"], {
          cwd: root,
          forceKillAfter: OXLINT_KILL_GRACE,
        })
        expect(Number(yield* init.exitCode)).toBe(0)
        const handle = yield* ChildProcess.make(
          path.join(repo, "node_modules/.bin/lefthook"),
          [
            "run",
            "pre-commit",
            "--job=lint+fmt",
            "--no-auto-install",
            "--no-stage-fixed",
            "--no-tty",
            ...files.flatMap((file) => ["--file", file]),
          ],
          { cwd: root, forceKillAfter: OXLINT_KILL_GRACE },
        )
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
          ],
          { concurrency: 3 },
        )
        expect(Number(exitCode), stderr).toBe(0)
        for (const file of fixturePaths) expect(stdout).not.toContain(file)
        for (const file of productPaths) expect(stdout).toContain(file)
      }).pipe(Effect.timeout(FIXTURE_LINT_BOUND), Effect.provide(BunServices.layer)),
    FIXTURE_LINT_BACKSTOP_MS,
  )

  // The two runs go together: each is bounded by OXLINT_RUN_BOUND plus
  // OXLINT_KILL_GRACE, the test by FIXTURE_LINT_BOUND, and bun by
  // FIXTURE_LINT_BACKSTOP_MS, each longer than the one before, so a stuck run
  // fails inside Effect with its finalizers run, never at the bun backstop.
  it.live(
    "each rule fires on its invalid fixture and stays silent on its valid ones",
    () =>
      Effect.gen(function* () {
        const [invalidRun, validRun] = yield* Effect.all(
          [runOxlint(INVALID_FIXTURES), runOxlint(VALID_FIXTURES)],
          { concurrency: 2 },
        )
        // oxlint exits non-zero when any fixture has violations, and the
        // invalid set always does.
        expect(invalidRun.exitCode).not.toBe(0)
        expect(ruleRows(invalidRun, validRun)).toEqual(expectedRows)
        // A valid fixture reports nothing either way; only the file count shows
        // that oxlint read it instead of ignoring or missing the path.
        expect(
          [invalidRun.report.number_of_files, validRun.report.number_of_files],
          `stderr:\n${invalidRun.stderr}\n${validRun.stderr}`,
        ).toEqual([INVALID_FIXTURES.length, VALID_FIXTURES.length])
        expect(validRun.exitCode).toBe(0)
        expect(validRun.report.diagnostics.length).toBe(0)
      }).pipe(Effect.timeout(FIXTURE_LINT_BOUND), Effect.provide(BunServices.layer)),
    FIXTURE_LINT_BACKSTOP_MS,
  )

  it.live("the fixtures are found from a checkout whose path has a space", () =>
    Effect.gen(function* () {
      const testFile = new URL("file:///work/gent%20checkout/packages/tooling/tests/a.test.ts")
      expect(yield* fixturesBeside(testFile)).toEqual({
        dir: "/work/gent checkout/packages/tooling/fixtures",
        config: "/work/gent checkout/packages/tooling/fixtures/.oxlintrc.json",
      })
    }).pipe(Effect.provide(BunServices.layer)),
  )

  /**
   * The held shapes: each invalid line of a retired gent rule, marked with the
   * rule that holds it now (`// held-by: effect/noGlobals`), under
   * `fixtures/held/` at the path it mirrors. They are linted with the repo's
   * own `.oxlintrc.json`, rooted at a scratch copy of the tree, so the
   * override globs match the mirrored paths; the config's two `./` paths (the
   * preset and the gent plugin) are made absolute. An upgrade or a retirement
   * that stops reporting a line fails here, not at counsel.
   */
  it.scopedLive(
    "every shape a retired gent rule held is still reported by the rule that holds it now",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const repo = yield* path.fromFileUrl(new URL("../../..", import.meta.url))
        const held = yield* path.fromFileUrl(new URL("../fixtures/held", import.meta.url))
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-held-shapes-" })
        yield* fs.copy(held, root)
        yield* fs.symlink(path.join(repo, "node_modules"), path.join(root, "node_modules"))
        const configText = yield* fs.readFileString(path.join(repo, ".oxlintrc.json"))
        yield* fs.writeFileString(
          path.join(root, ".oxlintrc.json"),
          configText.replaceAll('"./', `"${repo}/`),
        )
        const files = (yield* fs.readDirectory(held, { recursive: true }))
          .filter((file) => /\.tsx?$/.test(file))
          .toSorted()
        const expected = (yield* Effect.forEach(files, (file) =>
          Effect.map(fs.readFileString(path.join(held, file)), (text) =>
            text.split("\n").flatMap((line, index) =>
              Option.match(Option.fromNullishOr(/held-by: (\S+)/.exec(line)?.[1]), {
                onNone: () => [],
                onSome: (rule) => [`${file}:${index + 1} ${rule}`],
              }),
            ),
          ),
        )).flat()
        const run = yield* runOxlint(
          files,
          Option.some({ dir: root, config: path.join(root, ".oxlintrc.json") }),
        )
        const reported = new Set(
          run.report.diagnostics.map(
            (d) =>
              `${d.filename ?? ""}:${d.labels?.[0]?.span.line ?? 0} ${(d.code ?? "").replace(/^(\w+)\((.+)\)$/, "$1/$2")}`,
          ),
        )
        expect(expected.length).toBeGreaterThan(90)
        expect(expected.filter((line) => !reported.has(line))).toEqual([])
        const heldRules = new Set(expected.map((line) => line.replace(/:\d+ /, " ")))
        const expectedLines = new Set(expected)
        expect(
          [...reported].filter(
            (line) => heldRules.has(line.replace(/:\d+ /, " ")) && !expectedLines.has(line),
          ),
        ).toEqual([])
      }).pipe(Effect.timeout(FIXTURE_LINT_BOUND), Effect.provide(BunServices.layer)),
    FIXTURE_LINT_BACKSTOP_MS,
  )

  test("every rule the plugin defines has a positive and a negative fixture", () => {
    const covered = new Set(CASES.map((c) => c.rule))
    const uncovered = Object.keys(gentRules.rules)
      .map((name) => `gent/${name}`)
      .filter((rule) => !covered.has(rule))
    expect(uncovered).toEqual([])
  })
})

// ── what is a test ──────────────────────────────────────────────────────────

describe("what is a test", () => {
  const kinds = (file: string) => ({
    test: isTest(file),
    harness: isTestHarness(file),
    code: isTestCode(file),
    support: isTestSupport(file),
  })
  const aTest = { test: true, harness: false, code: true, support: true }
  const harness = { test: false, harness: true, code: true, support: true }
  const supportOnly = { test: false, harness: false, code: false, support: true }
  const product = { test: false, harness: false, code: false, support: false }

  test("a test file, a tests tree and an integration tree are tests", () => {
    expect(kinds("packages/core/tests/runtime/agent-loop.test.ts")).toEqual(aTest)
    expect(kinds("apps/tui/tests/helpers-boundary.ts")).toEqual(aTest)
    expect(kinds("apps/tui/integration/helpers.ts")).toEqual(aTest)
    expect(kinds("/Users/x/gent/apps/tui/integration/helpers.ts")).toEqual(aTest)
  })

  test("the e2e package and core test-utils are the harness", () => {
    expect(kinds("packages/e2e/src/pty-fixture.ts")).toEqual(harness)
    expect(kinds("packages/core/src/test-utils/language-model.ts")).toEqual(harness)
  })

  test("testbeds and lint fixtures are support but not test code", () => {
    expect(kinds("testbeds/gamut/gamut.ts")).toEqual(supportOnly)
    expect(kinds("packages/tooling/fixtures/no-sleep.valid.ts")).toEqual(supportOnly)
  })

  test("a rule judges the path under the lint root, not the directories above it", () => {
    const cwd = "/Users/x/tests/integration/gent"
    const subject = (file: string) => ruleSubject({ filename: `${cwd}/${file}`, cwd })
    expect(kinds(subject("packages/core/src/runtime/agent-loop.ts"))).toEqual(product)
    expect(kinds(subject("packages/core/tests/runtime/agent-loop.test.ts"))).toEqual(aTest)
    expect(ruleSubject({ filename: `${cwd}/packages/core/src/a.ts`, cwd: `${cwd}/` })).toBe(
      "packages/core/src/a.ts",
    )
  })

  test("a lint fixture is judged as the file it mirrors", () => {
    const cwd = "/Users/x/gent"
    expect(
      ruleSubject({
        filename: `${cwd}/packages/tooling/fixtures/packages/core/tests/a.test.ts`,
        cwd,
      }),
    ).toBe("packages/core/tests/a.test.ts")
  })

  test("shipped source is product code under packages/ and apps/, outside tooling and build output", () => {
    expect(isShippedSource("packages/core/src/runtime/agent-loop.ts")).toBe(true)
    expect(isShippedSource("apps/tui/src/main.tsx")).toBe(true)
    expect(isShippedSource("apps/tui/scripts/build.ts")).toBe(true)
    expect(isShippedSource("packages/core/src/test-utils/harness.ts")).toBe(false)
    expect(isShippedSource("packages/e2e/src/pty-fixture.ts")).toBe(false)
    expect(isShippedSource("packages/core/tests/runtime/agent-loop.test.ts")).toBe(false)
    expect(isShippedSource("packages/tooling/src/guards.ts")).toBe(false)
    expect(isShippedSource("packages/extensions/dist/index.js")).toBe(false)
    expect(isShippedSource("testbeds/gamut/gamut.ts")).toBe(false)
    expect(isShippedSource("packages/core/package.json")).toBe(false)
  })

  test("a shipped boundary file is product code", () => {
    expect(kinds("apps/tui/src/extensions/loader-boundary.ts")).toEqual(product)
    expect(kinds("packages/extensions/src/cell-worker-boundary.ts")).toEqual(product)
    expect(kinds("packages/core/src/runtime/agent-loop.ts")).toEqual(product)
  })
})
