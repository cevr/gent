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
  findUnadmittedChildSessionWriters,
  findUnconsumedExports,
  findUnenabledPluginRules,
  findUnmatchedOverrideGlobs,
  findUnusedSuppressionApprovals,
  HOOK_FILE,
  isSteeringFile,
  type PackageJson,
  RETIRED_SURFACES,
} from "../src/guards"
import { Option } from "effect"

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

// ── child session depth ─────────────────────────────────────────────────────

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

  test("flags a writer that names parentSessionId by shorthand", () => {
    for (const literal of [
      "new Session({ id, parentSessionId, createdAt: now })",
      "new Session({\n  id,\n  parentSessionId\n})",
    ]) {
      expect(
        findUnadmittedChildSessionWriters("packages/core/src/server/server.ts", literal),
      ).toHaveLength(1)
    }
  })

  test("ignores a row that only names a longer field", () => {
    const findings = findUnadmittedChildSessionWriters(
      "packages/core/src/server/server.ts",
      "new Session({ id, parentSessionIdHint: x })",
    )
    expect(findings).toEqual([])
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

// ── core feature independence ───────────────────────────────────────────────

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
        message: "Bun platform layers may only be provided by platform roots",
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
        message: "Bun platform layers may only be provided by platform roots",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/server-root.ts",
        "const PlatformLayer = Layer.mergeAll(BunGentPlatformLive)",
      ),
    ).toEqual([])
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

const packageSurface = (
  entries: ReadonlyArray<readonly [string, PackageJson]>,
  paths: Readonly<Record<string, ReadonlyArray<string>>>,
) => findPackageSurfaceFindings(new Map(entries), { compilerOptions: { paths } })

/** The file and the key a package surface finding names, as `<file> <key>`. */
const pathOf = (finding: { readonly file: string; readonly message: string }): string =>
  `${finding.file} ${finding.message.split(": ")[0]}`

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
                "./host": "./src/host.ts",
                "./protocol": "./src/protocol.ts",
                "./test-utils": "./src/test-utils/index.ts",
              },
            },
          ],
        ],
        {
          "@gent/core/extensions/api": ["./packages/core/src/extensions/api.ts"],
          "@gent/core/protocol": ["./packages/core/src/protocol.ts"],
          "@gent/core/host": ["./packages/core/src/host.ts"],
          "@gent/core/test-utils": ["./packages/core/src/test-utils/index.ts"],
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
      ).map(pathOf),
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
      ).map(pathOf),
    ).toEqual([
      'packages/core/package.json exports["./protocol/*"]',
      'tsconfig.json compilerOptions.paths["@gent/core/protocol/*"]',
      'tsconfig.json compilerOptions.paths["@gent/core/unknown"]',
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
                "./client": "./src/client.ts",
              },
            },
          ],
        ],
        {
          "@gent/extensions": ["./packages/extensions/src/index.ts"],
          "@gent/extensions/client": ["./packages/extensions/src/client.ts"],
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
        file: "tsconfig.json",
        line: 1,
        message:
          'compilerOptions.paths["@gent/extensions/todo-storage"]: Do not give TypeScript a public-looking @gent/extensions path for an internal module',
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
        file: "packages/sdk/package.json",
        line: 1,
        message: 'exports["./rpcs"]: @gent/sdk may only expose its supported entry points: .',
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
