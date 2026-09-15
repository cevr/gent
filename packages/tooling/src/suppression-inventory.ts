/**
 * The one suppression the linters cannot police: `@effect-diagnostics` comments.
 * Every other kind (`@ts-ignore`, `as any`, block eslint-disables) is banned by
 * oxlint or by `blanket-eslint-disable`, so this inventory is the approved list
 * of diagnostics suppressions and nothing else.
 */
export type SuppressionFindingKind = "effect-diagnostics"

export interface SuppressionInventoryFinding {
  readonly file: string
  readonly line: number
  readonly kind: SuppressionFindingKind
}

/** `next-line` suppresses the following line; `file` suppresses the whole module. */
type SuppressionScope = "next-line" | "file"

interface ApprovedSuppressionEntry {
  readonly file: string
  /** Historical receipt only; matching intentionally ignores line churn. */
  readonly line: number
  readonly scope: SuppressionScope
  /** Everything after the directive: rule flags and the reason. */
  readonly text: string
}

const directiveMarker = ["@effect", "diagnostics"].join("-")

const directivePrefix = {
  "next-line": `// ${directiveMarker}-next-line`,
  file: `// ${directiveMarker}`,
} satisfies Record<SuppressionScope, string>

const approvedComment = (entry: ApprovedSuppressionEntry): string =>
  `${directivePrefix[entry.scope]} ${entry.text}`

const approvedSuppressionEntries: ReadonlyArray<ApprovedSuppressionEntry> = [
  {
    file: "apps/tui/src/main.tsx",
    line: 105,
    scope: "next-line",
    text: "globalTimersInEffect:off -- process lifetime handle: OpenTUI render resolves after mount and suspended Effect fibers do not keep Bun alive",
  },
  {
    file: "apps/tui/src/main.tsx",
    line: 690,
    scope: "next-line",
    text: "strictEffectProvide:off entrypoint layer provision",
  },
  {
    file: "apps/tui/src/workspace/context.tsx",
    line: 176,
    scope: "next-line",
    text: "strictEffectProvide:off solid mount edge — isolated FS effect",
  },
  {
    file: "apps/tui/src/utils/client-logger.ts",
    line: 13,
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/src/utils/client-logger.ts",
    line: 32,
    scope: "next-line",
    text: "globalDate:off -- shutdown path, no Effect runtime to yield Clock from",
  },
  {
    file: "apps/tui/tests/extension-effect-setup.test.ts",
    line: 7,
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extension-effect-setup.test.ts",
    line: 9,
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extension-integration.test.ts",
    line: 10,
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extension-integration.test.ts",
    line: 12,
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/headless-cli-exit.test.ts",
    line: 3,
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/headless-cli-exit.test.ts",
    line: 6,
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "packages/core/src/server/workspace-rpc.ts",
    line: 4,
    scope: "file",
    text: "nodeBuiltinImport:off — the workspace id is a wire constant, see workspaceIdForCwd",
  },
  {
    file: "packages/core/src/server/workspace-rpc.ts",
    line: 6,
    scope: "file",
    text: "nodeBuiltinImport:off — the workspace id canonicalizes its cwd before hashing",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 14,
    scope: "file",
    text: "nodeBuiltinImport:off — server primitive owns filesystem path resolution",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 170,
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 199,
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 244,
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 289,
    scope: "next-line",
    text: "strictEffectProvide:off self-contained probe, no scope lifetime",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 307,
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
  {
    file: "packages/sdk/tests/server-lock.test.ts",
    line: 6,
    scope: "file",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "packages/core/tests/server/interaction-commands.test.ts",
    line: 5,
    scope: "file",
    text: "nodeBuiltinImport:off -- file-backed restart fixture uses a temp SQLite path.",
  },
  {
    file: "packages/core/src/domain/extension-load-boundary.ts",
    line: 24,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/e2e-layer.ts",
    line: 97,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/e2e-layer.ts",
    line: 101,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/extension-harness.ts",
    line: 152,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/fixtures.ts",
    line: 6,
    scope: "file",
    text: "nodeBuiltinImport:off — test fixture lifecycle comes from bun:test",
  },
  {
    file: "packages/core/src/test-utils/fake-fetch.ts",
    line: 150,
    scope: "next-line",
    text: "strictEffectProvide:off test entry point",
  },
  {
    file: "packages/sdk/src/log-paths.ts",
    line: 13,
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "packages/core/src/runtime/session-runtime.ts",
    line: 1102,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — Effect cluster's Entity.toLayer exposes erased RPC middleware requirements; the exported layer narrows the Gent-owned services at this boundary.",
  },
  {
    file: "packages/core/src/runtime/agent/tool-runner.ts",
    line: 280,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/registry.ts",
    line: 250,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 24,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 29,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 40,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 42,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 57,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-hooks.ts",
    line: 95,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-hooks.ts",
    line: 144,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-hooks.ts",
    line: 246,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-hooks.ts",
    line: 297,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-result slot",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-hooks.ts",
    line: 330,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
    line: 49,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — heterogeneous Resource layer enters the explicit eraseResourceLayer membrane.",
  },
  {
    file: "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
    line: 70,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit exitErasedEffect membrane.",
  },
  {
    file: "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
    line: 87,
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit exitErasedEffect membrane.",
  },
  {
    file: "packages/extensions/src/openai/oauth.ts",
    line: 287,
    scope: "next-line",
    text: "strictEffectProvide:off OAuth token endpoint at extension boundary",
  },
  {
    file: "packages/extensions/src/openai/oauth.ts",
    line: 327,
    scope: "next-line",
    text: "strictEffectProvide:off OAuth token endpoint at extension boundary",
  },
  {
    file: "packages/extensions/src/openai/oauth.ts",
    line: 526,
    scope: "next-line",
    text: "strictEffectProvide:off OAuth authorization owns its crypto layer at the extension boundary",
  },
  {
    file: "packages/extensions/src/openai/oauth.ts",
    line: 742,
    scope: "next-line",
    text: "strictEffectProvide:off device endpoints at extension boundary",
  },
  {
    file: "packages/extensions/src/anthropic/index.ts",
    line: 246,
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
  {
    file: "packages/extensions/src/anthropic/oauth/refresh.ts",
    line: 69,
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
  {
    file: "packages/core/src/test-utils/extension-harness.ts",
    line: 3,
    scope: "file",
    text: "nodeBuiltinImport:off — test stub needs sync path ops; ExtensionFilesService captures Path.Path at runtime construction",
  },
  {
    file: "packages/tooling/src/workspace-test-runner.ts",
    line: 59,
    scope: "next-line",
    text: "strictEffectProvide:off entrypoint layer provision",
  },
]

const approvedSuppression = (file: string, _line: number, text: string): boolean =>
  approvedSuppressionEntries.some(
    (entry) => entry.file === file && approvedComment(entry) === text.trim(),
  )

export const findSuppressionInventoryFindings = (
  file: string,
  text: string,
): ReadonlyArray<SuppressionInventoryFinding> => {
  const findings: SuppressionInventoryFinding[] = []
  if (file === "packages/tooling/src/suppression-inventory.ts") return findings

  for (const [index, line] of text.split("\n").entries()) {
    if (line.includes(directiveMarker) && !approvedSuppression(file, index + 1, line)) {
      findings.push({ file, line: index + 1, kind: "effect-diagnostics" })
    }
  }
  return findings
}
