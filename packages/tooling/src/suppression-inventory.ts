/**
 * The one suppression the linters cannot police: `@effect-diagnostics` comments.
 * Every other kind (`@ts-ignore`, `as any`, block eslint-disables) is banned by
 * oxlint or by `blanket-eslint-disable`, so this inventory is the approved list
 * of diagnostics suppressions and nothing else.
 *
 * The inventory is checked in both directions: a suppression comment with no
 * approved entry fails the guard, and an approved entry with no matching
 * comment anywhere in the tree fails it too, so the table cannot drift.
 */
import { Option } from "effect"

export type SuppressionFindingKind = "effect-diagnostics"

export interface SuppressionInventoryFinding {
  readonly file: string
  readonly line: number
  readonly kind: SuppressionFindingKind
}

/** An approved entry that no suppression comment in the scanned tree matches. */
export interface UnusedSuppressionApproval {
  readonly file: string
  readonly comment: string
}

/** `next-line` suppresses the following line; `file` suppresses the whole module. */
type SuppressionScope = "next-line" | "file"

interface ApprovedSuppressionEntry {
  readonly file: string
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

/** Matching ignores line churn: an entry is keyed by file and exact comment text. */
const approvedSuppressionEntries: ReadonlyArray<ApprovedSuppressionEntry> = [
  {
    file: "apps/tui/src/main.tsx",
    scope: "next-line",
    text: "globalTimersInEffect:off -- process lifetime handle: OpenTUI render resolves after mount and suspended Effect fibers do not keep Bun alive",
  },
  {
    file: "apps/tui/src/workspace.tsx",
    scope: "next-line",
    text: "strictEffectProvide:off solid mount edge — isolated FS effect",
  },
  {
    file: "apps/tui/src/client.tsx",
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extension-effect-setup.test.ts",
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extension-integration.test.ts",
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "packages/core/src/server/workspace-rpc.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — the workspace id is a wire constant, see workspaceIdForCwd",
  },
  {
    file: "packages/core/src/server/workspace-rpc.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — the workspace id canonicalizes its cwd before hashing",
  },
  {
    file: "packages/sdk/src/data-paths.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — this module owns path resolution for gent's data directory",
  },
  {
    file: "packages/sdk/src/server.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — server primitive owns filesystem path resolution",
  },
  {
    file: "packages/sdk/src/server.ts",
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
  {
    file: "packages/sdk/src/server.ts",
    scope: "next-line",
    text: "strictEffectProvide:off self-contained probe, no scope lifetime",
  },
  {
    file: "packages/sdk/tests/server-lock.test.ts",
    scope: "file",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "packages/core/src/domain/extension-load-boundary.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/fixtures.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — test fixture lifecycle comes from bun:test",
  },
  {
    file: "packages/core/src/test-utils/fake-fetch.ts",
    scope: "next-line",
    text: "strictEffectProvide:off test entry point",
  },
  {
    file: "packages/core/src/runtime/agent/tools.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/registry.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/domain/capability.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — the erased handler crosses the runtime membrane; the public overloads keep authors typed.",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/extension-hooks.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — heterogeneous Resource layer enters the explicit eraseResourceLayer membrane.",
  },
  {
    file: "packages/core/src/runtime/extensions/resource-host/resource-layer.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit exitErasedEffect membrane.",
  },
  {
    file: "packages/extensions/src/openai.ts",
    scope: "next-line",
    text: "strictEffectProvide:off OAuth token endpoint at extension boundary",
  },
  {
    file: "packages/extensions/src/openai.ts",
    scope: "next-line",
    text: "strictEffectProvide:off OAuth authorization owns its crypto layer at the extension boundary",
  },
  {
    file: "packages/extensions/src/openai.ts",
    scope: "next-line",
    text: "strictEffectProvide:off device endpoints at extension boundary",
  },
  {
    file: "packages/extensions/src/anthropic.ts",
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
]

/**
 * The guards that write the marker out to recognise it. Each spells
 * `@effect-diagnostics` in a pattern, a table entry or a message, so scanning
 * them reports the description of a suppression instead of a suppression.
 */
const DESCRIBES_THE_MARKER = new Set([
  "packages/tooling/src/suppression-inventory.ts",
  "packages/tooling/src/diagnostic-suppression-anchor.ts",
  "packages/tooling/tests/diagnostic-suppression-anchor.test.ts",
])

const approvedSuppression = (file: string, text: string): boolean =>
  approvedSuppressionEntries.some(
    (entry) => entry.file === file && approvedComment(entry) === text.trim(),
  )

export const findSuppressionInventoryFindings = (
  file: string,
  text: string,
): ReadonlyArray<SuppressionInventoryFinding> => {
  const findings: SuppressionInventoryFinding[] = []
  if (DESCRIBES_THE_MARKER.has(file)) return findings

  for (const [index, line] of text.split("\n").entries()) {
    if (line.includes(directiveMarker) && !approvedSuppression(file, line)) {
      findings.push({ file, line: index + 1, kind: "effect-diagnostics" })
    }
  }
  return findings
}

const containsComment = (text: string, comment: string): boolean =>
  text.split("\n").some((line) => line.trim() === comment)

/**
 * Whole-tree check: every approved entry must match a comment in its file.
 * `sources` maps each scanned source path to its text; a file missing from
 * the map counts as having no suppressions.
 */
export const findUnusedSuppressionApprovals = (
  sources: ReadonlyMap<string, string>,
): ReadonlyArray<UnusedSuppressionApproval> =>
  approvedSuppressionEntries.flatMap((entry) => {
    const comment = approvedComment(entry)
    const source = Option.fromNullishOr(sources.get(entry.file))
    if (Option.exists(source, (text) => containsComment(text, comment))) return []
    return [{ file: entry.file, comment }]
  })
