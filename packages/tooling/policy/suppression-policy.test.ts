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
  | "ts:@ts-nocheck"
  | "oxlint:no-await-in-loop"

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
const SCAN_ROOTS = ["packages", "apps", "lint"] as const
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
      "ts:@ts-expect-error": 33,
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
        "packages/core/src/extensions/internal.ts",
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
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 28,
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
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 14,
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
    id: "tooling-lint-adapters",
    reason:
      "Local lint rules bridge oxlint's plugin API where the runtime context exposes fields that the public type surface does not model.",
    matches: (file) => file === "lint/no-direct-env.ts",
    counts: {
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 1,
    },
  },
  {
    id: "tooling-rule-fixtures",
    reason:
      "Rule fixtures may disable TypeScript checking at the file boundary because they intentionally model invalid or partial source snippets for the linter.",
    matches: (file) => /packages\/tooling\/fixtures\/.+\.ts$/.test(file),
    counts: {
      "ts:@ts-nocheck": 14,
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
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 17,
      "eslint:no-control-regex": 2,
      "oxlint:no-await-in-loop": 2,
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
      "eslint:@typescript-eslint/no-unsafe-type-assertion": 39,
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
    for (const rule of parseOxlintRules(line)) {
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
    if (/^\s*\/\/\s*@ts-nocheck\b/.test(line)) {
      out.push({
        file: rel,
        line: index + 1,
        rule: "ts:@ts-nocheck",
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
  const eslintMatch = line.match(
    /(?:^|\s)(?:\/\/|\/\*)\s*eslint-disable(?<scope>-next-line|-line)?\b(?<rules>.*)$/,
  )
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

const parseOxlintRules = (line: string): ReadonlyArray<SuppressionRule> => {
  const oxlintMatch = line.match(
    /(?:^|\s)(?:\/\/|\/\*)\s*oxlint-disable(?<scope>-next-line|-line)?\b(?<rules>.*)$/,
  )
  const rulesText = oxlintMatch?.groups?.rules
  if (rulesText === undefined) return []
  if (oxlintMatch.groups?.scope === undefined) return ["oxlint:<block>" as SuppressionRule]

  const withoutBlockEnd = rulesText.replace(/\*\/\s*$/, "")
  const [ruleList = ""] = withoutBlockEnd.split(/\s--\s/, 1)
  const rules = ruleList
    .split(",")
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0)

  return rules.length === 0
    ? ["oxlint:<all>" as SuppressionRule]
    : rules.map((rule) => `oxlint:${rule}` as SuppressionRule)
}

const hasInlineReason = (suppression: SuppressionInstance): boolean =>
  (!suppression.rule.startsWith("eslint:") && !suppression.rule.startsWith("oxlint:")) ||
  /\s--\s+\S/.test(suppression.text)

const ESLINT_RULES_REQUIRING_INLINE_REASON = new Set<SuppressionRule>([
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
  "oxlint:no-await-in-loop",
])

const collectSuppressions = (): ReadonlyArray<SuppressionInstance> =>
  SCAN_ROOTS.flatMap((dir) => walkFiles(pathResolve(ROOT, dir)).flatMap(parseSuppressions))

const suppressionLocationKey = (instance: SuppressionInstance): string =>
  `${instance.file}:${instance.line} ${instance.rule}`

const APPROVED_SUPPRESSION_LOCATIONS = new Set<string>([
  "apps/server/src/debug/scenario.ts:589 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/server/src/main.ts:175 effect:globalConsoleInEffect:off",
  "apps/server/src/main.ts:178 effect:globalConsoleInEffect:off",
  "apps/server/src/main.ts:225 effect:strictEffectProvide:off",
  "apps/tui/src/app.tsx:25 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/app.tsx:41 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/atom-solid/atom.ts:41 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/atom-solid/registry.ts:135 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/client/context.tsx:798 eslint:@typescript-eslint/no-non-null-assertion",
  "apps/tui/src/components/composer.tsx:88 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/components/mermaid-viewer.tsx:60 eslint:no-control-regex",
  "apps/tui/src/components/tool-renderers/agent-tree.tsx:75 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/components/tool-renderers/grep.tsx:41 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/components/tool-renderers/live-child-tree.tsx:27 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/extensions/discovery.ts:54 oxlint:no-await-in-loop",
  "apps/tui/src/extensions/discovery.ts:61 oxlint:no-await-in-loop",
  "apps/tui/src/hooks/use-cache.ts:21 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/main.tsx:199 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/main.tsx:215 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/main.tsx:497 effect:strictEffectProvide:off",
  "apps/tui/src/main.tsx:536 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/routes/auth-state.ts:373 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/routes/session-controller.ts:281 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/routes/session-controller.ts:563 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/theme/resolve.ts:18 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/theme/resolve.ts:38 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/theme/resolve.ts:61 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/utils/client-logger.ts:13 effect:nodeBuiltinImport:off",
  "apps/tui/src/utils/format-error.ts:57 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/utils/mermaid.ts:64 eslint:no-control-regex",
  "apps/tui/src/utils/run-with-reconnect.ts:23 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/workspace/context.tsx:119 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/src/workspace/context.tsx:9 effect:nodeBuiltinImport:off",
  "apps/tui/tests/autocomplete-effect-items.test.ts:51 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/tests/autocomplete-effect-items.test.ts:55 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/tests/autocomplete-effect-items.test.ts:63 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/tests/autocomplete-effect-items.test.ts:65 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "apps/tui/tests/extensions-resolve.test.ts:40 ts:@ts-expect-error",
  "apps/tui/tests/extensions-resolve.test.ts:46 ts:@ts-expect-error",
  "apps/tui/tests/helpers.ts:23 eslint:no-await-in-loop",
  "apps/tui/tests/helpers.ts:28 eslint:no-await-in-loop",
  "lint/no-direct-env.ts:649 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/auth-storage.ts:310 effect:preferSchemaOverJson:off",
  "packages/core/src/domain/auth-storage.ts:318 effect:preferSchemaOverJson:off",
  "packages/core/src/domain/capability.ts:192 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/domain/capability/action.ts:100 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/capability/action.ts:91 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/capability/request.ts:99 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/capability/tool.ts:108 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/domain/capability/tool.ts:116 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/capability/tool.ts:122 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/capability/tool.ts:137 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/capability/tool.ts:50 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/domain/contribution.ts:94 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-load-boundary.ts:23 effect:anyUnknownInErrorContext:off",
  "packages/core/src/domain/extension-load-boundary.ts:24 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:191 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:202 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:217 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:220 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:253 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:272 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:275 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:324 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:333 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension-protocol.ts:376 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/extension.ts:316 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/domain/extension.ts:342 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/domain/interaction-request.ts:72 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/permission.ts:9 eslint:no-new",
  "packages/core/src/domain/projection.ts:132 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/domain/read-only.ts:73 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/resource.ts:188 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/domain/resource.ts:203 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/domain/resource.ts:265 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/domain/schema-tagged-enum-class.ts:147 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/schema-tagged-enum-class.ts:157 eslint:import/namespace",
  "packages/core/src/domain/schema-tagged-enum-class.ts:159 eslint:import/namespace",
  "packages/core/src/domain/schema-tagged-enum-class.ts:194 eslint:import/namespace",
  "packages/core/src/domain/schema-tagged-enum-class.ts:296 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/schema-tagged-enum-class.ts:391 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/sdk-boundary.ts:71 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/tool-schema.ts:25 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/tool-schema.ts:30 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/tool-schema.ts:35 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/domain/tool.ts:12 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/extensions/api.ts:301 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/extensions/api.ts:315 effect:anyUnknownInErrorContext:off",
  "packages/core/src/extensions/api.ts:328 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/extensions/api.ts:340 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/extensions/internal.ts:62 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/providers/provider.ts:477 effect:strictEffectProvide:off",
  "packages/core/src/runtime/agent/agent-runner.ts:114 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/agent/agent-runner.ts:497 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/agent/tool-runner.ts:174 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/agent/tool-runner.ts:177 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/agent/tool-runner.ts:183 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/agent/tool-runner.ts:85 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:105 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/runtime/composer.ts:107 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/runtime/composer.ts:173 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:186 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:188 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:192 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:194 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:196 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:198 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:200 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:219 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/runtime/composer.ts:284 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/runtime/composer.ts:284 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:293 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:296 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/composer.ts:298 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/composer.ts:300 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:312 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/composer.ts:313 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:323 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/composer.ts:337 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/composer.ts:350 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:361 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/composer.ts:363 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:365 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/composer.ts:367 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/composer.ts:372 eslint:@typescript-eslint/no-non-null-assertion",
  "packages/core/src/runtime/composer.ts:375 eslint:@typescript-eslint/no-non-null-assertion",
  "packages/core/src/runtime/composer.ts:384 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/composer.ts:385 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/composer.ts:96 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/runtime/extensions/capability-host.ts:238 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/capability-host.ts:260 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/capability-host.ts:286 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/capability-host.ts:71 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/effect-membrane.ts:24 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/effect-membrane.ts:25 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/effect-membrane.ts:38 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/effect-membrane.ts:39 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/effect-membrane.ts:42 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/runtime/extensions/effect-membrane.ts:54 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/runtime/extensions/effect-membrane.ts:57 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/effect-membrane.ts:58 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/effect-membrane.ts:62 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/extension-actor-shared.ts:19 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/extension-actor-shared.ts:23 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/extension-storage.ts:75 effect:globalErrorInEffectCatch:off",
  "packages/core/src/runtime/extensions/extension-storage.ts:75 effect:globalErrorInEffectFailure:off",
  "packages/core/src/runtime/extensions/extension-storage.ts:75 effect:preferSchemaOverJson:off",
  "packages/core/src/runtime/extensions/loader.ts:139 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/loader.ts:143 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts:153 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts:154 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/resource-host/machine-protocol.ts:130 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/resource-host/machine-protocol.ts:139 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/resource-host/machine-protocol.ts:168 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/resource-host/resource-layer.ts:38 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/resource-host/resource-layer.ts:50 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/resource-host/resource-layer.ts:65 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:156 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/runtime-slots.ts:101 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/runtime/extensions/runtime-slots.ts:105 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/runtime-slots.ts:125 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/runtime-slots.ts:295 effect:anyUnknownInErrorContext:off",
  "packages/core/src/runtime/extensions/spawn-machine-ref.ts:241 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/extensions/spawn-machine-ref.ts:309 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/file-index/native-adapter.ts:141 eslint:no-constant-condition",
  "packages/core/src/runtime/file-index/native-adapter.ts:16 eslint:typescript-eslint/consistent-type-imports",
  "packages/core/src/runtime/file-index/native-adapter.ts:18 eslint:typescript-eslint/consistent-type-imports",
  "packages/core/src/runtime/log-paths.ts:13 effect:nodeBuiltinImport:off",
  "packages/core/src/runtime/make-extension-host-context.ts:246 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/retry.ts:50 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/scope-brands.ts:102 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/scope-brands.ts:80 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/runtime/scope-brands.ts:89 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/server/build-fingerprint.ts:40 effect:globalErrorInEffectCatch:off",
  "packages/core/src/server/build-fingerprint.ts:40 effect:globalErrorInEffectFailure:off",
  "packages/core/src/server/rpc-handlers.ts:67 effect:effectSucceedWithVoid:off",
  "packages/core/src/storage/sqlite-storage.ts:1640 effect:strictEffectProvide:off",
  "packages/core/src/storage/sqlite-storage.ts:73 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/e2e-layer.ts:134 effect:anyUnknownInErrorContext:off",
  "packages/core/src/test-utils/e2e-layer.ts:135 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/test-utils/e2e-layer.ts:135 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/e2e-layer.ts:139 effect:anyUnknownInErrorContext:off",
  "packages/core/src/test-utils/e2e-layer.ts:169 effect:anyUnknownInErrorContext:off",
  "packages/core/src/test-utils/e2e-layer.ts:170 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/test-utils/e2e-layer.ts:170 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/e2e-layer.ts:172 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/extension-harness.ts:148 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/test-utils/extension-harness.ts:158 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/extension-harness.ts:179 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/test-utils/extension-harness.ts:183 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/extension-harness.ts:192 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/test-utils/extension-harness.ts:293 effect:anyUnknownInErrorContext:off",
  "packages/core/src/test-utils/extension-harness.ts:294 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/src/test-utils/extension-harness.ts:294 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/extension-harness.ts:296 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/fake-fetch.ts:124 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/fake-fetch.ts:148 effect:strictEffectProvide:off",
  "packages/core/src/test-utils/fixtures.ts:6 effect:nodeBuiltinImport:off",
  "packages/core/src/test-utils/index.ts:114 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/src/test-utils/index.ts:167 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/domain/agent-driver-routing.test.ts:17 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/acp-system-prompt-slot.test.ts:19 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/actor.test.ts:411 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/actor.test.ts:449 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/capability-host.test.ts:169 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/capability-host.test.ts:182 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/capability-host.test.ts:190 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/capability-host.test.ts:210 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/capability-host.test.ts:269 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/capability-host.test.ts:285 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/capability-host.test.ts:35 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/capability-host.test.ts:52 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/claude-code-executor.test.ts:102 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/claude-code-executor.test.ts:117 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/claude-code-executor.test.ts:145 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/claude-code-executor.test.ts:18 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/claude-code-executor.test.ts:25 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/claude-code-executor.test.ts:41 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/claude-code-executor.test.ts:57 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/claude-code-executor.test.ts:70 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/claude-code-executor.test.ts:87 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:132 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:166 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:198 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:209 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:219 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:235 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:243 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:251 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:253 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:255 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:264 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:272 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:296 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:298 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:300 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:302 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:304 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:317 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:332 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:343 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:351 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:357 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:424 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:456 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:501 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:61 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:85 ts:@ts-expect-error",
  "packages/core/tests/extensions/extension-surface-locks.test.ts:99 ts:@ts-expect-error",
  "packages/core/tests/extensions/helpers/actor-runtime-layer.ts:59 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/tests/extensions/helpers/actor-runtime-layer.ts:59 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/openai-extension-driver.test.ts:245 effect:strictEffectProvide:off",
  "packages/core/tests/extensions/resource-host.test.ts:234 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/tests/extensions/resource-host.test.ts:234 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/resource-host.test.ts:256 eslint:@typescript-eslint/no-explicit-any",
  "packages/core/tests/extensions/resource-host.test.ts:256 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/skills/skills-actor.test.ts:60 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/skills/skills-rpc.test.ts:54 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/extensions/task-tools/task-tools.test.ts:50 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/runtime/driver-override-routing.test.ts:21 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/runtime/driver-override-routing.test.ts:23 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/runtime/scope-brands.test.ts:265 ts:@ts-expect-error",
  "packages/core/tests/runtime/scope-brands.test.ts:58 ts:@ts-expect-error",
  "packages/core/tests/runtime/scope-brands.test.ts:70 ts:@ts-expect-error",
  "packages/core/tests/server/event-publisher.test.ts:361 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/core/tests/server/event-publisher.test.ts:475 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/e2e/tests/e2e.test.ts:187 eslint:no-control-regex",
  "packages/e2e/tests/e2e.test.ts:189 eslint:no-control-regex",
  "packages/e2e/tests/e2e.test.ts:191 eslint:no-control-regex",
  "packages/e2e/tests/e2e.test.ts:193 eslint:no-control-regex",
  "packages/e2e/tests/e2e.test.ts:195 eslint:no-control-regex",
  "packages/e2e/tests/e2e.test.ts:197 eslint:no-control-regex",
  "packages/extensions/src/acp-agents/claude-code-executor.ts:103 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/claude-code-executor.ts:129 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/claude-code-executor.ts:134 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/claude-code-executor.ts:149 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/claude-code-executor.ts:80 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/claude-sdk.ts:142 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/claude-sdk.ts:155 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/claude-sdk.ts:205 eslint:no-process-env",
  "packages/extensions/src/acp-agents/executor-boundary.ts:34 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/executor.ts:104 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/executor.ts:78 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/mcp-codemode.ts:150 eslint:@typescript-eslint/no-implied-eval",
  "packages/extensions/src/acp-agents/mcp-codemode.ts:155 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/mcp-codemode.ts:210 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/mcp-codemode.ts:61 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/protocol.ts:126 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/acp-agents/protocol.ts:200 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/keychain-client.ts:247 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/keychain-client.ts:483 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/keychain-client.ts:515 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/keychain-client.ts:529 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/keychain-client.ts:540 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/oauth.ts:351 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/oauth.ts:356 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/oauth.ts:466 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/oauth.ts:538 eslint:no-process-env",
  "packages/extensions/src/anthropic/oauth.ts:541 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/oauth.ts:543 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/anthropic/oauth.ts:708 eslint:no-process-env",
  "packages/extensions/src/anthropic/oauth.ts:96 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/auto-journal.ts:131 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/auto.ts:48 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/exec-tools/bash.ts:176 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/exec-tools/bash.ts:178 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/exec-tools/bash.ts:241 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/exec-tools/bash.ts:243 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/executor/actor.ts:224 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/executor/actor.ts:247 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/executor/mcp-bridge.ts:268 eslint:no-await-in-loop",
  "packages/extensions/src/executor/mcp-bridge.ts:317 effect:preferSchemaOverJson:off",
  "packages/extensions/src/executor/sidecar.ts:202 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/executor/sidecar.ts:206 effect:preferSchemaOverJson:off",
  "packages/extensions/src/executor/sidecar.ts:96 effect:preferSchemaOverJson:off",
  "packages/extensions/src/interaction-tools/ask-user.ts:13 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/librarian/git-reader.ts:112 eslint:@typescript-eslint/no-require-imports",
  "packages/extensions/src/librarian/git-reader.ts:112 eslint:typescript-eslint/consistent-type-imports",
  "packages/extensions/src/memory/index.ts:117 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/memory/vault.ts:1 effect:nodeBuiltinImport:off",
  "packages/extensions/src/openai/codex-transform.ts:252 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/extensions/src/task-tools-service.ts:91 effect:effectSucceedWithVoid:off",
  "packages/extensions/src/task-tools-service.ts:94 effect:effectSucceedWithVoid:off",
  "packages/sdk/src/client.ts:248 eslint:@typescript-eslint/no-empty-object-type",
  "packages/sdk/src/server-registry.ts:10 effect:nodeBuiltinImport:off",
  "packages/sdk/src/server-registry.ts:12 effect:nodeBuiltinImport:off",
  "packages/sdk/src/server-registry.ts:183 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/sdk/src/server-registry.ts:22 effect:nodeBuiltinImport:off",
  "packages/sdk/src/server.ts:13 effect:nodeBuiltinImport:off",
  "packages/sdk/src/server.ts:15 effect:nodeBuiltinImport:off",
  "packages/sdk/src/server.ts:157 effect:strictEffectProvide:off",
  "packages/sdk/src/server.ts:248 effect:strictEffectProvide:off",
  "packages/sdk/src/server.ts:284 eslint:@typescript-eslint/no-unsafe-type-assertion",
  "packages/sdk/src/server.ts:296 effect:strictEffectProvide:off",
  "packages/sdk/src/server.ts:318 effect:strictEffectProvide:off",
  "packages/sdk/src/server.ts:45 eslint:@typescript-eslint/no-empty-object-type",
  "packages/sdk/src/supervisor.ts:303 effect:nodeBuiltinImport:off",
  "packages/tooling/fixtures/all-errors-are-tagged.invalid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/all-errors-are-tagged.valid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/brand-constructor-callers.invalid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/brand-constructor-callers.valid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-define-extension-throw.invalid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-define-extension-throw.valid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-dynamic-imports.invalid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-dynamic-imports.valid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-r-equals-never-comment.invalid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-r-equals-never-comment.valid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-runpromise-outside-boundary-boundary.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-runpromise-outside-boundary.invalid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-scope-brand-cast.invalid.ts:1 ts:@ts-nocheck",
  "packages/tooling/fixtures/no-scope-brand-cast.valid.ts:1 ts:@ts-nocheck",
  "packages/tooling/tests/fixtures.test.ts:49 eslint:@typescript-eslint/no-unsafe-type-assertion",
])

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
  "ts:@ts-nocheck",
  "oxlint:no-await-in-loop",
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

  test("suppression locations stay frozen until the owning architecture changes", () => {
    const actual = collectSuppressions().map(suppressionLocationKey).sort()
    const expected = [...APPROVED_SUPPRESSION_LOCATIONS].sort()

    expect(actual).toEqual(expected)
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
