import { describe, expect, test } from "bun:test"
import {
  findSuppressionInventoryFindings,
  findUnusedSuppressionApprovals,
} from "../src/suppression-inventory"

const nextLine = ["// @effect", "diagnostics-next-line"].join("-")
const membraneFile = "packages/core/src/runtime/extensions/extension-effect-membrane.ts"
const membraneComment = `${nextLine} anyUnknownInErrorContext:off`

describe("suppression inventory guard", () => {
  test("flags effect diagnostics outside reviewed files", () => {
    expect(
      findSuppressionInventoryFindings("sample.ts", `${nextLine} strictEffectProvide:off`),
    ).toEqual([{ file: "sample.ts", line: 1, kind: "effect-diagnostics" }])
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
    ).toEqual([{ file: membraneFile, line: 1, kind: "effect-diagnostics" }])
  })

  test("approved entry with no matching comment in its file is unused", () => {
    const findings = findUnusedSuppressionApprovals(new Map([[membraneFile, "export {}\n"]]))
    expect(findings).toContainEqual({ file: membraneFile, comment: membraneComment })
  })

  test("approved entry whose file is not scanned is unused", () => {
    const findings = findUnusedSuppressionApprovals(new Map())
    expect(findings).toContainEqual({ file: membraneFile, comment: membraneComment })
  })

  test("approved entry with a matching comment is not reported", () => {
    const findings = findUnusedSuppressionApprovals(
      new Map([[membraneFile, `const x = 1\n  ${membraneComment}\nconst y = 2\n`]]),
    )
    expect(findings.filter((finding) => finding.file === membraneFile)).toEqual([])
  })
})
