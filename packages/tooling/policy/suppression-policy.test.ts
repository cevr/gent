import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { extname, resolve as pathResolve } from "node:path"

type SuppressionRule =
  | "effect:anyUnknownInErrorContext:off"
  | "effect:effectSucceedWithVoid:off"
  | "effect:globalConsoleInEffect:off"
  | "effect:globalErrorInEffectCatch:off"
  | "effect:globalErrorInEffectFailure:off"
  | "effect:nodeBuiltinImport:off"
  | "effect:preferSchemaOverJson:off"
  | "effect:strictEffectProvide:off"
  | "eslint:@typescript-eslint/no-empty-object-type"
  | "eslint:@typescript-eslint/no-explicit-any"
  | "eslint:@typescript-eslint/no-implied-eval"
  | "eslint:@typescript-eslint/no-non-null-assertion"
  | "eslint:@typescript-eslint/no-require-imports"
  | "eslint:@typescript-eslint/no-unsafe-type-assertion"
  | "eslint:import/namespace"
  | "eslint:no-await-in-loop"
  | "eslint:no-constant-condition"
  | "eslint:no-control-regex"
  | "eslint:no-new"
  | "eslint:no-process-env"
  | "eslint:typescript-eslint/consistent-type-imports"
  | "ts:@ts-expect-error"

interface SuppressionInstance {
  readonly file: string
  readonly line: number
  readonly rule: SuppressionRule
  readonly text: string
}

interface SuppressionCategory {
  readonly id: string
  readonly reason: string
  readonly matches: (file: string) => boolean
  readonly counts: Readonly<Partial<Record<SuppressionRule, number>>>
}

const ROOT = pathResolve(import.meta.dir, "..", "..", "..")
const SCAN_ROOTS = ["packages", "apps"] as const
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"])

const SUPPRESSION_CATEGORIES: ReadonlyArray<SuppressionCategory> = [
  {
    id: "tests-and-harnesses",
    reason:
      "Tests and harnesses may build partial fixtures or prove type fences directly. The debt is real, but it is isolated from production runtime edges.",
    matches: (file) =>
      /\/tests\//.test(file) ||
      /\.test\.[tj]sx?$/.test(file) ||
      /packages\/core\/src\/test-utils\//.test(file),
    counts: {
      "effect:anyUnknownInErrorContext:off": 4,
      "effect:nodeBuiltinImport:off": 1,
      "effect:strictEffectProvide:off": 2,
      "eslint:@typescript-eslint/no-explicit-any": 9,
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 46,
      "eslint:no-await-in-loop": 2,
      "eslint:no-control-regex": 6,
      "ts:@ts-expect-error": 30,
    },
  },
  {
    id: "runtime-effect-membranes",
    reason:
      "Explicit erased-effect membranes own the heterogeneous E/R boundary. Suppressions are allowed only where the code re-seals unknown channels into typed runtime errors.",
    matches: (file) =>
      [
        "packages/core/src/runtime/composer.ts",
        "packages/core/src/runtime/extensions/runtime-slots.ts",
        "packages/extensions/src/internal-resource-machine.ts",
        "packages/core/src/runtime/extensions/capability-host.ts",
        "packages/core/src/runtime/extensions/effect-membrane.ts",
        "packages/core/src/runtime/extensions/resource-host/index.ts",
        "packages/core/src/runtime/extensions/resource-host/machine-engine.ts",
        "packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts",
        "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
        "packages/core/src/runtime/extensions/extension-storage.ts",
        "packages/core/src/domain/extension-load-boundary.ts",
        "packages/core/src/extensions/api.ts",
        "apps/tui/src/components/autocomplete-popup-boundary.ts",
        "apps/tui/src/extensions/loader-boundary.ts",
      ].includes(file),
    counts: {
      "effect:anyUnknownInErrorContext:off": 22,
      "effect:globalErrorInEffectCatch:off": 1,
      "effect:globalErrorInEffectFailure:off": 1,
      "effect:preferSchemaOverJson:off": 1,
      "eslint:@typescript-eslint/no-explicit-any": 8,
      "eslint:@typescript-eslint/no-non-null-assertion": 2,
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 27,
    },
  },
  {
    id: "platform-entrypoints",
    reason:
      "Process entrypoints, supervisor probes, and platform bootstrap code sit at the edge of Effect's ideal model. These suppressions document those platform seams instead of pretending they are pure application logic.",
    matches: (file) =>
      [
        "apps/server/src/main.ts",
        "apps/tui/src/main.tsx",
        "apps/tui/src/utils/client-logger.ts",
        "apps/tui/src/workspace/context.tsx",
        "packages/core/src/server/build-fingerprint.ts",
        "packages/sdk/src/server.ts",
        "packages/sdk/src/supervisor.ts",
        "packages/core/src/runtime/log-paths.ts",
        "packages/core/src/server/rpc-handlers.ts",
        "packages/core/src/storage/sqlite-storage.ts",
        "packages/core/src/providers/provider.ts",
        "packages/extensions/src/task-tools-service.ts",
      ].includes(file),
    counts: {
      "effect:effectSucceedWithVoid:off": 3,
      "effect:globalConsoleInEffect:off": 2,
      "effect:globalErrorInEffectCatch:off": 1,
      "effect:globalErrorInEffectFailure:off": 1,
      "effect:nodeBuiltinImport:off": 6,
      "effect:strictEffectProvide:off": 8,
      "eslint:@typescript-eslint/no-empty-object-type": 1,
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 6,
    },
  },
  {
    id: "opaque-json-bridges",
    reason:
      "Raw JSON persistence and foreign protocol payloads are allowed to bypass Schema only at the narrow bridge that immediately re-normalizes the data.",
    matches: (file) =>
      [
        "packages/core/src/domain/auth-storage.ts",
        "packages/extensions/src/executor/mcp-bridge.ts",
      ].includes(file),
    counts: {
      "effect:preferSchemaOverJson:off": 3,
      "eslint:no-await-in-loop": 1,
    },
  },
  {
    id: "brand-and-schema-internals",
    reason:
      "Nominal-brand constructors and schema metaprogramming are one of the few places where carefully-owned casts are load-bearing. The rule is ownership, not convenience.",
    matches: (file) =>
      /packages\/core\/src\/domain\/(capability(\/|\.ts)|ids\.ts|read-only\.ts|schema-tagged-enum-class\.ts|resource\.ts|tool\.ts|projection\.ts|extension\.ts|contribution\.ts|tool-schema\.ts|sdk-boundary\.ts|interaction-request\.ts|permission\.ts)/.test(
        file,
      ),
    counts: {
      "eslint:@typescript-eslint/no-explicit-any": 10,
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 16,
      "eslint:import/namespace": 3,
      "eslint:no-new": 1,
    },
  },
  {
    id: "protocol-and-client-adapters",
    reason:
      "Protocol decoders and client wrappers sit between schema-level guarantees and consumer ergonomics. Suppressions here should disappear only when the transport model itself gets tighter.",
    matches: (file) =>
      [
        "packages/core/src/domain/extension-protocol.ts",
        "packages/core/src/runtime/extensions/resource-host/machine-protocol.ts",
        "packages/sdk/src/client.ts",
        "packages/sdk/src/namespaced-client.ts",
        "packages/sdk/src/local-supervisor.ts",
        "packages/sdk/src/server-registry.ts",
        "apps/tui/src/extensions/client-facets.ts",
      ].includes(file),
    counts: {
      "effect:nodeBuiltinImport:off": 3,
      "eslint:@typescript-eslint/no-empty-object-type": 1,
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 16,
    },
  },
  {
    id: "runtime-platform-adapters",
    reason:
      "Runtime adapters for optional native/platform dependencies may carry local lint suppressions where the import model or foreign API shape requires it.",
    matches: (file) => file === "packages/core/src/runtime/file-index/native-adapter.ts",
    counts: {
      "eslint:no-constant-condition": 1,
      "eslint:typescript-eslint/consistent-type-imports": 2,
    },
  },
  {
    id: "runtime-internals",
    reason:
      "Runtime internals still carry typed erase/cast residue. They are allowed here only until the surrounding architecture gets simpler enough to delete them.",
    matches: (file) =>
      /packages\/core\/src\/runtime\/(agent\/|make-extension-host-context\.ts|model-registry\.ts|retry\.ts|scope-brands\.ts|session-runtime\.ts|extensions\/extension-actor-shared\.ts|extensions\/loader\.ts|extensions\/resource-host\/schedule-engine\.ts|extensions\/spawn-machine-ref\.ts)/.test(
        file,
      ),
    counts: {
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 18,
    },
  },
  {
    id: "tui-adapters",
    reason:
      "TUI framework adapters still bridge generic UI/runtime surfaces. This bucket exists to keep that debt local while the client model keeps shrinking.",
    matches: (file) =>
      /apps\/tui\/src\/(app\.tsx|atom-solid\/|client\/|components\/(?!autocomplete-popup-boundary)|extensions\/(?!loader-boundary)(?!client-facets\.ts)|hooks\/use-cache\.ts|routes\/|theme\/|utils\/(format-error|run-with-reconnect|mermaid)\.ts)/.test(
        file,
      ),
    counts: {
      "eslint:@typescript-eslint/no-non-null-assertion": 1,
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 21,
      "eslint:no-control-regex": 2,
    },
  },
  {
    id: "extension-adapters",
    reason:
      "Foreign SDKs, sidecars, shells, and protocol adapters are allowed to carry cast debt at the adapter edge. Inside the core model, that debt is not acceptable.",
    matches: (file) =>
      /packages\/extensions\/src\//.test(file) || file === "apps/server/src/debug/scenario.ts",
    counts: {
      "eslint:@typescript-eslint/no-implied-eval": 1,
      "eslint:@typescript-eslint/no-require-imports": 1,
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 40,
      "eslint:no-process-env": 3,
      "eslint:typescript-eslint/consistent-type-imports": 1,
      "effect:nodeBuiltinImport:off": 1,
      "effect:preferSchemaOverJson:off": 2,
    },
  },
]

const walkFiles = (dir: string): ReadonlyArray<string> => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue
    const fullPath = pathResolve(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath))
      continue
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue
    out.push(fullPath)
  }
  return out
}

const parseSuppressions = (file: string): ReadonlyArray<SuppressionInstance> => {
  const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/")
  const source = readFileSync(file, "utf8")
  const lines = source.split("\n")
  const out: SuppressionInstance[] = []
  for (const [index, line] of lines.entries()) {
    for (const rule of parseEffectRules(line)) {
      out.push({
        file: rel,
        line: index + 1,
        rule,
        text: line.trim(),
      })
    }
    for (const rule of parseEslintRules(line)) {
      out.push({
        file: rel,
        line: index + 1,
        rule,
        text: line.trim(),
      })
    }
    if (/^\s*\/\/\s*@ts-expect-error\b/.test(line)) {
      out.push({
        file: rel,
        line: index + 1,
        rule: "ts:@ts-expect-error",
        text: line.trim(),
      })
    }
  }
  return out
}

const parseEffectRules = (line: string): ReadonlyArray<SuppressionRule> => {
  const effectMatch = line.match(/@effect-diagnostics(?<nextLine>-next-line)?\s+(?<rules>.*)$/)
  const rulesText = effectMatch?.groups?.rules.trim()
  if (rulesText === undefined || rulesText.length === 0) return []

  const [ruleList = ""] = rulesText.split(/\s(?:--|—)\s/, 1)
  const rules = ruleList
    .split(/\s+/)
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0)

  const scopedRules = effectMatch.groups?.nextLine === "-next-line" ? rules.slice(0, 1) : rules
  return scopedRules.map((rule) => `effect:${rule}` as SuppressionRule)
}

const parseEslintRules = (line: string): ReadonlyArray<SuppressionRule> => {
  const eslintMatch = line.match(/\beslint-disable(?<scope>-next-line|-line)?\b(?<rules>.*)$/)
  const rulesText = eslintMatch?.groups?.rules
  if (rulesText === undefined) return []
  if (eslintMatch.groups?.scope === undefined) return ["eslint:<block>" as SuppressionRule]

  const withoutBlockEnd = rulesText.replace(/\*\/\s*$/, "")
  const [ruleList = ""] = withoutBlockEnd.split(/\s--\s/, 1)
  const rules = ruleList
    .split(",")
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0)

  return rules.length === 0
    ? ["eslint:<all>" as SuppressionRule]
    : rules.map((rule) => `eslint:${rule}` as SuppressionRule)
}

const hasInlineReason = (suppression: SuppressionInstance): boolean =>
  !suppression.rule.startsWith("eslint:") || /\s--\s+\S/.test(suppression.text)

const ESLINT_RULES_REQUIRING_INLINE_REASON = new Set<SuppressionRule>([
  "eslint:@typescript-eslint/no-empty-object-type",
  "eslint:@typescript-eslint/no-implied-eval",
  "eslint:@typescript-eslint/no-non-null-assertion",
  "eslint:@typescript-eslint/no-require-imports",
  "eslint:import/namespace",
  "eslint:no-await-in-loop",
  "eslint:no-constant-condition",
  "eslint:no-control-regex",
  "eslint:no-new",
  "eslint:no-process-env",
  "eslint:typescript-eslint/consistent-type-imports",
])

const collectSuppressions = (): ReadonlyArray<SuppressionInstance> =>
  SCAN_ROOTS.flatMap((dir) => walkFiles(pathResolve(ROOT, dir)).flatMap(parseSuppressions))

const APPROVED_SUPPRESSION_RULES = new Set<SuppressionRule>([
  "effect:anyUnknownInErrorContext:off",
  "effect:effectSucceedWithVoid:off",
  "effect:globalConsoleInEffect:off",
  "effect:globalErrorInEffectCatch:off",
  "effect:globalErrorInEffectFailure:off",
  "effect:nodeBuiltinImport:off",
  "effect:preferSchemaOverJson:off",
  "effect:strictEffectProvide:off",
  "eslint:@typescript-eslint/no-empty-object-type",
  "eslint:@typescript-eslint/no-explicit-any",
  "eslint:@typescript-eslint/no-implied-eval",
  "eslint:@typescript-eslint/no-non-null-assertion",
  "eslint:@typescript-eslint/no-require-imports",
  "eslint:@typescript-eslint/no-unsafe-type-assertion",
  "eslint:import/namespace",
  "eslint:no-await-in-loop",
  "eslint:no-constant-condition",
  "eslint:no-control-regex",
  "eslint:no-new",
  "eslint:no-process-env",
  "eslint:typescript-eslint/consistent-type-imports",
  "ts:@ts-expect-error",
])

const formatCounts = (
  counts: ReadonlyMap<string, ReadonlyMap<SuppressionRule, number>>,
): ReadonlyArray<string> =>
  [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([category, rules]) =>
      [...rules.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rule, count]) => `${category} :: ${rule} = ${count}`),
    )

describe("suppression policy", () => {
  test("only approved suppression rule names appear in source", () => {
    const violations = collectSuppressions()
      .filter((instance) => !APPROVED_SUPPRESSION_RULES.has(instance.rule))
      .map((instance) => `${instance.file}:${instance.line} ${instance.rule}`)

    expect(violations).toEqual([])
  })

  test("newly-accounted eslint suppressions explain the local exception inline", () => {
    const reasonless = collectSuppressions()
      .filter((instance) => ESLINT_RULES_REQUIRING_INLINE_REASON.has(instance.rule))
      .filter((instance) => !hasInlineReason(instance))
      .map((instance) => `${instance.file}:${instance.line} ${instance.rule}`)

    expect(reasonless).toEqual([])
  })

  test("every suppression belongs to an approved architectural bucket", () => {
    const suppressions = collectSuppressions()
    const unexpected = suppressions.flatMap((instance) => {
      const category = SUPPRESSION_CATEGORIES.find((entry) => entry.matches(instance.file))
      if (category === undefined) {
        return [`unclassified ${instance.file}:${instance.line} ${instance.rule}`]
      }
      if (category.counts[instance.rule] === undefined) {
        return [
          `rule ${instance.rule} is not allowed in bucket ${category.id} for ${instance.file}:${instance.line}`,
        ]
      }
      return []
    })
    expect(unexpected).toEqual([])
  })

  test("suppression counts stay frozen until the owning architecture changes", () => {
    const suppressions = collectSuppressions()
    const actual = new Map<string, Map<SuppressionRule, number>>()
    for (const category of SUPPRESSION_CATEGORIES) {
      actual.set(category.id, new Map())
    }

    for (const instance of suppressions) {
      const category = SUPPRESSION_CATEGORIES.find((entry) => entry.matches(instance.file))
      if (category === undefined) continue
      const counts = actual.get(category.id)
      if (counts === undefined) continue
      counts.set(instance.rule, (counts.get(instance.rule) ?? 0) + 1)
    }

    const expected = new Map<string, Map<SuppressionRule, number>>(
      SUPPRESSION_CATEGORIES.map((category) => [
        category.id,
        new Map(Object.entries(category.counts) as Array<[SuppressionRule, number]>),
      ]),
    )

    const actualLines = formatCounts(actual)
    const expectedLines = formatCounts(expected)

    expect(actualLines).toEqual(expectedLines)
  })
})
