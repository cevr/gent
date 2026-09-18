import { describe, expect, test } from "bun:test"
import {
  ASSEMBLY_SITES,
  findCoreFeatureIndependenceFindings,
} from "../src/core-feature-independence"

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
      "packages/core/src/runtime/session-runtime.ts",
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
})
