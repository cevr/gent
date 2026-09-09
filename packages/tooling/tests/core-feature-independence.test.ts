import { describe, expect, test } from "bun:test"
import {
  ASSEMBLY_SITES,
  findCoreFeatureIndependenceFindings,
} from "../src/core-feature-independence"

const CELL_IMPORT = 'import { CellExecution } from "../code-cell/cell-execution.js"'

describe("core feature independence guard", () => {
  test("flags a core file that imports a feature directory", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/agent/agent-loop.behavior.ts",
      CELL_IMPORT,
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "packages/core/src/runtime/agent/agent-loop.behavior.ts:1",
    ])
    expect(findings[0]?.message).toContain("code-cell")
  })

  test("flags a type-only import, which still names the feature", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/session-runtime.ts",
      'import type { DispatchingToolStorage } from "./code-cell/dispatching-tool-storage.js"',
    )
    expect(findings.length).toBe(1)
  })

  test("allows a feature to import itself", () => {
    const findings = findCoreFeatureIndependenceFindings(
      "packages/core/src/runtime/code-cell/cell-storage.ts",
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
      "packages/core/src/runtime/agent/tool-runner.ts",
      "// the code-cell feature dispatches inner tool calls",
    )
    expect(findings).toEqual([])
  })
})
