import { findBannedEslintDisableBlocks } from "./blanket-eslint-disable"

export type SuppressionFindingKind =
  | "ts-ignore"
  | "as-any"
  | "extension-host-context-cast"
  | "eslint-disable-block"
  | "effect-diagnostics"

export interface SuppressionInventoryFinding {
  readonly file: string
  readonly line: number
  readonly kind: SuppressionFindingKind
}

interface ApprovedSuppressionEntry {
  readonly file: string
  readonly line: number
  readonly kind: SuppressionFindingKind
  readonly text: string
}

const approvedSuppressionEntries: ReadonlyArray<ApprovedSuppressionEntry> = [
  {
    file: "apps/server/src/main.ts",
    line: 154,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line globalConsoleInEffect:off",
  },
  {
    file: "apps/server/src/main.ts",
    line: 157,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line globalConsoleInEffect:off",
  },
  {
    file: "apps/server/src/main.ts",
    line: 205,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off",
  },
  {
    file: "apps/tui/src/main.tsx",
    line: 101,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line globalTimersInEffect:off -- process lifetime handle: OpenTUI render resolves after mount and suspended Effect fibers do not keep Bun alive",
  },
  {
    file: "apps/tui/src/main.tsx",
    line: 679,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off entrypoint layer provision",
  },
  {
    file: "apps/tui/src/workspace/context.tsx",
    line: 176,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off solid mount edge — isolated FS effect",
  },
  {
    file: "apps/tui/src/utils/client-logger.ts",
    line: 13,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extension-effect-setup.test.ts",
    line: 7,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extension-effect-setup.test.ts",
    line: 9,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extension-integration.test.ts",
    line: 10,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extension-integration.test.ts",
    line: 12,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/headless-cli-exit.test.ts",
    line: 3,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/headless-cli-exit.test.ts",
    line: 6,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line nodeBuiltinImport:off",
  },
  {
    file: "packages/sdk/src/transport-headers.ts",
    line: 1,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics nodeBuiltinImport:off — SDK transport computes stable local workspace ids.",
  },
  {
    file: "packages/sdk/src/transport-headers.ts",
    line: 3,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics nodeBuiltinImport:off — SDK transport canonicalizes caller cwd before hashing.",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 14,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics nodeBuiltinImport:off — server primitive owns filesystem path resolution",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 170,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 199,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 244,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 289,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off self-contained probe, no scope lifetime",
  },
  {
    file: "packages/sdk/src/server.ts",
    line: 307,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off",
  },
  {
    file: "packages/sdk/tests/server-lock.test.ts",
    line: 6,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics nodeBuiltinImport:off",
  },
  {
    file: "packages/core/tests/server/interaction-commands.test.ts",
    line: 3,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics nodeBuiltinImport:off -- mirrors SDK workspace hashing in a restart fixture.",
  },
  {
    file: "packages/core/tests/server/interaction-commands.test.ts",
    line: 5,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics nodeBuiltinImport:off -- file-backed restart fixture uses a temp SQLite path.",
  },
  {
    file: "packages/core/src/domain/extension-load-boundary.ts",
    line: 24,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/e2e-layer.ts",
    line: 97,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/e2e-layer.ts",
    line: 101,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/extension-harness.ts",
    line: 154,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/fixtures.ts",
    line: 6,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics nodeBuiltinImport:off — test fixture lifecycle comes from bun:test",
  },
  {
    file: "packages/core/src/test-utils/fake-fetch.ts",
    line: 150,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off test entry point",
  },
  {
    file: "packages/core/src/runtime/log-paths.ts",
    line: 13,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line nodeBuiltinImport:off",
  },
  {
    file: "packages/core/src/runtime/session-runtime.ts",
    line: 1100,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect cluster's Entity.toLayer exposes erased RPC middleware requirements; the exported layer narrows the Gent-owned services at this boundary.",
  },
  {
    file: "packages/core/src/runtime/agent/ephemeral-root.ts",
    line: 87,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit extension-layer recovery membrane",
  },
  {
    file: "packages/core/src/runtime/agent/ephemeral-root.ts",
    line: 110,
    kind: "effect-diagnostics",
    text: ": // @effect-diagnostics-next-line anyUnknownInErrorContext:off — heterogeneous upstream shape feeds the recovery membrane",
  },
  {
    file: "packages/core/src/runtime/agent/tool-runner.ts",
    line: 280,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/registry.ts",
    line: 235,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 24,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 29,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 40,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 42,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    line: 57,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-reactions.ts",
    line: 146,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-reactions.ts",
    line: 214,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-reactions.ts",
    line: 313,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous message-input slot",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-reactions.ts",
    line: 343,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous permission-check slot",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-reactions.ts",
    line: 374,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-reactions.ts",
    line: 407,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-reactions.ts",
    line: 454,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-execute slot",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-reactions.ts",
    line: 484,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-result slot",
  },
  {
    file: "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
    line: 49,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off — heterogeneous Resource layer enters the explicit eraseResourceLayer membrane.",
  },
  {
    file: "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
    line: 70,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit exitErasedEffect membrane.",
  },
  {
    file: "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
    line: 87,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit exitErasedEffect membrane.",
  },
  {
    file: "packages/extensions/src/openai/oauth.ts",
    line: 245,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off OAuth token endpoint at extension boundary",
  },
  {
    file: "packages/extensions/src/openai/oauth.ts",
    line: 285,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off OAuth token endpoint at extension boundary",
  },
  {
    file: "packages/extensions/src/anthropic/index.ts",
    line: 246,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off",
  },
  {
    file: "packages/extensions/src/anthropic/oauth.ts",
    line: 569,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off",
  },
  {
    file: "packages/extensions/src/acp-agents/claude-code-auth.ts",
    line: 53,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line strictEffectProvide:off",
  },
  {
    file: "packages/extensions/src/executor/sidecar.ts",
    line: 256,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics preferSchemaOverJson:off — parsing sidecar registry file",
  },
  {
    file: "packages/extensions/src/executor/mcp-bridge.ts",
    line: 317,
    kind: "effect-diagnostics",
    text: "// @effect-diagnostics-next-line preferSchemaOverJson:off",
  },
]

const approvedSuppression = (
  file: string,
  line: number,
  kind: SuppressionFindingKind,
  text: string,
): boolean =>
  approvedSuppressionEntries.some(
    (entry) =>
      entry.file === file &&
      entry.line === line &&
      entry.kind === kind &&
      entry.text === text.trim(),
  )

const linePatterns: ReadonlyArray<{
  readonly kind: SuppressionFindingKind
  readonly pattern: RegExp
}> = [
  { kind: "ts-ignore", pattern: new RegExp(`${["@ts", "ignore"].join("-")}\\b`) },
  { kind: "as-any", pattern: /\bas\s+any\b/ },
  {
    kind: "extension-host-context-cast",
    pattern: /as\s+unknown\s+as\s+ExtensionHostContext\b/,
  },
]

export const findSuppressionInventoryFindings = (
  file: string,
  text: string,
): ReadonlyArray<SuppressionInventoryFinding> => {
  const findings: SuppressionInventoryFinding[] = []
  if (file === "packages/tooling/src/suppression-inventory.ts") return findings

  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    for (const { kind, pattern } of linePatterns) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, kind })
    }
    if (
      line.includes(["@effect", "diagnostics"].join("-")) &&
      !approvedSuppression(file, index + 1, "effect-diagnostics", line)
    ) {
      findings.push({ file, line: index + 1, kind: "effect-diagnostics" })
    }
  }
  for (const finding of findBannedEslintDisableBlocks(file, text)) {
    findings.push({ ...finding, kind: "eslint-disable-block" })
  }
  return findings
}
