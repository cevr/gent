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
  findCoreVendorModelPins,
  findDiagnosticSuppressionAnchors,
  findE2eFixtureImportFindings,
  findHookGuardOrder,
  findIdentityEncodes,
  findPackageSurfaceFindings,
  findPlatformDuplicationViolations,
  findReadersWithoutWriters,
  findRetiredSurfaces,
  findSteeringFilePaths,
  findSuppressionInventoryFindings,
  findTuiSessionIdentityReads,
  findUnadaptedSeams,
  findUnadmittedChildSessionWriters,
  findUnconsumedExports,
  findUnenabledPluginRules,
  findUnmatchedOverrideGlobs,
  findMissingLockIncludes,
  findUnusedSuppressionApprovals,
  HOOK_FILE,
  isSteeringFile,
  type PackageJson,
  RETIRED_SURFACES,
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
      "apps/tui/tests/extensions/thread-view.client.test.tsx",
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

  test("flags core naming a catalog host a driver owns", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/provider.ts",
      'const MODELS_URL = "https://models.dev"',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain("models.dev")
    expect(findings[0]!.message).toContain("listModels")
  })

  test("lets an extension name the catalog host it owns", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/extensions/src/providers.ts",
      'const MODELS_URL = "https://models.dev"',
    )
    expect(findings).toEqual([])
  })
})

// ── core-identity-encode.test ───────────────────────────────────────────────

const ENCODER = "const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))"

const identityLines = (file: string, ...lines: ReadonlyArray<string>) =>
  findIdentityEncodes(file, [ENCODER, ...lines].join("\n")).map((finding) => finding.line)

describe("identity encode guard", () => {
  test("reports an encode stored under a camelCase identity name", () => {
    const file = "apps/tui/src/message-list.tsx"
    expect(identityLines(file, "const identity = encodeJson(m)")).toEqual([2])
    expect(identityLines(file, "const messageIdentity = encodeJson(m)")).toEqual([2])
    expect(identityLines(file, "const dedupeKey = encodeJson(m)")).toEqual([2])
    expect(identityLines(file, "const cache_key = encodeJson(m)")).toEqual([2])
  })

  test("reports an encode compared or collected on the same line", () => {
    const file = "packages/core/src/runtime/turn.ts"
    expect(identityLines(file, "if (encodeJson(a) === encodeJson(b)) return")).toEqual([2])
    expect(identityLines(file, "if (seen.has(encodeJson(m))) continue")).toEqual([2])
    expect(identityLines(file, "seen.add(encodeJson(m))")).toEqual([2])
  })

  test("leaves display encodes and fixed-order projections alone", () => {
    const file = "apps/tui/src/message-list.tsx"
    expect(identityLines(file, "yield* Effect.log(encodeJson(entry))")).toEqual([])
    expect(identityLines(file, "const text = encodeJson(result)")).toEqual([])
    expect(identityLines(file, "const keyboardHint = 1")).toEqual([])
    expect(
      identityLines(file, "const toolIdentity = (c: ToolCall) => encodeJson(toolFingerprint(c))"),
    ).toEqual([])
    expect(identityLines(file, "const identity = encodeJson([call.id, call.status])")).toEqual([])
  })

  test("scans shipped source only", () => {
    expect(
      identityLines("packages/core/tests/x.test.ts", "const identity = encodeJson(m)"),
    ).toEqual([])
    expect(identityLines("ARCHITECTURE.md", "const identity = encodeJson(m)")).toEqual([])
  })
})

// ── core-vendor-model-pins.test ─────────────────────────────────────────────

describe("vendor model pin guard", () => {
  test("reports a provider-qualified model id in core source", () => {
    const findings = findCoreVendorModelPins(
      "packages/core/src/runtime/turn.ts",
      ["const a = 1", 'const model = "anthropic/claude-haiku-4-5-20251001"'].join("\n"),
    )
    expect(findings.map((finding) => finding.line)).toEqual([2])
    expect(findings[0]?.message).toContain("anthropic/claude-haiku-4-5-20251001")
    expect(
      findCoreVendorModelPins(
        "packages/core/src/server/server.ts",
        "ModelId.make('openai/gpt-5.1')",
      ).length,
    ).toBe(1)
  })

  test("the declaration site, other packages and non-vendor paths are not reported", () => {
    const pin = 'const model = "anthropic/claude-haiku-4-5"'
    expect(findCoreVendorModelPins("packages/core/src/domain/agent.ts", pin)).toEqual([])
    expect(findCoreVendorModelPins("packages/extensions/src/anthropic.ts", pin)).toEqual([])
    expect(
      findCoreVendorModelPins("packages/core/src/runtime/turn.ts", 'const path = "src/index.ts"'),
    ).toEqual([])
    expect(
      findCoreVendorModelPins("packages/core/src/runtime/turn.ts", "const id = `openai/${model}`"),
    ).toEqual([])
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

  test("the seam file never credits a facet, not even one its own helpers reach", () => {
    // `extensionServicesFromHostContext` mirrors the host-context param into a
    // new struct with `Facet: ctx.Facet` lines, and a helper in the same file
    // may read a facet. Neither is a shipped extension filling the seam:
    // crediting them would make every facet permanently adapted and defeat
    // the dead-facet check. Telepathy is still reported.
    const source = `${facetsSource}
const extensionServicesFromHostContext = (ctx: ExtensionContextService) =>
  Effect.succeed({
    Files: ctx.Files,
    Telepathy: ctx.Telepathy,
  })
export const requireTelepathy = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  return yield* ctx.Telepathy.read("x")
})`
    const adapted = adaptedSeamsIn(SEAMS_FILE, source)
    expect(adapted.size).toBe(0)
    const findings = findUnadaptedSeams(new Map([[SEAMS_FILE, source]]), new Set(["Files"]))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('extension context facet "Telepathy"')
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
      findE2eFixtureImportFindings("packages/e2e/src/pty-fixture.ts", noFixtureSource),
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

describe("a lock include must name a tracked file", () => {
  const LOCKS = "packages/core/tsconfig.locks.json"
  const text = `{\n  "include": [\n    "src",\n    "tests/domain/actor.test.ts"\n  ]\n}`
  const config = { include: ["src", "tests/domain/actor.test.ts"] }

  test("an include naming a tracked file or directory is silent", () => {
    const findings = findMissingLockIncludes(LOCKS, text, config, [
      "packages/core/src/domain/ids.ts",
      "packages/core/tests/domain/actor.test.ts",
    ])
    expect(findings).toEqual([])
  })

  test("a trailing slash, a ./ prefix, a .. segment, and a glob are legal forms", () => {
    const findings = findMissingLockIncludes(
      LOCKS,
      "",
      { include: ["src/", "./tests/domain/actor.test.ts", "../core/src", "tests/**/*.test.ts"] },
      ["packages/core/src/domain/ids.ts", "packages/core/tests/domain/actor.test.ts"],
    )
    expect(findings).toEqual([])
  })

  test("a directory include does not match a sibling that shares its prefix", () => {
    const findings = findMissingLockIncludes(LOCKS, "", { include: ["src"] }, [
      "packages/core/srcfoo/a.ts",
    ])
    expect(findings).toHaveLength(1)
  })

  test("an include naming a deleted test is reported on its line", () => {
    const findings = findMissingLockIncludes(LOCKS, text, config, [
      "packages/core/src/domain/ids.ts",
    ])
    expect(findings.map((finding) => `${finding.line}: ${finding.message}`)).toEqual([
      expect.stringMatching(
        /^4: lock include `tests\/domain\/actor.test.ts` names no tracked file/,
      ),
    ])
  })
})

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
        "const id = Bun.randomUUIDv7()",
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

    // No shipped extension is exempt, the Anthropic driver included.
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/anthropic.ts",
        'import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"',
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/anthropic.ts",
        line: 1,
        message: "Bun platform layers may only be provided by platform roots",
      },
      {
        file: "packages/extensions/src/anthropic.ts",
        line: 1,
        message:
          "Shipped extensions must use @gent/core/extensions/api or @gent/core/extensions/branch-tools, not core internals",
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

  test("does not flag the guard source itself", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/tooling/src/guards.ts",
        ["const id = Bun.randomUUIDv7()", "Layer.provide(BunPlatformLive)"].join("\n"),
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
        ["export class BranchInfo {}", "const id = Bun.randomUUIDv7()"].join("\n"),
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
        message: "Bun.randomUUIDv7 is adapter-only; use GentPlatform.randomId",
      },
    ])
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

// ── retired-surfaces.test ───────────────────────────────────────────────────

/** One planted case per retired surface: file, text, and the matched text. */
const RETIRED_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["packages/core/src/runtime/extension-host.ts", "const runner = ProcessRunner", "ProcessRunner"],
  [
    "packages/core/src/runtime/extension-host.ts",
    "const l = ProcessRunnerLive",
    "ProcessRunnerLive",
  ],
  ["apps/tui/src/services/boundary.ts", "yield* ProcessRunnerService", "ProcessRunnerService"],
  ["packages/core/src/runtime/x.ts", "makeProcessRunner()", "makeProcessRunner"],
  ["packages/extensions/src/cell/cell.ts", "ResourceGraphHost.make()", "ResourceGraphHost"],
  ["packages/core/src/runtime/x.ts", "ResourceGraphPublication.make()", "ResourceGraphPublication"],
  ["packages/core/src/runtime/x.ts", "ResourceLeases.make()", "ResourceLeases"],
  ["packages/core/src/runtime/x.ts", "ResourceGenerationId.make()", "ResourceGenerationId"],
  ["packages/core/src/runtime/x.ts", "ResourceDescriptor.make()", "ResourceDescriptor"],
  ["packages/core/src/runtime/x.ts", "ResourceRevision.make()", "ResourceRevision"],
  ["packages/core/src/runtime/x.ts", "planResourceGraph()", "planResourceGraph"],
  ["packages/core/src/runtime/x.ts", "diffResourceGraph()", "diffResourceGraph"],
  ["packages/core/src/runtime/x.ts", "LiveAgentLoopTurnProfile", "LiveAgentLoopTurnProfile"],
  [
    "packages/core/src/runtime/x.ts",
    "runAgentLoopTurnProfileOrLegacy()",
    "runAgentLoopTurnProfileOrLegacy",
  ],
  [
    "apps/server/src/main.ts",
    'import { x } from "../core/src/resource-graph.js"',
    "resource-graph",
  ],
  [
    "apps/server/src/main.ts",
    'import { x } from "./resource-graph-host.js"',
    "resource-graph-host",
  ],
  ["apps/server/src/main.ts", 'import { x } from "./resource-leases"', "resource-leases"],
  ["apps/server/src/main.ts", 'export { x } from "./resource-lifecycle.ts"', "resource-lifecycle"],
  ["apps/server/src/main.ts", 'import { x } from "./live-profile.js"', "live-profile"],
  ["packages/core/src/runtime/x.ts", "const a = ExtensionRuntime", "ExtensionRuntime"],
  ["packages/core/src/runtime/x.ts", "const b = ExtensionTurnControl", "ExtensionTurnControl"],
  ["packages/core/src/runtime/x.ts", "const c = TurnEvent", "TurnEvent"],
  ["packages/core/src/runtime/x.ts", "const d = TurnEventUsage", "TurnEventUsage"],
  ["packages/core/src/storage/x.ts", "const layer = subTagLayers(base)", "subTagLayers("],
  ["packages/extensions/src/x.ts", "ctx.extension.request(ref)", "ctx.extension"],
  ["packages/extensions/src/x.ts", "// typed RPC helpers", "typed RPC helpers"],
  ["packages/core/src/runtime/x.ts", "const span = GentSpan.start()", "GentSpan"],
  [
    "packages/core/src/storage/x.ts",
    "yield* resetIncompatibleStorageSchema()",
    "resetIncompatibleStorageSchema",
  ],
  ["packages/core/src/runtime/x.ts", "const layer = AuthStorage.LiveFile(path)", "LiveFile"],
  [
    "packages/core/src/server/x.ts",
    "EventStore.Live = EventStore.Memory",
    "EventStore.Live = EventStore.Memory",
  ],
  ["packages/core/src/runtime/x.ts", "const loops = loopsRef", "loopsRef"],
  ["packages/core/src/runtime/x.ts", "const s = mutationSemaphoresRef", "mutationSemaphoresRef"],
  ["packages/core/src/runtime/x.ts", "type Event = LoopDriverEvent", "LoopDriverEvent"],
  ["packages/core/src/runtime/x.ts", "type Handle = LoopHandle", "LoopHandle"],
  ["packages/core/src/runtime/x.ts", "const erased = eraseLayer(layer)", "eraseLayer"],
  ["packages/core/src/runtime/x.ts", "restoreErasedLayer(erased)", "restoreErasedLayer"],
  ["packages/core/src/runtime/x.ts", "type Parent = ServerProfile", "ServerProfile"],
  ["packages/core/src/runtime/x.ts", "type Child = CwdProfile", "CwdProfile"],
  ["packages/core/src/runtime/x.ts", "type Leaf = EphemeralProfile", "EphemeralProfile"],
  ["packages/core/src/runtime/x.ts", "const s = ServerProfileService", "ServerProfileService"],
  ["packages/core/src/runtime/x.ts", "brandServerScope(x)", "brandServerScope"],
  ["packages/core/src/runtime/x.ts", "brandCwdScope(x)", "brandCwdScope"],
  ["packages/core/src/runtime/x.ts", "brandEphemeralScope(x)", "brandEphemeralScope"],
  ["packages/sdk/src/x.ts", "sdkBoundary(x)", "sdkBoundary"],
  ["packages/sdk/src/x.ts", "runSdkBoundary(x)", "runSdkBoundary"],
  ["packages/sdk/src/x.ts", "type B = SdkBoundary", "SdkBoundary"],
  ["apps/server/src/x.ts", 'env["GENT_TRACE_ID"]', "GENT_TRACE_ID"],
  ["apps/server/src/x.ts", 'env["GENT_PARENT_SPAN_ID"]', "GENT_PARENT_SPAN_ID"],
  ["apps/server/src/x.ts", "positiveIntegerOr(x)", "positiveIntegerOr"],
  ["apps/server/src/x.ts", "tcpPortOr(x)", "tcpPortOr"],
  ["apps/server/src/x.ts", "knownModeOr(x)", "knownModeOr"],
  ["apps/server/src/x.ts", "new LaunchConfigError()", "LaunchConfigError"],
  ["packages/extensions/src/x.ts", "type Q = AnyQueryContribution", "AnyQueryContribution"],
  ["packages/extensions/src/x.ts", "type C = CapabilityContribution", "CapabilityContribution"],
  ["packages/core/src/providers/x.ts", "Provider.Sequence([])", "Provider.Sequence"],
  ["packages/core/src/providers/x.ts", "Provider.Signal(reply)", "Provider.Signal"],
  ["packages/core/src/providers/x.ts", "Provider.Debug()", "Provider.Debug"],
  ["packages/core/src/providers/x.ts", "Provider.Failing(error)", "Provider.Failing"],
  ["packages/sdk/src/x.ts", "const port = findOpenPort()", "findOpenPort"],
  ["packages/sdk/src/x.ts", "const host = WORKER_HOST", "WORKER_HOST"],
  ["packages/sdk/src/x.ts", "type S = WorkerLifecycleState", "WorkerLifecycleState"],
  ["packages/extensions/src/x.ts", "defineExtension({ id: 'x', reactions: {} })", "reactions:"],
]

const RETIRED_PATHS: ReadonlyArray<string> = [
  "packages/core/src/server/rpcs/actor.ts",
  "packages/core/src/domain/auth-storage.ts",
  "packages/core/src/domain/auth-store.ts",
  "packages/core/src/domain/auth-method.ts",
  "packages/core/src/runtime/composer.ts",
  "packages/core/src/runtime/scope-brands.ts",
  "packages/sdk/src/server-registry.ts",
  "packages/sdk/src/worker-http.ts",
]

describe("retired surface guard", () => {
  test("every planted retired name, import, and path is reported once", () => {
    for (const [file, text, matched] of RETIRED_CASES) {
      const findings = findRetiredSurfaces(file, text)
      expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([`${file}:1`])
      expect(findings[0]?.message.startsWith(`"${matched}"`)).toBe(true)
    }
    for (const file of RETIRED_PATHS) {
      expect(findRetiredSurfaces(file, "").map((finding) => finding.line)).toEqual([1])
    }
  })

  test("every row has a planted case", () => {
    const rowsHit = new Set<number>()
    for (const [file, text] of RETIRED_CASES) {
      RETIRED_SURFACES.forEach((row, index) => {
        if (
          row.on !== "path" &&
          findRetiredSurfaces(file, text).some((f) => f.message.endsWith(row.message))
        )
          rowsHit.add(index)
      })
    }
    for (const file of RETIRED_PATHS) {
      RETIRED_SURFACES.forEach((row, index) => {
        if (row.on === "path" && row.match.test(file)) rowsHit.add(index)
      })
    }
    expect(rowsHit.size).toBe(RETIRED_SURFACES.length)
  })

  test("a test file is reported only for the process-runner row", () => {
    expect(
      findRetiredSurfaces(
        "packages/core/tests/runtime/session.test.ts",
        'import { ProcessRunnerLive } from "../../src/runtime/run-process"',
      ).length,
    ).toBe(1)
    expect(
      findRetiredSurfaces(
        "packages/core/tests/runtime/extension-host.test.ts",
        ["const host = ResourceGraphHost", "const name = 'TurnEvent'"].join("\n"),
      ),
    ).toEqual([])
  })

  test("docs, plans, the tooling tests and the guard source are not scanned", () => {
    const text = ["ProcessRunner", "ResourceGraphHost", "ExtensionRuntime"].join("\n")
    expect(findRetiredSurfaces("ARCHITECTURE.md", text)).toEqual([])
    expect(findRetiredSurfaces("plans/arch-core.md", text)).toEqual([])
    expect(findRetiredSurfaces("packages/tooling/src/guards.ts", text)).toEqual([])
    expect(findRetiredSurfaces("packages/tooling/tests/guards.test.ts", text)).toEqual([])
  })

  test("live names that contain a retired name are left alone", () => {
    expect(
      findRetiredSurfaces(
        "packages/core/src/server/server.ts",
        [
          'import { InProcessRunner } from "../runtime/agent/agent-runner.js"',
          "runProcess: (command, args, options) => runProcess(command, args, options)",
          "export const ResourceId = Schema.NonEmptyString.pipe(Schema.brand('ResourceId'))",
          'import { buildResourceLayer } from "./extensions/resource-host/resource-layer.js"',
          "persistenceMode === 'memory' ? EventStore.Memory : Layer.provide(EventStoreLive, ...)",
          "const layer = Layer.provideMerge(parent, child)",
        ].join("\n"),
      ),
    ).toEqual([])
    expect(findRetiredSurfaces("packages/core/src/runtime/child-agents.ts", "")).toEqual([])
    expect(findRetiredSurfaces("packages/core/src/runtime/provider.ts", "")).toEqual([])
    expect(findRetiredSurfaces("packages/sdk/src/server.ts", "")).toEqual([])
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
          file: "packages/core/tests/runtime/provider.test.ts",
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
          file: "packages/core/tests/runtime/session.test.ts",
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
          file: "packages/core/tests/runtime/session.test.ts",
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
          file: "apps/tui/tests/extensions/wake.client.test.tsx",
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
