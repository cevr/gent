import { describe, expect, test } from "bun:test"
import { findSuppressionInventoryFindings } from "../src/suppression-inventory"

const effectDiagnostics = ["@effect", "diagnostics-next-line"].join("-")

describe("suppression inventory guard", () => {
  test("flags effect diagnostics outside reviewed files", () => {
    expect(
      findSuppressionInventoryFindings(
        "sample.ts",
        `// ${effectDiagnostics} strictEffectProvide:off`,
      ),
    ).toEqual([{ file: "sample.ts", line: 1, kind: "effect-diagnostics" }])
  })

  test("allows exact reviewed effect diagnostics independent of line churn", () => {
    expect(
      findSuppressionInventoryFindings(
        "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
        [
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          `// ${effectDiagnostics} anyUnknownInErrorContext:off`,
        ].join("\n"),
      ),
    ).toEqual([])

    expect(
      findSuppressionInventoryFindings(
        "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
        `// ${effectDiagnostics} anyUnknownInErrorContext:off`,
      ),
    ).toEqual([])

    expect(
      findSuppressionInventoryFindings(
        "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
        `// ${effectDiagnostics} strictEffectProvide:off`,
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
        line: 1,
        kind: "effect-diagnostics",
      },
    ])
  })
})
