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

const approvedEffectDiagnosticFiles = new Set([
  "apps/server/src/main.ts",
  "apps/tui/src/main.tsx",
  "apps/tui/src/utils/client-logger.ts",
  "apps/tui/src/workspace/context.tsx",
  "apps/tui/tests/extension-effect-setup.test.ts",
  "apps/tui/tests/extension-integration.test.ts",
  "apps/tui/tests/headless-cli-exit.test.ts",
  "packages/core/src/domain/extension-load-boundary.ts",
  "packages/core/src/extensions/api.ts",
  "packages/core/src/runtime/agent/ephemeral-root.ts",
  "packages/core/src/runtime/agent/tool-runner.ts",
  "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
  "packages/core/src/runtime/extensions/extension-reactions.ts",
  "packages/core/src/runtime/extensions/registry.ts",
  "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
  "packages/core/src/runtime/log-paths.ts",
  "packages/core/src/runtime/session-runtime.ts",
  "packages/core/src/test-utils/e2e-layer.ts",
  "packages/core/src/test-utils/extension-harness.ts",
  "packages/core/src/test-utils/fake-fetch.ts",
  "packages/core/src/test-utils/fixtures.ts",
  "packages/core/tests/server/interaction-commands.test.ts",
  "packages/extensions/src/acp-agents/claude-code-auth.ts",
  "packages/extensions/src/anthropic/index.ts",
  "packages/extensions/src/anthropic/oauth.ts",
  "packages/extensions/src/executor/mcp-bridge.ts",
  "packages/extensions/src/executor/sidecar.ts",
  "packages/extensions/src/openai/oauth.ts",
  "packages/extensions/src/task-tools-service.ts",
  "packages/extensions/src/workflow-helpers.ts",
  "packages/sdk/src/server-lock.ts",
  "packages/sdk/src/server.ts",
  "packages/sdk/src/transport-headers.ts",
  "packages/sdk/tests/server-lock.test.ts",
])

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
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    for (const { kind, pattern } of linePatterns) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, kind })
    }
    if (
      line.includes(["@effect", "diagnostics"].join("-")) &&
      !approvedEffectDiagnosticFiles.has(file)
    ) {
      findings.push({ file, line: index + 1, kind: "effect-diagnostics" })
    }
  }
  for (const finding of findBannedEslintDisableBlocks(file, text)) {
    findings.push({ ...finding, kind: "eslint-disable-block" })
  }
  return findings
}
