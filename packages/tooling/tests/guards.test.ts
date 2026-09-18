import { describe, expect, test } from "bun:test"
import {
  adaptedSeamsIn,
  ASSEMBLY_SITES,
  collectExportFacts,
  type ExportFacts,
  findAliasTestLayers,
  findBannedEslintDisableBlocks,
  findBlanketEslintDisables,
  findCoreFeatureIndependenceFindings,
  findDiagnosticSuppressionAnchors,
  findE2eFixtureImportFindings,
  findHookGuardOrder,
  findPackageSurfaceFindings,
  findPlatformDuplicationViolations,
  findProcessRunnerFindings,
  findReadersWithoutWriters,
  findRetiredReconcilerFindings,
  findSteeringFilePaths,
  findSuppressionInventoryFindings,
  findTuiSessionIdentityReads,
  findUnadaptedSeams,
  findUnadmittedChildSessionWriters,
  findUnconsumedExports,
  findUnenabledPluginRules,
  findUnmatchedOverrideGlobs,
  findUnusedSuppressionApprovals,
  HOOK_FILE,
  isSteeringFile,
  type PackageJson,
  REMOVED_IDENTIFIERS,
  RETIRED_IDENTIFIERS,
  RETIRED_MODULES,
} from "../src/guards"
import { Option } from "effect"

// ── blanket-eslint-disable.test ─────────────────────────────────────────────

const directive = ["eslint", "disable"].join("-")

describe("blanket eslint disable checker", () => {
  test("flags blanket file comments", () => {
    expect(
      findBlanketEslintDisables("sample.ts", `/* ${directive} */\nexport const x = 1`),
    ).toEqual([{ file: "sample.ts", line: 1 }])
  })

  test("flags blanket line comments", () => {
    expect(
      findBlanketEslintDisables(
        "sample.ts",
        [
          "export const x = 1",
          `// ${directive}-next-line -- blanket suppression`,
          "export const y = 2",
        ].join("\n"),
      ),
    ).toEqual([{ file: "sample.ts", line: 2 }])
  })

  test("allows rule-named suppressions", () => {
    expect(
      findBlanketEslintDisables(
        "sample.ts",
        [
          `// ${directive}-next-line @typescript-eslint/no-unsafe-type-assertion -- boundary`,
          "const value = foreign as Local",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags rule-named block comments", () => {
    expect(
      findBannedEslintDisableBlocks(
        "sample.ts",
        `/* ${directive} @typescript-eslint/no-unsafe-type-assertion -- boundary */`,
      ),
    ).toEqual([{ file: "sample.ts", line: 1 }])
  })

  test("allows block comments only in explicit fixture files", () => {
    expect(
      findBannedEslintDisableBlocks(
        "tests/fixtures/bad-suppression.ts",
        `/* ${directive} @typescript-eslint/no-unsafe-type-assertion -- fixture */`,
      ),
    ).toEqual([])
  })
})

// ── core-alias-test-layers.test ─────────────────────────────────────────────

const FILE = "packages/core/src/domain/widget.ts"

const wrap = (member: string): string =>
  `export class Widget extends Context.Tag("Widget")<Widget, WidgetService>() {\n${member}\n}\n`

describe("alias alternative-layer guard", () => {
  test("flags a single-line alias under any alternative name", () => {
    for (const name of ["Test", "Fake", "Stub", "Mock"]) {
      const findings = findAliasTestLayers(
        FILE,
        wrap(`  static ${name} = (): Layer.Layer<Widget> => Widget.Live`),
      )
      expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([`${FILE}:2`])
      expect(findings[0]?.message).toContain(`static ${name}`)
      expect(findings[0]?.message).toContain("Widget.Live")
    }
  })

  test("flags an alias the formatter broke across lines", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap(
        [
          "  static Test = (",
          "    options: WidgetOptions = {},",
          "  ): Layer.Layer<Widget> =>",
          "    Widget.Live",
        ].join("\n"),
      ),
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([`${FILE}:2`])
    expect(findings[0]?.message).toContain("Widget.Live")
  })

  test("flags a property alias that carries no arrow head", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap("  static Fake: Layer.Layer<Widget> = Widget.Live"),
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([`${FILE}:2`])
    expect(findings[0]?.message).toContain("static Fake")
  })

  test("leaves a member name outside the alternative table alone", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap("  static Memory: Layer.Layer<Widget> = Widget.Live"),
    )
    expect(findings).toEqual([])
  })

  test("accepts an alternative that builds its own implementation", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap(
        [
          "  static Test = (): Layer.Layer<Widget> =>",
          "    Layer.succeed(",
          "      Widget,",
          "      Widget.of({",
          "        read: Effect.succeed(0),",
          "      }),",
          "    )",
        ].join("\n"),
      ),
    )
    expect(findings).toEqual([])
  })

  test("accepts an alternative that delegates to a sibling that is not Live", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap("  static Test = (): Layer.Layer<Widget> => Widget.fromResolved(resolveWidgets([]))"),
    )
    expect(findings).toEqual([])
  })

  test("accepts a following member that does alias Live in a later class", () => {
    const findings = findAliasTestLayers(
      FILE,
      wrap(
        [
          "  static Test = (): Layer.Layer<Widget> =>",
          "    Layer.succeed(Widget, Widget.of({ read: Effect.succeed(0) }))",
          "",
          "  static describe = (): string => `Widget.Live`",
        ].join("\n"),
      ),
    )
    expect(findings).toEqual([])
  })

  test("flags an alias in an app source tree, not only a package one", () => {
    const file = "apps/tui/src/services/widget.ts"
    const findings = findAliasTestLayers(
      file,
      wrap("  static Test = (): Layer.Layer<Widget> => Widget.Live"),
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([`${file}:2`])
    expect(findings[0]?.message).toContain("Widget.Live")
  })

  test("ignores files outside a shipped source tree", () => {
    const member = "  static Test = (): Layer.Layer<Widget> => Widget.Live"
    expect(findAliasTestLayers("packages/core/tests/domain/widget.test.ts", wrap(member))).toEqual(
      [],
    )
    expect(findAliasTestLayers("apps/tui/tests/services/widget.test.ts", wrap(member))).toEqual([])
    expect(findAliasTestLayers("scripts/widget.ts", wrap(member))).toEqual([])
    expect(findAliasTestLayers("ARCHITECTURE.md", wrap(member))).toEqual([])
  })
})

// ── core-child-session-depth.test ───────────────────────────────────────────

const childWriter = `
yield* sessionStorage.createSession(
  new Session({
    id: sessionId,
    parentSessionId: input.parentSessionId,
    parentBranchId: input.parentBranchId,
    createdAt: now,
    updatedAt: now,
  }),
)
`

describe("child-session depth guard", () => {
  test("flags a core writer that nests a session without the shared admission", () => {
    const findings = findUnadmittedChildSessionWriters(
      "packages/core/src/server/server.ts",
      childWriter,
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "packages/core/src/server/server.ts:3",
    ])
    expect(findings[0]?.message).toContain("admitChildSessionDepth")
  })

  test("accepts a writer once the file calls the shared admission", () => {
    const findings = findUnadmittedChildSessionWriters(
      "packages/core/src/server/server.ts",
      `yield* admitChildSessionDepth(input.parentSessionId)\n${childWriter}`,
    )
    expect(findings).toEqual([])
  })

  test("flags a writer in runtime/session.ts whose own declaration never admits", () => {
    const text = [
      "export const admitChildSessionDepth = Effect.fn(function* (parentSessionId) {",
      "  yield* admitChildSessionDepth(parentSessionId)",
      "})",
      "",
      "export const forkSession = Effect.fn(function* (input) {",
      childWriter,
      "})",
    ].join("\n")
    const findings = findUnadmittedChildSessionWriters("packages/core/src/runtime/session.ts", text)
    expect(findings.map((finding) => finding.line)).toEqual([8])
  })

  test("an admission in an earlier declaration does not cover a later writer", () => {
    const text = `export const admitted = Effect.fn(function* () {\n  yield* admitChildSessionDepth(id)\n})\n\nexport const unadmitted = Effect.fn(function* () {${childWriter}})`
    const findings = findUnadmittedChildSessionWriters("packages/core/src/server/server.ts", text)
    expect(findings).toHaveLength(1)
  })

  test("ignores a root session row", () => {
    const findings = findUnadmittedChildSessionWriters(
      "packages/core/src/server/server.ts",
      "new Session({ id, name, createdAt: now, updatedAt: now })",
    )
    expect(findings).toEqual([])
  })

  test("ignores storage readers, test fixtures, and files outside core", () => {
    for (const file of [
      "packages/core/src/storage/schema.ts",
      "packages/core/src/test-utils/index.ts",
      "packages/extensions/src/thread/thread.ts",
      "apps/tui/tests/components/thread-view.test.tsx",
    ]) {
      expect(findUnadmittedChildSessionWriters(file, childWriter)).toEqual([])
    }
  })
})

// ── core-feature-independence.test ──────────────────────────────────────────

const CELL_IMPORT = 'import { CellExecution } from "../cell/cell-execution.js"'

describe("core feature independence guard", () => {
  test("flags a core file that imports a feature directory", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/agent-loop.ts",
      CELL_IMPORT,
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "packages/core/src/runtime/agent-loop.ts:1",
    ])
    expect(findings[0]?.message).toContain("cell")
  })

  test("flags a type-only import, which still names the feature", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/session.ts",
      'import type { DispatchingToolStorage } from "./cell/dispatching-tool-storage.js"',
    )
    expect(findings.length).toBe(1)
  })

  test("allows a feature to import itself", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/cell/cell-storage.ts",
      'import { CellExecution } from "./cell-execution.js"',
    )
    expect(findings).toEqual([])
  })

  test("allows the sites that assemble an application", () => {
    for (const site of ASSEMBLY_SITES) {
      expect(findCoreFeatureIndependenceFindings(site, CELL_IMPORT)).toEqual([])
    }
  })

  test("ignores files outside core", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/extensions/src/some-extension.ts",
      CELL_IMPORT,
    )
    expect(findings).toEqual([])
  })

  test("ignores a mention that is not an import", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/tools.ts",
      "// the cell feature dispatches inner tool calls",
    )
    expect(findings).toEqual([])
  })
  test("flags core naming a table the cell owns", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/storage/schema.ts",
      "    CREATE TABLE cell_executions (",
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain("feature-migrations seam")
  })

  test("lets the cell name its own tables", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/cell/cell-storage.ts",
      "    CREATE TABLE cell_executions (",
    )
    expect(findings).toEqual([])
  })

  test("lets a cell file import a sibling through the feature directory name", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/cell/cell-storage.ts",
      'import { CellExecution } from "../cell/cell-execution.js"',
    )
    expect(findings).toEqual([])
  })

  test("ignores a kernel table whose name is not a feature's", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/storage/schema.ts",
      "    CREATE TABLE sessions (",
    )
    expect(findings).toEqual([])
  })
})

// ── core-process-runner.test ────────────────────────────────────────────────

describe("process runner guard", () => {
  test("flags every removed identifier once per line", () => {
    for (const name of REMOVED_IDENTIFIERS) {
      const findings = findProcessRunnerFindings(
        "packages/core/src/runtime/extension-host.ts",
        `const runner = ${name}`,
      )
      expect(findings.length).toBe(1)
      expect(findings[0]?.message).toContain(name)
    }
  })

  test("flags a test that builds the removed layer", () => {
    const findings = findProcessRunnerFindings(
      "packages/core/tests/runtime/session-runtime.test.ts",
      'import { ProcessRunnerLive } from "../../src/runtime/run-process"',
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "packages/core/tests/runtime/session-runtime.test.ts:1",
    ])
  })

  test("scans apps source as well as packages", () => {
    expect(
      findProcessRunnerFindings("apps/tui/src/services/boundary.ts", "yield* ProcessRunner").length,
    ).toBe(1)
  })

  test("leaves InProcessRunner and runProcess alone", () => {
    expect(
      findProcessRunnerFindings(
        "packages/core/src/server/server.ts",
        'import { InProcessRunner } from "../runtime/agent/agent-runner.js"',
      ),
    ).toEqual([])
    expect(
      findProcessRunnerFindings(
        "packages/core/src/runtime/extension-host.ts",
        "runProcess: (command, args, options) => runProcess(command, args, options)",
      ),
    ).toEqual([])
  })

  test("ignores docs, plans and the tooling package itself", () => {
    expect(findProcessRunnerFindings("ARCHITECTURE.md", "ProcessRunner")).toEqual([])
    expect(findProcessRunnerFindings("plans/arch-core.md", "ProcessRunnerLive")).toEqual([])
    expect(findProcessRunnerFindings("packages/tooling/src/guards.ts", "ProcessRunner")).toEqual([])
    expect(
      findProcessRunnerFindings("packages/tooling/tests/guards.test.ts", "ProcessRunner"),
    ).toEqual([])
  })
})

// ── core-retired-reconciler.test ────────────────────────────────────────────

describe("retired reconciler guard", () => {
  test("flags a shipped file that imports a retired module", () => {
    const findings = findRetiredReconcilerFindings(
      "packages/core/src/runtime/extension-host.ts",
      'import { ResourceGraphHost } from "./extensions/resource-host/resource-graph-host.js"',
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "packages/core/src/runtime/extension-host.ts:1",
    ])
    expect(findings[0]?.message).toContain("resource-graph-host")
  })

  test("flags every retired identifier once per line", () => {
    for (const name of RETIRED_IDENTIFIERS) {
      const findings = findRetiredReconcilerFindings(
        "packages/extensions/src/cell/cell-dispatch.ts",
        `const value = ${name}.make()`,
      )
      expect(findings.length).toBe(1)
      expect(findings[0]?.message).toContain(name)
    }
  })

  test("matches whole identifiers only", () => {
    const findings = findRetiredReconcilerFindings(
      "packages/core/src/domain/extension.ts",
      "export const ResourceId = Schema.NonEmptyString.pipe(Schema.brand('ResourceId'))",
    )
    expect(findings).toEqual([])
  })

  test("matches retired modules by basename, not by substring", () => {
    for (const module of RETIRED_MODULES) {
      expect(
        findRetiredReconcilerFindings(
          "apps/server/src/main.ts",
          `import { x } from "../../packages/core/src/${module}.js"`,
        ).length,
      ).toBe(1)
    }
    expect(
      findRetiredReconcilerFindings(
        "packages/core/src/runtime/extension-host.ts",
        'import { buildResourceLayer } from "./extensions/resource-host/resource-layer.js"',
      ),
    ).toEqual([])
  })

  test("ignores tests and docs", () => {
    expect(
      findRetiredReconcilerFindings(
        "packages/core/tests/runtime/session-profile.test.ts",
        "const host = ResourceGraphHost",
      ),
    ).toEqual([])
    expect(findRetiredReconcilerFindings("ARCHITECTURE.md", "ResourceGraphHost")).toEqual([])
  })
})

// ── core-unadapted-seams.test ───────────────────────────────────────────────

const SEAMS_FILE = "packages/core/src/domain/extension.ts"

const facetsSource = `export interface ExtensionContextService {
  readonly extensionId: ExtensionId
  readonly cwd: string
  readonly Files: ExtensionFilesService
  readonly Telepathy: ExtensionTelepathyService
}
`

const scopeSource = `export type ResourceScope = "process" | "branch"
`

describe("unadapted seam guard", () => {
  test("reads facets from a yielded context and scopes from a resource definition", () => {
    const seams = adaptedSeamsIn(
      "packages/extensions/src/notes/index.ts",
      `const ctx = yield* ExtensionContext
       yield* ctx.Files.read("notes.md")
       defineResource({ id: "notes", scope: "process", layer })`,
    )
    expect([...seams].sort()).toEqual(["Files", "process"])
  })

  test("a facet nothing reaches is reported", () => {
    const findings = findUnadaptedSeams(new Map([[SEAMS_FILE, facetsSource]]), new Set(["Files"]))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('extension context facet "Telepathy"')
    expect(findings[0]?.line).toBe(5)
  })

  test("plain context facts are not seams", () => {
    // `extensionId` and `cwd` are data an extension reads, not facades it
    // reaches through. Reporting them would make the guard unusable.
    const findings = findUnadaptedSeams(
      new Map([[SEAMS_FILE, facetsSource]]),
      new Set(["Files", "Telepathy"]),
    )
    expect(findings).toHaveLength(0)
  })

  test("a resource scope nothing declares is reported", () => {
    const findings = findUnadaptedSeams(new Map([[SEAMS_FILE, scopeSource]]), new Set(["process"]))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('resource scope "branch"')
  })

  test("a resource scope named like an extension load scope is not credited by one", () => {
    // Both concepts spell the field `scope:`, so a load-scope site would
    // silently satisfy a same-named resource scope. Such a name is skipped
    // rather than reported as filled by something that never filled it.
    const findings = findUnadaptedSeams(
      new Map([[SEAMS_FILE, `export type ResourceScope = "process" | "builtin"\n`]]),
      new Set(["process"]),
    )
    expect(findings).toHaveLength(0)
  })

  test("test files never count as adapters", () => {
    expect(adaptedSeamsIn("packages/extensions/tests/notes.test.ts", "ctx.Telepathy").size).toBe(0)
  })
})

// ── e2e-fixture-imports.test ────────────────────────────────────────────────

const noFixtureSource = [
  'import { describe, expect, it } from "effect-bun-test"',
  'import { Effect } from "effect"',
  'import { Gent } from "@gent/sdk"',
  'import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/fixtures"',
].join("\n")

describe("e2e fixture import guard", () => {
  test("ignores test files outside packages/e2e", () => {
    expect(
      findE2eFixtureImportFindings("packages/sdk/tests/server.test.ts", noFixtureSource),
    ).toEqual([])
  })

  test("ignores e2e helpers that are not test files", () => {
    expect(
      findE2eFixtureImportFindings("packages/e2e/tests/test-failure-boundary.ts", noFixtureSource),
    ).toEqual([])
  })

  test("accepts a single-line pty fixture import", () => {
    expect(
      findE2eFixtureImportFindings(
        "packages/e2e/tests/e2e.test.ts",
        `${noFixtureSource}\nimport { seedAndSpawn } from "../src/pty-fixture"\n`,
      ),
    ).toEqual([])
  })

  test("accepts a multi-line server process fixture import", () => {
    expect(
      findE2eFixtureImportFindings(
        "packages/e2e/tests/server-lifecycle.test.ts",
        `${noFixtureSource}\nimport {\n  killProcess,\n  spawnServer,\n} from "../src/server-process-fixture.js"\n`,
      ),
    ).toEqual([])
  })

  test("flags an e2e test file that imports neither fixture", () => {
    expect(
      findE2eFixtureImportFindings(
        "packages/e2e/tests/workspace-isolation.test.ts",
        noFixtureSource,
      ),
    ).toEqual([
      {
        file: "packages/e2e/tests/workspace-isolation.test.ts",
        line: 1,
        message:
          "e2e test files must import ../src/server-process-fixture or ../src/pty-fixture; an in-process test belongs in the owning package's tests/",
      },
    ])
  })

  test("does not accept the fixture path inside a comment or string body", () => {
    expect(
      findE2eFixtureImportFindings(
        "packages/e2e/tests/notes.test.ts",
        `${noFixtureSource}\n// see ../src/pty-fixture\nconst hint = "../src/server-process-fixture"\n`,
      ),
    ).toHaveLength(1)
  })
})

// ── hook-guard-order.test ───────────────────────────────────────────────────

const messagesOf = (text: string, file = HOOK_FILE): ReadonlyArray<string> =>
  findHookGuardOrder(file, text).map((finding) => finding.message)

const hook = (...jobs: ReadonlyArray<string>): string =>
  ["pre-commit:", "  parallel: false", "  jobs:", ...jobs].join("\n")

const GUARDS = ["    - name: guards", "      run: bun run guards"]
const LINT = [
  "    - name: lint+fmt",
  "      run: bun run lint:fix && bun run fmt",
  "      stage_fixed: true",
]
const TEST = ["    - name: test", "      run: bun run test"]

describe("pre-commit guard order", () => {
  test("allows the guards as the first job", () => {
    expect(messagesOf(hook(...GUARDS, ...LINT, ...TEST))).toEqual([])
  })

  test("flags the guards running after another job", () => {
    const messages = messagesOf(hook(...LINT, ...GUARDS, ...TEST))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("1 job(s) into the pre-commit hook")
  })

  test("reports the guards job at its own line", () => {
    const findings = findHookGuardOrder(HOOK_FILE, hook(...LINT, ...GUARDS))
    // 3 header lines + 3 lint lines, so the guards entry is line 7.
    expect(findings[0]?.line).toBe(7)
  })

  test("flags a hook with no guards job", () => {
    const messages = messagesOf(hook(...LINT, ...TEST))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("runs no `bun run guards` job")
  })

  test("finds the job by its command, not its name", () => {
    const renamed = ["    - name: fast-checks", "      run: bun run guards"]
    expect(messagesOf(hook(...renamed, ...LINT))).toEqual([])
  })

  test("reads the pre-commit block only", () => {
    const text = [
      "pre-push:",
      "  jobs:",
      "    - name: guards",
      "      run: bun run guards",
      "pre-commit:",
      "  jobs:",
      ...LINT,
    ].join("\n")
    expect(messagesOf(text)).toHaveLength(1)
  })

  test("leaves every other file alone", () => {
    expect(findHookGuardOrder("package.json", hook(...LINT, ...TEST))).toEqual([])
  })
})

// ── lint-config-guards.test ─────────────────────────────────────────────────

const CONFIG = ".oxlintrc.json"
const PLUGIN = "lint/no-direct-env.ts"

const messages = (findings: ReadonlyArray<{ readonly message: string }>): ReadonlyArray<string> =>
  findings.map((finding) => finding.message)

describe("an override must match a tracked file", () => {
  const configFor = (globs: ReadonlyArray<string>) => ({
    overrides: [{ files: globs }],
  })

  test("a glob naming a file that exists is silent", () => {
    const findings = findUnmatchedOverrideGlobs(
      CONFIG,
      `{ "files": ["packages/sdk/src/server.ts"] }`,
      configFor(["packages/sdk/src/server.ts"]),
      ["packages/sdk/src/server.ts", "packages/sdk/src/client.ts"],
    )
    expect(findings).toEqual([])
  })

  test("a glob naming a deleted file is reported", () => {
    // The supervisor.ts override outlived that file and kept a rule off.
    const findings = findUnmatchedOverrideGlobs(
      CONFIG,
      `{\n  "files": ["**/sdk/src/supervisor.ts"]\n}`,
      configFor(["**/sdk/src/supervisor.ts"]),
      ["packages/sdk/src/server.ts"],
    )
    expect(messages(findings)).toEqual([expect.stringContaining("matches no tracked file")])
  })

  test("the finding points at the line the glob sits on", () => {
    const findings = findUnmatchedOverrideGlobs(
      CONFIG,
      `{\n  "overrides": [\n    {\n      "files": ["packages/gone.ts"]\n`,
      configFor(["packages/gone.ts"]),
      ["packages/sdk/src/server.ts"],
    )
    expect(findings.map((finding) => finding.line)).toEqual([4])
  })

  test("a directory glob matches through its subdirectories", () => {
    const findings = findUnmatchedOverrideGlobs(
      CONFIG,
      "{}",
      configFor(["**/tests/**", "**/*.tsx"]),
      ["apps/tui/tests/deep/case.test.ts", "apps/tui/src/app.tsx"],
    )
    expect(findings).toEqual([])
  })
})

describe("a defined rule must be enabled", () => {
  const plugin = `  rules: {
    "no-sleep": {
      create() {},
    },
    "no-make-unsafe": {
      create() {},
    },
  }`

  test("a rule the root config enables is silent", () => {
    const findings = findUnenabledPluginRules(
      PLUGIN,
      plugin,
      new Set(["gent/no-sleep", "gent/no-make-unsafe"]),
    )
    expect(findings).toEqual([])
  })

  test("a rule the root config never enables is reported", () => {
    // no-make-unsafe shipped unenabled, and could not be enabled at all:
    // seven live makeUnsafe calls would have failed it.
    const findings = findUnenabledPluginRules(PLUGIN, plugin, new Set(["gent/no-sleep"]))
    expect(messages(findings)).toEqual([
      expect.stringContaining("`gent/no-make-unsafe` is defined but the root config never enables"),
    ])
  })

  test("the finding points at the line the rule is defined on", () => {
    const findings = findUnenabledPluginRules(PLUGIN, plugin, new Set(["gent/no-sleep"]))
    expect(findings.map((finding) => finding.line)).toEqual([5])
  })
})

describe("a read variable must have a writer", () => {
  test("a variable something in the tree sets is silent", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_CHILD_ID"))\n`],
        ["packages/sdk/src/spawn.ts", `const env = { GENT_CHILD_ID: id }\n`],
      ]),
    )
    expect(findings).toEqual([])
  })

  test("a variable nothing sets is reported", () => {
    // GENT_TRACE_ID outlived its writer and kept an unreachable branch alive.
    const findings = findReadersWithoutWriters(
      new Map([["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`]]),
    )
    expect(messages(findings)).toEqual([
      expect.stringContaining("`GENT_ORPHAN` is read but nothing in the tree sets it"),
    ])
  })

  test("a variable a person sets by hand is allowed, with its reason", () => {
    const findings = findReadersWithoutWriters(
      new Map([["packages/sdk/src/logger.ts", `Config.option(Config.string("GENT_LOG_LEVEL"))\n`]]),
    )
    expect(findings).toEqual([])
  })

  test("only a test sets it, so the production reader is still reported", () => {
    // A test that sets a variable proves the reader works, not that anything
    // in production supplies it.
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_TEST_ONLY"))\n`],
        ["packages/sdk/tests/reader.test.ts", `const env = { GENT_TEST_ONLY: "1" }\n`],
      ]),
    )
    expect(messages(findings)).toEqual([
      expect.stringContaining("`GENT_TEST_ONLY` is read but nothing in the tree sets it"),
    ])
  })

  test("every reader of one dead variable is reported, not just the first", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/a.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`],
        ["packages/sdk/src/b.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`],
      ]),
    )
    expect(findings.map((finding) => finding.file)).toEqual([
      "packages/sdk/src/a.ts",
      "packages/sdk/src/b.ts",
    ])
  })
})

// ── platform-duplication-guards.test ────────────────────────────────────────

describe("platform duplication guards", () => {
  test("ignores docs and tests", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/tests/runtime/example.test.ts",
        "const name = 'TurnEvent'",
      ),
    ).toEqual([])
  })

  test("flags private imports in reference extension examples", () => {
    expect(
      findPlatformDuplicationViolations(
        "examples/extensions/example.ts",
        [
          'import { AgentLoop } from "@gent/core-internal/runtime/agent-loop"',
          'import { Secret } from "@gent/core/src/domain/secret"',
          'import { Builtin } from "@gent/extensions/src/todo"',
          'import { helper } from "../../packages/core/src/domain/helper"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "examples/extensions/example.ts",
        line: 1,
        message: "Reference extensions must use @gent/core/extensions/api, not core internals",
      },
      {
        file: "examples/extensions/example.ts",
        line: 2,
        message: "Reference extensions must import the public extension API, not core source files",
      },
      {
        file: "examples/extensions/example.ts",
        line: 3,
        message:
          "Reference extensions must stand alone instead of importing shipped extension internals",
      },
      {
        file: "examples/extensions/example.ts",
        line: 4,
        message:
          "Reference extensions must not reach out of examples/extensions with relative imports",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "examples/extensions/session-notes.ts",
        'import { defineExtension } from "@gent/core/extensions/api"',
      ),
    ).toEqual([])
  })

  test("flags core-internal imports in shipped extensions", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/cell/cell-storage.ts",
        'import type { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"',
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/cell/cell-storage.ts",
        line: 1,
        message:
          "Shipped extensions must use @gent/core/extensions/api or @gent/core/extensions/branch-tools, not core internals",
      },
    ])

    // The public path is clean.
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/cell/cell-storage.ts",
        'import type { GentPlatform } from "@gent/core/extensions/branch-tools"',
      ),
    ).toEqual([])

    // The Anthropic root is allowlisted: `BunGentPlatformLive` has no public path.
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/anthropic.ts",
        'import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"',
      ),
    ).toEqual([])
  })

  test("flags deleted runtime bridge names in active source", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "const a = ExtensionRuntime",
          "const b = ExtensionTurnControl",
          "const c = TurnEvent",
          "const d = TurnEventUsage",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message: "ExtensionRuntime marker service is deleted; use explicit services",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 2,
        message: "ExtensionTurnControl mailbox is deleted; use the session runtime protocol",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 3,
        message: "TurnEvent duplicates Effect AI response parts",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 4,
        message: "TurnEvent duplicates Effect AI response parts",
      },
    ])
  })

  test("flags deleted storage subtag adapter", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/storage/example.ts",
        "const layer = subTagLayers(base)",
      ),
    ).toEqual([
      {
        file: "packages/core/src/storage/example.ts",
        line: 1,
        message: "Storage subtag adapter is deleted; use SqliteStorage composition roots",
      },
    ])
  })

  test("flags withX effect wrapper helpers", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "export const withThing = <A, E, R>(",
          "  effect: Effect.Effect<A, E, R>,",
          "  value: string,",
          ") => effect.pipe(Effect.annotateLogs({ value }))",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(effect, ...)` wrapper helpers are banned; expose a pipeable provider and call it from `.pipe(...)`",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "export const withThing = <A, E, R>(",
          "  eff: Effect.Effect<A, E, R>,",
          "  value: string,",
          ") => eff.pipe(Effect.annotateLogs({ value }))",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(effect, ...)` wrapper helpers are banned; expose a pipeable provider and call it from `.pipe(...)`",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "export const provideThing =",
          "  (value: string) =>",
          "  <A, E, R>(effect: Effect.Effect<A, E, R>) =>",
          "    effect.pipe(Effect.annotateLogs({ value }))",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags withX callback wrapper helpers", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "const withThing = <A>(",
          "  use: (thing: Thing) => A,",
          ") => runtime.runSync(Effect.map(Thing, use))",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(callback)` wrapper style is banned; expose an Effect value/provider and continue with `.pipe(...)`.",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "const withConnection = <A>(",
          "  baseUrl: string,",
          "  use: (conn: McpConnection) => Effect.Effect<A, ExampleMcpError>,",
          ") => Effect.acquireUseRelease(acquireConnection(baseUrl), use, releaseConnection)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(callback)` wrapper style is banned; expose an Effect value/provider and continue with `.pipe(...)`.",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/file-index/example.ts",
        [
          "const withFallback = (primary: FileIndexService, fallback: FileIndexService): FileIndexService => ({",
          "  getStatus: (path) => primary.getStatus(path),",
          "})",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags withX wrappers around function invocations", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "yield* withWorkspace(submitTurn(operation))",
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(fn(...))` invocation style is banned; call the inner effect and pipe the wrapper (`fn(...).pipe(withX)`).",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "yield* withWorkspace(",
          "  Effect.gen(function* () {",
          "    yield* submitTurn(operation)",
          "  }),",
          ")",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(fn(...))` invocation style is banned; call the inner effect and pipe the wrapper (`fn(...).pipe(withX)`).",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "yield* submitTurn(operation).pipe(provideWorkspace)",
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "yield* run.pipe(withWideEvent(agentRunBoundary(agentName, sessionId)))",
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "yield* run.pipe(",
          "  Effect.tap(() => WideEvent.set({ sessionId, branchId })),",
          "  withWideEvent(WideEventBoundary.rpc('message.send', { requestId })),",
          ")",
        ].join("\n"),
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/storage/example.ts",
        "return yield* sql.withTransaction(saveMessage(message))",
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/openai/codex-transform.ts",
        "const withBody = rewriteCodexBody(withHeaders(req, headers))",
      ),
    ).toEqual([])
  })

  test("flags withX callback invocations", () => {
    expect(
      findPlatformDuplicationViolations(
        "apps/tui/src/platform/path-runtime.ts",
        "const joined = withPath((path) => path.join(...parts))",
      ),
    ).toEqual([
      {
        file: "apps/tui/src/platform/path-runtime.ts",
        line: 1,
        message:
          "`withX(callback)` wrapper style is banned; expose an Effect value/provider and continue with `.pipe(...)`.",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/example/mcp-bridge.ts",
        [
          "withConnection(baseUrl, (conn) =>",
          "  Effect.tryPromise(() => conn.client.callTool({ name: 'execute' })),",
          ")",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/example/mcp-bridge.ts",
        line: 1,
        message:
          "`withX(callback)` wrapper style is banned; expose an Effect value/provider and continue with `.pipe(...)`.",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "yield* effect.pipe(withWideEvent(WideEventBoundary.rpc('message.send')), Effect.tap(() => log()))",
      ),
    ).toEqual([])
  })

  test("flags deleted public actor rpc path", () => {
    expect(findPlatformDuplicationViolations("packages/core/src/server/rpcs/actor.ts", "")).toEqual(
      [
        {
          file: "packages/core/src/server/rpcs/actor.ts",
          line: 1,
          message: "Public actor RPC surface is deleted; use product RPCs",
        },
      ],
    )

    expect(
      findPlatformDuplicationViolations("packages/core/src/server/rpcs/product.ts", ""),
    ).toEqual([])
  })

  test("does not flag the guard source itself", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/tooling/src/guards.ts",
        ["ExtensionRuntime", "ctx.extension.request(ref)", "subTagLayers(base)"].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags session transport dto names only in the transport contract", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/rpc.ts",
        "export class SessionInfo {}",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/rpc.ts",
        line: 1,
        message: "Transport session DTOs mirror domain types",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/domain/example.ts",
        "export class SessionInfo {}",
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/rpc.ts",
        ["export class BranchInfo {}", "const runtime = ExtensionRuntime"].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/rpc.ts",
        line: 1,
        message: "Transport session DTOs mirror domain types",
      },
      {
        file: "packages/core/src/server/rpc.ts",
        line: 2,
        message: "ExtensionRuntime marker service is deleted; use explicit services",
      },
    ])
  })

  test("flags stale in-process extension rpc comments and calls", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/example.ts",
        ["ctx.extension.request(ref)", "// typed RPC helpers"].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/example.ts",
        line: 1,
        message: "In-process extension RPC is deleted; yield services or use public transport",
      },
      {
        file: "packages/extensions/src/example.ts",
        line: 2,
        message: "Host contexts no longer expose typed RPC helpers",
      },
    ])
  })

  test("flags reintroduced GentSpan tracer", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "const span = GentSpan.start()",
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message: "GentSpan tracer is deleted; use @effect/opentelemetry via Tracer service",
      },
    ])
  })

  test("flags destructive storage schema reset", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/storage/example.ts",
        "yield* resetIncompatibleStorageSchema()",
      ),
    ).toEqual([
      {
        file: "packages/core/src/storage/example.ts",
        line: 1,
        message: "Destructive schema reset is deleted; use SqliteMigrator migrations",
      },
    ])
  })

  test("flags LiveFile JSON KV pattern", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "const layer = AuthStorage.LiveFile(path)",
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message: "LiveFile JSON KV pattern is deleted; use KeyValueStore.layerFileSystem",
      },
    ])
  })

  test("flags reintroduced EventStore.Live = EventStore.Memory alias", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/example.ts",
        "EventStore.Live = EventStore.Memory",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/example.ts",
        line: 1,
        message:
          "EventStore.Live = EventStore.Memory alias is deleted; resolve EventStore explicitly per persistence mode",
      },
    ])

    // Direct EventStore.Memory references are legitimate (memory persistence
    // mode, test harness) and must not trip the guard.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/server.ts",
        "persistenceMode === 'memory' ? EventStore.Memory : Layer.provide(EventStoreLive, ...)",
      ),
    ).toEqual([])
  })

  test("flags Bun platform providers outside platform roots", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/server.ts",
        "Layer.provide(Auth.Live(dir), BunPlatformLive)",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/server.ts",
        line: 1,
        message: "Bun platform layers may only be provided by platform roots",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/server-root.ts",
        "const PlatformLayer = Layer.mergeAll(BunCronRuntimeLive, BunGentPlatformLive)",
      ),
    ).toEqual([])
  })

  test("flags deleted agent-loop dispatch infrastructure", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/agent/example.ts",
        [
          "const loops = loopsRef",
          "const semaphores = mutationSemaphoresRef",
          "type Event = LoopDriverEvent",
          "type Handle = LoopHandle",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 1,
        message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 2,
        message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 3,
        message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 4,
        message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
      },
    ])
  })

  test("flags deleted runtime composer scope brands", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/agent/example.ts",
        [
          "const erased = eraseLayer(layer)",
          "const restored = restoreErasedLayer(erased)",
          "type Parent = ServerProfile",
          "type Child = CwdProfile",
          "type Leaf = EphemeralProfile",
          "const service = ServerProfileService",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 1,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 2,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 3,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 4,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 5,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 6,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/child-agents.ts",
        "const layer = Layer.provideMerge(parent, child)",
      ),
    ).toEqual([])
  })

  test("flags deleted runtime composer module paths", () => {
    expect(findPlatformDuplicationViolations("packages/core/src/runtime/composer.ts", "")).toEqual([
      {
        file: "packages/core/src/runtime/composer.ts",
        line: 1,
        message: "Legacy runtime composer modules are deleted; use owner-local layer composition",
      },
    ])
    expect(
      findPlatformDuplicationViolations("packages/core/src/runtime/scope-brands.ts", ""),
    ).toEqual([
      {
        file: "packages/core/src/runtime/scope-brands.ts",
        line: 1,
        message: "Legacy runtime composer modules are deleted; use owner-local layer composition",
      },
    ])
    expect(
      findPlatformDuplicationViolations("packages/core/src/runtime/child-agents.ts", ""),
    ).toEqual([])
  })

  test("flags deleted provider test statics outside language-model utilities", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/providers/example.ts",
        [
          "const a = Provider.Sequence([])",
          "const b = Provider.Signal(reply)",
          "const c = Provider.Debug()",
          "const d = Provider.Failing(error)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/providers/example.ts",
        line: 1,
        message:
          "Provider test statics are deleted outside language-model test utilities; use LanguageModelLayers",
      },
      {
        file: "packages/core/src/providers/example.ts",
        line: 2,
        message:
          "Provider test statics are deleted outside language-model test utilities; use LanguageModelLayers",
      },
      {
        file: "packages/core/src/providers/example.ts",
        line: 3,
        message:
          "Provider test statics are deleted outside language-model test utilities; use LanguageModelLayers",
      },
      {
        file: "packages/core/src/providers/example.ts",
        line: 4,
        message:
          "Provider test statics are deleted outside language-model test utilities; use LanguageModelLayers",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/test-utils/language-model.ts",
        "const a = Provider.Sequence([])",
      ),
    ).toEqual([])
  })

  test("flags deleted auth and sdk worker module paths", () => {
    expect(
      findPlatformDuplicationViolations("packages/core/src/domain/auth-storage.ts", ""),
    ).toEqual([
      {
        file: "packages/core/src/domain/auth-storage.ts",
        line: 1,
        message: "Legacy auth domain module is deleted; use domain/auth",
      },
    ])
    expect(findPlatformDuplicationViolations("packages/core/src/runtime/provider.ts", "")).toEqual(
      [],
    )
    expect(findPlatformDuplicationViolations("packages/sdk/src/server-registry.ts", "")).toEqual([
      {
        file: "packages/sdk/src/server-registry.ts",
        line: 1,
        message:
          "SDK worker registry/http split is deleted; use server lock and server entrypoints",
      },
    ])
    expect(findPlatformDuplicationViolations("packages/sdk/src/server.ts", "")).toEqual([])
  })

  test("flags deleted worker port preallocation and lifecycle symbols", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/sdk/src/example.ts",
        [
          "const port = findOpenPort()",
          "const host = WORKER_HOST",
          "type S = WorkerLifecycleState",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/sdk/src/example.ts",
        line: 1,
        message: "Worker port preallocation is deleted; use server-selected ports",
      },
      {
        file: "packages/sdk/src/example.ts",
        line: 2,
        message: "Worker port preallocation is deleted; use server-selected ports",
      },
      {
        file: "packages/sdk/src/example.ts",
        line: 3,
        message: "WorkerLifecycleState is deleted; use the server lifecycle contract",
      },
    ])
  })

  test("flags deleted Bun.Glob fallback", () => {
    expect(
      findPlatformDuplicationViolations(
        "apps/tui/src/utils/example.ts",
        "const glob = new Bun.Glob(pattern)",
      ),
    ).toEqual([
      {
        file: "apps/tui/src/utils/example.ts",
        line: 1,
        message: "Bun.Glob fallback is deleted; use the FileIndex service",
      },
    ])
  })

  test("flags Bun.randomUUIDv7 outside the platform adapter", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/example.ts",
        "const id = Bun.randomUUIDv7()",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/example.ts",
        line: 1,
        message: "Bun.randomUUIDv7 is adapter-only; use GentPlatform.randomId",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        "const id = Bun.randomUUIDv7()",
      ),
    ).toEqual([])
  })

  test("flags deleted extension reactions bucket in active source", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/example.ts",
        "export const Ext = defineExtension({ id: 'x', reactions: {} })",
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/example.ts",
        line: 1,
        message: "Extension lifecycle authoring uses hooks; the reactions bucket is deleted",
      },
    ])
  })

  test("flags host process and OS facts outside the platform adapter", () => {
    expect(
      findPlatformDuplicationViolations(
        "apps/server/src/main.ts",
        [
          "const pid = process.pid",
          "const runtime = process.execPath",
          "process.kill(pid, 'SIGTERM')",
          "const hostname = os.hostname()",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "apps/server/src/main.ts",
        line: 1,
        message: "Host process facts are adapter-only; use GentPlatform",
      },
      {
        file: "apps/server/src/main.ts",
        line: 2,
        message: "Host process facts are adapter-only; use GentPlatform",
      },
      {
        file: "apps/server/src/main.ts",
        line: 3,
        message: "Host process facts are adapter-only; use GentPlatform",
      },
      {
        file: "apps/server/src/main.ts",
        line: 4,
        message: "Host OS facts are adapter-only; use GentPlatform",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        ["const pid = process.pid", "const home = os.homedir()"].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags direct bun package imports in core/extensions sources", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/skills/skills.ts",
        'import { $ } from "bun"',
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/skills/skills.ts",
        line: 1,
        message:
          "Direct `bun` package imports are adapter-only; use ExtensionContext.Process or Effect platform services",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "import { something } from 'bun'",
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "Direct `bun` package imports are adapter-only; use ExtensionContext.Process or Effect platform services",
      },
    ])

    // bun:test, bun:sqlite, and other subpath imports must remain legal
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        ['import { describe } from "bun:test"', 'import { Database } from "bun:sqlite"'].join("\n"),
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        'import { $ } from "bun"',
      ),
    ).toEqual([])
  })

  test("flags protected package working directory and OS module facts", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "const cwd = process.cwd()",
          "const fallback = globalThis.process.cwd()",
          'import os from "node:os"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "Host working directory facts are adapter-only; use RuntimeEnvironment or GentPlatform",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 2,
        message:
          "Host working directory facts are adapter-only; use RuntimeEnvironment or GentPlatform",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 3,
        message: "Host OS module imports are adapter-only; use GentPlatform",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/bad.ts",
        ['import os from "os"', "const cwd = process.cwd()"].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/bad.ts",
        line: 1,
        message: "Host OS module imports are adapter-only; use GentPlatform",
      },
      {
        file: "packages/extensions/src/bad.ts",
        line: 2,
        message:
          "Host working directory facts are adapter-only; use RuntimeEnvironment or GentPlatform",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        ['import os from "node:os"', "const cwd = process.cwd()"].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags protected node:crypto and node:url module imports", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/storage/example.ts",
        [
          'import { createHash } from "node:crypto"',
          'import { fileURLToPath } from "node:url"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/storage/example.ts",
        line: 1,
        message:
          "Host crypto module imports are adapter-only; yield GentPlatform and call platform.hash(...) or platform.randomBytes(...)",
      },
      {
        file: "packages/core/src/storage/example.ts",
        line: 2,
        message:
          "Host url module imports are adapter-only; yield GentPlatform and call platform.fileURLToPath(...)",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/bad.ts",
        ['import { randomBytes } from "crypto"', 'import { fileURLToPath } from "url"'].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/bad.ts",
        line: 1,
        message:
          "Host crypto module imports are adapter-only; yield GentPlatform and call platform.hash(...) or platform.randomBytes(...)",
      },
      {
        file: "packages/extensions/src/bad.ts",
        line: 2,
        message:
          "Host url module imports are adapter-only; yield GentPlatform and call platform.fileURLToPath(...)",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        [
          'import { createHash, randomBytes } from "node:crypto"',
          'import { fileURLToPath } from "node:url"',
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags every acquisition form for crypto/url specifiers", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          'import "node:crypto"',
          'const c = await import("node:crypto")',
          'const u = require("node:url")',
          'const s = require("url")',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "Host crypto module imports are adapter-only; yield GentPlatform and call platform.hash(...) or platform.randomBytes(...)",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 2,
        message:
          "Host crypto module imports are adapter-only; yield GentPlatform and call platform.hash(...) or platform.randomBytes(...)",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 3,
        message:
          "Host url module imports are adapter-only; yield GentPlatform and call platform.fileURLToPath(...)",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 4,
        message:
          "Host url module imports are adapter-only; yield GentPlatform and call platform.fileURLToPath(...)",
      },
    ])

    // Plain string usage of "crypto" or "url" as data (param names, log
    // messages, branded ids) must not trip the guard.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          'const moduleName = "url"',
          'logger.info("crypto subsystem ready")',
          'type Tag = "node:crypto-fact"',
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags direct hash, randomBytes, and fileURLToPath calls in protected packages", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/memory/vault.ts",
        [
          "const h = createHash('sha256')",
          "const bytes = randomBytes(32)",
          "const p = fileURLToPath(url)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/memory/vault.ts",
        line: 1,
        message:
          "Direct createHash() is adapter-only; yield GentPlatform and call platform.hash(algorithm, input)",
      },
      {
        file: "packages/extensions/src/memory/vault.ts",
        line: 2,
        message:
          "Direct randomBytes() is adapter-only; yield GentPlatform and call platform.randomBytes(n) (or use the Web Crypto global `crypto.getRandomValues` if you need a sync Uint8Array)",
      },
      {
        file: "packages/extensions/src/memory/vault.ts",
        line: 3,
        message:
          "Direct fileURLToPath() is adapter-only; yield GentPlatform and call platform.fileURLToPath(url)",
      },
    ])

    // Test-utils are exempt — they back the platform itself.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/test-utils/example.ts",
        "const h = createHash('sha256')",
      ),
    ).toEqual([])

    // Adapter root is exempt.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        ["const h = createHash('sha256')", "const p = fileURLToPath(url)"].join("\n"),
      ),
    ).toEqual([])

    // The platform interface file (with JSDoc method references) is also exempt.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform.ts",
        ["// - randomBytes(n) — secure random", "// - fileURLToPath(url) — convert URL"].join("\n"),
      ),
    ).toEqual([])

    // Method calls on a platform instance are NOT bare calls — must not trip.
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/example.ts",
        [
          "yield* platform.hash('sha256', input)",
          "yield* platform.randomBytes(32)",
          "platform.fileURLToPath(url)",
          "gentPlatform.fileURLToPath(import.meta.resolve('x'))",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags bare new URL(import.meta.url) as a hand-rolled fileURLToPath", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/example.ts",
        "const here = new URL(import.meta.url).pathname",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/example.ts",
        line: 1,
        message:
          "Bare `new URL(import.meta.url)` is a hand-rolled fileURLToPath; yield GentPlatform and call platform.fileURLToPath(import.meta.url)",
      },
    ])

    // Routed through the platform: NOT a hand-rolled path — must not trip.
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/example.ts",
        "const here = platform.fileURLToPath(import.meta.url)",
      ),
    ).toEqual([])
  })

  test("flags server entrypoints that fork the composition root", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/sdk/src/server.ts",
        [
          'import { createDependencies } from "@gent/core-internal/server/server.js"',
          'import { buildServerRoutes } from "@gent/core-internal/server/server.js"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/sdk/src/server.ts",
        line: 1,
        message: "Server entrypoints must use server-root instead of hand-composing app services",
      },
      {
        file: "packages/sdk/src/server.ts",
        line: 2,
        message: "Server entrypoints must use server-root instead of hand-composing app services",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/sdk/src/server.ts",
        'import { buildServerRoot } from "@gent/core-internal/server/server-root.js"',
      ),
    ).toEqual([])
  })

  test("flags a server launcher that composes instead of calling Gent.server", () => {
    expect(
      findPlatformDuplicationViolations(
        "apps/server/src/main.ts",
        [
          'import { buildServerRoot } from "@gent/core-internal/server/server-root.js"',
          'import { BuiltinExtensions } from "@gent/extensions"',
          "const root = yield* buildServerRoot(config)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "apps/server/src/main.ts",
        line: 1,
        message:
          "The server launcher composes nothing; import @gent/sdk and pass the shape through GentServerOptions",
      },
      // The same line names the builder too — both rules report it.
      {
        file: "apps/server/src/main.ts",
        line: 1,
        message: "The server launcher calls Gent.server, never buildServerRoot",
      },
      {
        file: "apps/server/src/main.ts",
        line: 2,
        message:
          "The server launcher does not name extensions; Gent.server defaults to the builtin set",
      },
      {
        file: "apps/server/src/main.ts",
        line: 3,
        message: "The server launcher calls Gent.server, never buildServerRoot",
      },
    ])

    // The launcher reading its environment and calling the SDK is clean.
    expect(
      findPlatformDuplicationViolations(
        "apps/server/src/main.ts",
        [
          'import { Gent } from "@gent/sdk"',
          "const server = yield* Gent.server(launch.options)",
        ].join("\n"),
      ),
    ).toEqual([])
  })
})

// ── steering-file-paths.test ────────────────────────────────────────────────

const TRACKED = [
  "packages/core/src/runtime/provider.ts",
  "packages/core/src/domain/tool.ts",
  "packages/core-internal/src",
  "apps/tui/tests/render-harness-boundary.tsx",
  "plans/architecture-loop-2026-09-15.md",
  "README.md",
]

const messagesOfSteeringPath = (text: string, file = "ARCHITECTURE.md"): ReadonlyArray<string> =>
  findSteeringFilePaths(file, text, TRACKED).map((finding) => finding.message)

const linesOf = (text: string, file = "ARCHITECTURE.md"): ReadonlyArray<number> =>
  findSteeringFilePaths(file, text, TRACKED).map((finding) => finding.line)

describe("steering file paths", () => {
  test("flags a backticked file that no tracked file matches", () => {
    const text = "- `packages/e2e/tests/transport-harness.ts` — the deleted harness"
    expect(linesOf(text)).toEqual([1])
    expect(messagesOfSteeringPath(text)[0]).toContain("transport-harness.ts")
  })

  test("flags a renamed file at its own line", () => {
    const text = ["# Harnesses", "", "- `apps/tui/tests/render-harness.tsx` — renamed"].join("\n")
    expect(linesOf(text)).toEqual([3])
  })

  test("allows a tracked file", () => {
    expect(messagesOfSteeringPath("see `packages/core/src/runtime/provider.ts`")).toEqual([])
  })

  test("allows a directory that holds a tracked file", () => {
    expect(messagesOfSteeringPath("the tree under `packages/core/src/` holds it")).toEqual([])
  })

  test("allows a tracked symlink written with a trailing slash", () => {
    // git lists `packages/core-internal/src` as one blob and nothing beneath it.
    expect(messagesOfSteeringPath("relative imports inside `packages/core-internal/src/`")).toEqual(
      [],
    )
  })

  test("skips a brace expansion and a glob", () => {
    const text = [
      "- `packages/core/src/domain/capability/{tool,request}.ts`",
      "- `packages/core/src/**/*.test.ts`",
    ].join("\n")
    expect(messagesOfSteeringPath(text)).toEqual([])
  })

  test("skips a placeholder in angle brackets", () => {
    expect(messagesOfSteeringPath("write `plans/<name>.md` for the ledger")).toEqual([])
  })

  test("skips text inside a fenced block", () => {
    const text = [
      "```bash",
      "bun run --cwd apps/tui dev",
      "`packages/gone/src/missing.ts`",
      "```",
      "- `packages/gone/src/missing.ts` in prose",
    ].join("\n")
    expect(linesOf(text)).toEqual([5])
  })

  test("skips a command fragment carrying a shell character", () => {
    const text = "run `bun packages/gone/check.ts` and `packages/gone:build`"
    expect(messagesOfSteeringPath(text)).toEqual([])
  })

  test("ignores a path outside the five source roots", () => {
    expect(messagesOfSteeringPath("see `docs/gone.md` and `scripts/gone.ts`")).toEqual([])
  })

  test("reads a path only when it sits in backticks", () => {
    expect(
      messagesOfSteeringPath("packages/gone/src/missing.ts is named without backticks"),
    ).toEqual([])
  })

  test("checks each of the four steering files and nothing else", () => {
    const text = "- `packages/gone/src/missing.ts`"
    for (const file of ["CLAUDE.md", "AGENTS.md", "apps/tui/AGENTS.md", "ARCHITECTURE.md"]) {
      expect(isSteeringFile(file)).toBe(true)
      expect(messagesOfSteeringPath(text, file)).toHaveLength(1)
    }
    expect(isSteeringFile("plans/some-plan.md")).toBe(false)
    expect(messagesOfSteeringPath(text, "plans/some-plan.md")).toEqual([])
  })
})

// ── tui-session-identity.test ───────────────────────────────────────────────

const FILE_TUI_IDENTITY = "apps/tui/src/hooks/use-thing.ts"

const linesOfTuiIdentity = (text: string): ReadonlyArray<number> =>
  findTuiSessionIdentityReads(FILE_TUI_IDENTITY, text).map((finding) => finding.line)

describe("TUI session identity guard", () => {
  test("flags the record as an `on` source", () => {
    const text = [
      "  createEffect(",
      "    on(",
      "      () => client.session(),",
      "      (session) => startTracking(session),",
      "    ),",
      "  )",
    ].join("\n")
    expect(linesOfTuiIdentity(text)).toEqual([3])
    expect(findTuiSessionIdentityReads(FILE_TUI_IDENTITY, text)[0]?.message).toContain(
      "sessionIdentity()",
    )
  })

  test("flags the record read in a createEffect body", () => {
    const text = [
      "  createEffect(() => {",
      "    const current = Option.fromNullishOr(client.session())",
      "    if (Option.isNone(current)) return",
      "  })",
    ].join("\n")
    expect(linesOfTuiIdentity(text)).toEqual([2])
  })

  test("flags the record read in a createMemo", () => {
    const text = [
      "  const identity = createMemo(() =>",
      "    Option.map(Option.fromNullishOr(sessionClient.session()), (s) => s.sessionId),",
      "  )",
    ].join("\n")
    expect(linesOfTuiIdentity(text)).toEqual([2])
  })

  test("reports one finding per reactive scope, not one per opener", () => {
    const text = [
      "  createEffect(",
      "    on(",
      "      () => client.session(),",
      "      () => {},",
      "    ),",
      "  )",
    ].join("\n")
    expect(linesOfTuiIdentity(text)).toHaveLength(1)
  })

  test("allows the record in an event handler", () => {
    const text = ["  const onSelect = () => {", "    const s = client.session()", "  }"].join("\n")
    expect(linesOfTuiIdentity(text)).toEqual([])
  })

  test("allows the record in a JSX expression", () => {
    const text = ["  return (", "    <text>{client.session()?.name}</text>", "  )"].join("\n")
    expect(linesOfTuiIdentity(text)).toEqual([])
  })

  test("allows the narrowed identity accessors", () => {
    const text = [
      "  createEffect(() => {",
      "    const current = client.activeSessionId()",
      "    const identity = client.sessionIdentity()",
      "  })",
    ].join("\n")
    expect(linesOfTuiIdentity(text)).toEqual([])
  })

  test("allows the transport identity accessor", () => {
    const text = [
      "  createEffect(() => {",
      "    const session = Option.fromNullishOr(opts.transport.currentSession())",
      "  })",
    ].join("\n")
    expect(linesOfTuiIdentity(text)).toEqual([])
  })

  test("leaves files outside the TUI source alone", () => {
    const text = ["  createEffect(() => {", "    const s = client.session()", "  })"].join("\n")
    expect(findTuiSessionIdentityReads("packages/core/src/runtime/thing.ts", text)).toEqual([])
    expect(findTuiSessionIdentityReads("apps/tui/tests/thing.test.ts", text)).toEqual([])
  })
})

// ── diagnostic-suppression-anchor.test ──────────────────────────────────────

const FILE_SUPPRESSION_ANCHOR = "packages/core/src/runtime/thing.ts"

// Built from pieces on purpose. Spelled whole, the marker is a real directive
// to the Effect TypeScript plugin, which then reports this line as a
// suppression that has no effect.
const MARKER = `@effect-diagnostics${"-next-line"}`
const SUPPRESSION = `  // ${MARKER} anyUnknownInErrorContext:off`

const messagesOfSuppressionAnchor = (
  lines: ReadonlyArray<string>,
  file = FILE_SUPPRESSION_ANCHOR,
): ReadonlyArray<string> =>
  findDiagnosticSuppressionAnchors(file, lines.join("\n")).map((finding) => finding.message)

const linesOfSuppressionAnchor = (lines: ReadonlyArray<string>): ReadonlyArray<number> =>
  findDiagnosticSuppressionAnchors(FILE_SUPPRESSION_ANCHOR, lines.join("\n")).map(
    (finding) => finding.line,
  )

describe("diagnostic suppression anchor", () => {
  test("allows a suppression directly above the expression", () => {
    expect(
      messagesOfSuppressionAnchor([SUPPRESSION, "  const sealed = Effect.suspend(effect)"]),
    ).toEqual([])
  })

  test("allows a suppression above a multi-line expression head", () => {
    expect(
      messagesOfSuppressionAnchor([
        SUPPRESSION,
        "  Effect.provide(",
        "    FetchHttpClient.layer,",
        "  ),",
      ]),
    ).toEqual([])
  })

  test("flags a suppression a formatter detached with a blank line", () => {
    const messages = messagesOfSuppressionAnchor([
      SUPPRESSION,
      "",
      "  const sealed = Effect.suspend(effect)",
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("a blank line")
  })

  test("flags a suppression above closing punctuation alone", () => {
    for (const closer of ["  )", "  )", "  })", "  ],", "  );"]) {
      const messages = messagesOfSuppressionAnchor([SUPPRESSION, closer])
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain("closing punctuation alone")
    }
  })

  test("flags a suppression above a bare pipe continuation", () => {
    const messages = messagesOfSuppressionAnchor([SUPPRESSION, "  .pipe("])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("bare `.pipe(` continuation")
  })

  test("flags a suppression above a second suppression", () => {
    const messages = messagesOfSuppressionAnchor([SUPPRESSION, SUPPRESSION, "  const x = f()"])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("a second suppression comment")
  })

  test("flags a suppression on the last line of a file", () => {
    const messages = messagesOfSuppressionAnchor([" const x = f()", SUPPRESSION])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("ends the file")
  })

  test("reports the comment's own line", () => {
    expect(
      linesOfSuppressionAnchor(["const a = 1", "const b = 2", SUPPRESSION, "", "const c = 3"]),
    ).toEqual([3])
  })

  test("allows a line that closes one call and opens the next", () => {
    // `}).pipe(` carries the expression, so the diagnostic can land on it.
    expect(messagesOfSuppressionAnchor([SUPPRESSION, "  }).pipe("])).toEqual([])
  })

  test("leaves the file-scoped form alone", () => {
    const fileScoped = `// @effect-diagnostics${" nodeBuiltinImport:off"} -- fixture`
    expect(messagesOfSuppressionAnchor([fileScoped, ""])).toEqual([])
  })

  test("reads source files only", () => {
    expect(messagesOfSuppressionAnchor([SUPPRESSION, ""], "plans/notes.md")).toEqual([])
  })

  test("skips the guard's own source and test, which must spell the marker", () => {
    for (const self of [
      "packages/tooling/src/guards.ts",
      "packages/tooling/tests/guards.test.ts",
    ]) {
      expect(messagesOfSuppressionAnchor([SUPPRESSION, ""], self)).toEqual([])
    }
  })
})

// ── suppression-inventory.test ──────────────────────────────────────────────

const nextLine = ["// @effect", "diagnostics-next-line"].join("-")
const membraneFile = "packages/core/src/runtime/extension-host.ts"
const membraneComment = `${nextLine} anyUnknownInErrorContext:off`

describe("suppression inventory guard", () => {
  test("flags effect diagnostics outside reviewed files", () => {
    expect(
      findSuppressionInventoryFindings("sample.ts", `${nextLine} strictEffectProvide:off`),
    ).toEqual([{ file: "sample.ts", line: 1, kind: "effect-diagnostics" }])
  })

  test("allows exact reviewed effect diagnostics independent of line churn", () => {
    expect(
      findSuppressionInventoryFindings(
        membraneFile,
        [...Array.from({ length: 23 }, () => ""), membraneComment].join("\n"),
      ),
    ).toEqual([])

    expect(findSuppressionInventoryFindings(membraneFile, membraneComment)).toEqual([])
  })

  test("flags a different rule in a reviewed file", () => {
    expect(
      findSuppressionInventoryFindings(membraneFile, `${nextLine} strictEffectProvide:off`),
    ).toEqual([{ file: membraneFile, line: 1, kind: "effect-diagnostics" }])
  })

  test("approved entry with no matching comment in its file is unused", () => {
    const findings = findUnusedSuppressionApprovals(new Map([[membraneFile, "export {}\n"]]))
    expect(findings).toContainEqual({ file: membraneFile, comment: membraneComment })
  })

  test("approved entry whose file is not scanned is unused", () => {
    const findings = findUnusedSuppressionApprovals(new Map())
    expect(findings).toContainEqual({ file: membraneFile, comment: membraneComment })
  })

  test("approved entry with a matching comment is not reported", () => {
    const findings = findUnusedSuppressionApprovals(
      new Map([[membraneFile, `const x = 1\n  ${membraneComment}\nconst y = 2\n`]]),
    )
    expect(
      findings.filter(
        (finding) => finding.file === membraneFile && finding.comment === membraneComment,
      ),
    ).toEqual([])
  })
})

// ── export-consumers.test ───────────────────────────────────────────────────

const CORE_FILE = "packages/core/src/runtime/provider.ts"
const SDK_FILE = "packages/sdk/src/log-paths.ts"
const SDK_CONSUMER = "packages/sdk/src/logger.ts"
const API_FILE = "packages/core/src/extensions/api.ts"
const API_CONSUMER = "packages/extensions/src/notes/index.ts"
const BRANCH_TOOLS_FILE = "packages/core/src/extensions/branch-tools.ts"
const BRANCH_TOOLS_CONSUMER = "packages/extensions/src/cell/cell-tool-host.ts"
const EXTENSION_FILE = "packages/extensions/src/fs-tools/edit.ts"

interface SourceEntry {
  readonly file: string
  readonly text: string
}

const factsFor = (entries: ReadonlyArray<SourceEntry>): ReadonlyMap<string, ExportFacts> => {
  const byFile = new Map<string, ExportFacts>()
  for (const { file, text } of entries) byFile.set(file, collectExportFacts(file, text))
  return byFile
}

const declaredNames = (file: string, text: string): ReadonlyArray<string> =>
  collectExportFacts(file, text).declarations.map((declaration) => declaration.name)

const findingsFor = (entries: ReadonlyArray<SourceEntry>) =>
  findUnconsumedExports(factsFor(entries))

const apiSource = `export { defineExtension } from "../domain/extension.js"
export {
  tool,
  type ToolCapability,
} from "../domain/capability/tool.js"
export { CapabilityError, CapabilityNotFoundError } from "../domain/capability.js"
`

const consumedThroughApi = (file: string, text: string): ReadonlySet<string> =>
  Option.getOrElse(
    Option.fromNullishOr(collectExportFacts(file, text).imported.get("@gent/core/extensions/api")),
    () => new Set<string>(),
  )

describe("module surface declarations", () => {
  test("reads declared exports from a scanned core file", () => {
    const source = `export const retrySchedule = 1
const notExported = 2
export interface RetryPolicy {}
`
    expect(
      collectExportFacts(CORE_FILE, source).declarations.map(({ name, line }) => ({ name, line })),
    ).toEqual([
      { name: "retrySchedule", line: 1 },
      { name: "RetryPolicy", line: 3 },
    ])
  })

  test("reads declared exports from a scanned sdk file", () => {
    const source = `export const buildLogPaths = 1
export type LogPaths = { readonly dir: string }
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["buildLogPaths", "LogPaths"])
  })

  test("a file in an unscanned package declares nothing", () => {
    // Reference extensions stand alone; no surface row covers `examples/`.
    expect(
      declaredNames("examples/extensions/session-notes.ts", `export const ExampleHelper = 1\n`),
    ).toEqual([])
  })

  test("a bare export block is a surface, so its names are declared", () => {
    // 26 names hid in one such block in packages/sdk/src/client.ts because
    // only `export const|type|...` was read.
    const source = `type Local = { readonly a: number }
export type { Local }
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["Local"])
  })

  test("a bare block names a file already declares are not counted twice", () => {
    const source = `export const buildLogPaths = 1
export { buildLogPaths }
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["buildLogPaths"])
  })

  test("a bare block re-exporting an imported name declares nothing", () => {
    // The name belongs to the file that declared it. Counting the pass-through
    // here would make this file a declaring site and hide the real consumer.
    const source = `import { WakeExtension } from "./wake/index.js"
export { WakeExtension }
`
    expect(declaredNames("packages/extensions/src/index.ts", source)).toEqual([])
  })

  test("a from block on a module surface declares the name it exposes", () => {
    // The re-export puts a second consumable name at this module path. A dead
    // one is dead here even though the declaring file keeps its own alive.
    const source = `export { ToolRunner } from "../runtime/agent/tool-runner.js"\n`
    expect(declaredNames(SDK_FILE, source)).toEqual(["ToolRunner"])
  })

  test("a from block declares every shape it carries across lines", () => {
    const source = `export {
  Alpha,
  type Beta,
  Gamma as Delta,
} from "./shapes.js"
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["Alpha", "Beta", "Delta"])
  })

  test("a from re-export of a name the file also declares is not counted twice", () => {
    const source = `export const shared = 1
export { shared } from "./elsewhere.js"
`
    expect(declaredNames(SDK_FILE, source)).toEqual(["shared"])
  })

  test("a from re-export nothing imports is reported", () => {
    const findings = findingsFor([
      {
        file: SDK_FILE,
        text: `import { Orphan } from "./elsewhere.js"
export { Orphan } from "./elsewhere.js"
void Orphan
`,
      },
      { file: SDK_CONSUMER, text: `const unrelated = 1\nvoid unrelated\n` },
    ])
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("`Orphan` is exported but"),
    ])
  })

  test("a from re-export a sibling imports is not reported", () => {
    const findings = findingsFor([
      { file: SDK_FILE, text: `export { Kept } from "./elsewhere.js"\n` },
      { file: SDK_CONSUMER, text: `import { Kept } from "./log-paths.js"\nvoid Kept\n` },
    ])
    expect(findings).toEqual([])
  })

  test("a name only a bare block exposes, that nothing imports, is reported", () => {
    const findings = findingsFor([
      { file: SDK_FILE, text: `const orphan = 1\nconst used = 2\nexport { orphan, used }\n` },
      { file: SDK_CONSUMER, text: `import { used } from "./log-paths.js"\nvoid used\n` },
    ])
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("`orphan` is exported but"),
    ])
  })

  test("core's exempt entry points declare nothing as a module", () => {
    const source = `export const tool = 1\n`
    expect(declaredNames(API_FILE, source)).toEqual([])
    expect(declaredNames("packages/core/src/protocol.ts", source)).toEqual([])
  })

  test("test-utils declares its own names: the directory is a surface, not an exemption", () => {
    expect(
      declaredNames("packages/core/src/test-utils/language-model.ts", `export const tool = 1\n`),
    ) //
      .toEqual(["tool"])
  })

  test("a branch-tool name an extension imports through the specifier is live", () => {
    // The row exists to ask this question at all: before it, no surface
    // scanned this entry point and every name here looked consumed.
    expect(
      findingsFor([
        {
          file: BRANCH_TOOLS_FILE,
          text: `export { ToolRunner } from "../runtime/agent/tool-runner.js"\n`,
        },
        {
          file: BRANCH_TOOLS_CONSUMER,
          text: `import { ToolRunner } from "@gent/core/extensions/branch-tools"`,
        },
      ]),
    ).toEqual([])
  })

  test("a branch-tool name only core reaches by relative path is reported", () => {
    const findings = findingsFor([
      {
        file: BRANCH_TOOLS_FILE,
        text: `export { projectModelContext } from "../runtime/model-context.js"\n`,
      },
      {
        file: "packages/core/src/runtime/turn.ts",
        text: `import { projectModelContext } from "../model-context.js"`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("@gent/core/extensions/branch-tools")
  })

  test("the branch-tool entry point declares its re-exported names, not its module exports", () => {
    // A second scanned entry point: `export { X } from "..."` is the shape it
    // exposes, so a module-style `export const` on it declares nothing.
    expect(declaredNames(BRANCH_TOOLS_FILE, `export const tool = 1\n`)).toEqual([])
    expect(
      declaredNames(
        BRANCH_TOOLS_FILE,
        `export { ToolRunner, type BranchToolWork } from "../x.js"\n`,
      ),
    ).toEqual(["ToolRunner", "BranchToolWork"])
  })
})

describe("the TUI app surface", () => {
  const TUI_FILE = "apps/tui/src/utils.ts"
  const TUI_CONSUMER = "apps/tui/src/app.tsx"

  test("a TUI export another TUI file imports is live", () => {
    expect(
      findingsFor([
        { file: TUI_FILE, text: `export const formatTokens = 1\n` },
        { file: TUI_CONSUMER, text: `import { formatTokens } from "../utils"\n` },
      ]),
    ).toEqual([])
  })

  test("a TUI export nothing reaches is reported and fails the guard", () => {
    const findings = findingsFor([
      { file: TUI_FILE, text: `export const formatTokens = 1\nexport const orphan = 2\n` },
      { file: TUI_CONSUMER, text: `import { formatTokens } from "../utils"\n` },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([2])
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("`orphan`")
  })

  test("the declaring file reading its own name does not keep it alive", () => {
    // `ownFileCounts: false`: a TUI module that only talks to itself has no
    // reason to export the name at all.
    expect(
      findingsFor([
        { file: TUI_FILE, text: `export const orphan = 1\nconst near = orphan + 1\nvoid near\n` },
      ]).map((finding) => finding.line),
    ).toEqual([1])
  })

  test("a TUI test file keeps a name alive", () => {
    expect(
      findingsFor([
        { file: TUI_FILE, text: `export const orphan = 1\n` },
        {
          file: "apps/tui/tests/utils.test.ts",
          text: `import { orphan } from "../src/utils"\nvoid orphan\n`,
        },
      ]),
    ).toEqual([])
  })
})

describe("the server app surface", () => {
  const SERVER_FILE = "apps/server/src/main.ts"

  test("the launcher exporting nothing is clean", () => {
    expect(findingsFor([{ file: SERVER_FILE, text: `const program = 1\nvoid program\n` }])).toEqual(
      [],
    )
  })

  test("a server export nothing reaches is reported", () => {
    const findings = findingsFor([
      { file: SERVER_FILE, text: `const program = 1\nexport const orphan = program\n` },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([2])
    expect(findings[0]?.message).toContain("`orphan`")
  })

  test("a server test file keeps a name alive", () => {
    expect(
      findingsFor([
        { file: SERVER_FILE, text: `export const orphan = 1\n` },
        {
          file: "apps/server/tests/main.test.ts",
          text: `import { orphan } from "../src/main"\nvoid orphan\n`,
        },
      ]),
    ).toEqual([])
  })
})

describe("strict module surfaces (core, sdk)", () => {
  test("a planted sdk export no other file names is reported with its line", () => {
    const planted = `export const buildLogPaths = 1

export const plantedDeadSdkExport = "nothing imports this"
`
    const consumer = `import { buildLogPaths } from "./log-paths.js"\n`
    const findings = findingsFor([
      { file: SDK_FILE, text: planted },
      { file: SDK_CONSUMER, text: consumer },
    ])

    expect(findings).toHaveLength(1)
    expect(findings[0]?.file).toBe(SDK_FILE)
    expect(findings[0]?.line).toBe(3)
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("`plantedDeadSdkExport`")
  })

  test("an sdk export another sdk file imports is live", () => {
    expect(
      findingsFor([
        { file: SDK_FILE, text: `export const ensureLogDir = 1\n` },
        { file: SDK_CONSUMER, text: `import { ensureLogDir } from "./log-paths.js"\n` },
      ]),
    ).toEqual([])
  })

  test("a name an unscanned package reaches for is live", () => {
    expect(
      findingsFor([
        { file: SDK_FILE, text: `export const sharedName = 1\n` },
        { file: "apps/tui/src/app.tsx", text: `import { sharedName } from "@gent/sdk"\n` },
      ]),
    ).toEqual([])
  })

  test("a name only a test file reaches for is live", () => {
    expect(
      findingsFor([
        { file: CORE_FILE, text: `export const retrySchedule = 1\n` },
        {
          file: "packages/core/tests/runtime/retry.test.ts",
          text: `import { retrySchedule } from "../../src/runtime/retry"\n`,
        },
      ]),
    ).toEqual([])
  })

  test("a name only its own module reads is still reported", () => {
    // Core and the SDK are held to the strict reading: drop the `export`.
    const findings = findingsFor([
      {
        file: CORE_FILE,
        text: `export const retrySchedule = 1\nconst twice = retrySchedule * 2\n`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
    expect(findings[0]?.message).toContain("drop the `export` keyword")
  })

  test("a name two scanned files both declare needs a third file to be live", () => {
    const findings = findingsFor([
      { file: CORE_FILE, text: `export const sameName = 1\n` },
      { file: SDK_FILE, text: `export const sameName = 2\n` },
    ])
    expect(findings.map((finding) => finding.file).sort()).toEqual([CORE_FILE, SDK_FILE])
  })
})

describe("extensions module surface", () => {
  test("a schema only the tool beside it reads is reported", () => {
    // `ownFileCounts: false`: the tool is the package's surface, so the param
    // and error types it is built from stay file-local.
    const source = `export const EditParams = Schema.Struct({ path: Schema.String })
export class EditError extends Schema.TaggedError<EditError>()("EditError", {}) {}
export const edit = tool({ params: EditParams, run: () => new EditError({}) })
`
    const findings = findingsFor([
      { file: EXTENSION_FILE, text: source },
      {
        file: "packages/extensions/src/index.ts",
        text: `import { edit } from "./fs-tools/edit"`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1, 2])
    expect(findings[0]?.message).toContain("`EditParams`")
    expect(findings[1]?.message).toContain("`EditError`")
  })

  test("a service only its own module yields is reported", () => {
    const source = `export interface WakeAlarmsService { readonly schedule: () => void }
export class WakeAlarms extends Context.Service<WakeAlarms, WakeAlarmsService>()(
  "@gent/extensions/src/wake/WakeAlarms",
) {}
const use = Effect.gen(function* () {
  const alarms = yield* WakeAlarms
  return alarms
})
`
    const findings = findingsFor([{ file: "packages/extensions/src/wake/index.ts", text: source }])
    expect(findings.map((finding) => finding.line)).toEqual([1, 2])
    expect(findings.every((finding) => finding.enforced)).toBe(true)
  })

  test("a service another extension module yields keeps its export", () => {
    expect(
      findingsFor([
        {
          file: "packages/extensions/src/wake/index.ts",
          text: `export class WakeAlarms extends Context.Service<WakeAlarms, never>()(
  "@gent/extensions/src/wake/WakeAlarms",
) {}
`,
        },
        {
          file: "packages/extensions/src/wake/wake-store.ts",
          text: `import { WakeAlarms } from "./index"\nvoid WakeAlarms\n`,
        },
      ]),
    ).toEqual([])
  })

  test("a class only its own declaration, _tag string, and doc comment name is reported", () => {
    const source = `/** HandoffError is raised when the handoff fails. */
export class HandoffError extends Schema.TaggedError<HandoffError>()(
  "HandoffError",
  { message: Schema.String },
) {}
export const handoff = tool({ run: () => "HandoffError happened" })
`
    const findings = findingsFor([
      { file: "packages/extensions/src/handoff-tool.ts", text: source },
      {
        file: "packages/extensions/src/index.ts",
        text: `import { handoff } from "./handoff-tool"`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([2])
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("`HandoffError`")
    expect(findings[0]?.message).toContain("delete it")
  })

  test("a const and type pair nothing else reads is reported on both lines", () => {
    const source = `export const SessionUpdate = Schema.Union([Schema.String])
export type SessionUpdate = typeof SessionUpdate.Type
`
    const findings = findingsFor([
      { file: "packages/extensions/src/acp-agents/schema.ts", text: source },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1, 2])
  })

  test("a name an extension test reaches for is live", () => {
    expect(
      findingsFor([
        { file: EXTENSION_FILE, text: `export const findMatch = 1\n` },
        {
          file: "packages/extensions/tests/fs-tools.test.ts",
          text: `import { findMatch } from "../../src/fs-tools/edit"\n`,
        },
      ]),
    ).toEqual([])
  })
})

describe("core test-utils surface", () => {
  const TEST_UTILS_FILE = "packages/core/src/test-utils/language-model.ts"

  test("a helper a core test imports is live", () => {
    expect(
      findingsFor([
        { file: TEST_UTILS_FILE, text: `export const LanguageModelLayers = {}\n` },
        {
          file: "packages/core/tests/runtime/session-runtime.test.ts",
          text: `import { LanguageModelLayers } from "../../src/test-utils/language-model"\n`,
        },
      ]),
    ).toEqual([])
  })

  test("a type its own file reads off the declaration is live", () => {
    const source = `interface SignalControls { readonly emitNext: number }
export const signal = () => {
  const controls: SignalControls = { emitNext: 1 }
  return controls
}
`
    expect(
      findingsFor([
        { file: TEST_UTILS_FILE, text: source },
        {
          file: "packages/core/tests/runtime/session-runtime.test.ts",
          text: `import { signal } from "../../src/test-utils/language-model"\n`,
        },
      ]),
    ).toEqual([])
  })

  test("a constant nothing names, not even its own file, is reported and enforced", () => {
    const findings = findingsFor([
      { file: TEST_UTILS_FILE, text: `export const DebugSlowLanguageModelDelayMs = 250\n` },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain("`DebugSlowLanguageModelDelayMs`")
  })
})

describe("public extension API entry point", () => {
  test("reads names from single-line and multi-line export blocks", () => {
    expect(declaredNames(API_FILE, apiSource)).toEqual([
      "defineExtension",
      "tool",
      "ToolCapability",
      "CapabilityError",
      "CapabilityNotFoundError",
    ])
  })

  test("a name nothing outside core reaches for is reported with its line", () => {
    const findings = findingsFor([
      { file: API_FILE, text: apiSource },
      {
        file: API_CONSUMER,
        text: `import { defineExtension, tool, type ToolCapability, CapabilityError } from "@gent/core/extensions/api"`,
      },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.file).toBe(API_FILE)
    expect(findings[0]?.line).toBe(6)
    expect(findings[0]?.enforced).toBe(true)
    expect(findings[0]?.message).toContain('"CapabilityNotFoundError"')
  })

  test("only an import through the public path counts", () => {
    // The same symbol reached over a relative path is not consumption of the
    // public API -- nothing gets it from `extensions/api`, which is the only
    // question this surface asks.
    expect(
      consumedThroughApi(
        API_CONSUMER,
        `import { tool } from "../../../core/src/domain/capability/tool"`,
      ),
    ).not.toContain("tool")
    expect(
      consumedThroughApi(API_CONSUMER, `import { tool } from "@gent/core/extensions/api"`),
    ).toContain("tool")
  })

  test("a bare mention outside an import does not keep a public name alive", () => {
    const findings = findingsFor([
      { file: API_FILE, text: `export { tool } from "../domain/capability/tool.js"\n` },
      { file: API_CONSUMER, text: `const tool = 1\n` },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
  })

  test("an alias credits the original name, not the local one", () => {
    // `X as Y` still requires the public API to export `X`.
    const names = consumedThroughApi(
      API_CONSUMER,
      `import { messagePartText as renderText } from "@gent/core/extensions/api"`,
    )
    expect(names).toContain("messagePartText")
    expect(names).not.toContain("renderText")
  })

  test("a multi-line import block is read as one statement", () => {
    const names = consumedThroughApi(
      API_CONSUMER,
      `import {
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"`,
    )
    expect([...names].sort()).toEqual(["ToolCapability", "tool"])
  })

  test("a namespace import credits every member it reads", () => {
    const names = consumedThroughApi(
      API_CONSUMER,
      `import * as Api from "@gent/core/extensions/api"
const x: Api.ToolCapability = Api.tool({})`,
    )
    expect([...names].sort()).toEqual(["ToolCapability", "tool"])
  })

  test("a @ts-expect-error reference asserts absence, so it never counts", () => {
    // The surface-lock suites reach for removed names precisely to prove they
    // are gone. Crediting those would pin removed surface in place forever.
    const names = consumedThroughApi(
      API_CONSUMER,
      `import * as Api from "@gent/core/extensions/api"
    // @ts-expect-error — action factory was removed
    type Bad = typeof Api.action`,
    )
    expect(names).not.toContain("action")
  })

  test("core's own source never counts as a consumer", () => {
    const findings = findingsFor([
      { file: API_FILE, text: `export { tool } from "../domain/capability/tool.js"\n` },
      {
        file: "packages/core/src/domain/capability.ts",
        text: `import { tool } from "@gent/core/extensions/api"`,
      },
      {
        file: "packages/core-internal/src/capability.ts",
        text: `import { tool } from "@gent/core/extensions/api"`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
  })

  test("an SDK index name only the SDK's own tests import is reported", () => {
    const findings = findingsFor([
      {
        file: "packages/sdk/src/index.ts",
        text: `export { GentObservability } from "./logger.js"\n`,
      },
      {
        file: "packages/sdk/tests/logger.test.ts",
        text: `import { GentObservability } from "@gent/sdk"`,
      },
    ])
    expect(findings.map((finding) => finding.enforced)).toEqual([true])
    expect(findings[0]?.message).toContain('"GentObservability"')
    expect(findings[0]?.message).toContain("@gent/sdk")
  })

  test("a TUI import through @gent/sdk consumes an SDK index name", () => {
    expect(
      findingsFor([
        { file: "packages/sdk/src/index.ts", text: `export { LOG_DIR } from "./log-paths.js"\n` },
        { file: "apps/tui/src/main.tsx", text: `import { LOG_DIR } from "@gent/sdk"` },
      ]),
    ).toEqual([])
  })

  test("an extensions client name only the extensions package imports is reported", () => {
    const findings = findingsFor([
      {
        file: "packages/extensions/src/client.ts",
        text: `export { WakeRpc, WakeEntry } from "./wake/protocol.js"\n`,
      },
      {
        file: "packages/extensions/tests/wake.test.ts",
        text: `import { WakeEntry } from "@gent/extensions/client"`,
      },
      {
        file: "apps/tui/src/extensions/wake.client.tsx",
        text: `import { WakeRpc } from "@gent/extensions/client.js"`,
      },
    ])
    expect(findings.map((finding) => finding.enforced)).toEqual([true])
    expect(findings[0]?.message).toContain('"WakeEntry"')
    expect(findings[0]?.message).toContain("@gent/extensions/client")
  })

  test("a re-export alias is consumed under the alias, not the source name", () => {
    const source = `export { type WakePending as WakePendingType } from "./wake/protocol.js"\n`
    expect(declaredNames("packages/extensions/src/client.ts", source)).toEqual(["WakePendingType"])
    expect(
      findingsFor([
        { file: "packages/extensions/src/client.ts", text: source },
        {
          file: "apps/tui/tests/components/wake-tray.test.tsx",
          text: `import type { WakePendingType } from "@gent/extensions/client"`,
        },
      ]),
    ).toEqual([])
  })

  test("a test outside core is a real consumer of the public API", () => {
    expect(
      findingsFor([
        { file: API_FILE, text: `export { tool } from "../domain/capability/tool.js"\n` },
        {
          file: "packages/extensions/tests/api-surface.test.ts",
          text: `import { tool } from "@gent/core/extensions/api"`,
        },
      ]),
    ).toEqual([])
  })
})

const packageSurface = (
  entries: ReadonlyArray<readonly [string, PackageJson]>,
  paths: Readonly<Record<string, ReadonlyArray<string>>>,
) => findPackageSurfaceFindings(new Map(entries), { compilerOptions: { paths } })

describe("chained entry points", () => {
  const PROTOCOL_FILE = "packages/core/src/protocol.ts"
  const SDK_INDEX = "packages/sdk/src/index.ts"

  test("an sdk re-export keeps a protocol name alive", () => {
    // `@gent/sdk` both declares `emptyQueueSnapshot` and gets it from
    // `@gent/core/protocol`. Skipping every file that declares the name would
    // call the whole chained surface dead.
    const findings = findingsFor([
      {
        file: PROTOCOL_FILE,
        text: `export { QueueSnapshot, emptyQueueSnapshot } from "./domain/queue.js"\n`,
      },
      {
        file: SDK_INDEX,
        text: `export { QueueSnapshot, emptyQueueSnapshot } from "@gent/core/protocol"\n`,
      },
    ])
    expect(findings.filter((finding) => finding.file === PROTOCOL_FILE)).toEqual([])
  })

  test("a protocol name no chained entry point re-exports is still reported", () => {
    const findings = findingsFor([
      {
        file: PROTOCOL_FILE,
        text: `export { QueueSnapshot, DriverInfo } from "./domain/queue.js"\n`,
      },
      { file: SDK_INDEX, text: `export { QueueSnapshot } from "@gent/core/protocol"\n` },
    ])
    const reported = findings.filter((finding) => finding.file === PROTOCOL_FILE)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('"DriverInfo"')
  })
})

describe("package entry points", () => {
  test("allows explicit extension and protocol exports", () => {
    expect(
      packageSurface(
        [
          [
            "packages/core/package.json",
            {
              exports: {
                "./extensions/api": "./src/extensions/api.ts",
                "./extensions/api.js": "./src/extensions/api.ts",
                "./protocol": "./src/protocol.ts",
                "./protocol.js": "./src/protocol.ts",
              },
            },
          ],
          [
            "packages/core-internal/package.json",
            { private: true, exports: { "./*.js": "./src/*.ts", "./*": "./src/*.ts" } },
          ],
        ],
        {
          "@gent/core/extensions/api": ["./packages/core/src/extensions/api.ts"],
          "@gent/core/extensions/api.js": ["./packages/core/src/extensions/api.ts"],
          "@gent/core/protocol": ["./packages/core/src/protocol.ts"],
          "@gent/core/protocol.js": ["./packages/core/src/protocol.ts"],
          "@gent/core-internal/*.js": ["./packages/core/src/*.ts"],
          "@gent/core-internal/*": ["./packages/core/src/*"],
        },
      ),
    ).toEqual([])
  })

  test("flags public internal core exports and tsconfig aliases", () => {
    expect(
      packageSurface(
        [
          [
            "packages/core/package.json",
            {
              exports: {
                "./extensions/api": "./src/extensions/api.ts",
                "./domain/ids": "./src/domain/ids.ts",
              },
            },
          ],
        ],
        { "@gent/core/domain/ids": ["./packages/core/src/domain/ids.ts"] },
      ).map((finding) => finding.path),
    ).toEqual([
      'packages/core/package.json exports["./domain/ids"]',
      'tsconfig.json compilerOptions.paths["@gent/core/domain/ids"]',
    ])
  })

  test("rejects protocol wildcards and unknown core paths", () => {
    expect(
      packageSurface(
        [["packages/core/package.json", { exports: { "./protocol/*": "./src/*.ts" } }]],
        {
          "@gent/core/protocol/*": ["./packages/core/src/*"],
          "@gent/core/unknown": ["./packages/core/src/domain/ids.ts"],
        },
      ).map((finding) => finding.path),
    ).toEqual([
      'packages/core/package.json exports["./protocol/*"]',
      'tsconfig.json compilerOptions.paths["@gent/core/protocol/*"]',
      'tsconfig.json compilerOptions.paths["@gent/core/unknown"]',
    ])
  })

  test("keeps the workspace internal package private and narrow", () => {
    expect(
      packageSurface(
        [
          [
            "packages/core-internal/package.json",
            { private: false, exports: { "./debug/*": "./src/debug/*.ts" } },
          ],
        ],
        {},
      ),
    ).toEqual([
      {
        path: "packages/core-internal/package.json private",
        message: "@gent/core-internal must stay private; it is not a published contract",
      },
      {
        path: 'packages/core-internal/package.json exports["./debug/*"]',
        message: "@gent/core-internal may only expose its supported entry points: ./*.js, ./*",
      },
      {
        path: 'packages/core-internal/package.json exports["./*.js"]',
        message: '@gent/core-internal must map "./*.js" to "./src/*.ts"',
      },
      {
        path: 'packages/core-internal/package.json exports["./*"]',
        message: '@gent/core-internal must map "./*" to "./src/*.ts"',
      },
    ])
  })

  test("allows only root composition and client contracts for extensions", () => {
    expect(
      packageSurface(
        [
          [
            "packages/extensions/package.json",
            {
              private: true,
              exports: {
                ".": "./src/index.ts",
                "./index.js": "./src/index.ts",
                "./client": "./src/client.ts",
                "./client.js": "./src/client.ts",
              },
            },
          ],
        ],
        {
          "@gent/extensions": ["./packages/extensions/src/index.ts"],
          "@gent/extensions/index.js": ["./packages/extensions/src/index.ts"],
          "@gent/extensions/client": ["./packages/extensions/src/client.ts"],
          "@gent/extensions/client.js": ["./packages/extensions/src/client.ts"],
        },
      ),
    ).toEqual([])
  })

  test("flags extension implementation subpaths", () => {
    expect(
      packageSurface(
        [
          [
            "packages/extensions/package.json",
            {
              private: false,
              exports: { ".": "./src/index.ts", "./todo-storage": "./src/todo-storage.ts" },
            },
          ],
        ],
        { "@gent/extensions/todo-storage": ["./packages/extensions/src/todo-storage.ts"] },
      ),
    ).toEqual([
      {
        path: "packages/extensions/package.json private",
        message: "@gent/extensions must stay private; it is not a published contract",
      },
      {
        path: 'packages/extensions/package.json exports["./todo-storage"]',
        message:
          "@gent/extensions may only expose its supported entry points: ., ./index.js, ./client, ./client.js",
      },
      {
        path: 'tsconfig.json compilerOptions.paths["@gent/extensions/todo-storage"]',
        message:
          "Do not give TypeScript a public-looking @gent/extensions path for an internal module",
      },
    ])
  })

  test("allows only the root client contract export for the sdk", () => {
    expect(
      packageSurface([["packages/sdk/package.json", { exports: { ".": "./src/index.ts" } }]], {
        "@gent/sdk": ["./packages/sdk/src/index.ts"],
      }),
    ).toEqual([])
  })

  test("flags internal sdk subpath exports", () => {
    expect(
      packageSurface(
        [
          [
            "packages/sdk/package.json",
            { exports: { ".": "./src/index.ts", "./rpcs": "./src/rpcs.ts" } },
          ],
        ],
        {},
      ),
    ).toEqual([
      {
        path: 'packages/sdk/package.json exports["./rpcs"]',
        message: "@gent/sdk may only expose its supported entry points: .",
      },
    ])
  })
})

describe("a namesake does not vouch for an export", () => {
  const TUI_FILE = "apps/tui/src/extensions/loader-boundary.ts"
  const TUI_CONSUMER = "apps/tui/src/extensions/host.tsx"

  /** `use` keeps the probe file's own surface alive so only the name under test is measured. */
  const usedElsewhere = {
    file: TUI_CONSUMER,
    text: "import { use } from './loader-boundary'\nuse()\n",
  }
  const coreDeclaration = {
    file: CORE_FILE,
    text: "export const isClientFile = (entry: string) => entry.length > 0\n",
  }

  test("a file that binds the same name locally is not a consumer", () => {
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: "const isClientFile = (entry: string) => entry.length > 0\nexport const use = () => isClientFile('a')\n",
      },
      usedElsewhere,
    ])
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("`isClientFile` is exported but no file outside"),
    ])
  })

  test("a file that imports the name is a consumer even with a namesake beside it", () => {
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: "import { isClientFile } from '@gent/core/protocol'\nexport const use = () => isClientFile('a')\n",
      },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })

  test("an aliased import from the declaring module is a read, with a namesake beside it", () => {
    const stem = CORE_FILE.slice(CORE_FILE.lastIndexOf("/") + 1).replace(/\.ts$/, "")
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: `import { isClientFile as coreIsClientFile } from '../${stem}.js'\nconst isClientFile = () => true\nexport const use = () => coreIsClientFile('a') && isClientFile()\n`,
      },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })

  test("a namespace import from the declaring module is a read, with a namesake beside it", () => {
    const stem = CORE_FILE.slice(CORE_FILE.lastIndexOf("/") + 1).replace(/\.ts$/, "")
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: `import * as Core from '../${stem}.js'\nconst isClientFile = () => true\nexport const use = () => Core.isClientFile('a') && isClientFile()\n`,
      },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })

  test("a plain mention with no local binding still vouches", () => {
    const findings = findingsFor([
      coreDeclaration,
      { file: TUI_FILE, text: "export const use = () => isClientFile('a')\n" },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })

  test("a local binding in a comment does not discount the mention", () => {
    const findings = findingsFor([
      coreDeclaration,
      {
        file: TUI_FILE,
        text: "// const isClientFile = () => true\nexport const use = () => isClientFile('a')\n",
      },
      usedElsewhere,
    ])
    expect(findings).toEqual([])
  })
})
