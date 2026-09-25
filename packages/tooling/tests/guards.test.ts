import { describe, expect, test } from "bun:test"
import {
  adaptedSeamsIn,
  collectExportFacts,
  type ExportFacts,
  findAliasTestLayers,
  findBannedEslintDisableBlocks,
  findBlanketEslintDisables,
  findCoreFeatureIndependenceFindings,
  findCoreVendorModelPins,
  findE2eFixtureImportFindings,
  findEffectVersionDrift,
  findRepoTempDirectories,
  findSharedTestHomes,
  findHookWithoutGuards,
  findIdentityEncodes,
  findPackageSurfaceFindings,
  findPlatformDuplicationViolations,
  findReadersWithoutWriters,
  findRetiredSurfaces,
  findSteeringFilePaths,
  findSuppressionInventoryFindings,
  findTuiSessionIdentityReads,
  findUnadaptedSeams,
  findUnconsumedExports,
  findUnenabledPluginRules,
  findUnmatchedIgnoreRows,
  findUnmatchedOverrideGlobs,
  findUnmatchedTsconfigOverrides,
  findUnshippedSkillFiles,
  findUnhashedSteeringFiles,
  BUNDLED_SKILLS_MODULE,
  findUnneededOffs,
  findUnusedCatalogEntries,
  findUnusedDependencies,
  findUnusedSuppressionApprovals,
  guideBlockFile,
  guideCodeBlocks,
  guideCodeContextOf,
  guideDiagnosticLine,
  HOOK_FILE,
  type DependencyScope,
  type InstalledPackage,
  installedDependency,
  isSteeringFile,
  type PackageJson,
  workspaceManifests,
  RETIRED_SURFACES,
  workspaceTsconfigs,
} from "../src/guards"
import { indexFileNames, scanTrackedTexts, trackedTexts } from "../src/check-guardrails"
import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Option, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { it } from "effect-bun-test"

// ── blanket eslint disable ──────────────────────────────────────────────────

const directive = ["eslint", "disable"].join("-")

describe("blanket eslint disable checker", () => {
  test("flags blanket file comments", () => {
    expect(
      findBlanketEslintDisables("sample.ts", `/* ${directive} */\nexport const x = 1`),
    ).toMatchObject([{ file: "sample.ts", line: 1 }])
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
    ).toMatchObject([{ file: "sample.ts", line: 2 }])
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
    ).toMatchObject([{ file: "sample.ts", line: 1 }])
  })

  test("flags the oxlint spelling of blanket and block comments", () => {
    const oxDirective = ["oxlint", "disable"].join("-")
    expect(findBlanketEslintDisables("sample.ts", `// ${oxDirective}-next-line`)).toMatchObject([
      { file: "sample.ts", line: 1 },
    ])
    expect(
      findBannedEslintDisableBlocks("sample.ts", `/* ${oxDirective} effect/noNullish -- reason */`),
    ).toMatchObject([{ file: "sample.ts", line: 1 }])
    expect(
      findBannedEslintDisableBlocks("sample.ts", `// ${oxDirective}-next-line effect/noNullish`),
    ).toEqual([])
  })

  test("flags a file-wide disable written as a line comment, in both spellings", () => {
    // oxlint honours `// <tool>-disable <rule>` to the end of the file, the
    // same as the block form.
    const oxDirective = ["oxlint", "disable"].join("-")
    expect(
      findBannedEslintDisableBlocks(
        "sample.ts",
        [`// ${directive} effect/noNullish`, `// ${oxDirective} effect/noNullish`].join("\n"),
      ),
    ).toMatchObject([
      { file: "sample.ts", line: 1 },
      { file: "sample.ts", line: 2 },
    ])
  })

  test("allows block comments only in explicit fixture files", () => {
    expect(
      findBannedEslintDisableBlocks(
        "tests/fixtures/bad-suppression.ts",
        `/* ${directive} @typescript-eslint/no-unsafe-type-assertion -- fixture */`,
      ),
    ).toEqual([])
  })

  test("a file named like a fixture outside a fixtures directory is not exempt", () => {
    const block = `/* ${directive} @typescript-eslint/no-unsafe-type-assertion -- probe */`
    expect(
      [
        "packages/tooling/src/fixture-runner.ts",
        "packages/e2e/src/pty-fixture.ts",
        "packages/sdk/src/fixtures.ts",
      ].map((file) => findBannedEslintDisableBlocks(file, block).length),
    ).toEqual([1, 1, 1])
  })
})

// ── alias test layers ───────────────────────────────────────────────────────

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

// ── core feature independence ───────────────────────────────────────────────

describe("core feature independence guard", () => {
  test("flags core naming a table the cell owns", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/storage/schema.ts",
      "    CREATE TABLE cell_executions (",
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain("feature-migrations seam")
  })

  test("lets the cell extension name its own tables", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/extensions/src/cell.ts",
      "    CREATE TABLE cell_executions (",
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

// ── identity encode ─────────────────────────────────────────────────────────

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
    expect(
      identityLines(file, 'const identity = encodeJson(["tool", 1, true, call?.id, null])'),
    ).toEqual([])
    expect(
      identityLines(file, "const key = encodeJson([s._tag, toolFingerprint(s.toolCall)])"),
    ).toEqual([])
  })

  test("reports an array literal that carries a whole object", () => {
    const file = "apps/tui/src/message-list.tsx"
    expect(identityLines(file, "const identity = encodeJson([item])")).toEqual([2])
    expect(identityLines(file, "const identity = encodeJson([item.id, { a: 1 }])")).toEqual([2])
    expect(identityLines(file, "const identity = encodeJson([item.id, rest(item)])")).toEqual([2])
  })

  test("checks each encode on a line, so a safe one does not hide an unsafe one", () => {
    const file = "packages/core/src/runtime/turn.ts"
    expect(identityLines(file, "if (encodeJson([a.id]) === encodeJson(b)) return")).toEqual([2])
    expect(
      identityLines(file, "if (encodeJson(aFingerprint(a)) === encodeJson(b)) return"),
    ).toEqual([2])
    expect(identityLines(file, "if (encodeJson([a.id]) === encodeJson([b.id])) return")).toEqual([])
  })

  test("scans shipped source only", () => {
    expect(
      identityLines("packages/core/tests/x.test.ts", "const identity = encodeJson(m)"),
    ).toEqual([])
    expect(identityLines("ARCHITECTURE.md", "const identity = encodeJson(m)")).toEqual([])
  })
})

// ── vendor model pins ───────────────────────────────────────────────────────

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

// ── unadapted seams ─────────────────────────────────────────────────────────

const SEAMS_FILE = "packages/core/src/domain/extension.ts"

const facetsSource = `export interface ExtensionContextService {
  readonly extensionId: ExtensionId
  readonly cwd: string
  readonly State: ExtensionStateService
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
       yield* ctx.State.publish("notes")
       defineResource({ id: "notes", scope: "process", layer })`,
    )
    expect([...seams].sort()).toEqual(["State", "process"])
  })

  test("a facet nothing reaches is reported", () => {
    const findings = findUnadaptedSeams(new Map([[SEAMS_FILE, facetsSource]]), new Set(["State"]))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('extension context facet "Telepathy"')
    expect(findings[0]?.line).toBe(5)
  })

  test("plain context facts are not seams", () => {
    // `extensionId` and `cwd` are data an extension reads, not facades it
    // reaches through. Reporting them would make the guard unusable.
    const findings = findUnadaptedSeams(
      new Map([[SEAMS_FILE, facetsSource]]),
      new Set(["State", "Telepathy"]),
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
    State: ctx.State,
    Telepathy: ctx.Telepathy,
  })
export const requireTelepathy = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  return yield* ctx.Telepathy.read("x")
})`
    const adapted = adaptedSeamsIn(SEAMS_FILE, source)
    expect(adapted.size).toBe(0)
    const findings = findUnadaptedSeams(new Map([[SEAMS_FILE, source]]), new Set(["State"]))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('extension context facet "Telepathy"')
  })
})

// ── e2e fixture imports ─────────────────────────────────────────────────────

const noFixtureSource = [
  'import { describe, expect, it } from "effect-bun-test"',
  'import { Effect } from "effect"',
  'import { Gent } from "@gent/sdk"',
  'import { makeTempDirectoryScoped } from "@gent/core/test-utils"',
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

// ── test temp directories ───────────────────────────────────────────────────

describe("repo temp directory guard", () => {
  const testFile = "packages/core/tests/runtime/loader.test.ts"

  test("a directory option under import.meta is reported", () => {
    const source = [
      "const root = yield* fs.makeTempDirectoryScoped({",
      '  directory: path.resolve(import.meta.dir, "../.."),',
      '  prefix: "gent-x-",',
      "})",
    ].join("\n")
    expect(findRepoTempDirectories(testFile, source).map((finding) => finding.line)).toEqual([2])
  })

  test("a directory option naming a binding from import.meta is reported", () => {
    const source = [
      'const packageRoot = path.resolve(import.meta.dir, "../../..")',
      'const dir = yield* fs.makeTempDirectoryScoped({ directory: packageRoot, prefix: "x-" })',
    ].join("\n")
    expect(findRepoTempDirectories(testFile, source).map((finding) => finding.line)).toEqual([2])
  })

  test("a .tmp- path joined to import.meta is reported", () => {
    const source = 'const TEST_DIR = join(import.meta.dir, "../../.tmp-ext-integration")'
    expect(findRepoTempDirectories(testFile, source)).toHaveLength(1)
  })

  test("a tmp path of any spelling joined to a repo path is reported", () => {
    const sources = [
      'const dir = join(import.meta.dir, ".tmp")',
      'const dir = join(__dirname, "tmp", "case")',
      'const dir = path.resolve(import.meta.dirname, "../temp-fixtures")',
    ]
    expect(sources.map((source) => findRepoTempDirectories(testFile, source).length)).toEqual([
      1, 1, 1,
    ])
  })

  test("a temp directory call rooted in the repo is reported, whatever its prefix", () => {
    const sources = [
      'const dir = mkdtempSync(join(__dirname, "fixture-"))',
      'const dir = mkdtempSync(path.join("packages/core/tests", "case-"))',
      'const dir = yield* fs.makeTempDirectory({ directory: resolve("./apps/tui") })',
      [
        "const packageRoot = path.resolve(__dirname, '..')",
        "const dir = yield* fs.makeTempDirectoryScoped({",
        '  prefix: "case-",',
        "  directory: packageRoot,",
        "})",
      ].join("\n"),
    ]
    expect(
      sources.map((source) => findRepoTempDirectories(testFile, source).map((f) => f.line)),
    ).toEqual([[1], [1], [1], [4]])
  })

  test("a temp directory rooted in the working directory is reported", () => {
    const sources = [
      'const dir = mkdtempSync(join(process.cwd(), "tmp-"))',
      "const dir = yield* fs.makeTempDirectoryScoped({ directory: process.cwd() })",
      'const dir = yield* fs.makeTempDirectoryScoped({ directory: path.resolve("out") })',
      'const dir = yield* fs.makeTempDirectoryScoped({ directory: "./scratch" })',
      'const dir = mkdtempSync("case-")',
      ["const here = process.cwd()", 'const dir = mkdtempSync(join(here, "case-"))'].join("\n"),
    ]
    expect(
      sources.map((source) => findRepoTempDirectories(testFile, source).map((f) => f.line)),
    ).toEqual([[1], [1], [1], [1], [1], [2]])
  })

  test("an absolute prefix and a helper that takes a prefix pass", () => {
    const source = [
      'const a = mkdtempSync("/tmp/gent-case-")',
      "const b = mkdtempSync(`${tmpdir()}/gent-case-`)",
      'const c = yield* fs.makeTempDirectoryScoped({ directory: "/nonexistent/gent-probe-x" })',
      'const d = yield* makeTempDirectoryScoped("gent-case-")',
    ].join("\n")
    expect(findRepoTempDirectories(testFile, source)).toEqual([])
  })

  test("a system temp directory and a read of the source tree pass", () => {
    const source = [
      'const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-x-" })',
      'const dir = path.resolve(import.meta.dir, "../../src/extensions")',
      "const other = yield* fs.makeTempDirectoryScoped({ directory: root })",
      'const sys = mkdtempSync(join(tmpdir(), "gent-case-"))',
      'const template = path.join(import.meta.dir, "templates", "prompt.md")',
    ].join("\n")
    expect(findRepoTempDirectories(testFile, source)).toEqual([])
  })

  test("product source is out of scope", () => {
    const source = 'const dir = { directory: path.resolve(import.meta.dir, "..") }'
    expect(findRepoTempDirectories("packages/core/src/runtime/x.ts", source)).toEqual([])
  })
})

// ── a test's home is its own ────────────────────────────────────────────────

describe("shared test home checker", () => {
  const testFile = "apps/tui/tests/render-harness-boundary.tsx"
  const lines = (source: string, file = testFile) =>
    findSharedTestHomes(file, source).map((finding) => finding.line)

  test("a home or data directory under the shared temp root is reported, in every shape", () => {
    const source = [
      '<WorkspaceProvider cwd={cwd} home="/tmp" services={services}>',
      'const env = { cwd: "/tmp", home: "/tmp" }',
      'RuntimeEnvironment.Live({ home: "/tmp/test-home", cwd: "/tmp" })',
      'const logs = logDirFor({ GENT_DATA_DIR: "/var/tmp/gent-scratch" })',
      'const platform = (home: string = "/private/tmp") => home',
      'home: overrides?.home ?? "/tmp",',
      'homeDirectory: Effect.succeed("/dev/shm/x"),',
      "const facts = { home: tmpdir() }",
      'process.env.HOME = "/tmp"',
    ].join("\n")
    expect(lines(source)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test("a working or extension directory under the shared temp root is reported like a home", () => {
    const source = [
      'const { sessionId } = yield* client.session.create({ cwd: "/tmp" })',
      'const alphaCwd = "/tmp/gent-alpha-profile"',
      'loadClientExtensions({ userDir: "/tmp/user", projectDir: "/tmp/project" })',
      '...(yield* runtimeHostContext({ ...parent, sessionCwd: "/tmp" })),',
      "const facts = { cwd: tmpdir() }",
    ].join("\n")
    expect(lines(source)).toEqual([1, 2, 3, 4, 5])
  })

  test("a scoped temp home, a path no test can create, or a temp path under another name is not reported", () => {
    const source = [
      'const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-home-" })',
      'const env = { cwd: "/nonexistent/gent-test-cwd", home: "/nonexistent/gent-test-home" }',
      "RuntimeEnvironment.Live({ home, cwd })",
      'RuntimeEnvironment.Live({ home: root, cwd: yield* makeTempDirectoryScoped("gent-cwd-") })',
      'const workspace = workspaceIdForCwd("/tmp/run-workspace")',
      '{ extension, scope: "user", sourcePath: "/tmp/good.ts" }',
      'const home = mkdtempSync(join(tmpdir(), "gent-home-"))',
      'const homePage = "/tmp/page"',
      '// home: "/tmp" in a comment',
      'if (home === "/tmp/x") return',
      'const probe = home => "/tmp/x"',
    ].join("\n")
    expect(lines(source)).toEqual([])
  })

  test("the value is read as an expression: across a line break, in a template or a join", () => {
    const source = [
      "const env = {",
      "  home:",
      '    "/tmp",',
      "}",
      "const a = { home: `${tmpdir()}/case` }",
      'const b = { home: Path.join(tmpdir(), "case") }',
      'const c = { home: path.join("/tmp", "case") }',
    ].join("\n")
    expect(lines(source)).toEqual([2, 5, 6, 7])
  })

  test("a shared path in a sibling property does not make a unique home shared", () => {
    const source = [
      'const home = mkdtempSync(join(tmpdir(), "gent-home-")); const opts = { directory: "/tmp" }',
      'const env = { home: yield* makeTempDirectoryScoped("gent-home-"), directory: "/tmp" }',
      'const env2 = { home: root, directory: "/tmp" }',
      'const env3 = { home: yield* fs.makeTempDirectoryScoped({ directory: "/tmp" }) }',
      'const env4 = { home: mkdtempSync("/tmp/gent-home-") }',
      // A template is one value: its `'` opens no string that runs past the comma.
      'const env5 = { home: `${root}/it\'s`, directory: "/tmp" }',
    ]
    // Each alone too: a value read past its end would take a later line's `mkdtemp`.
    expect(source.flatMap((line) => lines(line))).toEqual([])
    expect(lines(source.join("\n"))).toEqual([])
  })

  test("a test layer in product source is read, the product code around it is not", () => {
    const product = "packages/core/src/runtime/gent-platform.ts"
    const source = [
      "export class GentPlatform extends Context.Service<GentPlatform>()(TAG) {",
      "  static Live = Layer.succeed(GentPlatform, {",
      '    homeDirectory: Effect.succeed("/tmp"),',
      "  })",
      '  static Test = (prefix = "id"): Layer.Layer<GentPlatform> =>',
      "    Layer.effect(",
      "      GentPlatform,",
      "      Effect.gen(function* () {",
      "        return GentPlatform.of({",
      '          homeDirectory: Effect.succeed("/tmp"),',
      "        })",
      "      }),",
      "    )",
      "  static Other = Layer.succeed(GentPlatform, {",
      '    homeDirectory: Effect.succeed("/tmp"),',
      "  })",
      "}",
      "export const FakeTestActor = (config: {",
      "  readonly id: string",
      "}) =>",
      '  Layer.succeed(Actor, { home: "/tmp" })',
      'const fallback = { home: "/tmp", cwd: "/tmp" }',
    ].join("\n")
    expect(lines(source, product)).toEqual([10, 21])
  })

  test("the tooling package is out of scope; the test harness is test code", () => {
    const source = 'homeDirectory: Effect.succeed("/tmp"),'
    expect(lines(source, "packages/tooling/tests/guards.test.ts")).toEqual([])
    expect(lines(source, "packages/tooling/src/guards.ts")).toEqual([])
    expect(lines(source, "packages/core/src/test-utils/harness.ts")).toEqual([1])
  })
})

// ── hook runs guards ────────────────────────────────────────────────────────

const hook = (...jobs: ReadonlyArray<string>): string =>
  ["pre-commit:", "  parallel: false", "  jobs:", ...jobs].join("\n")

const GUARDS = ["    - name: guards", "      run: bun run guards"]
const LINT = [
  "    - name: lint+fmt",
  "      run: bun run lint:fix && bun run fmt",
  "      stage_fixed: true",
]
const TEST = ["    - name: test", "      run: bun run test"]

describe("pre-commit hook runs the guards", () => {
  test("accepts the guards job in any position, under any name", () => {
    expect(findHookWithoutGuards(HOOK_FILE, hook(...GUARDS, ...LINT, ...TEST))).toEqual([])
    expect(findHookWithoutGuards(HOOK_FILE, hook(...LINT, ...TEST, ...GUARDS))).toEqual([])
    const renamed = ["    - name: fast-checks", "      run: bun run guards"]
    expect(findHookWithoutGuards(HOOK_FILE, hook(...renamed, ...LINT))).toEqual([])
  })

  test("flags a hook with no guards job", () => {
    const findings = findHookWithoutGuards(HOOK_FILE, hook(...LINT, ...TEST))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain("runs no `bun run guards` job")
  })

  test("a guards job under another hook does not count", () => {
    const text = ["pre-push:", "  jobs:", ...GUARDS, "pre-commit:", "  jobs:", ...LINT].join("\n")
    expect(findHookWithoutGuards(HOOK_FILE, text)).toHaveLength(1)
    expect(
      findHookWithoutGuards(
        HOOK_FILE,
        ["pre-commit:", "  jobs:", ...LINT, "pre-push:", ...GUARDS].join("\n"),
      ),
    ).toHaveLength(1)
  })

  test("a comment that names the guards command does not count", () => {
    const comment = ["    # Run bun run guards before committing."]
    expect(findHookWithoutGuards(HOOK_FILE, hook(...comment, ...LINT))).toHaveLength(1)
    const trailing = ["    - name: lint", "      run: bun run lint:fix # then bun run guards"]
    expect(findHookWithoutGuards(HOOK_FILE, hook(...trailing))).toHaveLength(1)
    const named = ["    - name: bun run guards", "      run: bun run lint:fix"]
    expect(findHookWithoutGuards(HOOK_FILE, hook(...named))).toHaveLength(1)
  })

  test("accepts the guards command as one step of a compound run", () => {
    const chained = ["    - name: checks", "      run: bun run guards && bun run lint:fix"]
    expect(findHookWithoutGuards(HOOK_FILE, hook(...chained))).toEqual([])
  })

  test("leaves every other file alone", () => {
    expect(findHookWithoutGuards("package.json", hook(...LINT, ...TEST))).toEqual([])
  })
})

// ── lint config ─────────────────────────────────────────────────────────────

const CONFIG = ".oxlintrc.json"
const PLUGIN = "packages/tooling/src/gent-rules.ts"

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
    expect(messages(findings)).toEqual([
      expect.stringContaining("matches no staged or committed file"),
    ])
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

describe("an ignore row must match a file oxlint would lint", () => {
  const tracked = [
    "packages/extensions/src/skills/markdown.d.ts",
    "packages/tooling/fixtures/case.ts",
    "packages/core/src/index.ts",
  ]

  test("a row that takes out a file is silent, in each gitignore form", () => {
    const text = [
      "# comment",
      "",
      "**/*.d.ts",
      "packages/tooling/fixtures/",
      "/packages/core",
      "index.ts",
      "!packages/keep.ts",
    ].join("\n")
    expect(findUnmatchedIgnoreRows(".oxlintignore", text, tracked)).toEqual([])
  })

  test("a row for build output git already ignores is reported at its line", () => {
    const text = ["**/*.d.ts", "**/dist/", ".tmp-*"].join("\n")
    expect(
      findUnmatchedIgnoreRows(".oxlintignore", text, tracked).map((finding) => finding.line),
    ).toEqual([2, 3])
  })
})

describe("every guard reads one file set, the git index", () => {
  const gitTest = it.scopedLive.layer(BunServices.layer)
  const PROBE = "packages/extensions/src/probe-new.ts"

  /**
   * Git's whole environment for the scratch repository: `PATH`, and the
   * repository itself as `HOME`, so no user config applies. Nothing is
   * inherited: a pre-commit hook exports `GIT_INDEX_FILE` and friends, which
   * would aim the scratch git at the real repository's index.
   */
  const scratchEnv = (root: string, extra: Readonly<Record<string, string>> = {}) =>
    Effect.map(Config.string("PATH"), (PATH) => ({ PATH, HOME: root, ...extra }))

  const git = (
    root: string,
    args: ReadonlyArray<string>,
    extra: Readonly<Record<string, string>> = {},
  ) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const identity = ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid"]
      const command = ChildProcess.make("git", [...identity, ...args], {
        cwd: root,
        env: yield* scratchEnv(root, extra),
        extendEnv: false,
      })
      expect(yield* spawner.exitCode(command)).toBe(ChildProcessSpawner.ExitCode(0))
    })

  /** A scratch repository with one commit, and `files` written but not added. */
  const scratchRepo = (files: ReadonlyArray<readonly [string, string]>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guard-index-" })
      yield* fs.writeFileString(path.join(root, "README.md"), "scratch\n")
      yield* git(root, ["init", "-q"])
      yield* git(root, ["add", "README.md"])
      yield* git(root, ["commit", "-qm", "init"])
      for (const [file, text] of files) {
        yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
        yield* fs.writeFileString(path.join(root, file), text)
      }
      return root
    })

  gitTest("a staged new file outside a hook satisfies the override that names it", () =>
    Effect.gen(function* () {
      const root = yield* scratchRepo([[PROBE, "export {}\n"]])
      yield* git(root, ["add", PROBE])
      const findings = findUnmatchedOverrideGlobs(
        CONFIG,
        `{ "files": ["${PROBE}"] }`,
        { overrides: [{ files: [PROBE] }] },
        yield* indexFileNames(root, yield* scratchEnv(root)),
      )
      expect(findings).toEqual([])
    }),
  )

  gitTest("an untracked file does not satisfy a steering file's path claim", () =>
    Effect.gen(function* () {
      const root = yield* scratchRepo([[PROBE, "export {}\n"]])
      const { findings } = scanTrackedTexts(
        [{ file: "AGENTS.md", text: `The probe lives in \`${PROBE}\`.\n` }],
        yield* indexFileNames(root, yield* scratchEnv(root)),
      )
      expect(messages(findings.filter((finding) => finding.file === "AGENTS.md"))).toEqual([
        expect.stringContaining(`\`${PROBE}\`, which no staged or committed file matches`),
      ])
    }),
  )

  gitTest("in a hook the index git hands the hook is the file set", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const root = yield* scratchRepo([[PROBE, "export {}\n"]])
      const hookIndex = { GIT_INDEX_FILE: path.join(root, ".git", "next-index.lock") }
      yield* git(root, ["read-tree", "HEAD"], hookIndex)
      yield* git(root, ["add", PROBE], hookIndex)
      expect(yield* indexFileNames(root, yield* scratchEnv(root, hookIndex))).toContain(PROBE)
      expect(yield* indexFileNames(root, yield* scratchEnv(root))).not.toContain(PROBE)
    }),
  )

  const STAGED_TEST = "packages/core/tests/runtime/probe.test.ts"
  const STAGED_VIOLATION = 'const TEST_DIR = join(import.meta.dir, "../../.tmp-probe")\n'
  // Multibyte text: the index read splits blobs by byte size, not by characters.
  const STAGED_NEIGHBOUR: readonly [string, string] = ["docs/probe.md", "café — naïve ✓\n"]

  gitTest("in a hook the scan reads the staged text, not the fix left on disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* scratchRepo([[STAGED_TEST, STAGED_VIOLATION], STAGED_NEIGHBOUR])
      const hookIndex = { GIT_INDEX_FILE: path.join(root, ".git", "next-index.lock") }
      yield* git(root, ["read-tree", "HEAD"], hookIndex)
      yield* git(root, ["add", STAGED_TEST, STAGED_NEIGHBOUR[0]], hookIndex)
      // The commit holds the violation; only the working file is fixed.
      yield* fs.writeFileString(path.join(root, STAGED_TEST), "export {}\n")
      const env = yield* scratchEnv(root, hookIndex)
      const indexFiles = yield* indexFileNames(root, env)
      const texts = yield* trackedTexts(root, env, indexFiles)
      expect(texts).toEqual([
        { file: "README.md", text: "scratch\n" },
        { file: STAGED_NEIGHBOUR[0], text: STAGED_NEIGHBOUR[1] },
        { file: STAGED_TEST, text: STAGED_VIOLATION },
      ])
      const { findings } = scanTrackedTexts(texts, indexFiles)
      expect(findings.filter((finding) => finding.file === STAGED_TEST)).toHaveLength(1)
    }),
  )

  gitTest("outside a hook the scan reads the working file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* scratchRepo([[STAGED_TEST, STAGED_VIOLATION]])
      yield* git(root, ["add", STAGED_TEST])
      yield* fs.writeFileString(path.join(root, STAGED_TEST), "export {}\n")
      const env = yield* scratchEnv(root)
      const texts = yield* trackedTexts(root, env, [STAGED_TEST])
      expect(texts).toEqual([{ file: STAGED_TEST, text: "export {}\n" }])
    }),
  )
})

describe("a tsconfig plugin override must match a tracked file", () => {
  const config = (include: ReadonlyArray<string>) => ({
    compilerOptions: { plugins: [{ overrides: [{ include }] }] },
  })

  test("an include glob that matches is silent, a dead one is reported at its line", () => {
    const text = `{\n  "include": ["**/tests/**/*.ts",\n  "testbeds/gone/gone.ts"]\n}`
    const findings = findUnmatchedTsconfigOverrides(
      "tsconfig.json",
      text,
      config(["**/tests/**/*.ts", "testbeds/gone/gone.ts"]),
      ["packages/core/tests/a.test.ts"],
    )
    expect(findings.map((finding) => [finding.line, finding.message])).toEqual([
      [
        3,
        expect.stringContaining(
          '`include: "testbeds/gone/gone.ts"` matches no staged or committed file',
        ),
      ],
    ])
  })
})

describe('an override "off" must suppress a diagnostic', () => {
  const configText = [
    "{",
    '  "overrides": [',
    '    { "files": ["apps/tui/scripts/build.ts"],',
    '      "rules": { "effect/noGlobals": "off", "gent/no-bun-outside-adapter": "off" } },',
    '    { "files": ["**/tests/**"],',
    '      "rules": {',
    '        "typescript/no-explicit-any": "off"',
    "      } }",
    "  ]",
    "}",
  ].join("\n")
  const config = {
    overrides: [
      {
        files: ["apps/tui/scripts/build.ts"],
        rules: { "effect/noGlobals": "off", "gent/no-bun-outside-adapter": "off" },
      },
      { files: ["**/tests/**"], rules: { "typescript/no-explicit-any": "off" } },
    ],
  }
  const allHit = [
    { file: "apps/tui/scripts/build.ts", code: "effect(noGlobals)" },
    { file: "apps/tui/scripts/build.ts", code: "gent(no-bun-outside-adapter)" },
    { file: "packages/core/tests/a.test.ts", code: "typescript(no-explicit-any)" },
  ]

  test("an off whose rule reports in the override's files is silent", () => {
    expect(findUnneededOffs(CONFIG, configText, config, allHit)).toEqual([])
  })

  test("an off with no diagnostic is reported at its rule's line", () => {
    const findings = findUnneededOffs(CONFIG, configText, config, allHit.slice(1))
    expect(findings.map((finding) => [finding.line, finding.message])).toEqual([
      [4, expect.stringContaining("turns off `effect/noGlobals`, which reports nothing")],
    ])
  })

  test("a diagnostic in a file outside the override's globs does not count", () => {
    const findings = findUnneededOffs(CONFIG, configText, config, [
      ...allHit.slice(0, 2),
      { file: "packages/core/src/a.ts", code: "typescript(no-explicit-any)" },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([7])
  })

  test("a diagnostic another override also turns off belongs to neither", () => {
    const shared = {
      overrides: [
        ...config.overrides,
        { files: ["packages/core/tests/**"], rules: { "typescript/no-explicit-any": "off" } },
      ],
    }
    const findings = findUnneededOffs(CONFIG, configText, shared, allHit)
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining('"**/tests/**" turns off `typescript/no-explicit-any`'),
      expect.stringContaining('"packages/core/tests/**" turns off `typescript/no-explicit-any`'),
    ])
  })

  test("a rule an override sets to a severity is not an off", () => {
    const enabling = { overrides: [{ files: ["**/tests/**"], rules: { "effect/noAs": "error" } }] }
    expect(findUnneededOffs(CONFIG, configText, enabling, [])).toEqual([])
  })
})

describe('a root "off" must suppress a diagnostic', () => {
  const configText = [
    "{",
    '  "rules": {',
    '    "no-shadow": "off",',
    '    "typescript/await-thenable": "off",',
    '    "complexity": ["error", 20]',
    "  },",
    '  "overrides": [',
    '    { "files": ["**/tests/**"], "rules": { "typescript/await-thenable": "error" } }',
    "  ]",
    "}",
  ].join("\n")
  const config = {
    rules: {
      "no-shadow": "off",
      "typescript/await-thenable": "off",
      complexity: ["error", 20],
    },
    overrides: [{ files: ["**/tests/**"], rules: { "typescript/await-thenable": "error" } }],
  }

  test("a root off whose rule reports somewhere is silent", () => {
    const findings = findUnneededOffs(CONFIG, configText, config, [
      { file: "packages/core/src/a.ts", code: "eslint(no-shadow)" },
      { file: "packages/core/src/b.ts", code: "typescript(await-thenable)" },
    ])
    expect(findings).toEqual([])
  })

  test("a root off with no diagnostic is reported at its rule's line", () => {
    const findings = findUnneededOffs(CONFIG, configText, config, [
      { file: "packages/core/src/a.ts", code: "eslint(no-shadow)" },
    ])
    expect(findings.map((finding) => [finding.line, finding.message])).toEqual([
      [4, expect.stringContaining("root config turns off `typescript/await-thenable`")],
    ])
  })

  test("a diagnostic in a file an override sets the rule for does not count", () => {
    const findings = findUnneededOffs(CONFIG, configText, config, [
      { file: "packages/core/src/a.ts", code: "eslint(no-shadow)" },
      { file: "packages/core/tests/a.test.ts", code: "typescript(await-thenable)" },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([4])
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
  const defined = ["no-sleep", "no-make-unsafe"]

  test("a rule the root config enables is silent", () => {
    const findings = findUnenabledPluginRules(
      PLUGIN,
      plugin,
      defined,
      new Set(["gent/no-sleep", "gent/no-make-unsafe"]),
    )
    expect(findings).toEqual([])
  })

  test("a rule the root config never enables is reported", () => {
    // no-make-unsafe shipped unenabled, and could not be enabled at all:
    // seven live makeUnsafe calls would have failed it.
    const findings = findUnenabledPluginRules(PLUGIN, plugin, defined, new Set(["gent/no-sleep"]))
    expect(messages(findings)).toEqual([
      expect.stringContaining("`gent/no-make-unsafe` is defined but the root config never enables"),
    ])
  })

  test("the finding points at the line the rule is defined on", () => {
    const findings = findUnenabledPluginRules(PLUGIN, plugin, defined, new Set(["gent/no-sleep"]))
    expect(findings.map((finding) => finding.line)).toEqual([5])
  })

  test("the rule set comes from the plugin object, not from how its text is indented", () => {
    // The text scrape read only a four-space `"name": {` key; a reformat
    // would have hidden every rule from the guard.
    const reformatted = `rules: { "no-sleep": { create() {} }, "no-make-unsafe": { create() {} } }`
    const findings = findUnenabledPluginRules(
      PLUGIN,
      reformatted,
      defined,
      new Set(["gent/no-sleep"]),
    )
    expect(findings.map((finding) => [finding.line, finding.message.split("`")[1]])).toEqual([
      [1, "gent/no-make-unsafe"],
    ])
  })
})

describe("a read variable must have a writer", () => {
  const none: ReadonlyMap<string, string> = new Map()

  test("a variable something in the tree sets is silent", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_CHILD_ID"))\n`],
        ["packages/sdk/src/spawn.ts", `const env = { GENT_CHILD_ID: id }\n`],
      ]),
      none,
    )
    expect(findings).toEqual([])
  })

  test("a variable nothing sets is reported", () => {
    // GENT_TRACE_ID outlived its writer and kept an unreachable branch alive.
    const findings = findReadersWithoutWriters(
      new Map([["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`]]),
      none,
    )
    expect(messages(findings)).toEqual([
      expect.stringContaining("`GENT_ORPHAN` is read but nothing in the tree sets it"),
    ])
  })

  test("every reader shape is seen: the name last, broken across lines, or behind a helper", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        [
          "packages/sdk/src/reader.ts",
          [
            `const mode = Config.literals(["a", "b"], "GENT_PROBE_B")`,
            `const level = Config.literals(NAMES,`,
            `  "GENT_PROBE_C",`,
            `)`,
            `const dir = optionalEnv("GENT_PROBE_D")`,
            `const link = process.env["GENT_PROBE_E"] === "1"`,
          ].join("\n"),
        ],
      ]),
      none,
    )
    expect(findings.map((finding) => [finding.line, finding.message.split("`")[1]])).toEqual([
      [1, "GENT_PROBE_B"],
      [3, "GENT_PROBE_C"],
      [5, "GENT_PROBE_D"],
      [6, "GENT_PROBE_E"],
    ])
  })

  test("a direct property read is a read: process.env.X and Bun.env.X", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        [
          "packages/sdk/src/reader.ts",
          [`const a = process.env.GENT_PROBE_G`, `const b = Bun.env.GENT_PROBE_H ?? "x"`].join(
            "\n",
          ),
        ],
      ]),
      none,
    )
    expect(findings.map((finding) => [finding.line, finding.message.split("`")[1]])).toEqual([
      [1, "GENT_PROBE_G"],
      [2, "GENT_PROBE_H"],
    ])
  })

  test("a string that shows the assignment in another production file sets nothing", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`],
        [
          "packages/sdk/src/help.ts",
          `console.log("run with GENT_ORPHAN=1")\nconst hint = "GENT_ORPHAN: on"\n`,
        ],
      ]),
      none,
    )
    expect(messages(findings)).toEqual([
      expect.stringContaining("`GENT_ORPHAN` is read but nothing in the tree sets it"),
    ])
  })

  test("each real writer shape sets the variable", () => {
    const reader = [
      `Config.string("GENT_W_SPAWN")`,
      `Config.string("GENT_W_ASSIGN")`,
      `Config.string("GENT_W_INDEX")`,
      `Config.string("GENT_W_SCRIPT")`,
    ].join("\n")
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", reader],
        [
          "packages/sdk/src/spawn.ts",
          `Bun.spawn(["gent"], {\n  env: { ...process.env, GENT_W_SPAWN: "1" },\n})\n`,
        ],
        [
          "packages/sdk/src/boot.ts",
          `process.env.GENT_W_ASSIGN = "1"\nBun.env["GENT_W_INDEX"] = "1"\n`,
        ],
        ["apps/tui/package.json", `{ "scripts": { "dev": "GENT_W_SCRIPT=1 bun run x" } }\n`],
      ]),
      none,
    )
    expect(findings).toEqual([])
  })

  test("a shell prefix outside a package script sets nothing", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.string("GENT_W_TEXT")\n`],
        ["packages/sdk/src/help.ts", `const usage = "GENT_W_TEXT=1 gent"\n`],
      ]),
      none,
    )
    expect(messages(findings)).toEqual([expect.stringContaining("`GENT_W_TEXT`")])
  })

  test("a comment that shows how to set a variable, or a message naming it, is not a writer", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        [
          "packages/sdk/src/reader.ts",
          [
            `// run with GENT_PROBE_F=1 to enable`,
            `Config.string("GENT_PROBE_F")`,
            "fail(`invalid GENT_PROBE_F: ${reason}`)",
          ].join("\n"),
        ],
      ]),
      none,
    )
    expect(messages(findings)).toEqual([expect.stringContaining("`GENT_PROBE_F`")])
  })

  test("a variable the operator sets is allowed, with its reason", () => {
    const findings = findReadersWithoutWriters(
      new Map([["packages/sdk/src/logger.ts", `Config.option(Config.string("GENT_LOG_LEVEL"))\n`]]),
      new Map([["GENT_LOG_LEVEL", "a developer sets this by hand"]]),
    )
    expect(findings).toEqual([])
  })

  test("only test support sets it, so the production reader is still reported", () => {
    // A test, the e2e fixtures, or the core harness setting a variable proves
    // the reader works, not that anything in production supplies it.
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_TEST_ONLY"))\n`],
        ["packages/sdk/tests/reader.test.ts", `const env = { GENT_TEST_ONLY: "1" }\n`],
        ["packages/e2e/src/pty-fixture.ts", `const env = { GENT_TEST_ONLY: "1" }\n`],
        ["packages/core/src/test-utils/harness.ts", `env["GENT_TEST_ONLY"] = "1"\n`],
      ]),
      none,
    )
    expect(findings.map((finding) => finding.file)).toEqual(["packages/sdk/src/reader.ts"])
  })

  test("a test that names a variable is not a reader", () => {
    const findings = findReadersWithoutWriters(
      new Map([["packages/sdk/tests/reader.test.ts", `expect(e).toContain("GENT_NAMED")\n`]]),
      none,
    )
    expect(findings).toEqual([])
  })

  test("every reader of one dead variable is reported, not just the first", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/a.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`],
        ["packages/sdk/src/b.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`],
      ]),
      none,
    )
    expect(findings.map((finding) => finding.file)).toEqual([
      "packages/sdk/src/a.ts",
      "packages/sdk/src/b.ts",
    ])
  })

  test("a name picked by a ternary is a read, on either branch", () => {
    // The `:` of a ternary is not a record key's colon.
    const findings = findReadersWithoutWriters(
      new Map([
        [
          "packages/sdk/src/reader.ts",
          [
            `const name = flag ? "GENT_T1" : "GENT_T2"`,
            `const other = flag`,
            `  ? "GENT_T3"`,
            `  : "GENT_T4"`,
          ].join("\n"),
        ],
      ]),
      none,
    )
    expect(findings.map((finding) => [finding.line, finding.message.split("`")[1]])).toEqual([
      [1, "GENT_T1"],
      [1, "GENT_T2"],
      [3, "GENT_T3"],
      [4, "GENT_T4"],
    ])
  })

  test("a record key is not a read, quoted or bare, inline or on its own line", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        [
          "packages/sdk/src/spawn.ts",
          [
            `const env = { "GENT_K1": "1", 'GENT_K2': "2" }`,
            `const e2 = {`,
            `  "GENT_K3": v,`,
            `}`,
          ].join("\n"),
        ],
      ]),
      none,
    )
    expect(findings).toEqual([])
  })

  test("an env record bound to a name ending in Env sets its keys", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.string("GENT_CHILD_MODE")\n`],
        [
          "packages/sdk/src/spawn.ts",
          `const childEnv = { GENT_CHILD_MODE: "1" }\nBun.spawn(["gent"], { env: childEnv })\n`,
        ],
      ]),
      none,
    )
    expect(findings).toEqual([])
  })

  test("an operator entry nothing reads, or that production sets, is reported", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.string("GENT_SET_HERE")\n`],
        ["packages/sdk/src/spawn.ts", `const env = { GENT_SET_HERE: "1" }\n`],
      ]),
      new Map([
        ["GENT_UNREAD", "nobody"],
        ["GENT_SET_HERE", "nobody"],
      ]),
    )
    expect(messages(findings)).toEqual([
      expect.stringContaining("`GENT_UNREAD` is allowed as operator-set, but nothing reads it"),
      expect.stringContaining("`GENT_SET_HERE` is allowed as operator-set, but the tree sets it"),
    ])
  })
})

describe("the guard entry routes each tracked file to its finders", () => {
  const gentNames = (files: ReadonlyArray<{ readonly file: string; readonly text: string }>) =>
    scanTrackedTexts(files, [])
      .findings.map((finding) => finding.message)
      .filter((message) => message.includes("GENT_PROBE_SCRIPT"))

  test("a package script sets the variable its prefix names", () => {
    // The runner once read package.json and dropped it before the variable
    // scan, so a script writer counted only when a test fed it to the finder.
    expect(
      gentNames([
        { file: "packages/sdk/src/reader.ts", text: `Config.string("GENT_PROBE_SCRIPT")\n` },
        {
          file: "apps/tui/package.json",
          text: `{ "scripts": { "dev": "GENT_PROBE_SCRIPT=1 bun run x" } }\n`,
        },
      ]),
    ).toEqual([])
  })

  test("a manifest field other than scripts sets nothing, even when it shows the prefix", () => {
    expect(
      gentNames([
        { file: "packages/sdk/src/reader.ts", text: `Config.string("GENT_PROBE_SCRIPT")\n` },
        {
          file: "apps/tui/package.json",
          text: `{ "description": "run with GENT_PROBE_SCRIPT=1 to probe", "scripts": { "dev": "bun run x" } }\n`,
        },
      ]),
    ).toEqual([expect.stringContaining("is read but nothing in the tree sets it")])
  })

  test("with no script to set it, the entry still reports the reader", () => {
    expect(
      gentNames([
        { file: "packages/sdk/src/reader.ts", text: `Config.string("GENT_PROBE_SCRIPT")\n` },
        { file: "apps/tui/package.json", text: `{ "scripts": { "dev": "bun run x" } }\n` },
      ]),
    ).toEqual([expect.stringContaining("is read but nothing in the tree sets it")])
  })
})

// ── platform duplication ────────────────────────────────────────────────────

describe("platform duplication guards", () => {
  test("ignores docs and tests", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/tests/runtime/example.test.ts",
        "Layer.provide(BunPlatformLive)",
      ),
    ).toEqual([])
  })

  test("flags Bun platform layers in shipped extensions", () => {
    // No shipped extension is exempt, the Anthropic driver included.
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/anthropic.ts",
        'import { BunGentPlatformLive } from "@gent/core/host"',
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/anthropic.ts",
        line: 1,
        message: expect.stringContaining(
          "`BunGentPlatformLive` provides a Bun platform layer outside the platform roots",
        ),
      },
    ])
  })

  test("does not flag the guard source itself", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/tooling/src/guards.ts",
        "Layer.provide(BunPlatformLive)",
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
        message: expect.stringContaining(
          "`BunPlatformLive` provides a Bun platform layer outside the platform roots",
        ),
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        "const PlatformLayer = Layer.mergeAll(BunGentPlatformLive)",
      ),
    ).toEqual([])
  })

  const provisionLines = (file: string, text: string) =>
    findPlatformDuplicationViolations(file, text).map((finding) => [finding.line, finding.message])

  test("every @effect/platform-bun layer outside a root is reported, however it is imported", () => {
    const text = [
      'import { BunCrypto, BunHttpServer as Http } from "@effect/platform-bun"',
      'import * as PlatformBun from "@effect/platform-bun"',
      'import * as BunPathModule from "@effect/platform-bun/BunPath"',
      "import {",
      "  layer as cryptoLayer,",
      "  make as makeCrypto,",
      '} from "@effect/platform-bun/BunCrypto"',
      "const a = Layer.provide(BunCrypto.layer)",
      "const b = Http.layerServer({ port: 1 })",
      "const c = PlatformBun.BunServices.layer",
      "const d = BunPathModule.layer",
      "const e = Layer.merge(base, cryptoLayer)",
      "const f = Http.layer({ port: 2 })",
    ].join("\n")
    expect(provisionLines("packages/core/src/storage/storage.ts", text)).toEqual([
      [8, expect.stringContaining("`BunCrypto.layer`")],
      [9, expect.stringContaining("`Http.layerServer`")],
      [10, expect.stringContaining("`PlatformBun.BunServices.layer`")],
      [11, expect.stringContaining("`BunPathModule.layer`")],
      [12, expect.stringContaining("`cryptoLayer`")],
      [13, expect.stringContaining("`Http.layer`")],
    ])
  })

  test("a constructor, a runner or a comment is no layer provision", () => {
    const text = [
      'import { BunRuntime, BunSocket } from "@effect/platform-bun"',
      "const socket = yield* BunSocket.makeNet({ path })",
      "BunRuntime.runMain(program)",
      "// BunCrypto.layer is what the host provides",
      "/**",
      " * `BunServices.layer` bundles the file system",
      " */",
      "const next = 1 /* BunCrypto.layer */ + 2",
    ].join("\n")
    expect(provisionLines("apps/tui/src/extensions/builtins.tsx", text)).toEqual([])
  })

  test("a local name that only looks like a Bun module is no provision", () => {
    const text = [
      "const BunWidget = { layer: Layer.empty }",
      "const provided = Layer.provide(BunWidget.layer)",
    ].join("\n")
    expect(provisionLines("packages/core/src/runtime/widget.ts", text)).toEqual([])
  })

  test("a layer reached through a dynamic import is reported", () => {
    const text = [
      'const BunCrypto = await import("@effect/platform-bun/BunCrypto")',
      'const { layer: cryptoLayer } = await import("@effect/platform-bun/BunCrypto")',
      'const PlatformBun = await import("@effect/platform-bun")',
      "Layer.provide(BunCrypto.layer)",
      "Layer.provide(cryptoLayer)",
      "Layer.provide(PlatformBun.BunServices.layer)",
      'Layer.provide((await import("@effect/platform-bun/BunPath")).layer)',
    ].join("\n")
    expect(provisionLines("packages/core/src/runtime/dynamic.ts", text)).toEqual([
      [4, expect.stringContaining("`BunCrypto.layer`")],
      [5, expect.stringContaining("`cryptoLayer`")],
      [6, expect.stringContaining("`PlatformBun.BunServices.layer`")],
      [7, expect.stringContaining('`(await import("@effect/platform-bun/BunPath")).layer`')],
    ])
  })

  test("a destructured or optional layer access is reported", () => {
    const text = [
      'import { BunCrypto, BunPath } from "@effect/platform-bun"',
      'import * as PlatformBun from "@effect/platform-bun"',
      "const { layer } = BunCrypto",
      "const { layer: pathLayer, make } = BunPath",
      "const { BunServices } = PlatformBun",
      "const a = BunCrypto?.layer",
      "const b = PlatformBun?.BunFileSystem?.layer",
      "const c = BunServices.layer",
      "const { make: makePath } = BunPath",
    ].join("\n")
    expect(provisionLines("packages/extensions/src/probe.ts", text)).toEqual([
      [3, expect.stringContaining("`{ layer } = BunCrypto`")],
      [4, expect.stringContaining("`{ layer: pathLayer, make } = BunPath`")],
      [6, expect.stringContaining("`BunCrypto?.layer`")],
      [7, expect.stringContaining("`PlatformBun?.BunFileSystem?.layer`")],
      [8, expect.stringContaining("`BunServices.layer`")],
    ])
  })

  test("a layer access split across lines is reported at its first line", () => {
    const text = [
      'import { BunServices } from "@effect/platform-bun"',
      "const platform = BunServices.",
      "  layer",
      "const other = BunServices",
      "  .layerTest",
    ].join("\n")
    expect(provisionLines("packages/core/src/runtime/split.ts", text)).toEqual([
      [2, expect.stringContaining("`BunServices.layer`")],
      [4, expect.stringContaining("`BunServices.layerTest`")],
    ])
  })

  test("a module that re-exports @effect/platform-bun is reported at the re-export", () => {
    const text = [
      'export { BunCrypto } from "@effect/platform-bun"',
      'export * from "@effect/platform-bun/BunPath"',
      'export * as PlatformBun from "@effect/platform-bun"',
      'export { layer as cryptoLayer } from "@effect/platform-bun/BunCrypto"',
      'import { BunServices } from "@effect/platform-bun"',
      "export { BunServices }",
      "export const Services = BunServices",
    ].join("\n")
    expect(provisionLines("packages/core/src/runtime/reexport.ts", text)).toEqual(
      [1, 2, 3, 4, 6, 7].map((line) => [line, expect.stringContaining("re-exports")]),
    )
  })

  test("a root provides any layer; a justified entry allows only its own layer", () => {
    expect(provisionLines("apps/tui/scripts/build.ts", "Layer.provide(BunServices.layer)")).toEqual(
      [],
    )
    expect(
      provisionLines(
        "packages/extensions/src/openai.ts",
        [
          'import { BunCrypto, BunHttpServer } from "@effect/platform-bun"',
          "Layer.provide(BunHttpServer.layerServer({ port: OAUTH_PORT }))",
          "Effect.provide(BunCrypto.layer)",
        ].join("\n"),
      ),
    ).toEqual([[3, expect.stringContaining("`BunCrypto.layer`")]])
  })
})

// ── retired surfaces ────────────────────────────────────────────────────────

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
  ["packages/extensions/src/x.ts", "yield* ctx.Files.read(path)", "ctx.Files"],
  ["packages/extensions/src/x.ts", "yield* ctx.Process.run('git', [])", "ctx.Process"],
  ["packages/core/src/domain/x.ts", "type F = ExtensionFilesService", "ExtensionFilesService"],
  ["packages/core/src/domain/x.ts", "type P = ExtensionProcessService", "ExtensionProcessService"],
  ["packages/core/src/domain/x.ts", "const w = makeFileWriter(fs)", "makeFileWriter"],
  ["packages/core/tests/x.test.ts", "const f = testExtensionFiles()", "testExtensionFiles"],
  ["packages/core/tests/x.test.ts", "const p = testExtensionProcess()", "testExtensionProcess"],
  ["packages/core/tests/x.test.ts", "Layer.provide(BunCronRuntimeLive)", "BunCronRuntimeLive"],
  ["packages/core/src/server/rpc.ts", "export class SessionInfo {}", "SessionInfo"],
  ["packages/core/src/domain/x.ts", "type B = BranchInfo", "BranchInfo"],
  ["packages/core/tests/x.test.ts", "yield* ExtensionStatePublisher", "ExtensionStatePublisher"],
  ["packages/core/src/runtime/x.ts", "const events = yield* EventPublisher", "EventPublisher"],
  ["packages/core/tests/x.test.ts", "Layer.provide(ConnectionTracker.Live)", "ConnectionTracker"],
  ["packages/sdk/src/x.ts", 'Rpc.make("runtime.status", {})', '"runtime.status"'],
  ["apps/tui/src/x.ts", "yield* transport.driverList", "driverList"],
  ["packages/core/tests/x.test.ts", "yield* scope.inbox.claimStart(item)", "inbox.claimStart"],
  ["packages/core/src/runtime/x.ts", "scope.inbox.releaseStart(item)", "inbox.releaseStart"],
  ["packages/sdk/src/x.ts", 'import { x } from "./server/server-root.js"', "server-root"],
  ["packages/core/tests/x.test.ts", "yield* buildServerRoot(deps)", "buildServerRoot"],
  ["AGENTS.md", "the `ExtensionStatePublisher` publishes state", "ExtensionStatePublisher"],
  ["docs/extensions.md", "yield* ProcessRunner", "ProcessRunner"],
  ["packages/core/AGENTS.md", "Runtime code yields `EventPublisher`", "EventPublisher"],
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
  "packages/core/src/server/server-root.ts",
  "packages/core/src/cell.ts",
  "packages/core/src/runtime/cell-execution.ts",
  "packages/core/src/runtime/cell/cell-worker.ts",
  "packages/core/src/cell/index.ts",
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

  test("a core path that only contains the letters of the cell feature is not reported", () => {
    for (const file of [
      "packages/core/src/runtime/cellular.ts",
      "packages/core/src/domain/excellent.ts",
      "packages/extensions/src/cell.ts",
      "packages/core/tests/runtime/cell.test.ts",
    ]) {
      expect(findRetiredSurfaces(file, "")).toEqual([])
    }
  })

  test("a test file is reported only for the shipped-and-tests rows", () => {
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

  test("a steering file or a doc is read for every name row", () => {
    const text = ["ProcessRunner", "ResourceGraphHost", "ExtensionRuntime"].join("\n")
    for (const file of [
      "AGENTS.md",
      "CLAUDE.md",
      "ARCHITECTURE.md",
      "apps/tui/AGENTS.md",
      "packages/core/AGENTS.md",
      "docs/extensions.md",
      "docs/guides/authoring.md",
    ]) {
      expect(findRetiredSurfaces(file, text).map((finding) => finding.line)).toEqual([1, 2, 3])
    }
  })

  test("a doc that shows a retired module's import is reported; a doc's own path is not", () => {
    expect(
      findRetiredSurfaces("docs/extensions.md", 'import { x } from "./resource-graph.js"').map(
        (finding) => finding.line,
      ),
    ).toEqual([1])
    expect(findRetiredSurfaces("docs/server-root.md", "")).toEqual([])
  })

  test("a retired module is read on every import shape, a multi-line one included", () => {
    const file = "packages/core/src/runtime/extension-host.ts"
    const multiLine = [
      "import {",
      "  ResourceGraph,",
      "  ResourceGraphLayer,",
      '} from "./resource-graph"',
    ]
    expect(findRetiredSurfaces(file, multiLine.join("\n")).map((finding) => finding.line)).toEqual([
      4,
    ])
    expect(
      findRetiredSurfaces(
        file,
        'const m = yield* Effect.promise(() => import("../live-profile.js"))',
      ),
    ).toHaveLength(1)
  })

  test("a retired module name that is not a specifier's last segment is not a hit", () => {
    const file = "packages/core/src/runtime/extension-host.ts"
    for (const line of [
      'import { x } from "./resource-graph-builder"',
      'import { x } from "./resource-graph/index.js"',
      "// the resource-graph module is gone",
    ]) {
      expect(findRetiredSurfaces(file, line)).toEqual([])
    }
  })

  test("dated research, plans, the tooling tests and the guard source are not scanned", () => {
    const text = ["ProcessRunner", "ResourceGraphHost", "ExtensionRuntime"].join("\n")
    expect(findRetiredSurfaces("docs/research/2026-09-08-pi-v2-extensions.md", text)).toEqual([])
    expect(findRetiredSurfaces("plans/arch-core.md", text)).toEqual([])
    expect(findRetiredSurfaces("README.md", text)).toEqual([])
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
    expect(
      findRetiredSurfaces(
        "packages/extensions/src/exec-tools.ts",
        [
          "const claim = yield* storage.claimStart({ id })",
          "listModels: driverListModels(catalog, id)",
          "const releaseStart = yield* Deferred.make<void>()",
          "const status = yield* runtime.status",
        ].join("\n"),
      ),
    ).toEqual([])
  })
})

// ── steering file paths ─────────────────────────────────────────────────────

const TRACKED = [
  "packages/core/src/runtime/provider.ts",
  "packages/core/src/domain/tool.ts",
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

  test("ignores a path outside the eight tree roots", () => {
    expect(messagesOfSteeringPath("see `scripts/gone.ts` and `gone.md`")).toEqual([])
  })

  test("reports a missing docs, patches or skill file", () => {
    const text = "see `docs/gone.md`, `patches/gone.patch` and `.claude/skills/x/safety.md`"
    expect(messagesOfSteeringPath(text)).toHaveLength(3)
  })

  test("reads a path only when it sits in backticks", () => {
    expect(
      messagesOfSteeringPath("packages/gone/src/missing.ts is named without backticks"),
    ).toEqual([])
  })

  test("checks the steering prose the retired rows read, and nothing else", () => {
    const text = "- `packages/gone/src/missing.ts`"
    for (const file of [
      "CLAUDE.md",
      "AGENTS.md",
      "ARCHITECTURE.md",
      "apps/tui/AGENTS.md",
      "packages/core/AGENTS.md",
      "docs/extensions.md",
      "testbeds/gamut/README.md",
      ".claude/skills/architecture-loop/prior-art.md",
      "patches/README.md",
      "packages/extensions/src/skills/bundled/principles/SKILL.md",
      "packages/extensions/src/skills/bundled/principles/references/fix-root-causes.md",
    ]) {
      expect(isSteeringFile(file)).toBe(true)
      expect(messagesOfSteeringPath(text, file)).toHaveLength(1)
    }
    for (const file of [
      "plans/some-plan.md",
      "docs/research/2026-09-06-x.md",
      "README.md",
      "testbeds/gamut/fixture/README.md",
      "packages/extensions/src/skills/bundled/principles/notes.txt",
    ]) {
      expect(isSteeringFile(file)).toBe(false)
      expect(messagesOfSteeringPath(text, file)).toEqual([])
    }
  })
})

describe("steering file links", () => {
  const skill = "packages/extensions/src/skills/bundled/principles/SKILL.md"
  const tracked = [
    skill,
    "packages/extensions/src/skills/bundled/principles/references/fix-root-causes.md",
    ".claude/skills/architecture-loop/safety.md",
    "docs/extensions.md",
  ]
  const linkLines = (file: string, text: string): ReadonlyArray<number> =>
    findSteeringFilePaths(file, text, tracked).map((finding) => finding.line)

  test("a link resolves against the file's own directory", () => {
    const text = [
      "- [Fix Root Causes](references/fix-root-causes.md)",
      "- [Gone](references/gone.md)",
      "- [Also fixed](./references/fix-root-causes.md#why)",
    ].join("\n")
    expect(linkLines(skill, text)).toEqual([2])
    expect(findSteeringFilePaths(skill, text, tracked)[0]?.message).toContain("references/gone.md")
  })

  test("a link climbs with .. and fails above the root", () => {
    const prompt = ".claude/skills/architecture-loop/prompts/apply.md"
    expect(linkLines(prompt, "read [safety](../safety.md) first")).toEqual([])
    expect(linkLines(prompt, "read [safety](../../gone/safety.md) first")).toEqual([1])
    expect(linkLines("AGENTS.md", "see [x](../outside.md)")).toEqual([1])
  })

  test("a link with a title is read by its target", () => {
    const text = [
      '- [Gone](references/gone.md "The gone one")',
      "- [Fix](references/fix-root-causes.md 'Fix root causes')",
    ].join("\n")
    expect(linkLines(skill, text)).toEqual([1])
  })

  test("a URL, an anchor, a root path, a backticked or a fenced link is not read", () => {
    const text = [
      "[site](https://example.com/gone.md) and [top](#top) and [abs](/gone.md)",
      'call `tools["gone"](input)` in the cell',
      "```md",
      "[gone](gone.md)",
      "```",
      "[guide](docs/extensions.md)",
    ].join("\n")
    expect(linkLines("ARCHITECTURE.md", text)).toEqual([])
  })
})

// ── every bundled skill file ships ──────────────────────────────────────────

describe("bundled skill files", () => {
  const directory = "packages/extensions/src/skills/bundled/"
  const moduleText = [
    'import fixRootCauses from "./skills/bundled/principles/references/fix-root-causes.md" with { type: "text" }',
    'import principlesSkill from "./skills/bundled/principles/SKILL.md" with { type: "text" }',
    "",
    "export const bundledSkillFiles = [",
    '  ["principles/SKILL.md", principlesSkill],',
    "  [",
    '    "principles/references/fix-root-causes.md",',
    "    fixRootCauses,",
    "  ],",
    "]",
  ].join("\n")
  const tracked = [
    `${directory}principles/SKILL.md`,
    `${directory}principles/references/fix-root-causes.md`,
    "packages/extensions/src/skills.ts",
  ]

  test("every file imported and listed under its own path ships", () => {
    expect(findUnshippedSkillFiles(moduleText, tracked)).toEqual([])
  })

  test("a Markdown file with no import is reported at the file", () => {
    const added = `${directory}principles/references/new-principle.md`
    expect(findUnshippedSkillFiles(moduleText, [...tracked, added])).toMatchObject([
      { file: added, line: 1 },
    ])
  })

  test("an import with no row, or a row under another path, is reported at the import", () => {
    const noRow = moduleText.replace('  ["principles/SKILL.md", principlesSkill],\n', "")
    expect(findUnshippedSkillFiles(noRow, tracked)).toMatchObject([
      { file: BUNDLED_SKILLS_MODULE, line: 2 },
    ])
    const moved = moduleText.replace(
      '"principles/references/fix-root-causes.md"',
      '"principles/fix-root-causes.md"',
    )
    const findings = findUnshippedSkillFiles(moved, tracked)
    expect(findings.map((finding) => finding.line)).toEqual([1])
    expect(findings[0]?.message).toContain("principles/fix-root-causes.md")
  })

  test("a file of another kind under the directory is not a skill file", () => {
    expect(findUnshippedSkillFiles(moduleText, [...tracked, `${directory}notes.txt`])).toEqual([])
  })

  test("a row or an import in a comment does not ship the file", () => {
    const rowOff = moduleText.replace(
      '  ["principles/SKILL.md", principlesSkill],',
      '  // ["principles/SKILL.md", principlesSkill],',
    )
    expect(findUnshippedSkillFiles(rowOff, tracked)).toMatchObject([
      { file: BUNDLED_SKILLS_MODULE, line: 2 },
    ])
    const blockOff = moduleText
      .replace("  [\n", "  /* [\n")
      .replace("    fixRootCauses,\n  ],", "    fixRootCauses,\n  ], */")
    expect(findUnshippedSkillFiles(blockOff, tracked)).toMatchObject([
      { file: BUNDLED_SKILLS_MODULE, line: 1 },
    ])
    const importOff = moduleText.replace("import fixRootCauses", "// import fixRootCauses")
    expect(findUnshippedSkillFiles(importOff, tracked)).toMatchObject([
      { file: `${directory}principles/references/fix-root-causes.md`, line: 1 },
    ])
  })
})

// ── the guide check's inputs are the steering files ─────────────────────────

describe("guide check inputs", () => {
  const exact = [
    "extensions/**/*.ts",
    "../AGENTS.md",
    "../CLAUDE.md",
    "../ARCHITECTURE.md",
    "../apps/*/AGENTS.md",
    "../apps/*/CLAUDE.md",
    "../packages/*/AGENTS.md",
    "../packages/*/CLAUDE.md",
    "../docs/**/*.md",
    "!../docs/research/**",
    "../testbeds/*/README.md",
    "../patches/README.md",
    "../.claude/skills/**/*.md",
    "../packages/extensions/src/skills/bundled/**/*.md",
  ]
  const tracked = [
    "AGENTS.md",
    "README.md",
    "docs/extensions.md",
    "docs/research/2026-09-06-x.md",
    "apps/tui/AGENTS.md",
    "packages/extensions/src/skills/bundled/principles/SKILL.md",
    "examples/extensions/a.ts",
  ]
  const files = (inputs: ReadonlyArray<string>, extra: ReadonlyArray<string> = []) =>
    findUnhashedSteeringFiles("examples/turbo.json", inputs, [...tracked, ...extra]).map(
      (finding) => finding.message,
    )

  test("inputs that read exactly the steering files pass", () => {
    expect(files(exact, ["docs/topic/guide.md"])).toEqual([])
  })

  test("a nested steering file the inputs miss is reported", () => {
    const shallow = exact.map((input) => input.replace("../docs/**/*.md", "../docs/*.md"))
    const messages = files(shallow, ["docs/topic/guide.md"])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("docs/topic/guide.md")
  })

  test("an input that reads a Markdown file outside the steering set is reported", () => {
    const messages = files([...exact.filter((input) => !input.startsWith("!")), "../*.md"])
    expect(messages.some((message) => message.includes("docs/research/2026-09-06-x.md"))).toBe(true)
    expect(messages.some((message) => message.includes("README.md"))).toBe(true)
  })
})

// ── the steering prose's code compiles ──────────────────────────────────────

describe("steering prose code blocks", () => {
  const guide = [
    "# Guide",
    "```ts",
    "const a = 1",
    "const b = 2",
    "```",
    "```json",
    '{ "x": 1 }',
    "```",
    "```typescript",
    "const c = 3",
    "```",
  ].join("\n")

  test("each ts and typescript block is read with the file line of its first code line", () => {
    expect(guideCodeBlocks("docs/extensions.md", guide)).toEqual([
      { file: "docs/extensions.md", line: 3, code: "const a = 1\nconst b = 2", extension: "ts" },
      { file: "docs/extensions.md", line: 10, code: "const c = 3", extension: "ts" },
    ])
  })

  test("a tsx block is written as a tsx module and compiles in the context of its file", () => {
    const blocks = guideCodeBlocks("apps/tui/AGENTS.md", ["```tsx", "<box />", "```"].join("\n"))
    expect(blocks).toEqual([
      { file: "apps/tui/AGENTS.md", line: 2, code: "<box />", extension: "tsx" },
    ])
    expect(blocks.map((block, index) => guideBlockFile(index, block))).toEqual(["b1.tsx"])
    expect(guideCodeContextOf("apps/tui/AGENTS.md").tsconfig).toBe("apps/tui/tsconfig.json")
    expect(guideCodeContextOf("AGENTS.md").modules).toBe("examples/node_modules")
  })

  test("a ts fence quoted inside a fence of another language is not a block", () => {
    expect(guideCodeBlocks("docs/x.md", ["```text", "```ts", "```"].join("\n"))).toEqual([])
  })

  test("a block marked illustrative with a reason is skipped; a mark without one is not", () => {
    const marked = ["<!-- illustrative: elides the layer -->", "```ts", "x ...", "```"]
    const bare = ["<!-- illustrative: -->", "```ts", "const y = 1", "```"]
    expect(guideCodeBlocks("docs/x.md", marked.join("\n"))).toEqual([])
    expect(guideCodeBlocks("docs/x.md", bare.join("\n")).map((block) => block.code)).toEqual([
      "const y = 1",
    ])
  })

  test("a diagnostic is reported at its line in the file that holds the block", () => {
    const blocks = [
      ...guideCodeBlocks("docs/extensions.md", guide),
      ...guideCodeBlocks("apps/tui/AGENTS.md", ["", "```tsx", "<box />", "```"].join("\n")),
    ]
    expect(guideDiagnosticLine("b1.ts(2,7): error TS1: x", blocks)).toBe(
      "docs/extensions.md:4:7: error TS1: x",
    )
    expect(
      guideDiagnosticLine("/tmp/gent-guide-code-x/extension/b2.ts(1,1): suggestion TS2: y", blocks),
    ).toBe("docs/extensions.md:10:1: suggestion TS2: y")
    expect(guideDiagnosticLine("tui/b3.tsx(1,2): error TS3: z", blocks)).toBe(
      "apps/tui/AGENTS.md:3:2: error TS3: z",
    )
    expect(guideDiagnosticLine("error TS2688: no bun types", blocks)).toBe(
      "error TS2688: no bun types",
    )
  })
})

// ── tui session identity ────────────────────────────────────────────────────

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

  test("an emitter's `.on(` is not a reactive scope", () => {
    const text = ['  emitter.on("change", () => {', "    render(client.session())", "  })"].join(
      "\n",
    )
    expect(linesOfTuiIdentity(text)).toEqual([])
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

// ── suppression inventory ───────────────────────────────────────────────────

const nextLine = ["// @effect", "diagnostics-next-line"].join("-")
const membraneFile = "packages/core/src/runtime/extension-host.ts"
const membraneComment = `${nextLine} anyUnknownInErrorContext:off`
type Entries = NonNullable<Parameters<typeof findUnusedSuppressionApprovals>[1]>

describe("suppression inventory guard", () => {
  test("flags effect diagnostics outside reviewed files", () => {
    expect(
      findSuppressionInventoryFindings("sample.ts", `${nextLine} strictEffectProvide:off`),
    ).toMatchObject([{ file: "sample.ts", line: 1 }])
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
    ).toMatchObject([{ file: membraneFile, line: 1 }])
  })

  test("an entry listed twice is reported once, at the duplicate", () => {
    const text = "strictEffectProvide:off"
    const findings = findUnusedSuppressionApprovals(
      new Map([[membraneFile, `${nextLine} ${text}\n`]]),
      [
        { file: membraneFile, scope: "next-line", text },
        { file: membraneFile, scope: "next-line", text },
      ],
    )
    expect(messages(findings)).toEqual([expect.stringContaining("is listed twice")])
  })

  test("approved entry with no matching comment in its file is unused", () => {
    const findings = findUnusedSuppressionApprovals(new Map([[membraneFile, "export {}\n"]]))
    expect(messages(findings)).toContainEqual(expect.stringContaining(membraneComment))
  })

  test("approved entry whose file is not scanned is unused", () => {
    const findings = findUnusedSuppressionApprovals(new Map())
    expect(messages(findings)).toContainEqual(expect.stringContaining(membraneComment))
  })

  test("approved entry with a matching comment is not reported", () => {
    const findings = findUnusedSuppressionApprovals(
      new Map([[membraneFile, `const x = 1\n  ${nextLine} probeRule:off\nconst y = 2\n`]]),
      [{ file: membraneFile, scope: "next-line", text: "probeRule:off" }],
    )
    expect(findings).toEqual([])
  })

  describe("an entry counts its identical comments", () => {
    const comment = `${nextLine} probeRule:off`
    const counted: Entries = [
      { file: membraneFile, scope: "next-line", text: "probeRule:off", count: 2 },
    ]
    const holding = (sites: number) => Array.from({ length: sites }, () => comment).join("\n")

    test("the approved count of sites passes both directions", () => {
      expect(findSuppressionInventoryFindings(membraneFile, holding(2), counted)).toEqual([])
      expect(
        findUnusedSuppressionApprovals(new Map([[membraneFile, holding(2)]]), counted),
      ).toEqual([])
    })

    test("count + 1: the new site is reported at its line", () => {
      expect(findSuppressionInventoryFindings(membraneFile, holding(3), counted)).toMatchObject([
        { file: membraneFile, line: 3, message: expect.stringContaining("new site") },
      ])
    })

    test("count - 1: the entry is reported, with the count to set", () => {
      expect(
        messages(findUnusedSuppressionApprovals(new Map([[membraneFile, holding(1)]]), counted)),
      ).toEqual([expect.stringContaining("set the count to 1")])
    })

    test("absent count means one site", () => {
      const single: Entries = [{ file: membraneFile, scope: "next-line", text: "probeRule:off" }]
      expect(findSuppressionInventoryFindings(membraneFile, holding(2), single)).toHaveLength(1)
    })
  })
})

// ── export consumers ────────────────────────────────────────────────────────

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

  test("no name is exempt by itself: a dead export is reported whatever it is called", () => {
    // A name-keyed exemption table once let `transition` and five other names
    // die silently on every surface, long after the exports it meant were gone.
    const names = [
      "formatBranchLabel",
      "transition",
      "AuthOauth",
      "resolveTurnContext",
      "resolveTurnSource",
      "StepOutcome",
    ]
    const findings = findingsFor([
      {
        file: "packages/core/src/runtime/probe.ts",
        text: names.map((name) => `export const ${name} = 1\n`).join(""),
      },
    ])
    expect(findings.map((finding) => finding.message.split("`")[1])).toEqual(names)
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
  // Nothing outside the app imports it, so a same-named identifier in another
  // package is its own binding, never a read of the TUI's export.
  test("a same-named identifier outside the app does not keep a TUI name alive", () => {
    const findings = findingsFor([
      { file: TUI_FILE, text: `export const waitFor = 1\n` },
      {
        file: "packages/core/tests/runtime/loop.test.ts",
        text: `import { waitFor } from "../../src/test-utils/harness"\nvoid waitFor\n`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
    expect(findings[0]?.message).toContain("`waitFor`")
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

describe("support module surface (test helpers, build scripts, testbed drivers)", () => {
  const HELPER = "packages/core/tests/server/session-mutations.ts"

  test("a helper export nothing names is reported", () => {
    const findings = findingsFor([
      { file: HELPER, text: `export const datePlusMillis = (millis: number) => millis\n` },
    ])
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("`datePlusMillis` is exported but no file outside"),
    ])
  })

  test("a helper export only its own file reads drops the export keyword", () => {
    const findings = findingsFor([
      {
        file: "apps/tui/tests/scrollback-hold-boundary.ts",
        text: `export interface SettleHold {}\nexport const makeSettleHold = (): SettleHold => ({})\n`,
      },
      {
        file: "apps/tui/tests/scrollback.test.ts",
        text: `import { makeSettleHold } from "./scrollback-hold-boundary"\nvoid makeSettleHold\n`,
      },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
  })

  test("a test file keeps a helper export alive", () => {
    expect(
      findingsFor([
        { file: HELPER, text: `export const FIXED_NOW = 1\n` },
        {
          file: "packages/core/tests/server/session.test.ts",
          text: `import { FIXED_NOW } from "./session-mutations"\nvoid FIXED_NOW\n`,
        },
      ]),
    ).toEqual([])
  })

  test("the testbed driver, an integration helper and a build script are scanned", () => {
    const files = [
      "testbeds/gamut/gamut.ts",
      "apps/tui/integration/helpers.ts",
      "apps/tui/scripts/build.ts",
    ]
    expect(files.map((file) => declaredNames(file, `export const orphan = 1\n`))).toEqual(
      files.map(() => ["orphan"]),
    )
  })

  test("an example extension is scanned, and its own test keeps a name alive", () => {
    const example = "examples/extensions/notes.ts"
    const text = `export const Orphan = 1\nexport const Tested = 2\nexport default { id: "notes" }\n`
    expect(declaredNames(example, text)).toEqual(["Orphan", "Tested"])
    expect(
      findingsFor([
        { file: example, text },
        {
          file: "examples/tests/notes.test.ts",
          text: `import { Tested } from "../extensions/notes"\nvoid Tested\n`,
        },
      ]).map((finding) => finding.message),
    ).toEqual([expect.stringContaining("`Orphan`")])
  })

  test("a test file, the testbed fixture app and the lint fixtures declare nothing", () => {
    const files = [
      "apps/tui/tests/extensions/builtins.test.ts",
      "testbeds/gamut/fixture/src/ledger.ts",
      "packages/tooling/fixtures/apps/tui/tests/helper.ts",
    ]
    expect(files.map((file) => declaredNames(file, `export const orphan = 1\n`))).toEqual(
      files.map(() => []),
    )
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

  test("a name another file mentions only in a comment is still reported", () => {
    const findings = findingsFor([
      { file: SDK_FILE, text: `export const commentedOnly = 1\n` },
      {
        file: SDK_CONSUMER,
        text: `// commentedOnly used to live here\n/** see commentedOnly */\nexport const other = 1\n`,
      },
    ])
    expect(findings.map((finding) => finding.message)).toContainEqual(
      expect.stringContaining("`commentedOnly`"),
    )
  })

  test("a TUI extension-entry name read only inside the TUI source is reported", () => {
    const entry = "apps/tui/src/extensions.ts"
    const findings = findingsFor([
      {
        file: entry,
        text: `export { clientOnly } from "./extensions/host"\nexport { authored } from "./extensions/api"\n`,
      },
      {
        file: "apps/tui/src/app.tsx",
        text: `import { clientOnly } from "./extensions"\nuse(clientOnly)\n`,
      },
      {
        file: "packages/extensions/src/client.ts",
        text: `import { authored } from "@gent/tui/extensions"\nuse(authored)\n`,
      },
    ])
    expect(findings).toMatchObject([{ file: entry, line: 1 }])
    expect(findings[0]?.message).toContain("clientOnly")
  })

  test("a shipped client extension that imports the TUI entry by its specifier consumes the name", () => {
    const entry = "apps/tui/src/extensions.ts"
    const findings = findingsFor([
      {
        file: entry,
        text: `export { viaSpecifier } from "./extensions/client-facets"\nexport { viaRelative } from "./ui"\n`,
      },
      {
        file: "apps/tui/src/extensions/wake.client.tsx",
        text: `import { viaSpecifier } from "@gent/tui/extensions"\nuse(viaSpecifier)\n`,
      },
      {
        file: "apps/tui/src/extensions/agents.client.tsx",
        text: `import { viaRelative } from "../extensions"\nuse(viaRelative)\n`,
      },
    ])
    expect(findings).toMatchObject([{ file: entry, line: 2 }])
    expect(findings[0]?.message).toContain("viaRelative")
  })

  test("a comment inside a template interpolation does not keep a name alive", () => {
    const findings = findingsFor([
      { file: SDK_FILE, text: `export const vanished = 1\n` },
      {
        file: SDK_CONSUMER,
        text: "export const shown = `a ${/* vanished */ 1} b ${`c ${2 /* vanished */}`}`\n",
      },
    ])
    expect(findings.map((finding) => finding.message)).toContainEqual(
      expect.stringContaining("`vanished`"),
    )
  })

  test("a name read inside a template interpolation is live", () => {
    expect(
      findingsFor([
        { file: SDK_FILE, text: `export const interpolated = 1\n` },
        {
          file: "apps/tui/src/app.tsx",
          text: "const label = `n = ${ { value: interpolated }.value } // not a comment`\nuse(label)\n",
        },
      ]),
    ).toEqual([])
  })

  test("a name another file reads beside a URL in a string is live", () => {
    expect(
      findingsFor([
        { file: SDK_FILE, text: `export const fetchedName = 1\n` },
        {
          file: "apps/tui/src/app.tsx",
          text: `const url = "https://example.test"; use(fetchedName)\n`,
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
    expect(findings[0]?.message).toContain("`HandoffError`")
    expect(findings[0]?.message).toContain("delete it")
  })

  test("a const and type pair nothing else reads is reported on both lines", () => {
    const source = `export const SessionUpdate = Schema.Union([Schema.String])
export type SessionUpdate = typeof SessionUpdate.Type
`
    const findings = findingsFor([
      { file: "packages/extensions/src/example/schema.ts", text: source },
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

  test("a constant nothing names, not even its own file, is reported", () => {
    const findings = findingsFor([
      { file: TEST_UTILS_FILE, text: `export const DebugSlowLanguageModelDelayMs = 250\n` },
    ])
    expect(findings.map((finding) => finding.line)).toEqual([1])
    expect(findings[0]?.message).toContain("`DebugSlowLanguageModelDelayMs`")
  })

  const TEST_UTILS_ENTRY = "packages/core/src/test-utils/index.ts"
  const HARNESS_FILE = "packages/core/src/test-utils/harness.ts"

  test("an entry import under an alias is a read, with a namesake beside it", () => {
    const findings = findingsFor([
      { file: TEST_UTILS_ENTRY, text: `export { zeta } from "./harness"\n` },
      { file: HARNESS_FILE, text: `export const zeta = 1\n` },
      {
        file: "apps/tui/integration/session.test.tsx",
        text: `import {\n  zeta as _zeta,\n} from "@gent/core/test-utils"\nconst zeta = () => _zeta\nconsole.log(zeta)\n`,
      },
    ])
    expect(findings).toEqual([])
  })

  test("a member destructured off a namespace import is a read", () => {
    const findings = findingsFor([
      { file: TEST_UTILS_ENTRY, text: `export { beta, gamma } from "./harness"\n` },
      { file: HARNESS_FILE, text: `export const beta = 1\nexport const gamma = 2\n` },
      {
        file: "apps/tui/tests/session.test.ts",
        text: `import * as TU from "@gent/core/test-utils"\nconst { beta, gamma: g } = TU\nconsole.log(beta, g)\n`,
      },
    ])
    expect(findings).toEqual([])
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

/** Every workspace manifest in the shape the rows allow. */
const VALID_MANIFESTS: ReadonlyArray<readonly [string, PackageJson]> = [
  [
    "packages/core/package.json",
    {
      exports: {
        "./extensions/api": "./src/extensions/api.ts",
        "./extensions/branch-tools": "./src/extensions/branch-tools.ts",
        "./host": "./src/host.ts",
        "./protocol": "./src/protocol.ts",
        "./test-utils": "./src/test-utils/index.ts",
      },
    },
  ],
  [
    "packages/extensions/package.json",
    { private: true, exports: { ".": "./src/index.ts", "./client": "./src/client.ts" } },
  ],
  ["packages/sdk/package.json", { exports: { ".": "./src/index.ts" } }],
  ["apps/tui/package.json", { exports: { "./extensions": "./src/extensions.ts" } }],
  ["apps/server/package.json", {}],
  ["packages/e2e/package.json", { private: true }],
  ["packages/tooling/package.json", { private: true }],
  ["examples/package.json", { private: true }],
]

const PACKAGE_NAMES = new Map([
  ["packages/core/package.json", "@gent/core"],
  ["packages/extensions/package.json", "@gent/extensions"],
  ["packages/sdk/package.json", "@gent/sdk"],
  ["apps/tui/package.json", "@gent/tui"],
  ["apps/server/package.json", "@gent/server-http"],
  ["packages/e2e/package.json", "@gent/e2e"],
  ["packages/tooling/package.json", "@gent/tooling"],
  ["examples/package.json", "@gent/examples"],
])

/** The workspace with `changes` laid over the valid manifests, less the `removed` ones. */
const packageSurface = (
  changes: ReadonlyArray<readonly [string, PackageJson]>,
  options: {
    readonly paths?: Readonly<Record<string, ReadonlyArray<string>>>
    /** The tsconfig that sets `paths`; the root one by default. */
    readonly pathsIn?: string
    readonly removed?: ReadonlyArray<string>
  } = {},
) => {
  // A change keeps the package's name unless it sets one.
  const withName = ([file, manifest]: readonly [string, PackageJson]): [string, PackageJson] => [
    file,
    { name: PACKAGE_NAMES.get(file), ...manifest },
  ]
  const manifests = new Map<string, PackageJson>([
    ...VALID_MANIFESTS.map(withName),
    ...changes.map(withName),
  ])
  for (const file of options.removed ?? []) manifests.delete(file)
  const tsconfigs = new Map([
    ["tsconfig.json", {}],
    [options.pathsIn ?? "tsconfig.json", { compilerOptions: { paths: options.paths ?? {} } }],
  ])
  return findPackageSurfaceFindings(manifests, tsconfigs)
}

/** The file and the key a package surface finding names, as `<file> <key>`. */
const pathOf = (finding: { readonly file: string; readonly message: string }): string =>
  `${finding.file} ${finding.message.split(": ")[0]}`

describe("host entry point", () => {
  // A host name needs a product caller: test support (tests, e2e fixtures,
  // testbeds, lint fixtures) reads past it.
  const HOST_FILE = "packages/core/src/host.ts"
  const hostSource = `export { Auth, AuthApi } from "./runtime/provider.js"\n`
  const reading = `import { Auth, AuthApi } from "@gent/core/host"\n`

  test("a name only an e2e fixture, a testbed or a lint fixture reads is reported", () => {
    for (const file of [
      "packages/e2e/src/pty-fixture.ts",
      "testbeds/gamut/gamut.ts",
      "packages/tooling/fixtures/apps/server/src/launch.valid.ts",
      "apps/tui/tests/headless-cli-exit.test.ts",
    ]) {
      expect(
        messages(
          findingsFor([
            { file: HOST_FILE, text: hostSource },
            { file, text: reading },
          ]),
        ),
        file,
      ).toEqual([expect.stringContaining('"Auth"'), expect.stringContaining('"AuthApi"')])
    }
  })

  test("a name a product file reads is live", () => {
    expect(
      findingsFor([
        { file: HOST_FILE, text: hostSource },
        { file: "apps/server/src/main.ts", text: reading },
      ]),
    ).toEqual([])
  })
})

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
  const coreExports = VALID_MANIFESTS[0]![1].exports

  test("every workspace package in the shape its row allows is clean", () => {
    expect(packageSurface([])).toEqual([])
  })

  test("the TUI exposes only its client-extension entry", () => {
    expect(
      packageSurface([
        [
          "apps/tui/package.json",
          { exports: { "./extensions": "./src/extensions.ts", "./client": "./src/client.tsx" } },
        ],
      ]).map(pathOf),
    ).toEqual(['apps/tui/package.json exports["./client"]'])
  })

  test("flags a public internal core export", () => {
    expect(
      packageSurface([
        [
          "packages/core/package.json",
          { exports: { ...coreExports, "./domain/ids": "./src/domain/ids.ts" } },
        ],
      ]).map(pathOf),
    ).toEqual(['packages/core/package.json exports["./domain/ids"]'])
  })

  test("rejects a protocol wildcard", () => {
    expect(
      packageSurface([
        [
          "packages/core/package.json",
          { exports: { ...coreExports, "./protocol/*": "./src/*.ts" } },
        ],
      ]).map(pathOf),
    ).toEqual(['packages/core/package.json exports["./protocol/*"]'])
  })

  test("an entry point the row names but the manifest does not export is reported", () => {
    const { "./host": _host, ...withoutHost } = coreExports ?? {}
    expect(
      messages(packageSurface([["packages/core/package.json", { exports: withoutHost }]])),
    ).toEqual([expect.stringContaining('exports["./host"] is missing')])
  })

  test("flags extension implementation subpaths and a public extensions package", () => {
    expect(
      packageSurface([
        [
          "packages/extensions/package.json",
          {
            private: false,
            exports: { ".": "./src/index.ts", "./todo-storage": "./src/todo-storage.ts" },
          },
        ],
      ]),
    ).toEqual([
      {
        file: "packages/extensions/package.json",
        line: 1,
        message: "private: @gent/extensions must stay private; it is not a published contract",
      },
      {
        file: "packages/extensions/package.json",
        line: 1,
        message:
          'exports["./todo-storage"]: @gent/extensions may only expose its supported entry points: ., ./client',
      },
      {
        file: "packages/extensions/package.json",
        line: 1,
        message:
          'exports["./client"] is missing: the package-surface row for @gent/extensions names it; export it, or drop it from the row',
      },
    ])
  })

  test("flags internal sdk subpath exports", () => {
    expect(
      packageSurface([
        [
          "packages/sdk/package.json",
          { exports: { ".": "./src/index.ts", "./rpcs": "./src/rpcs.ts" } },
        ],
      ]),
    ).toEqual([
      {
        file: "packages/sdk/package.json",
        line: 1,
        message: 'exports["./rpcs"]: @gent/sdk may only expose its supported entry points: .',
      },
    ])
  })

  test("a leaf package that gains an exports map is reported", () => {
    for (const file of [
      "packages/e2e/package.json",
      "packages/tooling/package.json",
      "apps/server/package.json",
      "examples/package.json",
    ]) {
      expect(
        messages(packageSurface([[file, { private: true, exports: { ".": "./src/index.ts" } }]])),
        file,
      ).toEqual([expect.stringContaining("may only expose its supported entry points: none")])
    }
  })

  test("a workspace package with no row is reported", () => {
    expect(
      packageSurface([["packages/new/package.json", { exports: { ".": "./src/index.ts" } }]]),
    ).toEqual([
      {
        file: "packages/new/package.json",
        line: 1,
        message:
          "a workspace package with no package-surface row in guards.ts; add one naming its entry points (none for a leaf)",
      },
    ])
  })

  test("a row with no workspace package is reported", () => {
    expect(messages(packageSurface([], { removed: ["examples/package.json"] }))).toEqual([
      "package-surface row examples/package.json names no workspace package; drop the row",
    ])
  })

  test("a package whose name is not its row's alias is reported", () => {
    expect(
      messages(
        packageSurface([
          [
            "packages/sdk/package.json",
            { name: "@gent/client", exports: { ".": "./src/index.ts" } },
          ],
        ]),
      ),
    ).toEqual([
      "name: the package is @gent/client, its package-surface row names @gent/sdk; make them agree",
    ])
  })

  test("a package tsconfig's path alias is reported in that tsconfig", () => {
    expect(
      packageSurface([], {
        pathsIn: "packages/sdk/tsconfig.json",
        paths: { "@gent/core/protocol": ["../core/src/protocol.ts"] },
      }).map(pathOf),
    ).toEqual(['packages/sdk/tsconfig.json compilerOptions.paths["@gent/core/protocol"]'])
  })

  test("every tsconfig but a fixture's is read for path aliases", () => {
    expect(
      workspaceTsconfigs([
        "tsconfig.json",
        "packages/sdk/tsconfig.json",
        "packages/e2e/tsconfig.json",
        "packages/sdk/tsconfig.build.json",
        "testbeds/gamut/fixture/tsconfig.json",
        "packages/tooling/fixtures/apps/tsconfig.json",
      ]),
    ).toEqual(["tsconfig.json", "packages/sdk/tsconfig.json", "packages/e2e/tsconfig.json"])
  })

  test("any tsconfig path alias is reported: packages resolve through exports", () => {
    expect(
      packageSurface([], {
        paths: {
          "@gent/core/protocol": ["./packages/core/src/protocol.ts"],
          "@gent/core/domain/ids": ["./packages/core/src/domain/ids.ts"],
        },
      }).map(pathOf),
    ).toEqual([
      'tsconfig.json compilerOptions.paths["@gent/core/protocol"]',
      'tsconfig.json compilerOptions.paths["@gent/core/domain/ids"]',
    ])
  })
})

describe("workspace manifests", () => {
  test("each workspace pattern names the manifests one level under it, and no deeper", () => {
    expect(
      workspaceManifests(
        ["packages/*", "apps/*", "examples"],
        [
          "package.json",
          "packages/core/package.json",
          "packages/core/src/index.ts",
          "packages/tooling/fixtures/package.json",
          "apps/tui/package.json",
          "examples/package.json",
          "examples/extensions/package.json",
          "testbeds/gamut/fixture/package.json",
        ],
      ),
    ).toEqual(["packages/core/package.json", "apps/tui/package.json", "examples/package.json"])
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

// ── declared dependencies ──────────────────────────────────────────────────

const dependencyScope = (overrides: Partial<DependencyScope>): DependencyScope => ({
  manifest: "packages/core/package.json",
  manifestText: "{}",
  packageJson: {},
  files: new Map(),
  commands: [],
  installed: new Map(),
  ...overrides,
})

const emptyRoot = dependencyScope({ manifest: "package.json" })

/** Installed manifests as the runner reads them. */
const installedMap = (entries: ReadonlyArray<readonly [string, InstalledPackage]>) =>
  new Map(entries.map(([name, installed]) => [name, installedDependency(name, installed)]))

const findingNames = (
  findings: ReadonlyArray<{ readonly file: string; readonly message: string }>,
) => findings.map((finding) => `${finding.file} ${finding.message.split(": ")[0] ?? ""}`)

const unusedNames = (scope: DependencyScope): ReadonlyArray<string> =>
  findUnusedDependencies({ root: emptyRoot, workspaces: [scope] }).map(
    (finding) => finding.message.split(": ")[0] ?? "",
  )

describe("a declared dependency must have a use", () => {
  test("a dependency no file loads is reported at its manifest line", () => {
    const manifestText = [
      "{",
      '  "dependencies": {',
      '    "effect-encore": "catalog:",',
      '    "effect-machine": "catalog:"',
      "  }",
      "}",
    ].join("\n")
    const findings = findUnusedDependencies({
      root: emptyRoot,
      workspaces: [
        dependencyScope({
          manifestText,
          packageJson: {
            dependencies: { "effect-encore": "catalog:", "effect-machine": "catalog:" },
          },
          files: new Map([
            ["packages/core/src/a.ts", 'import { Entity } from "effect-encore/entity"'],
          ]),
        }),
      ],
    })
    expect(findings).toEqual([
      {
        file: "packages/core/package.json",
        line: 4,
        message:
          'dependencies["effect-machine"]: nothing in this package loads it, runs its command or names it in a config; drop it',
      },
    ])
  })

  test("a dynamic import, a require, a re-export and a types reference each count as a load", () => {
    const names = ["a", "@s/b", "c", "d", "e"]
    const scope = dependencyScope({
      packageJson: { devDependencies: Object.fromEntries(names.map((name) => [name, "1"])) },
      files: new Map([
        [
          "packages/core/src/x.ts",
          [
            'const a = await import("a")',
            'const b = require("@s/b/sub")',
            'export { c } from "c"',
            '/// <reference types="d" />',
            'import "e"',
          ].join("\n"),
        ],
      ]),
    })
    expect(unusedNames(scope)).toEqual([])
  })

  test("a commented-out import is not a use", () => {
    const scope = dependencyScope({
      packageJson: { dependencies: { ghost: "1", "ghost-block": "1", live: "1" } },
      files: new Map([
        [
          "packages/core/src/x.ts",
          [
            '// import { Machine } from "ghost"',
            '/* const b = require("ghost-block") */',
            'const url = "https://example.com/a" // a string keeps its slashes',
            'import { y } from "live"',
          ].join("\n"),
        ],
      ]),
    })
    expect(unusedNames(scope)).toEqual(['dependencies["ghost"]', 'dependencies["ghost-block"]'])
  })

  test("a commented-out config entry is not a use", () => {
    const scope = dependencyScope({
      packageJson: { devDependencies: { "json-ghost": "1", "yaml-ghost": "1", kept: "1" } },
      files: new Map([
        ["packages/core/.oxlintrc.json", '{\n  // "jsPlugins": ["json-ghost"]\n  "x": "kept"\n}'],
        ["packages/core/ci.yml", '# run: "yaml-ghost"\nname: "a # b"'],
      ]),
      commands: ["# yaml-ghost is not run here"],
      installed: installedMap([["yaml-ghost", { bin: { "yaml-ghost": "./bin.js" } }]]),
    })
    expect(unusedNames(scope)).toEqual([
      'devDependencies["json-ghost"]',
      'devDependencies["yaml-ghost"]',
    ])
  })

  test("a config string and a script word count as a use; the manifest's own keys do not", () => {
    const scope = dependencyScope({
      packageJson: {
        devDependencies: { "lint-plugin": "1", "@opentui/solid": "1", ghost: "1" },
      },
      files: new Map([
        ["packages/core/.oxlintrc.json", '{ "jsPlugins": ["lint-plugin/plugin"] }'],
        ["packages/core/package.json", '{ "devDependencies": { "ghost": "1" } }'],
      ]),
      commands: ["bun test --preload @opentui/solid/preload tests"],
    })
    expect(unusedNames(scope)).toEqual(['devDependencies["ghost"]'])
  })

  test("a command a dependency installs counts as a use of it", () => {
    const scope = dependencyScope({
      packageJson: { devDependencies: { typescript: "7", "@effect/tsgo": "1", idle: "1" } },
      commands: ["tsc --noEmit", "lefthook install && effect-tsgo patch"],
      installed: installedMap([
        ["typescript", { bin: { tsc: "./bin/tsc" } }],
        ["@effect/tsgo", { bin: { "effect-tsgo": "./dist/effect-tsgo.cjs" } }],
        ["idle", { bin: "./bin/idle.js" }],
      ]),
    })
    expect(unusedNames(scope)).toEqual(['devDependencies["idle"]'])
  })

  test("a string bin is named after the package", () => {
    const scope = dependencyScope({
      packageJson: { devDependencies: { "@scope/runner": "1" } },
      commands: ["runner --fast"],
      installed: installedMap([["@scope/runner", { bin: "./bin/runner.js" }]]),
    })
    expect(unusedNames(scope)).toEqual([])
  })

  test("@types/x is used when x is loaded, including bun through a bun: import", () => {
    const scope = dependencyScope({
      packageJson: {
        devDependencies: { "@types/bun": "1", "@types/picomatch": "1", "@types/figlet": "1" },
      },
      files: new Map([
        [
          "packages/core/tests/a.test.ts",
          'import { test } from "bun:test"\nimport pm from "picomatch"',
        ],
      ]),
    })
    expect(unusedNames(scope)).toEqual(['devDependencies["@types/figlet"]'])
  })

  test("a peer of a used dependency is used through it, down the chain", () => {
    const scope = dependencyScope({
      packageJson: {
        dependencies: {
          "@effect/opentelemetry": "1",
          "@opentelemetry/api": "1",
          deep: "1",
          loose: "1",
        },
      },
      files: new Map([["packages/sdk/src/a.ts", 'import * as Otel from "@effect/opentelemetry"']]),
      installed: installedMap([
        ["@effect/opentelemetry", { peerDependencies: { "@opentelemetry/api": "^1" } }],
        ["@opentelemetry/api", { peerDependencies: { deep: "^1" } }],
      ]),
    })
    expect(unusedNames(scope)).toEqual(['dependencies["loose"]'])
  })

  test("a peer no file names is reported like any dependency", () => {
    const scope = dependencyScope({
      packageJson: { peerDependencies: { effect: "catalog:", "@effect/sql-pg": "catalog:" } },
      files: new Map([["packages/core/src/a.ts", 'import { Effect } from "effect"']]),
    })
    expect(unusedNames(scope)).toEqual(['peerDependencies["@effect/sql-pg"]'])
  })

  test("a peer is used through the peers of a workspace dependency", () => {
    const scope = dependencyScope({
      manifest: "packages/e2e/package.json",
      packageJson: {
        dependencies: { "@gent/core": "workspace:*" },
        peerDependencies: { "@effect/platform-bun": "catalog:" },
      },
      files: new Map([["packages/e2e/tests/a.test.ts", 'import { x } from "@gent/core/host"']]),
      installed: installedMap([
        ["@gent/core", { peerDependencies: { "@effect/platform-bun": "catalog:" } }],
      ]),
    })
    expect(unusedNames(scope)).toEqual([])
  })

  test("the root installs only the peers its workspaces use", () => {
    const root = dependencyScope({
      manifest: "package.json",
      packageJson: {
        devDependencies: { effect: "catalog:", "@effect/sql-pg": "catalog:", orphan: "1" },
      },
    })
    const core = dependencyScope({
      packageJson: { peerDependencies: { effect: "catalog:", "@effect/sql-pg": "catalog:" } },
      files: new Map([["packages/core/src/a.ts", 'import { Effect } from "effect"']]),
    })
    expect(findingNames(findUnusedDependencies({ root, workspaces: [core] }))).toEqual([
      'package.json devDependencies["@effect/sql-pg"]',
      'package.json devDependencies["orphan"]',
      'packages/core/package.json peerDependencies["@effect/sql-pg"]',
    ])
  })

  test("the root installs a peer a workspace's used dependency asks for, undeclared there", () => {
    const root = dependencyScope({
      manifest: "package.json",
      packageJson: { devDependencies: { react: "19", "react-dom": "19" } },
    })
    const web = dependencyScope({
      manifest: "apps/web/package.json",
      packageJson: { dependencies: { "react-dom": "19" } },
      files: new Map([["apps/web/src/main.tsx", 'import { createRoot } from "react-dom/client"']]),
      installed: installedMap([["react-dom", { peerDependencies: { react: "^19" } }]]),
    })
    // The root copy of react-dom is still dead: the workspace declares it itself.
    expect(findingNames(findUnusedDependencies({ root, workspaces: [web] }))).toEqual([
      'package.json devDependencies["react-dom"]',
    ])
  })
})

describe("a catalog entry must be taken", () => {
  test("an entry no manifest takes with catalog: is reported inside the catalog block", () => {
    const text = [
      "{",
      '  "devDependencies": { "effect": "catalog:" },',
      '  "catalog": {',
      '    "effect": "4",',
      '    "effect-machine": "0.27.0"',
      "  }",
      "}",
    ].join("\n")
    const findings = findUnusedCatalogEntries(
      {
        manifest: "package.json",
        text,
        packageJson: {
          devDependencies: { effect: "catalog:" },
          catalog: { effect: "4", "effect-machine": "0.27.0" },
        },
      },
      [{ peerDependencies: { effect: "catalog:" } }],
    )
    expect(findings).toEqual([
      {
        file: "package.json",
        line: 5,
        message: 'catalog["effect-machine"]: no manifest takes it with "catalog:"; drop it',
      },
    ])
  })
})

describe("the Effect packages share one version", () => {
  const rootText = [
    "{",
    '  "devDependencies": { "effect": "catalog:", "@effect/tsgo": "0.41.0" },',
    '  "overrides": {',
    '    "effect": "4.1.0",',
    '    "@effect/ai-openai": "4.0.0"',
    "  },",
    '  "catalog": {',
    '    "effect": "4.1.0",',
    '    "@effect/platform-bun": "4.1.0",',
    '    "picomatch": "^4"',
    "  },",
    '  "patchedDependencies": {',
    '    "@opentui/core@0.5.11": "patches/a.patch",',
    '    "@effect/ai-anthropic@4.0.0": "patches/b.patch"',
    "  }",
    "}",
  ].join("\n")
  const root = {
    manifest: "package.json",
    text: rootText,
    packageJson: {
      devDependencies: { effect: "catalog:", "@effect/tsgo": "0.41.0" },
      overrides: { effect: "4.1.0", "@effect/ai-openai": "4.0.0" },
      catalog: { effect: "4.1.0", "@effect/platform-bun": "4.1.0", picomatch: "^4" },
      patchedDependencies: {
        "@opentui/core@0.5.11": "patches/a.patch",
        "@effect/ai-anthropic@4.0.0": "patches/b.patch",
      },
    },
  }

  test("an override and a patch behind catalog.effect are reported at their lines", () => {
    const findings = findEffectVersionDrift(root, [])
    expect(findings.map((finding) => [finding.line, finding.message])).toEqual([
      [5, expect.stringContaining('overrides["@effect/ai-openai"] pins 4.0.0')],
      [14, expect.stringContaining('patchedDependencies["@effect/ai-anthropic"] pins 4.0.0')],
    ])
  })

  test("a workspace that names an Effect package with a literal version is reported", () => {
    const sdkText = [
      "{",
      '  "dependencies": {',
      '    "@effect/opentelemetry": "4.1.0"',
      "  }",
      "}",
    ].join("\n")
    const agreeing = {
      ...root,
      packageJson: {
        ...root.packageJson,
        overrides: { effect: "4.1.0" },
        patchedDependencies: { "@effect/ai-anthropic@4.1.0": "patches/b.patch" },
      },
    }
    const findings = findEffectVersionDrift(agreeing, [
      {
        manifest: "packages/sdk/package.json",
        text: sdkText,
        packageJson: { dependencies: { "@effect/opentelemetry": "4.1.0" } },
      },
    ])
    expect(findings).toEqual([
      {
        file: "packages/sdk/package.json",
        line: 3,
        message: expect.stringContaining(
          'dependencies["@effect/opentelemetry"] is the literal "4.1.0"',
        ),
      },
    ])
  })

  test("catalog.effect must be one exact version, not a range, a tag or a catalog reference", () => {
    const withEffect = (effect: string) => {
      const text = ["{", '  "catalog": {', `    "effect": "${effect}"`, "  }", "}"].join("\n")
      return findEffectVersionDrift(
        { manifest: "package.json", text, packageJson: { catalog: { effect } } },
        [],
      ).map((finding) => [finding.line, finding.message])
    }
    for (const spec of ["^4.0.0", "~4.0.0", ">=4.0.0 <5", "latest", "catalog:", "4.x"]) {
      expect(withEffect(spec)).toEqual([
        [3, expect.stringContaining(`catalog["effect"] is "${spec}"`)],
      ])
    }
    expect(withEffect("4.0.0-rc.112")).toEqual([])
  })
})
